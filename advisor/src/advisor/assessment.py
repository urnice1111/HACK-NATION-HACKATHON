"""Provider-neutral turn: plan the internal queries, run them in parallel, let the model decide, check it.

Latency budget (INSTRUCTIONS.md §12, §17): communications waits 4 s per SMS step and 8 s per
voice step, so a turn is at most two model calls plus up to three parallel internal queries
of 2 s each. The model only picks codes; every text the farmer hears comes from the
localized catalogs, and everything factual (queries, cases, sources) comes from the real
tool responses. Each provider adapter implements only ``_plan_calls`` and ``_decide``.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from .catalog import (
    ISSUE_CODES,
    ISSUES,
    NEED_CODES,
    PRACTICE_CODES,
    PRACTICES,
    PROTOCOL_VERSION,
    need_definition,
    normalize_language,
    resolved_case_speech,
)
from .contracts import (
    AssessmentRequest,
    AssessmentResponse,
    Disposition,
    EvidenceQuality,
    Recommendation,
    ResolvedCaseMention,
    SuspectedIssue,
    Urgency,
)
from .tools import MAX_INTERNAL_QUERIES, AdvisorToolGateway, ToolResult

# Per call: at most 5 questions to the farmer, and 2 new needs per turn.
MAX_FARMER_QUESTIONS = 5
MAX_NEEDS_PER_TURN = 2

log = logging.getLogger("advisor")


class AssessmentGenerationError(RuntimeError):
    """The endpoint degrades safely; it never returns made-up guidance."""


class NeedChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    need_code: Literal[NEED_CODES]  # type: ignore[valid-type]
    reason: str


class ModelDraft(BaseModel):
    """What the model decides. Codes only, plus one contextual sentence per need."""

    model_config = ConfigDict(extra="forbid")
    disposition: Disposition
    suspected_issue_code: Literal[ISSUE_CODES] | None  # type: ignore[valid-type]
    evidence_quality: EvidenceQuality
    urgency: Urgency
    information_needs: list[NeedChoice] = Field(default_factory=list)
    recommendation_codes: list[Literal[PRACTICE_CODES]] = Field(default_factory=list)  # type: ignore[valid-type]
    resolved_case_ids: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)
    human_review_required: bool


class TwoStepAssessor:
    """One planning call (optional), parallel internal queries, one structured decision call."""

    def __init__(self, model: str, gateway: AdvisorToolGateway | None, planner: str) -> None:
        self._model = model
        self._gateway = gateway or AdvisorToolGateway.from_environment()
        # "model": the model picks the queries (one extra call); "fixed": the default queries.
        self._planner = planner

    def _require_credentials(self) -> None:
        raise NotImplementedError

    def _plan_calls(self, turn_input: dict) -> list[tuple[str, str]] | None:
        """(tool name, JSON arguments) chosen by the model, or None to use the default queries."""
        raise NotImplementedError

    def _decide(self, language: str, payload: dict) -> ModelDraft:
        raise NotImplementedError

    def assess(self, request: AssessmentRequest) -> AssessmentResponse:
        self._require_credentials()
        started_at = time.monotonic()
        language = normalize_language(request.language)
        already_asked = sorted(set(request.asked_need_codes) | {a.need_code for a in request.observation.answers})
        questions_remaining = max(0, MAX_FARMER_QUESTIONS - len(already_asked))
        turn_input = {
            "request": request.model_dump(mode="json"),
            "already_asked": already_asked,
            "questions_remaining": questions_remaining,
        }

        calls = (self._plan_calls(turn_input) if self._planner != "fixed" else None) or default_queries(request)
        planned_at = time.monotonic()
        results = self._gateway.execute_many(calls[:MAX_INTERNAL_QUERIES], plot_id=request.plot_id, language=language)
        queried_at = time.monotonic()
        draft = self._decide(language, {**turn_input, "internal_data": [
            {"tool": result.name, "result": json.loads(result.output)} for result in results
        ]})
        response = build_response(draft, request, results, language, questions_remaining, self._model)
        log.info(
            "assessment %s disposition=%s queries=%s plan_ms=%d tools_ms=%d decide_ms=%d total_ms=%d model=%s",
            response.assessment_id, response.disposition, [r.name for r in results],
            (planned_at - started_at) * 1000, (queried_at - planned_at) * 1000,
            (time.monotonic() - queried_at) * 1000, (time.monotonic() - started_at) * 1000, self._model,
        )
        return response


def build_response(
    draft: ModelDraft,
    request: AssessmentRequest,
    results: list[ToolResult],
    language: str,
    questions_remaining: int,
    model_version: str,
) -> AssessmentResponse:
    """Server-side assembly and domain rules: localized catalog text, only verified facts."""
    already_asked = set(request.asked_need_codes) | {a.need_code for a in request.observation.answers}
    disposition = draft.disposition
    human_review = draft.human_review_required

    needs = []
    if disposition == Disposition.ask_more:
        seen: set[str] = set()
        for need in draft.information_needs:
            if need.need_code in already_asked or need.need_code in seen:
                continue  # never ask again what the farmer already answered
            seen.add(need.need_code)
            needs.append(need)
        needs = needs[: min(MAX_NEEDS_PER_TURN, questions_remaining)]
        if not needs:
            if questions_remaining > 0:
                raise AssessmentGenerationError("ask_more without any new need from the catalog")
            # Question limit reached: an agronomist takes over (§17), no guidance is made up.
            disposition, human_review = Disposition.refer, True

    recommendations = []
    source_ids: list[str] = []
    if disposition != Disposition.ask_more:
        available_sources = {source for result in results for source in result.source_ids}
        source_ids = [s for s in dict.fromkeys(draft.source_ids) if s in available_sources]
        recommendations = [
            Recommendation(code=code, text=PRACTICES[code][language]["text"], protocol_id=PROTOCOL_VERSION,
                           source_ids=source_ids)
            for code in dict.fromkeys(draft.recommendation_codes)
        ]
        if disposition == Disposition.advise and not recommendations:
            raise AssessmentGenerationError("advise without any protocol recommendation")
    if disposition == Disposition.refer:
        human_review = True

    mentions = []
    if disposition == Disposition.advise:
        cases = {cid: case for result in results for cid, case in result.resolved_cases.items()}
        for case_id in draft.resolved_case_ids:
            case = cases.get(case_id)
            speech = case and resolved_case_speech(case["solution_codes"], case.get("distance_band"), language)
            if speech and case.get("verification") in ("verified", "farmer_reported"):
                mentions.append(ResolvedCaseMention(resolution_id=case_id, summary_for_speech=speech,
                                                    verification=case["verification"]))
                break  # one mention per turn

    issue = None
    if draft.suspected_issue_code and disposition != Disposition.ask_more:
        issue = SuspectedIssue(code=draft.suspected_issue_code, label=ISSUES[draft.suspected_issue_code][language])

    return AssessmentResponse(
        assessment_id=f"assessment_{uuid4().hex}",
        disposition=disposition,
        suspected_issue=issue,
        evidence_quality=draft.evidence_quality,
        urgency=draft.urgency,
        information_needs=[
            need_definition(need.need_code, language, reason=need.reason.strip() or None, priority=index + 1)
            for index, need in enumerate(needs)
        ],
        data_used=[result.data_used for result in results if result.data_used is not None],
        resolved_case_mentions=mentions,
        recommendations=recommendations,
        human_review_required=human_review,
        source_ids=source_ids,
        context_stale=any(result.stale for result in results) or not results,
        model_version=model_version,
        protocol_version=PROTOCOL_VERSION,
    )


def default_queries(request: AssessmentRequest) -> list[tuple[str, str]]:
    """The three lookups a leaf-spot report needs, without asking the model."""
    observation = request.observation
    symptoms = [*observation.symptoms, observation.user_statement,
                "yellow spots on leaves", "manchas amarillas en hojas",
                "orange powder under leaves", "polvo naranja en el envés"]
    return [
        ("env_query", json.dumps({"variables": [
            {"code": "humidity_pct", "aggregation": "mean"},
            {"code": "precip_mm", "aggregation": "sum"},
            {"code": "temp_mean_c", "aggregation": "mean"},
        ], "days_back": 14})),
        ("search_resolved_cases", json.dumps({"symptoms": [s for s in symptoms if s][:10]})),
        ("get_external_context", json.dumps({"region": "Veracruz"})),
    ]
