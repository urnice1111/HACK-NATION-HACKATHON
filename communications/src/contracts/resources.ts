/**
 * Cuerpos de solicitud/respuesta de los contratos HTTP v2 (sección 10).
 *
 * Lo marcado como PROPUESTO no está definido en el documento: es la forma que
 * comunicaciones necesita y debe acordarse con el Integrante 3 antes de
 * integrarse. Lo demás reproduce los ejemplos 10.1, 10.4 y 10.5.
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

/** Respuesta del agricultor a una necesidad. `unknown: true` ("no sé") exige `value: null`; nunca cero. */
export const ObservationAnswer = z
  .strictObject({
    need_code: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    unit: z.string().min(1).nullable(),
    raw_text: z.string(),
    unknown: z.boolean(),
  })
  .refine((a) => !a.unknown || a.value === null, { path: ["value"], message: "debe ser null si unknown es true" });

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
  /** Necesidades ya preguntadas en la sesión; el asesor no debe repetirlas. */
  asked_need_codes: z.array(z.string().min(1)),
  plot_context: z.strictObject({
    crop: z.string().nullable(),
    variety: z.string().nullable(),
  }),
  is_demo: z.boolean(),
});

/** Dato que solo el agricultor puede aportar. El texto de la pregunta lo formula comunicaciones. */
export const InformationNeed = z
  .strictObject({
    need_code: z.string().min(1),
    variable: z.string().min(1),
    reason: z.string().min(1),
    farmer_hint: z.string().min(1),
    answer_type: AnswerType,
    options: z.array(z.string().min(1)).min(1).nullable(),
    /** 1 = preguntar primero. */
    priority: z.number().int().min(1),
    can_be_unknown: z.boolean(),
  })
  .refine((n) => n.answer_type !== "choice" || n.options !== null, { path: ["options"], message: "obligatorio si answer_type es choice" });

/** Consulta que el asesor hizo a los datos en vez de preguntar. */
export const DataUsed = z.strictObject({
  query_id: z.string().min(1),
  summary: z.string().min(1),
  data_freshness: DataFreshness,
  dataset_ids: z.array(z.string().min(1)),
});

/** Experiencia de otro agricultor; se comunica como testimonio, no como recomendación validada. */
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
  /** PROPUESTO: null para el "registro mínimo" de un número desconocido; nunca una parcela al azar. */
  plot_id: OpaqueId.nullable(),
  case_id: OpaqueId.nullable(),
  channel: Channel,
  provider_reference: z.string().min(1).nullable(),
  observed_at: IsoUtc.nullable(),
  symptoms: z.array(z.string().min(1)),
  measurements: z.array(Measurement),
  user_statement: z.string(),
  completeness: Completeness,
  /** Opcional si la evaluación falló. */
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

/** PROPUESTO: el documento solo dice "caso, evaluación y estado de procesamiento". */
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
 * PROPUESTO. Los tres permisos de la sección 17, por separado. `null` = nunca
 * se preguntó (hay que pedirlo); `false` = lo negó o lo revocó.
 */
export const ContactConsent = z.strictObject({
  reports: z.boolean().nullable(),
  notifications: z.boolean().nullable(),
  followup_calls: z.boolean().nullable(),
  consent_at: IsoUtc.nullable(),
});

/**
 * PROPUESTO. Dos pasos en la misma ruta:
 *  1. Sin `confirm_candidate_token`: devuelve candidatos con token opaco y etiqueta mínima.
 *  2. Con el token que el usuario confirmó: habilita los datos de ese agricultor para la sesión.
 * El caller ID por sí solo nunca es prueba de identidad.
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
  /** Etiqueta mínima para preguntar "¿hablo con…?"; nada más del registro. */
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
 * PROPUESTO: forma del resumen ambiental (`env.plot_summary`, Integrante 4)
 * dentro del contexto. Cada característica lleva unidad explícita (sección 8);
 * `value: null` = sin dato o fuera de cobertura.
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

/** PROPUESTO: contexto mínimo para el asesor y la conversación; sin coordenadas ni datos de contacto. */
export const PlotContext = z.strictObject({
  schema_version: SchemaVersion,
  plot_id: OpaqueId,
  label: z.string().min(1),
  crop: z.string().nullable(),
  variety: z.string().nullable(),
  altitude_m: z.number().nullable(),
  data_freshness: DataFreshness,
  /** null si el Integrante 4 aún no tiene resumen para la parcela. */
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
 * PROPUESTO: el documento dice "seguimientos con resumen del caso". Comunicaciones
 * necesita además el contacto para marcar y comprobar consentimiento/horario;
 * `contact` solo debería devolverse al token de servicio `comms`.
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
  /** Variables dinámicas del agente de seguimiento (sección 4). */
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
 * PROPUESTO: la v2 solo define `responses`. Comunicaciones necesita registrar
 * cada intento (`contacting`, `no_response`, `failed`). `contacting` liga la
 * sesión (conversation_id de ElevenLabs o sesión SMS) a la parcela del caso,
 * porque en una llamada saliente no hay `contact-resolution`.
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
  /** null salvo con `status_reported: resolved`. */
  resolution_id: OpaqueId.nullable(),
  next_followup_at: IsoUtc.nullable(),
});

// --- POST /v1/consents ---

/**
 * PROPUESTO: la v2 exige guardar tres permisos con `consent_at`, pero no define
 * dónde. Cada permiso `null` = no se preguntó en esta sesión (se conserva el anterior).
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

/** PROPUESTO: "BAJA" por SMS revoca avisos y seguimientos de todos los contactos con ese teléfono. */
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
