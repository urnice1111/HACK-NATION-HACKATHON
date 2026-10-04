"""Run: uvicorn backend.app.main:app --reload"""

import logging
import os
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from backend.app.db import pool
from backend.app.errors import ApiError, install_error_handlers
from backend.app.routes import alerts, contacts, environment, followups, graph, plots, reports, resolutions

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool.open()
    yield
    pool.close()


app = FastAPI(title="Agro voice MVP backend", version="0.1.0", lifespan=lifespan)
install_error_handlers(app)

# Dashboard en el navegador (Vite dev en :5173). En despliegue, CORS_ORIGINS con la URL pública separada por comas.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID", "X-Operator-Id"],
    expose_headers=["X-Request-ID"],
)


@app.middleware("http")
async def request_id(request: Request, call_next):
    request.state.request_id = request.headers.get("X-Request-ID") or f"req_{uuid.uuid4().hex[:16]}"
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response


@app.get("/health", tags=["health"])
@app.get("/v1/health", tags=["health"])
def health():
    try:
        with pool.connection(timeout=2) as conn:
            conn.execute("select 1")
    except Exception as exc:
        raise ApiError(503, "Base de datos no disponible", retryable=True) from exc
    return {"status": "ok"}


app.include_router(contacts.router)
app.include_router(plots.router)
app.include_router(reports.router)
app.include_router(graph.router)
app.include_router(alerts.router)
app.include_router(followups.router)
app.include_router(resolutions.router)
app.include_router(environment.router)
