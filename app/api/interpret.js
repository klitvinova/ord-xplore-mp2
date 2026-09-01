import { OpenAI } from 'openai';
import { getPool, applyCors } from './_db.js';

let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'dummy-key-for-initialization',
    });
  }
  return openai;
}

const CAISI_URL = (process.env.CAISI_URL || 'http://localhost:8001').replace(/\/$/, '');

/**
 * Fetch active property catalog from the database to inject into the LLM system prompt.
 */
async function getDynamicProperties() {
  try {
    const { rows } = await getPool().query(
      `SELECT name, display_name, type, description, options FROM properties ORDER BY id;`
    );
    if (rows && rows.length > 0) {
      return rows;
    }
  } catch (err) {
    // Database or table not available, use defaults
  }

  // Fallback default properties matching MCF digital editions schema
  return [
    { name: 'contains_verse', display_name: 'Contains Verse', type: 'binary', description: 'Whether the edition contains verse' },
    { name: 'contains_linguistic_annotation', display_name: 'Contains Linguistic Annotation', type: 'binary', description: 'Whether the edition contains linguistic annotation' },
    { name: 'contains_direct_speech', display_name: 'Contains Direct Speech', type: 'binary', description: 'Whether the edition contains direct speech' },
    { name: 'contains_east_asian_scripts', display_name: 'Contains East Asian Scripts', type: 'binary', description: 'Whether East Asian scripts are present' },
    { name: 'contains_japanese_scripts', display_name: 'Contains Japanese Scripts', type: 'binary', description: 'Whether Japanese scripts are present' },
    { name: 'contains_newspaper_articles', display_name: 'Contains Newspaper Articles', type: 'binary', description: 'Whether the edition contains newspaper articles' },
    { name: 'is_manuscript', display_name: 'Is Manuscript', type: 'binary', description: 'Whether the edition is manuscript-based' },
    { name: 'contains_inscriptions', display_name: 'Contains Inscriptions', type: 'binary', description: 'Whether the edition contains inscriptions' },
    { name: 'contains_dictionary', display_name: 'Contains Dictionary', type: 'binary', description: 'Whether the edition contains dictionary-like material' },
    { name: 'is_letter', display_name: 'Is Letter', type: 'binary', description: 'Whether the edition contains letters' },
    { name: 'is_political_letter', display_name: 'Is Political Letter', type: 'binary', description: 'Whether the edition contains political letters' },
    { name: 'contains_law_texts', display_name: 'Contains Law Texts', type: 'binary', description: 'Whether the edition contains legal texts' },
    { name: 'contains_diary', display_name: 'Contains Diary', type: 'binary', description: 'Whether the edition contains diary material' },
    { name: 'is_medieval_manuscript', display_name: 'Is Medieval Manuscript', type: 'binary', description: 'Whether the edition is a medieval manuscript' },
    { name: 'contains_theatre', display_name: 'Contains Theatre', type: 'binary', description: 'Whether the edition contains theatre content' },
    { name: 'is_historic', display_name: 'Is Historic', type: 'binary', description: 'Whether the edition is historic' },
    { name: 'contains_political_protocols', display_name: 'Contains Political Protocols', type: 'binary', description: 'Whether the edition contains political protocols' },
    { name: 'doc_count', display_name: 'Document Count', type: 'numerical', description: 'Number of documents in the edition' },
    { name: 'language', display_name: 'Language', type: 'multiple_choice', description: 'Language code of the text', options: ['en', 'de', 'fr', 'la', 'it', 'es'] },
    { name: 'people_genders', display_name: 'People Genders', type: 'multiple_choice', description: 'Genders mentioned', options: ['male', 'female'] },
    { name: 'doc_type', display_name: 'Document Type', type: 'multiple_choice', description: 'Document type' },
    { name: 'rights', display_name: 'Rights', type: 'multiple_choice', description: 'Rights or license information' },
  ];
}

async function getTeiTagDefinitions() {
  try {
    const { rows } = await getPool().query(
      `SELECT name, category, description, example_queries FROM tei_tag_definitions ORDER BY category, name;`
    );
    if (rows && rows.length > 0) return rows;
  } catch (err) {}
  return [];
}

/**
 * Build MCF/CaISI workflow prompt using active dynamic property schema and TEI guidelines.
 */
function buildCaisiSystemPrompt(properties, teiTags = []) {
  const binaryProps = properties.filter(p => p.type === 'binary').map(p => p.name);
  const choiceProps = properties.filter(p => p.type === 'multiple_choice').map(p => {
    const opts = Array.isArray(p.options) && p.options.length > 0 ? ` (options: ${p.options.slice(0, 8).join(', ')})` : '';
    return `${p.name}${opts}`;
  });

  const teiGuidelineList = teiTags.slice(0, 35).map(t => `<${t.name}> (${t.category}): ${t.description}`).join('\n   - ');

  return `You are the CaISI (Metadata Curation Framework) Intent Elicitation and Query Resolution Engine for ORD Xplore.

Your task is to analyze user queries over historical digital editions and metadata using both high-level facets and raw TEI XML tags.
Perform three distinct steps:

1. QUERY SCOPE CLASSIFICATION:
   - "supported": The query expresses an exploratory search, filtering, comparison, or structuring need over the collection (e.g. "French letters around 1750", "find documents with verse", "editions from Germany").
   - "unclear": The query is ambiguous, a single bare topic with no filtering criteria, or needs refinement (e.g. "history", "letters?").
   - "unsupported": The query is a general knowledge question or factoid QA not answerable by filtering metadata facets (e.g. "What is the capital of Switzerland?", "Who was Napoleon?").

2. ATOMIC INTENT DECOMPOSITION:
   - Break complex verbalizations into discrete atomic intent statements (e.g. "French letters from 1750 with verse" -> ["Language is French", "Time is 1750", "Document is letter", "Contains verse"]).

3. FACET, PROPERTY & RAW TEI TAG MAPPING:
   - Standard facets:
     * "time": year(s) or year ranges (e.g. [1750, 1800] or [1750])
     * "geography": city name or country (e.g. "Zurich", "Switzerland", "France", "Germany")
     * "language": ISO code or language name ("fr", "en", "de", "la", "it")
     * "topic": topic keywords
   - Dynamic binary properties: ${binaryProps.join(', ')}
   - Categorical / choice properties: ${choiceProps.join(', ')}
   - Raw TEI XML Elements (based on TEI P5 Guidelines):
   - ${teiGuidelineList || '<persName>, <placeName>, <date>, <lg>, <opener>, <signed>, <sp>, <said>, <licence>, <stamp>, <term>'}

SELECTION & MAPPING RULES:
- Do NOT guess unstated facets.
- Adjectives like "French", "German", "Latin", "English" map to language unless an explicit place/country is stated.
- "18th century" maps to time range [1700, 1799]. "19th century" -> [1800, 1899].
- Binary properties take value "true" or "false".
- If specific TEI tags or tag values are mentioned (e.g. signed by X, person X, place Y), emit them in tags/tagValues.

OUTPUT FORMAT (JSON only, no markdown):
{
  "data": {
    "scope": {
      "decision": "supported" | "unclear" | "unsupported",
      "reason": "Clear explanation of the scope classification",
      "message": "User-facing message explaining how the query was interpreted or how to rephrase if unclear/unsupported"
    },
    "intents": [
      {
        "statement": "Atomic intent statement",
        "facet": "facet_or_property_name",
        "filter": { "op": "include" | "range" | "match", "values": ["value1"] }
      }
    ],
    "facets": {
      "time": [{ "op": "include" | "range", "values": ["1750", "1800"] }],
      "geography": [{ "op": "include", "values": ["Zurich"] }],
      "language": [{ "op": "include", "values": ["fr"] }],
      "properties": [
        { "name": "is_letter", "value": true }
      ],
      "tagValues": [
        { "tag": "signed", "value": "Cody" }
      ]
    },
    "message": "Brief summary of applied filters"
  }
}`;
}

/**
 * Offline heuristic fallback when LLM API is unavailable.
 */
function resolveHeuristicIntent(query, dynamicProperties) {
  const q = query.toLowerCase().trim();

  // Scope check: factoid question
  if (/^(what|who|where|why|how|tell me|when was|explain)\b/i.test(q)) {
    return {
      scope: {
        decision: 'unsupported',
        reason: 'Factoid question answering is not supported by metadata filters.',
        message: 'The system only supports exploring and filtering digital edition metadata.'
      },
      intents: [],
      facets: {},
      message: 'Query outside collection exploration scope.'
    };
  }

  // Scope check: single vague keyword
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 1 && !/\d/.test(q) && ['history', 'letters', 'data', 'docs', 'text', 'edition'].includes(words[0])) {
    return {
      scope: {
        decision: 'unclear',
        reason: `Single keyword "${query}" is too broad.`,
        message: 'Please specify filtering criteria like time ranges (e.g. 1750-1800), languages, or features.'
      },
      intents: [],
      facets: {},
      message: 'Please refine your query with additional filter criteria.'
    };
  }

  const intents = [];
  const facets = {
    properties: []
  };

  // Time detection
  const rangeMatch = q.match(/\b(1\d{3}|20\d{2})\s*(?:to|-|until)\s*(1\d{3}|20\d{2})\b/);
  if (rangeMatch) {
    const y1 = parseInt(rangeMatch[1]);
    const y2 = parseInt(rangeMatch[2]);
    facets.time = [{ op: 'range', values: [Math.min(y1, y2), Math.max(y1, y2)] }];
    intents.push({ statement: `Time: ${Math.min(y1, y2)}–${Math.max(y1, y2)}`, facet: 'time', filter: facets.time[0] });
  } else if (/\b18th century\b/i.test(q)) {
    facets.time = [{ op: 'range', values: [1700, 1799] }];
    intents.push({ statement: 'Time: 18th Century (1700-1799)', facet: 'time', filter: facets.time[0] });
  } else if (/\b19th century\b/i.test(q)) {
    facets.time = [{ op: 'range', values: [1800, 1899] }];
    intents.push({ statement: 'Time: 19th Century (1800-1899)', facet: 'time', filter: facets.time[0] });
  } else {
    const singleYear = q.match(/\b(1\d{3}|20\d{2})\b/);
    if (singleYear) {
      const yr = parseInt(singleYear[1]);
      facets.time = [{ op: 'include', values: [yr] }];
      intents.push({ statement: `Time: ${yr}`, facet: 'time', filter: facets.time[0] });
    }
  }

  // Language detection
  const langMap = {
    french: 'fr', german: 'de', english: 'en', latin: 'la', italian: 'it', spanish: 'es'
  };
  for (const [name, code] of Object.entries(langMap)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(q)) {
      facets.language = [{ op: 'include', values: [code] }];
      intents.push({ statement: `Language: ${name.charAt(0).toUpperCase() + name.slice(1)} (${code})`, facet: 'language', filter: facets.language[0] });
      break;
    }
  }

  // Geography & Location Detection
  const geoKnowledge = [
    { pattern: /\b(?:egypt|ägypten|aegypten|cairo|alexandria)\b/i, name: 'Egypt' },
    { pattern: /\b(?:greece|griechenland|hellas|athens)\b/i, name: 'Greece' },
    { pattern: /\b(?:italy|italien|italia|rome|rom|venice|florence|naples)\b/i, name: 'Italy' },
    { pattern: /\b(?:france|frankreich|paris|lyon|marseille)\b/i, name: 'France' },
    { pattern: /\b(?:germany|deutschland|berlin|munich|münchen|frankfurt|heidelberg)\b/i, name: 'Germany' },
    { pattern: /\b(?:switzerland|schweiz|zurich|zürich|basel|bern|geneva|genf)\b/i, name: 'Switzerland' },
    { pattern: /\b(?:austria|österreich|vienna|wien|salzburg|innsbruck)\b/i, name: 'Austria' },
    { pattern: /\b(?:spain|spanien|españa|madrid|barcelona|toledo)\b/i, name: 'Spain' },
    { pattern: /\b(?:united\s+kingdom|england|britain|great\s+britain|london|cambridge|oxford)\b/i, name: 'United Kingdom' },
    { pattern: /\b(?:united\s+states|america|usa|washington|new\s+york)\b/i, name: 'United States' },
    { pattern: /\b(?:israel|palestine|jerusalem)\b/i, name: 'Israel' },
    { pattern: /\b(?:bulgaria|bulgarien|sofia)\b/i, name: 'Bulgaria' },
    { pattern: /\b(?:turkey|türkei|ottoman|constantinople|istanbul)\b/i, name: 'Turkey' },
    { pattern: /\b(?:libya|cyrenaica|cyrene)\b/i, name: 'Libya' },
    { pattern: /\b(?:japan|kyoto|tokyo)\b/i, name: 'Japan' },
    { pattern: /\b(?:china|beijing|dunhuang)\b/i, name: 'China' },
    { pattern: /\b(?:netherlands|holland|amsterdam)\b/i, name: 'Netherlands' },
    { pattern: /\b(?:belgium|belgien|brussels)\b/i, name: 'Belgium' },
    { pattern: /\b(?:russia|russland|moscow|petersburg)\b/i, name: 'Russia' },
    { pattern: /\b(?:morocco|marokko|tunisia|tunesien)\b/i, name: 'North Africa' }
  ];

  let detectedGeo = null;
  for (const gk of geoKnowledge) {
    if (gk.pattern.test(query)) {
      detectedGeo = gk.name;
      break;
    }
  }

  // Preposition match for any other capitalized place (e.g. from X, in X, at X)
  if (!detectedGeo) {
    const geoMatch = query.match(/(?:in|from|at|near|around|located\s+in|written\s+in|sent\s+from)\s+([A-Z][a-zA-Z\s]+?)(?=\s+(?:in|from|between|with|dated|containing|about)\b|$)/);
    if (geoMatch) {
      const g = geoMatch[1].trim();
      if (g && !['the', 'a', 'an', 'french', 'german', 'latin', 'english', '18th', '19th', 'medieval'].includes(g.toLowerCase())) {
        detectedGeo = g;
      }
    }
  }

  if (detectedGeo) {
    facets.geography = [{ op: 'include', values: [detectedGeo] }];
    facets.country = detectedGeo;
    intents.push({ statement: `Location: ${detectedGeo} (<placeName>)`, facet: 'geography', filter: facets.geography[0] });
  }

  // Topic Detection across 50 Clusters
  const topicKnowledge = [
    { id: 'T0', name: 'German Administrative', patterns: [/\b(?:german\s+)?administrative\b/i, /\bgerman\s+administration\b/i] },
    { id: 'T1', name: 'Board Meetings & Reports', patterns: [/\bboard\s+meetings?\b/i, /\bmeeting\s+reports?\b/i, /\bplenary\s+sessions?\b/i] },
    { id: 'T2', name: 'Business & Company Correspondence', patterns: [/\bbusiness\s+correspondence\b/i, /\bcompany\s+letters?\b/i, /\bcommercial\s+correspondence\b/i] },
    { id: 'T4', name: 'Middle High German Texts', patterns: [/\bmiddle\s+high\s+german\b/i, /\bmhd\b/i, /\bmedieval\s+german\b/i] },
    { id: 'T10', name: 'Latin Chronicles & Inscriptions', patterns: [/\blatin\s+chronicles?\b/i, /\blatin\s+inscriptions?\b/i, /\bconsular\s+records?\b/i] },
    { id: 'T11', name: 'German General Correspondence', patterns: [/\bgerman\s+general\s+correspondence\b/i] },
    { id: 'T12', name: 'English Economic Policy', patterns: [/\beconomic\s+policy\b/i, /\beconomics?\b/i, /\bbalance\s+of\s+trade\b/i] },
    { id: 'T13', name: 'Expedition Travel Journals', patterns: [/\bexpeditions?\b/i, /\btravel\s+journals?\b/i, /\bexplorations?\b/i, /\bexpedition\s+travel\b/i] },
    { id: 'T14', name: 'Education & Science', patterns: [/\beducation\s+(&|and)\s+science\b/i, /\bscientific\s+education\b/i, /\bacademic\s+teachers?\b/i] },
    { id: 'T15', name: 'Parliamentary Debates', patterns: [/\bparliamentary\s+debates?\b/i, /\bparliament\b/i, /\bbundestag\b/i, /\blegislative\s+debates?\b/i] },
    { id: 'T16', name: 'English Formal Letters', patterns: [/\benglish\s+formal\s+letters?\b/i, /\bformal\s+english\s+correspondence\b/i] },
    { id: 'T17', name: 'Insurance & Associations', patterns: [/\binsurance\b/i, /\bhealth\s+insurance\b/i, /\bassociations?\b/i] },
    { id: 'T23', name: 'German Colonial & Foreign Affairs', patterns: [/\bcolonial\b/i, /\bforeign\s+affairs\b/i, /\bcolonial\s+affairs\b/i] },
    { id: 'T24', name: 'Art & Illustration', patterns: [/\bart\s+(&|and)\s+illustration\b/i, /\billustrations?\b/i, /\bart\s+history\b/i] },
    { id: 'T25', name: 'Latin Roman Monuments', patterns: [/\broman\s+monuments?\b/i, /\blatin\s+monuments?\b/i, /\broman\s+epigraphy\b/i] },
    { id: 'T28', name: 'Archaeology & Figures', patterns: [/\barchaeolog(?:y|ical)\b/i, /\barchaeological\s+figures?\b/i] },
    { id: 'T29', name: 'Botany & Flora', patterns: [/\bbotan(?:y|ical)\b/i, /\bflora\b/i, /\bplant\s+specimens?\b/i] },
    { id: 'T31', name: 'Political Negotiations', patterns: [/\bpolitical\s+negotiations?\b/i, /\bdiplomatic\s+negotiations?\b/i] },
    { id: 'T32', name: 'Scientific Theory & Discussion', patterns: [/\bscientific\s+theory\b/i, /\bscientific\s+discussions?\b/i] },
    { id: 'T33', name: 'Spatial Planning Commission', patterns: [/\bspatial\s+planning\b/i, /\burban\s+planning\b/i, /\bplanning\s+commission\b/i] },
    { id: 'T34', name: 'Swiss Historical Records', patterns: [/\bswiss\s+historical\s+records?\b/i, /\bswiss\s+history\b/i] },
    { id: 'T37', name: 'Wilderness & Camping', patterns: [/\bwilderness\b/i, /\bcamping\b/i, /\bwild\s+expedition\b/i] },
    { id: 'T38', name: 'US Foreign Policy & Military', patterns: [/\bus\s+foreign\s+policy\b/i, /\bmilitary\s+policy\b/i, /\bamerican\s+foreign\s+policy\b/i] },
    { id: 'T42', name: 'Church Community Requests', patterns: [/\bchurch\s+community\b/i, /\bparish\b/i, /\bclerical\s+petitions?\b/i] },
    { id: 'T43', name: 'French Botanical Gardens', patterns: [/\bfrench\s+botanical\b/i, /\bbotanical\s+gardens?\b/i, /\bjardin\s+des\s+plantes\b/i] },
    { id: 'T44', name: 'French Personal Correspondence', patterns: [/\bfrench\s+personal\s+correspondence\b/i, /\bfrench\s+private\s+letters?\b/i] }
  ];

  let queryForProps = query;
  for (const tk of topicKnowledge) {
    for (const pat of tk.patterns) {
      if (pat.test(query)) {
        facets.topicId = tk.id;
        intents.push({ statement: `Topic: ${tk.name}`, facet: 'topic', filter: { op: 'match', values: [tk.id] } });
        queryForProps = queryForProps.replace(pat, ' ').trim();
        break;
      }
    }
    if (facets.topicId) break;
  }

  // Dynamic Properties detection
  const propKeywords = {
    is_medieval_manuscript: [/\bmedieval\s+manuscripts?\b/i],
    is_political_letter: [/\bpolitical\s+letters?\b/i],
    is_letter: [/\bletters?\b/i, /\bcorrespondence\b/i, /\bbriefe?\b/i],
    contains_verse: [/\bverse\b/i, /\bpoetry\b/i, /\bpoems?\b/i, /\bgedichte?\b/i, /\bstanzas?\b/i],
    is_manuscript: [/\bmanuscripts?\b/i, /\bhandschriften?\b/i],
    contains_diary: [/\bdiar(?:y|ies)\b/i, /\btageb(?:uch|ücher)\b/i, /\bpersonal\s+journals?\b/i, /\bwritten\s+in\s+a\s+journal\b/i],
    contains_theatre: [/\btheatre\b/i, /\btheater\b/i, /\bdrama\b/i, /\bplays?\b/i],
    contains_law_texts: [/\blaw\b/i, /\blegal\b/i, /\brecht\b/i, /\bstatutes?\b/i, /\bordinances?\b/i],
    contains_newspaper_articles: [/\bnewspapers?\b/i, /\bzeitung(?:en)?\b/i, /\barticles?\b/i],
    contains_dictionary: [/\bdictionar(?:y|ies)\b/i, /\blexicons?\b/i, /\bwörterb(?:uch|ücher)\b/i],
    contains_inscriptions: [/\binscriptions?\b/i, /\binschriften?\b/i, /\bepigraph(?:y|ic)?\b/i],
    contains_direct_speech: [/\bspeech\b/i, /\bdirect\s+speech\b/i, /\bdialogue\b/i],
    contains_political_protocols: [/\bprotocols?\b/i, /\bprotokolle?\b/i],
    is_historic: [/\bhistoric(?:al)?\b/i]
  };

  for (const [propName, patterns] of Object.entries(propKeywords)) {
    if (patterns.some(pat => pat.test(queryForProps))) {
      facets.properties.push({ name: propName, value: true });
      facets[propName] = [{ op: 'include', values: ['true'] }];
      intents.push({ statement: `Feature: ${propName.replace(/^(contains_|is_)/, '').replace(/_/g, ' ')}`, facet: propName, filter: { op: 'include', values: ['true'] } });
    }
  }

  // 4. Dynamic Facet Elicitation from Raw TEI Tag Guidelines
  const specializedTeiTagFacets = [
    {
      name: 'salute',
      patterns: [/\bsalutations?\b/i, /\bgreetings?\b/i, /\bdear\s+sir\b/i, /\bmy\s+lord\b/i, /\bformal\s+salutations?\b/i],
      displayName: 'Formal Salutations',
      description: "Extracted from TEI element <salute>: Contains a formal salutation or greeting ('Dear Sir', 'My Lord')."
    },
    {
      name: 'stage',
      patterns: [/\bstage\s+directions?\b/i, /\bstage\b/i, /\btheatrical\s+directions?\b/i],
      displayName: 'Stage Directions',
      description: 'Extracted from TEI element <stage>: Contains any stage direction in a dramatic text.'
    },
    {
      name: 'sp',
      patterns: [/\bdramatic\s+dialogue\b/i, /\bspeech\s+turns?\b/i, /\bplay\s+dialogue\b/i, /\bcharacter\s+speeches?\b/i],
      displayName: 'Dramatic Speech Turns',
      description: 'Extracted from TEI element <sp>: Contains an individual speech or dialogue turn in a dramatic text.'
    },
    {
      name: 'foreign',
      patterns: [/\bforeign\s+(?:words?|phrases?|language|terms?)\b/i, /\blatin\s+phrases?\b/i, /\bforeign\b/i],
      displayName: 'Foreign Language Phrases',
      description: 'Extracted from TEI element <foreign>: Identifies a word or phrase belonging to a foreign language.'
    },
    {
      name: 'corr',
      patterns: [/\beditorial\s+corrections?\b/i, /\bcorrected\s+text\b/i, /\bcorrections?\b/i, /\bemendations?\b/i],
      displayName: 'Editorial Corrections',
      description: 'Extracted from TEI element <corr>: Contains the correct form of a passage as emended by the editor.'
    },
    {
      name: 'sic',
      patterns: [/\bsic\s+passages?\b/i, /\boriginal\s+errors?\b/i, /\berrors?\b/i],
      displayName: 'Original Errors (sic)',
      description: 'Extracted from TEI element <sic>: Contains text reproduced exactly as original despite an apparent error.'
    },
    {
      name: 'unclear',
      patterns: [/\bunclear\s+passages?\b/i, /\billegible\b/i, /\buncertain\s+readings?\b/i, /\bdamaged\s+text\b/i],
      displayName: 'Illegible / Damaged Text',
      description: 'Extracted from TEI element <unclear>: Contains a passage that cannot be transcribed with certainty.'
    },
    {
      name: 'signed',
      patterns: [/\bsignatures?\b/i, /\bsigned\s+letters?\b/i, /\bcontains?\s+signatures?\b/i, /\bsign-?offs?\b/i, /\bsignator(?:y|ies)\b/i],
      displayName: 'Signatures & Sign-offs',
      description: 'Extracted from TEI element <signed>: Contains the closing salutation, signature, or sign-off mark of a letter.'
    },
    {
      name: 'quote',
      patterns: [/\bexternal\s+quotes?\b/i, /\bquotations?\b/i, /\bcitations?\b/i],
      displayName: 'Direct Quotations',
      description: 'Extracted from TEI element <quote>: Explicit quotation from an external source or speaker.'
    },
    {
      name: 'gloss',
      patterns: [/\bglosses\b/i, /\bglossar(?:y|ies)\b/i, /\bterm\s+definitions?\b/i],
      displayName: 'Glosses & Definitions',
      description: 'Extracted from TEI element <gloss>: Contains a definition, explanation, or gloss for a term.'
    },
    {
      name: 'epigraph',
      patterns: [/\bepigraphs?\b/i, /\bmottos?\b/i],
      displayName: 'Epigraphs & Mottos',
      description: 'Extracted from TEI element <epigraph>: Contains a quotation, anonymous motto, or inscription heading.'
    }
  ];

  for (const tagFacet of specializedTeiTagFacets) {
    if (tagFacet.patterns.some(pat => pat.test(query))) {
      facets.tagValues = facets.tagValues || [];
      facets.tagValues.push({ tag: tagFacet.name });
      intents.push({
        statement: `✨ Newly Extracted Facet: ${tagFacet.displayName} (<${tagFacet.name}>)`,
        facet: `tag_${tagFacet.name}`,
        filter: { op: 'include', values: [tagFacet.name] },
        description: tagFacet.description
      });
    }
  }

  // Raw TEI Tag Matching (e.g. signed by X, person X, place Y)
  const signedMatch = query.match(/(?:signed\s+by|signature(?: of)?|signatory)\s+([A-Za-z\s]+?)(?=\s+(?:in|from|at|around|between|with|to|dated)\b|$)/i);
  if (signedMatch) {
    const signer = signedMatch[1].trim();
    if (signer.length > 1) {
      facets.tagValues = facets.tagValues || [];
      facets.tagValues.push({ tag: 'signed', value: signer });
      intents.push({ statement: `TEI Tag <signed>: "${signer}"`, facet: 'signed', filter: { op: 'match', values: [signer] } });
    }
  }

  // 5. Comprehensive Person & Author Entity Detection
  const knownFigures = [
    { pattern: /\b(?:vincent\s+)?van\s+gogh\b/i, name: 'Van Gogh' },
    { pattern: /\bthomas\s+gray\b/i, name: 'Thomas Gray' },
    { pattern: /\brobert\s+walser\b/i, name: 'Robert Walser' },
    { pattern: /\b(?:andreas\s+)?okopenko\b/i, name: 'Okopenko' },
    { pattern: /\bferdinand(?:s)?\b/i, name: 'Ferdinand' },
    { pattern: /\b(?:alexander\s+von\s+)?humboldt\b/i, name: 'Humboldt' },
    { pattern: /\b(?:david\s+)?livingstone\b/i, name: 'Livingstone' },
    { pattern: /\b(?:arthur\s+)?schnitzler\b/i, name: 'Schnitzler' },
    { pattern: /\bstaribacher\b/i, name: 'Staribacher' },
    { pattern: /\b(?:leo\s+von\s+)?thun\b/i, name: 'Leo von Thun' },
    { pattern: /\b(?:william\s+f?\s*)?cody\b/i, name: 'William F. Cody' },
    { pattern: /\b(?:gottlieb\s+)?planck\b/i, name: 'Planck' },
    { pattern: /\b(?:heinrich\s+)?bullinger\b/i, name: 'Bullinger' }
  ];

  let detectedPerson = null;

  for (const fig of knownFigures) {
    if (fig.pattern.test(query)) {
      detectedPerson = fig.name;
      break;
    }
  }

  // Preposition match (e.g. letters by X, to X, about X)
  if (!detectedPerson) {
    const personMatch = query.match(/(?:person|author|writer|by|to|for|about)\s+([A-Za-z\s]+?)(?=\s+(?:in|from|at|around|between|with|dated)\b|$)/i);
    if (personMatch) {
      const p = personMatch[1].trim();
      if (p && !['the', 'a', 'an', 'french', 'german', 'latin', 'english', 'verse', 'poetry', 'letters', 'dramatic', 'theatrical', 'legal', 'political'].includes(p.toLowerCase())) {
        detectedPerson = p;
      }
    }
  }

  // Noun-adjunct / possessive match (e.g. "Van Gogh letters", "Gray's poems")
  if (!detectedPerson) {
    const adjunctMatch = query.match(/^([A-Z][a-zA-Z\s]+?)(?:'s)?\s+(?:letters?|poems?|diaries|manuscripts?|works?|texts?|writings?|correspondence)\b/i);
    if (adjunctMatch) {
      const p = adjunctMatch[1].trim();
      if (p && !['the', 'a', 'an', 'french', 'german', 'latin', 'english', 'historic', 'medieval', 'all', 'dramatic', 'theatrical', 'legal', 'political', 'ancient'].includes(p.toLowerCase())) {
        detectedPerson = p;
      }
    }
  }

  if (detectedPerson) {
    facets.tagValues = facets.tagValues || [];
    facets.tagValues.push({ tag: 'persName', value: detectedPerson });
    intents.push({
      statement: `Person / Author: "${detectedPerson}" (<persName>)`,
      facet: 'persName',
      filter: { op: 'match', values: [detectedPerson] }
    });
  }

  return {
    scope: {
      decision: 'supported',
      reason: 'Structured metadata facets and TEI tags successfully identified.',
      message: 'Applied matching metadata filters and TEI tags to the dashboard.'
    },
    intents,
    facets,
    message: intents.length > 0 ? `Filtered by ${intents.map(i => i.statement).join(', ')}.` : 'Query parsed.'
  };
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET,OPTIONS,POST')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { query } = req.body || {};

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ message: 'Query is missing' });
  }

  const trimmedQuery = query.trim();

  // Try calling CaISI service if running
  try {
    const caisiController = new AbortController();
    const timeoutId = setTimeout(() => caisiController.abort(), 1200);

    const caisiCheck = await fetch(`${CAISI_URL}/docs`, { signal: caisiController.signal });
    clearTimeout(timeoutId);

    if (caisiCheck.ok) {
      // CaISI is reachable, use its workflow endpoint
      const caisiRes = await fetch(`${CAISI_URL}/workflow/verbalization-to-intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbalization: trimmedQuery })
      });
      if (caisiRes.ok) {
        const caisiData = await caisiRes.json();
        return res.status(200).json({ data: caisiData });
      }
    }
  } catch (e) {
    // CaISI service not active on port 8001, fall back to internal engine
  }

  // Standalone MCF Intent Engine using OpenAI
  try {
    const dynamicProperties = await getDynamicProperties();

    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('dummy')) {
      const fallbackResult = resolveHeuristicIntent(trimmedQuery, dynamicProperties);
      return res.status(200).json({ data: fallbackResult });
    }

    const systemPrompt = buildCaisiSystemPrompt(dynamicProperties);

    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: trimmedQuery }
      ],
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content;
    const result = JSON.parse(content);

    if (!result || !result.data) {
      const fallbackResult = resolveHeuristicIntent(trimmedQuery, dynamicProperties);
      return res.status(200).json({ data: fallbackResult });
    }

    // Normalization & Backward Compatibility for ORD Xplore
    const data = result.data;
    data.facets = data.facets || {};

    // Populate legacy binary facet format
    if (Array.isArray(data.facets.properties)) {
      for (const prop of data.facets.properties) {
        if (prop.name && prop.value !== undefined) {
          data.facets[prop.name] = [{ op: "include", values: [String(prop.value)] }];
        }
      }
    }

    res.status(200).json(result);
  } catch (error) {
    console.warn('OpenAI call failed, using heuristic intent resolver:', error.message);
    const dynamicProperties = await getDynamicProperties();
    const fallbackResult = resolveHeuristicIntent(trimmedQuery, dynamicProperties);
    res.status(200).json({ data: fallbackResult });
  }
}
