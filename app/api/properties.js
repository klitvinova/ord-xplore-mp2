import { getPool, applyCors } from './_db.js';

/**
 * GET /api/properties
 *
 * Returns all dynamic properties and their option vocabularies from the database,
 * matching the Metadata Curation Framework (MCF) Property schema.
 */
export default async function handler(req, res) {
  if (applyCors(req, res, 'GET,OPTIONS')) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { rows } = await getPool().query(
      `SELECT id, name, display_name, type, description, options, created_at
       FROM properties
       ORDER BY id ASC;`
    );

    res.status(200).json({ properties: rows });
  } catch (error) {
    console.error('Properties API Error:', error);
    // If the properties table hasn't been migrated yet, return gracefully
    if (error.code === '42P01') {
      return res.status(200).json({ properties: [] });
    }
    res.status(500).json({ error: error.message, properties: [] });
  }
}
