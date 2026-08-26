import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import { getPool, applyCors } from './_db.js';

const select = xpath.useNamespaces({ tei: 'http://www.tei-c.org/ns/1.0' });

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

// Reject payloads before we try to parse them. 25MB is comfortably above the
// largest file in raw_documents/ and well under Vercel's body limit.
const MAX_CONTENT_BYTES = 25 * 1024 * 1024;

// How many topics to assign per uploaded document.
const TOPICS_PER_DOC = 3;

// Simple language heuristic fallback
function inferLanguage(text) {
  const t = text.toLowerCase();
  const deScore = (t.match(/\b(der|die|das|und|ist|ich|nicht|zu|es|sie)\b/g) || []).length;
  const enScore = (t.match(/\b(the|and|of|to|is|in|that|it|he|was)\b/g) || []).length;
  const frScore = (t.match(/\b(le|la|les|et|est|un|une|des|qui|que)\b/g) || []).length;
  const laScore = (t.match(/\b(et|in|est|qui|non|ad|ut|cum|quod|si)\b/g) || []).length;

  const max = Math.max(deScore, enScore, frScore, laScore);
  if (max === 0) return 'de'; // Swiss/German default fallback
  if (max === deScore) return 'de';
  if (max === enScore) return 'en';
  if (max === frScore) return 'fr';
  return 'la';
}

function parseYears(str) {
  if (!str) return [];
  str = str.trim();
  // Match a negative or positive 3-4 digit year number
  const m = str.match(/(-?\d{3,4})/);
  if (m) {
    const yr = parseInt(m[1]);
    if (!isNaN(yr) && yr >= -3000 && yr <= 2026) {
      return [yr];
    }
  }
  return [];
}

/** Namespace-stripped element name counts, matching db/backfill_tags.py. */
function collectTags(node, counts = new Map()) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1) continue; // ELEMENT_NODE
    const name = child.localName || child.nodeName;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
    collectTags(child, counts);
  }
  return counts;
}

/**
 * Assign topics by keyword overlap against topics.words.
 *
 * This is a heuristic, NOT the FasTopic model that produced the topic
 * assignments for the existing 127k documents (see
 * data/pipeline/topic_clustering/fastopic_v2.py). Running inference here would
 * mean shipping the model into a serverless function. Documents ingested via
 * upload therefore get approximate topics; re-run the clustering pipeline if
 * you need them to be comparable with the bulk corpus.
 */
function scoreTopics(text, topicRows) {
  const words = new Map();
  for (const w of text.toLowerCase().match(/\p{L}{3,}/gu) || []) {
    words.set(w, (words.get(w) || 0) + 1);
  }
  if (words.size === 0) return [];

  const scored = [];
  for (const { id, words: topicWords } of topicRows) {
    if (!Array.isArray(topicWords) || topicWords.length === 0) continue;
    let hits = 0;
    for (const tw of topicWords) {
      const n = words.get(String(tw).toLowerCase());
      if (n) hits += n;
    }
    if (hits > 0) scored.push({ id, hits });
  }

  scored.sort((a, b) => b.hits - a.hits);
  // Normalise across every topic that matched, not just the ones we keep, so a
  // document matching a single topic weakly doesn't come out at confidence 1.0.
  const totalHits = scored.reduce((s, t) => s + t.hits, 0) || 1;
  return scored
    .slice(0, TOPICS_PER_DOC)
    .map(t => ({ id: t.id, confidence: Number((t.hits / totalHits).toFixed(4)) }));
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'POST,OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { filename, content, edition, editionDescription, editionWebsite } = req.body || {};

  if (!filename || !content || !edition) {
    return res.status(400).json({ error: 'Missing required fields: filename, content, and edition' });
  }

  // --- 1. VALIDATION MIDDLEWARE ---
  if (typeof content !== 'string' || typeof filename !== 'string' || typeof edition !== 'string') {
    return res.status(400).json({ error: 'Validation Error: filename, content and edition must be strings' });
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return res.status(413).json({
      error: `Validation Error: file exceeds the ${MAX_CONTENT_BYTES / 1024 / 1024}MB limit`,
    });
  }

  if (!filename.toLowerCase().endsWith('.xml')) {
    return res.status(400).json({ error: 'Validation Error: File must have a .xml extension' });
  }

  // Path separators in a filename would let a caller fake an edition prefix.
  if (/[\\/]/.test(filename)) {
    return res.status(400).json({ error: 'Validation Error: filename must not contain path separators' });
  }

  let doc;
  const parseErrors = [];
  try {
    const parser = new DOMParser({
      errorHandler: {
        warning: () => {},
        error: (e) => parseErrors.push(e),
        fatalError: (e) => parseErrors.push(e),
      },
    });
    doc = parser.parseFromString(content, 'text/xml');
  } catch (err) {
    return res.status(400).json({ error: `XML Parsing Error: ${err.message}` });
  }

  if (parseErrors.length > 0) {
    return res.status(400).json({ error: `XML Validation Error: ${parseErrors.join('; ')}` });
  }

  const root = doc.documentElement;
  if (!root || (root.localName !== 'TEI' && root.localName !== 'teiCorpus')) {
    return res.status(400).json({ error: 'Validation Error: Root XML element must be <TEI> or <teiCorpus>' });
  }

  const teiHeader = doc.getElementsByTagNameNS(TEI_NS, 'teiHeader')[0]
                    || doc.getElementsByTagName('teiHeader')[0];
  if (!teiHeader) {
    return res.status(400).json({ error: 'Validation Error: Required <teiHeader> element is missing' });
  }

  // --- 2. PIPELINE EXTRACTION ---
  try {
    // A. Title
    let title = select('string(//tei:titleStmt/tei:title/text())', doc)
                || select('string(//tei:title/text())', doc);
    title = title ? title.trim() : filename;

    // B. Language
    let langCode = select('string(//tei:textLang/@ident)', doc)
                   || select('string(//tei:text/@*[local-name()="lang"])', doc)
                   || select('string(//@*[local-name()="lang"])', doc);
    langCode = langCode ? langCode.trim().toLowerCase() : null;

    const LANG_MAP = {
      english: "en", en: "en", eng: "en",
      german: "de", deutsch: "de", de: "de", deu: "de", ger: "de",
      french: "fr", français: "fr", francais: "fr", fr: "fr",
      latin: "la", la: "la", lat: "la",
      italian: "it", italiano: "it", it: "it",
      spanish: "es", español: "es", es: "es"
    };

    // Body text, reused for language inference and topic scoring.
    const textNodes = select('//tei:text//text()', doc);
    const bodyText = textNodes.map(n => n.nodeValue).join(' ');

    let normalizedLang = LANG_MAP[langCode] || langCode;
    const langInferred = !normalizedLang;

    if (langInferred) {
      normalizedLang = inferLanguage(bodyText.substring(0, 1000));
    }

    // C. Dates (Creation, Publication, Contextual)
    const dates = { creation: [], publication: [], contextual: [] };

    const creationNodes = select('//tei:profileDesc//tei:creation//tei:date | //tei:profileDesc//tei:creation//tei:origDate | //tei:msDesc//tei:history//tei:origin//tei:date | //tei:correspDesc//tei:correspAction[@type="sent"]//tei:date', doc);
    creationNodes.forEach(n => {
      const val = n.getAttribute('when') || n.getAttribute('when-iso') || n.getAttribute('from') || n.getAttribute('notBefore') || n.textContent;
      dates.creation.push(...parseYears(val));
    });

    const pubNodes = select('//tei:fileDesc//tei:publicationStmt//tei:date | //tei:teiHeader//tei:imprint//tei:date | //tei:fileDesc//tei:sourceDesc//tei:date', doc);
    pubNodes.forEach(n => {
      const val = n.getAttribute('when') || n.getAttribute('when-iso') || n.getAttribute('from') || n.textContent;
      dates.publication.push(...parseYears(val));
    });

    const ctxNodes = select('//tei:text//tei:date | //tei:body//tei:date | //tei:dateline//tei:date', doc);
    ctxNodes.forEach(n => {
      const val = n.getAttribute('when') || n.getAttribute('when-iso') || n.getAttribute('from') || n.textContent;
      dates.contextual.push(...parseYears(val));
    });

    // D. Geolocations (Creation, Publication, Contextual)
    const geolocations = { creation: [], publication: [], contextual: [] };

    const creGeo = select('//tei:profileDesc//tei:creation//tei:origPlace/text() | //tei:profileDesc//tei:creation//tei:placeName/text() | //tei:msDesc//tei:history//tei:origin//tei:origPlace/text()', doc);
    creGeo.forEach(n => { if (n.nodeValue.trim()) geolocations.creation.push(n.nodeValue.trim()); });

    const pubGeo = select('//tei:fileDesc//tei:publicationStmt//tei:pubPlace/text() | //tei:teiHeader//tei:imprint//tei:pubPlace/text()', doc);
    pubGeo.forEach(n => { if (n.nodeValue.trim()) geolocations.publication.push(n.nodeValue.trim()); });

    const ctxGeo = select('//tei:text//tei:placeName/text() | //tei:body//tei:placeName/text()', doc);
    ctxGeo.forEach(n => { if (n.nodeValue.trim()) geolocations.contextual.push(n.nodeValue.trim()); });

    // E. Features (Boolean characteristics)
    const features = {};
    if (select('count(//tei:lg | //tei:l)', doc) > 0) features['contains_verse'] = true;
    if (select('count(//tei:sp | //tei:said | //tei:u)', doc) > 0) features['contains_direct_speech'] = true;
    if (select('count(//@lemma | //@pos | //tei:w[@lemma])', doc) > 0) features['contains_linguistic_annotation'] = true;
    if (select('count(//tei:msDesc)', doc) > 0) features['is_manuscript'] = true;
    if (select('count(//tei:correspDesc)', doc) > 0 || filename.toLowerCase().includes('letter') || filename.toLowerCase().includes('brief')) features['is_letter'] = true;
    if (select('count(//tei:entry | //tei:superEntry)', doc) > 0) features['contains_dictionary'] = true;
    if (filename.toLowerCase().includes('diary') || filename.toLowerCase().includes('tagebuch')) features['contains_diary'] = true;

    // F. TEI tags (feeds the custom tag filter)
    // Walking from the document node means the root element is included.
    const tagCounts = collectTags(doc);

    // --- 3. DATABASE INGESTION ---
    const dbPool = getPool();
    const client = await dbPool.connect();

    let warnings = [];

    try {
      await client.query('BEGIN');

      // Check or insert digital edition
      let editionId;
      let editionCreated = false;
      const edCheck = await client.query('SELECT id FROM editions WHERE name = $1;', [edition]);
      if (edCheck.rows.length > 0) {
        editionId = edCheck.rows[0].id;
      } else {
        const desc = editionDescription ? editionDescription.trim() : `Digital edition of ${edition}`;
        const web = editionWebsite ? editionWebsite.trim() : 'https://example.org';
        const edInsert = await client.query(
          'INSERT INTO editions (name, description, image_file_name, website, added, number_documents, size_in_mb) VALUES ($1, $2, $3, $4, CURRENT_DATE, 0, 0) RETURNING id;',
          [edition, desc, 'sample.png', web]
        );
        editionId = edInsert.rows[0].id;
        editionCreated = true;
      }

      // Duplicate guard. Previously a repeated upload silently created a second
      // row and double-counted the edition's document total.
      const dupe = await client.query(
        'SELECT id FROM documents WHERE edition_id = $1 AND name = $2 LIMIT 1;',
        [editionId, filename]
      );
      if (dupe.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `"${filename}" already exists in edition "${edition}" as document ${dupe.rows[0].id}. Delete it first or rename the file.`,
          documentId: dupe.rows[0].id,
          duplicate: true,
        });
      }

      // Insert document
      const docInsert = await client.query(
        'INSERT INTO documents (edition_id, name) VALUES ($1, $2) RETURNING id;',
        [editionId, filename]
      );
      const documentId = docInsert.rows[0].id;

      await client.query(
        'UPDATE editions SET number_documents = number_documents + 1 WHERE id = $1;',
        [editionId]
      );

      // Insert Language
      let langId;
      const langCheck = await client.query('SELECT id FROM languages WHERE iso_code = $1;', [normalizedLang]);
      if (langCheck.rows.length > 0) {
        langId = langCheck.rows[0].id;
      } else {
        const langInsert = await client.query(
          'INSERT INTO languages (name, iso_code) VALUES ($1, $2) RETURNING id;',
          [normalizedLang.toUpperCase(), normalizedLang]
        );
        langId = langInsert.rows[0].id;
      }
      await client.query(
        'INSERT INTO document_languages (document_id, language_id, inference_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
        [documentId, langId, langInferred ? 'inferred' : 'original']
      );

      // Insert Dates (Time Entities)
      for (const [dateType, yearsList] of Object.entries(dates)) {
        for (const yr of new Set(yearsList)) {
          const era = yr < 0 ? 'BC' : 'CE';
          const absYr = Math.abs(yr);

          let timeId;
          const timeCheck = await client.query('SELECT id FROM time_entities WHERE year = $1 AND era = $2;', [absYr, era]);
          if (timeCheck.rows.length > 0) {
            timeId = timeCheck.rows[0].id;
          } else {
            const timeInsert = await client.query(
              'INSERT INTO time_entities (year, era) VALUES ($1, $2) RETURNING id;',
              [absYr, era]
            );
            timeId = timeInsert.rows[0].id;
          }

          await client.query(
            'INSERT INTO document_time_entities (document_id, time_entity_id, date_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
            [documentId, timeId, dateType]
          );
        }
      }

      // Insert Geolocations.
      //
      // The geolocations table doubles as the project's gazetteer: after
      // db/002_backfill_geo_and_topics.py it holds ~27k place names with
      // coordinates. Reusing an existing row is what makes an uploaded
      // document show up on the map -- inserting a fresh row with NULL
      // geometry (the previous behaviour) meant it never could.
      let ungeocoded = 0;
      for (const [geoType, placeList] of Object.entries(geolocations)) {
        for (const placeName of new Set(placeList)) {
          let geoId;
          let hasGeometry = false;

          // Exact match first, then case-insensitive, before giving up.
          let geoCheck = await client.query(
            'SELECT id, geometry IS NOT NULL AS has_geom FROM geolocations WHERE name = $1 ORDER BY (geometry IS NOT NULL) DESC LIMIT 1;',
            [placeName]
          );
          if (geoCheck.rows.length === 0) {
            geoCheck = await client.query(
              'SELECT id, geometry IS NOT NULL AS has_geom FROM geolocations WHERE lower(name) = lower($1) ORDER BY (geometry IS NOT NULL) DESC LIMIT 1;',
              [placeName]
            );
          }

          if (geoCheck.rows.length > 0) {
            geoId = geoCheck.rows[0].id;
            hasGeometry = geoCheck.rows[0].has_geom;
          } else {
            const geoInsert = await client.query(
              'INSERT INTO geolocations (name, country, country_code, continent, geometry) VALUES ($1, NULL, NULL, NULL, NULL) RETURNING id;',
              [placeName]
            );
            geoId = geoInsert.rows[0].id;
          }

          if (!hasGeometry) ungeocoded++;

          await client.query(
            'INSERT INTO document_geolocations (document_id, geolocation_id, geo_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
            [documentId, geoId, geoType]
          );
        }
      }
      if (ungeocoded > 0) {
        warnings.push(
          `${ungeocoded} place name(s) are not in the gazetteer and have no coordinates; ` +
          `they will not appear on the map or in the city list.`
        );
      }

      // Insert Attributes (Features)
      for (const [featureKey, featureVal] of Object.entries(features)) {
        if (!featureVal) continue;
        let attrId;
        const attrCheck = await client.query('SELECT id FROM attributes_metadata WHERE name = $1;', [featureKey]);
        if (attrCheck.rows.length > 0) {
          attrId = attrCheck.rows[0].id;
        } else {
          const attrInsert = await client.query(
            'INSERT INTO attributes_metadata (name, type) VALUES ($1, $2) RETURNING id;',
            [featureKey, 'boolean']
          );
          attrId = attrInsert.rows[0].id;
        }

        await client.query(
          'INSERT INTO document_attributes (document_id, attribute_id, is_inferred) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
          [documentId, attrId, 'original']
        );
      }

      // Insert TEI tags
      let tagsStored = 0;
      try {
        for (const [tagName, occurrences] of tagCounts) {
          const name = tagName.slice(0, 255);
          const tagRow = await client.query(
            `INSERT INTO tags (name) VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id;`,
            [name]
          );
          await client.query(
            `INSERT INTO document_tags (document_id, tag_id, occurrences)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;`,
            [documentId, tagRow.rows[0].id, occurrences]
          );
          tagsStored++;
        }
      } catch (err) {
        if (err.code === '42P01') {
          // Tag tables not migrated yet. Not fatal -- the document itself is
          // still valid -- but the custom tag filter will not see it.
          throw Object.assign(
            new Error('Tag tables are missing. Run db/001_add_tags.sql (and db/backfill_tags.py) before uploading.'),
            { statusCode: 503 }
          );
        }
        throw err;
      }

      // Assign topics (heuristic - see scoreTopics)
      const topicRows = await client.query('SELECT id, words FROM topics;');
      const usableTopics = topicRows.rows.filter(
        t => Array.isArray(t.words) && t.words.length > 0 &&
             !(t.words.length === 2 && t.words[0] === 'topic' && t.words[1] === 'keywords')
      );

      let assignedTopics = [];
      if (usableTopics.length === 0) {
        warnings.push(
          'topics.words still holds the placeholder {topic,keywords} from the dump, ' +
          'so no topics could be assigned. Run db/002_backfill_geo_and_topics.py.'
        );
      } else {
        assignedTopics = scoreTopics(bodyText, usableTopics);
        for (const { id, confidence } of assignedTopics) {
          await client.query(
            'INSERT INTO document_topics (document_id, topic_id, confidence) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
            [documentId, id, confidence]
          );
        }
        if (assignedTopics.length === 0) {
          warnings.push('No topic keywords matched this document; it will not appear under any topic.');
        }
      }

      await client.query('COMMIT');

      res.status(200).json({
        message: 'Successfully processed and ingested document into the database',
        documentId,
        editionCreated,
        warnings,
        metadata: {
          title,
          language: normalizedLang,
          languageInferred: langInferred,
          dates,
          geolocations,
          features: Object.keys(features),
          tags: tagsStored,
          topics: assignedTopics,
        },
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Metadata Ingestion Error:', error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : `Pipeline ingestion failed: ${error.message}`,
    });
  }
}
