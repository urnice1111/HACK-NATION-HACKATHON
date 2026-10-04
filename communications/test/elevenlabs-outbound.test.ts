import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ElevenLabsOutboundCaller } from "../src/elevenlabs/outbound.ts";

function callerWith(response: () => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  const caller = new ElevenLabsOutboundCaller({ apiKey: "xi-test", agentId: "agent_1", agentPhoneNumberId: "phnum_1", fetch: fakeFetch });
  return { caller, requests };
}

describe("llamada saliente de ElevenLabs", () => {
  it("manda agente, número, destino y variables dinámicas, sin grabación", async () => {
    const { caller, requests } = callerWith(
      () => new Response(JSON.stringify({ success: true, message: "ok", conversation_id: "conv_1", callSid: "CA1" }), { status: 200 }),
    );
    const result = await caller.placeCall({ to: "+5215512345678", dynamicVariables: { farmer_name: "Marta", attempt_number: 1 } });
    assert.deepEqual(result, { ok: true, conversation_id: "conv_1", call_sid: "CA1", stubbed: false });

    const [request] = requests;
    assert.equal(request!.url, "https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
    assert.equal((request!.init.headers as Record<string, string>)["xi-api-key"], "xi-test");
    const body = JSON.parse(String(request!.init.body));
    assert.equal(body.agent_id, "agent_1");
    assert.equal(body.agent_phone_number_id, "phnum_1");
    assert.equal(body.to_number, "+5215512345678");
    assert.deepEqual(body.conversation_initiation_client_data.dynamic_variables, { farmer_name: "Marta", attempt_number: 1 });
    assert.equal(body.call_recording_enabled, false);
  });

  it("error 4xx: rechazada sin reintento; 5xx: reintentable; red caída: ambigua", async () => {
    const bad = await callerWith(() => new Response(JSON.stringify({ detail: "invalid" }), { status: 422 })).caller.placeCall({ to: "+1", dynamicVariables: {} });
    assert.deepEqual(bad, { ok: false, kind: "rejected", code: "ELEVENLABS_422", retryable: false });

    const down = await callerWith(() => new Response("{}", { status: 503 })).caller.placeCall({ to: "+1", dynamicVariables: {} });
    assert.equal(down.ok === false && down.retryable, true);

    const lost = await callerWith(() => Promise.reject(new TypeError("fetch failed"))).caller.placeCall({ to: "+1", dynamicVariables: {} });
    assert.deepEqual(lost, { ok: false, kind: "ambiguous", code: "PROVIDER_TIMEOUT", retryable: false });
  });
});
