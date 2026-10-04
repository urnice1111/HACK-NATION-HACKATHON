/**
 * Request/response bodies of the v2 HTTP contracts (section 10).
 *
 * Anything marked AGREED isn't in the spec: communications proposed it and the
 * backend already implements it the same way (`contracts/models.py`);
 * `test/contracts-compat.test.ts` checks it. The rest mirrors examples 10.1, 10.4 and 10.5.
 */
import { z } from "zod";
import {
  ActionWorked,
  AnswerType,
  CaseStatus,
  Channel,
  Completeness,
  DataFreshness,
  Disposition,
  EvidenceQuality,
  FollowupStatus,
  IsoUtc,
  Language,
  Measurement,
  OpaqueId,
  PhoneE164,
  ProcessingStatus,
  ResolutionVerification,
  SchemaVersion,
  StatusReported,
  Urgency,
} from "./common.ts";

const VoiceOrSms = z.enum(["voice", "sms"]);

// --- POST /v1/assessments (10.1) ---

/** The farmer's answer to a need. `unknown: true` ("I don't know") requires `value: null`; never zero. */
export const ObservationAnswer = z
  .strictObject({
    need_code: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    unit: z.string().min(1).nullable(),
    raw_text: z.string(),
    unknown: z.boolean(),
  })
  .refine((a) => !a.unknown || a.value === null, { path: ["value"], message: "must be null if unknown is true" });

export const AssessmentRequest = z.strictObject({
  schema_version: SchemaVersion,
  session_id: OpaqueId,
  plot_id: OpaqueId,
  language: Language,
  observation: z.strictObject({
    observed_at: IsoUtc.nullable(),
    symptoms: z.array(z.string().min(1)),
    user_statement: z.string(),
    measurements: z.array(Measurement),
    answers: z.array(ObservationAnswer),
    completeness: Completeness,
  }),
  /** Needs already asked in the session; the advisor must not repeat them. */
  asked_need_codes: z.array(z.string().min(1)),
  plot_context: z.strictObject({
    crop: z.string().nullable(),
    variety: z.string().nullable(),
  }),
  is_demo: z.boolean(),
});

/** Information only the farmer can provide. Communications phrases the actual question. */
export const InformationNeed = z
  .strictObject({
    need_code: z.string().min(1),
    variable: z.string().min(1),
    reason: z.string().min(1),
    farmer_hint: z.string().min(1),
    answer_type: AnswerType,
    options: z.array(z.string().min(1)).min(1).nullable(),
    /** 1 = ask first. */
    priority: z.number().int().min(1),
    can_be_unknown: z.boolean(),
  })
  .refine((n) => n.answer_type !== "choice" || n.options !== null, { path: ["options"], message: "required if answer_type is choice" });

/** A data query the advisor made instead of asking. */
export const DataUsed = z.strictObject({
  query_id: z.string().min(1),
  summary: z.string().min(1),
  data_freshness: DataFreshness,
  dataset_ids: z.array(z.string().min(1)),
});

/** Another farmer's experience; conveyed as testimony, not as a validated recommendation. */
export const ResolvedCaseMention = z.strictObject({
  resolution_id: OpaqueId,
  summary_for_speech: z.string().min(1),
  verification: ResolutionVerification,
});

export const Recommendation = z.strictObject({
  code: z.string().min(1),
  text: z.string().min(1),
  protocol_id: z.string().min(1),
  source_ids: z.array(z.string()),
});

export const AssessmentResponse = z.strictObject({
  schema_version: SchemaVersion,
  assessment_id: OpaqueId,
  disposition: Disposition,
  suspected_issue: z
    .strictObject({
      code: z.string().min(1),
      label: z.string().min(1),
      certainty: z.literal("suspected"),
    })
    .nullable(),
  evidence_quality: EvidenceQuality,
  urgency: Urgency,
  information_needs: z.array(InformationNeed),
  data_used: z.array(DataUsed),
  resolved_case_mentions: z.array(ResolvedCaseMention),
  recommendations: z.array(Recommendation),
  human_review_required: z.boolean(),
  source_ids: z.array(z.string()),
  context_stale: z.boolean(),
  model_version: z.string().min(1),
  protocol_version: z.string().min(1),
});

// --- POST /v1/reports (10.5) ---

export const ReportRequest = z.strictObject({
  schema_version: SchemaVersion,
  session_id: OpaqueId,
  /** AGREED: null for the "minimal record" of an unknown number; never a random plot. */
  plot_id: OpaqueId.nullable(),
  case_id: OpaqueId.nullable(),
  channel: Channel,
  provider_reference: z.string().min(1).nullable(),
  observed_at: IsoUtc.nullable(),
  symptoms: z.array(z.string().min(1)),
  measurements: z.array(Measurement),
  user_statement: z.string(),
  completeness: Completeness,
  /** Optional if the assessment failed. */
  assessment_id: OpaqueId.nullable().optional(),
  is_demo: z.boolean(),
});

export const ReportCreated = z.strictObject({
  report_id: OpaqueId,
  case_id: OpaqueId.nullable(),
  received_at: IsoUtc,
  processing_status: ProcessingStatus,
  correlation_id: z.string(),
});

// --- GET /v1/reports/{report_id} ---

/** AGREED: the spec only says "case, assessment and processing status". */
export const ReportDetail = z.strictObject({
  report_id: OpaqueId,
  case_id: OpaqueId.nullable(),
  plot_id: OpaqueId.nullable(),
  session_id: OpaqueId,
  channel: Channel,
  provider_reference: z.string().nullable(),
  observed_at: IsoUtc.nullable(),
  received_at: IsoUtc,
  symptoms: z.array(z.string()),
  measurements: z.array(Measurement),
  user_statement: z.string(),
  completeness: Completeness,
  assessment_id: OpaqueId.nullable(),
  processing_status: ProcessingStatus,
  created_at: IsoUtc,
  is_demo: z.boolean(),
});

// --- POST /v1/contact-resolution ---

/**
 * AGREED. The three permissions of section 17, separately. `null` = never
 * asked (must be requested); `false` = declined or revoked.
 */
export const ContactConsent = z.strictObject({
  reports: z.boolean().nullable(),
  notifications: z.boolean().nullable(),
  followup_calls: z.boolean().nullable(),
  consent_at: IsoUtc.nullable(),
});

/**
 * AGREED. Two steps on the same route:
 *  1. Without `confirm_candidate_token`: returns candidates with an opaque token and a minimal label.
 *  2. With the token the user confirmed: unlocks that farmer's data for the session.
 * Caller ID alone is never proof of identity.
 */
export const ContactResolutionRequest = z.strictObject({
  schema_version: SchemaVersion,
  session_id: OpaqueId,
  phone_e164: PhoneE164,
  channel: VoiceOrSms,
  confirm_candidate_token: z.string().min(1).nullable(),
  is_demo: z.boolean(),
});

export const ContactCandidate = z.strictObject({
  candidate_token: z.string().min(1),
  /** Minimal label to ask "am I speaking with…?"; nothing else from the record. */
  label: z.string().min(1),
});

export const ContactResolutionResponse = z.strictObject({
  schema_version: SchemaVersion,
  session_id: OpaqueId,
  resolution_status: z.enum(["no_match", "candidates", "confirmed"]),
  requires_confirmation: z.boolean(),
  is_shared_phone: z.boolean(),
  candidates: z.array(ContactCandidate),
  confirmed: z
    .strictObject({
      farmer_id: OpaqueId,
      preferred_language: Language,
      timezone: z.string().min(1),
      consent: ContactConsent,
      plots: z.array(z.strictObject({ plot_id: OpaqueId, label: z.string().min(1) })),
    })
    .nullable(),
  is_demo: z.boolean(),
});

// --- GET /v1/plots/{plot_id}/context ---

/**
 * AGREED: shape of the environmental summary (`env.plot_summary`, Member 4)
 * inside the context. Every feature carries an explicit unit (section 8);
 * `value: null` = no data or out of coverage.
 */
export const EnvironmentSummary = z.strictObject({
  computed_at: IsoUtc,
  data_freshness: DataFreshness,
  features: z.array(
    z.strictObject({
      name: z.string().min(1),
      value: z.number().nullable(),
      unit: z.string().min(1),
    }),
  ),
  dataset_ids: z.array(z.string().min(1)),
});

/** AGREED: minimal context for the advisor and the conversation; no coordinates or contact details. */
export const PlotContext = z.strictObject({
  schema_version: SchemaVersion,
  plot_id: OpaqueId,
  label: z.string().min(1),
  crop: z.string().nullable(),
  variety: z.string().nullable(),
  altitude_m: z.number().nullable(),
  data_freshness: DataFreshness,
  /** null if Member 4 has no summary for the plot yet. */
  environment_summary: EnvironmentSummary.nullable(),
  active_cases: z.array(
    z.strictObject({
      case_id: OpaqueId,
      threat_code: z.string().min(1),
      status: CaseStatus,
      opened_at: IsoUtc,
      last_observation_at: IsoUtc.nullable(),
    }),
  ),
  pending_followups: z.array(
    z.strictObject({
      followup_id: OpaqueId,
      case_id: OpaqueId,
      due_at: IsoUtc,
      status: FollowupStatus,
    }),
  ),
  is_demo: z.boolean(),
});

// --- GET /v1/followups?status=… ---

/**
 * AGREED: the spec says "follow-ups with a case summary". Communications also
 * needs the contact to dial and to check consent/hours; `contact` should only
 * be returned to the `comms` service token.
 */
export const FollowupListItem = z.strictObject({
  followup_id: OpaqueId,
  case_id: OpaqueId,
  plot_id: OpaqueId,
  due_at: IsoUtc,
  status: FollowupStatus,
  channel: VoiceOrSms,
  attempt_count: z.number().int().min(0),
  questionnaire_version: z.string().min(1),
  call_reference: z.string().nullable(),
  /** Dynamic variables for the follow-up agent (section 4). */
  case_summary: z.strictObject({
    farmer_name: z.string().min(1),
    threat_code: z.string().min(1),
    case_status: CaseStatus,
    opened_at: IsoUtc,
    symptoms: z.array(z.string().min(1)),
    guidance_given: z.string().nullable(),
  }),
  contact: z.strictObject({
    phone_e164: PhoneE164,
    preferred_language: Language,
    timezone: z.string().min(1),
    allowed_hours: z.strictObject({ start: z.string(), end: z.string() }).nullable(),
    followup_call_consent: z.boolean(),
    notification_consent: z.boolean(),
  }),
  is_demo: z.boolean(),
});

export const FollowupList = z.strictObject({
  schema_version: SchemaVersion,
  followups: z.array(FollowupListItem),
  next_cursor: z.string().nullable(),
  is_demo: z.boolean(),
});

// --- POST /v1/followups/{id}/attempts ---

/**
 * AGREED: v2 only defines `responses`. Communications needs to record every
 * attempt (`contacting`, `no_response`, `failed`). `contacting` binds the
 * session (ElevenLabs conversation_id or SMS session) to the case's plot,
 * because an outbound call has no `contact-resolution`.
 */
export const FollowupAttemptRequest = z.strictObject({
  schema_version: SchemaVersion,
  session_id: OpaqueId,
  status: z.enum(["contacting", "no_response", "failed"]),
  channel: VoiceOrSms,
  call_reference: z.string().min(1).nullable(),
  occurred_at: IsoUtc,
  is_demo: z.boolean(),
});

export const FollowupAttemptRecorded = z.strictObject({
  followup_id: OpaqueId,
  status: FollowupStatus,
  attempt_count: z.number().int().min(0),
  is_demo: z.boolean(),
});

// --- POST /v1/followups/{id}/responses (10.4) ---

export const FollowupResponseRequest = z.strictObject({
  schema_version: SchemaVersion,
  session_id: OpaqueId,
  channel: VoiceOrSms,
  status_reported: StatusReported,
  user_statement: z.string(),
  actions_taken: z.string().nullable(),
  action_worked: ActionWorked,
  change_noticed_at: IsoUtc.nullable(),
  provider_reference: z.string().min(1).nullable(),
  is_demo: z.boolean(),
});

export const FollowupResponseCreated = z.strictObject({
  report_id: OpaqueId,
  case_id: OpaqueId,
  case_status: CaseStatus,
  /** null unless `status_reported: resolved`. */
  resolution_id: OpaqueId.nullable(),
  next_followup_at: IsoUtc.nullable(),
});

// --- POST /v1/consents ---

/**
 * AGREED: v2 requires storing three permissions with `consent_at`, but doesn't say
 * where. Each permission `null` = not asked in this session (the previous one is kept).
 */
export const ConsentRequest = z.strictObject({
  schema_version: SchemaVersion,
  session_id: OpaqueId,
  farmer_id: OpaqueId,
  channel: VoiceOrSms,
  reports: z.boolean().nullable(),
  notifications: z.boolean().nullable(),
  followup_calls: z.boolean().nullable(),
  provider_reference: z.string().min(1).nullable(),
  is_demo: z.boolean(),
});

export const ConsentRecorded = z.strictObject({
  farmer_id: OpaqueId,
  consent: ContactConsent,
  is_demo: z.boolean(),
});

// --- POST /v1/consents/revocations ---

const RevocableScope = z.enum(["notifications", "followup_calls"]);

/** AGREED: "ALERTS OFF" by SMS revokes alerts and follow-ups for every contact with that phone. */
export const ConsentRevocationRequest = z.strictObject({
  schema_version: SchemaVersion,
  phone_e164: PhoneE164,
  channel: z.literal("sms"),
  scopes: z.array(RevocableScope).min(1),
  provider_reference: z.string().min(1).nullable(),
  is_demo: z.boolean(),
});

export const ConsentRevoked = z.strictObject({
  contacts_updated: z.number().int().min(0),
  scopes: z.array(RevocableScope),
  is_demo: z.boolean(),
});

export type ObservationAnswer = z.infer<typeof ObservationAnswer>;
export type AssessmentRequest = z.infer<typeof AssessmentRequest>;
export type InformationNeed = z.infer<typeof InformationNeed>;
export type DataUsed = z.infer<typeof DataUsed>;
export type ResolvedCaseMention = z.infer<typeof ResolvedCaseMention>;
export type AssessmentResponse = z.infer<typeof AssessmentResponse>;
export type ReportRequest = z.infer<typeof ReportRequest>;
export type ReportCreated = z.infer<typeof ReportCreated>;
export type ReportDetail = z.infer<typeof ReportDetail>;
export type ContactConsent = z.infer<typeof ContactConsent>;
export type ContactResolutionRequest = z.infer<typeof ContactResolutionRequest>;
export type ContactCandidate = z.infer<typeof ContactCandidate>;
export type ContactResolutionResponse = z.infer<typeof ContactResolutionResponse>;
export type EnvironmentSummary = z.infer<typeof EnvironmentSummary>;
export type PlotContext = z.infer<typeof PlotContext>;
export type FollowupListItem = z.infer<typeof FollowupListItem>;
export type FollowupList = z.infer<typeof FollowupList>;
export type FollowupAttemptRequest = z.infer<typeof FollowupAttemptRequest>;
export type FollowupAttemptRecorded = z.infer<typeof FollowupAttemptRecorded>;
export type FollowupResponseRequest = z.infer<typeof FollowupResponseRequest>;
export type FollowupResponseCreated = z.infer<typeof FollowupResponseCreated>;
export type ConsentRequest = z.infer<typeof ConsentRequest>;
export type ConsentRecorded = z.infer<typeof ConsentRecorded>;
export type ConsentRevocationRequest = z.infer<typeof ConsentRevocationRequest>;
export type ConsentRevoked = z.infer<typeof ConsentRevoked>;
