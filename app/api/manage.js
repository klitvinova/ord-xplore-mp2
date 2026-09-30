import { getPool, ensureSchema, applyCors, SIGNED_YEAR } from './_db.js';

/**
 * Dataset curation API (upload.html).
 *
 * GET  /api/manage                                  editions with coverage figures + summary
 * GET  /api/manage?editionId=1&search=&limit=&offset=   documents of an edition (paged)
 * GET  /api/manage?editionDetailsId=1               languages, characteristics, years, topics of an edition
 * POST /api/manage { action: 'toggle_edition_exclusion' | 'toggle_document_exclusion', id, isExcluded }
 * POST /api/manage { action: 'update_edition', id, display_name, description, website }
 *
 * Hiding never deletes anything: is_excluded only keeps the edition or
 * document out of the Explorer.
 */

const MAX_LIMIT = 500;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  let schema;
  try {
    schema = await ensureSchema();
  } catch (e) {
    return res.status(500).json({ error: `Database unavailable: ${e.message}` });
  }
  const col = (table, name, fallback = 'NULL') => (schema.hasColumn(table, name) ? `${table === 'editions' ? 'e' : 'd'}.${name}` : fallback);
  const client = await getPool().connect();
  try {
    if (req.method === 'GET') {
      const { editionId, editionDetailsId } = req.query || {};

      if (editionDetailsId) {
        const id = parseInt(editionDetailsId, 10);
        const [langs, feats, years, topics] = await Promise.all([
          client.query(`SELECT l.iso_code AS lang, l.name, dl.inference_type AS inference, COUNT(*)::int AS count
                          FROM document_languages dl JOIN languages l ON l.id = dl.language_id
                          JOIN documents d ON d.id = dl.document_id
                         WHERE d.edition_id = $1 GROUP BY 1, 2, 3 ORDER BY count DESC`, [id]),
          client.query(`SELECT am.name AS key, COUNT(*)::int AS count FROM document_attributes da
                          JOIN attributes_metadata am ON am.id = da.attribute_id JOIN documents d ON d.id = da.document_id
                         WHERE d.edition_id = $1 GROUP BY 1 ORDER BY count DESC`, [id]),
          client.query(`SELECT dt.date_type, MIN(${SIGNED_YEAR('t')}) AS min_year, MAX(${SIGNED_YEAR('t')}) AS max_year,
                               COUNT(DISTINCT dt.document_id)::int AS documents
                          FROM document_time_entities dt JOIN time_entities t ON t.id = dt.time_entity_id
                          JOIN documents d ON d.id = dt.document_id
                         WHERE d.edition_id = $1 GROUP BY 1`, [id]),
          client.query(`SELECT t.id, t.name, COUNT(*)::int AS count FROM document_topics dt JOIN topics t ON t.id = dt.topic_id
                          JOIN documents d ON d.id = dt.document_id WHERE d.edition_id = $1
                         GROUP BY 1, 2 ORDER BY count DESC LIMIT 5`, [id]),
        ]);
        return res.status(200).json({ languages: langs.rows, features: feats.rows, years: years.rows, topics: topics.rows });
      }

      if (editionId) {
        const id = parseInt(editionId, 10);
        const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, MAX_LIMIT);
        const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
        const search = (req.query.search || '').trim();
        const filePath = col('documents', 'file_path');
        const params = [id];
        let where = 'd.edition_id = $1';
        if (search) {
          params.push(`%${search}%`);
          where += ` AND (d.name ILIKE $2 OR ${filePath === 'NULL' ? 'FALSE' : `${filePath} ILIKE $2`} OR CAST(d.id AS TEXT) = $3)`;
          params.push(search);
        }
        const total = await client.query(`SELECT COUNT(*)::int AS n FROM documents d WHERE ${where}`, params);
        const docs = await client.query(
          `SELECT d.id, d.name, ${filePath} AS file_path, d.is_excluded,
                  yr.year, yr.date_type AS year_type,
                  (SELECT json_agg(json_build_object('code', l.iso_code, 'name', l.name) ORDER BY l.iso_code)
                     FROM document_languages dl JOIN languages l ON l.id = dl.language_id
                    WHERE dl.document_id = d.id AND l.iso_code NOT IN ('und', 'mul', 'zxx')) AS languages
             FROM documents d
             LEFT JOIN LATERAL (
               SELECT ${SIGNED_YEAR('t')} AS year, dt.date_type FROM document_time_entities dt
                 JOIN time_entities t ON t.id = dt.time_entity_id
                WHERE dt.document_id = d.id
                ORDER BY (dt.date_type = 'creation') DESC, (dt.date_type = 'publication') DESC LIMIT 1) yr ON TRUE
            WHERE ${where}
            ORDER BY ${filePath === 'NULL' ? 'd.name' : filePath}, d.id
            LIMIT ${limit} OFFSET ${offset}`, params);
        return res.status(200).json({ documents: docs.rows, total: total.rows[0].n, limit, offset });
      }

      const eds = await client.query(`
        WITH docs AS (SELECT edition_id, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE is_excluded))::int AS hidden
                        FROM documents GROUP BY 1),
             yrs AS (SELECT d.edition_id,
                            MIN(${SIGNED_YEAR('t')}) FILTER (WHERE dt.date_type IN ('creation', 'publication')) AS y0,
                            MAX(${SIGNED_YEAR('t')}) FILTER (WHERE dt.date_type IN ('creation', 'publication')) AS y1,
                            MIN(${SIGNED_YEAR('t')}) FILTER (WHERE dt.date_type = 'contextual') AS c0,
                            MAX(${SIGNED_YEAR('t')}) FILTER (WHERE dt.date_type = 'contextual') AS c1
                       FROM document_time_entities dt JOIN time_entities t ON t.id = dt.time_entity_id
                       JOIN documents d ON d.id = dt.document_id GROUP BY 1),
             lang AS (SELECT edition_id, json_agg(json_build_object('code', iso_code, 'name', name, 'n', n) ORDER BY n DESC) AS langs
                        FROM (SELECT d.edition_id, l.iso_code, l.name, COUNT(*)::int AS n,
                                     ROW_NUMBER() OVER (PARTITION BY d.edition_id ORDER BY COUNT(*) DESC) AS rn
                                FROM document_languages dl JOIN languages l ON l.id = dl.language_id
                                JOIN documents d ON d.id = dl.document_id
                               WHERE l.iso_code NOT IN ('und', 'mul', 'zxx') GROUP BY 1, 2, 3) x
                       WHERE rn <= 3 GROUP BY 1),
             geo AS (SELECT d.edition_id, COUNT(*)::int AS links, (COUNT(*) FILTER (WHERE g.geometry IS NOT NULL))::int AS located
                       FROM document_geolocations dg JOIN documents d ON d.id = dg.document_id
                       JOIN geolocations g ON g.id = dg.geolocation_id GROUP BY 1)
        SELECT e.id, e.name, ${col('editions', 'display_name')} AS display_name, e.description, e.website,
               ${col('editions', 'publisher')} AS publisher, ${col('editions', 'description_source')} AS description_source,
               ${col('editions', 'edition_date_year')} AS edition_date_year, e.is_excluded,
               COALESCE(docs.n, 0) AS documents, COALESCE(docs.hidden, 0) AS hidden_documents,
               yrs.y0 AS year_min, yrs.y1 AS year_max, yrs.c0 AS mentioned_min, yrs.c1 AS mentioned_max, COALESCE(lang.langs, '[]'::json) AS languages,
               COALESCE(geo.links, 0) AS place_links, COALESCE(geo.located, 0) AS located_links
          FROM editions e
          LEFT JOIN docs ON docs.edition_id = e.id LEFT JOIN yrs ON yrs.edition_id = e.id
          LEFT JOIN lang ON lang.edition_id = e.id LEFT JOIN geo ON geo.edition_id = e.id
         ORDER BY lower(COALESCE(${col('editions', 'display_name')}, e.name))`);
      let build = null;
      if (schema.hasColumn('build_info', 'value')) {
        const b = await client.query(`SELECT value FROM build_info WHERE key = 'run'`);
        build = b.rows[0]?.value || null;
      }
      const rows = eds.rows;
      const visible = rows.filter((r) => !r.is_excluded);
      return res.status(200).json({
        editions: rows,
        summary: {
          editions: rows.length,
          hiddenEditions: rows.length - visible.length,
          documents: rows.reduce((s, r) => s + r.documents, 0),
          visibleDocuments: visible.reduce((s, r) => s + r.documents - r.hidden_documents, 0),
          build,
        },
      });
    }

    if (req.method === 'POST') {
      const { action, id } = req.body || {};
      if (!action || !id) return res.status(400).json({ error: 'action and id are required.' });

      if (action === 'toggle_edition_exclusion' || action === 'toggle_document_exclusion') {
        const table = action === 'toggle_edition_exclusion' ? 'editions' : 'documents';
        const r = await client.query(`UPDATE ${table} SET is_excluded = $2 WHERE id = $1 RETURNING id`,
          [parseInt(id, 10), !!req.body.isExcluded]);
        if (!r.rowCount) return res.status(404).json({ error: `${table.slice(0, -1)} ${id} not found` });
        return res.status(200).json({ success: true });
      }

      if (action === 'update_edition') {
        const displayName = String(req.body.display_name ?? '').trim().slice(0, 300);
        const description = String(req.body.description ?? '').trim().slice(0, 4000);
        const website = String(req.body.website ?? '').trim().slice(0, 500);
        if (website && !/^https?:\/\/\S+$/i.test(website)) {
          return res.status(400).json({ error: 'The website must start with http:// or https://' });
        }
        const sets = ['description = $2', 'website = $3'];
        const params = [parseInt(id, 10), description, website];
        if (schema.hasColumn('editions', 'display_name')) {
          sets.push('display_name = $4');
          params.push(displayName || null);
        }
        const r = await client.query(`UPDATE editions SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
        if (!r.rowCount) return res.status(404).json({ error: `edition ${id} not found` });
        return res.status(200).json({ success: true });
      }
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('Management API error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}
