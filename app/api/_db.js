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
      connectionString: process.env.DATABASE_URL || DEFAULT_DSN,
    });
  }
  return pool;
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
