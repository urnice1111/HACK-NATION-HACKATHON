import pytest

from advisor.catalog import NEED_CATALOG, PROTOCOL_VERSION, need_definition, resolved_case_speech
from advisor.contracts import AssessmentRequest, DataUsed, Disposition, EvidenceQuality, Observation, ObservationAnswer, Urgency
from advisor.anthropic_adapter import ANTHROPIC_TOOLS, AnthropicAssessor
from advisor.assessment import AssessmentGenerationError, ModelDraft, NeedChoice, build_response, default_queries
from advisor.openai_adapter import OpenAIAssessor
from advisor.tools import ToolResult


def request(*, language: str = "en", asked_need_codes: list[str] | None = None, answers=None) -> AssessmentRequest:
    return AssessmentRequest(
        session_id="session_demo_01",
        plot_id="plot_demo_01",
        language=language,
        observation=Observation(user_statement="I see yellow spots on the leaves", answers=answers or []),
        asked_need_codes=asked_need_codes or [],
    )


def draft(*, disposition: Disposition = Disposition.ask_more, needs=None, **extra) -> ModelDraft:
    return ModelDraft(
        disposition=disposition,
        suspected_issue_code=extra.pop("suspected_issue_code", None),
        evidence_quality=EvidenceQuality.insufficient,
        urgency=Urgency.unknown,
        information_needs=needs if needs is not None else [NeedChoice(need_code="leaf_underside", reason="Separates rust from leaf spot")],
        human_review_required=False,
        **extra,
    )


ENV = ToolResult("env_query", "{}", data_used=DataUsed(query_id="q_1", summary="average relative humidity 88 %",
                                                       data_freshness="fresh", dataset_ids=["nasa_power"]))
CASES = ToolResult("search_resolved_cases", "{}", resolved_cases={
    "resolution_demo_01": {"resolution_id": "resolution_demo_01", "distance_band": "más de 20 km",
                           "solution_codes": ["remove_affected_leaves", "regulate_shade"], "verification": "verified"},
})
CONTEXT = ToolResult("get_external_context", "{}", source_ids=["ctx_cenicafe_roya_sintomas"])


def build(d: ModelDraft, req: AssessmentRequest, results=(ENV, CASES, CONTEXT), remaining: int = 5):
    return build_response(d, req, list(results), "es" if req.language.startswith("es") else "en", remaining, "test-model")


def test_ask_more_uses_english_catalog_and_real_data_used() -> None:
    response = build(draft(), request())
    need = response.information_needs[0]
    assert response.disposition == "ask_more"
    assert need.options == ["orange or yellow powder", "white fuzz", "insects or tunnels", "nothing", "don't know"]
    assert need.reason == "Separates rust from leaf spot"
    assert need.priority == 1
    assert [d.query_id for d in response.data_used] == ["q_1"]
    assert response.recommendations == [] and response.resolved_case_mentions == []


def test_spanish_keeps_the_same_codes_and_option_order() -> None:
    response = build(draft(), request(language="es"))
    assert response.information_needs[0].options == NEED_CATALOG["leaf_underside"].options
    assert len(response.information_needs[0].options) == len(need_definition("leaf_underside", "en").options)


def test_already_answered_needs_are_dropped() -> None:
    needs = [NeedChoice(need_code="leaf_underside", reason="x"), NeedChoice(need_code="affected_extent", reason="y")]
    response = build(draft(needs=needs), request(asked_need_codes=["leaf_underside"]))
    assert [n.need_code for n in response.information_needs] == ["affected_extent"]


def test_ask_more_with_only_repeated_needs_fails() -> None:
    with pytest.raises(AssessmentGenerationError):
        build(draft(), request(asked_need_codes=["leaf_underside"]))


def test_question_limit_turns_ask_more_into_refer() -> None:
    response = build(draft(), request(), remaining=0)
    assert response.disposition == "refer" and response.human_review_required
    assert response.information_needs == []


def test_advise_renders_protocol_text_and_a_safe_case_mention() -> None:
    advise = draft(disposition=Disposition.advise, needs=[], suspected_issue_code="coffee_leaf_rust",
                   recommendation_codes=["remove_affected_leaves", "regulate_shade"],
                   resolved_case_ids=["resolution_demo_01"], source_ids=["ctx_cenicafe_roya_sintomas", "invented"])
    response = build(advise, request(answers=[ObservationAnswer(need_code="leaf_underside", value="orange or yellow powder")]))
    assert response.disposition == "advise"
    assert response.suspected_issue.label == "Possible coffee leaf rust"
    assert {r.protocol_id for r in response.recommendations} == {PROTOCOL_VERSION}
    assert response.recommendations[0].text.startswith("Remove the leaves")
    assert response.source_ids == ["ctx_cenicafe_roya_sintomas"]
    mention = response.resolved_case_mentions[0]
    assert mention.resolution_id == "resolution_demo_01" and mention.verification == "verified"
    assert mention.summary_for_speech == ("A farmer with a similar case in the wider area said their plants "
                                          "improved after removing the affected leaves and adjusting the shade")


def test_invented_case_ids_are_never_mentioned() -> None:
    advise = draft(disposition=Disposition.advise, needs=[], recommendation_codes=["remove_affected_leaves"],
                   resolved_case_ids=["resolution_made_up"])
    assert build(advise, request()).resolved_case_mentions == []


def test_advise_requires_a_recommendation() -> None:
    with pytest.raises(AssessmentGenerationError):
        build(draft(disposition=Disposition.advise, needs=[]), request())


def test_refer_always_requires_human_review() -> None:
    response = build(draft(disposition=Disposition.refer, needs=[]), request())
    assert response.human_review_required is True


def test_failed_queries_mark_context_stale() -> None:
    failed = ToolResult("env_query", '{"error": {"code": "dependency_timeout"}}', stale=True)
    assert build(draft(), request(), results=[failed]).context_stale is True


def test_case_speech_only_uses_protocol_practices() -> None:
    assert resolved_case_speech(["copper_fungicide"], "menos de 5 km", "en") is None
    assert "fungicide" not in (resolved_case_speech(["copper_fungicide", "weed_control"], "menos de 5 km", "en") or "")


def test_default_queries_stay_within_the_limit() -> None:
    names = [name for name, _ in default_queries(request())]
    assert names == ["env_query", "search_resolved_cases", "get_external_context"]


@pytest.mark.parametrize("assessor", [OpenAIAssessor, AnthropicAssessor])
def test_missing_key_is_an_error_not_guidance(assessor) -> None:
    with pytest.raises(AssessmentGenerationError):
        assessor(api_key="", model="test-model").assess(request())


def test_claude_tools_are_strict_and_keep_the_same_names() -> None:
    assert [t["name"] for t in ANTHROPIC_TOOLS] == ["env_query", "search_resolved_cases", "get_external_context"]
    assert all(t["strict"] and t["input_schema"]["additionalProperties"] is False for t in ANTHROPIC_TOOLS)


def test_protocol_version_is_explicit() -> None:
    assert PROTOCOL_VERSION == "coffee-rust-demo-v1"
