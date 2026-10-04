import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.app.graph.risk import apply_artifact, check_test_vectors
from contracts.models import Answer, InformationNeed, ReportCreate, RiskModelArtifact

CONTRACTS = Path(__file__).parent.parent / "contracts"


def load(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text())


def test_heuristic_artifact_reproduces_its_test_vectors():
    artifact = RiskModelArtifact.model_validate(load("fixtures/risk_model_heuristic.json"))
    assert check_test_vectors(artifact) == []


def test_missing_required_feature_is_unknown_not_low():
    artifact = RiskModelArtifact.model_validate(load("fixtures/risk_model_heuristic.json"))
    result = apply_artifact(artifact, {"humidity_mean_14d": None, "rain_anomaly_30d": 0.1})
    assert (result.score, result.priority) == (None, "unknown")
    assert "humidity_mean_14d" in result.missing_features


def test_need_catalog_entries_fit_information_need():
    catalog = load("need_catalog.json")
    codes = [n["need_code"] for n in catalog["needs"]]
    assert len(codes) == len(set(codes))
    for i, need in enumerate(catalog["needs"], start=1):
        InformationNeed.model_validate(
            {**need, "reason": need["why"], "priority": i, "can_be_unknown": True}
        )


def test_unknown_answer_cannot_carry_a_value():
    with pytest.raises(ValidationError):
        Answer(need_code="leaf_drop", value=0, unknown=True)
    assert Answer(need_code="leaf_drop", value=None, unknown=True).value is None


def test_report_rejects_unknown_fields():
    body = {
        "session_id": "s", "plot_id": "p", "channel": "voice",
        "completeness": "partial", "is_demo": True,
    }
    ReportCreate.model_validate(body)
    with pytest.raises(ValidationError):
        ReportCreate.model_validate({**body, "risk": "high"})
