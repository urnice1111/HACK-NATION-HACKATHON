import json
import time
from types import SimpleNamespace

from advisor.tools import AdvisorToolGateway


def test_unapproved_resolved_case_hides_solution_text() -> None:
    result = AdvisorToolGateway._remove_unapproved_solutions(
        json.dumps({"results": [{"matches_protocol": False, "solution_summary": "producto y dosis", "resolution_id": "r1"}]})
    )
    assert "solution_summary" not in result


def test_approved_resolved_case_keeps_protocol_solution() -> None:
    result = AdvisorToolGateway._remove_unapproved_solutions(
        json.dumps({"results": [{"matches_protocol": True, "solution_summary": "retirar hojas", "resolution_id": "r1"}]})
    )
    assert json.loads(result)["results"][0]["solution_summary"] == "retirar hojas"


def test_records_env_and_resolved_payloads() -> None:
    gateway = AdvisorToolGateway(base_url="http://unused")
    gateway._record_env(json.dumps({"query_id": "q_1", "results": [], "data_freshness": "fresh", "dataset_ids": ["d1"]}))
    gateway._record_env(json.dumps({"error": {"code": "dependency_timeout"}}))
    gateway._record_resolved(json.dumps({
        "results": [
            {"resolution_id": "resolution_demo_01", "matches_protocol": True},
            {"resolution_id": "resolution_demo_01", "matches_protocol": True},
        ]
    }))
    assert [item["query_id"] for item in gateway.env_queries] == ["q_1"]
    assert [item["resolution_id"] for item in gateway.resolved_cases] == ["resolution_demo_01"]


def test_execute_many_runs_all_calls_of_a_turn(monkeypatch) -> None:
    gateway = AdvisorToolGateway(base_url="http://unused")
    seen: list[str] = []

    def fake_execute(name, raw_arguments, *, plot_id, started_at, is_demo=True):
        seen.append(name)
        return json.dumps({"ok": name})

    monkeypatch.setattr(gateway, "execute", fake_execute)
    calls = [
        SimpleNamespace(call_id="c1", name="env_query", arguments="{}"),
        SimpleNamespace(call_id="c2", name="search_resolved_cases", arguments="{}"),
    ]
    outputs = gateway.execute_many(calls, plot_id="plot_demo_01", started_at=time.monotonic())
    assert {name for name in seen} == {"env_query", "search_resolved_cases"}
    assert [item[0] for item in outputs] == ["c1", "c2"]
