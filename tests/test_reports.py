import uuid

import pytest


@pytest.fixture(scope="module", autouse=True)
def _seeded(fresh_db):
    pass


def report(plot_id="plot_demo_02", **overrides):
    return {
        "session_id": "session_test",
        "plot_id": plot_id,
        "channel": "voice",
        "symptoms": ["manchas amarillas en hojas"],
        "user_statement": "Veo manchas amarillas en varias matas",
        "completeness": "sufficient",
        "is_demo": True,
        **overrides,
    }


def post(client, body, key=None):
    return client.post("/v1/reports", json=body, headers={"Idempotency-Key": key or f"key-{uuid.uuid4()}"})


def count(db, sql, *params):
    return db.execute(sql, params).fetchone()[0]


def test_new_report_opens_a_case(client, db):
    resp = post(client, report("plot_demo_02"))
    assert resp.status_code == 201
    body = resp.json()
    assert body["processing_status"] == "pending"
    assert body["correlation_id"] == "session_test"
    status = db.execute("select status, plot_id from cases where id = %s", (body["case_id"],)).fetchone()
    assert status == ("reported", "plot_demo_02")


def test_report_joins_existing_open_case(client, db):
    resp = post(client, report("plot_demo_01"))
    assert resp.json()["case_id"] == "case_demo_01"
    assert count(db, "select count(*) from cases where plot_id = 'plot_demo_01' and status <> 'resolved'") == 1


def test_three_reports_same_episode_one_case(client, db):
    case_ids = {post(client, report("plot_demo_06")).json()["case_id"] for _ in range(3)}
    assert len(case_ids) == 1
    # plot 06 had only a resolved case, so a new one was opened rather than reusing it.
    assert case_ids != {"case_demo_r2"}


def test_same_key_same_body_returns_original(client, db):
    key = f"key-{uuid.uuid4()}"
    first = post(client, report("plot_demo_05"), key)
    second = post(client, report("plot_demo_05"), key)
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert second.headers["Idempotency-Replayed"] == "true"
    assert count(db, "select count(*) from reports where id = %s", first.json()["report_id"]) == 1
    assert count(db, "select count(*) from reports where plot_id = 'plot_demo_05'") == 1


def test_same_key_different_body_is_409(client):
    key = f"key-{uuid.uuid4()}"
    post(client, report("plot_demo_05"), key)
    resp = post(client, report("plot_demo_05", user_statement="otra cosa"), key)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_missing_idempotency_key_is_422(client):
    resp = client.post("/v1/reports", json=report())
    assert resp.status_code == 422


def test_unknown_plot_is_404_and_key_not_consumed(client, db):
    key = f"key-{uuid.uuid4()}"
    assert post(client, report("plot_nope"), key).status_code == 404
    assert count(db, "select count(*) from idempotency_keys where key = %s", key) == 0


def test_case_from_another_plot_is_422(client):
    resp = post(client, report("plot_demo_02", case_id="case_demo_01"))
    assert resp.status_code == 422


def test_each_report_emits_one_event(client, db):
    report_id = post(client, report("plot_demo_04")).json()["report_id"]
    events = db.execute(
        "select event_type, payload->>'plot_id' from outbox_events where aggregate_id = %s", (report_id,)
    ).fetchall()
    assert events == [("report.created", "plot_demo_04")]


def test_partial_report_without_assessment_is_accepted(client):
    resp = post(client, report("plot_demo_03", completeness="partial", assessment_id=None, symptoms=[]))
    assert resp.status_code == 201
    assert resp.json()["case_id"] == "case_demo_02"


def test_unknown_number_report_has_no_plot_and_no_case(client, db):
    resp = post(client, report(None, channel="sms"))
    assert resp.status_code == 201
    assert resp.json()["case_id"] is None
    assert count(db, "select count(*) from reports where id = %s and plot_id is null",
                 resp.json()["report_id"]) == 1


def test_report_detail_matches_communications_shape(client):
    created = post(client, report("plot_demo_03", measurements=[
        {"name": "ph", "value": None, "unit": "pH", "sample_type": "soil", "measured_at": None,
         "method": None, "source": "farmer_reported"}])).json()
    detail = client.get(f"/v1/reports/{created['report_id']}").json()
    assert set(detail) == {"report_id", "case_id", "plot_id", "session_id", "channel", "provider_reference",
                           "observed_at", "received_at", "symptoms", "measurements", "user_statement",
                           "completeness", "assessment_id", "processing_status", "created_at", "is_demo"}
    assert detail["received_at"].endswith("Z")
    assert detail["measurements"][0]["value"] is None
    assert detail["processing_status"] == "processed"
