"""Alert delivery by voice call (INSTRUCTIONS.md sections 11, 16 step 6 and 17)."""

import json
import uuid

import psycopg
import pytest

from backend.app.config import settings

WET = {"humidity_mean_14d": 86, "rain_anomaly_30d": 1.6, "temp_optimal_days_14d": 10}
NOW = "2026-10-04T15:00:00Z"


@pytest.fixture(scope="module", autouse=True)
def _seeded(fresh_db):
    pass


def post_status(client, notification_id, status, key=None, **extra):
    body = {"schema_version": "2.0", "status": status, "provider_reference": None, "error_code": None,
            "occurred_at": NOW, "is_demo": True, **extra}
    return client.post(f"/v1/notifications/{notification_id}/status",
                       headers={"Idempotency-Key": key or f"key-{uuid.uuid4()}"}, json=body)


def report(client, plot_id):
    resp = client.post("/v1/reports", headers={"Idempotency-Key": f"key-{uuid.uuid4()}"}, json={
        "session_id": f"s-{uuid.uuid4()}", "plot_id": plot_id, "channel": "voice",
        "symptoms": ["polvo naranja en el envés"], "completeness": "sufficient", "is_demo": True,
    })
    assert resp.status_code == 201


def queue(client, **params):
    return client.get("/v1/notifications", params=params).json()["notifications"]


@pytest.fixture(scope="module")
def approved(client):
    """Approves a fresh alert for plot_demo_04 (neighbour of a new case on plot_demo_02)."""
    with psycopg.connect(settings.database_url) as conn:
        conn.execute("update env.plot_summary set features = %s where plot_id = 'plot_demo_04'", (json.dumps(WET),))
    report(client, "plot_demo_02")
    alerts = client.get("/v1/alerts", params={"plot_id": "plot_demo_04", "status": "pending_review"}).json()["alerts"]
    resp = client.post(f"/v1/alerts/{alerts[0]['alert_id']}/review", json={
        "decision": "approve", "expected_version": alerts[0]["version"],
        "message": "Aviso de prueba: revisa el envés de tus hojas."})
    assert resp.status_code == 200
    return resp.json()


def test_approval_creates_voice_notification_in_queue(client, approved):
    [notification] = approved["notifications"]
    assert notification["channel"] == "voice"

    resp = client.get("/v1/notifications", params={"status": "queued", "channel": "voice"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["schema_version"] == "2.0" and body["next_cursor"] is None and body["is_demo"] is True
    [item] = [n for n in body["notifications"] if n["notification_id"] == notification["notification_id"]]
    assert item == {
        "notification_id": notification["notification_id"],
        "alert_id": approved["alert_id"],
        "plot_id": "plot_demo_04",
        "plot_label": approved["plot_label"],
        "farmer_name": approved["recipient_label"],
        "channel": "voice",
        "status": "queued",
        "attempt_count": 0,
        "provider_reference": None,
        "message": "Aviso de prueba: revisa el envés de tus hojas.",
        "contact": item["contact"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
        "is_demo": True,
    }
    assert set(item["contact"]) == {"phone_e164", "preferred_language", "timezone", "allowed_hours",
                                    "notification_consent"}
    assert item["contact"]["phone_e164"].startswith("+")
    assert item["contact"]["notification_consent"] is True
    assert set(item["contact"]["allowed_hours"]) == {"start", "end"}
    assert item["created_at"].endswith("Z") and item["updated_at"].endswith("Z")


def test_queue_only_lists_alert_notifications_and_filters(client):
    ids = [n["notification_id"] for n in queue(client)]
    assert "notification_demo_02" not in ids  # follow-up notification, not an alert
    assert "notification_demo_01" in ids
    assert all(n["status"] == "failed" for n in queue(client, status="failed"))
    assert queue(client, channel="sms") == []
    assert client.get("/v1/notifications", params={"status": "read"}).status_code == 422


def test_call_lifecycle_with_retry_then_delivered(client, db, approved):
    nid = approved["notifications"][0]["notification_id"]

    first = post_status(client, nid, "sending")
    assert first.status_code == 200
    assert first.json() == {"notification_id": nid, "status": "sending", "attempt_count": 1,
                            "provider_reference": None, "applied": True, "is_demo": True}

    accepted = post_status(client, nid, "accepted", provider_reference="conv_demo_1").json()
    assert (accepted["status"], accepted["attempt_count"], accepted["provider_reference"]) == \
        ("accepted", 1, "conv_demo_1")

    retry = post_status(client, nid, "sending").json()
    assert (retry["status"], retry["attempt_count"], retry["provider_reference"]) == ("sending", 2, "conv_demo_1")

    delivered = post_status(client, nid, "delivered", provider_reference="conv_demo_2").json()
    assert delivered == {"notification_id": nid, "status": "delivered", "attempt_count": 2,
                         "provider_reference": "conv_demo_2", "applied": True, "is_demo": True}

    events = db.execute(
        "select payload from outbox_events where event_type = 'notification.status_changed' and aggregate_id = %s "
        "order by aggregate_version", (nid,)).fetchall()
    assert [e[0]["status"] for e in events] == ["sending", "accepted", "sending", "delivered"]
    assert events[-1][0] == {"notification_id": nid, "alert_id": approved["alert_id"], "status": "delivered",
                             "provider_reference": "conv_demo_2"}

    # The operator dashboard sees the outcome on the alert.
    [shown] = client.get(f"/v1/alerts/{approved['alert_id']}").json()["notifications"]
    assert (shown["channel"], shown["status"], shown["attempt_count"]) == ("voice", "delivered", 2)


def test_update_after_terminal_changes_nothing(client, db, approved):
    nid = approved["notifications"][0]["notification_id"]
    events_before = db.execute("select count(*) from outbox_events where aggregate_id = %s", (nid,)).fetchone()[0]

    for late in ("failed", "accepted", "unknown"):
        resp = post_status(client, nid, late, error_code="no_answer", provider_reference="late_ref")
        assert resp.status_code == 200
        assert resp.json() == {"notification_id": nid, "status": "delivered", "attempt_count": 2,
                               "provider_reference": "conv_demo_2", "applied": False, "is_demo": True}

    row = db.execute("select status, last_error from notifications where id = %s", (nid,)).fetchone()
    assert row == ("delivered", None)
    assert db.execute("select count(*) from outbox_events where aggregate_id = %s", (nid,)).fetchone()[0] \
        == events_before


def test_failed_stores_error_code(client, db):
    db.execute("update notifications set status = 'queued', last_error = null where id = 'notification_demo_01'")
    db.commit()
    resp = post_status(client, "notification_demo_01", "failed", error_code="no_answer")
    assert resp.json()["applied"] is True and resp.json()["status"] == "failed"
    assert db.execute("select last_error from notifications where id = 'notification_demo_01'").fetchone()[0] \
        == "no_answer"


def test_idempotent_replay_and_conflict(client, db):
    db.execute("update notifications set status = 'queued', attempt_count = 0 where id = 'notification_demo_01'")
    db.commit()
    key = f"key-{uuid.uuid4()}"

    first = post_status(client, "notification_demo_01", "sending", key=key)
    replay = post_status(client, "notification_demo_01", "sending", key=key)
    assert replay.status_code == 200
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert replay.json() == first.json()
    assert first.json()["attempt_count"] == 1
    assert db.execute("select attempt_count from notifications where id = 'notification_demo_01'").fetchone()[0] == 1

    conflict = post_status(client, "notification_demo_01", "accepted", key=key)
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_missing_and_invalid(client):
    assert post_status(client, "nope", "sending").status_code == 404

    for bad in ({"status": "read"}, {"status": "queued"}, {"extra_field": 1}):
        resp = post_status(client, "notification_demo_01", "sending", **bad)
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    no_key = client.post("/v1/notifications/notification_demo_01/status",
                         json={"status": "sending", "occurred_at": NOW, "is_demo": True})
    assert no_key.status_code == 422
