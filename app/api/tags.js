import { getPool, applyCors, ensureSchema } from './_db.js';

/**
 * GET /api/tags?search=<substring>&limit=<n>
 *
 * Returns the TEI tag inventory with per-tag document counts, for the
 * "Add Custom Tag Filter" modal. Replaces the old 30MB client-side
 * tag_presence_optimized.json.
 */
export default async function handler(req, res) {
  if (applyCors(req, res, 'GET,OPTIONS')) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const search = (req.query?.search ?? '').toString().trim();
  const rawLimit = parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 2000) : 500;

  try {
    const params = [];
    let where = '';
    if (search) {
      // Escape LIKE metacharacters so a user typing "%" doesn't match everything.
      params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
      where = `WHERE t.name ILIKE $1 ESCAPE '\\'`;
    }
    params.push(limit);

    // tei_tag_definitions (migration 006) is optional: without it every tag
    // just gets the generic category/description.
    const schema = await ensureSchema();
    const hasDefs = schema.has('tei_tag_definitions');
    const { rows } = await getPool().query(
      `SELECT t.name, COUNT(dt.document_id)::int AS doc_count,
              ${hasDefs ? "COALESCE(def.category, 'General Element')" : "'General Element'"} AS category,
              ${hasDefs ? "COALESCE(def.description, 'Standard TEI XML document element.')" : "'Standard TEI XML document element.'"} AS description
         FROM tags t
         LEFT JOIN document_tags dt ON dt.tag_id = t.id
         ${hasDefs ? 'LEFT JOIN tei_tag_definitions def ON def.name = t.name' : ''}
        ${where}
        GROUP BY t.name${hasDefs ? ', def.category, def.description' : ''}
        ORDER BY doc_count DESC, t.name ASC
        LIMIT $${params.length};`,
      params
    );

    res.status(200).json({ tags: rows });
  } catch (error) {
    console.error('Tags API Error:', error);
    // The tags tables are added by db/001_add_tags.sql; a missing relation is
    // the single most likely failure here, so say so explicitly.
    if (error.code === '42P01') {
      return res.status(503).json({
        error:
          'Tag tables are missing. Run db/001_add_tags.sql and db/backfill_tags.py.',
        tags: [],
      });
    }
    res.status(500).json({ error: error.message, tags: [] });
  }
}
