"""Aplicación FastAPI que el backend puede montar o desplegar por separado."""

import os

from fastapi import FastAPI, HTTPException

from .contracts import AssessmentRequest, AssessmentResponse
from .openai_adapter import AssessmentGenerationError, OpenAIAssessor
from .mock_assessor import MockAssessor

app = FastAPI(title="Coffee advisor", version="0.1.0")


def build_assessor() -> OpenAIAssessor | MockAssessor:
    return MockAssessor() if os.getenv("ADVISOR_MODE", "openai") == "mock" else OpenAIAssessor()


@app.post("/v1/assessments", response_model=AssessmentResponse)
def assess_observation(request: AssessmentRequest) -> AssessmentResponse:
    try:
        return build_assessor().assess(request)
    except AssessmentGenerationError as exc:
        raise HTTPException(status_code=503, detail={"code": "ASSESSMENT_UNAVAILABLE", "message": str(exc), "retryable": True}) from exc
