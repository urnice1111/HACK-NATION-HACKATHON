"""Pydantic models for the v2 HTTP contracts (INSTRUCTIONS.md sections 8-11).

Unknown values are `None`, never 0. Request bodies reject unknown fields.
"""

from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, model_validator

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
PhoneE164 = Annotated[str, Field(pattern=r"^\+[1-9][0-9]{1,14}$")]


def _utc_z(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ISO 8601 in UTC with a "Z" suffix (communications validates with zod `iso.datetime({offset: false})`).
UtcDatetime = Annotated[datetime, PlainSerializer(_utc_z, return_type=str)]


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
    value: float | str | None
    unit: str = Field(min_length=1)
    sample_type: str  # suggested: SampleType values (soil, irrigation_water, leaf, other)
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


# --- Contact resolution, consents and plot context ---------------------------------------
# Shapes agreed with integrante 1 (communications/src/contracts/resources.ts).


class ContactResolutionRequest(Request):
    """Step 1 without confirm_candidate_token -> candidates. Step 2 with it -> confirmed farmer."""

    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    phone_e164: PhoneE164
    channel: Literal["voice", "sms"] = "voice"
    confirm_candidate_token: str | None = None
    is_demo: bool = True


class ContactCandidate(Response):
    """Minimal label to ask "¿hablo con…?"; nothing else from the record."""

    candidate_token: str
    label: str


class ContactConsent(Response):
    """null = never asked; false = denied or revoked."""

    reports: bool | None
    notifications: bool | None
    followup_calls: bool | None
    consent_at: UtcDatetime | None


class ConfirmedPlot(Response):
    plot_id: str
    label: str


class ConfirmedFarmer(Response):
    farmer_id: str
    preferred_language: str
    timezone: str
    consent: ContactConsent
    plots: list[ConfirmedPlot]


class ContactResolutionResponse(Response):
    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    resolution_status: Literal["no_match", "candidates", "confirmed"]
    requires_confirmation: bool
    is_shared_phone: bool
    candidates: list[ContactCandidate]
    confirmed: ConfirmedFarmer | None
    is_demo: bool


class ConsentRequest(Request):
    """Each permission null = not asked in this session (previous value kept)."""

    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    farmer_id: str
    channel: Literal["voice", "sms"]
    reports: bool | None = None
    notifications: bool | None = None
    followup_calls: bool | None = None
    provider_reference: str | None = None
    is_demo: bool = True


class ConsentRecorded(Response):
    farmer_id: str
    consent: ContactConsent
    is_demo: bool


RevocableScope = Literal["notifications", "followup_calls"]


class ConsentRevocationRequest(Request):
    """"BAJA" by SMS revokes for every contact with that phone."""

    schema_version: SchemaVersion = SCHEMA_VERSION
    phone_e164: PhoneE164
    channel: Literal["sms"] = "sms"
    scopes: list[RevocableScope] = Field(min_length=1)
    provider_reference: str | None = None
    is_demo: bool = True


class ConsentRevoked(Response):
    contacts_updated: int
    scopes: list[RevocableScope]
    is_demo: bool


class ActiveCase(Response):
    case_id: str
    threat_code: str
    status: str
    opened_at: UtcDatetime
    last_observation_at: UtcDatetime | None


class PendingFollowup(Response):
    followup_id: str
    case_id: str
    due_at: UtcDatetime
    status: str


class EnvFeature(Response):
    name: str
    value: float | None
    unit: str


class EnvironmentSummary(Response):
    computed_at: UtcDatetime
    data_freshness: DataFreshness
    features: list[EnvFeature]
    dataset_ids: list[str] = []


class PlotContext(Response):
    """No coordinates or contact data: this goes to the voice agent."""

    schema_version: SchemaVersion = SCHEMA_VERSION
    plot_id: str
    label: str
    crop: str | None
    variety: str | None
    altitude_m: float | None
    data_freshness: DataFreshness
    environment_summary: EnvironmentSummary | None
    active_cases: list[ActiveCase]
    pending_followups: list[PendingFollowup]
    is_demo: bool


class PlotTimelineEvent(Response):
    """One thing that happened on the plot. No phone or farmer name."""

    event_id: str
    event_type: Literal[
        "report.created",
        "risk.updated",
        "followup.due",
        "followup.responded",
        "case.resolved",
    ]
    occurred_at: UtcDatetime
    summary: str
    threat_code: str | None
    case_id: str | None
    report_id: str | None
    followup_id: str | None
    resolution_id: str | None
    is_demo: bool


class PlotTimeline(Response):
    schema_version: SchemaVersion = SCHEMA_VERSION
    plot_id: str
    events: list[PlotTimelineEvent]
    next_cursor: str | None = None
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


class PlotAssessment(Response):
    """Dashboard view of a stored assessment: what the advisor looked at and said."""

    assessment_id: str
    report_id: str | None
    created_at: UtcDatetime
    disposition: Disposition
    suspected_issue: SuspectedIssue | None = None
    evidence_quality: EvidenceQuality
    urgency: Urgency
    data_used: list[DataUsed] = []
    resolved_case_mentions: list[ResolvedCaseMention] = []
    recommendations: list[Recommendation] = []
    human_review_required: bool
    model_version: str
    protocol_version: str
    is_demo: bool


class PlotAssessmentList(Response):
    schema_version: SchemaVersion = SCHEMA_VERSION
    assessments: list[PlotAssessment]


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
    resolved_at: UtcDatetime
    days_to_resolution: int | None
    solution_summary: str
    solution_codes: list[str] | None
    matches_protocol: bool | None
    verification: Verification


class ResolvedCaseSearchResponse(Response):
    results: list[ResolvedCaseResult]


class ResolutionOut(Response):
    """Dashboard view (operators only): includes the plot, unlike the advisor search."""

    resolution_id: str
    case_id: str
    plot_id: str
    plot_label: str
    threat_code: str
    symptoms: list[str]
    resolved_at: UtcDatetime
    solution_statement: str | None
    solution_codes: list[str] | None
    matches_protocol: bool | None
    outcome: str
    verification: Verification
    followup_id: str | None
    verified_by: str | None
    is_demo: bool


class ResolutionList(Response):
    schema_version: SchemaVersion = SCHEMA_VERSION
    resolutions: list[ResolutionOut]


# --- 10.4 Follow-up responses ------------------------------------------------------


class FollowupCaseSummary(Response):
    """Dynamic variables for the follow-up voice agent."""

    farmer_name: str
    threat_code: str
    case_status: str
    opened_at: UtcDatetime
    symptoms: list[str]
    guidance_given: str | None


class AllowedHours(Response):
    start: str
    end: str


class FollowupContact(Response):
    phone_e164: str
    preferred_language: str
    timezone: str
    allowed_hours: AllowedHours | None
    followup_call_consent: bool
    notification_consent: bool


class FollowupListItem(Response):
    followup_id: str
    case_id: str
    plot_id: str
    due_at: UtcDatetime
    status: str
    channel: Literal["voice", "sms"]
    attempt_count: int
    questionnaire_version: str
    call_reference: str | None
    case_summary: FollowupCaseSummary
    contact: FollowupContact
    is_demo: bool


class FollowupList(Response):
    schema_version: SchemaVersion = SCHEMA_VERSION
    followups: list[FollowupListItem]
    next_cursor: str | None = None
    is_demo: bool


class FollowupAttemptRequest(Request):
    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    status: Literal["contacting", "no_response", "failed"]
    channel: Literal["voice", "sms"]
    call_reference: str | None = None
    occurred_at: datetime
    is_demo: bool = True


class FollowupAttemptRecorded(Response):
    followup_id: str
    status: str
    attempt_count: int
    is_demo: bool


class FollowUpResponseRequest(Request):
    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    channel: Literal["voice", "sms"]
    status_reported: StatusReported
    user_statement: str
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
    next_followup_at: UtcDatetime | None


# --- 10.5 Reports ----------------------------------------------------------------


class ReportCreate(Request):
    schema_version: SchemaVersion = SCHEMA_VERSION
    session_id: str
    # null = minimal registration from an unknown number; never a random plot.
    plot_id: str | None
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
    case_id: str | None
    received_at: UtcDatetime
    processing_status: ProcessingStatus
    correlation_id: str


class ReportMeasurement(Response):
    name: str
    value: float | str | None
    unit: str
    sample_type: str
    measured_at: UtcDatetime | None
    method: str | None
    source: MeasurementSource


class ReportDetail(Response):
    report_id: str
    case_id: str | None
    plot_id: str | None
    session_id: str
    channel: Channel
    provider_reference: str | None
    observed_at: UtcDatetime | None
    received_at: UtcDatetime
    symptoms: list[str]
    measurements: list[ReportMeasurement]
    user_statement: str
    completeness: Completeness
    assessment_id: str | None
    processing_status: ProcessingStatus
    created_at: UtcDatetime
    is_demo: bool


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
    generated_at: UtcDatetime
    threat_code: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]


# --- 10.7 Alert review ----------------------------------------------------------------


class AlertReview(Request):
    decision: AlertDecision
    expected_version: int = Field(ge=1)
    reason: str | None = None
    message: str | None = None


class AlertNotification(Response):
    notification_id: str
    channel: str
    status: str
    attempt_count: int
    last_error: str | None


class AlertOut(Response):
    """Alert for the operator queue. Recipient is a label only; no phone numbers."""

    alert_id: str
    plot_id: str
    plot_label: str
    recipient_label: str
    threat_code: str
    status: str
    version: int
    message: str | None
    inspection_priority: InspectionPriority
    score: Unit | None
    reasons: list[str] = []
    risk_evaluation_id: str
    created_at: UtcDatetime
    review_reason: str | None
    approved_by: str | None
    approved_at: UtcDatetime | None
    notifications: list[AlertNotification] = []
    is_demo: bool


class AlertList(Response):
    schema_version: SchemaVersion = SCHEMA_VERSION
    alerts: list[AlertOut]


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
    occurred_at: UtcDatetime
    aggregate_id: str
    aggregate_version: int
    correlation_id: str | None
    is_demo: bool
    payload: dict[str, Any]
