/**
 * Agente de ayuda (llamada entrante, sección 2.1) contra el mock: las herramientas
 * que ElevenLabs llama durante la conversación, en el orden del prompt.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
process.env.LOG_SILENT = "1";

import { BackendClient } from "../src/backend/client.ts";
import { BackendWriter } from "../src/backend/writer.ts";
import { createMockBackend } from "../src/mock-backend/server.ts";
import type { MockState } from "../src/mock-backend/state.ts";
import { createCommsServer } from "../src/server/app.ts";
import { SmsConversation } from "../src/sms/conversation.ts";
import { FollowupSmsFlow } from "../src/sms/followup.ts";
import type { SessionStore } from "../src/sms/session.ts";
import { VoiceTools } from "../src/tools/voice-tools.ts";
import { StubSmsSender } from "../src/twilio/sender.ts";

const SERVICE_TOKEN = "test-service-token";
const TOOL_SECRET = "test-tool-secret-0123456789";
const MINUTE = 60 * 1000;

let clock = Date.parse("2026-10-03T23:00:00Z");
let mockState: MockState;
let writer: BackendWriter;
let tools: VoiceTools;
let commsUrl: string;
/** Simula un candidate_token vencido: el backend lo rechaza con 403 CANDIDATE_TOKEN_INVALID. */
let expireCandidateTokens = false;
let conversationCounter = 0;
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  const mock = createMockBackend({ serviceToken: SERVICE_TOKEN, now: () => new Date(clock) });
  mockState = mock.state;
  const tokenExpiringFetch: typeof fetch = (input, init) => {
    if (expireCandidateTokens && String(input).endsWith("/v1/contact-resolution") && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { confirm_candidate_token: string | null };
      if (body.confirm_candidate_token) return fetch(input, { ...init, body: JSON.stringify({ ...body, confirm_candidate_token: "vencido" }) });
    }
    return fetch(input, init);
  };
  const client = new BackendClient({ baseUrl: await listen(mock.server), serviceToken: SERVICE_TOKEN, timeoutMs: 2000, fetch: tokenExpiringFetch });
  writer = new BackendWriter(client, [20, 50]);
  const now = () => new Date(clock);
  tools = new VoiceTools({ client, writer, isDemo: true, defaultLanguage: "es", idleMs: 15 * MINUTE, now });
  const store: SessionStore = new Map();
  const followups = new FollowupSmsFlow({ client, writer, store, sender: new StubSmsSender(), isDemo: true, demoAllowlist: new Set(), replyWindowMs: MINUTE, now });
  const conversation = new SmsConversation({ client, store, writer, followups, isDemo: true, defaultLanguage: "es", idleMs: 30 * MINUTE, now });
  commsUrl = await listen(
    createCommsServer({
      publicBaseUrl: "https://comms.example.test",
      twilioAuthToken: "twilio-token",
      twilioPhoneNumber: "+12025550999",
      conversation,
      voiceTools: tools,
      toolSecret: TOOL_SECRET,
    }),
  );
});

after(async () => {
  await writer.drain();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

/** Una llamada entrante: `session_id` = `system__conversation_id`, como en ElevenLabs. */
function newCall() {
  conversationCounter += 1;
  const session_id = `conv_help_${conversationCounter}`;
  const call = async (path: string, body: Record<string, unknown> = {}) => {
    const res = await fetch(`${commsUrl}/v1/tools/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOOL_SECRET}` },
      body: JSON.stringify({ session_id, ...body }),
    });
    assert.equal(res.status, 200, `${path} → ${res.status}`);
    return (await res.json()) as Record<string, any>;
  };
  return { session_id, call };
}

const reportsOf = (sessionId: string) => [...mockState.reports.values()].filter((r) => r.session_id === sessionId);

describe("agente de ayuda: identidad y parcela", () => {
  it("número conocido: confirma, fija su parcela, evalúa y guarda el reporte", async () => {
    const { session_id, call } = newCall();
    const resolved = await call("resolve-farmer", { caller_phone: "+12025550101" });
    assert.equal(resolved.status, "candidates");
    assert.deepEqual(resolved.candidates, [{ number: 1, label: "Rosa" }]);
    assert.doesNotMatch(JSON.stringify(resolved), /cand_|plot_demo|farmer_demo|\+1202/, "sin tokens, IDs ni teléfono para el modelo");

    const confirmed = await call("confirm-farmer", { candidate_number: 1 });
    assert.equal(confirmed.confirmed, true);
    assert.deepEqual(confirmed.plots, [{ number: 1, label: "Parcela 1" }]);
    assert.equal(confirmed.report_permission, "granted");
    assert.deepEqual(confirmed.ask_permissions, []);

    const context = await call("get-plot-context");
    assert.equal(context.found, true);
    assert.equal(context.plot_label, "Parcela 1");
    assert.equal(context.crop, "coffee");

    assert.equal((await call("record-consent", { reports: true })).saved, true);

    const first = await call("assess-observation", { user_statement: "Tengo manchas amarillas en las hojas", symptoms: ["manchas amarillas en hojas"] });
    assert.equal(first.disposition, "ask_more");
    const codes = first.information_needs.map((n: { need_code: string }) => n.need_code);
    const advice = await call("assess-observation", {
      user_statement: "Tengo manchas amarillas en las hojas",
      answers: [{ need_code: "leaf_underside", value: "polvo naranja o amarillo", raw_text: "como polvito naranja", unknown: false }],
      asked_need_codes: codes,
    });
    assert.equal(advice.disposition, "advise");

    // El modelo no puede cambiar la parcela confirmada.
    const saved = await call("submit-report", {
      plot_id: "plot_demo_05",
      conversation_id: session_id,
      user_statement: "Manchas amarillas y polvo naranja abajo de las hojas",
      completeness: "sufficient",
    });
    assert.equal(saved.registered, true);
    const [report] = reportsOf(session_id);
    assert.equal(report?.plot_id, "plot_demo_01");
    assert.equal(report?.channel, "voice");
    assert.equal(report?.provider_reference, session_id);
    assert.equal(report?.assessment_id, advice.assessment_id);
  });

  it("teléfono compartido: solo nombres antes de confirmar; usa la parcela del elegido", async () => {
    const { session_id, call } = newCall();
    const resolved = await call("resolve-farmer", { caller_phone: "+12025550102" });
    assert.equal(resolved.is_shared_phone, true);
    assert.deepEqual(resolved.candidates.map((c: { label: string }) => c.label), ["Tomás", "Lucía"]);

    const early = await call("get-plot-context", { plot_number: 1 });
    assert.equal(early.found, false, "sin confirmar no hay datos de nadie");
    assert.equal(early.plot_label, undefined);

    assert.equal((await call("confirm-farmer", { candidate_number: 2 })).confirmed, true);
    assert.equal((await call("get-plot-context")).plot_label, "Parcela 3");
    await call("record-consent", { reports: true });
    assert.equal((await call("submit-report", { user_statement: "manchas", completeness: "partial" })).registered, true);
    assert.equal(reportsOf(session_id)[0]?.plot_id, "plot_demo_03");
  });

  it("número desconocido o sin caller ID: registro mínimo, sin parcela ni evaluación", async () => {
    for (const caller_phone of ["+12025550199", null]) {
      const { session_id, call } = newCall();
      const resolved = await call("resolve-farmer", { caller_phone });
      assert.equal(resolved.status, "no_match");
      assert.equal((await call("confirm-farmer", { candidate_number: 1 })).confirmed, false);
      assert.equal((await call("assess-observation", { user_statement: "se secan las plantas" })).disposition, "no_plot");

      const withoutPermission = await call("submit-report", { user_statement: "se secan las plantas", completeness: "partial" });
      assert.equal(withoutPermission.registered, false);
      assert.equal(reportsOf(session_id).length, 0);

      assert.equal((await call("record-consent", { reports: true })).valid_for_this_call_only, true);
      assert.equal((await call("submit-report", { user_statement: "se secan las plantas", completeness: "partial" })).registered, true);
      assert.equal(reportsOf(session_id)[0]?.plot_id, null);
    }
  });

  it("candidato vencido: pide confirmar de nuevo con candidatos nuevos", async () => {
    const { call } = newCall();
    await call("resolve-farmer", { caller_phone: "+12025550101" });
    expireCandidateTokens = true;
    const expired = await call("confirm-farmer", { candidate_number: 1 });
    expireCandidateTokens = false;
    assert.equal(expired.confirmed, false);
    assert.deepEqual(expired.candidates, [{ number: 1, label: "Rosa" }]);
    assert.equal((await call("confirm-farmer", { candidate_number: 1 })).confirmed, true);
  });
});

describe("agente de ayuda: permisos", () => {
  it("primera vez: guarda los tres permisos por separado", async () => {
    const { call } = newCall();
    await call("resolve-farmer", { caller_phone: "+12025550108" });
    const confirmed = await call("confirm-farmer", { candidate_number: 1 });
    assert.equal(confirmed.report_permission, "never_asked");
    assert.deepEqual(confirmed.ask_permissions, ["notifications", "followup_calls"]);

    assert.equal((await call("record-consent", { reports: true, notifications: false, followup_calls: true })).saved, true);
    const contact = mockState.contacts.find((c) => c.id === "contact_demo_08")!;
    assert.deepEqual([contact.report_consent, contact.notification_consent, contact.followup_call_consent], [true, false, true]);
    assert.ok(contact.consent_at);
  });

  it("si no da permiso de guardar, no se evalúa ni se guarda nada", async () => {
    const { session_id, call } = newCall();
    await call("resolve-farmer", { caller_phone: "+12025550107" });
    await call("confirm-farmer", { candidate_number: 1 });
    await call("record-consent", { reports: false });
    assert.equal((await call("assess-observation", { user_statement: "manchas" })).disposition, "declined");
    assert.equal((await call("submit-report", { user_statement: "manchas", completeness: "partial" })).registered, false);
    assert.equal(reportsOf(session_id).length, 0);
  });

  it("llamada cortada sin submit_report: guarda lo descrito como parcial, una sola vez", async () => {
    const { session_id, call } = newCall();
    await call("resolve-farmer", { caller_phone: "+12025550105" });
    await call("confirm-farmer", { candidate_number: 1 });
    await call("get-plot-context");
    await call("record-consent", { reports: true });
    await call("assess-observation", { user_statement: "Las hojas tienen polvo naranja", symptoms: ["polvo naranja en el envés"] });

    await tools.sweep();
    assert.equal(reportsOf(session_id).length, 0, "aún dentro del plazo");
    clock += 16 * MINUTE;
    await tools.sweep();
    await tools.sweep();
    const reports = reportsOf(session_id);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.completeness, "partial");
    assert.equal(reports[0]?.plot_id, "plot_demo_05");
    assert.equal(reports[0]?.user_statement, "Las hojas tienen polvo naranja");
  });
});

describe("agente de ayuda: rutas", () => {
  it("exigen el secreto de las herramientas y validan parámetros", async () => {
    const post = (path: string, body: unknown, auth?: string) =>
      fetch(`${commsUrl}/v1/tools/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body),
      });
    assert.equal((await post("resolve-farmer", { session_id: "s", caller_phone: "+12025550101" })).status, 401);
    assert.equal((await post("resolve-farmer", { session_id: "s", caller_phone: "+12025550101" }, "otro-secreto-0123456789")).status, 401);
    const invalid = await post("confirm-farmer", { session_id: "s", candidate_number: 0 }, TOOL_SECRET);
    assert.equal(invalid.status, 422);
    assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "VALIDATION_ERROR");
  });
});
