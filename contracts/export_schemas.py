"""Writes JSON Schema files to contracts/schemas/ so non-Python consumers can validate.

Run: python -m contracts.export_schemas
"""

import json
from pathlib import Path

from contracts import models

EXPORTED = [
    models.ErrorResponse,
    models.ContactResolutionRequest,
    models.ContactResolutionResponse,
    models.ContactConfirmRequest,
    models.ContactConfirmResponse,
    models.PlotContext,
    models.AssessmentRequest,
    models.AssessmentResponse,
    models.EnvQueryRequest,
    models.EnvQueryResponse,
    models.ResolvedCaseSearchRequest,
    models.ResolvedCaseSearchResponse,
    models.FollowUpResponseRequest,
    models.FollowUpResponseResult,
    models.ReportCreate,
    models.ReportCreated,
    models.GraphResponse,
    models.AlertReview,
    models.RiskModelArtifact,
    models.OutboxEvent,
]

OUT_DIR = Path(__file__).parent / "schemas"


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    for model in EXPORTED:
        path = OUT_DIR / f"{model.__name__}.json"
        path.write_text(json.dumps(model.model_json_schema(), indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {len(EXPORTED)} schemas to {OUT_DIR}")


if __name__ == "__main__":
    main()
