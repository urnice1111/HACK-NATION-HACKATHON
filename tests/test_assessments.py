import uuid

import pytest

from advisor.mock_assessor import MockAssessor
from advisor.openai_adapter import AssessmentGenerationError
from advisor.contracts import (
    AssessmentResponse,
    Disposition,
    EvidenceQuality,
    Recommendation,
    Urgency,
)
from tests.test_api import assert_uniform_error


@pytest.fixture(scope="module", autouse=True)
def _seeded(fresh_db):
    pass


def ask_payload(session_id: str = "session_demo_01", plot_id: str = "plot_demo_01") -> dict:
    return {
        "schema_version": "2.0",
        "session_id": session_id,
        "plot_id": plot_id,
        "language": "es",
        "observation": {
            "observed_at": None,
            "symptoms": ["manchas"],
            "user_statement": "Tengo manchas amarillas en las hojas",
            "measurements": [],
            "answers": [],
            "completeness": "partial",
        },
        "asked_need_codes": [],
        "plot_context": {"crop": "coffee"},
        "is_demo": True,
    }


def test_assessment_route_adapts_to_shared_contract(client, monkeypatch) -> None:
    monkeypatch.setattr("backend.app.routes.assessments.build_assessor", lambda: MockAssessor())
    response = client.post("/v1/assessments", json=ask_payload(session_id=f"s-{uuid.uuid4()}"))
    body = response.json()
    assert response.status_code == 200
    assert body["disposition"] == "ask_more"
    assert [need["need_code"] for need in body["information_needs"]] == ["leaf_underside", "affected_extent"]
    assert body["protocol_version"] == "coffee-rust-demo-v1"


def test_assessment_is_persisted_with_returned_id(client, monkeypatch, db) -> None:
    monkeypatch.setattr("backend.app.routes.assessments.build_assessor", lambda: MockAssessor())
    body = client.post("/v1/assessments", json=ask_payload(session_id=f"s-{uuid.uuid4()}")).json()
    row = db.execute("select id, disposition from assessments where id = %s", (body["assessment_id"],)).fetchone()
    assert row is not None
    assert row[0] == body["assessment_id"]
    assert row[1] == "ask_more"


def test_assessment_unavailable_is_uniform_503(client, monkeypatch) -> None:
    class Boom:
        def assess(self, _request):
            raise AssessmentGenerationError("OpenAI no está disponible temporalmente")

    monkeypatch.setattr("backend.app.routes.assessments.build_assessor", lambda: Boom())
    response = client.post("/v1/assessments", json=ask_payload())
    assert_uniform_error(response, 503, "ASSESSMENT_UNAVAILABLE")
    assert response.json()["error"]["retryable"] is True
    assert "OpenAI" in response.json()["error"]["message"]


def test_advise_persists_and_followup_has_guidance_given(client, monkeypatch) -> None:
    guidance = "Retirar y enterrar hojas afectadas; vigilar plantas vecinas."
    assessment_id = f"assessment_{uuid.uuid4().hex}"

    class Advise:
        def assess(self, _request):
            return AssessmentResponse(
                assessment_id=assessment_id,
                disposition=Disposition.advise,
                evidence_quality=EvidenceQuality.medium,
                urgency=Urgency.soon,
                recommendations=[
                    Recommendation(
                        code="remove_affected_leaves",
                        text=guidance,
                        protocol_id="coffee-rust-demo-v1",
                    )
                ],
                model_version="test-mock",
                protocol_version="coffee-rust-demo-v1",
            )

    monkeypatch.setattr("backend.app.routes.assessments.build_assessor", lambda: Advise())
    session_id = f"session_new_{uuid.uuid4().hex[:8]}"
    assessed = client.post(
        "/v1/assessments",
        json=ask_payload(session_id=session_id, plot_id="plot_demo_02"),
    )
    assert assessed.status_code == 200
    assert assessed.json()["assessment_id"] == assessment_id

    created = client.post(
        "/v1/reports",
        headers={"Idempotency-Key": f"report-{assessment_id}"},
        json={
            "schema_version": "2.0",
            "session_id": session_id,
            "plot_id": "plot_demo_02",
            "channel": "voice",
            "symptoms": ["manchas amarillas en hojas"],
            "user_statement": "Tengo manchas amarillas en las hojas",
            "completeness": "sufficient",
            "assessment_id": assessment_id,
            "is_demo": True,
        },
    )
    assert created.status_code == 201

    followups = client.get("/v1/followups").json()["followups"]
    match = next(item for item in followups if item["plot_id"] == "plot_demo_02")
    assert match["case_summary"]["guidance_given"] == guidance
