/**
 * SMS conversation: identity → plot → consent → observation → advisor
 * questions → report. Replies to an SMS follow-up are delegated to
 * `FollowupSmsFlow`.
 *
 * Rules (CLAUDE.md, sections 4, 15 and 17):
 *  - The phone number is not proof of identity: the candidate is always confirmed.
 *  - A plot is never picked at random; without confirmation the report has no plot.
 *  - Nothing is saved without consent. Three separate permissions (reports,
 *    alerts, follow-up calls); only the missing ones are asked, and every
 *    report is confirmed before it is saved.
 *  - "ALERTS OFF" (and STOP) revoke alerts and follow-ups in the backend.
 *  - "It's been recorded" is only said after a 201 from the backend.
 *  - If the advisor fails, we say so and save the report without made-up guidance.
 *  - At most two blocking backend calls per SMS, so Twilio gets its answer in
 *    time; consent is saved in the background.
 */
import { randomUUID } from "node:crypto";
import type { BackendClient } from "../backend/client.ts";
import type { BackendWriter, WriteOutcome } from "../backend/writer.ts";
import { MAX_ASSESSMENTS, MAX_QUESTIONS, SCHEMA_VERSION, type ReportRequest } from "../contracts/index.ts";
import { log, maskPhone } from "../http/log.ts";
import type { FollowupSmsFlow } from "./followup.ts";
import {
  adviceText,
  answerFrom,
  isAlertsOffKeyword,
  isGreetingOnly,
  isOptOutKeyword,
  needQuestion,
  parseChoice,
  parseYesNo,
  sms,
} from "./messages.ts";
import { isOpen, type AnySession, type ConsentScope, type SessionStore, type SmsSession } from "./session.ts";

const MAX_INVALID_REPLIES = 3;

export interface InboundSms {
  message_sid: string;
  from: string;
  text: string;
  num_media: number;
}

export interface ConversationDeps {
  client: BackendClient;
  store: SessionStore;
  writer: BackendWriter;
  followups: FollowupSmsFlow;
  isDemo: boolean;
  defaultLanguage: string;
  idleMs: number;
  now?: () => Date;
}

export class SmsConversation {
  private readonly now: () => Date;

  constructor(private readonly deps: ConversationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Returns the reply text, or null to send no reply. */
  async handle(msg: InboundSms): Promise<string | null> {
    const text = msg.text.trim();

    if (isAlertsOffKeyword(text)) return this.optOut(msg, true);
    // STOP and friends: Twilio answers and blocks; we revoke so the backend matches.
    if (isOptOutKeyword(text)) return this.optOut(msg, false);

    const stored = this.deps.store.get(msg.from);
    let session = isOpen(stored) ? stored : undefined;
    if (session && this.isIdle(session)) {
      await this.closeIdle(session);
      session = undefined;
    }
    if (session?.kind === "help") session.last_activity_at = this.now().getTime();

    if (!text) return msg.num_media > 0 ? sms.textOnly : null;
    if (!session) return this.start(msg, text);
    if (session.kind === "followup") return this.deps.followups.handleReply(session, msg.message_sid, text);

    switch (session.stage.kind) {
      case "identify":
        return this.onIdentify(session, session.stage.candidates, text);
      case "choose_plot":
        return this.onChoosePlot(session, session.stage.plots, text);
      case "consent":
        return this.onConsent(session, session.stage.scope, text);
      case "describe":
        session.statements.push(text);
        return this.assessAndMaybeFinish(session);
      case "answer":
        session.answers.push(answerFrom(session.stage.need, text));
        session.statements.push(text);
        return this.assessAndMaybeFinish(session);
      case "closed":
        return null;
    }
  }

  /** Closes idle conversations: saves what was received as partial, or records the follow-up as unanswered. */
  async sweep(): Promise<void> {
    for (const session of [...this.deps.store.values()]) {
      if (isOpen(session) && this.isIdle(session)) await this.closeIdle(session);
    }
  }

  // --- Opt-out ---

  private async optOut(msg: InboundSms, reply: boolean): Promise<string | null> {
    const existing = this.deps.store.get(msg.from);
    if (isOpen(existing)) {
      if (existing.kind === "followup") await this.deps.followups.close(existing, "opt_out");
      else await this.closeHelp(existing);
    } else {
      this.deps.store.delete(msg.from);
    }

    const outcome = await this.deps.writer.revokeConsent(
      {
        schema_version: SCHEMA_VERSION,
        phone_e164: msg.from,
        channel: "sms",
        scopes: ["notifications", "followup_calls"],
        provider_reference: msg.message_sid,
        is_demo: this.deps.isDemo,
      },
      msg.message_sid,
    );
    log("info", "sms_opt_out", { phone: maskPhone(msg.from), outcome: outcome.status, keyword: reply ? "alerts_off" : "stop" });
    if (!reply) return null;
    if (outcome.status === "saved") return sms.optedOut;
    return outcome.status === "pending" ? sms.optOutPending : sms.optOutFailed;
  }

  // --- Stages ---

  private async start(msg: InboundSms, text: string): Promise<string> {
    const session: SmsSession = {
      kind: "help",
      session_id: `sms_${randomUUID()}`,
      phone_e164: msg.from,
      first_message_sid: msg.message_sid,
      last_activity_at: this.now().getTime(),
      stage: { kind: "consent", scope: "reports" },
      invalid_replies: 0,
      farmer: null,
      plot: null,
      stored_consent: null,
      consent: { reports: null, notifications: null, followup_calls: null },
      statements: isGreetingOnly(text) ? [] : [text],
      answers: [],
      asked_need_codes: [],
      assessment_rounds: 0,
      last_assessment_id: null,
      report_submitted: false,
    };

    const resolved = await this.deps.client.resolveContact({
      schema_version: SCHEMA_VERSION,
      session_id: session.session_id,
      phone_e164: msg.from,
      channel: "sms",
      confirm_candidate_token: null,
      is_demo: this.deps.isDemo,
    });
    if (!resolved.ok) {
      log("warn", "sms_contact_resolution_failed", { correlation_id: session.session_id, code: resolved.code });
      return sms.technicalIssue;
    }

    log("info", "sms_conversation_started", {
      correlation_id: session.session_id,
      phone: maskPhone(msg.from),
      outcome: resolved.data.resolution_status,
    });
    this.deps.store.set(session.phone_e164, session);

    const candidates = resolved.data.candidates;
    if (candidates.length === 0) return `${sms.unknownNumber} ${sms.consent}`;
    session.stage = { kind: "identify", candidates };
    return sms.identify(candidates.map((c) => c.label));
  }

  private async onIdentify(session: SmsSession, candidates: { candidate_token: string; label: string }[], text: string): Promise<string> {
    let choice = parseChoice(text, candidates.length);
    if (choice === null && candidates.length === 1 && parseYesNo(text) === true) choice = 0;
    if (choice === null) return this.reAsk(session, sms.identify(candidates.map((c) => c.label)));
    session.invalid_replies = 0;

    if (choice === "none") {
      // None of the registered people: treat it as an unknown number, with no plot.
      session.stage = { kind: "consent", scope: "reports" };
      return sms.consent;
    }

    const confirmed = await this.deps.client.resolveContact({
      schema_version: SCHEMA_VERSION,
      session_id: session.session_id,
      phone_e164: session.phone_e164,
      channel: "sms",
      confirm_candidate_token: candidates[choice]!.candidate_token,
      is_demo: this.deps.isDemo,
    });
    if (!confirmed.ok && confirmed.code === "CANDIDATE_TOKEN_INVALID") return this.refreshCandidates(session);
    if (!confirmed.ok || !confirmed.data.confirmed) return sms.technicalIssue;

    const { farmer_id, preferred_language, consent, plots } = confirmed.data.confirmed;
    session.farmer = { farmer_id, language: preferred_language };
    session.stored_consent = consent;
    if (plots.length === 0) return this.askConsent(session);
    if (plots.length > 1) {
      session.stage = { kind: "choose_plot", plots };
      return sms.choosePlot(plots.map((p) => p.label));
    }
    return this.selectPlot(session, plots[0]!.plot_id);
  }

  /**
   * The backend signs each candidate for 15 minutes, only for this session and phone. If it expired,
   * we fetch fresh candidates and ask again; nobody is ever confirmed without their answer.
   */
  private async refreshCandidates(session: SmsSession): Promise<string> {
    const resolved = await this.deps.client.resolveContact({
      schema_version: SCHEMA_VERSION,
      session_id: session.session_id,
      phone_e164: session.phone_e164,
      channel: "sms",
      confirm_candidate_token: null,
      is_demo: this.deps.isDemo,
    });
    if (!resolved.ok) return sms.technicalIssue;
    log("info", "sms_candidates_refreshed", { correlation_id: session.session_id, candidates: resolved.data.candidates.length });
    if (resolved.data.candidates.length === 0) {
      session.stage = { kind: "consent", scope: "reports" };
      return `${sms.unknownNumber} ${sms.consent}`;
    }
    session.stage = { kind: "identify", candidates: resolved.data.candidates };
    return sms.identify(resolved.data.candidates.map((c) => c.label), sms.identifyExpired);
  }

  private async onChoosePlot(session: SmsSession, plots: { plot_id: string; label: string }[], text: string): Promise<string> {
    const choice = parseChoice(text, plots.length);
    if (choice === null || choice === "none") return this.reAsk(session, sms.choosePlot(plots.map((p) => p.label)));
    session.invalid_replies = 0;
    return this.selectPlot(session, plots[choice]!.plot_id);
  }

  private async selectPlot(session: SmsSession, plotId: string): Promise<string> {
    const context = await this.deps.client.getPlotContext(plotId, session.session_id);
    // Without context the plot is still confirmed; crop and variety stay unknown (null).
    session.plot = context.ok
      ? { plot_id: plotId, crop: context.data.crop, variety: context.data.variety }
      : { plot_id: plotId, crop: null, variety: null };
    if (!context.ok) log("warn", "sms_plot_context_failed", { correlation_id: session.session_id, code: context.code });
    return this.askConsent(session);
  }

  // --- Consent ---

  /** Next permission to ask. Alerts and follow-ups only for a confirmed farmer who never answered them. */
  private nextConsentScope(session: SmsSession): ConsentScope | null {
    if (session.consent.reports === null) return "reports";
    if (!session.farmer) return null;
    if (session.stored_consent?.notifications == null && session.consent.notifications === null) return "notifications";
    if (session.stored_consent?.followup_calls == null && session.consent.followup_calls === null) return "followup_calls";
    return null;
  }

  private consentQuestion(session: SmsSession, scope: ConsentScope): string {
    if (scope === "notifications") return sms.consentNotifications;
    if (scope === "followup_calls") return sms.consentFollowupCalls;
    return session.stored_consent?.reports === true ? sms.confirmReport : sms.consent;
  }

  /** Only called when at least the report permission is missing, so it makes no backend calls. */
  private askConsent(session: SmsSession): string {
    const scope = this.nextConsentScope(session) ?? "reports";
    session.stage = { kind: "consent", scope };
    return this.consentQuestion(session, scope);
  }

  private async onConsent(session: SmsSession, scope: ConsentScope, text: string): Promise<string> {
    const answer = parseYesNo(text);
    if (answer === null) return this.reAsk(session, this.consentQuestion(session, scope));
    session.invalid_replies = 0;
    session.consent[scope] = answer;

    if (scope === "reports" && !answer) {
      this.recordConsent(session);
      session.statements = [];
      session.stage = { kind: "closed" };
      return sms.consentDeclined;
    }

    const next = this.nextConsentScope(session);
    if (next) {
      session.stage = { kind: "consent", scope: next };
      return this.consentQuestion(session, next);
    }

    this.recordConsent(session);
    if (session.statements.length === 0) {
      session.stage = { kind: "describe" };
      return sms.describe;
    }
    return this.assessAndMaybeFinish(session);
  }

  /**
   * Saves this conversation's new permissions in the background. Confirming a
   * report when permission already existed isn't resent; declining to save one
   * specific report doesn't revoke a permission that already existed either.
   */
  private recordConsent(session: SmsSession): void {
    if (!session.farmer) return;
    const stored = session.stored_consent;
    const reports = stored?.reports === true ? null : session.consent.reports;
    const { notifications, followup_calls } = session.consent;
    if (reports === null && notifications === null && followup_calls === null) return;
    this.deps.writer.track(
      this.deps.writer.recordConsent({
        schema_version: SCHEMA_VERSION,
        session_id: session.session_id,
        farmer_id: session.farmer.farmer_id,
        channel: "sms",
        reports,
        notifications,
        followup_calls,
        provider_reference: session.first_message_sid,
        is_demo: this.deps.isDemo,
      }),
    );
  }

  // --- Assessment ---

  private async assessAndMaybeFinish(session: SmsSession): Promise<string> {
    // No confirmed plot means no assessment: minimal record for human review.
    if (!session.plot) {
      const outcome = await this.finish(session, "partial");
      return closingText(outcome, sms.savedUnknown);
    }
    if (session.assessment_rounds >= MAX_ASSESSMENTS) {
      return closingText(await this.finish(session, "partial"));
    }

    session.assessment_rounds += 1;
    const assessed = await this.deps.client.assess({
      schema_version: SCHEMA_VERSION,
      session_id: session.session_id,
      plot_id: session.plot.plot_id,
      // SMS copy is in the service language; the farmer's stored preference may differ.
      language: this.deps.defaultLanguage,
      observation: {
        observed_at: null,
        symptoms: [],
        user_statement: session.statements.join("\n"),
        measurements: [],
        answers: session.answers,
        completeness: "partial",
      },
      asked_need_codes: session.asked_need_codes,
      plot_context: { crop: session.plot.crop, variety: session.plot.variety },
      is_demo: this.deps.isDemo,
    });

    if (!assessed.ok) {
      log("warn", "sms_assessment_failed", { correlation_id: session.session_id, code: assessed.code });
      const outcome = await this.finish(session, "partial");
      return `${sms.advisorFailed} ${closingText(outcome)}`;
    }

    const assessment = assessed.data;
    session.last_assessment_id = assessment.assessment_id;
    if (assessment.disposition === "ask_more") {
      // One question per turn: the highest-priority one not asked yet.
      const need = [...assessment.information_needs]
        .sort((a, b) => a.priority - b.priority)
        .find((n) => !session.asked_need_codes.includes(n.need_code));
      if (need && session.asked_need_codes.length < MAX_QUESTIONS) {
        session.asked_need_codes.push(need.need_code);
        session.stage = { kind: "answer", need };
        return needQuestion(need);
      }
      // No new questions or limit reached: close with what we have, for review.
      return `${sms.refer} ${closingText(await this.finish(session, "partial"))}`;
    }

    if (assessment.disposition === "advise") {
      return `${adviceText(assessment)} ${closingText(await this.finish(session, "sufficient"))}`;
    }
    return `${sms.refer} ${closingText(await this.finish(session, "partial"))}`;
  }

  // --- Closing ---

  private async finish(session: SmsSession, completeness: "partial" | "sufficient"): Promise<WriteOutcome<unknown>> {
    session.stage = { kind: "closed" };
    session.report_submitted = true;
    const body: ReportRequest = {
      schema_version: SCHEMA_VERSION,
      session_id: session.session_id,
      plot_id: session.plot?.plot_id ?? null,
      case_id: null,
      channel: "sms",
      provider_reference: session.first_message_sid,
      observed_at: null,
      symptoms: [],
      measurements: [],
      user_statement: session.statements.join("\n"),
      completeness,
      assessment_id: session.last_assessment_id,
      is_demo: this.deps.isDemo,
    };
    // One conversation produces one report; the key survives restarts because it comes from the MessageSid.
    const outcome = await this.deps.writer.submitReport(body, `report-sms-${session.first_message_sid}`);
    log("info", "sms_report_submitted", { correlation_id: session.session_id, outcome: outcome.status, completeness });
    return outcome;
  }

  private reAsk(session: SmsSession, question: string): string {
    session.invalid_replies += 1;
    if (session.invalid_replies >= MAX_INVALID_REPLIES) {
      session.stage = { kind: "closed" };
      return sms.gaveUp;
    }
    return `${sms.notUnderstood} ${question}`;
  }

  private isIdle(session: AnySession): boolean {
    if (session.kind === "followup") return this.deps.followups.isIdle(session);
    return this.now().getTime() - session.last_activity_at > this.deps.idleMs;
  }

  private async closeIdle(session: AnySession): Promise<void> {
    if (session.kind === "followup") await this.deps.followups.close(session, "idle");
    else await this.closeHelp(session);
  }

  /** If there was an observation with permission to save it, it is saved as partial. */
  private async closeHelp(session: SmsSession): Promise<void> {
    this.deps.store.delete(session.phone_e164);
    const hasObservation = session.consent.reports === true && session.statements.length > 0 && !session.report_submitted;
    if (hasObservation) await this.finish(session, "partial");
  }
}

function closingText(outcome: WriteOutcome<unknown>, savedText: string = sms.saved): string {
  if (outcome.status === "saved") return savedText;
  return outcome.status === "pending" ? sms.notConfirmed : sms.notSaved;
}
