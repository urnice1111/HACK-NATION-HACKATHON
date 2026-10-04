"""Puente HTTP del backend principal al asesor (responsabilidad dev 2).

Comunicaciones consume siempre ``POST /v1/assessments`` en este backend. El
adaptador conserva los contratos compartidos y deja la implementación del modelo
encapsulada en ``advisor``. Cada evaluación se guarda en ``public.assessments``
con ``id = assessment_id``: comunicaciones manda ese id en ``POST /v1/reports`` y
``GET /v1/followups`` lo usa para ``guidance_given``.
"""

import logging

from fastapi import APIRouter
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from advisor.app import build_assessor
from advisor.contracts import AssessmentRequest as AdvisorAssessmentRequest
from advisor.openai_adapter import AssessmentGenerationError
from backend.app.db import pool
from backend.app.errors import ApiError
from contracts.models import AssessmentRequest, AssessmentResponse

router = APIRouter(prefix="/v1/assessments", tags=["assessments"])
log = logging.getLogger("api.assessments")


@router.post("", response_model=AssessmentResponse)
def assess_observation(body: AssessmentRequest) -> AssessmentResponse:
    """Evalúa la observación y devuelve necesidades u orientación estructurada."""
    try:
        advisor_request = AdvisorAssessmentRequest.model_validate(body.model_dump(mode="json"))
        assessment = build_assessor().assess(advisor_request)
        # Revalidar también contra el contrato que consumen los otros integrantes.
        response = AssessmentResponse.model_validate(assessment.model_dump(mode="json"))
    except ValidationError as exc:
        raise ApiError(422, "La evaluación no cumple el contrato", code="ASSESSMENT_VALIDATION_ERROR",
                       details=[{"field": ".".join(str(p) for p in e["loc"]), "reason": e["type"]} for e in exc.errors()]) from exc
    except AssessmentGenerationError as exc:
        raise ApiError(503, str(exc), code="ASSESSMENT_UNAVAILABLE", retryable=True) from exc
    save_assessment(body, response)
    return response


def save_assessment(body: AssessmentRequest, response: AssessmentResponse) -> None:
    """Guarda la evaluación; report_id queda null hasta que POST /v1/reports la enlaza por assessment_id.

    Un fallo al guardar no descarta una orientación ya validada: se registra y se responde igual.
    La conexión se pide solo para el insert, no durante la llamada al modelo.
    """
    data = response.model_dump(mode="json")
    try:
        with pool.connection(timeout=2) as conn:
            conn.execute(
                """
                insert into public.assessments
                  (id, is_demo, session_id, plot_id, disposition, suspected_issue, evidence_quality, urgency,
                   information_needs, data_used, resolved_case_ids, recommendations, human_review_required,
                   source_ids, model_version, protocol_version)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    response.assessment_id, body.is_demo, body.session_id, body.plot_id, data["disposition"],
                    Jsonb(data["suspected_issue"]) if data["suspected_issue"] else None,
                    data["evidence_quality"], data["urgency"], Jsonb(data["information_needs"]),
                    Jsonb(data["data_used"]), [m["resolution_id"] for m in data["resolved_case_mentions"]],
                    Jsonb(data["recommendations"]), data["human_review_required"], data["source_ids"],
                    data["model_version"], data["protocol_version"],
                ),
            )
    except Exception:
        log.exception("assessment %s could not be saved", response.assessment_id)
