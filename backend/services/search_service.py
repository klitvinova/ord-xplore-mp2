from __future__ import annotations

from typing import Any, Dict, Protocol

from fastapi import APIRouter, HTTPException

from schemas import (
    QueryRequest,
    FacetsResponse,
    FacetPayload,
)


class LLMClient(Protocol):
    """
    Protocol interface for LLM client implementations.
    
    Defines the contract for converting user queries into structured facet data.
    Keeps the service layer decoupled from specific LLM SDK implementations.
    """
    def query_to_facets(self, user_query: str) -> Dict[str, Any]:
        """
        Convert user query to structured facet data.
        
        Args:
            user_query: Natural language search query
            
        Returns:
            Dict matching FacetsResponse schema:
            {"data": {"facets": { "time": [{"op":"include","value":"1945"}], ... }}}
        """
        ...


class SearchService:
    """
    FastAPI service for query interpretation and facet extraction.
    
    Provides the POST /interpret endpoint that:
    - Accepts natural language queries via QueryRequest
    - Uses LLM client to extract structured search facets
    - Returns validated FacetsResponse with error handling
    """

    def __init__(self, llm_client: LLMClient, *, prefix: str = "") -> None:
        self.llm_client = llm_client
        self.router = APIRouter(prefix=prefix, tags=["search"])

        @self.router.post("/interpret", response_model=FacetsResponse)
        def interpret(req: QueryRequest) -> FacetsResponse:
            """Extract search facets from natural language query."""
            user_query = req.query.strip()
            if not user_query:
                raise HTTPException(status_code=400, detail="Empty query")

            raw = self.llm_client.query_to_facets(user_query)

            # Validate LLM output against schema to ensure data integrity
            try:
                return FacetsResponse.model_validate(raw)
            except (ValueError, TypeError, KeyError) as e:
                # Graceful fallback: return empty facets when LLM output is malformed
                return FacetsResponse(
                    data=FacetPayload(
                        message="No filters could be applied to your query.", 
                        facets={}
                    )
                )
