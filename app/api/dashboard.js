import { getPool, applyCors, CUSTOM_PREFIX, parseCustomFilters } from './_db.js';

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET,POST,OPTIONS')) return;

  const dbPool = getPool();

  try {
    if (req.method === 'GET') {
      // Initial Load metadata dictionaries
      const editionsRes = await dbPool.query('SELECT name, description, website, number_documents, size_in_mb FROM editions ORDER BY name;');
      const languagesRes = await dbPool.query('SELECT name, iso_code FROM languages ORDER BY name;');
      const topicsRes = await dbPool.query('SELECT id, name, words FROM topics ORDER BY id;');
      const featuresRes = await dbPool.query('SELECT name, type FROM attributes_metadata ORDER BY name;');

      res.status(200).json({
        editions: editionsRes.rows,
        languages: languagesRes.rows,
        topics: topicsRes.rows,
        features: featuresRes.rows,
      });
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'Method Not Allowed' });
    }

    // Filtered Query
    const { filters = {}, viewMode = 'document' } = req.body;

    const dateSource = filters.dateSource || 'contextual';
    const geoSource = filters.geoSource || 'contextual';

    // User-defined tag filters, e.g. { key: "__custom__Verse", tags: ["lg","l"] }.
    // A document matches if it carries ANY of the tags.
    const customFilters = parseCustomFilters(req.body.customFilters);
    const customByKey = new Map(customFilters.map((f) => [f.key, f.tags]));

    // Build dynamic where clauses and params
    const clauses = ['d.is_excluded = FALSE', 'e.is_excluded = FALSE'];
    const params = [];
    let paramIndex = 1;

    // Edition filter
    if (filters.edition) {
      clauses.push(`d.edition_id = (SELECT id FROM editions WHERE name = $${paramIndex})`);
      params.push(filters.edition);
      paramIndex++;
    }

    // Language filter
    if (filters.lang) {
      clauses.push(`EXISTS (
        SELECT 1 FROM document_languages dl
        JOIN languages l ON dl.language_id = l.id
        WHERE dl.document_id = d.id AND l.iso_code = $${paramIndex}
      )`);
      params.push(filters.lang);
      paramIndex++;
    }

    // Year range filter
    if (filters.yearRange && Array.isArray(filters.yearRange) && filters.yearRange.length === 2) {
      clauses.push(`EXISTS (
        SELECT 1 FROM document_time_entities dt
        JOIN time_entities t ON dt.time_entity_id = t.id
        WHERE dt.document_id = d.id AND dt.date_type = $${paramIndex} AND t.year >= $${paramIndex + 1} AND t.year <= $${paramIndex + 2}
      )`);
      params.push(dateSource, filters.yearRange[0], filters.yearRange[1]);
      paramIndex += 3;
    }

    // City filter
    if (filters.city) {
      clauses.push(`EXISTS (
        SELECT 1 FROM document_geolocations dg
        JOIN geolocations g ON dg.geolocation_id = g.id
        WHERE dg.document_id = d.id AND dg.geo_type = $${paramIndex} AND g.name = $${paramIndex + 1}
      )`);
      params.push(geoSource, filters.city);
      paramIndex += 2;
    }

    // Country filter
    if (filters.country) {
      clauses.push(`EXISTS (
        SELECT 1 FROM document_geolocations dg
        JOIN geolocations g ON dg.geolocation_id = g.id
        WHERE dg.document_id = d.id AND dg.geo_type = $${paramIndex} AND g.country = $${paramIndex + 1}
      )`);
      params.push(geoSource, filters.country);
      paramIndex += 2;
    }

    // Feature filter. Two flavours share the same UI slot: real columns in
    // attributes_metadata, and ad-hoc tag filters the user built in the modal.
    if (filters.feature && typeof filters.feature === 'object' && filters.feature.key) {
      const { key, value } = filters.feature;
      const existOperator = value === false ? 'NOT EXISTS' : 'EXISTS';

      if (key.startsWith(CUSTOM_PREFIX)) {
        const tags = customByKey.get(key);
        if (!tags) {
          return res.status(400).json({
            error: `Unknown custom filter "${key}". The client must send its tag list in customFilters.`,
          });
        }
        clauses.push(`${existOperator} (
          SELECT 1 FROM document_tags dt
          JOIN tags tg ON dt.tag_id = tg.id
          WHERE dt.document_id = d.id AND tg.name = ANY($${paramIndex}::text[])
        )`);
        params.push(tags);
        paramIndex++;
      } else {
        clauses.push(`${existOperator} (
          SELECT 1 FROM document_attributes da
          JOIN attributes_metadata am ON da.attribute_id = am.id
          WHERE da.document_id = d.id AND am.name = $${paramIndex}
        )`);
        params.push(key);
        paramIndex++;
      }
    }

    // Topic filter
    if (filters.topicId) {
      clauses.push(`EXISTS (
        SELECT 1 FROM document_topics dtop
        WHERE dtop.document_id = d.id AND dtop.topic_id = $${paramIndex}
      )`);
      params.push(filters.topicId);
      paramIndex++;
    }

    const whereSql = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';

    // Connect a single client from the pool to run in a temporary table transaction
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');

      // Create a temporary table containing matching document IDs
      await client.query(`
        CREATE TEMP TABLE temp_docs ON COMMIT DROP AS
        SELECT d.id, d.edition_id
        FROM documents d
        JOIN editions e ON d.edition_id = e.id
        ${whereSql}
      `, params);

      // Get count of matching documents and editions
      const docCountRes = await client.query('SELECT COUNT(*) as count FROM temp_docs;');
      const edCountRes = await client.query('SELECT COUNT(DISTINCT edition_id) as count FROM temp_docs;');
      const totalDocs = parseInt(docCountRes.rows[0].count);
      const totalEditions = parseInt(edCountRes.rows[0].count);

      // Aggregations depend on viewMode
      const countExpr = viewMode === 'edition' ? 'COUNT(DISTINCT t.edition_id)' : 'COUNT(t.id)';

      // 1. Language Aggregation
      const langQuery = `
        SELECT l.iso_code as lang, ${countExpr} as total,
               COUNT(DISTINCT case when dl.inference_type = 'inferred' then ${viewMode === 'edition' ? 't.edition_id' : 't.id'} end) as inferred,
               COUNT(DISTINCT case when dl.inference_type = 'original' then ${viewMode === 'edition' ? 't.edition_id' : 't.id'} end) as confirmed
        FROM temp_docs t
        JOIN document_languages dl ON t.id = dl.document_id
        JOIN languages l ON dl.language_id = l.id
        GROUP BY l.iso_code;
      `;
      const langAgg = await client.query(langQuery);
      const langsMap = {};
      langAgg.rows.forEach(r => {
        langsMap[r.lang] = {
          total: parseInt(r.total),
          confirmed: parseInt(r.confirmed),
          inferred: parseInt(r.inferred)
        };
      });

      // 2. Timeline Aggregation
      const timeQuery = `
        SELECT te.year, ${countExpr} as count
        FROM temp_docs t
        JOIN document_time_entities dte ON t.id = dte.document_id
        JOIN time_entities te ON dte.time_entity_id = te.id
        WHERE dte.date_type = $1
        GROUP BY te.year;
      `;
      const timeAgg = await client.query(timeQuery, [dateSource]);
      const yearsMap = {};
      timeAgg.rows.forEach(r => {
        yearsMap[r.year] = { count: parseInt(r.count) };
      });

      // 3. Geolocations Aggregation
      const geoQuery = `
        SELECT g.name as city, g.country, ST_Y(g.geometry) as lat, ST_X(g.geometry) as lng, ${countExpr} as total
        FROM temp_docs t
        JOIN document_geolocations dg ON t.id = dg.document_id
        JOIN geolocations g ON dg.geolocation_id = g.id
        WHERE dg.geo_type = $1
        GROUP BY g.name, g.country, g.geometry;
      `;
      const geoAgg = await client.query(geoQuery, [geoSource]);
      const citiesMap = {};
      geoAgg.rows.forEach(r => {
        citiesMap[r.city] = {
          total: parseInt(r.total),
          confirmed: parseInt(r.total),
          inferred: 0,
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lng),
          country: r.country
        };
      });

      // 4. Features Aggregation
      const featureQuery = `
        SELECT am.name as key, ${countExpr} as count
        FROM temp_docs t
        JOIN document_attributes da ON t.id = da.document_id
        JOIN attributes_metadata am ON da.attribute_id = am.id
        GROUP BY am.name;
      `;
      const featureAgg = await client.query(featureQuery);
      const featuresMap = {};
      featureAgg.rows.forEach(r => {
        featuresMap[r.key] = parseInt(r.count);
      });

      // 4b. Custom tag filters get counts too, so their bars render alongside
      // the built-in characteristics instead of always showing zero.
      const customCountExpr = viewMode === 'edition'
        ? 'COUNT(DISTINCT t.edition_id)'
        : 'COUNT(t.id)';
      for (const { key, tags } of customFilters) {
        const customAgg = await client.query(
          `SELECT ${customCountExpr} AS count
             FROM temp_docs t
            WHERE EXISTS (
              SELECT 1 FROM document_tags dt
              JOIN tags tg ON dt.tag_id = tg.id
              WHERE dt.document_id = t.id AND tg.name = ANY($1::text[])
            );`,
          [tags]
        );
        featuresMap[key] = parseInt(customAgg.rows[0]?.count ?? 0, 10) || 0;
      }

      // 5. Topics Aggregation
      const topicQuery = `
        SELECT dtop.topic_id, ${countExpr} as count
        FROM temp_docs t
        JOIN document_topics dtop ON t.id = dtop.document_id
        GROUP BY dtop.topic_id;
      `;
      const topicAgg = await client.query(topicQuery);
      const topicsMap = {};
      topicAgg.rows.forEach(r => {
        topicsMap[r.topic_id] = parseInt(r.count);
      });

      // 6. Editions Aggregation
      const edAggQuery = `
        SELECT ed.name, ${countExpr} as count
        FROM temp_docs t
        JOIN editions ed ON t.edition_id = ed.id
        GROUP BY ed.name;
      `;
      const edAgg = await client.query(edAggQuery);
      const editionsList = edAgg.rows.map(r => r.name);

      await client.query('COMMIT');

      res.status(200).json({
        totalDocs,
        totalEditions,
        langs: langsMap,
        years: yearsMap,
        cities: citiesMap,
        features: featuresMap,
        topics: topicsMap,
        editions: editionsList
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Database Error:', error);
    if (error.code === '42P01' && /tags/.test(error.message)) {
      return res.status(503).json({
        error: 'Tag tables are missing. Run db/001_add_tags.sql and db/backfill_tags.py.',
      });
    }
    res.status(500).json({ error: error.message });
  }
}
