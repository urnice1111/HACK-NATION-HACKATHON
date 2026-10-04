from fastapi.testclient import TestClient

from advisor.app import app


def payload(statement: str = "Veo manchas en varias hojas") -> dict:
    return {
        "schema_version": "2.0",
        "session_id": "session_demo_01",
        "plot_id": "plot_demo_01",
        "language": "es",
        "observation": {"observed_at": None, "symptoms": ["manchas"], "user_statement": statement, "measurements": [], "answers": [], "completeness": "partial"},
        "asked_need_codes": [],
        "plot_context": {"crop": "coffee"},
        "is_demo": True,
    }


def client(monkeypatch) -> TestClient:
    monkeypatch.setenv("ADVISOR_MODE", "mock")
    return TestClient(app)


def test_insufficient_case_returns_two_needs_and_environment_data(monkeypatch) -> None:
    response = client(monkeypatch).post("/v1/assessments", json=payload())
    body = response.json()
    assert response.status_code == 200
    assert body["disposition"] == "ask_more"
    assert [need["need_code"] for need in body["information_needs"]] == ["leaf_underside", "affected_extent"]
    assert body["data_used"]


def test_typical_case_advises_after_farmer_answer(monkeypatch) -> None:
    data = payload()
    data["observation"]["answers"] = [{"need_code": "leaf_underside", "value": "polvo naranja o amarillo", "raw_text": "Veo polvo naranja", "unknown": False}]
    response = client(monkeypatch).post("/v1/assessments", json=data)
    assert response.json()["disposition"] == "advise"
    assert response.json()["recommendations"][0]["protocol_id"] == "coffee-rust-demo-v1"


def test_product_or_dose_is_referred(monkeypatch) -> None:
    response = client(monkeypatch).post("/v1/assessments", json=payload("¿Qué fungicida y dosis uso?"))
    assert response.json()["disposition"] == "refer"
    assert response.json()["human_review_required"] is True


def test_resolved_case_is_mentioned_only_when_supplied_by_backend(monkeypatch) -> None:
    data = payload()
    data["observation"]["answers"] = [{"need_code": "leaf_underside", "value": "polvo naranja", "unknown": False}]
    data["plot_context"]["resolved_case_match"] = {"resolution_id": "resolution_demo_03", "summary_for_speech": "Caso verificado de la zona", "verification": "verified"}
    response = client(monkeypatch).post("/v1/assessments", json=data)
    assert response.json()["resolved_case_mentions"][0]["resolution_id"] == "resolution_demo_03"
