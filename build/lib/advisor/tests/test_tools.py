import json

from advisor.tools import MAX_INTERNAL_QUERIES, AdvisorToolGateway, env_summary, protocol_cases


def test_unapproved_resolved_case_never_reaches_the_model() -> None:
    cases = protocol_cases({"results": [{"resolution_id": "r1", "matches_protocol": False,
                                         "solution_summary": "caldo bordelés 3 kilos", "solution_codes": ["copper_fungicide"]}]})
    assert cases == {}


def test_approved_case_keeps_only_protocol_codes_and_no_free_text() -> None:
    cases = protocol_cases({"results": [{"resolution_id": "r1", "matches_protocol": True, "verification": "verified",
                                         "solution_summary": "Retiró hojas", "solution_codes": ["remove_affected_leaves", "other"]}]})
    assert cases["r1"]["solution_codes"] == ["remove_affected_leaves"]
    assert "solution_summary" not in json.dumps(cases)


def test_env_summary_keeps_null_as_no_data() -> None:
    body = {"distance_km": 3.4, "results": [
        {"code": "humidity_pct", "unit": "%", "aggregation": "mean", "value": 88.1, "normal": 79.0},
        {"code": "precip_mm", "unit": "mm", "aggregation": "sum", "value": None, "normal": None},
    ]}
    summary = env_summary(body, 14, "en")
    assert summary == "average relative humidity 88.1 % (normal 79 %); total rainfall: no data (last 14 days, grid cell 3.4 km away)"
    assert "0 mm" not in summary


def test_extra_tool_calls_are_answered_but_not_run(monkeypatch) -> None:
    gateway = AdvisorToolGateway("http://backend.invalid")
    ran: list[str] = []
    monkeypatch.setattr(gateway, "execute", lambda name, args, **_: ran.append(name) or type("R", (), {"name": name})())
    results = gateway.execute_many([("env_query", "{}")] * (MAX_INTERNAL_QUERIES + 2), plot_id="p", language="en")
    assert len(ran) == MAX_INTERNAL_QUERIES
    assert len(results) == MAX_INTERNAL_QUERIES + 2
    assert "query_limit_reached" in results[-1].output


def test_invalid_variable_is_rejected_without_calling_the_backend() -> None:
    result = AdvisorToolGateway("http://backend.invalid").execute(
        "env_query", json.dumps({"variables": [{"code": "soil_ph", "aggregation": "mean"}], "days_back": 14}),
        plot_id="p", language="en")
    assert "variable_or_aggregation_not_allowed" in result.output
