import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import { OpenAI } from 'openai';

let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'dummy-key-for-initialization',
    });
  }
  return openai;
}

const TEI_NS = 'http://www.tei-c.org/ns/1.0';
const select = xpath.useNamespaces({ tei: TEI_NS });

export default async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { filename, content } = req.body || {};

  if (!content) {
    return res.status(400).json({ error: 'Missing required field: content' });
  }

  // --- XML PARSING ---
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
    return res.status(400).json({ error: `XML Well-Formedness Error: ${parseErrors.join('; ')}` });
  }

  // --- RULES-BASED STRUCTURAL ANALYSIS ---
  let suitable = true;
  let detectedType = 'Standard Digital Edition (Text)';
  let reason = 'The document fits the metadata dashboard schema expectations (contains general text, standard header metadata).';
  let extractableData = [];
  let suggestions = [];

  // 1. Check for Prosopographical Data (Persons list)
  const persons = select('//tei:listPerson/tei:person | //tei:person', doc);
  if (persons.length > 0) {
    suitable = false;
    detectedType = 'Prosopographical Record (List of Persons)';
    reason = 'This document contains a structured list of persons/biographical data rather than a continuous digitized historical text edition (like letters, journals, or chronicles).';
    
    // Attempt to extract names
    const names = [];
    persons.slice(0, 3).forEach(p => {
      const forename = select('string(.//tei:forename/text())', p).trim();
      const surname = select('string(.//tei:surname/text())', p).trim();
      if (forename || surname) {
        names.push(`${forename} ${surname}`.trim());
      } else {
        const name = select('string(.//tei:persName/text())', p).trim();
        if (name) names.push(name);
      }
    });

    extractableData.push(`Detected ${persons.length} person entity/entities${names.length > 0 ? ` (including: ${names.join(', ')})` : ''}.`);
    
    // Career stations / occupations
    const occupations = select('//tei:occupation', doc);
    const educations = select('//tei:education', doc);
    const residences = select('//tei:residence', doc);
    if (occupations.length > 0 || educations.length > 0 || residences.length > 0) {
      extractableData.push(`Detected career/residence stations: ${occupations.length} occupations, ${educations.length} educations, ${residences.length} residences.`);
    }

    suggestions.push('Use the "Force Ingest Anyway" button below to bypass this warning and parse the record as a standard document.');
    suggestions.push('Wrap biographical entries inside standard `<text><body><p>` tags if you want the narrative content to be fully indexed.');
    suggestions.push('Ensure key timeline dates and places are tagged with standard `<date>` and `<placeName>` tags to map them to the dashboard.');
  }

  // 2. Check for Bibliographical Catalog Data
  const bibls = select('//tei:listBibl/tei:bibl | //tei:bibl | //tei:biblStruct', doc);
  if (suitable && bibls.length > 0) {
    suitable = false;
    detectedType = 'Bibliographical Catalog / Reference List';
    reason = 'This document represents a bibliography or list of citations/references rather than historical narrative text.';
    extractableData.push(`Detected ${bibls.length} bibliography entries.`);
    suggestions.push('Use the "Force Ingest Anyway" button below to catalog this bibliography as a single document.');
    suggestions.push('Ensure citation metadata (authors, titles, dates) are wrapped in standard TEI `<bibl>` tags.');
  }

  // 3. Check for Lexicographical / Dictionary data
  const entries = select('//tei:entry | //tei:dictScrap | //tei:form', doc);
  if (suitable && entries.length > 0) {
    suitable = false;
    detectedType = 'Lexicographical Record (Dictionary/Glossary)';
    reason = 'This document contains dictionary entries, definition lists, or glossaries.';
    extractableData.push(`Detected ${entries.length} dictionary entries.`);
    suggestions.push('Use the "Force Ingest Anyway" button below to ingest the glossary/dictionary as a standard text document.');
    suggestions.push('Tag vocabulary terms using `<term>` and definitions using `<gloss>` inside a standard body layout.');
  }

  // 4. General check for metadata presence
  if (suitable) {
    const dates = select('//tei:date', doc);
    const places = select('//tei:placeName', doc);
    if (dates.length === 0 && places.length === 0) {
      extractableData.push('No dates or placenames detected in the text.');
      suggestions.push('Add <date> tags with `when`, `from`, or `to` attributes to make dates queryable.');
      suggestions.push('Add <placeName> tags to enable geolocation mapping.');
    }
  }

  // --- GPT-BACKED ANALYSIS UPGRADE ---
  if (process.env.OPENAI_API_KEY) {
    try {
      const client = getOpenAI();
      const prompt = `Analyze this TEI XML document. Determine if it is suitable for our metadata dashboard.
Our database expects traditional digitized historical edition texts (like correspondence, protocols, or journals) containing:
- Creation/publication dates and locations
- Narrative body texts
- Topics and boolean attributes

Document content (truncated if too long):
${content.substring(0, 4000)}

Analyze the structure and return JSON strictly matching this schema:
{
  "suitable": true/false,
  "detectedType": "Type name",
  "reason": "Clear explanation of why it is suitable or structurally different",
  "extractableData": ["Information that could be captured (e.g. entities, career paths, bibliography details)"],
  "suggestions": ["Alternative formatting or schema suggestions to support this structure"]
}`;

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an expert XML and TEI Schema engineer. Return ONLY raw JSON matching the requested structure.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content);
      if (result && typeof result.suitable === 'boolean') {
        return res.status(200).json({ ...result, aiGenerated: true });
      }
    } catch (e) {
      console.error('GPT pre-analysis failed, falling back to rules-based analyzer:', e);
    }
  }

  // Return rules-based analysis output
  return res.status(200).json({
    suitable,
    detectedType,
    reason,
    extractableData,
    suggestions,
    aiGenerated: false
  });
}
