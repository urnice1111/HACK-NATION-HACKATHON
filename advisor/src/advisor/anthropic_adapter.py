"""Claude adapter (INSTRUCTIONS.md §17 allows Claude with tool use as the equivalent of OpenAI).

Same turn as the OpenAI adapter: strict tools to plan the internal queries, Structured
Outputs (``messages.parse``) to decide. Selected with ``ADVISOR_PROVIDER=anthropic``.
"""

from __future__ import annotations

import copy
import json
import os

import anthropic
from pydantic import ValidationError

from .assessment import AssessmentGenerationError, ModelDraft, TwoStepAssessor, log
from .prompt import build_planner_prompt, build_system_prompt
from .tools import MAX_INTERNAL_QUERIES, TOOL_DEFINITIONS, AdvisorToolGateway

# Measured 2026-10-04 against the real backend: Haiku 4.5 answers in ~3.6 s per turn; Opus 5.5 missed the 5 s budget.
DEFAULT_MODEL = "claude-haiku-4-5-20251001"
DEFAULT_EFFORT = "low"
PLANNER_TIMEOUT_SECONDS = float(os.getenv("ADVISOR_PLANNER_TIMEOUT_S", "3.0"))
DECISION_TIMEOUT_SECONDS = float(os.getenv("ADVISOR_DECISION_TIMEOUT_S", "7.0"))  # communications waits up to 10 s
# Room for adaptive thinking at low effort plus the short JSON; the answer itself is ~100 tokens.
PLANNER_MAX_TOKENS = 2048
DECISION_MAX_TOKENS = 4096
# Server-side refusal fallback: a declined request is retried on a model chosen by category.
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}


def _anthropic_tools() -> list[dict]:
    """Same tools as OpenAI, in Messages API shape; array-size limits are enforced server-side instead."""
    tools = []
    for tool in TOOL_DEFINITIONS:
        schema = copy.deepcopy(tool["parameters"])
        for prop in schema["properties"].values():
            prop.pop("maxItems", None)
        tools.append({"name": tool["name"], "description": tool["description"], "strict": True, "input_schema": schema})
    return tools


ANTHROPIC_TOOLS = _anthropic_tools()


class AnthropicAssessor(TwoStepAssessor):
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        gateway: AdvisorToolGateway | None = None,
        planner: str | None = None,
        effort: str | None = None,
    ) -> None:
        super().__init__(model or os.getenv("ADVISOR_MODEL", DEFAULT_MODEL), gateway,
                         planner or os.getenv("ADVISOR_PLANNER", "fixed"))  # env + resolved cases first; "model" lets the model plan
        self._api_key = api_key if api_key is not None else os.getenv("ANTHROPIC_API_KEY")
        self._workspace_id = os.getenv("ANTHROPIC_WORKSPACE_ID")
        self._effort = effort or os.getenv("ADVISOR_EFFORT", DEFAULT_EFFORT)

    def _require_credentials(self) -> None:
        if not self._api_key:
            raise AssessmentGenerationError("ANTHROPIC_API_KEY is not configured on the server")

    @property
    def _client(self) -> anthropic.Anthropic:
        headers = {"anthropic-workspace-id": self._workspace_id} if self._workspace_id else None
        return anthropic.Anthropic(api_key=self._api_key, max_retries=0, default_headers=headers)

    def _options(self) -> dict:
        options: dict = {}
        if not self._model.startswith("claude-haiku"):  # effort is not available on Haiku 4.5
            options["output_config"] = {"effort": self._effort}
        if self._model in FALLBACK_MODELS:
            options["betas"] = [FALLBACK_BETA]
            options["fallbacks"] = "default"
        return options

    def _plan_calls(self, turn_input: dict) -> list[tuple[str, str]] | None:
        try:
            planned = self._client.beta.messages.create(
                model=self._model,
                max_tokens=PLANNER_MAX_TOKENS,
                system=build_planner_prompt(),
                messages=[{"role": "user", "content": json.dumps(turn_input, ensure_ascii=False)}],
                tools=ANTHROPIC_TOOLS,
                tool_choice={"type": "auto"},  # forced tool use is a 400 on Opus 5.5; the prompt asks for the calls
                timeout=PLANNER_TIMEOUT_SECONDS,
                **self._options(),
            )
        except anthropic.APIStatusError as exc:
            log.warning("planner failed (HTTP %s); using default queries", exc.status_code)
            return None
        except anthropic.APIConnectionError as exc:
            # Includes timeouts. Planning is an optimization: the default queries still consult before asking.
            log.warning("planner failed (%s); using default queries", type(exc).__name__)
            return None
        calls = [(block.name, json.dumps(block.input)) for block in planned.content if block.type == "tool_use"]
        return calls[:MAX_INTERNAL_QUERIES] or None

    def _decide(self, language: str, payload: dict) -> ModelDraft:
        try:
            final = self._client.beta.messages.parse(
                model=self._model,
                max_tokens=DECISION_MAX_TOKENS,
                system=build_system_prompt(language),
                messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
                output_format=ModelDraft,
                timeout=DECISION_TIMEOUT_SECONDS,
                **self._options(),
            )
        except anthropic.RateLimitError as exc:
            raise AssessmentGenerationError("The language model is rate limited") from exc
        except anthropic.APIStatusError as exc:
            log.warning("decision failed (HTTP %s)", exc.status_code)
            raise AssessmentGenerationError("The language model is temporarily unavailable") from exc
        except anthropic.APIConnectionError as exc:
            raise AssessmentGenerationError("The language model did not answer in time") from exc
        except ValidationError as exc:
            raise AssessmentGenerationError("The structured output failed validation") from exc
        if final.stop_reason != "end_turn" or final.parsed_output is None:
            raise AssessmentGenerationError(f"The language model stopped without a usable answer ({final.stop_reason})")
        return ModelDraft.model_validate(final.parsed_output)
