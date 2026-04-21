"""
FastAPI backend application for digital editions search and facet extraction.

Provides REST API endpoints for:
- Natural language query interpretation (/api/interpret)
- Document search using extracted facets (/api/lookup)
- Health monitoring (/health)
"""
import os
import signal
import sys
from contextlib import asynccontextmanager
from typing import Dict, Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from services.search_service import SearchService
from services.lookup_service import LookupService
from services.openai_llm import OpenAILLM

# Get API key from environment variable
API_KEY = os.environ.get("OPENAI_API_KEY", "")
# Note: Verification is deferred to service initialization to prevent startup crashes.


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manage application lifecycle with graceful startup and shutdown.
    
    Args:
        app: FastAPI application instance
        
    Yields:
        Control to the running application
    """
    # Application startup
    print("Starting digital editions backend server...")
    yield
    
    # Application shutdown - cleanup resources
    print("Shutting down digital editions backend server...")


def create_app() -> FastAPI:
    """
    Create and configure the FastAPI application.
    
    Sets up middleware, services, routes, and lifecycle management.
    
    Returns:
        Configured FastAPI application instance
    """
    app = FastAPI(
        title="Digital Editions Backend API",
        description="Backend API for TEI document search and facet extraction",
        version="1.0.0",
        lifespan=lifespan
    )

    # Configure CORS middleware for cross-origin requests
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # NOTE: Restrict to specific domains in production
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    # Initialize LLM client
    if not API_KEY:
        print("WARNING: OPENAI_API_KEY not set. Search features will be unavailable.")
    
    llm_client = OpenAILLM(api_key=API_KEY)

    # Initialize services
    search_service = SearchService(llm_client=llm_client, prefix="/api")
    lookup_service = LookupService(prefix="/api")

    # Register routes
    app.include_router(search_service.router)
    app.include_router(lookup_service.router)

    # Health monitoring endpoint
    @app.get("/health")
    def health() -> Dict[str, str]:
        """Health check endpoint for service monitoring and load balancers."""
        return {"status": "ok", "service": "digital-editions-backend"}

    return app


def signal_handler(signum: int, frame) -> None:
    """
    Handle system signals for graceful application shutdown.
    
    Args:
        signum: Signal number received
        frame: Current stack frame (unused)
    """
    print(f"\nReceived signal {signum}. Shutting down gracefully...")
    sys.exit(0)


app = create_app()

if __name__ == "__main__":
    import uvicorn
    
    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, signal_handler)   # Handle Ctrl+C
    signal.signal(signal.SIGTERM, signal_handler)  # Handle process termination
    
    try:
        uvicorn.run(
            "index:app",
            host="127.0.0.1",
            port=8000,
            reload=False,  # Disabled to prevent shutdown issues in development
            log_level="info",
            access_log=True,
            timeout_keep_alive=5,
            timeout_graceful_shutdown=5
        )
    except KeyboardInterrupt:
        print("\nShutdown complete!")
    except Exception as e:
        print(f"Server error: {e}")
        sys.exit(1)
