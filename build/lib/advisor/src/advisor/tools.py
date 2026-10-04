"""Internal tools the advisor may call; they never run generated SQL.

Each tool calls a backend endpoint (members 3 and 4) with a validated, structured
request. What the model reads back is data, never instructions. Anything that must
be true in the response (what was queried, which cases exist, which sources were
read) is recorded here from the real responses, not taken from the model.
"""

from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .catalog import PRACTICES, THREAT_CODE, normalize_language
from .contracts import DataUsed

MAX_INTERNAL_QUERIES = 3
# Plots of the demo region are up to ~35 km apart; distance_band hides the exact distance.
RESOLVED_CASE_RADIUS_KM = 50
EXTERNAL_CONTEXT_ITEMS = 3
EXTERNAL_CONTEXT_CHARS = 600

# Mirror of env.variable_catalog (backend/scripts/load_nasa_power.py). Validated here so a
# wrong code costs nothing; the backend validates again against the real catalog.
ENV_VARIABLES: dict[str, dict[str, Any]] = {
    "humidity_pct": {"unit": "%", "aggregations": ["mean", "min", "max"], "en": "relative humidity", "es": "humedad relativa"},
    "precip_mm": {"unit": "mm", "aggregations": ["sum", "mean", "min", "max"], "en": "rainfall", "es": "lluvia"},
    "temp_mean_c": {"unit": "°C", "aggregations": ["mean", "min", "max"], "en": "temperature", "es": "temperatura"},
    "temp_max_c": {"unit": "°C", "aggregations": ["mean", "min", "max"], "en": "maximum temperature", "es": "temperatura máxima"},
    "temp_min_c": {"unit": "°C", "aggregations": ["mean", "min", "max"], "en": "minimum temperature", "es": "temperatura mínima"},
}
_AGGREGATION_WORDS = {
    "en": {"mean": "average", "sum": "total", "min": "minimum", "max": "maximum"},
    "es": {"mean": "promedio", "sum": "total", "min": "mínimo", "max": "máximo"},
}


class EnvVariable(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str
    aggregation: str


class EnvQueryArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    variables: list[EnvVariable] = Field(min_length=1, max_length=5)
    days_back: int = Field(ge=1, le=365)


class ResolvedCasesArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    symptoms: list[str] = Field(min_length=1, max_length=10)


class ExternalContextArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    region: str = Field(min_length=1, max_length=200)


# Written by hand: strict mode needs every property required and no unsupported keywords.
TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "env_query",
        "description": "Aggregated environmental data (NASA POWER grid) for the caller's plot, compared with the monthly normal.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "variables": {
                    "type": "array",
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "properties": {
                            "code": {"type": "string", "enum": list(ENV_VARIABLES)},
                            "aggregation": {"type": "string", "enum": ["mean", "sum", "min", "max"]},
                        },
                        "required": ["code", "aggregation"],
                        "additionalProperties": False,
                    },
                },
                "days_back": {"type": "integer", "description": "Window ending at the latest data, 1 to 365 days."},
            },
            "required": ["variables", "days_back"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "search_resolved_cases",
        "description": "Anonymized coffee leaf rust cases resolved near this plot. Only cases solved with approved protocol practices are returned.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "symptoms": {
                    "type": "array",
                    "maxItems": 10,
                    "items": {"type": "string"},
                    "description": "Short symptom phrases, each in English and in Spanish (stored cases may be in either).",
                },
            },
            "required": ["symptoms"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "get_external_context",
        "description": "Curated, reviewed reference notes about coffee leaf rust for a region. Does not browse the internet.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {"region": {"type": "string", "description": "Region name, e.g. Veracruz."}},
            "required": ["region"],
            "additionalProperties": False,
        },
    },
]


@dataclass
class ToolResult:
    """What one internal query returned: text for the model plus verified facts for the response."""

    name: str
    output: str
    data_used: DataUsed | None = None
    # Only cases solved with protocol practices, by resolution_id.
    resolved_cases: dict[str, dict[str, Any]] = field(default_factory=dict)
    source_ids: list[str] = field(default_factory=list)
    stale: bool = False


@dataclass
class AdvisorToolGateway:
    """Client of the internal APIs, with a timeout per dependency. The demo has no service auth."""

    base_url: str
    timeout_seconds: float = 2.0

    @classmethod
    def from_environment(cls) -> "AdvisorToolGateway":
        return cls(os.getenv("ADVISOR_BACKEND_BASE_URL", "http://localhost:8000").rstrip("/"))

    def execute_many(self, calls: list[tuple[str, str]], *, plot_id: str, language: str) -> list[ToolResult]:
        """Runs up to MAX_INTERNAL_QUERIES calls in parallel; extra calls are answered, not run."""
        allowed = calls[:MAX_INTERNAL_QUERIES]
        with ThreadPoolExecutor(max_workers=MAX_INTERNAL_QUERIES) as pool:
            results = list(pool.map(lambda call: self.execute(call[0], call[1], plot_id=plot_id, language=language), allowed))
        for name, _ in calls[MAX_INTERNAL_QUERIES:]:
            results.append(ToolResult(name, self._error("query_limit_reached", retryable=False)))
        return results

    def execute(self, name: str, raw_arguments: str, *, plot_id: str, language: str) -> ToolResult:
        try:
            args = json.loads(raw_arguments)
            if name == "env_query":
                return self._env_query(EnvQueryArgs.model_validate(args), plot_id=plot_id, language=language)
            if name == "search_resolved_cases":
                return self._resolved_cases(ResolvedCasesArgs.model_validate(args), plot_id=plot_id)
            if name == "get_external_context":
                return self._external_context(ExternalContextArgs.model_validate(args))
        except (json.JSONDecodeError, ValidationError):
            return ToolResult(name, self._error("invalid_tool_arguments", retryable=False))
        return ToolResult(name, self._error("unknown_tool", retryable=False))

    # --- tools ------------------------------------------------------------------------

    def _env_query(self, args: EnvQueryArgs, *, plot_id: str, language: str) -> ToolResult:
        for variable in args.variables:
            spec = ENV_VARIABLES.get(variable.code)
            if spec is None or variable.aggregation not in spec["aggregations"]:
                return ToolResult("env_query", self._error("variable_or_aggregation_not_allowed", retryable=False))
        query_id = f"q_{uuid4().hex[:16]}"
        body, error = self._request("POST", "/v1/environment/query", json={
            "schema_version": "2.0",
            "query_id": query_id,
            "requested_by": "advisor",
            "target": {"plot_id": plot_id},
            "variables": [v.model_dump() for v in args.variables],
            "window": {"days_back": args.days_back, "end_date": None},
            "compare_to_normal": True,
            "is_demo": True,
        })
        if error:
            return ToolResult("env_query", error, stale=True)
        data_used = DataUsed(
            query_id=body.get("query_id") or query_id,
            summary=env_summary(body, args.days_back, language),
            data_freshness=body.get("data_freshness", "unknown"),
            dataset_ids=body.get("dataset_ids", []),
        )
        return ToolResult("env_query", json.dumps(body, ensure_ascii=False), data_used=data_used,
                          stale=data_used.data_freshness != "fresh")

    def _resolved_cases(self, args: ResolvedCasesArgs, *, plot_id: str) -> ToolResult:
        body, error = self._request("POST", "/v1/resolved-cases/search", json={
            "threat_code": THREAT_CODE,
            "symptoms": args.symptoms,
            "near_plot_id": plot_id,
            "max_distance_km": RESOLVED_CASE_RADIUS_KM,
            "only_verified": False,
            "limit": 5,
        })
        if error:
            return ToolResult("search_resolved_cases", error, stale=True)
        cases = protocol_cases(body)
        return ToolResult("search_resolved_cases", json.dumps({"results": list(cases.values())}, ensure_ascii=False),
                          resolved_cases=cases)

    def _external_context(self, args: ExternalContextArgs) -> ToolResult:
        body, error = self._request("GET", "/v1/external-context", params={
            "region": args.region, "threat_code": THREAT_CODE, "limit": EXTERNAL_CONTEXT_ITEMS,
        })
        if error:
            return ToolResult("get_external_context", error, stale=True)
        items = [
            {"source_id": item.get("source_id"), "title": item.get("title"),
             "content": (item.get("content") or "")[:EXTERNAL_CONTEXT_CHARS]}
            for item in body.get("items", [])
        ]
        return ToolResult("get_external_context", json.dumps({"items": items}, ensure_ascii=False),
                          source_ids=[item["source_id"] for item in items if item["source_id"]])

    # --- HTTP ---------------------------------------------------------------------------

    def _request(self, method: str, path: str, **kwargs: Any) -> tuple[dict[str, Any], str | None]:
        try:
            response = httpx.request(method, f"{self.base_url}{path}", timeout=self.timeout_seconds, **kwargs)
            response.raise_for_status()
            return response.json(), None
        except httpx.TimeoutException:
            return {}, self._error("dependency_timeout", retryable=True)
        except httpx.HTTPStatusError as exc:
            return {}, self._error(f"dependency_http_{exc.response.status_code}", retryable=exc.response.status_code >= 500)
        except (httpx.HTTPError, ValueError):
            return {}, self._error("dependency_unavailable", retryable=True)

    @staticmethod
    def _error(code: str, *, retryable: bool) -> str:
        return json.dumps({"error": {"code": code, "retryable": retryable}}, ensure_ascii=False)


def protocol_cases(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Keeps only cases solved with protocol practices, without free text.

    A testimony with a product or dose (matches_protocol false) never reaches the model,
    and neither does solution_summary: the spoken mention is built from solution codes.
    """
    cases: dict[str, dict[str, Any]] = {}
    for item in body.get("results", []):
        codes = [code for code in item.get("solution_codes") or [] if code in PRACTICES]
        if item.get("matches_protocol") is not True or not codes or not item.get("resolution_id"):
            continue
        cases[item["resolution_id"]] = {
            "resolution_id": item["resolution_id"],
            "similarity": item.get("similarity"),
            "distance_band": item.get("distance_band"),
            "days_to_resolution": item.get("days_to_resolution"),
            "solution_codes": codes,
            "verification": item.get("verification"),
        }
    return cases


def env_summary(body: dict[str, Any], days_back: int, language: str) -> str:
    """Plain summary of a query for the dashboard, in the call language. Null is never zero."""
    lang = normalize_language(language)
    parts = []
    for result in body.get("results", []):
        spec = ENV_VARIABLES.get(result.get("code"), {})
        label = f"{_AGGREGATION_WORDS[lang].get(result.get('aggregation'), result.get('aggregation'))} {spec.get(lang, result.get('code'))}"
        unit = result.get("unit") or spec.get("unit", "")
        if result.get("value") is None:
            parts.append(f"{label}: {'no data' if lang == 'en' else 'sin datos'}")
            continue
        text = f"{label} {result['value']:g} {unit}"
        if result.get("normal") is not None:
            text += f" ({'normal' if lang == 'en' else 'normal'} {result['normal']:g} {unit})"
        parts.append(text)
    window = f"last {days_back} days" if lang == "en" else f"últimos {days_back} días"
    where = ""
    if body.get("distance_km") is not None:
        where = (f", grid cell {body['distance_km']:g} km away" if lang == "en"
                 else f", celda a {body['distance_km']:g} km")
    return f"{'; '.join(parts) or ('no data' if lang == 'en' else 'sin datos')} ({window}{where})"
