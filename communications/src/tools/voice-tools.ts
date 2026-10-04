/**
 * Server tools for the ElevenLabs agents (CLAUDE.md, section 4). The agent
 * calls communications, not the backend: that way it never gets service
 * credentials and the rules are enforced in code, not in the prompt.
 *
 * Two agents share these tools:
 *  - Help (inbound call, section 2.1): `resolve_farmer` → `confirm_farmer` →
 *    `get_plot_context` → `record_consent` → `assess_observation` → `submit_report`.
 *    The session is the ElevenLabs `conversation_id` and the phone is the caller ID
 *    (system variables). Identity, plot and permissions live here: the model only
 *    sees numbered names, never tokens or IDs, and can't pick another plot or
 *    save without permission.
 *  - Follow-up (outbound call, section 2.2): `submit_followup` and, if it got worse,
 *    `assess_observation` and `submit_report` with the session and plot the dispatcher set.
 *  - Alerts (outbound call for an approved alert): `acknowledge_alert`, delegated to the
 *    alert dispatcher, which owns the notification's state.
 *
 * Shared rules:
 *  - IDs come from dynamic variables; the model never writes them.
 *  - Only `registered: true` allows saying "it's been recorded"; any other result
 *    carries an explicit instruction that it was NOT recorded.
 *  - "I don't know" is validated as `value: null, unknown: true`, never zero.
 *  - At most 3 rounds and 5 questions per call (section 17), however much the model insists.
 *
 * Replies are 200 with a structured result for the model to read; only
 * authentication and validation return 4xx with the uniform error.
 */
import { z } from "zod";
import type { AlertDispatcher } from "../alerts/dispatcher.ts";
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
/** With no activity for this long, a help call is considered dropped. */
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

const ConversationId = z.string().min(1).max(200).nullish().transform((v) => v ?? null);
const OptionalBoolean = z.boolean().nullish().transform((v) => v ?? null);

/**
 * Answer as the model sends it (it may omit `value` or `unit`). Normalized to
 * the contract: "I don't know" → `value: null, unknown: true`; never a zero.
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
  /** Days since they noticed the change; null if unknown or no change. The agent never dictates ISO dates. */
  change_noticed_days_ago: z.number().int().min(0).max(365).nullish().transform((v) => v ?? null),
});

export const AcknowledgeAlertInput = z.object({
  session_id: OpaqueId,
  notification_id: OpaqueId,
  conversation_id: ConversationId,
  /** heard: they confirmed they heard the alert. wrong_person: someone else answered (nothing was read). */
  outcome: z.enum(["heard", "wrong_person"]),
});

export const ResolveFarmerInput = z.object({
  session_id: OpaqueId,
  /** `system__caller_id`. Hidden or invalid → unidentified number (never guessed). */
  caller_phone: z.string().max(64).nullish().transform((v) => normalizeE164(v)),
});

export const ConfirmFarmerInput = z.object({
  session_id: OpaqueId,
  /** Number from the list `resolve_farmer` returned (1 = the first). */
  candidate_number: z.coerce.number().int().min(1).max(20),
});

export const GetPlotContextInput = z.object({
  session_id: OpaqueId,
  /** Number from `confirm_farmer`'s plot list; may be omitted when there is only one. */
  plot_number: z.coerce.number().int().min(1).max(50).nullish().transform((v) => v ?? null),
});

export const RecordConsentInput = z.object({
  session_id: OpaqueId,
  /** null or omitted = not asked in this call. */
  reports: OptionalBoolean,
  notifications: OptionalBoolean,
  followup_calls: OptionalBoolean,
});

export const AssessObservationInput = z.object({
  session_id: OpaqueId,
  /** Only the follow-up agent sends it (dynamic variable); help calls use the confirmed plot. */
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
  /** Alert dispatcher; without it `acknowledge_alert` records nothing. */
  alerts?: AlertDispatcher;
  /** Inactivity after which a help call is considered dropped (and what was described is saved as partial). */
  idleMs?: number;
  now?: () => Date;
}

/** State of a help call: what the model must not be able to make up. */
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
  /** Answers in this call; null = not asked. */
  consent: Record<ConsentScope, boolean | null>;
  consent_writes: number;
  /** Last assessed description: if the call drops without `submit_report`, it is saved as partial. */
  statement: string;
  symptoms: string[];
}

interface ToolSession {
  assessments: number;
  last_assessment_id: string | null;
  plot: { plot_id: string; crop: string | null; variety: string | null } | null;
  reports: number;
  /** Only in help calls (started by `resolve_farmer`). */
  help: HelpState | null;
  last_activity_at: number;
  /** Last advisor disposition: "advise" means the evaluation finished. */
  last_disposition: string | null;
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  return parseBody(schema, raw, "Invalid tool parameters");
}

const NOT_REGISTERED_PENDING =
  "Do NOT say it was recorded. Say you couldn't confirm the record, that the system will retry and that they don't need to call again.";
const NOT_REGISTERED_FAILED = "Do NOT say it was recorded. Say it couldn't be recorded and that a technician will review their case.";
const UNKNOWN_CALLER =
  "There is no record for this number. Don't look up or pick a plot and don't mention any names. Ask for permission to save their report and call record_consent with reports. If they agree, ask them to describe the problem and call submit_report with completeness \"partial\": a technician will review it. Without a registered plot there is no assessment.";
const REPORTS_DECLINED =
  "They did not agree to us saving their report: do NOT call submit_report or assess_observation. Tell them that's fine, that they can call anytime, and say goodbye.";
const NO_REPORT_CONSENT =
  "Do NOT say it was recorded. Before saving, ask whether they give us permission to save their report so a technician can review it, and call record_consent with reports. If they say no, don't save anything.";

export class VoiceTools {
  private readonly now: () => Date;
  private readonly idleMs: number;
  /** State per voice session; lives as long as a call. */
  private readonly sessions = new BoundedMap<string, ToolSession>();

  constructor(private readonly deps: VoiceToolsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  }

  // --- Help agent: identity, plot and permissions ---

  /** `resolve_farmer`: candidates by caller ID. The number is not proof of identity: names only, no data. */
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
      return ok({ status: "unavailable", instruction: `You couldn't look up their record because of a technical issue. ${UNKNOWN_CALLER}` });
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
          ? `Ask whether you're speaking with ${only!.label}. If they say yes, call confirm_farmer with candidate_number 1. Don't say anything else about their record before confirming.`
          : "Several people share this phone. Ask which one you're speaking with, reading only the names, and call confirm_farmer with their number. Don't say anything else about anyone before confirming.",
    });
  }

  /** `confirm_farmer`: the farmer said who they are; unlocks their plots and permissions for this call. */
  async confirmFarmer(raw: unknown): Promise<ToolReply> {
    const input = parse(ConfirmFarmerInput, raw);
    const session = this.session(input.session_id);
    const help = session.help;
    if (!help?.phone_e164 || help.candidates.length === 0) {
      return ok({ confirmed: false, instruction: "There is no one to confirm. If you haven't, call resolve_farmer first; if they aren't registered, continue as an unregistered number." });
    }
    const candidate = help.candidates[input.candidate_number - 1];
    if (!candidate) {
      return ok({ confirmed: false, candidates: numbered(help.candidates.map((c) => c.label)), instruction: `Use a number between 1 and ${help.candidates.length}.` });
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
      // The backend signs each candidate for 15 minutes: fetch fresh ones and ask again.
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
        instruction: "The confirmation expired. Ask again who you're speaking with and call confirm_farmer again.",
      });
    }
    if (!confirmed.ok || !confirmed.data.confirmed) {
      log("warn", "tool_confirm_farmer_failed", { correlation_id: input.session_id, code: confirmed.ok ? "NOT_CONFIRMED" : confirmed.code });
      return ok({ confirmed: false, instruction: `You couldn't confirm their record because of a technical issue. ${UNKNOWN_CALLER}` });
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
        ? "They have no registered plots: there is no assessment. Continue with the permissions, ask them to describe the problem and save the report with completeness \"partial\"."
        : farmer.plots.length === 1
          ? "Call get_plot_context."
          : "Ask which plot this is about, reading their names, and call get_plot_context with its number.";
    return ok({
      confirmed: true,
      farmer_name: candidate.label,
      plots: numbered(farmer.plots.map((p) => p.label)),
      report_permission: permissionState(farmer.consent.reports),
      /** Permissions they never answered: asked one at a time. */
      ask_permissions: (["notifications", "followup_calls"] as const).filter((scope) => farmer.consent[scope] === null),
      instruction: plotInstruction,
    });
  }

  /** `get_plot_context`: only a plot of the confirmed farmer; it stays fixed for the rest of the call. */
  async getPlotContext(raw: unknown): Promise<ToolReply> {
    const input = parse(GetPlotContextInput, raw);
    const session = this.session(input.session_id);
    const farmer = session.help?.farmer;
    if (!farmer) {
      return ok({ found: false, instruction: "First confirm who you're speaking with (confirm_farmer). Never pick a plot on your own." });
    }
    const number = input.plot_number ?? (farmer.plots.length === 1 ? 1 : null);
    const plot = number === null ? undefined : farmer.plots[number - 1];
    if (!plot) {
      return ok({
        found: false,
        plots: numbered(farmer.plots.map((p) => p.label)),
        instruction: farmer.plots.length === 0 ? "They have no registered plots." : "Ask which plot this is about and call get_plot_context with its number.",
      });
    }

    const context = await this.deps.client.getPlotContext(plot.plot_id, input.session_id);
    // Without context the plot is still confirmed; crop and variety stay unknown (null).
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
        "Plot confirmed. Don't read out technical data. Continue with any missing permissions and ask them to describe what they see on their plants.",
    });
  }

  /** `record_consent`: three separate permissions (section 17); only stored for a confirmed farmer. */
  async recordConsent(raw: unknown): Promise<ToolReply> {
    const input = parse(RecordConsentInput, raw);
    const session = this.session(input.session_id);
    const help = session.help;
    if (!help) return ok({ saved: false, instruction: "Call resolve_farmer first." });

    for (const scope of ["reports", "notifications", "followup_calls"] as const) {
      if (input[scope] !== null) help.consent[scope] = input[scope];
    }
    const next = input.reports === false ? REPORTS_DECLINED : "Continue.";
    // Unregistered number: the permission is valid for this call only.
    if (!help.farmer) return ok({ saved: true, valid_for_this_call_only: true, instruction: next });

    // Confirming this report when permission already existed isn't resent; declining doesn't revoke an existing permission.
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
    return ok({ saved: false, instruction: `Don't say their permissions were saved; the system will retry. ${next}` });
  }

  // --- Both agents ---

  /** `submit_followup`: all the follow-up answers in a single request (10.4). */
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
        instruction: closed ? "This follow-up was already recorded. Do NOT say you recorded it now; thank them and say goodbye." : NOT_REGISTERED_FAILED,
      });
    }

    const worse = input.status_reported === "worse";
    return ok({
      registered: true,
      case_status: outcome.data.case_status,
      resolved: outcome.data.resolution_id !== null,
      next_followup_scheduled: outcome.data.next_followup_at !== null,
      instruction: worse
        ? "It's been recorded. Since it got worse, ask what they see on their plants now and call assess_observation with their description, as in a help call."
        : outcome.data.resolution_id !== null
          ? "It's been recorded. Thank them, say you're glad it's resolved and say goodbye."
          : "It's been recorded. Thank them, tell them we'll check in again in a few days and say goodbye.",
    });
  }

  /** `acknowledge_alert`: `registered: true` only once the backend confirmed the notification's state. */
  async acknowledgeAlert(raw: unknown): Promise<ToolReply> {
    const input = parse(AcknowledgeAlertInput, raw);
    this.session(input.session_id);
    const heard = input.outcome === "heard";
    const after = heard
      ? "If they say they see symptoms on their own plants, give them the help line. Then say goodbye and end the call."
      : "Don't read the alert and don't mention any name, plot or detail of it. Apologize for the trouble, say goodbye and end the call.";
    if (!this.deps.alerts) return ok({ registered: false, instruction: `Do NOT say it was recorded. ${after}` });

    const result = await this.deps.alerts.acknowledge(input);
    if (result.registered) return ok({ registered: true, instruction: heard ? `It's been recorded that they heard the alert. ${after}` : after });
    if (result.reason === "closed") {
      return ok({ registered: false, instruction: `This alert was already closed. Do NOT say it was recorded now and don't call acknowledge_alert again. ${after}` });
    }
    return ok({
      registered: false,
      instruction: `Do NOT say it was recorded. ${heard ? "Thank them; the system will retry saving it. " : ""}${after}`,
    });
  }

  /** `assess_observation`: information needs or guidance, within the limits of section 17. */
  async assessObservation(raw: unknown): Promise<ToolReply> {
    const input = parse(AssessObservationInput, raw);
    const session = this.session(input.session_id);
    const help = session.help;
    // In help calls the confirmed plot wins, never the one the model names.
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
          "Without a confirmed plot there is no assessment. Tell them a technician will review their case and call submit_report with completeness \"partial\".",
      });
    }

    const asked = new Set([...input.asked_need_codes, ...input.answers.map((a) => a.need_code)]);
    if (session.assessments >= MAX_ASSESSMENTS || asked.size >= MAX_QUESTIONS) {
      return ok({
        disposition: "limit_reached",
        instruction:
          "Don't ask any more questions. Say that a technician will review their case with what they told you and call submit_report with completeness \"partial\".",
      });
    }

    if (!session.plot || session.plot.plot_id !== plotId) {
      const context = await this.deps.client.getPlotContext(plotId, input.session_id);
      // Without context the assessment goes ahead; crop and variety stay unknown (null).
      session.plot = context.ok
        ? { plot_id: plotId, crop: context.data.crop, variety: context.data.variety }
        : { plot_id: plotId, crop: null, variety: null };
    }

    session.assessments += 1;
    const assessed = await this.deps.client.assess({
      schema_version: SCHEMA_VERSION,
      session_id: input.session_id,
      plot_id: plotId,
      // The conversation runs in the agent's language; the farmer's stored preference may differ.
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
          "Say the assessment couldn't be completed, that a technician will review their case and that there will be a follow-up. Do NOT make up guidance. Call submit_report with completeness \"partial\".",
      });
    }
    session.last_assessment_id = assessed.data.assessment_id;
    session.last_disposition = assessed.data.disposition;
    return ok(forAgent(assessed.data, MAX_QUESTIONS - asked.size));
  }

  /** `submit_report`: saves the observation the farmer confirmed. */
  async submitReport(raw: unknown): Promise<ToolReply> {
    const input = parse(SubmitReportInput, raw);
    const session = this.session(input.session_id);
    const help = session.help;
    if (help && !reportAllowed(help)) {
      return ok({ registered: false, instruction: help.consent.reports === false ? REPORTS_DECLINED : NO_REPORT_CONSENT });
    }

    const outcome = await this.saveReport(input.session_id, session, {
      // In help calls, the confirmed plot (or none, for an unregistered number); never the model's.
      plot_id: help ? (session.plot?.plot_id ?? null) : input.plot_id,
      provider_reference: input.conversation_id ?? (help ? input.session_id : null),
      user_statement: input.user_statement,
      symptoms: input.symptoms,
      completeness: input.completeness,
      assessment_id: input.assessment_id ?? session.last_assessment_id,
    });
    log("info", "tool_submit_report", { correlation_id: input.session_id, outcome: outcome.status });

    if (outcome.status === "saved") {
      return ok({ registered: true, instruction: "It's been recorded. You can say so; thank them and say goodbye." });
    }
    return ok({ registered: false, instruction: outcome.status === "pending" ? NOT_REGISTERED_PENDING : NOT_REGISTERED_FAILED });
  }

  /**
   * Help calls that dropped without `submit_report` (section 4): if there was permission and a
   * description, only what was received is saved as `completeness: "partial"`.
   */
  async sweep(): Promise<void> {
    const now = this.now().getTime();
    for (const [sessionId, session] of [...this.sessions]) {
      if (now - session.last_activity_at > this.idleMs) await this.saveUnsubmitted(sessionId, session, "partial");
    }
  }

  /**
   * ElevenLabs' post-call webhook: the call is over. A help call that ended without `submit_report`
   * (the model said goodbye first, or the line dropped) is saved now with what was evaluated, instead
   * of waiting for the idle sweep. Only with permission and a description; never twice.
   */
  async callEnded(conversationId: string): Promise<"saved" | "pending" | "failed" | "nothing_to_save"> {
    const session = this.sessions.get(conversationId);
    if (!session) return "nothing_to_save";
    const completeness = session.last_disposition === "advise" ? "sufficient" : "partial";
    return (await this.saveUnsubmitted(conversationId, session, completeness)) ?? "nothing_to_save";
  }

  private async saveUnsubmitted(sessionId: string, session: ToolSession, completeness: "partial" | "sufficient") {
    const help = session.help;
    if (!help || session.reports > 0 || !help.statement || !reportAllowed(help)) return null;
    const outcome = await this.saveReport(sessionId, session, {
      plot_id: session.plot?.plot_id ?? null,
      provider_reference: sessionId,
      user_statement: help.statement,
      symptoms: help.symptoms,
      completeness,
      assessment_id: session.last_assessment_id,
    });
    log("info", "help_call_saved_without_submit", { correlation_id: sessionId, outcome: outcome.status, completeness });
    return outcome.status;
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
      // Stable per session and turn: if the model repeats the tool call, the backend returns the original.
      reportIdempotencyKey(sessionId, session.reports),
    );
  }

  private session(id: string): ToolSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = { assessments: 0, last_assessment_id: null, plot: null, reports: 0, help: null, last_activity_at: 0, last_disposition: null };
      this.sessions.set(id, session);
    }
    session.last_activity_at = this.now().getTime();
    return session;
  }
}

/** With permission given in this call, or stored earlier and not declined now. */
function reportAllowed(help: HelpState): boolean {
  if (help.consent.reports !== null) return help.consent.reports;
  return help.farmer?.stored_consent.reports === true;
}

function permissionState(value: boolean | null): "granted" | "denied" | "never_asked" {
  return value === true ? "granted" : value === false ? "denied" : "never_asked";
}

/** The model sees "1 Rosa, 2 Marta"; tokens and IDs stay in communications. */
function numbered(labels: string[]): { number: number; label: string }[] {
  return labels.map((label, i) => ({ number: i + 1, label }));
}

/** What the agent needs to speak; no internal `reason` or dataset IDs. */
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
        "Ask ONE question only: the priority 1 need, in plain words based on farmer_hint, never with the technical name. Normalize the answer according to answer_type; if they say they don't know, send it with value null and unknown true. Then call assess_observation again with all the answers and asked_need_codes.",
    };
  }
  if (assessment.disposition === "advise") {
    return {
      ...base,
      recommendations: assessment.recommendations.map((r) => r.text),
      resolved_case_mentions: assessment.resolved_case_mentions.map((m) => ({ summary: m.summary_for_speech, verification: m.verification })),
      instruction:
        "Make clear this doesn't confirm any disease and that a technician will review it. Convey the recommendations in your own words, in English. If there is a resolved case, tell it as another farmer's experience (if verification is not \"verified\", say it isn't verified). Then call submit_report with completeness \"sufficient\".",
    };
  }
  return {
    ...base,
    disposition: "refer" as const,
    instruction:
      "Say that with what they told you, you can't give safe guidance and that a technician will review their case. Do NOT recommend products or doses. Call submit_report with completeness \"partial\".",
  };
}

function ok(body: unknown): ToolReply {
  return { status: 200, body };
}

function startOfUtcDay(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}
