"""Herramientas internas permitidas al asesor; nunca ejecutan SQL generado."""

from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import Lock
from typing import Any
from uuid import uuid4

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .env import load_dotenv


class EnvVariable(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str
    aggregation: str


class EnvQueryArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    variables: list[EnvVariable] = Field(min_length=1, max_length=5)
    days_back: int = Field(ge=1, le=365)
    compare_to_normal: bool = True


class ResolvedCasesArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    symptoms: list[str] = Field(max_length=10)
    limit: int = Field(default=3, ge=1, le=5)


class ExternalContextArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    region: str
    threat_code: str


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {"type": "function", "name": "env_query", "description": "Consulta datos ambientales agregados de esta parcela.", "parameters": EnvQueryArgs.model_json_schema(), "strict": True},
    {"type": "function", "name": "search_resolved_cases", "description": "Busca experiencias anonimizadas de casos resueltos similares.", "parameters": ResolvedCasesArgs.model_json_schema(), "strict": True},
    {"type": "function", "name": "get_external_context", "description": "Obtiene contexto externo previamente curado; no navega internet en tiempo real.", "parameters": ExternalContextArgs.model_json_schema(), "strict": True},
]


@dataclass
class AdvisorToolGateway:
    """Cliente de las APIs internas, con timeout por dependencia.

    La demo no implementa autenticación entre servicios.
    """

    base_url: str
    timeout_seconds: float = 2.0
    turn_budget_seconds: float = 5.0
    env_queries: list[dict[str, Any]] = field(default_factory=list)
    resolved_cases: list[dict[str, Any]] = field(default_factory=list)
    budget_exhausted: bool = False
    _lock: Lock = field(default_factory=Lock, repr=False)

    @classmethod
    def from_environment(cls) -> "AdvisorToolGateway":
        load_dotenv()
        return cls(os.getenv("ADVISOR_BACKEND_BASE_URL", "http://localhost:8000").rstrip("/"))

    def execute_many(
        self,
        calls: list[Any],
        *,
        plot_id: str,
        started_at: float,
        is_demo: bool = True,
    ) -> list[tuple[str, str]]:
        """Ejecuta las function calls de un turno en paralelo."""
        if not calls:
            return []
        if time.monotonic() - started_at >= self.turn_budget_seconds:
            self.budget_exhausted = True
            return [(call.call_id, self._error("turn_budget_exhausted", retryable=False)) for call in calls]

        def run(call: Any) -> tuple[str, str]:
            return call.call_id, self.execute(
                call.name, call.arguments, plot_id=plot_id, started_at=started_at, is_demo=is_demo
            )

        if len(calls) == 1:
            return [run(calls[0])]
        with ThreadPoolExecutor(max_workers=min(3, len(calls))) as pool:
            return list(pool.map(run, calls))

    def execute(
        self,
        name: str,
        raw_arguments: str,
        *,
        plot_id: str,
        started_at: float,
        is_demo: bool = True,
    ) -> str:
        if time.monotonic() - started_at >= self.turn_budget_seconds:
            self.budget_exhausted = True
            return self._error("turn_budget_exhausted", retryable=False)
        try:
            args = json.loads(raw_arguments)
            if name == "env_query":
                parsed = EnvQueryArgs.model_validate(args)
                query_id = f"q_{uuid4().hex[:12]}"
                result = self._post(
                    "/v1/environment/query",
                    {
                        "schema_version": "2.0",
                        "query_id": query_id,
                        "requested_by": "advisor",
                        "target": {"plot_id": plot_id},
                        "variables": [item.model_dump() for item in parsed.variables],
                        "window": {"days_back": parsed.days_back, "end_date": None},
                        "compare_to_normal": parsed.compare_to_normal,
                        "is_demo": is_demo,
                    },
                )
                self._record_env(result)
                return result
            if name == "search_resolved_cases":
                parsed = ResolvedCasesArgs.model_validate(args)
                result = self._post(
                    "/v1/resolved-cases/search",
                    {
                        "threat_code": "coffee_leaf_rust",
                        "symptoms": parsed.symptoms,
                        "near_plot_id": plot_id,
                        "max_distance_km": 50,
                        "only_verified": False,
                        "limit": parsed.limit,
                    },
                )
                result = self._remove_unapproved_solutions(result)
                self._record_resolved(result)
                return result
            if name == "get_external_context":
                parsed = ExternalContextArgs.model_validate(args)
                if parsed.threat_code != "coffee_leaf_rust":
                    return self._error("invalid_threat_code", retryable=False)
                return self._get("/v1/external-context", parsed.model_dump())
        except (json.JSONDecodeError, ValidationError):
            return self._error("invalid_tool_arguments", retryable=False)
        return self._error("unknown_tool", retryable=False)

    def _record_env(self, payload: str) -> None:
        body = _json_object(payload)
        if body is None or "error" in body or "results" not in body:
            return
        with self._lock:
            self.env_queries.append(body)

    def _record_resolved(self, payload: str) -> None:
        body = _json_object(payload)
        if body is None or "error" in body:
            return
        with self._lock:
            seen = {item.get("resolution_id") for item in self.resolved_cases}
            for item in body.get("results") or []:
                resolution_id = item.get("resolution_id")
                if resolution_id and resolution_id not in seen:
                    self.resolved_cases.append(item)
                    seen.add(resolution_id)

    def _post(self, path: str, payload: dict[str, Any]) -> str:
        try:
            response = httpx.post(f"{self.base_url}{path}", json=payload, timeout=self.timeout_seconds)
            response.raise_for_status()
            return response.text
        except httpx.TimeoutException:
            return self._error("dependency_timeout", retryable=True)
        except httpx.HTTPError:
            return self._error("dependency_unavailable", retryable=True)

    def _get(self, path: str, params: dict[str, Any]) -> str:
        try:
            response = httpx.get(f"{self.base_url}{path}", params=params, timeout=self.timeout_seconds)
            response.raise_for_status()
            return response.text
        except httpx.TimeoutException:
            return self._error("dependency_timeout", retryable=True)
        except httpx.HTTPError:
            return self._error("dependency_unavailable", retryable=True)

    @staticmethod
    def _error(code: str, *, retryable: bool) -> str:
        return json.dumps({"error": {"code": code, "retryable": retryable}}, ensure_ascii=False)

    @staticmethod
    def _remove_unapproved_solutions(payload: str) -> str:
        """No entregar productos/dosis de testimonios sin protocolo aprobado."""
        try:
            body = json.loads(payload)
            for item in body.get("results", []):
                if item.get("matches_protocol") is not True:
                    item.pop("solution_summary", None)
                    item.pop("solution_statement", None)
                    item.pop("product", None)
                    item.pop("dose", None)
            return json.dumps(body, ensure_ascii=False)
        except (AttributeError, json.JSONDecodeError):
            return payload


def _json_object(payload: str) -> dict[str, Any] | None:
    try:
        body = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return body if isinstance(body, dict) else None
