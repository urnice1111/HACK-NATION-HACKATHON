/**
 * SMS follow-up: fallback once the 3 calls are used up (sections 2.2 and 17).
 * Sends a short question and turns the replies into `submit_followup` (10.4):
 * how the plot is doing, what they did and whether it worked.
 *
 * Rules:
 *  - Only with follow-up consent, within allowed hours and, in demo, to
 *    allowlisted numbers.
 *  - The `contacting` attempt is recorded BEFORE sending: it binds the session
 *    to the case's plot so the reply can be saved.
 *  - Ambiguous send (timeout): never resent; the session stays open in case they reply.
 *  - No reply within the window: `no_response` is recorded. Never declares a resolution.
 *  - "It's been recorded" is only said after a 201.
 */
import { randomUUID } from "node:crypto";
import type { BackendClient } from "../backend/client.ts";
import type { BackendWriter, WriteOutcome } from "../backend/writer.ts";
import { SCHEMA_VERSION, type FollowupAttemptRequest, type FollowupListItem, type FollowupResponseCreated } from "../contracts/index.ts";
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
  /** DEMO_IGNORE_ALLOWED_HOURS (demo only). */
  ignoreAllowedHours?: boolean;
  /** How long we wait for a reply before recording `no_response`. */
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

  /** Sends the follow-up SMS. The caller (the `followup.due` dispatcher) decides when. */
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
      ignoreAllowedHours: this.deps.ignoreAllowedHours,
    });
    if (!decision.ok) return this.skip(decision.reason, correlation);
    // Never step on an ongoing conversation; the dispatcher will retry.
    if (isOpen(this.deps.store.get(phone))) return this.skip("busy", correlation);

    const sessionId = `sms_fu_${randomUUID()}`;
    const attempt = await this.deps.client.recordFollowupAttempt(item.followup_id, this.attemptBody(sessionId, "contacting"));
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
      last_activity_at: this.now().getTime(),
      stage: "status",
      invalid_replies: 0,
      status_reported: null,
      actions_taken: null,
      action_worked: null,
      statements: [],
      submitted: false,
    };
    // Also after an ambiguous send: if the SMS did go out, the reply must find its session.
    this.deps.store.set(phone, session);

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
   * Closes the session. With replies, saves what there is (unknown where
   * missing). With no reply at all: `no_response` if the window expired; nothing
   * if they opted out (the opt-out already prevents further contact).
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
    const outcome = await this.deps.writer.submitFollowup(session.followup_id, {
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
    });
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
    // They replied but we couldn't parse it: saved as unknown with their text, never as a resolution.
    return replyFor(session, await this.finish(session));
  }

  /** In the background: doesn't block the reply and retries with the same key. */
  private recordAttempt(followupId: string, sessionId: string, status: "no_response" | "failed"): void {
    this.deps.writer.track(this.deps.writer.recordFollowupAttempt(followupId, this.attemptBody(sessionId, status)));
  }

  private attemptBody(sessionId: string, status: FollowupAttemptRequest["status"]): FollowupAttemptRequest {
    return {
      schema_version: SCHEMA_VERSION,
      session_id: sessionId,
      status,
      channel: "sms",
      call_reference: null,
      occurred_at: this.now().toISOString(),
      is_demo: this.deps.isDemo,
    };
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
