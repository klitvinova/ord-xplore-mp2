import { getPool, applyCors, CUSTOM_PREFIX } from './_db.js';

/**
 * Saved custom tags: a user-defined characteristic such as "Mentions Van Gogh", shown with the
 * built-in characteristics (Letter, Verse, ...) and usable as a filter.
 *
 *   GET  /api/custom_tags                         -> { tags: [{ key, label, definition, doc_count, ... }] }
 *   POST /api/custom_tags { action: 'create', label, definition, sourceQuery? }
 *   POST /api/custom_tags { action: 'refresh', key }   recompute its documents (after uploads)
 *   POST /api/custom_tags { action: 'delete', key }
 *
 * definition = {
 *   tags:   ['lg', 'l'],                                   documents containing any of these elements
 *   values: [{ tags: ['persName', 'rs'], value: 'Van Gogh' }]  ... or whose element text contains value
 * }
 * Values are matched only in elements the editors tagged (the TEI tag-value index,
 * document_tag_values), not in the running text. The matching documents are stored in
 * custom_tag_documents when the tag is saved, so filters and counts are plain joins.
 */

export const CUSTOM_TAG_DDL = `
CREATE TABLE IF NOT EXISTS custom_tags (
  id           SERIAL PRIMARY KEY,
  key          TEXT UNIQUE NOT NULL,
  label        TEXT NOT NULL,
  definition   JSONB NOT NULL,
  source_query TEXT,
  doc_count    INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS custom_tag_documents (
  tag_id      INTEGER NOT NULL REFERENCES custom_tags(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_custom_tag_documents_doc ON custom_tag_documents(document_id);`;

function slug(s) {
  return String(s).trim().replace(/\s+/g, ' ').slice(0, 80);
}

/** Clean a definition from the client; throws on anything unusable. */
export function cleanDefinition(def) {
  const okTag = (t) => typeof t === 'string' && /^[A-Za-z][\w.-]{0,63}$/.test(t);
  const tags = Array.isArray(def?.tags) ? [...new Set(def.tags.filter(okTag))].slice(0, 50) : [];
  const values = (Array.isArray(def?.values) ? def.values : [])
    .map((v) => ({
      tags: Array.isArray(v?.tags) ? [...new Set(v.tags.filter(okTag))].slice(0, 20) : [],
      value: typeof v?.value === 'string' ? v.value.trim().slice(0, 200) : '',
    }))
    .filter((v) => v.tags.length && v.value.length >= 2)
    .slice(0, 20);
  if (!tags.length && !values.length) throw new Error('A tag needs at least one element, or an element and a text to look for.');
  return { tags, values };
}

/** Store the documents matching a tag's definition (replacing earlier ones). */
export async function materialize(client, tagId, def) {
  await client.query('DELETE FROM custom_tag_documents WHERE tag_id = $1', [tagId]);
  const hasAttr = (await client.query(`SELECT 1 FROM information_schema.columns
      WHERE table_name = 'document_tag_values' AND column_name = 'attribute_name'`)).rowCount > 0;
  if (def.tags.length) {
    await client.query(`
      INSERT INTO custom_tag_documents (tag_id, document_id)
      SELECT DISTINCT $1::int, dt.document_id FROM document_tags dt JOIN tags tg ON tg.id = dt.tag_id
       WHERE tg.name = ANY($2::text[])
      ON CONFLICT DO NOTHING`, [tagId, def.tags]);
  }
  for (const v of def.values) {
    // element text only (attribute_name IS NULL), case-insensitive substring
    await client.query(`
      INSERT INTO custom_tag_documents (tag_id, document_id)
      SELECT DISTINCT $1::int, dtv.document_id FROM document_tag_values dtv
       WHERE dtv.tag_name = ANY($2::text[]) AND dtv.value ILIKE $3 ${hasAttr ? 'AND dtv.attribute_name IS NULL' : ''}
      ON CONFLICT DO NOTHING`, [tagId, v.tags, `%${v.value.replace(/[\\%_]/g, '\\$&')}%`]);
  }
  const n = (await client.query('SELECT COUNT(*)::int AS n FROM custom_tag_documents WHERE tag_id = $1', [tagId])).rows[0].n;
  await client.query('UPDATE custom_tags SET doc_count = $2, refreshed_at = now() WHERE id = $1', [tagId, n]);
  return n;
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET,POST,OPTIONS')) return;
  const pool = getPool();
  try {
    if (req.method === 'GET') {
      const exists = (await pool.query("SELECT to_regclass('custom_tags') IS NOT NULL AS ok")).rows[0].ok;
      if (!exists) return res.status(200).json({ tags: [] });
      const { rows } = await pool.query(
        'SELECT key, label, definition, source_query, doc_count, created_at, refreshed_at FROM custom_tags ORDER BY created_at');
      return res.status(200).json({ tags: rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { action } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query(CUSTOM_TAG_DDL);
      if (action === 'create') {
        const label = slug(req.body.label || '');
        if (!label) return res.status(400).json({ error: 'The tag needs a name.' });
        let def;
        try { def = cleanDefinition(req.body.definition); } catch (e) { return res.status(400).json({ error: e.message }); }
        const key = CUSTOM_PREFIX + label;
        await client.query('BEGIN');
        const r = await client.query(`
          INSERT INTO custom_tags (key, label, definition, source_query) VALUES ($1, $2, $3, $4)
          ON CONFLICT (key) DO UPDATE SET definition = EXCLUDED.definition, source_query = EXCLUDED.source_query
          RETURNING id`, [key, label, JSON.stringify(def), req.body.sourceQuery ? String(req.body.sourceQuery).slice(0, 500) : null]);
        const n = await materialize(client, r.rows[0].id, def);
        await client.query('COMMIT');
        return res.status(200).json({ key, label, definition: def, doc_count: n });
      }
      if (action === 'refresh' || action === 'delete') {
        const key = String(req.body.key || '');
        const t = (await client.query('SELECT id, definition FROM custom_tags WHERE key = $1', [key])).rows[0];
        if (!t) return res.status(404).json({ error: `No saved tag ${key}` });
        if (action === 'delete') {
          await client.query('DELETE FROM custom_tags WHERE id = $1', [t.id]);
          return res.status(200).json({ deleted: key });
        }
        await client.query('BEGIN');
        const n = await materialize(client, t.id, t.definition);
        await client.query('COMMIT');
        return res.status(200).json({ key, doc_count: n });
      }
      return res.status(400).json({ error: `Unknown action ${action}` });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('custom_tags:', err);
    return res.status(500).json({ error: err.message });
  }
}
