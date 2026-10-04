"""Idempotency-Key handling (INSTRUCTIONS.md section 8).

Same key + same body -> stored response (with Idempotency-Replayed: true). Same key + other body -> 409.
The key and the business write commit in the same transaction; an error releases the key.
"""

import hashlib
import json
from collections.abc import Callable

from fastapi.responses import JSONResponse
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from backend.app.errors import ApiError


def body_hash(body: BaseModel) -> str:
    canonical = json.dumps(body.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def idempotent(conn: Connection, key: str, scope: str, body: BaseModel,
               run: Callable[[], tuple[int, dict]]) -> JSONResponse:
    """Runs `run` (returns status and JSON body) at most once per key, inside one transaction."""
    with conn.transaction():
        claimed = conn.execute(
            """
            insert into idempotency_keys (key, scope, request_hash) values (%s, %s, %s)
            on conflict (key) do nothing returning key
            """,
            (key, scope, body_hash(body)),
        ).fetchone()
        if not claimed:
            existing = conn.execute(
                "select scope, request_hash, response_status, response_body from idempotency_keys where key = %s",
                (key,),
            ).fetchone()
            if existing["scope"] != scope or existing["request_hash"] != body_hash(body):
                raise ApiError(409, "La Idempotency-Key ya se usó con otro cuerpo", code="IDEMPOTENCY_KEY_REUSED")
            if existing["response_body"] is None:
                raise ApiError(409, "Solicitud con esta Idempotency-Key en proceso", retryable=True)
            return JSONResponse(existing["response_body"], status_code=existing["response_status"],
                                headers={"Idempotency-Replayed": "true"})

        status, payload = run()
        conn.execute(
            "update idempotency_keys set response_status = %s, response_body = %s where key = %s",
            (status, Jsonb(payload), key), 
        )
    return JSONResponse(payload, status_code=status)


def is_replay(response: JSONResponse) -> bool:
    return response.headers.get("Idempotency-Replayed") == "true"
