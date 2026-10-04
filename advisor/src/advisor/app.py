"""FastAPI app the backend can mount or deploy separately."""

import os

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .contracts import AssessmentRequest, AssessmentResponse
from .openai_adapter import AssessmentGenerationError, OpenAIAssessor
from .mock_assessor import MockAssessor
from .anthropic_adapter import AnthropicAssessor

app = FastAPI(title="Coffee advisor", version="0.2.0")


def build_assessor() -> OpenAIAssessor | AnthropicAssessor | MockAssessor:
    """ADVISOR_MODE=mock for a stable answer without a model; ADVISOR_PROVIDER picks openai or anthropic."""
    if os.getenv("ADVISOR_MODE", "openai") == "mock":
        return MockAssessor()
    return AnthropicAssessor() if os.getenv("ADVISOR_PROVIDER", "openai") == "anthropic" else OpenAIAssessor()


@app.post("/v1/assessments", response_model=AssessmentResponse)
def assess_observation(request: AssessmentRequest):
    try:
        return build_assessor().assess(request)
    except AssessmentGenerationError as exc:
        # Uniform error (INSTRUCTIONS.md §8); never made-up guidance.
        return JSONResponse(status_code=503, content={"error": {
            "code": "ASSESSMENT_UNAVAILABLE", "message": str(exc), "retryable": True, "details": [],
        }})
