from advisor.mock_assessor import MockAssessor
from backend.app.routes.assessments import assess_observation
from contracts.models import AssessmentRequest, Observation, PlotContextLite


def request() -> AssessmentRequest:
    return AssessmentRequest(
        session_id="session_demo_01",
        plot_id="plot_demo_01",
        observation=Observation(symptoms=["manchas"], user_statement="Veo manchas en hojas"),
        plot_context=PlotContextLite(crop="coffee"),
        is_demo=True,
    )


def test_assessment_route_adapts_to_shared_contract(monkeypatch) -> None:
    monkeypatch.setattr("backend.app.routes.assessments.build_assessor", lambda: MockAssessor())
    response = assess_observation(request())
    assert response.disposition == "ask_more"
    assert [need.need_code for need in response.information_needs] == ["leaf_underside", "affected_extent"]
    assert response.protocol_version == "coffee-rust-demo-v1"
