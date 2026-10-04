"""env_query (INSTRUCTIONS.md 10.2 y aceptación de la sección 7)."""

from datetime import date, timedelta

import pytest

from backend.app.routes.environment import aggregate, expected_normal

DS = "dataset_test_env"
CELL = "cell_test_env"
END = date(2026, 1, 20)


def query(variables, target=None, days_back=14, compare=True, end_date=END.isoformat()):
    return {
        "schema_version": "2.0", "query_id": "q_test", "requested_by": "advisor",
        "target": target or {"latitude": 0.1, "longitude": 0.1},
        "variables": variables, "window": {"days_back": days_back, "end_date": end_date},
        "compare_to_normal": compare, "is_demo": True,
    }


# --- Funciones puras: no necesitan base de datos -----------------------------------------


def test_aggregate():
    assert aggregate([1.0, 2.0, 3.0], "sum") == 6.0
    assert aggregate([1.0, 2.0, 3.0], "mean") == 2.0
    assert aggregate([1.0, 2.0, 3.0], "min") == 1.0
    assert aggregate([], "mean") is None


def test_normal_uses_month_of_each_day_and_skips_min_max():
    days = [date(2026, 1, 31), date(2026, 2, 1)]
    monthly = {1: 2.0, 2: 4.0}
    assert expected_normal(days, monthly, "sum") == 6.0
    assert expected_normal(days, monthly, "mean") == 3.0
    assert expected_normal(days, monthly, "max") is None
    assert expected_normal(days, {1: 2.0}, "sum") is None  # falta la normal de febrero: no se inventa


# --- Endpoint contra la base de demo -----------------------------------------------------


@pytest.fixture(scope="module")
def env_fixture():
    """Celda sintética en (0, 0), lejos de la región real. 20 días; el 2026-01-15 falta humedad."""
    from backend.app.config import settings
    import psycopg

    try:
        conn = psycopg.connect(settings.database_url, autocommit=True, connect_timeout=2)
    except psycopg.OperationalError:
        pytest.skip("demo database not running (docker compose up -d db)")
    with conn:
        conn.execute("insert into env.datasets (dataset_id, name, source, license, is_demo) "
                     "values (%s, 'test', 'test', 'test', true) on conflict do nothing", (DS,))
        conn.execute("insert into env.grid_cells values (%s, 0, 0, %s) on conflict do nothing", (CELL, DS))
        for code, unit, aggs in [("humidity_pct", "%", ["mean", "min", "max"]),
                                 ("precip_mm", "mm", ["sum", "mean", "min", "max"])]:
            conn.execute("insert into env.variable_catalog values (%s, %s, %s, 'test', 'daily', null, null, %s, %s) "
                         "on conflict do nothing", (code, code, unit, aggs, DS))
        for i in range(20):
            d = END - timedelta(days=i)
            conn.execute("insert into env.daily_observations values (%s, %s, 'precip_mm', 2.0, %s) "
                         "on conflict do nothing", (CELL, d, DS))
            if d != date(2026, 1, 15):
                conn.execute("insert into env.daily_observations values (%s, %s, 'humidity_pct', 80.0, %s) "
                             "on conflict do nothing", (CELL, d, DS))
        conn.execute("insert into env.climatology values (%s, 'precip_mm', 1, 1.0, null), "
                     "(%s, 'humidity_pct', 1, 64.0, null) on conflict do nothing", (CELL, CELL))
        yield
        conn.execute("delete from env.grid_cells where cell_id = %s", (CELL,))
        conn.execute("delete from env.variable_catalog where dataset_id = %s", (DS,))
        conn.execute("delete from env.datasets where dataset_id = %s", (DS,))


def test_valid_query_returns_value_normal_and_anomaly(client, env_fixture):
    r = client.post("/v1/environment/query", json=query(
        [{"code": "humidity_pct", "aggregation": "mean"}, {"code": "precip_mm", "aggregation": "sum"}]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cell_id"] == CELL
    assert body["latest_data_date"] == END.isoformat()
    humidity, precip = body["results"]
    assert humidity == {"code": "humidity_pct", "unit": "%", "aggregation": "mean", "value": 80.0,
                        "normal": 64.0, "anomaly_ratio": 1.25, "coverage": 0.93, "missing_days": 1}
    assert precip["value"] == 28.0 and precip["normal"] == 14.0 and precip["anomaly_ratio"] == 2.0
    assert body["dataset_ids"] == [DS]


def test_unknown_variable_is_422(client, env_fixture):
    r = client.post("/v1/environment/query", json=query([{"code": "lluvia_magica", "aggregation": "mean"}]))
    assert r.status_code == 422
    assert r.json()["error"]["details"] == [{"field": "variables[0].code", "reason": "unknown_variable"}]


def test_aggregation_not_in_catalog_is_422(client, env_fixture):
    r = client.post("/v1/environment/query", json=query([{"code": "humidity_pct", "aggregation": "sum"}]))
    assert r.status_code == 422
    assert r.json()["error"]["details"][0]["reason"] == "aggregation_not_allowed"


def test_point_outside_coverage_is_null_with_zero_coverage(client, env_fixture):
    r = client.post("/v1/environment/query", json=query(
        [{"code": "humidity_pct", "aggregation": "mean"}], target={"latitude": -45.0, "longitude": 120.0}))
    assert r.status_code == 200
    body = r.json()
    assert body["cell_id"] is None and body["data_freshness"] == "unknown"
    assert body["results"][0]["value"] is None
    assert body["results"][0]["coverage"] == 0 and body["results"][0]["missing_days"] == 14


def test_low_coverage_returns_null_not_partial_sum(client, env_fixture):
    r = client.post("/v1/environment/query", json=query([{"code": "precip_mm", "aggregation": "sum"}], days_back=60))
    result = r.json()["results"][0]
    assert result["value"] is None and result["coverage"] == 0.33


def test_unknown_plot_is_404(client, env_fixture):
    r = client.post("/v1/environment/query", json=query(
        [{"code": "humidity_pct", "aggregation": "mean"}], target={"plot_id": "nope"}))
    assert r.status_code == 404


# --- Catálogo, resumen por parcela y contexto externo ---------------------------------------


def test_catalog_lists_codes_units_and_aggregations(client, env_fixture):
    body = client.get("/v1/environment/catalog").json()
    variables = {v["code"]: v for v in body["variables"]}
    assert variables["humidity_pct"]["unit"] == "%"
    assert "sum" not in variables["humidity_pct"]["allowed_aggregations"]
    assert body["max_variables_per_query"] == 5


def test_environment_summary_without_data_is_null_not_zero(client):
    body = client.get("/v1/plots/plot_demo_08/environment-summary").json()
    assert body["environment_summary"] is None and body["data_freshness"] == "unknown"
    assert client.get("/v1/plots/nope/environment-summary").status_code == 404


@pytest.fixture
def external_rows(db):
    rows = [
        ("ctx_test_ok", "reviewed", "Veracruz", "coffee_leaf_rust", "1 day"),
        ("ctx_test_unreviewed", "unreviewed", "Veracruz", "coffee_leaf_rust", "1 day"),
        ("ctx_test_expired", "reviewed", "Veracruz", "coffee_leaf_rust", "-1 day"),
        ("ctx_test_other_threat", "reviewed", "Veracruz", "other_threat", "1 day"),
        ("ctx_test_other_region", "reviewed", "Chiapas", None, "1 day"),
    ]
    for source_id, quality, region, threat, valid in rows:
        db.execute(
            "insert into env.external_context (source_id, url, title, valid_until, region, data_type, content, "
            "quality_status, threat_code) values (%s, 'https://example.org', 't', now() + %s::interval, %s, "
            "'advisory', 'c', %s, %s) on conflict do nothing",
            (source_id, valid, region, quality, threat),
        )
    db.commit()
    yield
    db.execute("delete from env.external_context where source_id like 'ctx_test_%%'")
    db.commit()


def test_external_context_only_reviewed_valid_matching(client, external_rows):
    r = client.get("/v1/external-context", params={"region": "centro de Veracruz", "threat_code": "coffee_leaf_rust"})
    assert r.status_code == 200
    assert [i["source_id"] for i in r.json()["items"]] == ["ctx_test_ok"]
