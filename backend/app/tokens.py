"""Opaque, signed, short-lived candidate tokens for contact resolution."""

import base64
import hashlib
import hmac
import json
import time

from backend.app.config import settings


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign(payload: bytes) -> str:
    return _b64(hmac.new(settings.token_secret.encode(), payload, hashlib.sha256).digest())


def make_candidate_token(farmer_id: str, session_id: str, phone: str) -> str:
    payload = json.dumps(
        {"f": farmer_id, "s": session_id, "p": phone, "exp": int(time.time()) + settings.candidate_token_ttl_s},
        separators=(",", ":"),
    ).encode()
    return f"{_b64(payload)}.{_sign(payload)}"


def read_candidate_token(token: str, session_id: str, phone: str) -> str | None:
    """Returns the farmer_id, or None if invalid, expired, or from another session or phone."""
    try:
        encoded, signature = token.split(".", 1)
        payload = _unb64(encoded)
    except ValueError:
        return None
    if not hmac.compare_digest(signature, _sign(payload)):
        return None
    data = json.loads(payload)
    if data["s"] != session_id or data["p"] != phone or data["exp"] < time.time():
        return None
    return data["f"]
