/**
 * Cliente del backend /v1 para las server tools y los webhooks. No confía en
 * el backend ni en el modelo: valida cada respuesta contra el contrato, y un
 * timeout en una escritura se reporta como resultado ambiguo (`timeout`) para
 * reintentar con la MISMA Idempotency-Key, nunca con una nueva.
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
  /** El asesor (Integrante 2) es otro servicio; por defecto, `baseUrl` (el mock sirve ambos). */
  advisorBaseUrl?: string | null;
  /** Sin token no se envía `Authorization` (el backend real aún no autentica servicios). */
  serviceToken?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CallOptions {
  /** `correlation_id` de la sesión; normalmente el session_id. */
  correlationId?: string;
  requestId?: string;
  /** Solo para el mock: ver X-Mock-Scenario en src/mock-backend/server.ts. */
  mockScenario?: string;
}

export type BackendResult<T> =
  | { ok: true; status: number; data: T; requestId: string; replayed: boolean }
  | {
      ok: false;
      /** http: el backend respondió con error. timeout: no se sabe si la escritura ocurrió. */
      kind: "http" | "timeout" | "network" | "invalid_response";
      status: number | null;
      code: string;
      retryable: boolean;
      requestId: string;
    };

/** Clave estable por sesión y turno (CLAUDE.md): `report-<session_id>-turn-<nn>`. */
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

  /** Solo tras confirmar la parcela; la sesión viaja en X-Session-Id. */
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

  /** Una respuesta por seguimiento y sesión. */
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

  /** Seguimientos con resumen del caso y contacto (solo token `comms`). */
  listFollowups(status: FollowupStatus, filters: { dueBefore?: string } = {}, opts: CallOptions = {}) {
    const query = new URLSearchParams({ status });
    if (filters.dueBefore) query.set("due_before", filters.dueBefore);
    return this.call("GET", `/v1/followups?${query}`, FollowupList, { opts });
  }

  /**
   * Registra un intento de contacto; `contacting` liga la sesión a la parcela del caso.
   * Un intento por sesión y estado: repetir el callback del proveedor no cuenta otro intento.
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

  /** Guarda los tres permisos de la sección 17; una escritura por sesión. */
  recordConsent(body: ConsentRequest, idempotencyKey = `consent-${body.session_id}`, opts: CallOptions = {}) {
    return this.call("POST", "/v1/consents", ConsentRecorded, {
      body,
      opts: withSession(opts, body.session_id),
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  /** "BAJA" por SMS. */
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
      // Error JSON sin la forma uniforme (p. ej. `{"detail": …}` de FastAPI en el asesor): se respeta el código HTTP.
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

/** Las rutas ya llevan `/v1`: "http://localhost:8000/v1/" → "http://localhost:8000". */
function origin(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function withSession(opts: CallOptions, sessionId: string): CallOptions {
  return { ...opts, correlationId: opts.correlationId ?? sessionId };
}

/** `{"detail": {"code": "…"}}` → el código; cualquier otra forma → null. */
function detailCode(payload: unknown): string | null {
  const detail = (payload as { detail?: unknown } | null)?.detail;
  const code = (detail as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

function invalid(status: number, requestId: string) {
  return { ok: false as const, kind: "invalid_response" as const, status, code: "INVALID_RESPONSE", retryable: false, requestId };
}
