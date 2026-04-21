"""
⚠️  WORK IN PROGRESS - NOT CURRENTLY USED ⚠️

Facet-based document search using LLM-generated search criteria.
Uses Levenshtein distance for fuzzy matching and returns ranked document results.

Status: This module is not integrated into the current application workflow.
The frontend dashboard only uses the /interpret endpoint for facet extraction.
This represents an idealistic implementation for future development.
"""

import json
import os
import re
import requests
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import Levenshtein


class FacetSearcher:
    """
    Searches documents using faceted lookup with fuzzy matching.
    """
    
    def __init__(self, facet_lookup_path: str = None):
        """Initialize with facet lookup data."""
        current_file = Path(__file__).parents[2]  # misc_fall26/
        self.facet_lookup_path = current_file / "temp" / "facet_lookup.json"
        self.facet_data = self._load_facet_data()
        # Elasticsearch configuration (aligns with text_processing/ingest_keywords_elasticsearch.py)
        self.es_base_url = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
        self.es_index = os.getenv("ELASTICSEARCH_INDEX", "digital_editions")
        
    def _load_facet_data(self) -> Dict[str, Dict[str, List]]:
        """Load facet lookup JSON."""
        try:
            with open(self.facet_lookup_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            print(f"Error: {self.facet_lookup_path} not found. Run facet_parser.py first.")
            return {}
        except json.JSONDecodeError as e:
            print(f"Error loading JSON: {e}")
            return {}
    
    def _normalize_text(self, text: str) -> str:
        """Normalize text for comparison."""
        if not text:
            return ""
        # just make everything lowercase and clean it up
        text = text.lower().strip()
        # get rid of weird punctuation but keep normal stuff
        text = re.sub(r'[^\w\s-]', '', text)
        return ' '.join(text.split())
    
    def _fuzzy_match(self, query_term: str, candidate: str, threshold: float = 0.7) -> float:
        """
        Calculate fuzzy match score using Levenshtein distance.
        Returns similarity score between 0 and 1 (1 = perfect match).
        """
        if not query_term or not candidate:
            return 0.0
            
        query_norm = self._normalize_text(query_term)
        candidate_norm = self._normalize_text(candidate)
        
        if query_norm == candidate_norm:
            return 1.0
            
        if not Levenshtein:
            # fallback if levenshtein doesnt work
            if query_norm in candidate_norm or candidate_norm in query_norm:
                return 0.8
            return 0.0
        
        # actual fuzzy matching with levenshtein
        max_len = max(len(query_norm), len(candidate_norm))
        if max_len == 0:
            return 0.0
        
        distance = Levenshtein.distance(query_norm, candidate_norm)
        similarity = 1.0 - (distance / max_len)
        
        return similarity if similarity >= threshold else 0.0
    
    def _match_time_value(self, query_time: str, candidate_value: Any) -> float:
        """
        Special matching for time values (strings or structured dicts).
        """
        query_years = self._extract_years(str(query_time))
        
        if isinstance(candidate_value, dict):
            # handle the structured time stuff like {"from": 1520, "to": 1530}
            candidate_years = []
            if "from" in candidate_value:
                candidate_years.append(candidate_value["from"])
            if "to" in candidate_value:
                candidate_years.append(candidate_value["to"])
        else:
            # just strings with years in them
            candidate_years = self._extract_years(str(candidate_value))
        
        if not query_years or not candidate_years:
            return self._fuzzy_match(query_time, str(candidate_value))
        
        # check if years are close to each other
        for q_year in query_years:
            for c_year in candidate_years:
                # exact year match
                if q_year == c_year:
                    return 1.0
                # pretty close (within 10 years)
                if abs(q_year - c_year) <= 10:
                    return 0.8
                # same general time period
                if abs(q_year - c_year) <= 50:
                    return 0.6
        
        return 0.0
    
    def _extract_years(self, text: str) -> List[int]:
        """Extract 4-digit years from text."""
        if not text:
            return []
        # find years between 1400-2099 basically
        pattern = r'\b(1[4-9][0-9]{2}|20[0-9]{2})\b'
        matches = re.findall(pattern, text)
        return [int(year) for year in matches]
    
    def _search_elasticsearch_topics(self, topics: List[str], size: int = 25) -> Dict[str, float]:
        """
        Query Elasticsearch for documents by matching the concatenated topics against
        the 'full_text' field using a match query.
        Returns mapping of doc_id -> normalized score in [0,1].
        """
        if not topics:
            return {}
        try:
            # Build a match query on the 'full_text' field
            query_text = " ".join([t for t in topics if t])
            query = {
                "size": size,
                "query": {
                    "match": {
                        "full_text": query_text
                    }
                }
            }
            url = f"{self.es_base_url}/{self.es_index}/_search"
            resp = requests.post(url, json=query, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            hits = data.get("hits", {}).get("hits", [])
            if not hits:
                return {}
            max_score = max(h.get("_score", 0.0) or 0.0 for h in hits) or 1.0
            results: Dict[str, float] = {}
            for h in hits:
                doc_id = (h.get("_source", {}) or {}).get("doc_id") or h.get("_id")
                score = (h.get("_score", 0.0) or 0.0) / max_score
                if doc_id:
                    results[str(doc_id)] = max(results.get(str(doc_id), 0.0), float(score))
            return results
        except Exception as e:
            print(f"Elasticsearch topics search failed: {e}")
            return {}

    def _search_facet(self, facet_name: str, query_values: List[str]) -> Dict[str, float]:
        """
        Search a specific facet for matching documents.
        Returns dict of {document: max_score}.
        """
        if facet_name not in self.facet_data:
            return {}
        
        facet_data = self.facet_data[facet_name]
        doc_scores = defaultdict(float)
        
        for doc_name, doc_values in facet_data.items():
            max_score = 0.0
            
            for query_val in query_values:
                for doc_val in doc_values:
                    if facet_name == "time":
                        score = self._match_time_value(query_val, doc_val)
                    else:
                        score = self._fuzzy_match(query_val, str(doc_val))
                    
                    max_score = max(max_score, score)
            
            if max_score > 0:
                doc_scores[doc_name] = max_score
        
        return dict(doc_scores)
    
    def search(self, search_criteria: Dict[str, List[str]], min_score: float = 0.5) -> List[Tuple[str, float, Dict[str, float]]]:
        """
        Search documents using faceted criteria.
        
        Args:
            search_criteria: Dict like {"people": ["zwingli"], "geography": ["zurich"]}
            min_score: Minimum score threshold for results
            
        Returns:
            List of (document_name, total_score, facet_scores) sorted by score
        """
        if not search_criteria:
            return []
        
        # go through each facet and search
        all_doc_scores = defaultdict(dict)
        
        for facet_name, query_values in search_criteria.items():
            if not query_values:
                continue
                
            facet_results = self._search_facet(facet_name, query_values)
            
            for doc_name, score in facet_results.items():
                all_doc_scores[doc_name][facet_name] = score

        # If subjects are present, query Elasticsearch topics and merge as an additional facet
        subjects = search_criteria.get("subjects") or search_criteria.get("topics") or []
        if subjects:
            es_results = self._search_elasticsearch_topics(subjects)
            for doc_id, es_score in es_results.items():
                all_doc_scores[doc_id]["elasticsearch"] = es_score
        
        # now calculate the final scores
        final_results = []
        
        for doc_name, facet_scores in all_doc_scores.items():
            # just average all the facet scores
            total_score = sum(facet_scores.values()) / len(facet_scores)
            
            # give bonus if document matches more facets
            # include ES as a facet if used
            total_possible_facets = len(search_criteria) + (1 if (subjects) else 0)
            facet_match_bonus = len(facet_scores) / max(1, total_possible_facets)
            total_score = total_score * (0.7 + 0.3 * facet_match_bonus)
            
            if total_score >= min_score:
                final_results.append((doc_name, total_score, facet_scores))
        
        # sort by highest score first
        final_results.sort(key=lambda x: x[1], reverse=True)
        
        return final_results


def search_documents(query: str, orchestrator, top_k: int = 10) -> Tuple[List[Tuple[str, float, Dict[str, float]]], FacetSearcher]:
    """
    Complete pipeline: natural language query -> structured search -> document results.
    
    Args:
        query: Natural language query like "reformation in zurich 1520"
        api_key: OpenAI API key (or uses environment variable)
        top_k: Maximum number of results to return
        
    Returns:
        Tuple of (results, searcher) where results is List of (document_name, score, facet_breakdown) tuples
    """
    
    try:
        search_json_str = orchestrator.send(query)
        print(f"LLM Search JSON: {search_json_str}")
        
        # parse the json response
        search_criteria = json.loads(search_json_str)
        
    except json.JSONDecodeError as e:
        print(f"Error parsing LLM response as JSON: {e}")
        print(f"Raw response: {search_json_str}")
        return [], FacetSearcher()
    except Exception as e:
        print(f"Error getting LLM response: {e}")
        return [], FacetSearcher()
    
    # now do the actual search
    searcher = FacetSearcher()
    results = searcher.search(search_criteria)
    
    # Round scores for display friendliness even when printing raw tuples
    rounded_results = []
    for doc_name, total_score, facet_scores in results[:top_k]:
        rounded_facet_scores = {facet: round(score, 2) for facet, score in facet_scores.items()}
        rounded_results.append((doc_name, round(total_score, 2), rounded_facet_scores))
    
    # return top results and searcher
    return rounded_results, searcher


def print_results(results: List[Tuple[str, float, Dict[str, float]]], query: str, searcher: Optional[FacetSearcher] = None):
    """Pretty print search results."""
    print(f"\n🔍 Search results for: '{query}'")
    print("=" * 60)
    
    if not results:
        print("No matching documents found.")
        return
    
    for i, (doc_name, total_score, facet_scores) in enumerate(results, 1):
        # Try to get edition info if available
        edition_name = ""
        if searcher and "edition_info" in searcher.facet_data:
            edition_data = searcher.facet_data["edition_info"].get(doc_name, [])
            if edition_data:
                edition_name = f"[{edition_data[0]}] " if edition_data[0] else ""
        
        print(f"\n{i}. {edition_name}{doc_name}")
        print(f"   Score: {total_score:.2f}")
        print(f"   Matches: {', '.join(f'{facet}={score:.2f}' for facet, score in facet_scores.items())}")


if __name__ == "__main__":
    # some test queries
    queries = [
    
        "documents from publisher nicolas legrand",
        "stuff from around 1900 with bernhard fetz",
        "reformation in zurich between 1520 and 1530",
        "german language editions about humanism"
        
        #'Editions containing inscriptions',
        #'Editions containing a dictionary/ dictionaries',
        #'Editions containing documents about Northern Africa around 500 BCE specializing in Inscriptions',
        #'Editions containing religious scripts',
        #'Editions about intellectuals of the enlightment period'

    ]
    
    print("🚀 Facet-based Document Search Demo")
    print("=" * 50)
    
    for query in queries:
        try:
            results, searcher = search_documents(query, top_k=5)
            print_results(results, query, searcher)
        except Exception as e:
            print(f"Error searching '{query}': {e}")
        
        print("\n" + "-" * 50) 