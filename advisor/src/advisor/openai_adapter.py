"""Orquestador OpenAI: Function Calling interno y Structured Outputs final."""

from __future__ import annotations

import json
import os
import time
from uuid import uuid4

from openai import APIError, OpenAI
from pydantic import ValidationError

from .catalog import NEED_CATALOG, PROTOCOL_VERSION
from .contracts import AssessmentDraft, AssessmentRequest, AssessmentResponse
from .prompt import build_system_prompt
from .tools import AdvisorToolGateway, TOOL_DEFINITIONS

MODEL_SNAPSHOT = "gpt-4.1-mini-2025-04-14"
MAX_INTERNAL_QUERIES = 3


class AssessmentGenerationError(RuntimeError):
    """El endpoint degrada de forma segura; nunca devuelve consejo inventado."""


class OpenAIAssessor:
    def __init__(
        self,
        api_key: str | None = None,
        model: str = MODEL_SNAPSHOT,
        gateway: AdvisorToolGateway | None = None,
    ) -> None:
        self._api_key = api_key or os.getenv("OPENAI_API_KEY")
        self._model = model
        self._gateway = gateway or AdvisorToolGateway.from_environment()

    def assess(self, request: AssessmentRequest) -> AssessmentResponse:
        if not self._api_key:
            raise AssessmentGenerationError("OPENAI_API_KEY no está configurada en el servidor")

        client = OpenAI(api_key=self._api_key, timeout=5.0)
        started_at = time.monotonic()
        transcript: list[object] = [
            {"role": "system", "content": build_system_prompt()},
            {"role": "user", "content": json.dumps(request.model_dump(mode="json"), ensure_ascii=False)},
        ]

        for _ in range(MAX_INTERNAL_QUERIES):
            if time.monotonic() - started_at >= 5.0:
                transcript.append({"role": "developer", "content": "Se agotó el tiempo. Finaliza declarando contexto insuficiente."})
                break
            try:
                response = client.responses.create(model=self._model, input=transcript, tools=TOOL_DEFINITIONS)
            except APIError as exc:
                raise AssessmentGenerationError("OpenAI no está disponible temporalmente") from exc
            calls = [item for item in response.output if item.type == "function_call"]
            if not calls:
                break
            transcript.extend(response.output)
            # Una por vuelta: el límite de tres consultas es verificable y trazable.
            call = calls[0]
            output = self._gateway.execute(call.name, call.arguments, plot_id=request.plot_id, started_at=started_at)
            transcript.append({"type": "function_call_output", "call_id": call.call_id, "output": output})
        else:
            transcript.append({"role": "developer", "content": "Ya se alcanzó el límite de consultas. Finaliza con los datos disponibles."})

        try:
            final = client.responses.parse(model=self._model, input=transcript, text_format=AssessmentDraft)
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
        return AssessmentResponse(
            **draft.model_dump(),
            assessment_id=f"assessment_{uuid4().hex}",
            model_version=self._model,
            protocol_version=PROTOCOL_VERSION,
        )

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
