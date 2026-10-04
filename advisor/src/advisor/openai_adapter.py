"""Orquestador OpenAI: Function Calling interno y Structured Outputs final."""

from __future__ import annotations

import json
import os
import time
from types import SimpleNamespace
from uuid import uuid4

from openai import APIError, OpenAI
from pydantic import ValidationError

from .catalog import MODEL_SNAPSHOT, NEED_CATALOG, PROTOCOL_VERSION
from .contracts import AssessmentDraft, AssessmentRequest, AssessmentResponse
from .env import load_dotenv
from .evidence import data_used_from_queries, mentions_from_search
from .prompt import build_system_prompt
from .tools import AdvisorToolGateway, TOOL_DEFINITIONS

MAX_INTERNAL_QUERIES = 3
TURN_BUDGET_SECONDS = 5.0
DEFAULT_MAX_TOKENS = 700


class AssessmentGenerationError(RuntimeError):
    """El endpoint degrada de forma segura; nunca devuelve consejo inventado."""


class OpenAIAssessor:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        gateway: AdvisorToolGateway | None = None,
        max_tokens: int | None = None,
    ) -> None:
        load_dotenv()
        self._api_key = (api_key or os.getenv("OPENAI_API_KEY") or "").strip() or None
        self._model = model or os.getenv("ADVISOR_MODEL", MODEL_SNAPSHOT)
        self._max_tokens = max_tokens if max_tokens is not None else int(os.getenv("ADVISOR_MAX_TOKENS", str(DEFAULT_MAX_TOKENS)))
        self._gateway = gateway or AdvisorToolGateway.from_environment()

    def assess(self, request: AssessmentRequest) -> AssessmentResponse:
        if not self._api_key:
            raise AssessmentGenerationError("OPENAI_API_KEY no está configurada en el servidor")

        client = OpenAI(api_key=self._api_key, timeout=TURN_BUDGET_SECONDS)
        started_at = time.monotonic()
        context_stale = False
        used_queries = 0
        prefetch = self._prefetch(request, started_at)
        used_queries += prefetch["count"]
        transcript: list[object] = [
            {"role": "system", "content": build_system_prompt()},
            {"role": "user", "content": json.dumps(request.model_dump(mode="json"), ensure_ascii=False)},
        ]
        if prefetch["note"]:
            transcript.append({"role": "developer", "content": prefetch["note"]})

        for _ in range(MAX_INTERNAL_QUERIES):
            if time.monotonic() - started_at >= TURN_BUDGET_SECONDS:
                context_stale = True
                transcript.append({"role": "developer", "content": "Se agotó el tiempo. Finaliza declarando contexto insuficiente."})
                break
            remaining = MAX_INTERNAL_QUERIES - used_queries
            if remaining <= 0:
                break
            try:
                response = client.responses.create(
                    model=self._model,
                    input=transcript,
                    tools=TOOL_DEFINITIONS,
                    max_output_tokens=self._max_tokens,
                )
            except APIError as exc:
                raise AssessmentGenerationError("OpenAI no está disponible temporalmente") from exc
            calls = [item for item in response.output if item.type == "function_call"]
            if not calls:
                break
            transcript.extend(response.output)
            batch = calls[:remaining]
            if len(calls) > len(batch):
                context_stale = True
            outputs = self._gateway.execute_many(
                batch, plot_id=request.plot_id, started_at=started_at, is_demo=request.is_demo
            )
            used_queries += len(batch)
            for call_id, output in outputs:
                transcript.append({"type": "function_call_output", "call_id": call_id, "output": output})
            if self._gateway.budget_exhausted:
                context_stale = True
                transcript.append({"role": "developer", "content": "Se agotó el tiempo. Finaliza declarando contexto insuficiente."})
                break

        try:
            final = client.responses.parse(
                model=self._model,
                input=transcript,
                text_format=AssessmentDraft,
                max_output_tokens=self._max_tokens,
            )
            draft = final.output_parsed
            if draft is None:
                raise AssessmentGenerationError("OpenAI no produjo una salida estructurada utilizable")
            draft = AssessmentDraft.model_validate(draft)
        except ValidationError as exc:
            raise AssessmentGenerationError("La salida estructurada no superó la validación") from exc
        except APIError as exc:
            raise AssessmentGenerationError("OpenAI no está disponible temporalmente") from exc

        self._validate_domain_rules(draft, request)
        # El modelo decide qué falta y el orden; el texto que verá voz siempre es canónico.
        draft.information_needs = [NEED_CATALOG[need.need_code] for need in draft.information_needs]
        draft.data_used = data_used_from_queries(self._gateway.env_queries)
        draft.resolved_case_mentions = mentions_from_search(
            self._gateway.resolved_cases,
            draft.resolved_case_mentions,
            draft.disposition,
        )
        draft.context_stale = draft.context_stale or context_stale or self._gateway.budget_exhausted
        return AssessmentResponse(
            **draft.model_dump(),
            assessment_id=f"assessment_{uuid4().hex}",
            model_version=self._model,
            protocol_version=PROTOCOL_VERSION,
        )

    def _prefetch(self, request: AssessmentRequest, started_at: float) -> dict[str, object]:
        """Consulta env y casos resueltos antes del modelo: la demo no depende de que los pida."""
        symptoms = list(request.observation.symptoms) or [request.observation.user_statement]
        calls = [
            SimpleNamespace(
                call_id="prefetch_env",
                name="env_query",
                arguments=json.dumps({
                    "variables": [
                        {"code": "humidity_pct", "aggregation": "mean"},
                        {"code": "precip_mm", "aggregation": "sum"},
                    ],
                    "days_back": 14,
                    "compare_to_normal": True,
                }),
            ),
            SimpleNamespace(
                call_id="prefetch_cases",
                name="search_resolved_cases",
                arguments=json.dumps({"symptoms": symptoms[:10], "limit": 3}),
            ),
        ]
        outputs = self._gateway.execute_many(
            calls, plot_id=request.plot_id, started_at=started_at, is_demo=request.is_demo
        )
        chunks = [f"{name}: {output}" for (_, output), name in zip(outputs, ("env_query", "search_resolved_cases"))]
        note = (
            "Datos ya consultados (no los vuelvas a pedir; no inventes valores):\n"
            + "\n".join(chunks)
            + "\nPuedes llamar get_external_context si aporta. Pregunta al agricultor solo lo que falte."
        )
        return {"count": len(outputs), "note": note}

    @staticmethod
    def _validate_domain_rules(draft: AssessmentDraft, request: AssessmentRequest) -> None:
        requested_codes = [need.need_code for need in draft.information_needs]
        unknown_codes = set(requested_codes) - set(NEED_CATALOG)
        repeated_codes = {code for code in requested_codes if requested_codes.count(code) > 1}
        if unknown_codes or repeated_codes:
            raise AssessmentGenerationError("El modelo propuso necesidades fuera del catálogo o repetidas")
        if set(requested_codes) & set(request.asked_need_codes):
            raise AssessmentGenerationError("El modelo volvió a pedir una necesidad ya respondida")
        if draft.disposition.value == "ask_more" and not draft.information_needs:
            raise AssessmentGenerationError("ask_more requiere al menos una necesidad")
        if draft.disposition.value != "ask_more" and draft.information_needs:
            raise AssessmentGenerationError("advise o refer no deben incluir nuevas necesidades")
        for recommendation in draft.recommendations:
            if recommendation.protocol_id != PROTOCOL_VERSION:
                raise AssessmentGenerationError("La recomendación no pertenece al protocolo aprobado")
