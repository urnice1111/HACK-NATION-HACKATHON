import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from contracts.models import Answer, InformationNeed, ReportCreate, RiskModelArtifact

CONTRACTS = Path(__file__).parent.parent / "contracts"


def load(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text())


def reference_score(artifact: RiskModelArtifact, inputs: dict) -> tuple[float | None, str]:
    """Section 5.2 formula, used only to check the fixture's test vectors."""
    features = {f.name: f for f in artifact.features}
    if any(f.required and inputs.get(name) is None for name, f in features.items()):
        return None, "unknown"
    raw = artifact.intercept + sum(
        f.coef * (inputs[name] - f.mean) / f.std for name, f in features.items() if inputs.get(name) is not None
    )
    low, high = artifact.score_range
    score = min(max(raw, low), high)
    if score >= artifact.cutoffs.high:
        return score, "high"
    if score >= artifact.cutoffs.medium:
        return score, "medium"
    return score, "low"


def test_heuristic_artifact_reproduces_its_test_vectors():
    artifact = RiskModelArtifact.model_validate(load("fixtures/risk_model_heuristic.json"))
    for vector in artifact.test_vectors:
        score, priority = reference_score(artifact, vector.input)
        assert priority == vector.expected_priority
        if vector.expected_score is None:
            assert score is None
        else:
            assert score == pytest.approx(vector.expected_score, abs=1e-4)


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
