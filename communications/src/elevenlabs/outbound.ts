/**
 * Outbound call with an ElevenLabs agent through the Twilio number imported
 * into ElevenLabs (`POST /v1/convai/twilio/outbound-call`). The dynamic
 * variables reach the agent's prompt and tools as `{{name}}`.
 *
 * No recording (section 17). A timeout or network error is ambiguous: the
 * call may have gone out, so it is never blindly retried. Without credentials
 * the stub is used (like `placeCall`'s `status: "stubbed"` in Marco).
 */
import { randomUUID } from "node:crypto";

export type DynamicVariables = Record<string, string | number | boolean>;

export type PlaceCallResult =
  | { ok: true; conversation_id: string | null; call_sid: string | null; stubbed: boolean }
  /** rejected: ElevenLabs answered with an error. ambiguous: unknown whether the call went out. */
  | { ok: false; kind: "rejected" | "ambiguous"; code: string; retryable: boolean };

export interface OutboundCaller {
  placeCall(input: { to: string; dynamicVariables: DynamicVariables }): Promise<PlaceCallResult>;
}

export interface ElevenLabsCallerOptions {
  apiKey: string;
  agentId: string;
  /** ID of the Twilio number imported into ElevenLabs (not the number itself). */
  agentPhoneNumberId: string;
  baseUrl?: string;
  timeoutMs?: number;
  ringingTimeoutSecs?: number;
  fetch?: typeof fetch;
}

export class ElevenLabsOutboundCaller implements OutboundCaller {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ElevenLabsCallerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async placeCall({ to, dynamicVariables }: { to: string; dynamicVariables: DynamicVariables }): Promise<PlaceCallResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl ?? "https://api.elevenlabs.io"}/v1/convai/twilio/outbound-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": this.options.apiKey },
        body: JSON.stringify({
          agent_id: this.options.agentId,
          agent_phone_number_id: this.options.agentPhoneNumberId,
          to_number: to,
          conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
          call_recording_enabled: false,
          telephony_call_config: { ringing_timeout_secs: this.options.ringingTimeoutSecs ?? 30 },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch {
      return { ok: false, kind: "ambiguous", code: "PROVIDER_TIMEOUT", retryable: false };
    }

    let payload: { success?: unknown; conversation_id?: unknown; callSid?: unknown } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // Unreadable body: with a 2xx status we don't know whether the call went out.
      if (response.ok) return { ok: false, kind: "ambiguous", code: "INVALID_PROVIDER_RESPONSE", retryable: false };
    }

    if (!response.ok || payload.success !== true) {
      return {
        ok: false,
        kind: "rejected",
        code: `ELEVENLABS_${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    return {
      ok: true,
      conversation_id: typeof payload.conversation_id === "string" ? payload.conversation_id : null,
      call_sid: typeof payload.callSid === "string" ? payload.callSid : null,
      stubbed: false,
    };
  }
}

/** Records calls in memory; calls nobody. */
export class StubOutboundCaller implements OutboundCaller {
  readonly calls: { to: string; dynamicVariables: DynamicVariables; conversation_id: string }[] = [];
  /** Forced results for tests, in order. */
  readonly queued: PlaceCallResult[] = [];

  async placeCall({ to, dynamicVariables }: { to: string; dynamicVariables: DynamicVariables }): Promise<PlaceCallResult> {
    const forced = this.queued.shift();
    if (forced) return forced;
    const conversation_id = `conv_stub_${randomUUID().replace(/-/g, "")}`;
    this.calls.push({ to, dynamicVariables, conversation_id });
    return { ok: true, conversation_id, call_sid: null, stubbed: true };
  }
}
