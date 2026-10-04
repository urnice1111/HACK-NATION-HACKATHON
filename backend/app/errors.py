"""Uniform error body (INSTRUCTIONS.md section 8) for every failure path."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("api")

STATUS_CODES = {
    400: "INVALID_JSON",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    503: "DEPENDENCY_UNAVAILABLE",
}


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None,
                 retryable: bool = False, details: list[dict] | None = None):
        self.status = status
        self.code = code or STATUS_CODES.get(status, "ERROR")
        self.message = message
        self.retryable = retryable
        self.details = details or []


def error_response(request: Request, status: int, code: str, message: str,
                   retryable: bool = False, details: list[dict] | None = None) -> JSONResponse:
    request_id = getattr(request.state, "request_id", "unknown")
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "retryable": retryable,
                           "request_id": request_id, "details": details or []}},
        headers={"X-Request-ID": request_id},
    )


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(request: Request, exc: ApiError):
        return error_response(request, exc.status, exc.code, exc.message, exc.retryable, exc.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        if any(e["type"] == "json_invalid" for e in errors):
            return error_response(request, 400, "INVALID_JSON", "El cuerpo no es JSON válido")
        details = [
            {"field": ".".join(str(p) for p in e["loc"] if p != "body"), "reason": e["type"]}
            for e in errors
        ]
        message = f"{details[0]['field']}: {errors[0]['msg']}" if details else "Solicitud inválida"
        return error_response(request, 422, "VALIDATION_ERROR", message, details=details)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        code = STATUS_CODES.get(exc.status_code, "ERROR")
        return error_response(request, exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        log.exception("unhandled error request_id=%s", getattr(request.state, "request_id", "?"))
        return error_response(request, 500, "INTERNAL_ERROR", "Error interno", retryable=True)
