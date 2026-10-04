/**
 * Backend /v1 client for the server tools and webhooks. Trusts neither the
 * backend nor the model: validates every response against the contract, and a
 * timeout on a write is reported as an ambiguous result (`timeout`) so it is
 * retried with the SAME Idempotency-Key, never a new one.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  AssessmentResponse,
  ConsentRecorded,
  ConsentRevoked,
  ContactResolutionResponse,
  ErrorBody,
  FollowupAttemptRecorded,
  FollowupList,
  FollowupResponseCreated,
  PlotContext,
  ReportCreated,
  ReportDetail,
  type AssessmentRequest,
  type ConsentRequest,
  type ConsentRevocationRequest,
  type ContactResolutionRequest,
  type FollowupAttemptRequest,
  type FollowupResponseRequest,
  type FollowupStatus,
  type ReportRequest,
} from "../contracts/index.ts";

export interface BackendClientOptions {
  baseUrl: string;
  /** The advisor (Member 2) is a separate service; defaults to `baseUrl` (the mock serves both). */
  advisorBaseUrl?: string | null;
  /** Without a token no `Authorization` is sent (the real backend doesn't authenticate services yet). */
  serviceToken?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CallOptions {
  /** The session's `correlation_id`; usually the session_id. */
  correlationId?: string;
  requestId?: string;
  /** Mock only: see X-Mock-Scenario in src/mock-backend/server.ts. */
  mockScenario?: string;
}

export type BackendResult<T> =
  | { ok: true; status: number; data: T; requestId: string; replayed: boolean }
  | {
      ok: false;
      /** http: the backend answered with an error. timeout: unknown whether the write happened. */
      kind: "http" | "timeout" | "network" | "invalid_response";
      status: number | null;
      code: string;
      retryable: boolean;
      requestId: string;
    };

/** Stable key per session and turn (CLAUDE.md): `report-<session_id>-turn-<nn>`. */
export function reportIdempotencyKey(sessionId: string, turn: number): string {
  return `report-${sessionId}-turn-${String(turn).padStart(2, "0")}`;
}

export class BackendClient {
  private readonly baseUrl: string;
  private readonly advisorBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BackendClientOptions) {
    this.baseUrl = origin(options.baseUrl);
    this.advisorBaseUrl = origin(options.advisorBaseUrl || options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  resolveContact(body: ContactResolutionRequest, opts: CallOptions = {}) {
    return this.call("POST", "/v1/contact-resolution", ContactResolutionResponse, { body, opts: withSession(opts, body.session_id) });
  }

  /** Only after confirming the plot; the session travels in X-Session-Id. */
  getPlotContext(plotId: string, sessionId: string, opts: CallOptions = {}) {
    return this.call("GET", `/v1/plots/${encodeURIComponent(plotId)}/context`, PlotContext, {
      opts: withSession(opts, sessionId),
      headers: { "X-Session-Id": sessionId },
    });
  }

  assess(body: AssessmentRequest, opts: CallOptions = {}) {
    return this.call("POST", "/v1/assessments", AssessmentResponse, {
      body,
      opts: withSession(opts, body.session_id),
      baseUrl: this.advisorBaseUrl,
    });
  }

  submitReport(body: ReportRequest, idempotencyKey: string, opts: CallOptions = {}) {
    return this.call("POST", "/v1/reports", ReportCreated, {
      body,
      opts: withSession(opts, body.session_id),
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  getReport(reportId: string, opts: CallOptions = {}) {
    return this.call("GET", `/v1/reports/${encodeURIComponent(reportId)}`, ReportDetail, { opts });
  }

  /** One response per follow-up and session. */
  submitFollowupResponse(
    followupId: string,
    body: FollowupResponseRequest,
    idempotencyKey = `followup-${followupId}-${body.session_id}`,
    opts: CallOptions = {},
  ) {
    return this.call("POST", `/v1/followups/${encodeURIComponent(followupId)}/responses`, FollowupResponseCreated, {
      body,
      opts: withSession(opts, body.session_id),
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  /** Follow-ups with case summary and contact (`comms` token only). */
  listFollowups(status: FollowupStatus, filters: { dueBefore?: string } = {}, opts: CallOptions = {}) {
    const query = new URLSearchParams({ status });
    if (filters.dueBefore) query.set("due_before", filters.dueBefore);
    return this.call("GET", `/v1/followups?${query}`, FollowupList, { opts });
  }

  /**
   * Records a contact attempt; `contacting` binds the session to the case's plot.
   * One attempt per session and status: a repeated provider callback doesn't count as another attempt.
   */
  recordFollowupAttempt(
    followupId: string,
    body: FollowupAttemptRequest,
    idempotencyKey = `followup-attempt-${followupId}-${body.session_id}-${body.status}`,
    opts: CallOptions = {},
  ) {
    return this.call("POST", `/v1/followups/${encodeURIComponent(followupId)}/attempts`, FollowupAttemptRecorded, {
      body,
      opts: withSession(opts, body.session_id),
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  /** Stores the three permissions of section 17; one write per session. */
  recordConsent(body: ConsentRequest, idempotencyKey = `consent-${body.session_id}`, opts: CallOptions = {}) {
    return this.call("POST", "/v1/consents", ConsentRecorded, {
      body,
      opts: withSession(opts, body.session_id),
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  /** "ALERTS OFF" by SMS. */
  revokeConsent(body: ConsentRevocationRequest, idempotencyKey: string, opts: CallOptions = {}) {
    return this.call("POST", "/v1/consents/revocations", ConsentRevoked, {
      body,
      opts,
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  private async call<T extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: T,
    {
      body,
      opts,
      headers = {},
      baseUrl = this.baseUrl,
    }: { body?: unknown; opts: CallOptions; headers?: Record<string, string>; baseUrl?: string },
  ): Promise<BackendResult<z.infer<T>>> {
    const requestId = opts.requestId ?? `req_${randomUUID()}`;
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      "X-Request-Id": requestId,
      ...headers,
    };
    if (this.options.serviceToken) requestHeaders.Authorization = `Bearer ${this.options.serviceToken}`;
    if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
    if (opts.correlationId) requestHeaders["X-Correlation-Id"] = opts.correlationId;
    if (opts.mockScenario) requestHeaders["X-Mock-Scenario"] = opts.mockScenario;

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        ok: false,
        kind: timedOut ? "timeout" : "network",
        status: null,
        code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        retryable: true,
        requestId,
      };
    }

    const echoedRequestId = response.headers.get("x-request-id") ?? requestId;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return invalid(response.status, echoedRequestId);
    }

    if (!response.ok) {
      const parsedError = ErrorBody.safeParse(payload);
      if (parsedError.success) {
        return {
          ok: false,
          kind: "http",
          status: response.status,
          code: parsedError.data.error.code,
          retryable: parsedError.data.error.retryable,
          requestId: parsedError.data.error.request_id,
        };
      }
      // JSON error without the uniform shape (e.g. FastAPI's `{"detail": …}` in the advisor): keep the HTTP status.
      return {
        ok: false,
        kind: "http",
        status: response.status,
        code: detailCode(payload) ?? `HTTP_${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
        requestId: echoedRequestId,
      };
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) return invalid(response.status, echoedRequestId);
    return {
      ok: true,
      status: response.status,
      data: parsed.data,
      requestId: echoedRequestId,
      replayed: response.headers.get("idempotency-replayed") === "true",
    };
  }
}

/** Routes already include `/v1`: "http://localhost:8000/v1/" → "http://localhost:8000". */
function origin(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function withSession(opts: CallOptions, sessionId: string): CallOptions {
  return { ...opts, correlationId: opts.correlationId ?? sessionId };
}

/** `{"detail": {"code": "…"}}` → the code; any other shape → null. */
function detailCode(payload: unknown): string | null {
  const detail = (payload as { detail?: unknown } | null)?.detail;
  const code = (detail as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

function invalid(status: number, requestId: string) {
  return { ok: false as const, kind: "invalid_response" as const, status, code: "INVALID_RESPONSE", retryable: false, requestId };
}
