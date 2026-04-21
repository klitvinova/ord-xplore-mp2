import json
from typing import Any, Dict
from openai import OpenAI


class OpenAILLM:
    """
    OpenAI Language Model client for converting user queries into structured facets.
    
    Handles both standard facets (time, geography, language, etc.) and binary 
    characteristics (historic, manuscript, letter, etc.) using GPT models.
    """
    
    def __init__(self, api_key: str, model: str = "gpt-4.1-mini") -> None:
        """
        Initialize the OpenAI LLM client.
        
        Args:
            api_key: OpenAI API key
            model: Model name to use (default: gpt-4o-mini)
        """
        self.client = OpenAI(api_key=api_key)
        self.model = model
        self._system_prompt = self._build_system_prompt()

    def _build_system_prompt(self) -> str:
        """
        Build the comprehensive system prompt for facet extraction.
        
        Returns:
            Complete system prompt string
        """
        # Define allowed facets
        standard_facets = [
            "time", "geography", "people", "institutions", "publisher", 
            "language", "edition_info", "identifiers", "rights", 
            "repository", "citations_relations", "document_authors", "subjects"
        ]
        
        binary_facets = [
            "historic", "medieval_manuscript", "manuscript", "letter", 
            "political_letter", "verse", "direct_speech", "linguistic_annotation",
            "theatre", "east_asian_scripts", "japanese_scripts", "political_protocols",
            "dictionary", "inscriptions", "law_texts", "newspaper_articles", "diary"
        ]
        
        # Build facet mapping examples
        binary_mappings = [
            '"historic", "historical" → historic = ["true"]',
            '"medieval manuscript" → medieval_manuscript = ["true"]',
            '"letter", "correspondence" → letter = ["true"]',
            '"verse", "poetry" → verse = ["true"]',
            '"theatre", "dramatic text" → theatre = ["true"]',
            '"law", "legal text" → law_texts = ["true"]',
            '"newspaper article" → newspaper_articles = ["true"]',
            '"diary", "journal" → diary = ["true"]'
        ]
        
        return f"""You are a deterministic information extraction system.

Extract structured facets from user queries and provide a natural-language explanation.
Do NOT infer information not explicitly supported by the text.

ALLOWED FACETS:
Standard facets: {', '.join(standard_facets)}
Binary characteristics: {', '.join(binary_facets)}

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
{chr(10).join(f"- {mapping}" for mapping in binary_mappings)}

OUTPUT FORMAT (JSON only, no markdown):
{{
  "data": {{
    "message": "Brief explanation of applied filters (1-2 sentences)",
    "facets": {{
      "facet_name": [{{"op": "include", "values": ["value1", "variant2"]}}]
    }}
  }}
}}

EXAMPLES:
Query: "French literature 1700" → filters to French-language literature from 1700
Query: "historic letters by Zwingli" → filters to historic letters associated with Zwingli
Query: "east asian law texts" → filters to East Asian scripts and law texts"""

    def query_to_facets(self, user_query: str) -> Dict[str, Any]:
        """
        Convert a user query into structured facets using OpenAI.
        
        Args:
            user_query: Natural language search query
            
        Returns:
            Dictionary containing facets and message in the expected format
        """
        try:
            response = self.client.responses.create(
                model=self.model,
                input=f'{self._system_prompt}\n\nUser query: """{user_query}"""'
            )
            
            content = (response.output_text or "").strip()
            return json.loads(content)
            
        except json.JSONDecodeError as e:
            # Log the parsing error for debugging
            print(f"JSON parsing error: {e}")
            print(f"Raw response: {content if 'content' in locals() else 'N/A'}")
            return self._fallback_response()
            
        except Exception as e:
            # Log other API errors
            print(f"OpenAI API error: {e}")
            return self._fallback_response()

    def _fallback_response(self) -> Dict[str, Any]:
        """
        Provide fallback response when API call fails.
        
        Returns:
            Default empty facet response
        """
        return {
            "data": {
                "message": "No filters could be applied to your query.",
                "facets": {}
            }
        }
