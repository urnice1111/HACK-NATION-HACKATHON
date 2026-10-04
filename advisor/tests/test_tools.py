import json

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
