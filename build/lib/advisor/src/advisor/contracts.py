"""Modelos Pydantic del contrato v2 de assessments.

Este módulo es la validación final: aunque OpenAI devuelva Structured Outputs,
la aplicación no confía en la red ni en un modelo para validar su propia salida.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AnswerType(StrEnum):
    yes_no = "yes_no"
    number_with_unit = "number_with_unit"
    choice = "choice"
    free_text = "free_text"


class Disposition(StrEnum):
    ask_more = "ask_more"
    advise = "advise"
    refer = "refer"


class EvidenceQuality(StrEnum):
    insufficient = "insufficient"
    low = "low"
    medium = "medium"
    high = "high"


class Urgency(StrEnum):
    unknown = "unknown"
    routine = "routine"
    soon = "soon"
    urgent = "urgent"


class NeedDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    need_code: str
    variable: str
    reason: str
    farmer_hint: str
    answer_type: AnswerType
    options: list[str] | None
    priority: int = Field(ge=1, le=99)
    can_be_unknown: bool


class ObservationAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    need_code: str
    value: Any | None = None
    unit: str | None = None
    raw_text: str | None = None
    unknown: bool = False


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observed_at: str | None = None
    symptoms: list[str] = Field(default_factory=list)
    user_statement: str | None = None
    measurements: list[dict[str, Any]] = Field(default_factory=list)
    answers: list[ObservationAnswer] = Field(default_factory=list)
    completeness: str = "partial"


class AssessmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = "2.0"
    session_id: str
    plot_id: str
    language: str = "es"
    observation: Observation
    asked_need_codes: list[str] = Field(default_factory=list)
    # The shared contract allows null (PlotContextLite | None).
    plot_context: dict[str, Any] | None = Field(default_factory=dict)
    is_demo: bool = True


class SuspectedIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    label: str
    certainty: str = "suspected"


class DataUsed(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query_id: str
    summary: str
    data_freshness: str
    dataset_ids: list[str] = Field(default_factory=list)


class Recommendation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    text: str
    protocol_id: str
    source_ids: list[str] = Field(default_factory=list)


class ResolvedCaseMention(BaseModel):
    model_config = ConfigDict(extra="forbid")

    resolution_id: str
    summary_for_speech: str
    verification: str


class AssessmentDraft(BaseModel):
    """Parte propuesta por el modelo; el servidor agrega IDs y versiones."""

    model_config = ConfigDict(extra="forbid")

    disposition: Disposition
    suspected_issue: SuspectedIssue | None = None
    evidence_quality: EvidenceQuality
    urgency: Urgency
    information_needs: list[NeedDefinition] = Field(default_factory=list)
    data_used: list[DataUsed] = Field(default_factory=list)
    resolved_case_mentions: list[ResolvedCaseMention] = Field(default_factory=list)
    recommendations: list[Recommendation] = Field(default_factory=list)
    human_review_required: bool = False
    source_ids: list[str] = Field(default_factory=list)
    context_stale: bool = False


class AssessmentResponse(AssessmentDraft):
    """Respuesta pública completa y validada."""

    schema_version: str = "2.0"
    assessment_id: str
    model_version: str
    protocol_version: str
