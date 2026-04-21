# services/lookup_service.py
"""
⚠️  WORK IN PROGRESS - NOT CURRENTLY USED ⚠️

This module implements document lookup functionality based on faceted search criteria.
While functional, it is not integrated into the current application workflow.
The frontend dashboard only uses the /interpret endpoint for facet extraction.

Status: Idealistic implementation for future development.
"""
from __future__ import annotations

from typing import Dict, List, Protocol, Iterable

from fastapi import APIRouter

from schemas import LookupRequest, EditionsResponse, EditionHit, FacetName


# --- This should already exist ---
# from facet_search import search
# (Import inside method if you want to avoid import-time side effects)
from services.facet_search import FacetSearcher


def _normalize_terms(terms: Iterable[str]) -> List[str]:
    """
    Normalize and deduplicate values while preserving order.
    Minimal normalization: strip + lowercase.
    """
    out: List[str] = []
    seen = set()
    for t in terms:
        if t is None:
            continue
        s = t.strip().lower()
        if not s:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def facet_payload_to_filters(req: LookupRequest) -> tuple[Dict[str, List[str]], Dict[str, List[str]]]:
    """
    Convert LookupRequest -> (include_filters, exclude_filters)
    where each is {facet_name: [terms...]}.

    We flatten all provided values for each facet entry (canonical + synonyms),
    because your search backend can choose how to interpret them (OR semantics).
    """
    include_filters: Dict[str, List[str]] = {}
    exclude_filters: Dict[str, List[str]] = {}

    for facet_name, entries in req.data.facets.items():
        facet_key = facet_name.value if isinstance(facet_name, FacetName) else str(facet_name)

        for entry in entries:
            normalized = _normalize_terms(entry.values)

            if not normalized:
                continue

            target = include_filters if entry.op == "include" else exclude_filters
            target.setdefault(facet_key, []).extend(normalized)

    # final dedupe per facet (preserve order)
    for d in (include_filters, exclude_filters):
        for k, v in list(d.items()):
            d[k] = _normalize_terms(v)

    return include_filters, exclude_filters


class LookupService:
    """
    Owns one endpoint: POST /lookup
    - takes LookupRequest (facet JSON)
    - converts to include/exclude dicts
    - passes to facet_search.search()
    - returns EditionsResponse
    """

    def __init__(self, *, prefix: str = "") -> None:
        self.router = APIRouter(prefix=prefix, tags=["lookup"])

        @self.router.post("/lookup", response_model=EditionsResponse)
        def lookup(req: LookupRequest) -> EditionsResponse:
            include_filters, exclude_filters = facet_payload_to_filters(req)

            # If your facet_search.search currently only accepts one dict,
            # either (a) extend it to accept excludes, or (b) ignore excludes.
            #
            # Recommended signature:
            #   search(include_filters: dict, exclude_filters: dict) -> list[dict] | list[EditionHit]
            fs = FacetSearcher()
            results = fs.search(include_filters)

            # Results from facet_search.search() are tuples: (doc_name, total_score, facet_scores)
            hits: List[EditionHit] = []
            for r in results:
                if isinstance(r, EditionHit):
                    hits.append(r)
                elif isinstance(r, tuple) and len(r) >= 3:
                    # Unpack tuple: (document_name, total_score, facet_scores)
                    doc_name, total_score, facet_scores = r[:3]
                    hits.append(
                        EditionHit(
                            title=str(doc_name),  # Use doc_name as title for now
                            highlight=True,
                        )
                    )
                else:
                    # Fallback for unexpected format
                    hits.append(
                        EditionHit(
                            id=str(r),
                            title=str(r),
                            highlight=True,
                        )
                    )

            return EditionsResponse(editions=hits, total_matched=len(hits))
