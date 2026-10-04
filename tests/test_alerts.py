import json
import uuid

import pytest

WET = {"humidity_mean_14d": 86, "rain_anomaly_30d": 1.6, "temp_optimal_days_14d": 10}


@pytest.fixture(scope="module", autouse=True)
def _seeded(fresh_db):
    pass


def set_env(db, plot_id, features):
    db.execute("update env.plot_summary set features = %s where plot_id = %s", (json.dumps(features), plot_id))
    db.commit()


def report(client, plot_id):
    resp = client.post("/v1/reports", headers={"Idempotency-Key": f"key-{uuid.uuid4()}"}, json={
        "session_id": f"s-{uuid.uuid4()}", "plot_id": plot_id, "channel": "voice",
        "symptoms": ["polvo naranja en el envés"], "completeness": "sufficient", "is_demo": True,
    })
    assert resp.status_code == 201
    return resp.json()


def alerts_for(client, plot_id):
    return client.get("/v1/alerts", params={"plot_id": plot_id}).json()["alerts"]


def review(client, alert_id, decision="approve", version=1, **extra):
    return client.post(f"/v1/alerts/{alert_id}/review",
                       json={"decision": decision, "expected_version": version, **extra})


def test_pending_queue_lists_seed_alert(client):
    pending = client.get("/v1/alerts", params={"status": "pending_review"}).json()["alerts"]
    assert [a["alert_id"] for a in pending] == ["alert_demo_03"]
    assert pending[0]["recipient_label"] == "Agricultor Demo 3"
    assert "+52" not in json.dumps(pending)


def test_rejected_episode_is_not_reproposed(client, db):
    set_env(db, "plot_demo_04", WET)
    client.post("/v1/graph/recalculate")
    nodes = {n["id"]: n for n in client.get("/v1/graph").json()["nodes"]}
    assert nodes["plot_demo_04"]["inspection_priority"] == "medium"
    # alert_demo_02 already rejected this plot for case_demo_01's episode.
    assert [a["alert_id"] for a in alerts_for(client, "plot_demo_04")] == ["alert_demo_02"]


def test_new_neighbor_case_proposes_alert_for_neighbors_only(client):
    report(client, "plot_demo_02")
    alerts = alerts_for(client, "plot_demo_04")
    new = [a for a in alerts if a["alert_id"] != "alert_demo_02"]
    assert len(new) == 1 and new[0]["status"] == "pending_review"
    assert new[0]["inspection_priority"] in ("medium", "high")
    # The reporting plot gets no new alert: it now has its own case.
    assert [a["alert_id"] for a in alerts_for(client, "plot_demo_02")] == ["alert_demo_01"]


def test_repeated_reports_do_not_duplicate_alerts(client):
    before = len(alerts_for(client, "plot_demo_04"))
    report(client, "plot_demo_02")
    report(client, "plot_demo_02")
    assert len(alerts_for(client, "plot_demo_04")) == before


def test_no_alert_without_notification_consent(client, db):
    set_env(db, "plot_demo_06", WET)
    report(client, "plot_demo_05")
    nodes = {n["id"]: n for n in client.get("/v1/graph").json()["nodes"]}
    assert nodes["plot_demo_06"]["inspection_priority"] in ("medium", "high")
    assert alerts_for(client, "plot_demo_06") == []


def test_approve_queues_one_notification_and_event(client, db):
    alert = next(a for a in alerts_for(client, "plot_demo_04") if a["status"] == "pending_review")
    resp = review(client, alert["alert_id"], reason="Aviso revisado")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "queued"
    assert body["approved_by"] == "operator_demo"
    assert [(n["channel"], n["status"]) for n in body["notifications"]] == [("sms", "queued")]
    events = db.execute("select count(*) from outbox_events where event_type = 'alert.approved' "
                        "and aggregate_id = %s", (alert["alert_id"],)).fetchone()[0]
    assert events == 1

    again = review(client, alert["alert_id"], version=body["version"])
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "ALERT_ALREADY_REVIEWED"
    assert len(client.get(f"/v1/alerts/{alert['alert_id']}").json()["notifications"]) == 1


def test_stale_version_is_409_and_reject_sends_nothing(client):
    stale = review(client, "alert_demo_03", version=99)
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "VERSION_CONFLICT"

    resp = review(client, "alert_demo_03", decision="reject", reason="Sin evidencia suficiente")
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"
    assert resp.json()["notifications"] == []


def test_unknown_alert_is_404(client):
    assert review(client, "nope").status_code == 404
