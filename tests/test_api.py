"""API tests against the local demo database (docker compose up -d db && backend/scripts/reset_db.sh)."""

import pytest

SHARED_PHONE = "+525500000001"


@pytest.fixture(scope="module", autouse=True)
def _seeded(fresh_db):
    pass


def assert_uniform_error(resp, status, code):
    assert resp.status_code == status
    error = resp.json()["error"]
    assert error["code"] == code
    assert error["request_id"] == resp.headers["X-Request-ID"]
    assert set(error) == {"code", "message", "retryable", "request_id", "details"}


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_invalid_body_is_422_with_field(client):
    resp = client.post("/v1/contact-resolution", json={"phone_e164": "5512345678"})
    assert_uniform_error(resp, 422, "VALIDATION_ERROR")
    fields = {d["field"] for d in resp.json()["error"]["details"]}
    assert fields == {"phone_e164", "session_id"}


def test_invalid_json_is_400(client):
    resp = client.post("/v1/contact-resolution", headers={"Content-Type": "application/json"},
                       content="{not json")
    assert_uniform_error(resp, 400, "INVALID_JSON")


def test_shared_phone_returns_two_candidates_without_personal_data(client):
    resp = client.post("/v1/contact-resolution",
                       json={"phone_e164": SHARED_PHONE, "session_id": "s1"})
    body = resp.json()
    assert resp.status_code == 200
    assert body["requires_confirmation"] is True
    assert len(body["candidates"]) == 2
    assert "Agricultor" not in resp.text
    assert {c["label"] for c in body["candidates"]} == {"Parcela 1", "Parcela 2"}


def test_unknown_phone_returns_no_candidates(client):
    resp = client.post("/v1/contact-resolution",
                       json={"phone_e164": "+525599999999", "session_id": "s1"})
    assert resp.json()["candidates"] == []


def test_confirm_releases_farmer_only_for_same_session(client):
    candidates = client.post("/v1/contact-resolution",
                             json={"phone_e164": SHARED_PHONE, "session_id": "s1"}).json()["candidates"]
    token = next(c["candidate_token"] for c in candidates if c["label"] == "Parcela 1")

    other = client.post("/v1/contact-resolution/confirm",
                        json={"candidate_token": token, "session_id": "s2"})
    assert_uniform_error(other, 403, "FORBIDDEN")

    resp = client.post("/v1/contact-resolution/confirm",
                       json={"candidate_token": token, "session_id": "s1"})
    assert resp.status_code == 200
    assert resp.json()["farmer_id"] == "farmer_demo_01"
    assert resp.json()["plots"] == [{"plot_id": "plot_demo_01", "name": "Parcela 1"}]


def test_plot_context(client):
    resp = client.get("/v1/plots/plot_demo_01/context")
    body = resp.json()
    assert resp.status_code == 200
    assert [c["case_id"] for c in body["active_cases"]] == ["case_demo_01"]
    assert body["risk"][0]["inspection_priority"] == "high"
    assert body["environment_summary"]["data_freshness"] == "unknown"


def test_plot_context_uses_latest_risk_evaluation(client):
    body = client.get("/v1/plots/plot_demo_04/context").json()
    assert body["risk"][0]["inspection_priority"] == "low"
    assert body["active_cases"] == []


def test_unknown_plot_is_404(client):
    assert_uniform_error(client.get("/v1/plots/nope/context"), 404, "NOT_FOUND")
