import pg from 'pg';

const { Pool } = pg;

const DEFAULT_DSN = 'postgresql://karina@localhost:5432/ord_xplore';

let pool;

/**
 * Shared connection pool. On Vercel each serverless function gets its own
 * module instance, but the pool is still reused across warm invocations of
 * that function -- which is the case that matters.
 */
export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || DEFAULT_DSN,
    });
  }
  return pool;
}

/**
 * Tables added by later migrations (db/001, 003, 006). Production databases
 * loaded from an older dump may not have them yet, so queries that touch
 * them must check first instead of failing the whole request.
 */
export const OPTIONAL_TABLES = {
  tags: 'db/001_add_tags.sql + db/backfill_tags.py',
  document_tags: 'db/001_add_tags.sql + db/backfill_tags.py',
  properties: 'db/003_add_properties_and_values.sql + db/004_backfill_properties.py',
  edition_property_values: 'db/003_add_properties_and_values.sql + db/004_backfill_properties.py',
  document_property_values: 'db/003_add_properties_and_values.sql + db/005_extract_document_properties.py',
  tei_tag_definitions: 'db/006_add_tei_guidelines_and_doc_tag_values.sql + db/007_populate_tei_guidelines_and_tag_values.py',
  document_tag_values: 'db/006_add_tei_guidelines_and_doc_tag_values.sql + db/007_populate_tei_guidelines_and_tag_values.py',
};

let schemaPromise;

/**
 * Run once per function instance: make sure the soft-exclusion columns exist
 * and record which optional tables are present. Returns
 * { has(name), missing: [{ table, migration }] }.
 */
export function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getPool();
      try {
        await db.query('ALTER TABLE editions ADD COLUMN IF NOT EXISTS is_excluded BOOLEAN DEFAULT FALSE;');
        await db.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_excluded BOOLEAN DEFAULT FALSE;');
      } catch (e) {
        console.warn('is_excluded column check failed:', e.message);
      }
      const { rows } = await db.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = ANY($1::text[]);`,
        [Object.keys(OPTIONAL_TABLES)]
      );
      const present = new Set(rows.map((r) => r.table_name));
      // Optional columns, e.g. geolocations.place_type from
      // data/geo_audit/correct_geolocations.py.
      const cols = await db.query(
        `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND ((table_name = 'geolocations' AND column_name IN ('place_type', 'geo_correction'))
              OR (table_name = 'editions' AND column_name IN ('display_name', 'edition_date_year')));`
      );
      const columns = new Set(cols.rows.map((r) => r.col));
      return {
        has: (name) => present.has(name),
        hasColumn: (table, column) => columns.has(`${table}.${column}`),
        missing: Object.keys(OPTIONAL_TABLES)
          .filter((t) => !present.has(t))
          .map((t) => ({ table: t, migration: OPTIONAL_TABLES[t] })),
      };
    })().catch((err) => {
      schemaPromise = undefined; // retry on the next request
      throw err;
    });
  }
  return schemaPromise;
}

/** Standard CORS + preflight handling. Returns true if the request is done. */
export function applyCors(req, res, methods = 'GET,POST,OPTIONS') {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

/**
 * time_entities stores BC years as a positive year plus era = 'BC'. Always
 * read years through this expression so BC dates come out negative.
 */
export const SIGNED_YEAR = (alias = 't') =>
  `(CASE WHEN ${alias}.era = 'BC' THEN -${alias}.year ELSE ${alias}.year END)`;

// attributes_metadata rows that are facet names, not characteristics.
export const PSEUDO_ATTRIBUTES = ['date_creation', 'date_publication', 'date_contextual',
  'geo_creation', 'geo_publication', 'geo_contextual', 'language'];

export const CUSTOM_PREFIX = '__custom__';

/**
 * Normalise the `customFilters` payload the dashboard sends alongside its
 * filter state. Shape: [{ key: "__custom__Letters", tags: ["lg", "l"] }]
 *
 * Everything here is attacker-controlled, so cap both the number of filters
 * and the tags per filter -- each one becomes a subquery.
 */
export function parseCustomFilters(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && typeof f.key === 'string' && Array.isArray(f.tags))
    .slice(0, 20)
    .map((f) => ({
      key: f.key,
      tags: f.tags
        .filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 255)
        .slice(0, 50),
    }))
    .filter((f) => f.tags.length > 0);
}
