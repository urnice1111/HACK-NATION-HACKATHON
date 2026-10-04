"""Puente HTTP del backend principal al asesor (responsabilidad dev 2).

Comunicaciones consume siempre ``POST /v1/assessments`` en este backend. El
adaptador conserva los contratos compartidos y deja la implementación del modelo
encapsulada en ``advisor``.
"""

import logging

from fastapi import APIRouter, Depends
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from advisor.app import build_assessor
from advisor.contracts import AssessmentRequest as AdvisorAssessmentRequest
from advisor.openai_adapter import AssessmentGenerationError
from backend.app.db import get_conn
from backend.app.errors import ApiError
from contracts.models import AssessmentRequest, AssessmentResponse

router = APIRouter(prefix="/v1/assessments", tags=["assessments"])
log = logging.getLogger("api.assessments")


@router.post("", response_model=AssessmentResponse)
def assess_observation(body: AssessmentRequest, conn: Connection = Depends(get_conn)) -> AssessmentResponse:
    """Evalúa la observación, persiste la fila y devuelve necesidades u orientación."""
    try:
        advisor_request = AdvisorAssessmentRequest.model_validate(body.model_dump(mode="json"))
        assessment = build_assessor().assess(advisor_request)
        response = AssessmentResponse.model_validate(assessment.model_dump(mode="json"))
    except ValidationError as exc:
        details = [{"field": ".".join(str(p) for p in e["loc"]), "reason": e["type"]} for e in exc.errors()]
        raise ApiError(422, "La evaluación no superó la validación", code="ASSESSMENT_VALIDATION_ERROR",
                       details=details) from exc
    except AssessmentGenerationError as exc:
        raise ApiError(503, str(exc), code="ASSESSMENT_UNAVAILABLE", retryable=True) from exc

    persist_assessment(conn, body, response)
    return response


def persist_assessment(conn: Connection, request: AssessmentRequest, assessment: AssessmentResponse) -> None:
    """Guarda la evaluación con el id que comunicaciones reenvía en POST /v1/reports."""
    resolved_ids = [mention.resolution_id for mention in assessment.resolved_case_mentions]
    try:
        conn.execute(
            """
            insert into public.assessments (
              id, is_demo, session_id, plot_id, disposition, suspected_issue,
              evidence_quality, urgency, information_needs, data_used, resolved_case_ids,
              recommendations, human_review_required, source_ids, model_version, protocol_version
            ) values (
              %(id)s, %(is_demo)s, %(session_id)s, %(plot_id)s, %(disposition)s, %(suspected_issue)s,
              %(evidence_quality)s, %(urgency)s, %(information_needs)s, %(data_used)s, %(resolved_case_ids)s,
              %(recommendations)s, %(human_review_required)s, %(source_ids)s, %(model_version)s, %(protocol_version)s
            )
            """,
            {
                "id": assessment.assessment_id,
                "is_demo": request.is_demo,
                "session_id": request.session_id,
                "plot_id": request.plot_id,
                "disposition": assessment.disposition,
                "suspected_issue": Jsonb(assessment.suspected_issue.model_dump(mode="json"))
                if assessment.suspected_issue else None,
                "evidence_quality": assessment.evidence_quality,
                "urgency": assessment.urgency,
                "information_needs": Jsonb([need.model_dump(mode="json") for need in assessment.information_needs]),
                "data_used": Jsonb([item.model_dump(mode="json") for item in assessment.data_used]),
                "resolved_case_ids": resolved_ids,
                "recommendations": Jsonb([item.model_dump(mode="json") for item in assessment.recommendations]),
                "human_review_required": assessment.human_review_required,
                "source_ids": assessment.source_ids,
                "model_version": assessment.model_version,
                "protocol_version": assessment.protocol_version,
            },
        )
    except Exception as exc:
        log.exception("failed to persist assessment %s", assessment.assessment_id)
        raise ApiError(
            503,
            "No se pudo guardar la evaluación",
            code="ASSESSMENT_UNAVAILABLE",
            retryable=True,
        ) from exc
