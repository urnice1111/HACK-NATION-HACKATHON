import json
import uuid

import pytest


@pytest.fixture(scope="module", autouse=True)
def _seeded(fresh_db):
    pass


def nodes(client):
    return {n["id"]: n for n in client.get("/v1/graph").json()["nodes"]}


def attempt(client, followup_id, status="contacting", channel="voice", key=None):
    return client.post(
        f"/v1/followups/{followup_id}/attempts",
        headers={"Idempotency-Key": key or f"attempt-{uuid.uuid4()}"},
        json={
            "schema_version": "2.0",
            "session_id": f"s-{uuid.uuid4()}",
            "status": status,
            "channel": channel,
            "call_reference": "call-test" if status == "contacting" else None,
            "occurred_at": "2026-10-04T03:00:00Z",
            "is_demo": True,
        },
    )


def respond(client, followup_id, status="resolved", key=None, **extra):
    body = {
        "schema_version": "2.0",
        "session_id": f"s-{uuid.uuid4()}",
        "channel": "voice",
        "status_reported": status,
        "user_statement": extra.pop("user_statement", "Ya no hay manchas"),
        "actions_taken": extra.pop("actions_taken", "Quitó hojas afectadas"),
        "action_worked": extra.pop("action_worked", "yes"),
        "change_noticed_at": None,
        "provider_reference": None,
        "is_demo": True,
        **extra,
    }
    return client.post(
        f"/v1/followups/{followup_id}/responses",
        headers={"Idempotency-Key": key or f"followup-{followup_id}-{uuid.uuid4()}"},
        json=body,
    )


def test_list_includes_overdue_and_matches_communications_shape(client):
    body = client.get("/v1/followups", params={"status": "scheduled"}).json()
    assert set(body) == {"schema_version", "followups", "next_cursor", "is_demo"}
    overdue = next(f for f in body["followups"] if f["followup_id"] == "followup_demo_01")
    assert overdue["plot_id"] == "plot_demo_01"
    assert overdue["case_summary"]["farmer_name"] == "Agricultor Demo 1"
    assert overdue["case_summary"]["threat_code"] == "coffee_leaf_rust"
    assert overdue["contact"]["followup_call_consent"] is True
    assert overdue["due_at"].endswith("Z")
    assert overdue["case_summary"]["opened_at"].endswith("Z")
    # Communications needs the phone to dial, but the dashboard search must never see it.
    assert overdue["contact"]["phone_e164"].startswith("+52")


def test_new_report_schedules_one_followup(client, db):
    client.post("/v1/reports", headers={"Idempotency-Key": f"key-{uuid.uuid4()}"}, json={
        "session_id": "s-fu", "plot_id": "plot_demo_02", "channel": "voice",
        "symptoms": ["polvo naranja"], "user_statement": "manchas",
        "completeness": "sufficient", "is_demo": True,
    })
    client.post("/v1/reports", headers={"Idempotency-Key": f"key-{uuid.uuid4()}"}, json={
        "session_id": "s-fu-2", "plot_id": "plot_demo_02", "channel": "voice",
        "symptoms": ["polvo naranja"], "user_statement": "siguen las manchas",
        "completeness": "sufficient", "is_demo": True,
    })
    open_count = db.execute(
        """
        select count(*) from followups f join cases c on c.id = f.case_id
        where c.plot_id = 'plot_demo_02' and f.status in ('scheduled', 'contacting', 'no_response')
        """
    ).fetchone()[0]
    assert open_count == 1


def test_no_response_does_not_change_risk(client, db):
    created = client.post("/v1/reports", headers={"Idempotency-Key": f"key-{uuid.uuid4()}"}, json={
        "session_id": "s-no-resp", "plot_id": "plot_demo_04", "channel": "voice",
        "symptoms": ["manchas"], "user_statement": "aparecieron manchas",
        "completeness": "sufficient", "is_demo": True,
    }).json()
    followup_id = db.execute(
        "select id from followups where case_id = %s and status = 'scheduled'", (created["case_id"],)
    ).fetchone()[0]
    before = nodes(client)["plot_demo_04"]
    resp = attempt(client, followup_id, status="no_response")
    assert resp.status_code == 200
    assert resp.json()["status"] == "no_response"
    after = nodes(client)["plot_demo_04"]
    assert after["inspection_priority"] == before["inspection_priority"]
    assert after["score"] == before["score"]
    case = db.execute("select status from cases where id = %s", (created["case_id"],)).fetchone()[0]
    assert case != "resolved"


def test_resolved_creates_one_resolution_and_lowers_neighbors(client, db):
    client.post("/v1/graph/recalculate")
    neighbor_before = nodes(client)["plot_demo_02"]
    key = f"followup-followup_demo_01-{uuid.uuid4()}"
    payload = {
        "schema_version": "2.0", "session_id": "s-resolved-01", "channel": "voice",
        "status_reported": "resolved", "user_statement": "Ya no hay manchas",
        "actions_taken": "Quitó hojas afectadas", "action_worked": "yes",
        "change_noticed_at": None, "provider_reference": None, "is_demo": True,
    }
    first = client.post("/v1/followups/followup_demo_01/responses",
                        headers={"Idempotency-Key": key}, json=payload)
    assert first.status_code == 201
    body = first.json()
    assert set(body) == {"report_id", "case_id", "case_status", "resolution_id", "next_followup_at"}
    assert body["case_status"] == "resolved"
    assert body["resolution_id"] is not None
    assert body["next_followup_at"] is None

    replay = client.post("/v1/followups/followup_demo_01/responses",
                         headers={"Idempotency-Key": key}, json=payload)
    assert replay.status_code == 201
    assert replay.json()["resolution_id"] == body["resolution_id"]
    assert db.execute("select count(*) from case_resolutions where case_id = 'case_demo_01'").fetchone()[0] == 1

    closed = respond(client, "followup_demo_01")
    assert closed.status_code == 409
    assert closed.json()["error"]["code"] == "FOLLOWUP_CLOSED"

    case = db.execute("select status from cases where id = 'case_demo_01'").fetchone()[0]
    assert case == "resolved"
    neighbor_after = nodes(client)["plot_demo_02"]
    assert neighbor_after["score"] < neighbor_before["score"]


def test_same_or_worse_schedules_another_followup(client):
    resp = respond(client, "followup_demo_02", status="worse",
                   user_statement="Está peor", actions_taken=None, action_worked="no")
    assert resp.status_code == 201
    assert resp.json()["resolution_id"] is None
    assert resp.json()["next_followup_at"] is not None
    assert resp.json()["next_followup_at"].endswith("Z")
    listed = client.get("/v1/followups", params={"status": "scheduled"}).json()["followups"]
    assert any(f["case_id"] == "case_demo_02" for f in listed)


def test_resolved_cases_search_hides_identity(client):
    resp = client.post("/v1/resolved-cases/search", json={
        "threat_code": "coffee_leaf_rust",
        "symptoms": ["manchas amarillas en hojas", "polvo naranja en el envés"],
        "near_plot_id": "plot_demo_01",
        "max_distance_km": 50,
        "only_verified": False,
        "limit": 5,
    })
    assert resp.status_code == 200
    text = json.dumps(resp.json())
    assert "plot_demo" not in text
    assert "Agricultor" not in text
    assert "19." not in text and "-96." not in text
    results = resp.json()["results"]
    assert results
    assert set(results[0]) == {
        "resolution_id", "threat_code", "similarity", "distance_band", "resolved_at",
        "days_to_resolution", "solution_summary", "solution_codes", "matches_protocol", "verification",
    }
    assert results[0]["resolved_at"].endswith("Z")
    product = next(r for r in results if r["resolution_id"] == "resolution_demo_03")
    assert product["matches_protocol"] is False


def test_dashboard_list_includes_plot(client):
    body = client.get("/v1/resolved-cases").json()
    assert set(body) == {"schema_version", "resolutions"}
    row = next(r for r in body["resolutions"] if r["resolution_id"] == "resolution_demo_01")
    assert row["plot_id"] == "plot_demo_05"
    assert row["plot_label"] == "Parcela 5"
    assert row["verification"] == "verified"
