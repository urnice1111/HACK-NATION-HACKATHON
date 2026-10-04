/**
 * Alert calls (demo step 6, section 17): an alert approved in the dashboard queues a voice
 * notification in the backend; communications calls the farmer with the ElevenLabs Alerts
 * agent, from the follow-up number, and reports every state change.
 *
 *  - Only with alert permission (`notification_consent`), within allowed hours (08:00–19:00
 *    local time by default) and, in demo, to allowlisted numbers. No permission →
 *    `cancelled` NO_CONSENT; not allowlisted → `cancelled` NOT_ALLOWLISTED; outside hours
 *    the notification stays `queued`.
 *  - `sending` is reported BEFORE dialing (it counts the attempt in the backend) and the call
 *    only goes out if the backend confirmed it; `accepted` once ElevenLabs accepts the call.
 *  - `delivered` only when the farmer confirms they heard it (`acknowledge_alert`), never
 *    because the call connected.
 *  - Without acknowledgement within `callResultTimeoutMs` the attempt counts as unanswered and
 *    the next one goes out; after `callAttempts` attempts, `failed` NO_ANSWER.
 *  - An ambiguous ElevenLabs timeout is reported as `unknown` and never redialed: the call may
 *    have gone out. A late acknowledgement still delivers it; otherwise an operator reviews it.
 *  - A notification left in `sending` by an interrupted dispatch (restart, lost write) is
 *    reported as `unknown` too, for the same reason.
 *
 * The backend's `updated_at` marks when the last attempt was accepted, so the retry timing
 * survives a restart of this service.
 */
import { randomUUID } from "node:crypto";
import type { BackendClient } from "../backend/client.ts";
import type { BackendWriter, WriteOutcome } from "../backend/writer.ts";
import { SCHEMA_VERSION, type NotificationListItem, type NotificationStatusRecorded, type NotificationStatusUpdate } from "../contracts/index.ts";
import type { DynamicVariables, OutboundCaller } from "../elevenlabs/outbound.ts";
import { log, maskPhone } from "../http/log.ts";
import { canContact } from "../policy/outreach.ts";
import { BoundedMap, KeyedMutex } from "../util.ts";

/** Variables the Alerts agent receives; its prompt and tools can't use any others (checked by `agents:check`). */
export const ALERT_DYNAMIC_VARIABLES = ["farmer_name", "plot_label", "alert_message", "notification_id", "session_id"] as const;

export type AlertDispatchResult =
  | { status: "call_placed"; session_id: string; conversation_id: string | null; attempt_number: number }
  | { status: "call_ambiguous"; session_id: string; attempt_number: number }
  | { status: "waiting"; reason: "outside_hours" | "awaiting_acknowledgement" }
  | { status: "cancelled"; reason: "NO_CONSENT" | "NOT_ALLOWLISTED" }
  | { status: "failed"; reason: "NO_ANSWER" | "NO_MESSAGE" | "PROVIDER_REJECTED"; code: string }
  | { status: "unknown"; reason: "SENDING_INTERRUPTED" }
  | { status: "skipped"; reason: "not_alert" | "other_mode" | "closed" | "settled" | "backend_error" };

export interface AlertDispatcherDeps {
  client: BackendClient;
  writer: BackendWriter;
  /** ElevenLabs Alerts agent from the follow-up number. */
  caller: OutboundCaller;
  isDemo: boolean;
  demoAllowlist: ReadonlySet<string>;
  /** DEMO_IGNORE_ALLOWED_HOURS (demo only). */
  ignoreAllowedHours?: boolean;
  /** Attempts before `failed` NO_ANSWER (3, like the follow-up). */
  callAttempts: number;
  /** How long to wait for `acknowledge_alert` after an attempt before the next one. */
  callResultTimeoutMs: number;
  now?: () => Date;
}

export interface AcknowledgeInput {
  session_id: string;
  notification_id: string;
  conversation_id: string | null;
  outcome: "heard" | "wrong_person";
}

export type AcknowledgeResult =
  | { registered: true; status: NotificationStatusRecorded["status"] }
  /** pending: not confirmed yet (retried in the background). closed: it was already terminal with another status. */
  | { registered: false; reason: "pending" | "closed" | "failed"; status: NotificationStatusRecorded["status"] | null };

/** Dynamic variables for the Alerts agent. No phone or coordinates: the model sees them. */
export function alertVariables(item: NotificationListItem, sessionId: string): DynamicVariables & Record<(typeof ALERT_DYNAMIC_VARIABLES)[number], string> {
  return {
    farmer_name: item.farmer_name,
    plot_label: item.plot_label,
    alert_message: item.message?.trim() ?? "",
    notification_id: item.notification_id,
    session_id: sessionId,
  };
}

export class AlertDispatcher {
  private readonly now: () => Date;
  private readonly locks = new KeyedMutex();
  /** When this process last placed a call per notification (the backend's `updated_at` covers restarts). */
  private readonly placed = new BoundedMap<string, number>();
  /** Notifications with a terminal or acknowledgement write already started: never dialed again from here. */
  private readonly settled = new BoundedMap<string, string>();
  /** One acknowledgement per notification and session: the model repeating the tool doesn't write twice. */
  private readonly acks = new BoundedMap<string, Promise<AcknowledgeResult>>();
  private lastPollFailure: string | null = null;

  constructor(private readonly deps: AlertDispatcherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Queued alerts, retries of unanswered ones and interrupted dispatches. */
  async poll(): Promise<AlertDispatchResult[]> {
    const results: AlertDispatchResult[] = [];
    for (const status of ["queued", "accepted", "sending"] as const) {
      const list = await this.deps.client.listNotifications(status, { channel: "voice", limit: 50 });
      if (!list.ok) {
        const failure = `${list.status ?? list.kind}:${list.code}`;
        if (failure !== this.lastPollFailure) log("warn", "alert_poll_failed", { code: list.code, status: list.status });
        this.lastPollFailure = failure;
        return results;
      }
      this.lastPollFailure = null;
      for (const item of list.data.notifications) results.push(await this.dispatch(item));
    }
    return results;
  }

  dispatch(item: NotificationListItem): Promise<AlertDispatchResult> {
    return this.locks.run(item.notification_id, () => this.dispatchLocked(item));
  }

  /** `acknowledge_alert`: heard → `delivered`; someone else answered → `failed` WRONG_PERSON. */
  acknowledge(input: AcknowledgeInput): Promise<AcknowledgeResult> {
    const key = `${input.notification_id}\u0000${input.session_id}`;
    let result = this.acks.get(key);
    if (!result) {
      result = this.locks.run(input.notification_id, () => this.acknowledgeLocked(input));
      this.acks.set(key, result);
    }
    return result;
  }

  private async acknowledgeLocked(input: AcknowledgeInput): Promise<AcknowledgeResult> {
    const heard = input.outcome === "heard";
    const target = heard ? "delivered" : "failed";
    // Even if the write is still pending, the farmer was reached: no more calls for this alert.
    this.settled.set(input.notification_id, `acknowledged:${input.outcome}`);
    this.placed.delete(input.notification_id);
    const outcome = await this.deps.writer.updateNotificationStatus(
      input.notification_id,
      this.update(target, input.conversation_id, heard ? null : "WRONG_PERSON"),
      `notification-${input.notification_id}-ack-${input.session_id}`,
    );
    log("info", "alert_acknowledged", { correlation_id: input.session_id, notification_id: input.notification_id, outcome: `${input.outcome}:${outcome.status}` });
    if (outcome.status === "pending") return { registered: false, reason: "pending", status: null };
    if (outcome.status === "failed") return { registered: false, reason: "failed", status: null };
    // Already terminal: only counts as recorded if it already had the status we wanted.
    if (outcome.data.applied || outcome.data.status === target) return { registered: true, status: outcome.data.status };
    return { registered: false, reason: "closed", status: outcome.data.status };
  }

  private async dispatchLocked(item: NotificationListItem): Promise<AlertDispatchResult> {
    const id = item.notification_id;
    const fields = { notification_id: id, phone: maskPhone(item.contact.phone_e164), attempt_count: item.attempt_count };

    if (item.channel !== "voice" || item.alert_id === null) return this.done({ status: "skipped", reason: "not_alert" }, fields);
    // Demo and production never mix.
    if (item.is_demo !== this.deps.isDemo) return this.done({ status: "skipped", reason: "other_mode" }, fields);
    if (this.settled.has(id)) return this.done({ status: "skipped", reason: "settled" }, fields);
    if (item.status !== "queued" && item.status !== "accepted" && item.status !== "sending") return this.done({ status: "skipped", reason: "closed" }, fields);

    const sinceLastAttempt = this.now().getTime() - Math.max(Date.parse(item.updated_at), this.placed.get(id) ?? 0);
    if (item.status === "sending") {
      // Mid-dispatch elsewhere or interrupted: if it's been long enough, the call may or may not have gone out.
      if (this.placed.has(id) || sinceLastAttempt < this.deps.callResultTimeoutMs) return this.done({ status: "waiting", reason: "awaiting_acknowledgement" }, fields);
      await this.settle(item, "unknown", "SENDING_INTERRUPTED");
      return this.done({ status: "unknown", reason: "SENDING_INTERRUPTED" }, fields);
    }
    if (item.status === "accepted") {
      if (sinceLastAttempt < this.deps.callResultTimeoutMs) return this.done({ status: "waiting", reason: "awaiting_acknowledgement" }, fields);
      if (item.attempt_count >= this.deps.callAttempts) {
        await this.settle(item, "failed", "NO_ANSWER");
        return this.done({ status: "failed", reason: "NO_ANSWER", code: "NO_ANSWER" }, fields);
      }
    }

    const decision = canContact({
      phone_e164: item.contact.phone_e164,
      timezone: item.contact.timezone,
      allowed_hours: item.contact.allowed_hours,
      consent: item.contact.notification_consent,
      now: this.now(),
      isDemo: this.deps.isDemo,
      demoAllowlist: this.deps.demoAllowlist,
      ignoreAllowedHours: this.deps.ignoreAllowedHours,
    });
    if (!decision.ok && decision.reason === "outside_hours") return this.done({ status: "waiting", reason: "outside_hours" }, fields);
    if (!decision.ok) {
      const reason = decision.reason === "no_consent" ? "NO_CONSENT" : "NOT_ALLOWLISTED";
      await this.settle(item, "cancelled", reason);
      return this.done({ status: "cancelled", reason }, fields);
    }
    if (!item.message?.trim()) {
      await this.settle(item, "failed", "NO_MESSAGE");
      return this.done({ status: "failed", reason: "NO_MESSAGE", code: "NO_MESSAGE" }, fields);
    }

    return this.call(item, fields);
  }

  private async call(item: NotificationListItem, fields: Record<string, unknown>): Promise<AlertDispatchResult> {
    const id = item.notification_id;
    const attempt = item.attempt_count + 1;
    const key = `notification-${id}-attempt-${attempt}`;

    // Nothing is dialed until the backend confirms `sending`. A timeout is retried once with the
    // same key and body; if it's still unconfirmed, the next poll decides (a stuck `sending` becomes `unknown`).
    const sendingBody = this.update("sending", null, null);
    let sending = await this.deps.client.updateNotificationStatus(id, sendingBody, `${key}-sending`);
    if (!sending.ok && sending.kind !== "http") sending = await this.deps.client.updateNotificationStatus(id, sendingBody, `${key}-sending`);
    if (!sending.ok) return this.done({ status: "skipped", reason: "backend_error" }, { ...fields, code: sending.code });
    if (!sending.data.applied) return this.done({ status: "skipped", reason: "closed" }, fields);

    const sessionId = `voice_alert_${randomUUID()}`;
    const placed = await this.deps.caller.placeCall({ to: item.contact.phone_e164, dynamicVariables: alertVariables(item, sessionId) });
    const callFields = { ...fields, correlation_id: sessionId, attempt_number: attempt };

    if (placed.ok) {
      this.placed.set(id, this.now().getTime());
      await this.deps.writer.updateNotificationStatus(id, this.update("accepted", placed.conversation_id ?? placed.call_sid, null), `${key}-accepted`);
      return this.done({ status: "call_placed", session_id: sessionId, conversation_id: placed.conversation_id, attempt_number: attempt }, { ...callFields, stubbed: placed.stubbed });
    }
    if (placed.kind === "ambiguous") {
      // The call may have gone out: never redial blindly.
      this.settled.set(id, "unknown");
      await this.deps.writer.updateNotificationStatus(id, this.update("unknown", null, placed.code), `${key}-unknown`);
      return this.done({ status: "call_ambiguous", session_id: sessionId, attempt_number: attempt }, { ...callFields, code: placed.code });
    }
    this.settled.set(id, "failed");
    await this.deps.writer.updateNotificationStatus(id, this.update("failed", null, placed.code), `${key}-failed`);
    return this.done({ status: "failed", reason: "PROVIDER_REJECTED", code: placed.code }, callFields);
  }

  /** Terminal (or `unknown`) state decided here; written once with a stable key. */
  private settle(item: NotificationListItem, status: "cancelled" | "failed" | "unknown", code: string): Promise<WriteOutcome<NotificationStatusRecorded>> {
    this.settled.set(item.notification_id, `${status}:${code}`);
    this.placed.delete(item.notification_id);
    return this.deps.writer.updateNotificationStatus(item.notification_id, this.update(status, null, code), `notification-${item.notification_id}-${status}-${code}`);
  }

  private update(status: NotificationStatusUpdate["status"], providerReference: string | null, errorCode: string | null): NotificationStatusUpdate {
    return {
      schema_version: SCHEMA_VERSION,
      status,
      provider_reference: providerReference,
      error_code: errorCode,
      occurred_at: this.now().toISOString(),
      is_demo: this.deps.isDemo,
    };
  }

  private done(result: AlertDispatchResult, fields: Record<string, unknown>): AlertDispatchResult {
    // Waiting and skipping repeat on every poll: only what changes something is logged.
    const quiet = result.status === "waiting" || (result.status === "skipped" && result.reason !== "backend_error");
    const outcome = "reason" in result ? `${result.status}:${result.reason}` : result.status;
    if (!quiet) log(result.status === "failed" || result.status === "skipped" ? "warn" : "info", "alert_dispatch", { ...fields, outcome });
    return result;
  }
}
