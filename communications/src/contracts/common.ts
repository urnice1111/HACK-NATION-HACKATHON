/**
 * Copia local y provisional de los contratos v2 (secciones 8, 9, 10 y 11 de
 * INSTRUCTIONS.md, en la raíz del repo). La fuente oficial es `contracts/`, del
 * Integrante 3; ver README, "Pendiente de acordar con el Integrante 3".
 * No cambies nombres de enums aquí sin acuerdo del equipo.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "2.0" as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** Límites por llamada o conversación SMS (sección 17): la evaluación inicial + 3 rondas, y 5 preguntas. */
export const MAX_ASSESSMENTS = 4;
export const MAX_QUESTIONS = 5;

// --- Primitivos (sección 8) ---

/** E.164: "+" seguido de 2 a 15 dígitos, sin cero inicial. */
export const PhoneE164 = z.string().regex(/^\+[1-9]\d{1,14}$/, "debe estar en formato E.164");

/** Fecha ISO 8601 en UTC (sufijo Z obligatorio). */
export const IsoUtc = z.iso.datetime({ offset: false });

/** ID opaco generado por el backend. */
export const OpaqueId = z.string().min(1).max(128);

export const Language = z.string().min(2).max(16);

// --- Enums (secciones 9, 10 y 11) ---

export const Disposition = z.enum(["ask_more", "advise", "refer"]);
export const EvidenceQuality = z.enum(["insufficient", "low", "medium", "high"]);
export const Urgency = z.enum(["unknown", "routine", "soon", "urgent"]);
export const Channel = z.enum(["voice", "sms", "operator"]);
export const Completeness = z.enum(["partial", "sufficient"]);
export const ProcessingStatus = z.enum(["pending", "processed", "failed"]);
export const MeasurementSource = z.enum(["farmer_reported", "sensor", "technician"]);
export const DataFreshness = z.enum(["fresh", "stale", "unknown"]);

export const CaseStatus = z.enum(["reported", "suspected", "confirmed", "monitoring", "resolved"]);
export const FollowupStatus = z.enum(["scheduled", "contacting", "responded", "no_response", "failed", "cancelled"]);

// --- Enums nuevos en v2 (secciones 9, 10.1 y 10.4) ---

export const AnswerType = z.enum(["yes_no", "number_with_unit", "choice", "free_text"]);
export const StatusReported = z.enum(["worse", "same", "improved", "resolved", "unknown"]);
export const ActionWorked = z.enum(["yes", "no", "partial", "unknown"]);
export const ResolutionVerification = z.enum(["farmer_reported", "verified", "disputed"]);

// --- Medición (sección 9) ---

export const Measurement = z.strictObject({
  name: z.string().min(1),
  /** null = desconocido; nunca se sustituye por cero. */
  value: z.union([z.number(), z.string()]).nullable(),
  unit: z.string().min(1),
  /** suelo, agua de riego u otra; el documento no fija un enum. */
  sample_type: z.string().min(1),
  measured_at: IsoUtc.nullable(),
  method: z.string().nullable(),
  source: MeasurementSource,
});

// --- Error uniforme (sección 8) ---

export const ErrorDetail = z.strictObject({
  field: z.string(),
  reason: z.string(),
});

export const ErrorBody = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    request_id: z.string(),
    details: z.array(ErrorDetail),
  }),
});

// --- Evento outbox (sección 11) ---

export const EventType = z.enum([
  "report.created",
  "assessment.completed",
  "env.summary_refreshed",
  "risk_model.activated",
  "risk.updated",
  "alert.approved",
  "notification.status_changed",
  "followup.due",
  "followup.responded",
  "case.resolved",
]);

export const OutboxEvent = z.strictObject({
  event_id: OpaqueId,
  schema_version: SchemaVersion,
  event_type: EventType,
  occurred_at: IsoUtc,
  aggregate_id: OpaqueId,
  aggregate_version: z.number().int().min(1),
  correlation_id: z.string().nullable(),
  is_demo: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
});

export type ErrorDetail = z.infer<typeof ErrorDetail>;
export type ErrorBody = z.infer<typeof ErrorBody>;
export type CaseStatus = z.infer<typeof CaseStatus>;
export type FollowupStatus = z.infer<typeof FollowupStatus>;
export type StatusReported = z.infer<typeof StatusReported>;
export type ActionWorked = z.infer<typeof ActionWorked>;
export type ResolutionVerification = z.infer<typeof ResolutionVerification>;
