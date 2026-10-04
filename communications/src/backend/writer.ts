/**
 * Escrituras al backend con Idempotency-Key fija y reintentos acotados
 * (máximo 3 intentos en total ante fallos transitorios). Un timeout es
 * ambiguo: se reintenta con la MISMA clave, así el backend devuelve el
 * original si la primera escritura sí ocurrió. Nunca se cambia la clave.
 *
 * Lo usan el reporte, la respuesta de seguimiento, el consentimiento, la baja
 * y los intentos de seguimiento.
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
  ReportCreated,
  ReportRequest,
} from "../contracts/index.ts";
import { log } from "../http/log.ts";

export type WriteOutcome<T> =
  | { status: "saved"; data: T }
  /** No confirmado todavía; hay reintentos programados. No decir "registrado". */
  | { status: "pending" }
  | { status: "failed"; code: string };

function isTransient(result: Extract<BackendResult<unknown>, { ok: false }>): boolean {
  // invalid_response tras una escritura también es ambiguo; reintentar con la misma clave es seguro.
  return result.kind !== "http" || result.retryable;
}

export class BackendWriter {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly client: BackendClient,
    /** Esperas antes del 2.º y 3.er intento. */
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

  recordConsent(body: ConsentRequest): Promise<WriteOutcome<ConsentRecorded>> {
    return this.write("consent", body.session_id, () => this.client.recordConsent(body));
  }

  /** La baja se deduplica por el MessageSid del SMS que la pidió. */
  revokeConsent(body: ConsentRevocationRequest, messageSid: string): Promise<WriteOutcome<ConsentRevoked>> {
    const key = `revocation-${messageSid}`;
    return this.write("consent_revocation", key, () => this.client.revokeConsent(body, key));
  }

  /** Escritura en segundo plano (no bloquea la respuesta al usuario); `drain()` también la espera. */
  track(write: Promise<unknown>): void {
    const tracked = write.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(tracked);
    void tracked.then(() => this.inFlight.delete(tracked));
  }

  /** Para pruebas y apagado ordenado: espera a que terminen los reintentos pendientes. */
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
