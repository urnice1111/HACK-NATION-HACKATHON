/**
 * Server tools de los agentes de ElevenLabs (CLAUDE.md, sección 4). El agente
 * llama a comunicaciones, no al backend: así no recibe credenciales de
 * servicio y las reglas se cumplen en código, no en el prompt.
 *
 * Dos agentes comparten estas herramientas:
 *  - Ayuda (llamada entrante, sección 2.1): `resolve_farmer` → `confirm_farmer` →
 *    `get_plot_context` → `record_consent` → `assess_observation` → `submit_report`.
 *    La sesión es el `conversation_id` de ElevenLabs y el teléfono, el caller ID
 *    (variables de sistema). Identidad, parcela y permisos viven aquí: el modelo
 *    solo ve nombres numerados, nunca tokens ni IDs, y no puede elegir otra parcela
 *    ni guardar sin permiso.
 *  - Seguimiento (llamada saliente, sección 2.2): `submit_followup` y, si empeoró,
 *    `assess_observation` y `submit_report` con la sesión y la parcela que fijó el despachador.
 *
 * Reglas comunes:
 *  - Los IDs llegan de variables dinámicas, no los escribe el modelo.
 *  - Solo `registered: true` autoriza a decir "quedó registrado"; cualquier otro
 *    resultado trae una instrucción explícita de que NO se registró.
 *  - "No sé" se valida como `value: null, unknown: true`, nunca cero.
 *  - Máximo 3 rondas y 5 preguntas por llamada (sección 17), aunque el modelo insista.
 *
 * Las respuestas son 200 con un resultado estructurado para que el modelo lo
 * lea; solo autenticación y validación devuelven 4xx con el error uniforme.
 */
import { z } from "zod";
import { reportIdempotencyKey, type BackendClient } from "../backend/client.ts";
import type { BackendWriter, WriteOutcome } from "../backend/writer.ts";
import {
  ActionWorked,
  Completeness,
  MAX_ASSESSMENTS,
  MAX_QUESTIONS,
  OpaqueId,
  SCHEMA_VERSION,
  StatusReported,
  type AssessmentResponse,
  type ContactCandidate,
  type ContactConsent,
  type ObservationAnswer,
  type ReportCreated,
} from "../contracts/index.ts";
import { log, maskPhone } from "../http/log.ts";
import { parseBody } from "../http/respond.ts";
import { normalizeE164 } from "../phone.ts";
import type { ConsentScope } from "../sms/session.ts";
import { BoundedMap } from "../util.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sin actividad en este plazo, una llamada de ayuda se da por cortada. */
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

const ConversationId = z.string().min(1).max(200).nullish().transform((v) => v ?? null);
const OptionalBoolean = z.boolean().nullish().transform((v) => v ?? null);

/**
 * Respuesta tal como la manda el modelo (puede omitir `value` o `unit`). Se
 * normaliza al contrato: "no sé" → `value: null, unknown: true`; jamás un cero.
 */
const ToolAnswer = z
  .object({
    need_code: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
    unit: z.string().min(1).nullish(),
    raw_text: z.string().default(""),
    unknown: z.boolean().default(false),
  })
  .transform((a): ObservationAnswer => {
    const value = a.unknown ? null : (a.value ?? (a.raw_text.trim() || null));
    return { need_code: a.need_code, value, unit: value === null ? null : (a.unit ?? null), raw_text: a.raw_text, unknown: a.unknown || value === null };
  });

export const SubmitFollowupInput = z.object({
  session_id: OpaqueId,
  followup_id: OpaqueId,
  conversation_id: ConversationId,
  status_reported: StatusReported,
  user_statement: z.string().max(4000).default(""),
  actions_taken: z.string().max(2000).nullish().transform((v) => (v?.trim() ? v.trim() : null)),
  action_worked: ActionWorked.default("unknown"),
  /** Días desde que notó el cambio; null si no sabe o no hubo cambio. El agente no dicta fechas ISO. */
  change_noticed_days_ago: z.number().int().min(0).max(365).nullish().transform((v) => v ?? null),
});

export const ResolveFarmerInput = z.object({
  session_id: OpaqueId,
  /** `system__caller_id`. Oculto o inválido → número no identificado (nunca se adivina). */
  caller_phone: z.string().max(64).nullish().transform((v) => normalizeE164(v)),
});

export const ConfirmFarmerInput = z.object({
  session_id: OpaqueId,
  /** Número de la lista que devolvió `resolve_farmer` (1 = el primero). */
  candidate_number: z.coerce.number().int().min(1).max(20),
});

export const GetPlotContextInput = z.object({
  session_id: OpaqueId,
  /** Número de la lista de parcelas de `confirm_farmer`; puede omitirse si solo hay una. */
  plot_number: z.coerce.number().int().min(1).max(50).nullish().transform((v) => v ?? null),
});

export const RecordConsentInput = z.object({
  session_id: OpaqueId,
  /** null u omitido = no se preguntó en esta llamada. */
  reports: OptionalBoolean,
  notifications: OptionalBoolean,
  followup_calls: OptionalBoolean,
});

export const AssessObservationInput = z.object({
  session_id: OpaqueId,
  /** Solo el agente de seguimiento lo manda (variable dinámica); en ayuda se usa la parcela confirmada. */
  plot_id: OpaqueId.nullish().transform((v) => v ?? null),
  user_statement: z.string().max(4000),
  symptoms: z.array(z.string().min(1).max(200)).max(20).default([]),
  answers: z.array(ToolAnswer).max(MAX_QUESTIONS).default([]),
  asked_need_codes: z.array(z.string().min(1)).max(20).default([]),
});

export const SubmitReportInput = z.object({
  session_id: OpaqueId,
  plot_id: OpaqueId.nullish().transform((v) => v ?? null),
  conversation_id: ConversationId,
  user_statement: z.string().max(4000),
  symptoms: z.array(z.string().min(1).max(200)).max(20).default([]),
  completeness: Completeness,
  assessment_id: OpaqueId.nullish().transform((v) => v ?? null),
});

export interface ToolReply {
  status: number;
  body: unknown;
}

export interface VoiceToolsDeps {
  client: BackendClient;
  writer: BackendWriter;
  isDemo: boolean;
  defaultLanguage: string;
  /** Inactividad tras la que una llamada de ayuda se da por cortada (y se guarda lo descrito como parcial). */
  idleMs?: number;
  now?: () => Date;
}

/** Estado de una llamada de ayuda: lo que el modelo no debe poder inventar. */
interface HelpState {
  phone_e164: string | null;
  candidates: ContactCandidate[];
  farmer: {
    farmer_id: string;
    name: string;
    language: string;
    plots: { plot_id: string; label: string }[];
    stored_consent: ContactConsent;
  } | null;
  /** Respuestas de esta llamada; null = no se preguntó. */
  consent: Record<ConsentScope, boolean | null>;
  consent_writes: number;
  /** Última descripción evaluada: si la llamada se corta sin `submit_report`, se guarda como parcial. */
  statement: string;
  symptoms: string[];
}

interface ToolSession {
  assessments: number;
  last_assessment_id: string | null;
  plot: { plot_id: string; crop: string | null; variety: string | null } | null;
  reports: number;
  /** Solo en llamadas de ayuda (las inicia `resolve_farmer`). */
  help: HelpState | null;
  last_activity_at: number;
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  return parseBody(schema, raw, "Parámetros de la herramienta inválidos");
}

const NOT_REGISTERED_PENDING =
  "NO digas que quedó registrado. Di que no pudiste confirmar el registro, que el sistema lo va a reintentar y que no necesita volver a llamar.";
const NOT_REGISTERED_FAILED = "NO digas que quedó registrado. Di que no se pudo registrar y que un técnico revisará su caso.";
const UNKNOWN_CALLER =
  "No hay un registro para este número. No busques ni elijas una parcela y no menciones nombres. Pide permiso para guardar su reporte y llama a record_consent con reports. Si acepta, pídele que describa el problema y llama a submit_report con completeness \"partial\": un técnico lo revisará. Sin parcela registrada no hay evaluación.";
const REPORTS_DECLINED =
  "No aceptó que guardemos su reporte: NO llames a submit_report ni a assess_observation. Dile que está bien, que puede llamar cuando quiera, y despídete.";
const NO_REPORT_CONSENT =
  "NO digas que quedó registrado. Antes de guardar, pregúntale si nos da permiso de guardar su reporte para que un técnico lo revise y llama a record_consent con reports. Si dice que no, no guardes nada.";

export class VoiceTools {
  private readonly now: () => Date;
  private readonly idleMs: number;
  /** Estado por sesión de voz; vive lo que dura una llamada. */
  private readonly sessions = new BoundedMap<string, ToolSession>();

  constructor(private readonly deps: VoiceToolsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  }

  // --- Agente de ayuda: identidad, parcela y permisos ---

  /** `resolve_farmer`: candidatos por caller ID. El número no es prueba de identidad: solo nombres, sin datos. */
  async resolveFarmer(raw: unknown): Promise<ToolReply> {
    const input = parse(ResolveFarmerInput, raw);
    const session = this.session(input.session_id);
    const help: HelpState = {
      phone_e164: input.caller_phone,
      candidates: [],
      farmer: null,
      consent: { reports: null, notifications: null, followup_calls: null },
      consent_writes: 0,
      statement: "",
      symptoms: [],
    };
    session.help = help;
    session.plot = null;

    if (!help.phone_e164) {
      log("info", "tool_resolve_farmer", { correlation_id: input.session_id, outcome: "no_caller_id" });
      return ok({ status: "no_match", instruction: UNKNOWN_CALLER });
    }
    const resolved = await this.deps.client.resolveContact({
      schema_version: SCHEMA_VERSION,
      session_id: input.session_id,
      phone_e164: help.phone_e164,
      channel: "voice",
      confirm_candidate_token: null,
      is_demo: this.deps.isDemo,
    });
    if (!resolved.ok) {
      log("warn", "tool_resolve_farmer_failed", { correlation_id: input.session_id, code: resolved.code });
      return ok({ status: "unavailable", instruction: `No pudiste consultar su registro por una falla técnica. ${UNKNOWN_CALLER}` });
    }

    help.candidates = resolved.data.candidates;
    log("info", "tool_resolve_farmer", {
      correlation_id: input.session_id,
      phone: maskPhone(help.phone_e164),
      outcome: resolved.data.resolution_status,
      candidates: help.candidates.length,
    });
    if (help.candidates.length === 0) return ok({ status: "no_match", instruction: UNKNOWN_CALLER });

    const [only] = help.candidates;
    return ok({
      status: "candidates",
      is_shared_phone: resolved.data.is_shared_phone,
      candidates: numbered(help.candidates.map((c) => c.label)),
      instruction:
        help.candidates.length === 1
          ? `Pregunta si hablas con ${only!.label}. Si dice que sí, llama a confirm_farmer con candidate_number 1. No digas nada más de su registro antes de confirmar.`
          : "Este teléfono lo comparten varias personas. Pregunta con cuál hablas, leyendo solo los nombres, y llama a confirm_farmer con su número. No digas nada más de nadie antes de confirmar.",
    });
  }

  /** `confirm_farmer`: el agricultor dijo quién es; habilita sus parcelas y permisos para esta llamada. */
  async confirmFarmer(raw: unknown): Promise<ToolReply> {
    const input = parse(ConfirmFarmerInput, raw);
    const session = this.session(input.session_id);
    const help = session.help;
    if (!help?.phone_e164 || help.candidates.length === 0) {
      return ok({ confirmed: false, instruction: "No hay a quién confirmar. Si no lo hiciste, llama primero a resolve_farmer; si no está registrado, sigue como número no registrado." });
    }
    const candidate = help.candidates[input.candidate_number - 1];
    if (!candidate) {
      return ok({ confirmed: false, candidates: numbered(help.candidates.map((c) => c.label)), instruction: `Usa un número entre 1 y ${help.candidates.length}.` });
    }

    const confirmed = await this.deps.client.resolveContact({
      schema_version: SCHEMA_VERSION,
      session_id: input.session_id,
      phone_e164: help.phone_e164,
      channel: "voice",
      confirm_candidate_token: candidate.candidate_token,
      is_demo: this.deps.isDemo,
    });
    if (!confirmed.ok && confirmed.code === "CANDIDATE_TOKEN_INVALID") {
      // El backend firma cada candidato por 15 minutos: se piden nuevos y se vuelve a preguntar.
      const fresh = await this.deps.client.resolveContact({
        schema_version: SCHEMA_VERSION,
        session_id: input.session_id,
        phone_e164: help.phone_e164,
        channel: "voice",
        confirm_candidate_token: null,
        is_demo: this.deps.isDemo,
      });
      help.candidates = fresh.ok ? fresh.data.candidates : [];
      if (help.candidates.length === 0) return ok({ confirmed: false, instruction: UNKNOWN_CALLER });
      return ok({
        confirmed: false,
        candidates: numbered(help.candidates.map((c) => c.label)),
        instruction: "La confirmación venció. Vuelve a preguntar con quién hablas y llama otra vez a confirm_farmer.",
      });
    }
    if (!confirmed.ok || !confirmed.data.confirmed) {
      log("warn", "tool_confirm_farmer_failed", { correlation_id: input.session_id, code: confirmed.ok ? "NOT_CONFIRMED" : confirmed.code });
      return ok({ confirmed: false, instruction: `No pudiste confirmar su registro por una falla técnica. ${UNKNOWN_CALLER}` });
    }

    const farmer = confirmed.data.confirmed;
    help.farmer = {
      farmer_id: farmer.farmer_id,
      name: candidate.label,
      language: farmer.preferred_language,
      plots: farmer.plots,
      stored_consent: farmer.consent,
    };
    help.candidates = [];
    log("info", "tool_confirm_farmer", { correlation_id: input.session_id, plots: farmer.plots.length, outcome: "confirmed" });

    const plotInstruction =
      farmer.plots.length === 0
        ? "No tiene parcelas registradas: no hay evaluación. Sigue con los permisos, pídele que describa el problema y guarda el reporte con completeness \"partial\"."
        : farmer.plots.length === 1
          ? "Llama a get_plot_context."
          : "Pregunta de cuál parcela se trata, leyendo sus nombres, y llama a get_plot_context con su número.";
    return ok({
      confirmed: true,
      farmer_name: candidate.label,
      plots: numbered(farmer.plots.map((p) => p.label)),
      report_permission: permissionState(farmer.consent.reports),
      /** Permisos que nunca respondió: se preguntan uno por uno. */
      ask_permissions: (["notifications", "followup_calls"] as const).filter((scope) => farmer.consent[scope] === null),
      instruction: plotInstruction,
    });
  }

  /** `get_plot_context`: solo una parcela del agricultor confirmado; queda fija para el resto de la llamada. */
  async getPlotContext(raw: unknown): Promise<ToolReply> {
    const input = parse(GetPlotContextInput, raw);
    const session = this.session(input.session_id);
    const farmer = session.help?.farmer;
    if (!farmer) {
      return ok({ found: false, instruction: "Primero confirma con quién hablas (confirm_farmer). Nunca elijas una parcela por tu cuenta." });
    }
    const number = input.plot_number ?? (farmer.plots.length === 1 ? 1 : null);
    const plot = number === null ? undefined : farmer.plots[number - 1];
    if (!plot) {
      return ok({
        found: false,
        plots: numbered(farmer.plots.map((p) => p.label)),
        instruction: farmer.plots.length === 0 ? "No tiene parcelas registradas." : "Pregunta de cuál parcela se trata y llama a get_plot_context con su número.",
      });
    }

    const context = await this.deps.client.getPlotContext(plot.plot_id, input.session_id);
    // Sin contexto la parcela sigue confirmada; cultivo y variedad quedan como desconocidos (null).
    session.plot = context.ok
      ? { plot_id: plot.plot_id, crop: context.data.crop, variety: context.data.variety }
      : { plot_id: plot.plot_id, crop: null, variety: null };
    if (!context.ok) log("warn", "tool_plot_context_failed", { correlation_id: input.session_id, code: context.code });

    return ok({
      found: true,
      plot_label: plot.label,
      crop: session.plot.crop,
      variety: session.plot.variety,
      has_open_case: context.ok ? context.data.active_cases.length > 0 : null,
      instruction:
        "Parcela confirmada. No leas datos técnicos. Sigue con los permisos que falten y pídele que describa qué ve en sus plantas.",
    });
  }

  /** `record_consent`: tres permisos separados (sección 17); se guardan solo para un agricultor confirmado. */
  async recordConsent(raw: unknown): Promise<ToolReply> {
    const input = parse(RecordConsentInput, raw);
    const session = this.session(input.session_id);
    const help = session.help;
    if (!help) return ok({ saved: false, instruction: "Primero llama a resolve_farmer." });

    for (const scope of ["reports", "notifications", "followup_calls"] as const) {
      if (input[scope] !== null) help.consent[scope] = input[scope];
    }
    const next = input.reports === false ? REPORTS_DECLINED : "Continúa.";
    // Número no registrado: el permiso vale solo para esta llamada.
    if (!help.farmer) return ok({ saved: true, valid_for_this_call_only: true, instruction: next });

    // Confirmar este reporte cuando ya había permiso no se reenvía; negarlo no revoca un permiso que ya existía.
    const reports = help.farmer.stored_consent.reports === true ? null : input.reports;
    const { notifications, followup_calls } = input;
    if (reports === null && notifications === null && followup_calls === null) return ok({ saved: true, instruction: next });

    help.consent_writes += 1;
    const outcome = await this.deps.writer.recordConsent(
      {
        schema_version: SCHEMA_VERSION,
        session_id: input.session_id,
        farmer_id: help.farmer.farmer_id,
        channel: "voice",
        reports,
        notifications,
        followup_calls,
        provider_reference: input.session_id,
        is_demo: this.deps.isDemo,
      },
      `consent-${input.session_id}-${help.consent_writes}`,
    );
    log("info", "tool_record_consent", { correlation_id: input.session_id, outcome: outcome.status });
    if (outcome.status === "saved") return ok({ saved: true, instruction: next });
    return ok({ saved: false, instruction: `No digas que sus permisos quedaron guardados; el sistema lo reintentará. ${next}` });
  }

  // --- Ambos agentes ---

  /** `submit_followup`: todas las respuestas del seguimiento en una sola petición (10.4). */
  async submitFollowup(raw: unknown): Promise<ToolReply> {
    const input = parse(SubmitFollowupInput, raw);
    this.session(input.session_id);
    const changeNoticedAt =
      input.change_noticed_days_ago === null ? null : startOfUtcDay(this.now().getTime() - input.change_noticed_days_ago * DAY_MS);

    const outcome = await this.deps.writer.submitFollowup(input.followup_id, {
      schema_version: SCHEMA_VERSION,
      session_id: input.session_id,
      channel: "voice",
      status_reported: input.status_reported,
      user_statement: input.user_statement,
      actions_taken: input.actions_taken,
      action_worked: input.action_worked,
      change_noticed_at: changeNoticedAt,
      provider_reference: input.conversation_id,
      is_demo: this.deps.isDemo,
    });
    log("info", "tool_submit_followup", { correlation_id: input.session_id, followup_id: input.followup_id, outcome: outcome.status });

    if (outcome.status === "pending") return ok({ registered: false, instruction: NOT_REGISTERED_PENDING });
    if (outcome.status === "failed") {
      const closed = outcome.code === "FOLLOWUP_CLOSED";
      return ok({
        registered: false,
        instruction: closed ? "Este seguimiento ya estaba registrado. NO digas que lo registraste ahora; agradece y despídete." : NOT_REGISTERED_FAILED,
      });
    }

    const worse = input.status_reported === "worse";
    return ok({
      registered: true,
      case_status: outcome.data.case_status,
      resolved: outcome.data.resolution_id !== null,
      next_followup_scheduled: outcome.data.next_followup_at !== null,
      instruction: worse
        ? "Quedó registrado. Como empeoró, pregúntale qué ve ahora en sus plantas y llama a assess_observation con su descripción, como en una llamada de ayuda."
        : outcome.data.resolution_id !== null
          ? "Quedó registrado. Agradece, alégrate de que se resolvió y despídete."
          : "Quedó registrado. Agradece, dile que le volveremos a preguntar en unos días y despídete.",
    });
  }

  /** `assess_observation`: necesidades de información u orientación, con los límites de la sección 17. */
  async assessObservation(raw: unknown): Promise<ToolReply> {
    const input = parse(AssessObservationInput, raw);
    const session = this.session(input.session_id);
    const help = session.help;
    // En ayuda manda la parcela confirmada, nunca la que diga el modelo.
    const plotId = help ? (session.plot?.plot_id ?? null) : input.plot_id;
    if (help) {
      if (help.consent.reports === false) return ok({ disposition: "declined", instruction: REPORTS_DECLINED });
      if (input.user_statement.trim()) help.statement = input.user_statement;
      if (input.symptoms.length > 0) help.symptoms = input.symptoms;
    }
    if (!plotId) {
      return ok({
        disposition: "no_plot",
        instruction:
          "Sin parcela confirmada no hay evaluación. Dile que un técnico revisará su caso y llama a submit_report con completeness \"partial\".",
      });
    }

    const asked = new Set([...input.asked_need_codes, ...input.answers.map((a) => a.need_code)]);
    if (session.assessments >= MAX_ASSESSMENTS || asked.size >= MAX_QUESTIONS) {
      return ok({
        disposition: "limit_reached",
        instruction:
          "No hagas más preguntas. Di que con lo que te contó un técnico revisará su caso y llama a submit_report con completeness \"partial\".",
      });
    }

    if (!session.plot || session.plot.plot_id !== plotId) {
      const context = await this.deps.client.getPlotContext(plotId, input.session_id);
      // Sin contexto la evaluación sigue; cultivo y variedad quedan como desconocidos (null).
      session.plot = context.ok
        ? { plot_id: plotId, crop: context.data.crop, variety: context.data.variety }
        : { plot_id: plotId, crop: null, variety: null };
    }

    session.assessments += 1;
    const assessed = await this.deps.client.assess({
      schema_version: SCHEMA_VERSION,
      session_id: input.session_id,
      plot_id: plotId,
      language: help?.farmer?.language ?? this.deps.defaultLanguage,
      observation: {
        observed_at: null,
        symptoms: input.symptoms,
        user_statement: input.user_statement,
        measurements: [],
        answers: input.answers,
        completeness: "partial",
      },
      asked_need_codes: [...asked],
      plot_context: { crop: session.plot.crop, variety: session.plot.variety },
      is_demo: this.deps.isDemo,
    });

    if (!assessed.ok) {
      log("warn", "tool_assess_failed", { correlation_id: input.session_id, code: assessed.code });
      return ok({
        disposition: "unavailable",
        instruction:
          "Di que no se pudo completar la evaluación, que un técnico revisará su caso y que habrá seguimiento. NO inventes orientación. Llama a submit_report con completeness \"partial\".",
      });
    }
    session.last_assessment_id = assessed.data.assessment_id;
    return ok(forAgent(assessed.data, MAX_QUESTIONS - asked.size));
  }

  /** `submit_report`: guarda la observación confirmada por el agricultor. */
  async submitReport(raw: unknown): Promise<ToolReply> {
    const input = parse(SubmitReportInput, raw);
    const session = this.session(input.session_id);
    const help = session.help;
    if (help && !reportAllowed(help)) {
      return ok({ registered: false, instruction: help.consent.reports === false ? REPORTS_DECLINED : NO_REPORT_CONSENT });
    }

    const outcome = await this.saveReport(input.session_id, session, {
      // En ayuda, la parcela confirmada (o ninguna, para un número no registrado); nunca la del modelo.
      plot_id: help ? (session.plot?.plot_id ?? null) : input.plot_id,
      provider_reference: input.conversation_id ?? (help ? input.session_id : null),
      user_statement: input.user_statement,
      symptoms: input.symptoms,
      completeness: input.completeness,
      assessment_id: input.assessment_id ?? session.last_assessment_id,
    });
    log("info", "tool_submit_report", { correlation_id: input.session_id, outcome: outcome.status });

    if (outcome.status === "saved") {
      return ok({ registered: true, instruction: "Quedó registrado. Puedes decirlo, agradece y despídete." });
    }
    return ok({ registered: false, instruction: outcome.status === "pending" ? NOT_REGISTERED_PENDING : NOT_REGISTERED_FAILED });
  }

  /**
   * Llamadas de ayuda que se cortaron sin `submit_report` (sección 4): si había permiso y una
   * descripción, se guarda solo lo recibido como `completeness: "partial"`.
   */
  async sweep(): Promise<void> {
    const now = this.now().getTime();
    for (const [sessionId, session] of [...this.sessions]) {
      const help = session.help;
      if (!help || session.reports > 0 || !help.statement || now - session.last_activity_at <= this.idleMs) continue;
      if (!reportAllowed(help)) continue;
      const outcome = await this.saveReport(sessionId, session, {
        plot_id: session.plot?.plot_id ?? null,
        provider_reference: sessionId,
        user_statement: help.statement,
        symptoms: help.symptoms,
        completeness: "partial",
        assessment_id: session.last_assessment_id,
      });
      log("info", "help_call_saved_partial", { correlation_id: sessionId, outcome: outcome.status });
    }
  }

  private saveReport(
    sessionId: string,
    session: ToolSession,
    fields: {
      plot_id: string | null;
      provider_reference: string | null;
      user_statement: string;
      symptoms: string[];
      completeness: "partial" | "sufficient";
      assessment_id: string | null;
    },
  ): Promise<WriteOutcome<ReportCreated>> {
    session.reports += 1;
    return this.deps.writer.submitReport(
      {
        schema_version: SCHEMA_VERSION,
        session_id: sessionId,
        case_id: null,
        channel: "voice",
        observed_at: null,
        measurements: [],
        is_demo: this.deps.isDemo,
        ...fields,
      },
      // Estable por sesión y turno: si el modelo repite la herramienta, el backend devuelve el original.
      reportIdempotencyKey(sessionId, session.reports),
    );
  }

  private session(id: string): ToolSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = { assessments: 0, last_assessment_id: null, plot: null, reports: 0, help: null, last_activity_at: 0 };
      this.sessions.set(id, session);
    }
    session.last_activity_at = this.now().getTime();
    return session;
  }
}

/** Con permiso dado en esta llamada, o guardado antes y no negado ahora. */
function reportAllowed(help: HelpState): boolean {
  if (help.consent.reports !== null) return help.consent.reports;
  return help.farmer?.stored_consent.reports === true;
}

function permissionState(value: boolean | null): "granted" | "denied" | "never_asked" {
  return value === true ? "granted" : value === false ? "denied" : "never_asked";
}

/** El modelo ve "1 Rosa, 2 Marta"; los tokens e IDs se quedan en comunicaciones. */
function numbered(labels: string[]): { number: number; label: string }[] {
  return labels.map((label, i) => ({ number: i + 1, label }));
}

/** Lo que el agente necesita para hablar; nada de `reason` interno ni IDs de datasets. */
function forAgent(assessment: AssessmentResponse, questionsLeft: number) {
  const needs = [...assessment.information_needs].sort((a, b) => a.priority - b.priority).map(({ reason: _, ...need }) => need);
  const base = {
    assessment_id: assessment.assessment_id,
    disposition: assessment.disposition,
    human_review_required: assessment.human_review_required,
  };

  if (assessment.disposition === "ask_more" && needs.length > 0) {
    return {
      ...base,
      information_needs: needs,
      questions_left: questionsLeft,
      instruction:
        "Haz UNA sola pregunta: la necesidad de priority 1, en palabras sencillas según farmer_hint, nunca con el nombre técnico. Normaliza la respuesta según answer_type; si dice que no sabe, envíala con value null y unknown true. Luego vuelve a llamar a assess_observation con todas las respuestas y asked_need_codes.",
    };
  }
  if (assessment.disposition === "advise") {
    return {
      ...base,
      recommendations: assessment.recommendations.map((r) => r.text),
      resolved_case_mentions: assessment.resolved_case_mentions.map((m) => ({ summary: m.summary_for_speech, verification: m.verification })),
      instruction:
        "Aclara que esto no confirma ninguna enfermedad y que un técnico lo revisará. Comunica las recomendaciones con tus palabras. Si hay un caso resuelto, cuéntalo como experiencia de otro agricultor (si verification no es \"verified\", di que no está verificado). Después llama a submit_report con completeness \"sufficient\".",
    };
  }
  return {
    ...base,
    disposition: "refer" as const,
    instruction:
      "Di que con lo que te contó no puedes darle una orientación segura y que un técnico revisará su caso. NO recomiendes productos ni dosis. Llama a submit_report con completeness \"partial\".",
  };
}

function ok(body: unknown): ToolReply {
  return { status: 200, body };
}

function startOfUtcDay(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}
