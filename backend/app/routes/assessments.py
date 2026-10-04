"""Puente HTTP del backend principal al asesor (responsabilidad dev 2).

Comunicaciones consume siempre ``POST /v1/assessments`` en este backend. El
adaptador conserva los contratos compartidos y deja la implementación del modelo
encapsulada en ``advisor``.
"""

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from advisor.app import build_assessor
from advisor.contracts import AssessmentRequest as AdvisorAssessmentRequest
from advisor.openai_adapter import AssessmentGenerationError
from contracts.models import AssessmentRequest, AssessmentResponse

router = APIRouter(prefix="/v1/assessments", tags=["assessments"])


@router.post("", response_model=AssessmentResponse)
def assess_observation(body: AssessmentRequest) -> AssessmentResponse:
    """Evalúa la observación y devuelve necesidades u orientación estructurada."""
    try:
        advisor_request = AdvisorAssessmentRequest.model_validate(body.model_dump(mode="json"))
        assessment = build_assessor().assess(advisor_request)
        # Revalidar también contra el contrato que consumen los otros integrantes.
        return AssessmentResponse.model_validate(assessment.model_dump(mode="json"))
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"code": "ASSESSMENT_VALIDATION_ERROR", "details": exc.errors()}) from exc
    except AssessmentGenerationError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "ASSESSMENT_UNAVAILABLE", "message": str(exc), "retryable": True},
        ) from exc
