import { getPool, applyCors, ensureSchema, CUSTOM_PREFIX, parseCustomFilters, SIGNED_YEAR, PSEUDO_ATTRIBUTES } from './_db.js';

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET,POST,OPTIONS')) return;

  const dbPool = getPool();

  try {
    // Adds is_excluded columns once and records which optional tables exist.
    const schema = await ensureSchema();
    const hasPropertyValues = schema.has('edition_property_values') && schema.has('properties');
    const hasTagValues = schema.has('document_tag_values');
    // Countries, regions, water bodies and fragments are not settlements: keep
    // them out of the Places list and the map (they can still match filters).
    // 'approximate' = a settlement known only at country level; its point is the
    // country centre (kept as a fallback, see data/geo_audit/phase1_followup.py).
    const hasPlaceType = schema.hasColumn('geolocations', 'place_type');
    const settlementsOnly = hasPlaceType
      ? "AND (g.place_type IS NULL OR g.place_type IN ('settlement', 'approximate', 'ancient_place'))" : '';
    // A precise point wins over a country-centre fallback of the same name.
    const precise = hasPlaceType ? "FILTER (WHERE g.place_type IS DISTINCT FROM 'approximate')" : '';
    const approxExpr = hasPlaceType ? "BOOL_AND(g.place_type IS NOT DISTINCT FROM 'approximate')" : 'FALSE';
    // Filters we had to skip because their tables are not migrated yet.
    const warnings = [];

    if (req.method === 'GET') {
      // Initial Load metadata dictionaries
      // Excluded (e.g. test) editions stay out of every list.
      const displayName = schema.hasColumn('editions', 'display_name') ? 'display_name' : 'NULL AS display_name';
      const editionsRes = await dbPool.query(
        `SELECT name, ${displayName}, description, website, number_documents, size_in_mb
           FROM editions WHERE is_excluded = FALSE ORDER BY name;`);
      const languagesRes = await dbPool.query(
        "SELECT name, iso_code FROM languages WHERE iso_code NOT IN ('und', 'mul', 'zxx') ORDER BY name;");
      // v2 builds keep only topic models that passed the evaluation (data/build/ordx/topics.py), one per
      // language; older databases have the near-uniform FASTopic clusters, which stay hidden.
      const topicsV2 = schema.hasColumn('topics', 'lang');
      const topicsRes = await dbPool.query(topicsV2
        ? 'SELECT id, name, words, lang, coherence FROM topics ORDER BY lang, id;'
        : 'SELECT id, name, words FROM topics ORDER BY id;');
      const featuresRes = await dbPool.query(
        'SELECT name, type FROM attributes_metadata WHERE NOT (name = ANY($1::text[])) ORDER BY name;',
        [PSEUDO_ATTRIBUTES]);

      let propertiesRows = [];
      try {
        const propertiesRes = await dbPool.query('SELECT id, name, display_name, type, description, options FROM properties ORDER BY id;');
        propertiesRows = propertiesRes.rows;
      } catch (err) {
        // Fall back gracefully if properties table is not yet migrated
      }

      res.status(200).json({
        editions: editionsRes.rows,
        languages: languagesRes.rows,
        topics: topicsRes.rows,
        topicsEvaluated: topicsV2 && topicsRes.rows.length > 0,
        features: featuresRes.rows,
        properties: propertiesRows,
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
    // Saved custom tags (api/custom_tags.js): their documents are stored, so they filter and count by join.
    const savedTags = new Map();
    if ((await dbPool.query("SELECT to_regclass('custom_tags') IS NOT NULL AS ok")).rows[0].ok) {
      (await dbPool.query('SELECT id, key FROM custom_tags')).rows.forEach((r) => savedTags.set(r.key, r.id));
    }

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
        WHERE dt.document_id = d.id
          AND dt.date_type = $${paramIndex}
          AND ${SIGNED_YEAR('t')} BETWEEN $${paramIndex + 1} AND $${paramIndex + 2}
      )`);
      params.push(dateSource, filters.yearRange[0], filters.yearRange[1]);
      paramIndex += 3;
    }

    // Geography filters use the same place layer the map shows (geoSource:
    // creation / publication / contextual), so matching and display agree.
    // geoMatchPatterns is reused below to flag which places satisfied it.
    let geoMatchPatterns = null;

    // City filter
    if (filters.city) {
      geoMatchPatterns = [`%${filters.city}%`];
      clauses.push(`EXISTS (
        SELECT 1 FROM document_geolocations dg
        JOIN geolocations g ON dg.geolocation_id = g.id
        WHERE dg.document_id = d.id
          AND dg.geo_type = $${paramIndex}
          AND (g.name ILIKE $${paramIndex + 1} OR g.country ILIKE $${paramIndex + 1})
      )`);
      params.push(geoSource, `%${filters.city}%`);
      paramIndex += 2;
    }

    // Exact place, from a click on the map or the Places list: that one place (name + country),
    // not every place whose name contains the text (Bülach must not also select Bachenbülach).
    const place = filters.place && typeof filters.place === 'object' && filters.place.name ? filters.place : null;
    if (place) {
      clauses.push(`EXISTS (
        SELECT 1 FROM document_geolocations dg
        JOIN geolocations g ON dg.geolocation_id = g.id
        WHERE dg.document_id = d.id
          AND dg.geo_type = $${paramIndex}
          AND g.name = $${paramIndex + 1} AND COALESCE(g.country, '') = $${paramIndex + 2}
      )`);
      params.push(geoSource, place.name, place.country || '');
      paramIndex += 3;
    }

    // Country filter
    if (filters.country) {
      let countryPatterns = [`%${filters.country}%`];
      const cLower = filters.country.toLowerCase();
      if (cLower === 'egypt') {
        countryPatterns = ['%egypt%', '%aegypt%', '%مصر%', '%cairo%', '%alexandria%'];
      } else if (cLower === 'greece') {
        countryPatterns = ['%greece%', '%griechenland%', '%hellas%', '%ελλάς%', '%athens%'];
      } else if (cLower === 'italy') {
        countryPatterns = ['%italy%', '%italien%', '%italia%', '%rome%', '%rom%', '%venice%', '%florence%'];
      } else if (cLower === 'germany') {
        countryPatterns = ['%germany%', '%deutschland%', '%berlin%', '%munich%', '%heidelberg%'];
      } else if (cLower === 'switzerland') {
        countryPatterns = ['%switzerland%', '%schweiz%', '%zurich%', '%zürich%', '%basel%', '%bern%', '%geneva%'];
      } else if (cLower === 'israel') {
        countryPatterns = ['%israel%', '%palestine%', '%jerusalem%', '%ישראל%'];
      }

      clauses.push(`EXISTS (
        SELECT 1 FROM document_geolocations dg
        JOIN geolocations g ON dg.geolocation_id = g.id
        WHERE dg.document_id = d.id
          AND dg.geo_type = $${paramIndex}
          AND (g.country ILIKE ANY($${paramIndex + 1}::text[]) OR g.name ILIKE ANY($${paramIndex + 1}::text[]))
      )`);
      geoMatchPatterns = [...(geoMatchPatterns || []), ...countryPatterns];
      params.push(geoSource, countryPatterns);
      paramIndex += 2;
    }

    // Feature filter. Two flavours share the same UI slot: real columns in
    // attributes_metadata, and ad-hoc tag filters the user built in the modal.
    if (filters.feature && typeof filters.feature === 'object' && filters.feature.key) {
      const { key, value } = filters.feature;
      const existOperator = value === false ? 'NOT EXISTS' : 'EXISTS';

      if (key.startsWith(CUSTOM_PREFIX) && savedTags.has(key)) {
        clauses.push(`${existOperator} (
          SELECT 1 FROM custom_tag_documents ctd WHERE ctd.document_id = d.id AND ctd.tag_id = $${paramIndex}
        )`);
        params.push(savedTags.get(key));
        paramIndex++;
      } else if (key.startsWith(CUSTOM_PREFIX)) {
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
        let tagFallbackClause = '';
        if (key === 'is_letter') {
          tagFallbackClause = `OR ${existOperator} (
            SELECT 1 FROM editions ed WHERE ed.id = d.edition_id AND (ed.name ILIKE '%letters%' OR ed.name ILIKE '%brief%' OR ed.name ILIKE '%korrespondenz%')
          )
          OR ${existOperator} (
            SELECT 1 FROM document_tags dt JOIN tags tg ON dt.tag_id = tg.id WHERE dt.document_id = d.id AND tg.name IN ('correspAction', 'opener', 'salute', 'signed', 'correspDesc')
          )`;
        } else if (key === 'contains_verse') {
          tagFallbackClause = `OR ${existOperator} (
            SELECT 1 FROM document_tags dt JOIN tags tg ON dt.tag_id = tg.id WHERE dt.document_id = d.id AND tg.name IN ('lg', 'l')
          )`;
        } else if (key === 'contains_diary') {
          tagFallbackClause = `OR ${existOperator} (
            SELECT 1 FROM editions ed WHERE ed.id = d.edition_id AND (ed.name ILIKE '%diar%' OR ed.name ILIKE '%tageb%' OR ed.name ILIKE '%journal%' OR ed.name ILIKE '%expedition%' OR ed.name ILIKE '%reise%')
          )
          OR ${existOperator} (
            SELECT 1 FROM document_tags dt JOIN tags tg ON dt.tag_id = tg.id WHERE dt.document_id = d.id AND tg.name IN ('entry')
          )`;
        } else if (key === 'is_manuscript') {
          tagFallbackClause = `OR ${existOperator} (
            SELECT 1 FROM editions ed WHERE ed.id = d.edition_id AND (ed.name ILIKE '%manuscript%' OR ed.name ILIKE '%handschrift%')
          )
          OR ${existOperator} (
            SELECT 1 FROM document_tags dt JOIN tags tg ON dt.tag_id = tg.id WHERE dt.document_id = d.id AND tg.name IN ('msDesc', 'handDesc', 'physDesc')
          )`;
        }

        clauses.push(`(
          ${existOperator} (
            SELECT 1 FROM document_attributes da
            JOIN attributes_metadata am ON da.attribute_id = am.id
            WHERE da.document_id = d.id AND am.name = $${paramIndex}
          )
          ${hasPropertyValues ? `OR ${existOperator} (
            SELECT 1 FROM edition_property_values epv
            JOIN properties p ON epv.property_id = p.id
            WHERE epv.edition_id = d.edition_id AND p.name = $${paramIndex}
              AND (
                (p.type = 'binary' AND (epv.value = 'true'::jsonb OR epv.value = '"true"'::jsonb))
                OR (p.type = 'multiple_choice' AND (epv.value ? $${paramIndex + 1} OR epv.value @> jsonb_build_array($${paramIndex + 1})))
              )
          )` : `OR ($${paramIndex + 1}::text IS NULL AND FALSE)`}
          ${tagFallbackClause}
        )`);
        params.push(key, typeof value === 'string' ? value : key);
        paramIndex += 2;
      }
    }

    // Dynamic properties array filter (e.g. from MCF intent search or dynamic facets)
    if (Array.isArray(filters.properties) && filters.properties.length > 0 && !hasPropertyValues) {
      warnings.push('Property filters were ignored: the properties tables are not migrated on this database.');
    } else if (Array.isArray(filters.properties) && filters.properties.length > 0) {
      for (const propFilter of filters.properties) {
        if (!propFilter || !propFilter.name) continue;
        const { name, value } = propFilter;
        if (value === true || value === 'true') {
          clauses.push(`EXISTS (
            SELECT 1 FROM edition_property_values epv
            JOIN properties p ON epv.property_id = p.id
            WHERE epv.edition_id = d.edition_id AND p.name = $${paramIndex}
              AND (epv.value = 'true'::jsonb OR epv.value = '"true"'::jsonb)
          )`);
          params.push(name);
          paramIndex++;
        } else if (value === false || value === 'false') {
          clauses.push(`EXISTS (
            SELECT 1 FROM edition_property_values epv
            JOIN properties p ON epv.property_id = p.id
            WHERE epv.edition_id = d.edition_id AND p.name = $${paramIndex}
              AND (epv.value = 'false'::jsonb OR epv.value = '"false"'::jsonb)
          )`);
          params.push(name);
          paramIndex++;
        } else if (typeof value === 'string') {
          clauses.push(`EXISTS (
            SELECT 1 FROM edition_property_values epv
            JOIN properties p ON epv.property_id = p.id
            WHERE epv.edition_id = d.edition_id AND p.name = $${paramIndex}
              AND (
                epv.value ? $${paramIndex + 1}
                OR epv.value @> jsonb_build_array($${paramIndex + 1})
                OR epv.value#>>'{}' ILIKE $${paramIndex + 2}
              )
          )`);
          params.push(name, value, `%${value}%`);
          paramIndex += 3;
        }
      }
    }

    // Raw TEI Tag Values Filter (querying document_tag_values)
    if (Array.isArray(filters.tagValues) && filters.tagValues.length > 0) {
      for (const tv of filters.tagValues) {
        if (!tv || !tv.tag) continue;
        const { tag, value } = tv;
        const isGeneric = !value || value === 'true' || value === true;
        
        if (!isGeneric) {
          const cleanSlug = `%${String(value).toLowerCase().replace(/[^a-z0-9]/g, '%')}%`;
          let extraTagNames = [tag];
          if (tag === 'persName') extraTagNames = ['persName', 'author', 'speaker', 'signed'];
          else if (tag === 'term' || tag === 'topic' || tag === 'genre') extraTagNames = ['term', 'gloss', 'head', 'title', 'name', 'rs'];
          else if (tag === 'head' || tag === 'title') extraTagNames = ['head', 'title', 'bibl', 'term'];

          if (!hasTagValues) {
            warnings.push(`Only document and edition names were searched for "${value}": document_tag_values is not migrated on this database.`);
          }
          clauses.push(`(
            ${hasTagValues ? `EXISTS (
              SELECT 1 FROM document_tag_values dtv
              WHERE dtv.document_id = d.id 
                AND dtv.tag_name = ANY($${paramIndex}::text[])
                AND (dtv.value ILIKE $${paramIndex + 1} OR dtv.value ILIKE $${paramIndex + 2})
            )` : `($${paramIndex}::text[] IS NULL AND FALSE)`}
            OR (
              $${paramIndex + 3} IN ('persName', 'term', 'head', 'title', 'bibl') AND (
                d.name ILIKE $${paramIndex + 1}
                OR EXISTS (
                  SELECT 1 FROM editions ed
                  WHERE ed.id = d.edition_id AND (ed.name ILIKE $${paramIndex + 1} OR ed.name ILIKE $${paramIndex + 2})
                )
              )
            )
          )`);
          params.push(extraTagNames, `%${value}%`, cleanSlug, tag);
          paramIndex += 4;
        } else {
          // Pure structural TEI tag presence
          clauses.push(`EXISTS (
            SELECT 1 FROM document_tags dt
            JOIN tags tg ON dt.tag_id = tg.id
            WHERE dt.document_id = d.id AND tg.name = $${paramIndex}
          )`);
          params.push(tag);
          paramIndex++;
        }
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
      // 'und' (not detectable: too little text), 'mul' and 'zxx' are not languages; they stay
      // out of the chart and are reported as one count under it.
      const NON_LANGUAGE = ['und', 'mul', 'zxx'];
      const noLangRes = await client.query(`
        SELECT COUNT(*)::int AS n FROM temp_docs t
         WHERE NOT EXISTS (SELECT 1 FROM document_languages dl JOIN languages l ON l.id = dl.language_id
                            WHERE dl.document_id = t.id AND NOT (l.iso_code = ANY($1::text[])))`, [NON_LANGUAGE]);
      const langsUnassigned = noLangRes.rows[0].n;
      langAgg.rows.filter(r => !NON_LANGUAGE.includes(r.lang)).forEach(r => {
        langsMap[r.lang] = {
          total: parseInt(r.total),
          confirmed: parseInt(r.confirmed),
          inferred: parseInt(r.inferred)
        };
      });

      // 2. Timeline Aggregation
      const timeQuery = `
        SELECT ${SIGNED_YEAR('te')} AS year, ${countExpr} as count
        FROM temp_docs t
        JOIN document_time_entities dte ON t.id = dte.document_id
        JOIN time_entities te ON dte.time_entity_id = te.id
        WHERE dte.date_type = $1
        GROUP BY 1;
      `;
      const timeAgg = await client.query(timeQuery, [dateSource]);
      const yearsMap = {};
      timeAgg.rows.forEach(r => {
        yearsMap[r.year] = { count: parseInt(r.count) };
      });

      // 3. Geolocations Aggregation
      const geoQuery = `
        SELECT g.name as city,
               MAX(g.country) as country,
               COALESCE(AVG(ST_Y(g.geometry)) ${precise}, AVG(ST_Y(g.geometry))) as lat,
               COALESCE(AVG(ST_X(g.geometry)) ${precise}, AVG(ST_X(g.geometry))) as lng,
               ${approxExpr} as approximate,
               ${countExpr} as total,
               ${viewMode === 'edition' ? 'ARRAY_AGG(DISTINCT t.edition_id)' : 'NULL::int[]'} as eds,
               ${geoMatchPatterns
                 ? 'BOOL_OR(g.name ILIKE ANY($2::text[]) OR g.country ILIKE ANY($2::text[]))'
                 : 'FALSE'} as matched
        FROM temp_docs t
        JOIN document_geolocations dg ON t.id = dg.document_id
        JOIN geolocations g ON dg.geolocation_id = g.id
        WHERE dg.geo_type = $1 ${settlementsOnly}
        GROUP BY g.name, g.country_code;
      `;
      const geoAgg = await client.query(geoQuery, geoMatchPatterns ? [geoSource, geoMatchPatterns] : [geoSource]);
      const citiesMap = {};
      geoAgg.rows.forEach(r => {
        let cleanName = (r.city || '').trim();
        if (!cleanName) return;
        // Two different places with the same name (Paris FR / Paris US) stay apart.
        if (citiesMap[cleanName] && r.country) cleanName = `${cleanName} (${r.country})`;
        citiesMap[cleanName] = {
          name: r.city,
          total: parseInt(r.total),
          confirmed: parseInt(r.total),
          inferred: 0,
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lng),
          country: r.country,
          matched: r.matched === true
            || Boolean(place && r.city === place.name && (r.country || '') === (place.country || '')),
          approximate: r.approximate === true, // only a country-centre point is known
          ...(r.eds ? { eds: r.eds } : {}),     // edition mode: lets map clusters count distinct editions
        };
      });

      // 4. Features Aggregation (pre-populate all known attributes so characteristic tiles never disappear)
      const allAttrsRes = await client.query(
        'SELECT name FROM attributes_metadata WHERE NOT (name = ANY($1::text[]));', [PSEUDO_ATTRIBUTES]);
      const featuresMap = {};
      allAttrsRes.rows.forEach(r => {
        featuresMap[r.name] = 0;
      });

      const featureQuery = `
        SELECT am.name as key, ${countExpr} as count
        FROM temp_docs t
        JOIN document_attributes da ON t.id = da.document_id
        JOIN attributes_metadata am ON da.attribute_id = am.id
        GROUP BY am.name;
      `;
      const featureAgg = await client.query(featureQuery);
      featureAgg.rows.forEach(r => {
        featuresMap[r.key] = parseInt(r.count);
      });

      // 4b. Custom tag filters get counts too, so their bars render alongside
      // the built-in characteristics instead of always showing zero.
      const customCountExpr = viewMode === 'edition'
        ? 'COUNT(DISTINCT t.edition_id)'
        : 'COUNT(t.id)';
      if (savedTags.size) {
        const savedAgg = await client.query(`
          SELECT ct.key, ${customCountExpr} AS count
            FROM temp_docs t JOIN custom_tag_documents ctd ON ctd.document_id = t.id
            JOIN custom_tags ct ON ct.id = ctd.tag_id GROUP BY ct.key`);
        savedTags.forEach((_, key) => { featuresMap[key] = 0; });
        savedAgg.rows.forEach((r) => { featuresMap[r.key] = parseInt(r.count, 10) || 0; });
      }
      for (const { key, tags } of customFilters.filter((f) => !savedTags.has(f.key))) {
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
        SELECT ed.name, ed.description, ${countExpr} as count
        FROM temp_docs t
        JOIN editions ed ON t.edition_id = ed.id
        GROUP BY ed.name, ed.description
        ORDER BY count DESC;
      `;
      const edAgg = await client.query(edAggQuery);
      const editionsList = edAgg.rows.map(r => r.name);
      const editionDetails = edAgg.rows.map(r => ({
        name: r.name,
        description: r.description || '',
        count: parseInt(r.count)
      }));

      // 7. Sample of matching documents (up to 100)
      const docSampleQuery = `
        SELECT d.id, d.name as name, ed.name as edition_name
        FROM temp_docs t
        JOIN documents d ON t.id = d.id
        JOIN editions ed ON d.edition_id = ed.id
        ORDER BY d.id
        LIMIT 100;
      `;
      const docSampleRes = await client.query(docSampleQuery);

      await client.query('COMMIT');

      res.status(200).json({
        totalDocs,
        totalEditions,
        langs: langsMap,
        langsUnassigned,
        years: yearsMap,
        cities: citiesMap,
        features: featuresMap,
        topics: topicsMap,
        editions: editionsList,
        editionDetails,
        documents: docSampleRes.rows,
        warnings,
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
