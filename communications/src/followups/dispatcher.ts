/**
 * Despachador de `followup.due` (secciones 2.2, 11 y 17): decide si llamar,
 * enviar el SMS de respaldo o esperar.
 *
 *  - Solo con permiso de seguimiento, en horario permitido (08:00–19:00 hora
 *    local por defecto) y, en demo, a números de la lista blanca.
 *  - Hasta 3 intentos de llamada (agente de seguimiento de ElevenLabs con
 *    variables dinámicas); después, un SMS. Tras el SMS sin respuesta no se
 *    vuelve a contactar.
 *  - La llamada se registra como intento `contacting` en cuanto ElevenLabs la
 *    acepta; eso liga la sesión a la parcela para que las herramientas del
 *    agente puedan guardar.
 *  - Si en `callResultTimeoutMs` no llegó `submit_followup`, se registra
 *    `no_response` (el backend reprograma el reintento). Nunca baja el riesgo.
 *  - Una llamada ambigua (timeout de ElevenLabs) no se repite: se registra
 *    como `contacting` y se concilia por el mismo vencimiento.
 *
 * El evento llega por `POST /v1/followups/{id}/dispatch` (PROPUESTO) o por
 * sondeo de `GET /v1/followups`; ambos caminos terminan en `dispatch()`.
 */
import { randomUUID } from "node:crypto";
import type { BackendClient } from "../backend/client.ts";
import type { BackendWriter } from "../backend/writer.ts";
import { SCHEMA_VERSION, type FollowupListItem } from "../contracts/index.ts";
import type { DynamicVariables, OutboundCaller } from "../elevenlabs/outbound.ts";
import { log, maskPhone } from "../http/log.ts";
import { canContact } from "../policy/outreach.ts";
import type { FollowupSmsFlow, FollowupStartResult } from "../sms/followup.ts";
import { KeyedMutex } from "../util.ts";

/** Nombre hablado de cada amenaza; el `threat_code` no se le dice al agricultor. */
const THREAT_LABELS: Record<string, string> = { coffee_leaf_rust: "roya del café" };

/** Fallos transitorios seguidos al colocar la llamada antes de marcar el seguimiento como fallido. */
const MAX_PLACEMENT_FAILURES = 3;

export type DispatchResult =
  | { status: "call_placed"; session_id: string; conversation_id: string | null; attempt_number: number }
  | { status: "call_ambiguous"; session_id: string }
  | { status: "sms"; result: FollowupStartResult }
  | { status: "deferred"; reason: "outside_hours" | "provider_backoff" }
  | { status: "skipped"; reason: "not_found" | "closed" | "in_progress" | "exhausted" | "no_consent" | "not_allowlisted" }
  | { status: "failed"; reason: "provider_rejected" | "backend_error"; code: string };

export interface DispatcherDeps {
  client: BackendClient;
  writer: BackendWriter;
  caller: OutboundCaller;
  followupSms: FollowupSmsFlow;
  isDemo: boolean;
  demoAllowlist: ReadonlySet<string>;
  /** DEMO_IGNORE_ALLOWED_HOURS (solo demo). */
  ignoreAllowedHours?: boolean;
  /** Intentos de llamada antes del SMS (3 en la sección 17). */
  callAttempts: number;
  /** Cuánto esperar `submit_followup` tras colocar la llamada antes de registrar `no_response`. */
  callResultTimeoutMs: number;
  /** Espera tras un fallo transitorio de ElevenLabs al colocar la llamada. */
  placementBackoffMs: number;
  now?: () => Date;
}

interface PendingCall {
  followup_id: string;
  session_id: string;
  placed_at: number;
}

/** Variables que recibe el agente de seguimiento; su prompt y herramientas no pueden usar otras (las comprueba `agents:check`). */
export const FOLLOWUP_DYNAMIC_VARIABLES = [
  "farmer_name",
  "threat_label",
  "symptoms",
  "guidance_given",
  "followup_id",
  "plot_id",
  "session_id",
  "attempt_number",
] as const;

/** Variables dinámicas del agente de seguimiento. Sin teléfono ni coordenadas: el modelo las ve. */
export function followupVariables(item: FollowupListItem, sessionId: string): DynamicVariables & Record<(typeof FOLLOWUP_DYNAMIC_VARIABLES)[number], string | number> {
  return {
    farmer_name: item.case_summary.farmer_name,
    threat_label: THREAT_LABELS[item.case_summary.threat_code] ?? "el problema que reportó",
    symptoms: item.case_summary.symptoms.length > 0 ? item.case_summary.symptoms.join(", ") : "sin detalle",
    guidance_given: item.case_summary.guidance_given ?? "ninguna",
    followup_id: item.followup_id,
    plot_id: item.plot_id,
    session_id: sessionId,
    attempt_number: item.attempt_count + 1,
  };
}

export class FollowupDispatcher {
  private readonly now: () => Date;
  private readonly locks = new KeyedMutex();
  private readonly pending = new Map<string, PendingCall>();
  private readonly backoff = new Map<string, { until: number; failures: number }>();
  /** Último fallo del sondeo: se registra al cambiar, no en cada intervalo (el backend real aún no tiene GET /v1/followups). */
  private lastPollFailure: string | null = null;

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** `followup.due` para un ID: busca el seguimiento abierto y lo despacha. */
  async dispatchById(followupId: string): Promise<DispatchResult> {
    // Sin sondeo, el evento es lo único que vence las llamadas sin resultado: si no, una llamada vieja bloquea para siempre.
    await this.sweep();
    for (const status of ["scheduled", "no_response", "contacting"] as const) {
      const list = await this.deps.client.listFollowups(status);
      if (!list.ok) return { status: "failed", reason: "backend_error", code: list.code };
      const item = list.data.followups.find((f) => f.followup_id === followupId);
      if (item) return this.dispatch(item);
    }
    return { status: "skipped", reason: "not_found" };
  }

  dispatch(item: FollowupListItem): Promise<DispatchResult> {
    return this.locks.run(item.followup_id, () => this.dispatchLocked(item));
  }

  /** Respaldo del evento: despacha los vencidos y concilia llamadas sin resultado. */
  async poll(): Promise<DispatchResult[]> {
    await this.sweep();
    const results: DispatchResult[] = [];
    for (const status of ["scheduled", "no_response"] as const) {
      const list = await this.deps.client.listFollowups(status, { dueBefore: this.now().toISOString() });
      if (!list.ok) {
        const failure = `${list.status ?? list.kind}:${list.code}`;
        if (failure !== this.lastPollFailure) log("warn", "followup_poll_failed", { code: list.code, status: list.status });
        this.lastPollFailure = failure;
        continue;
      }
      this.lastPollFailure = null;
      for (const item of list.data.followups) results.push(await this.dispatch(item));
    }
    return results;
  }

  /** Llamadas colocadas sin `submit_followup` dentro del plazo → `no_response`. */
  async sweep(): Promise<void> {
    const now = this.now().getTime();
    const expired = [...this.pending.values()].filter((p) => now - p.placed_at > this.deps.callResultTimeoutMs);
    if (expired.length === 0) return;

    const contacting = await this.deps.client.listFollowups("contacting");
    if (!contacting.ok) return; // se reintenta en el próximo barrido
    const stillOpen = new Set(contacting.data.followups.map((f) => f.followup_id));

    for (const call of expired) {
      this.pending.delete(call.followup_id);
      if (!stillOpen.has(call.followup_id)) continue; // respondió (o el backend lo cerró)
      this.deps.writer.track(this.recordAttempt(call.followup_id, call.session_id, "no_response", null));
      log("info", "followup_call_no_response", { correlation_id: call.session_id, followup_id: call.followup_id });
    }
  }

  private async dispatchLocked(item: FollowupListItem): Promise<DispatchResult> {
    const fields = { followup_id: item.followup_id, phone: maskPhone(item.contact.phone_e164) };

    if (item.status === "contacting" || this.pending.has(item.followup_id)) return this.done({ status: "skipped", reason: "in_progress" }, fields);
    if (item.status !== "scheduled" && item.status !== "no_response") return this.done({ status: "skipped", reason: "closed" }, fields);
    // El SMS de respaldo ya se envió y tampoco hubo respuesta: no se insiste.
    if (item.status === "no_response" && item.channel === "sms") return this.done({ status: "skipped", reason: "exhausted" }, fields);

    const decision = canContact({
      phone_e164: item.contact.phone_e164,
      timezone: item.contact.timezone,
      allowed_hours: item.contact.allowed_hours,
      consent: item.contact.followup_call_consent,
      now: this.now(),
      isDemo: this.deps.isDemo,
      demoAllowlist: this.deps.demoAllowlist,
      ignoreAllowedHours: this.deps.ignoreAllowedHours,
    });
    if (!decision.ok) {
      const result: DispatchResult =
        decision.reason === "outside_hours" ? { status: "deferred", reason: "outside_hours" } : { status: "skipped", reason: decision.reason };
      return this.done(result, fields);
    }

    if (item.attempt_count >= this.deps.callAttempts) {
      return this.done({ status: "sms", result: await this.deps.followupSms.start(item) }, fields);
    }

    const backoff = this.backoff.get(item.followup_id);
    if (backoff && backoff.until > this.now().getTime()) return this.done({ status: "deferred", reason: "provider_backoff" }, fields);

    return this.call(item, fields);
  }

  private async call(item: FollowupListItem, fields: Record<string, unknown>): Promise<DispatchResult> {
    const sessionId = `voice_fu_${randomUUID()}`;
    const placed = await this.deps.caller.placeCall({ to: item.contact.phone_e164, dynamicVariables: followupVariables(item, sessionId) });

    if (!placed.ok && placed.kind === "rejected") {
      const failures = (this.backoff.get(item.followup_id)?.failures ?? 0) + 1;
      if (placed.retryable && failures < MAX_PLACEMENT_FAILURES) {
        this.backoff.set(item.followup_id, { until: this.now().getTime() + this.deps.placementBackoffMs, failures });
        return this.done({ status: "deferred", reason: "provider_backoff" }, { ...fields, code: placed.code });
      }
      this.backoff.delete(item.followup_id);
      this.deps.writer.track(this.recordAttempt(item.followup_id, sessionId, "failed", null));
      return this.done({ status: "failed", reason: "provider_rejected", code: placed.code }, fields);
    }
    this.backoff.delete(item.followup_id);

    // Colocada o ambigua: la llamada pudo salir, así que la sesión debe poder guardar.
    const reference = placed.ok ? (placed.conversation_id ?? placed.call_sid) : null;
    const attempt = await this.recordAttempt(item.followup_id, sessionId, "contacting", reference);
    if (attempt.status === "failed") log("error", "followup_call_attempt_not_recorded", { ...fields, correlation_id: sessionId, code: attempt.code });
    this.pending.set(item.followup_id, { followup_id: item.followup_id, session_id: sessionId, placed_at: this.now().getTime() });

    if (!placed.ok) return this.done({ status: "call_ambiguous", session_id: sessionId }, { ...fields, correlation_id: sessionId, code: placed.code });
    return this.done(
      { status: "call_placed", session_id: sessionId, conversation_id: placed.conversation_id, attempt_number: item.attempt_count + 1 },
      { ...fields, correlation_id: sessionId, stubbed: placed.stubbed },
    );
  }

  private recordAttempt(followupId: string, sessionId: string, status: "contacting" | "no_response" | "failed", reference: string | null) {
    return this.deps.writer.recordFollowupAttempt(followupId, {
      schema_version: SCHEMA_VERSION,
      session_id: sessionId,
      status,
      channel: "voice",
      call_reference: reference,
      occurred_at: this.now().toISOString(),
      is_demo: this.deps.isDemo,
    });
  }

  private done(result: DispatchResult, fields: Record<string, unknown>): DispatchResult {
    const outcome = "reason" in result ? `${result.status}:${result.reason}` : result.status;
    log(result.status === "failed" ? "warn" : "info", "followup_dispatch", { ...fields, outcome });
    return result;
  }
}
