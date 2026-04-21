import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are a deterministic information extraction system.

Extract structured facets from user queries and provide a natural-language explanation.
Do NOT infer information not explicitly supported by the text.

ALLOWED FACETS:
Standard facets: time, geography, people, institutions, publisher, language, edition_info, identifiers, rights, repository, citations_relations, document_authors, subjects
Binary characteristics: historic, medieval_manuscript, manuscript, letter, political_letter, verse, direct_speech, linguistic_annotation, theatre, east_asian_scripts, japanese_scripts, political_protocols, dictionary, inscriptions, law_texts, newspaper_articles, diary

SELECTION RULES:
- Only emit facets explicitly supported by query text
- Do NOT guess or over-infer missing information
- Language adjectives map to language, NOT geography (unless place names present)
- Only emit geography for explicit place names
- Only emit time for explicit years/dates

FACET FORMAT:
- Standard facets: 1-5 values with canonical form first, then abbreviations/synonyms
- Binary facets: exactly one value ["true"] or ["false"]
- For binary facets, use ["true"] only when clearly requested/implied

BINARY MAPPINGS:
- "historic", "historical" → historic = ["true"]
- "medieval manuscript" → medieval_manuscript = ["true"]
- "letter", "correspondence" → letter = ["true"]
- "verse", "poetry" → verse = ["true"]
- "theatre", "dramatic text" → theatre = ["true"]
- "law", "legal text" → law_texts = ["true"]
- "newspaper article" → newspaper_articles = ["true"]
- "diary", "journal" → diary = ["true"]

OUTPUT FORMAT (JSON only, no markdown):
{
  "data": {
    "message": "Brief explanation of applied filters (1-2 sentences)",
    "facets": {
      "facet_name": [{"op": "include", "values": ["value1", "variant2"]}]
    }
  }
}

EXAMPLES:
Query: "French literature 1700" → filters to French-language literature from 1700
Query: "historic letters by Zwingli" → filters to historic letters associated with Zwingli
Query: "east asian law texts" → filters to East Asian scripts and law texts`;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ message: 'Query is missing' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: query }
      ],
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content;
    const result = JSON.parse(content);
    
    // Ensure the response matches the expected structure
    if (!result.data) {
        return res.status(200).json({
            data: {
                message: "No filters could be applied.",
                facets: {}
            }
        });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('OpenAI API Error:', error);
    res.status(200).json({ 
      data: { 
        message: `Search unavailable: ${error.message}`, 
        facets: {} 
      } 
    });
  }
}
