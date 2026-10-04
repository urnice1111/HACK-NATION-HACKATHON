from enum import StrEnum

SCHEMA_VERSION = "2.0"
DEMO_THREAT_CODE = "coffee_leaf_rust"


class Channel(StrEnum):
    voice = "voice"
    sms = "sms"
    operator = "operator"


class Completeness(StrEnum):
    partial = "partial"
    sufficient = "sufficient"


class ProcessingStatus(StrEnum):
    pending = "pending"
    processed = "processed"
    failed = "failed"


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


class AnswerType(StrEnum):
    yes_no = "yes_no"
    number_with_unit = "number_with_unit"
    choice = "choice"
    free_text = "free_text"


class InspectionPriority(StrEnum):
    unknown = "unknown"
    low = "low"
    medium = "medium"
    high = "high"


class CaseStatus(StrEnum):
    reported = "reported"
    suspected = "suspected"
    confirmed = "confirmed"
    monitoring = "monitoring"
    resolved = "resolved"


class LocalCaseStatus(StrEnum):
    none = "none"
    reported = "reported"
    suspected = "suspected"
    confirmed = "confirmed"
    monitoring = "monitoring"
    resolved = "resolved"


class DataFreshness(StrEnum):
    fresh = "fresh"
    stale = "stale"
    unknown = "unknown"


class StatusReported(StrEnum):
    worse = "worse"
    same = "same"
    improved = "improved"
    resolved = "resolved"
    unknown = "unknown"


class ActionWorked(StrEnum):
    yes = "yes"
    no = "no"
    partial = "partial"
    unknown = "unknown"


class Verification(StrEnum):
    farmer_reported = "farmer_reported"
    verified = "verified"
    disputed = "disputed"


class ResolutionOutcome(StrEnum):
    resolved = "resolved"
    improved_enough = "improved_enough"


class RiskModelStatus(StrEnum):
    draft = "draft"
    active = "active"
    retired = "retired"


class AlertStatus(StrEnum):
    pending_review = "pending_review"
    approved = "approved"
    rejected = "rejected"
    queued = "queued"
    cancelled = "cancelled"


class AlertDecision(StrEnum):
    approve = "approve"
    reject = "reject"


class NotificationStatus(StrEnum):
    queued = "queued"
    sending = "sending"
    accepted = "accepted"
    delivered = "delivered"
    failed = "failed"
    unknown = "unknown"
    cancelled = "cancelled"


class FollowUpStatus(StrEnum):
    scheduled = "scheduled"
    contacting = "contacting"
    responded = "responded"
    no_response = "no_response"
    failed = "failed"
    cancelled = "cancelled"


class SampleType(StrEnum):
    soil = "soil"
    irrigation_water = "irrigation_water"
    leaf = "leaf"
    other = "other"


class MeasurementSource(StrEnum):
    farmer_reported = "farmer_reported"
    sensor = "sensor"
    technician = "technician"


class Aggregation(StrEnum):
    daily = "daily"
    weekly = "weekly"
    sum = "sum"
    mean = "mean"
    min = "min"
    max = "max"


class EventType(StrEnum):
    report_created = "report.created"
    assessment_completed = "assessment.completed"
    env_summary_refreshed = "env.summary_refreshed"
    risk_model_activated = "risk_model.activated"
    risk_updated = "risk.updated"
    alert_approved = "alert.approved"
    notification_status_changed = "notification.status_changed"
    followup_due = "followup.due"
    followup_responded = "followup.responded"
    case_resolved = "case.resolved"
