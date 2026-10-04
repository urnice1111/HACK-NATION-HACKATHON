"""Herramientas internas permitidas al asesor; nunca ejecutan SQL generado."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError


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
    """Cliente de las APIs de los devs 3 y 4, con timeout por dependencia.

    La demo no implementa autenticación entre servicios.
    """

    base_url: str
    timeout_seconds: float = 2.0
    turn_budget_seconds: float = 5.0

    @classmethod
    def from_environment(cls) -> "AdvisorToolGateway":
        return cls(os.getenv("ADVISOR_BACKEND_BASE_URL", "http://localhost:8000").rstrip("/"))

    def execute(self, name: str, raw_arguments: str, *, plot_id: str, started_at: float) -> str:
        if time.monotonic() - started_at >= self.turn_budget_seconds:
            return self._error("turn_budget_exhausted", retryable=False)
        try:
            args = json.loads(raw_arguments)
            if name == "env_query":
                parsed = EnvQueryArgs.model_validate(args)
                return self._post("/v1/environment/query", {"schema_version": "2.0", "query_id": "advisor_internal", "requested_by": "advisor", "target": {"plot_id": plot_id}, "variables": [item.model_dump() for item in parsed.variables], "window": {"days_back": parsed.days_back, "end_date": None}, "compare_to_normal": parsed.compare_to_normal, "is_demo": True})
            if name == "search_resolved_cases":
                parsed = ResolvedCasesArgs.model_validate(args)
                result = self._post("/v1/resolved-cases/search", {"threat_code": "coffee_leaf_rust", "symptoms": parsed.symptoms, "near_plot_id": plot_id, "max_distance_km": 20, "only_verified": False, "limit": parsed.limit})
                return self._remove_unapproved_solutions(result)
            if name == "get_external_context":
                parsed = ExternalContextArgs.model_validate(args)
                if parsed.threat_code != "coffee_leaf_rust":
                    return self._error("invalid_threat_code", retryable=False)
                return self._get("/v1/external-context", parsed.model_dump())
        except (json.JSONDecodeError, ValidationError):
            return self._error("invalid_tool_arguments", retryable=False)
        return self._error("unknown_tool", retryable=False)

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
