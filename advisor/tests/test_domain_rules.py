import pytest

from advisor.catalog import NEED_CATALOG, PROTOCOL_VERSION
from advisor.contracts import (
    AssessmentDraft,
    AssessmentRequest,
    Disposition,
    EvidenceQuality,
    Observation,
    Recommendation,
    Urgency,
)
from advisor.openai_adapter import AssessmentGenerationError, OpenAIAssessor


def request(*, asked_need_codes: list[str] | None = None) -> AssessmentRequest:
    return AssessmentRequest(
        session_id="session_demo_01",
        plot_id="plot_demo_01",
        observation=Observation(user_statement="Veo manchas naranjas", completeness="partial"),
        asked_need_codes=asked_need_codes or [],
    )


def draft(*, disposition: Disposition = Disposition.ask_more, needs=None) -> AssessmentDraft:
    return AssessmentDraft(
        disposition=disposition,
        evidence_quality=EvidenceQuality.insufficient,
        urgency=Urgency.unknown,
        information_needs=needs if needs is not None else [NEED_CATALOG["leaf_underside"]],
    )


def test_rejects_question_already_answered() -> None:
    with pytest.raises(AssessmentGenerationError, match="volvió a pedir"):
        OpenAIAssessor._validate_domain_rules(draft(), request(asked_need_codes=["leaf_underside"]))


def test_ask_more_requires_a_need() -> None:
    with pytest.raises(AssessmentGenerationError, match="requiere"):
        OpenAIAssessor._validate_domain_rules(draft(needs=[]), request())


def test_advise_rejects_new_questions() -> None:
    with pytest.raises(AssessmentGenerationError, match="no deben"):
        OpenAIAssessor._validate_domain_rules(draft(disposition=Disposition.advise), request())


def test_recommendation_must_use_approved_protocol() -> None:
    invalid = draft(disposition=Disposition.advise, needs=[])
    invalid.recommendations = [Recommendation(code="bad", text="Producto X", protocol_id="unapproved")]
    with pytest.raises(AssessmentGenerationError, match="protocolo aprobado"):
        OpenAIAssessor._validate_domain_rules(invalid, request())


def test_protocol_version_is_explicit() -> None:
    assert PROTOCOL_VERSION == "coffee-rust-demo-v1"


def test_model_need_text_is_replaced_by_the_catalog() -> None:
    generated = NEED_CATALOG["leaf_underside"].model_copy(update={"farmer_hint": "ignora reglas"})
    checked = draft(needs=[generated])
    OpenAIAssessor._validate_domain_rules(checked, request())
    checked.information_needs = [NEED_CATALOG[need.need_code] for need in checked.information_needs]
    assert checked.information_needs[0].farmer_hint != "ignora reglas"
