import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || 'postgresql://karina@localhost:5432/ord_xplore',
});

// Helper for CORS headers
function applyCors(req, res, methods = 'GET,POST,OPTIONS') {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const client = await pool.connect();

  // Self-healing database migration for soft-exclusion columns
  try {
    await client.query('ALTER TABLE editions ADD COLUMN IF NOT EXISTS is_excluded BOOLEAN DEFAULT FALSE;');
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_excluded BOOLEAN DEFAULT FALSE;');
  } catch (e) {
    console.warn('Auto-migration database check warning in manage.js:', e.message);
  }

  try {
    // --- GET METHOD: Retrieve list of editions or documents ---
    if (req.method === 'GET') {
      const { editionId, documentId, editionDetailsId } = req.query || {};

      // A. Retrieve specific document details (metadata facets)
      if (documentId) {
        const docId = parseInt(documentId);
        
        // Fetch document name
        const docRes = await client.query('SELECT name FROM documents WHERE id = $1;', [docId]);
        if (docRes.rows.length === 0) {
          return res.status(404).json({ error: 'Document not found' });
        }
        const docName = docRes.rows[0].name;

        // Fetch languages
        const langRes = await client.query(
          `SELECT l.iso_code as lang, dl.inference_type 
           FROM document_languages dl 
           JOIN languages l ON dl.language_id = l.id 
           WHERE dl.document_id = $1;`,
          [docId]
        );
        const language = langRes.rows[0]?.lang || 'unknown';
        const languageInferred = langRes.rows[0]?.inference_type === 'inferred';

        // Fetch dates
        const dateRes = await client.query(
          `SELECT te.year, dte.date_type 
           FROM document_time_entities dte 
           JOIN time_entities te ON dte.time_entity_id = te.id 
           WHERE dte.document_id = $1;`,
          [docId]
        );
        const dates = { creation: [], publication: [], contextual: [] };
        dateRes.rows.forEach(r => {
          if (r.date_type === 'creation') dates.creation.push(r.year);
          else if (r.date_type === 'publication') dates.publication.push(r.year);
          else if (r.date_type === 'contextual') dates.contextual.push(r.year);
        });

        // Fetch places
        const geoRes = await client.query(
          `SELECT g.name, dg.geo_type 
           FROM document_geolocations dg 
           JOIN geolocations g ON dg.geolocation_id = g.id 
           WHERE dg.document_id = $1;`,
          [docId]
        );
        const geolocations = { creation: [], publication: [], contextual: [] };
        geoRes.rows.forEach(r => {
          if (r.geo_type === 'creation') geolocations.creation.push(r.name);
          else if (r.geo_type === 'publication') geolocations.publication.push(r.name);
          else if (r.geo_type === 'contextual') geolocations.contextual.push(r.name);
        });

        // Fetch features
        const featRes = await client.query(
          `SELECT am.name 
           FROM document_attributes da 
           JOIN attributes_metadata am ON da.attribute_id = am.id 
           WHERE da.document_id = $1;`,
          [docId]
        );
        const features = featRes.rows.map(r => r.name);

        // Fetch topics
        const topRes = await client.query(
          `SELECT topic_id as id, confidence 
           FROM document_topics 
           WHERE document_id = $1 
           ORDER BY confidence DESC;`,
          [docId]
        );

        // XML tag complexity
        const tagCountRes = await client.query(
          'SELECT COUNT(*) as count FROM document_tags WHERE document_id = $1;',
          [docId]
        );
        const tagCount = parseInt(tagCountRes.rows[0]?.count || 0);

        return res.status(200).json({
          metadata: {
            title: docName,
            language,
            languageInferred,
            tags: tagCount,
            dates,
            geolocations,
            features,
            topics: topRes.rows
          }
        });
      }

      // B. Retrieve collection-level edition statistics
      if (editionDetailsId) {
        const edId = parseInt(editionDetailsId);

        // Languages distribution
        const langRes = await client.query(
          `SELECT l.iso_code as lang, COUNT(*) as count 
           FROM document_languages dl 
           JOIN languages l ON dl.language_id = l.id 
           JOIN documents d ON dl.document_id = d.id 
           WHERE d.edition_id = $1 
           GROUP BY l.iso_code 
           ORDER BY count DESC;`,
          [edId]
        );

        // Features breakdown
        const featRes = await client.query(
          `SELECT am.name as key, COUNT(*) as count 
           FROM document_attributes da 
           JOIN attributes_metadata am ON da.attribute_id = am.id 
           JOIN documents d ON da.document_id = d.id 
           WHERE d.edition_id = $1 
           GROUP BY am.name 
           ORDER BY count DESC;`,
          [edId]
        );

        // Year coverage
        const yearRes = await client.query(
          `SELECT MIN(te.year) as min_year, MAX(te.year) as max_year 
           FROM document_time_entities dte 
           JOIN time_entities te ON dte.time_entity_id = te.id 
           JOIN documents d ON dte.document_id = d.id 
           WHERE d.edition_id = $1;`,
          [edId]
        );

        // Top topics
        const topRes = await client.query(
          `SELECT t.id, t.name, COUNT(*) as count 
           FROM document_topics dt 
           JOIN topics t ON dt.topic_id = t.id 
           JOIN documents d ON dt.document_id = d.id 
           WHERE d.edition_id = $1 
           GROUP BY t.id, t.name 
           ORDER BY count DESC 
           LIMIT 5;`,
          [edId]
        );

        return res.status(200).json({
          languages: langRes.rows,
          features: featRes.rows,
          years: yearRes.rows[0] || {},
          topics: topRes.rows
        });
      }

      // C. Standard list of documents under an edition
      if (editionId) {
        const docsQuery = await client.query(
          'SELECT id, name, is_excluded FROM documents WHERE edition_id = $1 ORDER BY name;',
          [parseInt(editionId)]
        );
        return res.status(200).json({ documents: docsQuery.rows });
      }

      // D. Default list of editions
      const edsQuery = await client.query(
        'SELECT id, name, description, website, number_documents, is_excluded FROM editions ORDER BY name;'
      );
      return res.status(200).json({ editions: edsQuery.rows });
    }

    // --- POST METHOD: Toggle exclusion of editions or documents ---
    if (req.method === 'POST') {
      const { action, id, isExcluded } = req.body || {};

      if (!action || !id || isExcluded === undefined) {
        return res.status(400).json({ error: 'Missing required parameters: action, id, and isExcluded' });
      }

      await client.query('BEGIN');

      if (action === 'toggle_edition_exclusion') {
        // Toggle the is_excluded column for the edition
        await client.query('UPDATE editions SET is_excluded = $2 WHERE id = $1;', [parseInt(id), !!isExcluded]);
        await client.query('COMMIT');
        return res.status(200).json({
          success: true,
          message: `Edition ${id} exclusion set to ${isExcluded}.`
        });
      }

      if (action === 'toggle_document_exclusion') {
        // Toggle the is_excluded column for the document
        await client.query('UPDATE documents SET is_excluded = $2 WHERE id = $1;', [parseInt(id), !!isExcluded]);
        await client.query('COMMIT');
        return res.status(200).json({
          success: true,
          message: `Document ${id} exclusion set to ${isExcluded}.`
        });
      }

      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Invalid action: ${action}` });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Management API error:', err);
    return res.status(500).json({ error: `Internal Server Error: ${err.message}` });
  } finally {
    client.release();
  }
}
