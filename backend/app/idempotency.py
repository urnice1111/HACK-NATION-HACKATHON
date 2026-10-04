"""Idempotency-Key handling (INSTRUCTIONS.md section 8).

Same key + same body -> stored response. Same key + different body -> 409.
Must run inside the caller's transaction so the key and the write commit together.
"""

import hashlib
import json

from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from backend.app.errors import ApiError


def body_hash(body: BaseModel) -> str:
    canonical = json.dumps(body.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def claim_key(conn: Connection, key: str, scope: str, request_hash: str) -> dict | None:
    """Claims the key. Returns the stored response if it was already used with the same body."""
    claimed = conn.execute(
        """
        insert into idempotency_keys (key, scope, request_hash) values (%s, %s, %s)
        on conflict (key) do nothing returning key
        """,
        (key, scope, request_hash),
    ).fetchone()
    if claimed:
        return None

    existing = conn.execute(
        "select scope, request_hash, response_body from idempotency_keys where key = %s", (key,)
    ).fetchone()
    if existing["scope"] != scope or existing["request_hash"] != request_hash:
        raise ApiError(409, "Idempotency-Key ya usada con otro cuerpo", code="IDEMPOTENCY_CONFLICT")
    if existing["response_body"] is None:
        raise ApiError(409, "Solicitud con esta Idempotency-Key en proceso", retryable=True)
    return existing["response_body"]


def store_response(conn: Connection, key: str, status: int, body: dict) -> None:
    conn.execute(
        "update idempotency_keys set response_status = %s, response_body = %s where key = %s",
        (status, Jsonb(body), key),
    )
