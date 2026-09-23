import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, ensureSchema } from './_db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RAW_DOCS_ROOT = path.resolve(__dirname, '../../../raw_documents');

export default async function handler(req, res) {
  const pool = getPool();

  // If edition parameter is present, list documents for that edition
  if (req.query.edition) {
    try {
      const editionSlug = req.query.edition;
      const search = req.query.search ? `%${req.query.search.trim()}%` : null;
      const limit = parseInt(req.query.limit || 250, 10);

      let q = `
        SELECT d.id, d.name, e.name as edition_name
        FROM documents d
        JOIN editions e ON d.edition_id = e.id
        WHERE e.name = $1
      `;
      const params = [editionSlug];
      if (search) {
        q += ` AND (d.name ILIKE $2 OR CAST(d.id AS TEXT) ILIKE $2)`;
        params.push(search);
      }
      q += ` ORDER BY d.id LIMIT $${params.length + 1}`;
      params.push(limit);

      const listRes = await pool.query(q, params);
      return res.status(200).json({
        edition: editionSlug,
        documents: listRes.rows
      });
    } catch (err) {
      console.error('Error listing edition documents:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  const docId = req.query.id;
  if (!docId) {
    return res.status(400).json({ error: 'Missing required query parameter "id" or "edition"' });
  }

  try {
    const query = `
      SELECT d.id, d.name, e.name as edition_name, e.description as edition_description
      FROM documents d
      JOIN editions e ON d.edition_id = e.id
      WHERE d.id = $1;
    `;
    const result = await pool.query(query, [docId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Document ID ${docId} not found` });
    }

    const doc = result.rows[0];
    const editionDir = path.join(RAW_DOCS_ROOT, doc.edition_name);
    
    // Find XML file
    let filePath = path.join(editionDir, doc.name);
    if (!fs.existsSync(filePath) && !filePath.endsWith('.xml')) {
      filePath = path.join(editionDir, `${doc.name}.xml`);
    }

    let xmlContent = '';
    if (fs.existsSync(filePath)) {
      xmlContent = fs.readFileSync(filePath, 'utf8');
    }

    // Fetch tags & entities for this document
    const tagsQuery = `
      SELECT dtv.tag_name, dtv.value, count(*) as count
      FROM document_tag_values dtv
      WHERE dtv.document_id = $1
      GROUP BY dtv.tag_name, dtv.value
      ORDER BY count DESC
      LIMIT 50;
    `;
    // document_tag_values comes from migration 006; older databases lack it.
    let tagValueRows = [];
    const schema = await ensureSchema();
    if (schema.has('document_tag_values')) {
      tagValueRows = (await pool.query(tagsQuery, [docId])).rows;
    }

    // Fetch dates and places
    const metaQuery = `
      SELECT 
        (SELECT json_agg(json_build_object('year', te.year, 'date_type', dte.date_type)) 
         FROM document_time_entities dte 
         JOIN time_entities te ON dte.time_entity_id = te.id 
         WHERE dte.document_id = $1) as dates,
        (SELECT json_agg(json_build_object('name', g.name, 'country', g.country, 'geo_type', dg.geo_type)) 
         FROM document_geolocations dg 
         JOIN geolocations g ON dg.geolocation_id = g.id 
         WHERE dg.document_id = $1) as places,
        (SELECT json_agg(json_build_object('iso', l.iso_code, 'name', l.name)) 
         FROM document_languages dl 
         JOIN languages l ON dl.language_id = l.id 
         WHERE dl.document_id = $1) as languages,
        (SELECT json_agg(json_build_object('topic_id', t.id, 'name', t.name)) 
         FROM document_topics dt 
         JOIN topics t ON dt.topic_id = t.id 
         WHERE dt.document_id = $1) as topics
    `;
    const metaRes = await pool.query(metaQuery, [docId]);
    const metadata = metaRes.rows[0] || {};

    res.status(200).json({
      id: doc.id,
      name: doc.name,
      edition: doc.edition_name,
      editionDescription: doc.edition_description,
      xml: xmlContent,
      dates: metadata.dates || [],
      places: metadata.places || [],
      languages: metadata.languages || [],
      topics: metadata.topics || [],
      tagValues: tagValueRows
    });

  } catch (err) {
    console.error('Error fetching document:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
