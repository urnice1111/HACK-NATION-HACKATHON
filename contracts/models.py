"""Pydantic models for the v2 HTTP contracts (INSTRUCTIONS.md sections 8-11).

Unknown values are `None`, never 0. Request bodies reject unknown fields.
"""

from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from contracts.enums import (
    SCHEMA_VERSION,
    ActionWorked,
    AlertDecision,
    Aggregation,
    AnswerType,
    Channel,
    Completeness,
    DataFreshness,
    Disposition,
    EvidenceQuality,
    InspectionPriority,
    LocalCaseStatus,
    MeasurementSource,
    ProcessingStatus,
    SampleType,
    StatusReported,
    Urgency,
    Verification,
)

Unit = Annotated[float, Field(ge=0, le=1)]
Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]
SchemaVersion = Literal["2.0"]


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Response(BaseModel):
    model_config = ConfigDict(extra="ignore")


# --- Errors ---------------------------------------------------------------


class ErrorDetail(Response):
    field: str
    reason: str


class ErrorBody(Response):
    code: str
    message: str
    retryable: bool
    request_id: str
    details: list[ErrorDetail] = []


class ErrorResponse(Response):
    error: ErrorBody


# --- Shared pieces ----------------------------------------------------------


class Measurement(Request):
    name: str
    value: float | None
    unit: str | None
    sample_type: SampleType
    measured_at: datetime | None = None
    method: str | None = None
    source: MeasurementSource = MeasurementSource.farmer_reported


class Answer(Request):
    need_code: str
    value: str | float | bool | None
    unit: str | None = None
    raw_text: str | None = None
    unknown: bool = False

    @model_validator(mode="after")
    def unknown_has_no_value(self):
        if self.unknown and self.value is not None:
            raise ValueError("unknown answers must have value=null")
        return self


# --- Contact resolution and plot context ----------------------------------------------


class ContactResolutionRequest(Request):
    phone_e164: str = Field(pattern=r"^\+[1-9][0-9]{7,14}$")
    session_id: str


class ContactCandidate(Response):
    """Minimal label only; personal data is released after confirmation."""

    candidate_token: str
    label: str


class ContactResolutionResponse(Response):
    candidates: list[ContactCandidate]
    requires_confirmation: bool


class ContactConfirmRequest(Request):
    candidate_token: str
    session_id: str


class ConfirmedPlot(Response):
    plot_id: str
    name: str


class ContactConfirmResponse(Response):
    farmer_id: str
    farmer_name: str
    preferred_language: str
    plots: list[ConfirmedPlot]
    notification_consent: bool
    followup_call_consent: bool


class ActiveCase(Response):
    case_id: str
    threat_code: str
    status: str
    opened_at: datetime
    last_observation_at: datetime | None


class CurrentRisk(Response):
    threat_code: str
    inspection_priority: InspectionPriority
    score: Unit | None
    reasons: list[str] = []
    model_version: str | None
    heuristic: bool


class EnvironmentSummary(Response):
    computed_at: datetime | None
    features: dict[str, Any]
    data_freshness: DataFreshness


class PlotContext(Response):
    plot_id: str
    name: str
    crop: str | None
    variety: str | None
    altitude_m: float | None
    active_cases: list[ActiveCase]
    risk: list[CurrentRisk]
    environment_summary: EnvironmentSummary
    is_demo: bool


# --- 10.1 Assessments ---------------------------------------------------------


class Observation(Request):
    observed_at: datetime | None = None
    symptoms: list[str] = []
    user_statement: str | None = None
    measurements: list[Measurement] = []
    answers: list[Answer] = []
    completeness: Completeness = Completeness.partial


class PlotContextLite(Request):
    crop: str | None = None
    variety: str | None = None


class AssessmentRequest(Request):
    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    plot_id: str
    language: str = "es"
    observation: Observation
    asked_need_codes: list[str] = []
    plot_context: PlotContextLite | None = None
    is_demo: bool


class InformationNeed(Response):
    need_code: str
    variable: str
    reason: str
    farmer_hint: str
    answer_type: AnswerType
    options: list[str] | None = None
    priority: int = Field(ge=1)
    can_be_unknown: bool = True


class DataUsed(Response):
    query_id: str
    summary: str
    data_freshness: DataFreshness
    dataset_ids: list[str] = []


class ResolvedCaseMention(Response):
    resolution_id: str
    summary_for_speech: str
    verification: Verification


class Recommendation(Response):
    code: str
    text: str
    protocol_id: str
    source_ids: list[str] = []


class SuspectedIssue(Response):
    code: str
    label: str
    certainty: Literal["suspected"] = "suspected"


class AssessmentResponse(Response):
    schema_version: SchemaVersion = SCHEMA_VERSION
    assessment_id: str
    disposition: Disposition
    suspected_issue: SuspectedIssue | None = None
    evidence_quality: EvidenceQuality
    urgency: Urgency
    information_needs: list[InformationNeed] = []
    data_used: list[DataUsed] = []
    resolved_case_mentions: list[ResolvedCaseMention] = []
    recommendations: list[Recommendation] = []
    human_review_required: bool = False
    source_ids: list[str] = []
    context_stale: bool = False
    model_version: str
    protocol_version: str


# --- 10.2 Environment query (owner: integrante 4) ---------------------------------


class PlotTarget(Request):
    plot_id: str


class PointTarget(Request):
    latitude: Latitude
    longitude: Longitude


class EnvVariableSpec(Request):
    code: str
    aggregation: Aggregation


class EnvWindow(Request):
    days_back: int = Field(ge=1, le=365)
    end_date: date | None = None


class EnvQueryRequest(Request):
    schema_version: SchemaVersion = SCHEMA_VERSION
    query_id: str
    requested_by: str
    target: PlotTarget | PointTarget
    variables: list[EnvVariableSpec] = Field(min_length=1, max_length=5)
    window: EnvWindow
    compare_to_normal: bool = False
    is_demo: bool


class EnvResult(Response):
    code: str
    unit: str
    aggregation: Aggregation
    value: float | None
    normal: float | None = None
    anomaly_ratio: float | None = None
    coverage: Unit
    missing_days: int = Field(ge=0)


class EnvQueryResponse(Response):
    query_id: str
    cell_id: str | None
    distance_km: float | None
    results: list[EnvResult]
    data_freshness: DataFreshness
    latest_data_date: date | None
    dataset_ids: list[str] = []
    is_demo: bool


# --- 10.3 Resolved cases search -------------------------------------------------


class ResolvedCaseSearchRequest(Request):
    threat_code: str
    symptoms: list[str] = []
    near_plot_id: str | None = None
    max_distance_km: float = Field(default=20, gt=0)
    only_verified: bool = False
    limit: int = Field(default=5, ge=1, le=20)


class ResolvedCaseResult(Response):
    """Never carries plot_id, farmer name, phone or coordinates."""

    resolution_id: str
    threat_code: str
    similarity: Unit
    distance_band: str | None
    resolved_at: datetime
    days_to_resolution: int | None
    solution_summary: str
    solution_codes: list[str] | None
    matches_protocol: bool | None
    verification: Verification


class ResolvedCaseSearchResponse(Response):
    results: list[ResolvedCaseResult]


# --- 10.4 Follow-up responses ------------------------------------------------------


class FollowUpResponseRequest(Request):
    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    channel: Channel
    status_reported: StatusReported
    user_statement: str | None = None
    actions_taken: str | None = None
    action_worked: ActionWorked = ActionWorked.unknown
    change_noticed_at: datetime | None = None
    provider_reference: str | None = None
    is_demo: bool


class FollowUpResponseResult(Response):
    report_id: str
    case_id: str
    case_status: str
    resolution_id: str | None
    next_followup_at: datetime | None


# --- 10.5 Reports ----------------------------------------------------------------


class ReportCreate(Request):
    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    plot_id: str
    case_id: str | None = None
    channel: Channel
    provider_reference: str | None = None
    observed_at: datetime | None = None
    symptoms: list[str] = []
    measurements: list[Measurement] = []
    user_statement: str | None = None
    completeness: Completeness
    assessment_id: str | None = None
    is_demo: bool


class ReportCreated(Response):
    report_id: str
    case_id: str
    received_at: datetime
    processing_status: ProcessingStatus
    correlation_id: str


# --- 10.6 Graph --------------------------------------------------------------------


class Contribution(Response):
    feature: str
    value: float


class GraphNode(Response):
    id: str
    label: str
    latitude: Latitude
    longitude: Longitude
    inspection_priority: InspectionPriority
    score: Unit | None
    contributions: list[Contribution] = []
    model_version: str | None
    local_case_status: LocalCaseStatus
    data_freshness: DataFreshness
    risk_evaluation_id: str | None
    reasons: list[str] = []
    evidence_report_ids: list[str] = []
    heuristic: bool
    is_demo: bool


class GraphEdge(Response):
    id: str
    source: str
    target: str
    distance_km: float = Field(ge=0)
    environment_similarity: Unit | None
    exposure_type: str
    exposure_strength: Unit | None
    missing_features: list[str] = []
    rule_version: str


class GraphResponse(Response):
    schema_version: SchemaVersion = SCHEMA_VERSION
    graph_version: int
    generated_at: datetime
    threat_code: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]


# --- 10.7 Alert review ----------------------------------------------------------------


class AlertReview(Request):
    decision: AlertDecision
    expected_version: int = Field(ge=1)
    reason: str | None = None
    message: str | None = None


# --- Risk model artifact (producer: integrante 2) --------------------------------------


class RiskFeature(Request):
    name: str
    mean: float
    std: float = Field(gt=0)
    coef: float
    required: bool = True


class RiskTestVector(Request):
    input: dict[str, float | None]
    expected_score: float | None
    expected_priority: InspectionPriority


class RiskCutoffs(Request):
    medium: Unit
    high: Unit

    @model_validator(mode="after")
    def ordered(self):
        if self.medium >= self.high:
            raise ValueError("cutoffs.medium must be < cutoffs.high")
        return self


class RiskMetrics(Request):
    mae: float | None = None
    r2: float | None = None
    n_train: int | None = None
    n_test: int | None = None


class RiskModelArtifact(Request):
    model_id: str
    model_version: str
    threat_code: str
    target: str
    trained_at: datetime
    features: list[RiskFeature] = Field(min_length=1)
    intercept: float
    score_range: tuple[float, float] = (0.0, 1.0)
    cutoffs: RiskCutoffs
    metrics: RiskMetrics
    labels_are_synthetic: bool
    heuristic: bool
    test_vectors: list[RiskTestVector] = Field(min_length=1)


# --- 11. Outbox event ---------------------------------------------------------------


class OutboxEvent(Response):
    event_id: str
    schema_version: SchemaVersion = SCHEMA_VERSION
    event_type: str
    occurred_at: datetime
    aggregate_id: str
    aggregate_version: int
    correlation_id: str | None
    is_demo: bool
    payload: dict[str, Any]
