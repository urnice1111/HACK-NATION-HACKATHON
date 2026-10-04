"""Respuesta determinista para integración local sin clave ni dependencias externas."""

from __future__ import annotations

from uuid import uuid4

from .catalog import NEED_CATALOG, PROTOCOL_VERSION
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


class MockAssessor:
    def assess(self, request: AssessmentRequest) -> AssessmentResponse:
        statement = request.observation.user_statement.lower()
        answered = {answer.need_code for answer in request.observation.answers}
        base = {
            "assessment_id": f"assessment_mock_{uuid4().hex}",
            "model_version": f"mock:{MODEL_SNAPSHOT}",
            "protocol_version": PROTOCOL_VERSION,
        }
        if any(word in statement for word in ("fungicida", "producto", "dosis", "pesticida")):
            return AssessmentResponse(
                **base,
                disposition=Disposition.refer,
                evidence_quality=EvidenceQuality.low,
                urgency=Urgency.soon,
                human_review_required=True,
            )
        if "leaf_underside" not in answered:
            needs = [NEED_CATALOG["leaf_underside"], NEED_CATALOG["affected_extent"]]
            return AssessmentResponse(
                **base,
                disposition=Disposition.ask_more,
                evidence_quality=EvidenceQuality.insufficient,
                urgency=Urgency.unknown,
                information_needs=needs,
                data_used=[{"query_id": "q_mock_env_01", "summary": "Mock: humedad y lluvia recientes consultadas", "data_freshness": "fresh", "dataset_ids": ["dataset_mock_env"]}],
            )
        mentions = []
        match = request.plot_context.get("resolved_case_match")
        if isinstance(match, dict):
            mentions.append(ResolvedCaseMention(
                resolution_id=str(match.get("resolution_id", "resolution_mock_01")),
                summary_for_speech=str(match.get("summary_for_speech", "Un agricultor de la zona reportó mejora con prácticas culturales.")),
                verification=str(match.get("verification", "verified")),
            ))
        return AssessmentResponse(
            **base,
            disposition=Disposition.advise,
            suspected_issue=SuspectedIssue(code="coffee_leaf_rust", label="Posible roya del café"),
            evidence_quality=EvidenceQuality.medium,
            urgency=Urgency.soon,
            recommendations=[Recommendation(code="remove_affected_leaves", text="Retirar y enterrar hojas afectadas; vigilar plantas vecinas.", protocol_id=PROTOCOL_VERSION)],
            resolved_case_mentions=mentions,
            data_used=[{"query_id": "q_mock_env_01", "summary": "Mock: humedad y lluvia recientes consultadas", "data_freshness": "fresh", "dataset_ids": ["dataset_mock_env"]}],
        )
