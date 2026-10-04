import uuid

import pytest

from contracts.models import GraphResponse


@pytest.fixture(scope="module", autouse=True)
def _seeded(fresh_db):
    pass


def nodes(client):
    graph = client.get("/v1/graph").json()
    return {n["id"]: n for n in graph["nodes"]}


def edge(client, a, b):
    return next(e for e in client.get("/v1/graph").json()["edges"] if (e["source"], e["target"]) == (a, b))


def test_recalculation_reproduces_seed_priorities(client):
    client.post("/v1/graph/recalculate")
    n = nodes(client)
    assert {pid: n[pid]["inspection_priority"] for pid in n} == {
        "plot_demo_01": "high", "plot_demo_02": "medium", "plot_demo_03": "medium", "plot_demo_04": "low",
        "plot_demo_05": "low", "plot_demo_06": "low", "plot_demo_07": "unknown", "plot_demo_08": "unknown",
    }
    assert n["plot_demo_01"]["score"] == pytest.approx(0.87, abs=0.01)


def test_graph_matches_contract(client):
    graph = GraphResponse.model_validate(client.get("/v1/graph").json())
    assert graph.graph_version >= 1
    assert all(node.heuristic for node in graph.nodes)
    assert all(e.source < e.target and e.distance_km <= 10 for e in graph.edges)


def test_missing_env_data_is_unknown_with_reason(client):
    plot7 = nodes(client)["plot_demo_07"]
    assert plot7["score"] is None
    assert plot7["reasons"][0].startswith("Faltan datos")


def test_outside_coverage_plot_has_no_edges(client):
    edges = client.get("/v1/graph").json()["edges"]
    assert not any("plot_demo_08" in (e["source"], e["target"]) for e in edges)


def test_similarity_without_active_case_creates_no_exposure(client):
    e = edge(client, "plot_demo_02", "plot_demo_04")
    assert e["environment_similarity"] > 0.5
    assert e["exposure_strength"] is None


def test_recalculating_without_changes_adds_no_evaluations(client, db):
    client.post("/v1/graph/recalculate")
    before = db.execute("select count(*) from risk_evaluations").fetchone()[0]
    assert client.post("/v1/graph/recalculate").json()["changed_plot_ids"] == []
    assert db.execute("select count(*) from risk_evaluations").fetchone()[0] == before


def test_report_raises_plot_and_neighbors(client, db):
    before = nodes(client)
    assert edge(client, "plot_demo_02", "plot_demo_04")["exposure_strength"] is None

    resp = client.post("/v1/reports", headers={"Idempotency-Key": f"key-{uuid.uuid4()}"}, json={
        "session_id": "s-graph", "plot_id": "plot_demo_02", "channel": "voice",
        "symptoms": ["polvo naranja en el envés"], "completeness": "sufficient", "is_demo": True,
    })
    assert resp.status_code == 201

    after = nodes(client)
    assert before["plot_demo_02"]["inspection_priority"] == "medium"
    assert after["plot_demo_02"]["inspection_priority"] == "high"
    assert after["plot_demo_02"]["evidence_report_ids"] == [resp.json()["report_id"]]
    assert "Reporte directo activo" in after["plot_demo_02"]["reasons"]
    # Neighbour 04 gains exposure from the new source case; far plots (Huatusco) are untouched.
    assert after["plot_demo_04"]["score"] > before["plot_demo_04"]["score"]
    assert edge(client, "plot_demo_02", "plot_demo_04")["exposure_strength"] is not None
    assert after["plot_demo_05"]["risk_evaluation_id"] == before["plot_demo_05"]["risk_evaluation_id"]

    status = db.execute("select processing_status from reports where id = %s",
                        (resp.json()["report_id"],)).fetchone()[0]
    assert status == "processed"
    changed = db.execute("select count(*) from outbox_events where event_type = 'risk.updated' "
                         "and payload->>'plot_id' = 'plot_demo_02'").fetchone()[0]
    assert changed >= 1
