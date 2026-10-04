import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import twilio from "twilio";
process.env.LOG_SILENT = "1";

import { BackendClient } from "../src/backend/client.ts";
import { BackendWriter } from "../src/backend/writer.ts";
import type { FollowupListItem } from "../src/contracts/index.ts";
import { createMockBackend } from "../src/mock-backend/server.ts";
import type { MockState } from "../src/mock-backend/state.ts";
import { createCommsServer } from "../src/server/app.ts";
import { SmsConversation } from "../src/sms/conversation.ts";
import { FollowupSmsFlow } from "../src/sms/followup.ts";
import { sms } from "../src/sms/messages.ts";
import type { SessionStore } from "../src/sms/session.ts";
import { StubSmsSender } from "../src/twilio/sender.ts";

const SERVICE_TOKEN = "test-service-token";
const AUTH_TOKEN = "test-twilio-auth-token";
const PUBLIC_BASE_URL = "https://comms.example.test";
const OUR_NUMBER = "+12025550999";
const SMS_PATH = "/v1/webhooks/twilio/sms";

let mockState: MockState;
let commsUrl: string;
let client: BackendClient;
let writer: BackendWriter;
let followups: FollowupSmsFlow;
let conversation: SmsConversation;
const sender = new StubSmsSender();
let clock = Date.parse("2026-10-03T23:00:00Z");
/** Escenario del mock que se inyecta en las llamadas cuya ruta coincide. */
let scenario: { path: RegExp; value: string } | null = null;
let sidCounter = 0;
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  const mock = createMockBackend({ serviceToken: SERVICE_TOKEN });
  mockState = mock.state;
  const backendUrl = await listen(mock.server);

  const scenarioFetch: typeof fetch = (input, init) => {
    const url = String(input);
    if (scenario && scenario.path.test(url)) {
      const headers = new Headers(init?.headers);
      headers.set("X-Mock-Scenario", scenario.value);
      return fetch(input, { ...init, headers });
    }
    return fetch(input, init);
  };
  client = new BackendClient({ baseUrl: backendUrl, serviceToken: SERVICE_TOKEN, timeoutMs: 2000, fetch: scenarioFetch });
  writer = new BackendWriter(client, [50, 200]);
  const store: SessionStore = new Map();
  followups = new FollowupSmsFlow({
    client,
    writer,
    store,
    sender,
    isDemo: true,
    demoAllowlist: new Set(["+12025550105", "+12025550106"]),
    replyWindowMs: 24 * 60 * 60 * 1000,
    now: () => new Date(clock),
  });
  conversation = new SmsConversation({
    client,
    store,
    writer,
    followups,
    isDemo: true,
    defaultLanguage: "es",
    idleMs: 30 * 60 * 1000,
    now: () => new Date(clock),
  });
  commsUrl = await listen(
    createCommsServer({ publicBaseUrl: PUBLIC_BASE_URL, twilioAuthToken: AUTH_TOKEN, twilioPhoneNumber: OUR_NUMBER, conversation }),
  );
});

after(async () => {
  await writer.drain();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

beforeEach(() => {
  scenario = null;
});

function nextSid(): string {
  sidCounter += 1;
  return `SM${String(sidCounter).padStart(32, "0")}`;
}

/** Envía un SMS como Twilio: form-encoded y firmado con la URL pública. */
async function sendSms(from: string, body: string, opts: { sid?: string; to?: string; signature?: string } = {}) {
  const params: Record<string, string> = {
    MessageSid: opts.sid ?? nextSid(),
    AccountSid: "ACtest",
    From: from,
    To: opts.to ?? OUR_NUMBER,
    Body: body,
    NumMedia: "0",
  };
  const signature = opts.signature ?? twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${SMS_PATH}`, params);
  const res = await fetch(`${commsUrl}${SMS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  const reply = text.match(/<Message>([\s\S]*)<\/Message>/)?.[1] ?? null;
  return { status: res.status, text, reply: reply && decodeXml(reply), sid: params.MessageSid! };
}

function decodeXml(s: string): string {
  return s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function reportsFrom(firstSid: string) {
  return [...mockState.reports.values()].filter((r) => r.provider_reference === firstSid);
}

describe("webhook SMS: seguridad", () => {
  it("firma inválida → 403 y no llama al backend", async () => {
    const before = mockState.reports.size;
    const res = await sendSms("+12025550101", "manchas", { signature: "firma-falsa" });
    assert.equal(res.status, 403);
    assert.match(res.text, /INVALID_SIGNATURE/);
    assert.equal(mockState.reports.size, before);
  });

  it("SMS dirigido a otro número → se ignora sin respuesta", async () => {
    const res = await sendSms("+12025550101", "hola", { to: "+12025550000" });
    assert.equal(res.status, 200);
    assert.equal(res.reply, null);
  });
});

describe("webhook SMS: conversación", () => {
  it("número conocido: confirma identidad, pide consentimiento, pregunta y registra el reporte", async () => {
    const phone = "+12025550101";
    const first = await sendSms(phone, "Tengo manchas en las hojas del cafe");
    assert.equal(first.reply, sms.identify(["Rosa"]));

    // Ya dio permiso de guardar reportes: solo se confirma este reporte.
    assert.equal((await sendSms(phone, "1")).reply, sms.confirmReport);

    // El asesor devuelve dos necesidades; se pregunta una por turno, la de mayor prioridad.
    const weather = await sendSms(phone, "SI");
    assert.match(weather.reply!, /clima/);
    assert.equal(reportsFrom(first.sid).length, 0, "no se guarda antes de terminar");

    const leaf = await sendSms(phone, "Ha llovido mucho");
    assert.match(leaf.reply!, /parte de abajo de las hojas/);
    assert.match(leaf.reply!, /1 polvo naranja o amarillo/);

    const closing = await sendSms(phone, "1");
    assert.match(closing.reply!, /no confirma ninguna enfermedad/);
    assert.match(closing.reply!, /entiérralas/);
    assert.match(closing.reply!, /un técnico confirmó/, "menciona el caso resuelto verificado");
    assert.ok(closing.reply!.endsWith(sms.saved));

    const [report] = reportsFrom(first.sid);
    assert.ok(report);
    assert.equal(report.channel, "sms");
    assert.equal(report.plot_id, "plot_demo_01");
    assert.equal(report.completeness, "sufficient");
    assert.equal(report.observed_at, null);
    assert.match(report.user_statement, /manchas[\s\S]*llovido/);
    assert.ok(report.assessment_id);
  });

  it("webhook duplicado: misma respuesta y un solo reporte", async () => {
    const phone = "+12025550105";
    const first = await sendSms(phone, "Veo hojas con manchas cafes");
    await sendSms(phone, "1");
    await sendSms(phone, "si");
    await sendSms(phone, "no se");
    const last = await sendSms(phone, "polvo naranja abajo");
    const duplicate = await sendSms(phone, "polvo naranja abajo", { sid: last.sid });
    assert.equal(duplicate.text, last.text);
    assert.equal(reportsFrom(first.sid).length, 1);
  });

  it("teléfono compartido: solo nombres antes de confirmar; usa la parcela del elegido", async () => {
    const phone = "+12025550102";
    const first = await sendSms(phone, "hola");
    assert.equal(first.reply, sms.identify(["Tomás", "Lucía"]));
    assert.doesNotMatch(first.reply!, /Parcela|plot_/);

    await sendSms(phone, "2");
    await sendSms(phone, "si");
    assert.match((await sendSms(phone, "hay manchas en muchas plantas")).reply!, /clima/);
    assert.match((await sendSms(phone, "no sé")).reply!, /parte de abajo/);
    await sendSms(phone, "polvo amarillo");
    assert.equal(reportsFrom(first.sid)[0]?.plot_id, "plot_demo_03");
  });

  it("número desconocido: registro mínimo sin parcela", async () => {
    const phone = "+12025550177";
    const first = await sendSms(phone, "Mis plantas se estan secando");
    assert.equal(first.reply, `${sms.unknownNumber} ${sms.consent}`);
    const closing = await sendSms(phone, "si");
    assert.equal(closing.reply, sms.savedUnknown);
    const [report] = reportsFrom(first.sid);
    assert.equal(report?.plot_id, null);
    assert.equal(report?.case_id, null);
  });

  it("dice no ser el candidato: no se elige parcela", async () => {
    const phone = "+12025550106";
    const first = await sendSms(phone, "Hay plaga en el cafetal");
    assert.equal((await sendSms(phone, "0")).reply, sms.consent);
    await sendSms(phone, "si");
    assert.equal(reportsFrom(first.sid)[0]?.plot_id, null);
  });

  it("sin consentimiento no se guarda nada", async () => {
    const phone = "+12025550107";
    const first = await sendSms(phone, "manchas en hojas");
    await sendSms(phone, "1");
    assert.equal((await sendSms(phone, "NO")).reply, sms.consentDeclined);
    assert.equal(reportsFrom(first.sid).length, 0);
  });

  it("\"no sé\" se trata como desconocido: el asesor sigue preguntando", async () => {
    const phone = "+12025550104";
    const first = await sendSms(phone, "manchas en las hojas");
    await sendSms(phone, "1");
    await sendSms(phone, "si"); // pregunta del clima
    await sendSms(phone, "ni idea"); // pregunta del envés
    const next = await sendSms(phone, "5"); // opción "no sé"
    assert.match(next.reply!, /color y forma son las manchas/);
    const closing = await sendSms(phone, "1");
    assert.ok(closing.reply!.endsWith(sms.saved));
    assert.equal(reportsFrom(first.sid)[0]?.completeness, "sufficient");
  });

  it("primera vez: pide los tres permisos por separado y los guarda", async () => {
    const phone = "+12025550108";
    const first = await sendSms(phone, "manchas en hojas");
    assert.equal(first.reply, sms.identify(["Raúl"]));
    assert.equal((await sendSms(phone, "1")).reply, sms.consent);
    assert.equal((await sendSms(phone, "si")).reply, sms.consentNotifications);
    assert.equal((await sendSms(phone, "no")).reply, sms.consentFollowupCalls);
    const closing = await sendSms(phone, "si"); // parcela sin contexto: el asesor deriva
    assert.ok(closing.reply!.startsWith(sms.refer));
    assert.ok(closing.reply!.endsWith(sms.saved));

    await writer.drain();
    const contact = mockState.contacts.find((c) => c.id === "contact_demo_08")!;
    assert.equal(contact.report_consent, true);
    assert.equal(contact.notification_consent, false);
    assert.equal(contact.followup_call_consent, true);
    assert.ok(contact.consent_at);
  });

  it("STOP: no contesta (Twilio responde) pero revoca en el backend", async () => {
    const res = await sendSms("+12025550108", "STOP");
    assert.equal(res.reply, null);
    await writer.drain();
    const contact = mockState.contacts.find((c) => c.id === "contact_demo_08")!;
    assert.equal(contact.followup_call_consent, false);
    assert.equal(contact.notification_consent, false);
  });
});

describe("webhook SMS: BAJA", () => {
  it("revoca avisos y seguimientos, no el permiso de reportar", async () => {
    const res = await sendSms("+12025550102", "Baja");
    assert.equal(res.reply, sms.optedOut);
    const contact = mockState.contacts.find((c) => c.id === "contact_demo_02")!;
    assert.equal(contact.notification_consent, false);
    assert.equal(contact.followup_call_consent, false);
    assert.equal(contact.report_consent, true);
  });

  it("a mitad de un reporte: guarda lo recibido como parcial y confirma la baja", async () => {
    const phone = "+12025550101";
    const first = await sendSms(phone, "manchas en el cafetal");
    await sendSms(phone, "1");
    await sendSms(phone, "si"); // pregunta del clima
    const res = await sendSms(phone, "BAJA");
    assert.equal(res.reply, sms.optedOut);
    assert.equal(reportsFrom(first.sid)[0]?.completeness, "partial");
  });

  it("backend caído: no afirma la baja y la reintenta", async () => {
    scenario = { path: /\/v1\/consents\/revocations$/, value: "backend_unavailable" };
    const res = await sendSms("+12025550104", "baja");
    assert.equal(res.reply, sms.optOutPending);
    scenario = null;
    await writer.drain();
    assert.equal(mockState.contacts.find((c) => c.id === "contact_demo_04")!.notification_consent, false);
  });
});

describe("webhook SMS: fallos", () => {
  it("asesor caído: lo dice y guarda el reporte sin evaluación", async () => {
    const phone = "+12025550104";
    const first = await sendSms(phone, "manchas en las hojas");
    await sendSms(phone, "1");
    scenario = { path: /\/v1\/assessments$/, value: "advisor_unavailable" };
    const closing = await sendSms(phone, "si");
    assert.equal(closing.reply, `${sms.advisorFailed} ${sms.saved}`);
    const [report] = reportsFrom(first.sid);
    assert.equal(report?.assessment_id, null);
    assert.equal(report?.completeness, "partial");
  });

  it("backend no guarda: no afirma registro y reintenta con la misma clave", async () => {
    const phone = "+12025550101";
    const first = await sendSms(phone, "otra vez manchas");
    await sendSms(phone, "1");
    await sendSms(phone, "si");
    await sendSms(phone, "llovió");
    scenario = { path: /\/v1\/reports$/, value: "backend_unavailable" };
    const closing = await sendSms(phone, "polvo amarillo");
    assert.ok(closing.reply!.endsWith(sms.notConfirmed));
    assert.doesNotMatch(closing.reply!, /quedó registrado\.$/);
    assert.equal(reportsFrom(first.sid).length, 0);

    scenario = null; // el backend se recupera antes del reintento
    await writer.drain();
    assert.equal(reportsFrom(first.sid).length, 1);
  });

  it("conversación abandonada: guarda lo recibido como parcial", async () => {
    const phone = "+12025550105";
    const first = await sendSms(phone, "las hojas tienen manchas");
    await sendSms(phone, "1");
    await sendSms(phone, "si"); // queda esperando la respuesta del asesor
    clock += 31 * 60 * 1000;
    await conversation.sweep();
    const [report] = reportsFrom(first.sid);
    assert.equal(report?.completeness, "partial");
  });
});

describe("seguimiento por SMS (respaldo)", () => {
  async function dueFollowup(id: string): Promise<FollowupListItem> {
    const list = await client.listFollowups(id === "followup_demo_05" ? "scheduled" : "no_response");
    assert.ok(list.ok);
    const item = list.data.followups.find((f) => f.followup_id === id);
    assert.ok(item);
    return item;
  }

  function withContact(item: FollowupListItem, contact: Partial<FollowupListItem["contact"]>): FollowupListItem {
    return { ...item, contact: { ...item.contact, ...contact } };
  }

  it("no envía sin consentimiento, fuera de horario ni a números fuera de la lista blanca", async () => {
    const item = await dueFollowup("followup_demo_05");
    const before = sender.sent.length;
    assert.deepEqual(await followups.start(withContact(item, { followup_call_consent: false })), { status: "skipped", reason: "no_consent" });
    assert.deepEqual(
      await followups.start(withContact(item, { allowed_hours: { start: "06:00", end: "07:00" } })),
      { status: "skipped", reason: "outside_hours" },
    );
    assert.deepEqual(await followups.start(withContact(item, { phone_e164: "+12025550101" })), { status: "skipped", reason: "not_allowlisted" });
    assert.equal(sender.sent.length, before);
  });

  it("no pisa una conversación en curso", async () => {
    const item = await dueFollowup("followup_demo_05");
    await sendSms("+12025550105", "veo manchas");
    assert.deepEqual(await followups.start(item), { status: "skipped", reason: "busy" });
    await sendSms("+12025550105", "0");
    await sendSms("+12025550105", "no"); // cierra la conversación sin guardar nada
  });

  it("resuelto: las respuestas se guardan como seguimiento y crean una resolución", async () => {
    const item = await dueFollowup("followup_demo_05");
    const started = await followups.start(item);
    assert.equal(started.status, "sent");
    const outbound = sender.sent.at(-1)!;
    assert.equal(outbound.to, "+12025550105");
    assert.equal(outbound.body, sms.followupIntro("Marta"));

    assert.equal((await sendSms("+12025550105", "4")).reply, sms.followupActions);
    assert.equal((await sendSms("+12025550105", "Quité las hojas y las enterré")).reply, sms.followupWorked);
    assert.equal((await sendSms("+12025550105", "1")).reply, sms.followupSaved("resolved"));

    assert.equal(mockState.followups.find((f) => f.id === "followup_demo_05")?.status, "responded");
    assert.equal(mockState.cases.find((c) => c.id === "case_demo_05")?.status, "resolved");
    const resolution = mockState.resolutions.find((r) => r.followup_id === "followup_demo_05");
    assert.equal(resolution?.solution_statement, "Quité las hojas y las enterré");
    assert.equal(resolution?.verification, "farmer_reported");
  });

  it("sin respuesta en la ventana: registra no_response y nunca una resolución", async () => {
    const item = await dueFollowup("followup_demo_06");
    assert.equal((await followups.start(item)).status, "sent");
    clock += 25 * 60 * 60 * 1000;
    await conversation.sweep();
    await writer.drain();

    const followup = mockState.followups.find((f) => f.id === "followup_demo_06")!;
    assert.equal(followup.status, "no_response");
    assert.equal(followup.attempt_count, 4);
    assert.notEqual(mockState.cases.find((c) => c.id === "case_demo_06")?.status, "resolved");
    assert.equal(mockState.resolutions.some((r) => r.followup_id === "followup_demo_06"), false);
  });
});
