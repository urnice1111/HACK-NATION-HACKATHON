"""OpenAI adapter: Function Calling to plan the internal queries, Structured Outputs to decide."""

from __future__ import annotations

import json
import os

from openai import OpenAI, OpenAIError
from pydantic import ValidationError

# Re-exported: the backend bridge and tests import them from here.
from .assessment import (  # noqa: F401
    AssessmentGenerationError,
    ModelDraft,
    NeedChoice,
    TwoStepAssessor,
    build_response,
    default_queries,
    log,
)
from .prompt import build_planner_prompt, build_system_prompt
from .tools import MAX_INTERNAL_QUERIES, TOOL_DEFINITIONS, AdvisorToolGateway

MODEL_SNAPSHOT = "gpt-4.1-mini-2025-04-14"
PLANNER_TIMEOUT_SECONDS = 2.5
DECISION_TIMEOUT_SECONDS = 4.0
PLANNER_MAX_OUTPUT_TOKENS = 300
DECISION_MAX_OUTPUT_TOKENS = 350


class OpenAIAssessor(TwoStepAssessor):
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        gateway: AdvisorToolGateway | None = None,
        planner: str | None = None,
    ) -> None:
        super().__init__(model or os.getenv("ADVISOR_MODEL", MODEL_SNAPSHOT), gateway,
                         planner or os.getenv("ADVISOR_PLANNER", "model"))
        self._api_key = api_key if api_key is not None else os.getenv("OPENAI_API_KEY")

    def _require_credentials(self) -> None:
        if not self._api_key:
            raise AssessmentGenerationError("OPENAI_API_KEY is not configured on the server")

    @property
    def _client(self) -> OpenAI:
        return OpenAI(api_key=self._api_key, max_retries=0)

    def _plan_calls(self, turn_input: dict) -> list[tuple[str, str]] | None:
        try:
            planned = self._client.responses.create(
                model=self._model,
                instructions=build_planner_prompt(),
                input=json.dumps(turn_input, ensure_ascii=False),
                tools=TOOL_DEFINITIONS,
                tool_choice="required",
                parallel_tool_calls=True,
                temperature=0,
                max_output_tokens=PLANNER_MAX_OUTPUT_TOKENS,
                store=False,
                timeout=PLANNER_TIMEOUT_SECONDS,
            )
        except OpenAIError as exc:
            # Planning is an optimization: the default queries still consult before asking.
            log.warning("planner failed (%s); using default queries", type(exc).__name__)
            return None
        calls = [(item.name, item.arguments) for item in planned.output if item.type == "function_call"]
        return calls[:MAX_INTERNAL_QUERIES] or None

    def _decide(self, language: str, payload: dict) -> ModelDraft:
        try:
            final = self._client.responses.parse(
                model=self._model,
                instructions=build_system_prompt(language),
                input=json.dumps(payload, ensure_ascii=False),
                text_format=ModelDraft,
                temperature=0,
                max_output_tokens=DECISION_MAX_OUTPUT_TOKENS,
                store=False,
                timeout=DECISION_TIMEOUT_SECONDS,
            )
        except OpenAIError as exc:
            raise AssessmentGenerationError("The language model is temporarily unavailable") from exc
        if final.output_parsed is None:
            raise AssessmentGenerationError("The language model did not produce a usable structured output")
        try:
            return ModelDraft.model_validate(final.output_parsed)
        except ValidationError as exc:
            raise AssessmentGenerationError("The structured output failed validation") from exc
