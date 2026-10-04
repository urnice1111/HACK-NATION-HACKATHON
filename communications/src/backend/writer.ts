/**
 * Backend writes with a fixed Idempotency-Key and bounded retries (at most 3
 * attempts in total on transient failures). A timeout is ambiguous: it is
 * retried with the SAME key, so the backend returns the original if the first
 * write did happen. The key never changes.
 *
 * Used by the report, the follow-up response, consent, opt-out, follow-up
 * attempts and notification states.
 */
import type { BackendClient, BackendResult } from "./client.ts";
import type {
  ConsentRecorded,
  ConsentRequest,
  ConsentRevocationRequest,
  ConsentRevoked,
  FollowupAttemptRecorded,
  FollowupAttemptRequest,
  FollowupResponseCreated,
  FollowupResponseRequest,
  NotificationStatusRecorded,
  NotificationStatusUpdate,
  ReportCreated,
  ReportRequest,
} from "../contracts/index.ts";
import { log } from "../http/log.ts";

export type WriteOutcome<T> =
  | { status: "saved"; data: T }
  /** Not confirmed yet; retries are scheduled. Don't say "recorded". */
  | { status: "pending" }
  | { status: "failed"; code: string };

function isTransient(result: Extract<BackendResult<unknown>, { ok: false }>): boolean {
  // invalid_response after a write is also ambiguous; retrying with the same key is safe.
  return result.kind !== "http" || result.retryable;
}

export class BackendWriter {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly client: BackendClient,
    /** Waits before the 2nd and 3rd attempts. */
    private readonly retryDelaysMs: number[],
  ) {}

  submitReport(body: ReportRequest, key: string): Promise<WriteOutcome<ReportCreated>> {
    return this.write("report", body.session_id, () => this.client.submitReport(body, key));
  }

  submitFollowup(followupId: string, body: FollowupResponseRequest): Promise<WriteOutcome<FollowupResponseCreated>> {
    return this.write("followup_response", body.session_id, () => this.client.submitFollowupResponse(followupId, body));
  }

  recordFollowupAttempt(followupId: string, body: FollowupAttemptRequest): Promise<WriteOutcome<FollowupAttemptRecorded>> {
    return this.write("followup_attempt", body.session_id, () => this.client.recordFollowupAttempt(followupId, body));
  }

  /** One write per session (SMS); in voice, one per `record_consent` in the call. */
  recordConsent(body: ConsentRequest, key = `consent-${body.session_id}`): Promise<WriteOutcome<ConsentRecorded>> {
    return this.write("consent", body.session_id, () => this.client.recordConsent(body, key));
  }

  /** The opt-out is deduplicated by the MessageSid of the SMS that requested it. */
  revokeConsent(body: ConsentRevocationRequest, messageSid: string): Promise<WriteOutcome<ConsentRevoked>> {
    const key = `revocation-${messageSid}`;
    return this.write("consent_revocation", key, () => this.client.revokeConsent(body, key));
  }

  /** One key per notification state change (e.g. `notification-<id>-attempt-2-accepted`). */
  updateNotificationStatus(notificationId: string, body: NotificationStatusUpdate, key: string): Promise<WriteOutcome<NotificationStatusRecorded>> {
    return this.write("notification_status", key, () => this.client.updateNotificationStatus(notificationId, body, key));
  }

  /** Background write (doesn't block the reply to the user); `drain()` waits for it too. */
  track(write: Promise<unknown>): void {
    const tracked = write.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(tracked);
    void tracked.then(() => this.inFlight.delete(tracked));
  }

  /** For tests and graceful shutdown: waits for pending retries to finish. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async write<T>(label: string, correlationId: string, attempt: () => Promise<BackendResult<T>>): Promise<WriteOutcome<T>> {
    const result = await attempt();
    if (result.ok) return { status: "saved", data: result.data };
    if (isTransient(result)) {
      this.scheduleRetry(label, correlationId, attempt, 0);
      return { status: "pending" };
    }
    log("error", `${label}_write_failed`, { request_id: result.requestId, correlation_id: correlationId, code: result.code, outcome: "failed" });
    return { status: "failed", code: result.code };
  }

  private scheduleRetry<T>(label: string, correlationId: string, attempt: () => Promise<BackendResult<T>>, index: number): void {
    const delay = this.retryDelaysMs[index];
    if (delay === undefined) {
      log("error", `${label}_write_exhausted`, { correlation_id: correlationId, outcome: "unknown" });
      return;
    }
    const retry = new Promise<void>((resolve) => {
      setTimeout(async () => {
        const result = await attempt();
        if (result.ok) {
          log("info", `${label}_write_retried`, { correlation_id: correlationId, outcome: "saved" });
        } else if (isTransient(result)) {
          this.scheduleRetry(label, correlationId, attempt, index + 1);
        } else {
          log("error", `${label}_write_failed`, { request_id: result.requestId, correlation_id: correlationId, code: result.code });
        }
        resolve();
      }, delay);
    });
    this.track(retry);
  }
}
