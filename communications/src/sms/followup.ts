/**
 * Seguimiento por SMS: respaldo cuando se agotan las 3 llamadas (secciones 2.2
 * y 17). Envía una pregunta breve y convierte las respuestas en
 * `submit_followup` (10.4): cómo sigue la parcela, qué hizo y si funcionó.
 *
 * Reglas:
 *  - Solo con consentimiento de seguimiento, en horario permitido y, en demo,
 *    a números de la lista blanca.
 *  - El intento `contacting` se registra ANTES de enviar: liga la sesión a la
 *    parcela del caso para poder guardar la respuesta.
 *  - Envío ambiguo (timeout): no se reenvía; la sesión queda abierta por si responde.
 *  - Sin respuesta en la ventana: se registra `no_response`. Nunca se declara resolución.
 *  - Solo se dice "quedó registrado" tras un 201.
 */
import { randomUUID } from "node:crypto";
import { followupAttemptIdempotencyKey, followupIdempotencyKey, type BackendClient } from "../backend/client.ts";
import type { BackendWriter, WriteOutcome } from "../backend/writer.ts";
import { SCHEMA_VERSION, type FollowupListItem, type FollowupResponseCreated } from "../contracts/index.ts";
import { log, maskPhone } from "../http/log.ts";
import { canContact } from "../policy/outreach.ts";
import type { SmsSender } from "../twilio/sender.ts";
import { isDontKnow, parseActionWorked, parseStatusReported, sms } from "./messages.ts";
import { isOpen, type FollowupSmsSession, type SessionStore } from "./session.ts";

const MAX_INVALID_REPLIES = 3;
const OPEN_FOLLOWUP_STATUSES = new Set(["scheduled", "contacting", "no_response"]);

export interface FollowupFlowDeps {
  client: BackendClient;
  writer: BackendWriter;
  store: SessionStore;
  sender: SmsSender;
  isDemo: boolean;
  demoAllowlist: ReadonlySet<string>;
  /** Cuánto esperamos la respuesta antes de registrar `no_response`. */
  replyWindowMs: number;
  now?: () => Date;
}

export type FollowupStartResult =
  | { status: "sent"; session_id: string; provider_reference: string }
  | { status: "skipped"; reason: "closed" | "busy" | "no_consent" | "outside_hours" | "not_allowlisted" }
  | { status: "failed"; reason: "backend_error" | "provider_rejected" | "provider_ambiguous"; code: string };

export class FollowupSmsFlow {
  private readonly now: () => Date;

  constructor(private readonly deps: FollowupFlowDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Envía el SMS de seguimiento. Quien llama (el despachador de `followup.due`) decide cuándo. */
  async start(item: FollowupListItem): Promise<FollowupStartResult> {
    const phone = item.contact.phone_e164;
    const correlation = { followup_id: item.followup_id, phone: maskPhone(phone) };

    if (!OPEN_FOLLOWUP_STATUSES.has(item.status)) return this.skip("closed", correlation);
    const decision = canContact({
      phone_e164: phone,
      timezone: item.contact.timezone,
      allowed_hours: item.contact.allowed_hours,
      consent: item.contact.followup_call_consent,
      now: this.now(),
      isDemo: this.deps.isDemo,
      demoAllowlist: this.deps.demoAllowlist,
    });
    if (!decision.ok) return this.skip(decision.reason, correlation);
    // No se pisa una conversación en curso; el despachador lo reintentará.
    if (isOpen(this.deps.store.get(phone))) return this.skip("busy", correlation);

    const sessionId = `sms_fu_${randomUUID()}`;
    const attempt = await this.deps.client.recordFollowupAttempt(
      item.followup_id,
      {
        schema_version: SCHEMA_VERSION,
        session_id: sessionId,
        status: "contacting",
        channel: "sms",
        call_reference: null,
        occurred_at: this.now().toISOString(),
        is_demo: this.deps.isDemo,
      },
      followupAttemptIdempotencyKey(item.followup_id, sessionId, "contacting"),
    );
    if (!attempt.ok) {
      log("warn", "followup_sms_attempt_failed", { ...correlation, correlation_id: sessionId, code: attempt.code });
      return { status: "failed", reason: "backend_error", code: attempt.code };
    }

    const sent = await this.deps.sender.send(phone, sms.followupIntro(item.case_summary.farmer_name));
    if (!sent.ok && sent.kind === "rejected") {
      this.recordAttempt(item.followup_id, sessionId, "failed");
      log("warn", "followup_sms_rejected", { ...correlation, correlation_id: sessionId, code: sent.code });
      return { status: "failed", reason: "provider_rejected", code: sent.code };
    }

    const session: FollowupSmsSession = {
      kind: "followup",
      session_id: sessionId,
      phone_e164: phone,
      followup_id: item.followup_id,
      outbound_reference: sent.ok ? sent.provider_reference : null,
      first_reply_sid: null,
      created_at: this.now().toISOString(),
      last_activity_at: this.now().getTime(),
      stage: "status",
      invalid_replies: 0,
      status_reported: null,
      actions_taken: null,
      action_worked: null,
      statements: [],
      submitted: false,
    };
    // También tras un envío ambiguo: si el SMS sí salió, la respuesta debe encontrar su sesión.
    this.deps.store.set(session);

    if (!sent.ok) {
      log("warn", "followup_sms_ambiguous", { ...correlation, correlation_id: sessionId, code: sent.code });
      return { status: "failed", reason: "provider_ambiguous", code: sent.code };
    }
    log("info", "followup_sms_sent", { ...correlation, correlation_id: sessionId, provider_reference: sent.provider_reference, stubbed: sent.stubbed });
    return { status: "sent", session_id: sessionId, provider_reference: sent.provider_reference };
  }

  async handleReply(session: FollowupSmsSession, messageSid: string, text: string): Promise<string> {
    session.last_activity_at = this.now().getTime();
    session.first_reply_sid ??= messageSid;
    session.statements.push(text);

    switch (session.stage) {
      case "status": {
        const status = parseStatusReported(text);
        if (status === null) return this.reAsk(session, sms.followupStatusRetry);
        session.invalid_replies = 0;
        session.status_reported = status;
        session.stage = "actions";
        return sms.followupActions;
      }
      case "actions":
        session.actions_taken = isDontKnow(text) ? null : text;
        session.stage = "worked";
        return sms.followupWorked;
      case "worked": {
        const worked = parseActionWorked(text);
        if (worked === null) return this.reAsk(session, sms.followupWorked);
        session.action_worked = worked;
        return replyFor(session, await this.finish(session));
      }
      case "closed":
        return sms.notUnderstood;
    }
  }

  isIdle(session: FollowupSmsSession): boolean {
    return this.now().getTime() - session.last_activity_at > this.deps.replyWindowMs;
  }

  /**
   * Cierra la sesión. Con respuestas, guarda lo que hay (desconocido donde
   * falte). Sin ninguna respuesta: `no_response` si venció la ventana; nada si
   * pidió la baja (la baja ya impide más contactos).
   */
  async close(session: FollowupSmsSession, reason: "idle" | "opt_out"): Promise<void> {
    this.deps.store.delete(session.phone_e164);
    if (session.submitted) return;
    if (session.statements.length > 0) {
      await this.finish(session);
      return;
    }
    if (reason === "idle") {
      this.recordAttempt(session.followup_id, session.session_id, "no_response");
      log("info", "followup_sms_no_response", { correlation_id: session.session_id, followup_id: session.followup_id });
    }
  }

  private async finish(session: FollowupSmsSession): Promise<WriteOutcome<FollowupResponseCreated>> {
    session.stage = "closed";
    session.submitted = true;
    const outcome = await this.deps.writer.submitFollowup(
      session.followup_id,
      {
        schema_version: SCHEMA_VERSION,
        session_id: session.session_id,
        channel: "sms",
        status_reported: session.status_reported ?? "unknown",
        user_statement: session.statements.join("\n"),
        actions_taken: session.actions_taken,
        action_worked: session.action_worked ?? "unknown",
        change_noticed_at: null,
        provider_reference: session.first_reply_sid ?? session.outbound_reference,
        is_demo: this.deps.isDemo,
      },
      followupIdempotencyKey(session.followup_id, session.session_id),
    );
    log("info", "followup_sms_submitted", {
      correlation_id: session.session_id,
      followup_id: session.followup_id,
      outcome: outcome.status,
      status_reported: session.status_reported ?? "unknown",
    });
    return outcome;
  }

  private async reAsk(session: FollowupSmsSession, retry: string): Promise<string> {
    session.invalid_replies += 1;
    if (session.invalid_replies < MAX_INVALID_REPLIES) return `${sms.notUnderstood} ${retry}`;
    // Respondió, pero no entendimos: se guarda como desconocido con su texto, nunca como resolución.
    return replyFor(session, await this.finish(session));
  }

  private recordAttempt(followupId: string, sessionId: string, status: "no_response" | "failed"): void {
    this.deps.writer.track(
      this.deps.writer.recordFollowupAttempt(
        followupId,
        {
          schema_version: SCHEMA_VERSION,
          session_id: sessionId,
          status,
          channel: "sms",
          call_reference: null,
          occurred_at: this.now().toISOString(),
          is_demo: this.deps.isDemo,
        },
        followupAttemptIdempotencyKey(followupId, sessionId, status),
      ),
    );
  }

  private skip(reason: Extract<FollowupStartResult, { status: "skipped" }>["reason"], fields: Record<string, unknown>): FollowupStartResult {
    log("info", "followup_sms_skipped", { ...fields, outcome: reason });
    return { status: "skipped", reason };
  }
}

function replyFor(session: FollowupSmsSession, outcome: WriteOutcome<FollowupResponseCreated>): string {
  if (outcome.status === "saved") return sms.followupSaved(session.status_reported ?? "unknown");
  return outcome.status === "pending" ? sms.notConfirmed : sms.notSaved;
}
