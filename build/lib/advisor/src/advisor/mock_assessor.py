"""Deterministic response for local integration without a key or external dependencies."""

from __future__ import annotations

from uuid import uuid4

from .catalog import ISSUES, PRACTICES, PROTOCOL_VERSION, need_definition, normalize_language
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
from .openai_adapter import MODEL_SNAPSHOT

PRODUCT_WORDS = ("fungicida", "producto", "dosis", "pesticida", "fungicide", "product", "dose", "pesticide", "chemical")
MOCK_DATA_USED = {
    "en": "Mock: recent humidity and rain looked up",
    "es": "Mock: humedad y lluvia recientes consultadas",
}


class MockAssessor:
    def assess(self, request: AssessmentRequest) -> AssessmentResponse:
        language = normalize_language(request.language)
        statement = (request.observation.user_statement or "").lower()
        answered = {answer.need_code for answer in request.observation.answers}
        data_used = [{"query_id": "q_mock_env_01", "summary": MOCK_DATA_USED[language], "data_freshness": "fresh",
                      "dataset_ids": ["dataset_mock_env"]}]
        base = {
            "assessment_id": f"assessment_mock_{uuid4().hex}",
            "model_version": f"mock:{MODEL_SNAPSHOT}",
            "protocol_version": PROTOCOL_VERSION,
        }
        if any(word in statement for word in PRODUCT_WORDS):
            return AssessmentResponse(
                **base,
                disposition=Disposition.refer,
                evidence_quality=EvidenceQuality.low,
                urgency=Urgency.soon,
                human_review_required=True,
            )
        if "leaf_underside" not in answered:
            return AssessmentResponse(
                **base,
                disposition=Disposition.ask_more,
                evidence_quality=EvidenceQuality.insufficient,
                urgency=Urgency.unknown,
                information_needs=[need_definition("leaf_underside", language, priority=1),
                                   need_definition("affected_extent", language, priority=2)],
                data_used=data_used,
            )
        mentions = []
        match = (request.plot_context or {}).get("resolved_case_match")
        if isinstance(match, dict):
            mentions.append(ResolvedCaseMention(
                resolution_id=str(match.get("resolution_id", "resolution_mock_01")),
                summary_for_speech=str(match.get("summary_for_speech", "A farmer in the area said cultural practices helped")),
                verification=str(match.get("verification", "verified")),
            ))
        return AssessmentResponse(
            **base,
            disposition=Disposition.advise,
            suspected_issue=SuspectedIssue(code="coffee_leaf_rust", label=ISSUES["coffee_leaf_rust"][language]),
            evidence_quality=EvidenceQuality.medium,
            urgency=Urgency.soon,
            recommendations=[
                Recommendation(code=code, text=PRACTICES[code][language]["text"], protocol_id=PROTOCOL_VERSION)
                for code in ("remove_affected_leaves", "monitor_neighbor_plants")
            ],
            resolved_case_mentions=mentions,
            data_used=data_used,
        )
