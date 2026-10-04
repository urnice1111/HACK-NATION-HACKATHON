/**
 * Server tools de los agentes de ElevenLabs (CLAUDE.md, sección 4). El agente
 * llama a comunicaciones, no al backend: así no recibe credenciales de
 * servicio y las reglas se cumplen en código, no en el prompt.
 *
 *  - Los IDs (`session_id`, `followup_id`, `plot_id`, `conversation_id`) llegan
 *    de variables dinámicas, no los escribe el modelo.
 *  - Solo `registered: true` autoriza a decir "quedó registrado"; cualquier otro
 *    resultado trae una instrucción explícita de que NO se registró.
 *  - "No sé" se valida como `value: null, unknown: true`, nunca cero.
 *  - Máximo 3 rondas y 5 preguntas por llamada (sección 17), aunque el modelo insista.
 *
 * Las respuestas son 200 con un resultado estructurado para que el modelo lo
 * lea; solo autenticación y validación devuelven 4xx con el error uniforme.
 */
import { z } from "zod";
import { followupIdempotencyKey, reportIdempotencyKey, type BackendClient } from "../backend/client.ts";
import type { BackendWriter } from "../backend/writer.ts";
import {
  ActionWorked,
  Completeness,
  OpaqueId,
  SCHEMA_VERSION,
  StatusReported,
  validationDetails,
  type AssessmentResponse,
  type ObservationAnswer,
} from "../contracts/index.ts";
import { HttpError } from "../http/respond.ts";
import { log } from "../http/log.ts";

/** Evaluaciones por sesión: la inicial + 3 rondas de preguntas. */
const MAX_ASSESSMENTS = 4;
const MAX_QUESTIONS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const ConversationId = z.string().min(1).max(200).nullish().transform((v) => v ?? null);

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

export const AssessObservationInput = z.object({
  session_id: OpaqueId,
  plot_id: OpaqueId,
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
  now?: () => Date;
}

interface ToolSession {
  assessments: number;
  last_assessment_id: string | null;
  plot: { plot_id: string; crop: string | null; variety: string | null } | null;
  reports: number;
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(422, "VALIDATION_ERROR", "Parámetros de la herramienta inválidos", { details: validationDetails(result.error) });
  }
  return result.data;
}

const NOT_REGISTERED_PENDING =
  "NO digas que quedó registrado. Di que no pudiste confirmar el registro, que el sistema lo va a reintentar y que no necesita volver a llamar.";
const NOT_REGISTERED_FAILED = "NO digas que quedó registrado. Di que no se pudo registrar y que un técnico revisará su caso.";

export class VoiceTools {
  private readonly now: () => Date;
  /** Estado por sesión de voz; vive lo que dura una llamada. */
  private readonly sessions = new Map<string, ToolSession>();

  constructor(private readonly deps: VoiceToolsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** `submit_followup`: todas las respuestas del seguimiento en una sola petición (10.4). */
  async submitFollowup(raw: unknown): Promise<ToolReply> {
    const input = parse(SubmitFollowupInput, raw);
    const changeNoticedAt =
      input.change_noticed_days_ago === null ? null : startOfUtcDay(this.now().getTime() - input.change_noticed_days_ago * DAY_MS);

    const outcome = await this.deps.writer.submitFollowup(
      input.followup_id,
      {
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
      },
      followupIdempotencyKey(input.followup_id, input.session_id),
    );
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
    const asked = new Set([...input.asked_need_codes, ...input.answers.map((a) => a.need_code)]);

    if (session.assessments >= MAX_ASSESSMENTS || asked.size >= MAX_QUESTIONS) {
      return ok({
        disposition: "limit_reached",
        instruction:
          "No hagas más preguntas. Di que con lo que te contó un técnico revisará su caso y llama a submit_report con completeness \"partial\".",
      });
    }

    if (!session.plot || session.plot.plot_id !== input.plot_id) {
      const context = await this.deps.client.getPlotContext(input.plot_id, input.session_id);
      // Sin contexto la evaluación sigue; cultivo y variedad quedan como desconocidos (null).
      session.plot = context.ok
        ? { plot_id: input.plot_id, crop: context.data.crop, variety: context.data.variety }
        : { plot_id: input.plot_id, crop: null, variety: null };
    }

    session.assessments += 1;
    const assessed = await this.deps.client.assess({
      schema_version: SCHEMA_VERSION,
      session_id: input.session_id,
      plot_id: input.plot_id,
      language: this.deps.defaultLanguage,
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
    session.reports += 1;

    const outcome = await this.deps.writer.submitReport(
      {
        schema_version: SCHEMA_VERSION,
        session_id: input.session_id,
        plot_id: input.plot_id,
        case_id: null,
        channel: "voice",
        provider_reference: input.conversation_id,
        observed_at: null,
        symptoms: input.symptoms,
        measurements: [],
        user_statement: input.user_statement,
        completeness: input.completeness,
        assessment_id: input.assessment_id ?? session.last_assessment_id,
        is_demo: this.deps.isDemo,
      },
      // Estable por sesión y turno: si el modelo repite la herramienta, el backend devuelve el original.
      reportIdempotencyKey(input.session_id, session.reports),
    );
    log("info", "tool_submit_report", { correlation_id: input.session_id, outcome: outcome.status });

    if (outcome.status === "saved") {
      return ok({ registered: true, instruction: "Quedó registrado. Puedes decirlo, agradece y despídete." });
    }
    return ok({ registered: false, instruction: outcome.status === "pending" ? NOT_REGISTERED_PENDING : NOT_REGISTERED_FAILED });
  }

  private session(id: string): ToolSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = { assessments: 0, last_assessment_id: null, plot: null, reports: 0 };
      this.sessions.set(id, session);
      if (this.sessions.size > 5000) this.sessions.delete(this.sessions.keys().next().value!);
    }
    return session;
  }
}

/** Lo que el agente necesita para hablar; nada de `reason` interno ni IDs de datasets. */
function forAgent(assessment: AssessmentResponse, questionsLeft: number) {
  const needs = [...assessment.information_needs]
    .sort((a, b) => a.priority - b.priority)
    .map(({ need_code, variable, farmer_hint, answer_type, options, priority, can_be_unknown }) => ({
      need_code,
      variable,
      farmer_hint,
      answer_type,
      options,
      priority,
      can_be_unknown,
    }));
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
