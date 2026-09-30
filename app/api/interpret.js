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

// CaISI (metadata-curation-framework) is optional. It is only called when
// CAISI_URL is set; server.js sets it to http://localhost:8001 for local runs.
// Read lazily because server.js assigns env vars after this module loads.
const getCaisiUrl = () => (process.env.CAISI_URL || '').replace(/\/$/, '') || null;
const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.6-flash';

/**
 * Topics the LLM may use: only from a v2 build (topics.lang exists), whose models passed the
 * evaluation in data/build/ordx/topics.py. Older databases: none (near-uniform model, FIX_PLAN T1).
 */
async function getTopics() {
  try {
    const { rows } = await getPool().query(
      `SELECT id, words, lang FROM topics
        WHERE EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'topics' AND column_name = 'lang')
        ORDER BY lang, id`);
    return rows;
  } catch (err) {
    return [];   // older database: the column check fails inside the query planner, or no table
  }
}

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
    const { rows } = await getPool().query(`
      SELECT 
        tg.name, 
        COALESCE(td.category, 'Other TEI Elements') as category,
        COALESCE(td.description, 'TEI XML element <' || tg.name || '>') as description,
        td.example_queries
      FROM tags tg
      LEFT JOIN tei_tag_definitions td ON tg.name = td.name
      ORDER BY 
        CASE WHEN td.category IS NOT NULL THEN 0 ELSE 1 END,
        td.category,
        tg.name;
    `);
    if (rows && rows.length > 0) return rows;
  } catch (err) {
    console.error('Error fetching TEI tag definitions:', err);
  }
  return [];
}

/**
 * Build MCF/CaISI workflow prompt using active dynamic property schema and TEI guidelines.
 */
function buildCaisiSystemPrompt(properties, teiTags = [], topics = []) {
  const binaryProps = properties.filter(p => p.type === 'binary').map(p => p.name);
  const choiceProps = properties.filter(p => p.type === 'multiple_choice').map(p => {
    const opts = Array.isArray(p.options) && p.options.length > 0 ? ` (options: ${p.options.slice(0, 8).join(', ')})` : '';
    return `${p.name}${opts}`;
  });

  // Group all TEI tags by category
  const categories = {};
  for (const t of teiTags) {
    const cat = t.category || 'General';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(`<${t.name}>: ${t.description} (examples: ${t.example_queries || t.name})`);
  }

  const teiGuidelineList = Object.entries(categories).map(([cat, list]) => {
    return `   [${cat}]:\n     - ` + list.join('\n     - ');
  }).join('\n\n');

  const topicsList = topics.map(t => `\n   - ${t.id}: ${(t.words || []).slice(0, 6).join(', ')} [${t.lang}]`).join('');

  return `You are the CaISI (Metadata Curation Framework) Intent Elicitation and Query Resolution Engine for ORD Xplore.

Your task is to analyze user queries over historical digital editions and metadata using high-level facets, topic clusters, and raw TEI XML elements.
Perform three distinct steps:

1. QUERY SCOPE CLASSIFICATION:
   - "supported": The query expresses an exploratory search, filtering, comparison, or structuring need over the collection (e.g. "French letters around 1750", "find documents with verse", "editions from Germany", "manuscripts with seal", "texts with glosses").
   - "unclear": The query is ambiguous, a single bare word with no filtering criteria, or needs refinement.
   - "unsupported": The query is a general knowledge question or factoid QA not answerable by filtering metadata facets (e.g. "What is the capital of Switzerland?", "Who was Napoleon?").

2. ATOMIC INTENT DECOMPOSITION:
   - Break complex verbalizations into discrete atomic intent statements (e.g. "French letters from 1750 with verse and seals" -> ["Language is French", "Time is 1750", "Document is letter", "Contains verse", "Contains seal"]).

3. FACET, PROPERTY, TOPIC & RAW TEI TAG MAPPING:
   - Standard facets:
     * "time": year(s) or year ranges (e.g. [1750, 1800] or [1750]). For historical eras: "Second World War" -> [1939, 1945], "First World War" -> [1914, 1918], "18th century" -> [1700, 1799], "19th century" -> [1800, 1899], "Renaissance" -> [1400, 1650], "Middle Ages" -> [500, 1500]. Add a "source" for the date layer:
         - "creation": when the document was written or made ("letters from 1850", "written in 1850") -- the default
         - "publication": when it was historically printed or published ("published in 1850", "printed before 1600")
         - "contextual": years the text is about or mentions ("documents about 1848", "mentioning 1789")
     * "geography": city name or country (e.g. "Zurich", "Switzerland", "France", "Germany", "London", "Paris", "Berlin", "Vienna"), plus a "source" saying which place layer is meant:
         - "creation": where the document was written or sent from ("letters from France", "written in Paris", "sent from Vienna")
         - "publication": where it was printed or published ("published in London", "printed in Leipzig")
         - "contextual": places the text is about or mentions ("letters about France", "mentioning Zurich", "documents on Egypt")
         If the query does not make it clear, use "contextual".
     * "language": ISO code or language name ("fr", "en", "de", "la", "it", "es")
${topics.length ? `     * "topicId": one of these topic IDs (each topic model covers one language; the words are the topic's top words) if the query clearly asks for that subject: ${topicsList}` : '     * (topics are disabled: never output a topicId)'}
   - Dynamic binary properties: ${binaryProps.join(', ')}
   - Categorical / choice properties: ${choiceProps.join(', ')}
   - Complete TEI XML Guidelines Elements (TEI P5):
${teiGuidelineList}

SELECTION & TEI TAG EXTRACTION RULES:
- Do NOT guess unstated facets.
- Adjectives like "French", "German", "Latin", "English" map to language unless an explicit place/country is stated.
- Binary properties take value "true" or "false" (e.g. is_letter: true, contains_verse: true, contains_diary: true, is_manuscript: true, contains_direct_speech: true, contains_theatre: true, contains_law_texts: true, contains_newspaper_articles: true, contains_inscriptions: true, contains_dictionary: true).
- EXACT TEI P5 CANONICAL TAG CASING & ENTITY VALUES (tagValues):
  * When a person or author is named: tagValues: [{ tag: "persName", value: "Vincent van Gogh" }]
    -> Intent statement: 'Person / Author: "Vincent van Gogh" (<persName>)'
    -> Intent facet: 'persName'
    (Never use "author" as a tag name; authors are indexed under <persName>)
  * When a specific organization or society is mentioned: tagValues: [{ tag: "orgName", value: "Royal Society" }]
    -> Intent statement: 'Organization: "Royal Society" (<orgName>)'
    -> Intent facet: 'orgName'
  * When a specific term or concept is mentioned: tagValues: [{ tag: "term", value: "botany" }]
  * When a document structure/palaeographical feature/linguistic markup is requested:
    - signatures/signed: tagValues: [{ tag: "signed", value: "true" }] or specific signer name
      -> Intent statement: 'Signatures & Sign-offs (<signed>)'
      -> Intent facet: 'signed'
    - salutations/greetings: tagValues: [{ tag: "salute", value: "true" }] -> Intent statement: 'Salutation (<salute>)'
    - manuscript descriptions / codicology: tagValues: [{ tag: "msDesc", value: "true" }] -> Intent statement: 'Manuscript Description (<msDesc>)'
    - seals or lead bullae: tagValues: [{ tag: "seal", value: "true" }] -> Intent statement: 'Wax Seal (<seal>)'
    - stamps or postmarks: tagValues: [{ tag: "stamp", value: "true" }] -> Intent statement: 'Postage / Stamp (<stamp>)'
    - glosses or definitions: tagValues: [{ tag: "gloss", value: "true" }] -> Intent statement: 'Gloss / Definition (<gloss>)'
    - foreign language phrases: tagValues: [{ tag: "foreign", value: "true" }] -> Intent statement: 'Foreign Words (<foreign>)'
    - rubric / red ink headings: tagValues: [{ tag: "rubric", value: "true" }] -> Intent statement: 'Rubric (<rubric>)'
    - abbreviations: tagValues: [{ tag: "abbr", value: "true" }] -> Intent statement: 'Abbreviations (<abbr>)'
    - critical apparatus variants: tagValues: [{ tag: "app", value: "true" }] -> Intent statement: 'Critical Apparatus (<app>)'
    - licence / rights statements: tagValues: [{ tag: "licence", value: "true" }]
    - verse lines or stanzas: tagValues: [{ tag: "lg", value: "true" }]
    - speeches / dramatic roles: tagValues: [{ tag: "sp", value: "true" }]

OUTPUT FORMAT (JSON only, no markdown):
{
  "data": {
    "scope": {
      "decision": "supported" | "unclear" | "unsupported",
      "reason": "Clear explanation of the scope classification",
      "message": "User-facing message explaining how the query was interpreted"
    },
    "intents": [
      {
        "statement": "Atomic intent statement with TEI tag e.g. 'Person / Author: \"Darwin\" (<persName>)'",
        "facet": "persName",
        "filter": { "op": "match", "values": ["Darwin"] }
      }
    ],
    "facets": {
      "time": [{ "op": "include" | "range", "values": ["1750", "1800"], "source": "creation" | "publication" | "contextual" }],
      "geography": [{ "op": "include", "values": ["Zurich"], "source": "creation" | "publication" | "contextual" }],
      "language": [{ "op": "include", "values": ["fr"] }],
      "topicId": "T29",
      "properties": [
        { "name": "is_letter", "value": true }
      ],
      "tagValues": [
        { "tag": "persName", "value": "Darwin" },
        { "tag": "signed", "value": "true" }
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

  // Historical Eras, Wars & Time detection
  const eraKnowledge = [
    { pattern: /\b(?:second\s+world\s+war|world\s+war\s+(?:ii|2)|ww(?:ii|2)|zweiter\s+weltkrieg)\b/i, label: 'Second World War (1939-1945)', range: [1939, 1945] },
    { pattern: /\b(?:first\s+world\s+war|world\s+war\s+(?:i|1)|ww(?:i|1)|erster\s+weltkrieg)\b/i, label: 'First World War (1914-1918)', range: [1914, 1918] },
    { pattern: /\b(?:cold\s+war|kalter\s+krieg)\b/i, label: 'Cold War (1947-1991)', range: [1947, 1991] },
    { pattern: /\b(?:thirty\s+years\s+war|dreissigjähriger\s+krieg|dreißigjähriger\s+krieg)\b/i, label: 'Thirty Years War (1618-1648)', range: [1618, 1648] },
    { pattern: /\b(?:french\s+revolution|französische\s+revolution)\b/i, label: 'French Revolution (1789-1799)', range: [1789, 1799] },
    { pattern: /\b(?:american\s+civil\s+war)\b/i, label: 'American Civil War (1861-1865)', range: [1861, 1865] },
    { pattern: /\b(?:enlightenment|aufklärung)\b/i, label: 'Enlightenment (1715-1789)', range: [1715, 1789] },
    { pattern: /\b(?:renaissance|early\s+modern|frühe\s+neuzeit)\b/i, label: 'Renaissance & Early Modern (1400-1650)', range: [1400, 1650] },
    { pattern: /\b(?:middle\s+ages|medieval|mittelalter)\b/i, label: 'Middle Ages (500-1500)', range: [500, 1500] },
    { pattern: /\b20th\s+century\b/i, label: '20th Century (1900-1999)', range: [1900, 1999] },
    { pattern: /\b19th\s+century\b/i, label: '19th Century (1800-1899)', range: [1800, 1899] },
    { pattern: /\b18th\s+century\b/i, label: '18th Century (1700-1799)', range: [1700, 1799] },
    { pattern: /\b17th\s+century\b/i, label: '17th Century (1600-1699)', range: [1600, 1699] },
    { pattern: /\b16th\s+century\b/i, label: '16th Century (1500-1599)', range: [1500, 1599] },
    { pattern: /\b15th\s+century\b/i, label: '15th Century (1400-1499)', range: [1400, 1499] }
  ];

  let detectedEra = false;
  for (const era of eraKnowledge) {
    if (era.pattern.test(q)) {
      facets.time = [{ op: 'range', values: era.range }];
      intents.push({ statement: `Time: ${era.label}`, facet: 'time', filter: facets.time[0] });
      detectedEra = true;
      break;
    }
  }

  if (!detectedEra) {
    const rangeMatch = q.match(/\b(1\d{3}|20\d{2})\s*(?:to|-|until)\s*(1\d{3}|20\d{2})\b/);
    if (rangeMatch) {
      const y1 = parseInt(rangeMatch[1]);
      const y2 = parseInt(rangeMatch[2]);
      facets.time = [{ op: 'range', values: [Math.min(y1, y2), Math.max(y1, y2)] }];
      intents.push({ statement: `Time: ${Math.min(y1, y2)}–${Math.max(y1, y2)}`, facet: 'time', filter: facets.time[0] });
    } else {
      const singleYear = q.match(/\b(1\d{3}|20\d{2})\b/);
      if (singleYear) {
        const yr = parseInt(singleYear[1]);
        facets.time = [{ op: 'include', values: [yr] }];
        intents.push({ statement: `Time: ${yr}`, facet: 'time', filter: facets.time[0] });
      }
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
    // Which place layer: "from/written in/sent from X" -> creation,
    // "published/printed in X" -> publication, otherwise places mentioned.
    const geoSource = /\b(?:published|printed)\s+(?:in|at)\b/i.test(query) ? 'publication'
      : /\b(?:from|written\s+in|sent\s+from|composed\s+in)\b/i.test(query) ? 'creation'
      : 'contextual';
    facets.geography = [{ op: 'include', values: [detectedGeo], source: geoSource }];
    facets.country = detectedGeo;
    intents.push({ statement: `Geography: ${detectedGeo}`, facet: 'geography', filter: facets.geography[0] });
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
    { id: 'T29', name: 'Botany & Flora', patterns: [/\bbotan(?:y|ical|ics)?\b/i, /\bflora\b/i, /\bplant\s+specimens?\b/i] },
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

  const nonPersonWords = new Set([
    'the', 'a', 'an', 'french', 'german', 'latin', 'english', 'italian', 'spanish',
    'historic', 'historical', 'medieval', 'ancient', 'early', 'late', 'modern',
    'all', 'some', 'many', 'few', 'other', 'new', 'old', 'short', 'long',
    'dramatic', 'theatrical', 'legal', 'political', 'botany', 'botanics', 'botanical',
    'science', 'scientific', 'history', 'verse', 'poetry', 'letters', 'letter',
    'signed', 'unsigned', 'sealed', 'unsealed', 'stamped', 'annotated',
    'formal', 'official', 'private', 'personal', 'illustrated', 'printed', 'written', 'archival', 'administrative'
  ]);

  // Preposition match (e.g. letters by X, author X, written by X)
  if (!detectedPerson) {
    const personMatch = query.match(/(?:person|author|writer|written\s+by|authored\s+by|by)\s+([A-Z][a-zA-Z\s]+?)(?=\s+(?:in|from|at|around|between|with|dated|about)\b|$)/);
    if (personMatch) {
      const p = personMatch[1].trim();
      if (p && !nonPersonWords.has(p.toLowerCase())) {
        detectedPerson = p;
      }
    }
  }

  // Noun-adjunct / possessive match (e.g. "Van Gogh letters", "Gray's poems")
  if (!detectedPerson) {
    const adjunctMatch = query.match(/^([A-Z][a-zA-Z\s]+?)(?:'s)?\s+(?:letters?|poems?|diaries|manuscripts?|works?|texts?|writings?|correspondence)\b/);
    if (adjunctMatch) {
      const p = adjunctMatch[1].trim();
      if (p && !nonPersonWords.has(p.toLowerCase())) {
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
      decision: intents.length > 0 ? 'supported' : 'unclear',
      reason: intents.length > 0
        ? 'Structured metadata facets, eras, and TEI tags successfully identified.'
        : `No specific time period, person, location, or characteristics matched "${query}".`,
      message: intents.length > 0
        ? 'Applied matching metadata filters and TEI tags to the dashboard.'
        : 'Tip: Try searching for historical eras (e.g. "Second World War", "18th century"), persons, places, languages, or features.'
    },
    intents,
    facets,
    message: intents.length > 0 ? `Filtered by ${intents.map(i => i.statement).join(', ')}.` : `No structured filters found for "${query}".`
  };
}

const GEO_SOURCES = ['creation', 'publication', 'contextual'];

/**
 * Make sure every geography facet says which place layer it targets and that
 * the matching intent pill carries the same value, so the dashboard can switch
 * its map layer to what the query meant ("from France" -> creation).
 */
function normalizeGeoSource(data) {
  // Time: which date layer is meant. "Letters from 1850" means written in 1850, so the
  // default is the creation date, not a year mentioned in the text.
  const time = data?.facets?.time?.[0];
  if (time) {
    if (!GEO_SOURCES.includes(time.source)) time.source = 'creation';
    for (const it of data.intents || []) {
      if (it && it.facet === 'time') it.filter = { ...(it.filter || {}), values: it.filter?.values || time.values, source: time.source };
    }
  }
  const geo = data?.facets?.geography?.[0];
  if (!geo) return data;
  if (!GEO_SOURCES.includes(geo.source)) geo.source = 'contextual';
  for (const it of data.intents || []) {
    if (it && it.facet === 'geography') {
      it.filter = { ...(it.filter || {}), values: it.filter?.values || geo.values, source: geo.source };
    }
  }
  return data;
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
  // Engines tried before the one that answered, with the reason they did not (shown in the UI).
  const attempts = [];
  const respond = (data, status = 200) => {
    if (data && typeof data === 'object') { data.attempts = attempts; normalizeGeoSource(data); }
    return res.status(status).json({ data });
  };

  // 1. CaISI service, only if configured. Any failure falls through to Gemini.
  const CAISI_URL = getCaisiUrl();
  if (CAISI_URL) {
    try {
      const caisiRes = await fetch(`${CAISI_URL}/workflow/verbalization-to-intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verbalization: trimmedQuery }),
        signal: AbortSignal.timeout(8000),
      });
      if (caisiRes.ok) {
        const caisiData = await caisiRes.json();
        if (caisiData && typeof caisiData === 'object') { caisiData.engine = 'caisi'; normalizeGeoSource(caisiData); }
        return respond(caisiData);
      }
      console.warn(`CaISI returned HTTP ${caisiRes.status}, falling back`);
      attempts.push({ engine: 'caisi', ok: false, reason: `HTTP ${caisiRes.status}` });
    } catch (e) {
      console.warn('CaISI unreachable, falling back:', e.message);
      attempts.push({ engine: 'caisi', ok: false, reason: e.name === 'TimeoutError' ? 'timed out' : 'unreachable' });
    }
  }

  // Check if forced heuristic mode is requested
  const engineMode = (process.env.ENGINE_MODE || req.body.mode || 'llm').toLowerCase();
  if (engineMode === 'heuristic') {
    const dynamicProperties = await getDynamicProperties();
    const result = resolveHeuristicIntent(trimmedQuery, dynamicProperties);
    result.engine = 'heuristic';
    return respond(result);
  }

  // Google Gemini LLM Intent Engine
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (GEMINI_API_KEY) {
    try {
      const dynamicProperties = await getDynamicProperties();
      const teiTags = await getTeiTagDefinitions();
      const systemPrompt = buildCaisiSystemPrompt(dynamicProperties, teiTags, await getTopics());

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL()}:generateContent?key=${GEMINI_API_KEY}`;
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser Query: "${trimmedQuery}"` }] }
          ],
          generationConfig: { responseMimeType: 'application/json' }
        })
      });

      if (geminiRes.ok) {
        const geminiJson = await geminiRes.json();
        const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          const data = parsed.data || parsed;
          if (data && (data.scope || data.facets || data.intents)) {
            data.facets = data.facets || {};
            // Populate legacy binary facet format for dashboard UI compatibility
            if (Array.isArray(data.facets.properties)) {
              for (const prop of data.facets.properties) {
                if (prop.name && prop.value !== undefined) {
                  data.facets[prop.name] = [{ op: "include", values: [String(prop.value)] }];
                }
              }
            }

            const CANONICAL_TAG_MAP = {
              'persname': 'persName',
              'author': 'persName',
              'placename': 'placeName',
              'orgname': 'orgName',
              'rolename': 'roleName',
              'msdesc': 'msDesc',
              'handdesc': 'handDesc',
              'handshift': 'handShift',
              'physdesc': 'physDesc',
              'correspaction': 'correspAction',
              'correspdesc': 'correspDesc',
              'origdate': 'origDate',
              'pubplace': 'pubPlace'
            };

            // Normalize tagValues
            if (Array.isArray(data.facets.tagValues)) {
              const uniqueTagValues = new Map();
              data.facets.tagValues.forEach(tv => {
                if (!tv || !tv.tag) return;
                const tagLower = tv.tag.toLowerCase();
                const canonicalTag = CANONICAL_TAG_MAP[tagLower] || tv.tag;
                const isGeneric = !tv.value || tv.value === 'true' || tv.value === true;
                const normVal = isGeneric ? 'true' : String(tv.value).trim();
                const key = `${canonicalTag}:${normVal.toLowerCase()}`;
                if (!uniqueTagValues.has(key)) {
                  uniqueTagValues.set(key, { tag: canonicalTag, value: normVal });
                }
              });
              data.facets.tagValues = Array.from(uniqueTagValues.values());
            }

            // Normalize intents
            if (Array.isArray(data.intents)) {
              data.intents.forEach(it => {
                if (!it) return;
                const facetLower = String(it.facet || '').toLowerCase();
                if (CANONICAL_TAG_MAP[facetLower]) {
                  it.facet = CANONICAL_TAG_MAP[facetLower];
                }
                if (it.facet === 'persName' && it.statement && !it.statement.includes('<persName>')) {
                  const val = (it.filter?.values && it.filter.values[0]) || (it.statement.match(/"([^"]+)"/)?.[1]) || (it.statement.match(/(?:is|named|author)\s+([A-Za-z\s]+)/i)?.[1]) || '';
                  it.statement = `Person / Author: "${val.trim()}" (<persName>)`;
                } else if (it.facet === 'signed' && it.statement && !it.statement.includes('<signed>')) {
                  it.statement = `Signatures & Sign-offs (<signed>)`;
                }
              });
            }

            data.engine = 'gemini';
            normalizeGeoSource(data);
            return respond(data);
          }
        }
      } else {
        console.warn(`Gemini returned HTTP ${geminiRes.status}, falling back`);
        attempts.push({ engine: 'gemini', ok: false, reason: `HTTP ${geminiRes.status}` });
      }
    } catch (gErr) {
      console.warn('Gemini LLM call failed, falling back:', gErr.message);
      attempts.push({ engine: 'gemini', ok: false, reason: 'request failed' });
    }
  }

  // Standalone MCF Intent Engine using OpenAI
  try {
    const dynamicProperties = await getDynamicProperties();

    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('dummy')) {
      const fallbackResult = resolveHeuristicIntent(trimmedQuery, dynamicProperties);
      fallbackResult.engine = 'heuristic';
      return respond(fallbackResult);
    }

    const systemPrompt = buildCaisiSystemPrompt(dynamicProperties, [], await getTopics());

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
      fallbackResult.engine = 'heuristic';
      return respond(fallbackResult);
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

    data.engine = 'openai';
    normalizeGeoSource(data);
    data.attempts = attempts;
    res.status(200).json(result);
  } catch (error) {
    console.warn('LLM call failed, using heuristic intent resolver:', error.message);
    const dynamicProperties = await getDynamicProperties();
    const fallbackResult = resolveHeuristicIntent(trimmedQuery, dynamicProperties);
    fallbackResult.engine = 'heuristic';
    attempts.push({ engine: 'openai', ok: false, reason: 'request failed' });
    respond(fallbackResult);
  }
}
