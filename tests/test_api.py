"""API tests against the local demo database (docker compose up -d db && backend/scripts/reset_db.sh).

Key sets mirror communications/src/contracts/resources.ts: its zod schemas are strict, so an extra
or missing field breaks integrante 1's client.
"""

import re
import uuid

import pytest

SHARED_PHONE = "+525500000001"
UTC_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


@pytest.fixture(scope="module", autouse=True)
def _seeded(fresh_db):
    pass


def assert_uniform_error(resp, status, code):
    assert resp.status_code == status
    error = resp.json()["error"]
    assert error["code"] == code
    assert error["request_id"] == resp.headers["X-Request-ID"]
    assert set(error) == {"code", "message", "retryable", "request_id", "details"}


def resolve(client, phone=SHARED_PHONE, session="s1", token=None):
    return client.post("/v1/contact-resolution", json={
        "schema_version": "2.0", "session_id": session, "phone_e164": phone, "channel": "voice",
        "confirm_candidate_token": token, "is_demo": True,
    })


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/v1/health").json() == {"status": "ok"}


def test_invalid_body_is_422_with_field(client):
    resp = client.post("/v1/contact-resolution", json={"phone_e164": "5512345678"})
    assert_uniform_error(resp, 422, "VALIDATION_ERROR")
    fields = {d["field"] for d in resp.json()["error"]["details"]}
    assert fields == {"phone_e164", "session_id"}


def test_invalid_json_is_400(client):
    resp = client.post("/v1/contact-resolution", headers={"Content-Type": "application/json"},
                       content="{not json")
    assert_uniform_error(resp, 400, "INVALID_JSON")


def test_shared_phone_returns_two_candidates(client):
    body = resolve(client).json()
    assert set(body) == {"schema_version", "session_id", "resolution_status", "requires_confirmation",
                         "is_shared_phone", "candidates", "confirmed", "is_demo"}
    assert body["resolution_status"] == "candidates"
    assert body["requires_confirmation"] is True and body["is_shared_phone"] is True
    assert {c["label"] for c in body["candidates"]} == {"Agricultor Demo 1", "Agricultor Demo 2"}
    assert body["confirmed"] is None


def test_unknown_phone_is_no_match(client):
    body = resolve(client, phone="+525599999999").json()
    assert (body["resolution_status"], body["requires_confirmation"], body["candidates"]) == ("no_match", False, [])


def test_confirm_releases_farmer_only_for_same_session_and_phone(client):
    candidates = resolve(client).json()["candidates"]
    token = next(c["candidate_token"] for c in candidates if c["label"] == "Agricultor Demo 1")

    assert_uniform_error(resolve(client, session="s2", token=token), 403, "CANDIDATE_TOKEN_INVALID")
    assert_uniform_error(resolve(client, phone="+525500000003", token=token), 403, "CANDIDATE_TOKEN_INVALID")

    body = resolve(client, token=token).json()
    assert body["resolution_status"] == "confirmed"
    confirmed = body["confirmed"]
    assert set(confirmed) == {"farmer_id", "preferred_language", "timezone", "consent", "plots"}
    assert confirmed["farmer_id"] == "farmer_demo_01"
    assert confirmed["plots"] == [{"plot_id": "plot_demo_01", "label": "Parcela 1"}]
    assert set(confirmed["consent"]) == {"reports", "notifications", "followup_calls", "consent_at"}
    assert UTC_Z.match(confirmed["consent"]["consent_at"])


def test_never_asked_consent_is_null(client):
    token = resolve(client, phone="+525500000008").json()["candidates"][0]["candidate_token"]
    consent = resolve(client, phone="+525500000008", token=token).json()["confirmed"]["consent"]
    assert consent == {"reports": None, "notifications": None, "followup_calls": None, "consent_at": None}


def test_plot_context(client):
    resp = client.get("/v1/plots/plot_demo_01/context")
    body = resp.json()
    assert resp.status_code == 200
    assert set(body) == {"schema_version", "plot_id", "label", "crop", "variety", "altitude_m", "data_freshness",
                         "environment_summary", "active_cases", "pending_followups", "is_demo"}
    assert body["label"] == "Parcela 1"
    assert [c["case_id"] for c in body["active_cases"]] == ["case_demo_01"]
    assert [f["followup_id"] for f in body["pending_followups"]] == ["followup_demo_01"]
    assert body["data_freshness"] == "fresh"
    features = {f["name"]: f for f in body["environment_summary"]["features"]}
    assert features["humidity_mean_14d"] == {"name": "humidity_mean_14d", "value": 88, "unit": "%"}
    assert UTC_Z.match(body["active_cases"][0]["opened_at"])


def test_plot_without_env_summary_is_null_not_error(client):
    body = client.get("/v1/plots/plot_demo_07/context").json()
    assert body["environment_summary"] is None
    assert body["data_freshness"] == "unknown"


def test_unknown_plot_is_404(client):
    assert_uniform_error(client.get("/v1/plots/nope/context"), 404, "NOT_FOUND")
    assert_uniform_error(client.get("/v1/plots/nope/timeline"), 404, "NOT_FOUND")


def test_plot_timeline_lists_history_newest_first(client):
    resp = client.get("/v1/plots/plot_demo_01/timeline")
    body = resp.json()
    assert resp.status_code == 200
    assert set(body) == {"schema_version", "plot_id", "events", "next_cursor", "is_demo"}
    assert body["plot_id"] == "plot_demo_01"
    types = [e["event_type"] for e in body["events"]]
    assert types == ["followup.due", "risk.updated", "report.created"]
    assert {e["event_id"] for e in body["events"]} == {
        "followup_demo_01", "risk_demo_01", "report_demo_01",
    }
    assert all(UTC_Z.match(e["occurred_at"]) for e in body["events"])
    assert "+52" not in resp.text
    event = body["events"][0]
    assert set(event) == {"event_id", "event_type", "occurred_at", "summary", "threat_code",
                          "case_id", "report_id", "followup_id", "resolution_id", "is_demo"}


def test_plot_timeline_includes_resolution(client):
    types = {e["event_type"] for e in client.get("/v1/plots/plot_demo_06/timeline").json()["events"]}
    assert types == {"risk.updated", "report.created", "followup.responded", "case.resolved"}


def test_plot_timeline_pages_with_cursor(client):
    first = client.get("/v1/plots/plot_demo_01/timeline", params={"limit": 1}).json()
    assert len(first["events"]) == 1
    assert first["events"][0]["event_id"] == "followup_demo_01"
    assert first["next_cursor"]

    second = client.get("/v1/plots/plot_demo_01/timeline",
                        params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [e["event_id"] for e in second["events"]] == ["risk_demo_01", "report_demo_01"]
    assert second["next_cursor"] is None
    assert_uniform_error(client.get("/v1/plots/plot_demo_01/timeline", params={"cursor": "bad"}),
                         422, "VALIDATION_ERROR")


def test_consents_update_only_given_permissions(client):
    key = f"consent-{uuid.uuid4()}"
    body = {"schema_version": "2.0", "session_id": "s-consent", "farmer_id": "farmer_demo_08", "channel": "voice",
            "reports": True, "notifications": None, "followup_calls": False, "provider_reference": None,
            "is_demo": True}
    resp = client.post("/v1/consents", json=body, headers={"Idempotency-Key": key})
    assert resp.status_code == 200
    consent = resp.json()["consent"]
    assert (consent["reports"], consent["notifications"], consent["followup_calls"]) == (True, False, False)

    replay = client.post("/v1/consents", json=body, headers={"Idempotency-Key": key})
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert replay.json() == resp.json()


def test_revocation_by_phone_updates_every_contact(client):
    resp = client.post("/v1/consents/revocations", headers={"Idempotency-Key": f"revocation-{uuid.uuid4()}"}, json={
        "schema_version": "2.0", "phone_e164": "+525500000005", "channel": "sms",
        "scopes": ["notifications", "followup_calls"], "provider_reference": "SM123", "is_demo": True,
    })
    assert resp.json() == {"contacts_updated": 1, "scopes": ["notifications", "followup_calls"], "is_demo": True}
    token = resolve(client, phone="+525500000005").json()["candidates"][0]["candidate_token"]
    consent = resolve(client, phone="+525500000005", token=token).json()["confirmed"]["consent"]
    assert (consent["notifications"], consent["followup_calls"], consent["reports"]) == (False, False, True)
