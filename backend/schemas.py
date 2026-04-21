"""
Pydantic data models for the Digital Editions API.

Defines request/response schemas for:
- Query interpretation: Converting natural language to structured facets
- Document lookup: Finding editions based on facet criteria  
- Binary facet validation: Ensuring document type/content flags are boolean
"""
from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional, Literal

from pydantic import BaseModel, Field, ConfigDict, field_validator


# === Query Interpretation Schemas ===

class QueryRequest(BaseModel):
    """
    Request model for natural language query interpretation.
    
    Attributes:
        query: User's search query string (1-500 characters)
    """
    query: str = Field(..., min_length=1, max_length=500)


class FacetName(str, Enum):
    """
    Enumeration of all available search facets.
    
    Includes both traditional metadata facets and binary document characteristics.
    Binary facets (document types and content features) only accept true/false values.
    """
    # Traditional metadata facets
    TIME = "time"
    GEOGRAPHY = "geography"
    PEOPLE = "people"
    INSTITUTIONS = "institutions"
    PUBLISHER = "publisher"
    LANGUAGE = "language"
    EDITION_INFO = "edition_info"
    IDENTIFIERS = "identifiers"
    RIGHTS = "rights"
    REPOSITORY = "repository"
    CITATIONS_RELATIONS = "citations_relations"
    DOCUMENT_AUTHORS = "document_authors"
    SUBJECTS = "subjects"
    
    # Binary document type characteristics
    HISTORIC = "historic"
    MEDIEVAL_MANUSCRIPT = "medieval_manuscript"
    MANUSCRIPT = "manuscript"
    LETTER = "letter"
    POLITICAL_LETTER = "political_letter"
    
    # Binary content characteristics
    VERSE = "verse"
    DIRECT_SPEECH = "direct_speech"
    LINGUISTIC_ANNOTATION = "linguistic_annotation"
    THEATRE = "theatre"
    EAST_ASIAN_SCRIPTS = "east_asian_scripts"
    JAPANESE_SCRIPTS = "japanese_scripts"
    POLITICAL_PROTOCOLS = "political_protocols"
    DICTIONARY = "dictionary"
    INSCRIPTIONS = "inscriptions"
    LAW_TEXTS = "law_texts"
    NEWSPAPER_ARTICLES = "newspaper_articles"
    DIARY = "diary"


# Binary facets that only accept "true" or "false" values
BINARY_FACETS = {
    FacetName.HISTORIC, FacetName.MEDIEVAL_MANUSCRIPT, FacetName.MANUSCRIPT,
    FacetName.LETTER, FacetName.POLITICAL_LETTER, FacetName.VERSE,
    FacetName.DIRECT_SPEECH, FacetName.LINGUISTIC_ANNOTATION, FacetName.THEATRE,
    FacetName.EAST_ASIAN_SCRIPTS, FacetName.JAPANESE_SCRIPTS, FacetName.POLITICAL_PROTOCOLS,
    FacetName.DICTIONARY, FacetName.INSCRIPTIONS, FacetName.LAW_TEXTS,
    FacetName.NEWSPAPER_ARTICLES, FacetName.DIARY
}


class FacetValue(BaseModel):
    """
    A facet filter with operation type and search values.
    
    Attributes:
        op: Filter operation - "include" (AND) or "exclude" (NOT)
        values: List of 1-5 search terms (canonical + variants/synonyms)
    """
    op: Literal["include", "exclude"] = "include"
    values: List[str] = Field(
        ...,
        min_length=1,
        max_length=5,
        description="Canonical term plus up to 4 common variants or synonyms"
    )
    
    model_config = ConfigDict(extra="forbid")

class FacetPayload(BaseModel):
    """
    Structured facet data exchanged between API endpoints.
    
    Contains the interpreted search criteria with validation for binary facets.
    
    Attributes:
        message: Human-readable description of applied filters
        facets: Dictionary mapping facet names to their filter criteria
    """
    message: str = Field(..., min_length=1, max_length=240)
    facets: Dict[FacetName, List[FacetValue]] = Field(default_factory=dict)
    
    @field_validator('facets')
    @classmethod
    def validate_binary_facets(cls, v):
        """
        Ensure binary facets only contain valid boolean values.
        
        Args:
            v: Facets dictionary to validate
            
        Returns:
            Validated facets dictionary
            
        Raises:
            ValueError: If binary facet has invalid structure or values
        """
        for facet_name, facet_values in v.items():
            if facet_name in BINARY_FACETS:
                for facet_value in facet_values:
                    # Binary facets must have exactly one value
                    if len(facet_value.values) != 1:
                        raise ValueError(
                            f"Binary facet '{facet_name}' must have exactly 1 value, "
                            f"got {len(facet_value.values)}"
                        )
                    
                    # Value must be boolean string representation
                    value = facet_value.values[0].lower()
                    if value not in ['true', 'false']:
                        raise ValueError(
                            f"Binary facet '{facet_name}' only accepts 'true' or 'false', "
                            f"got '{facet_value.values[0]}'"
                        )
        return v


class FacetsResponse(BaseModel):
    """
    Response from query interpretation endpoint.
    
    Attributes:
        data: Structured facet payload with extracted search criteria
    """
    data: FacetPayload = Field(default_factory=FacetPayload)
    
    model_config = ConfigDict(extra="forbid")


# === Document Lookup Schemas ===

class LookupRequest(BaseModel):
    """
    Request for document lookup based on facet criteria.
    
    Attributes:
        data: Facet payload containing search filters
    """
    data: FacetPayload
    
    model_config = ConfigDict(extra="forbid")


class EditionHit(BaseModel):
    """
    A single document edition returned in search results.
    
    Attributes:
        title: Document title (optional)
        highlight: Whether to highlight this result in the UI
    """
    title: Optional[str] = None
    highlight: bool = True


class EditionsResponse(BaseModel):
    """
    Response containing document search results.
    
    Attributes:
        editions: List of matching document editions
        total_matched: Total number of documents found
    """
    editions: List[EditionHit] = Field(default_factory=list)
    total_matched: int = 0
    
    model_config = ConfigDict(extra="forbid")
