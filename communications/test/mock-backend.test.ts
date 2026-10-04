import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
process.env.LOG_SILENT = "1";

import { BackendClient, reportIdempotencyKey } from "../src/backend/client.ts";
import { ErrorBody, SCHEMA_VERSION, type ReportRequest } from "../src/contracts/index.ts";
import { createMockBackend } from "../src/mock-backend/server.ts";
import type { MockState } from "../src/mock-backend/state.ts";

const TOKEN = "test-service-token";
const KNOWN_PHONE = "+12025550101";
const SHARED_PHONE = "+12025550102";
const UNKNOWN_PHONE = "+12025550199";

let baseUrl: string;
let state: MockState;
let client: BackendClient;
let closeServer: () => Promise<void>;
let sessionCounter = 0;

before(async () => {
  const mock = createMockBackend({ serviceToken: TOKEN });
  state = mock.state;
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`;
  client = new BackendClient({ baseUrl, serviceToken: TOKEN, timeoutMs: 2000 });
  closeServer = () => new Promise((resolve) => mock.server.close(() => resolve()));
});

after(() => closeServer());

function newSession(): string {
  sessionCounter += 1;
  return `session_test_${sessionCounter}`;
}

function resolution(sessionId: string, phone: string, token: string | null = null) {
  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    phone_e164: phone,
    channel: "voice" as const,
    confirm_candidate_token: token,
    is_demo: true,
  };
}

/** Resuelve y confirma el único/primer candidato; devuelve el plot_id confirmado. */
async function confirmFirst(sessionId: string, phone: string): Promise<string> {
  const found = await client.resolveContact(resolution(sessionId, phone));
  assert.ok(found.ok);
  const confirmed = await client.resolveContact(resolution(sessionId, phone, found.data.candidates[0]!.candidate_token));
  assert.ok(confirmed.ok);
  return confirmed.data.confirmed!.plots[0]!.plot_id;
}

function report(sessionId: string, plotId: string | null, overrides: Partial<ReportRequest> = {}): ReportRequest {
  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    plot_id: plotId,
    case_id: null,
    channel: "voice",
    provider_reference: "conv_demo_test",
    observed_at: null,
    symptoms: ["manchas en hojas"],
    measurements: [],
    user_statement: "Desde ayer veo manchas en varias plantas",
    completeness: "partial",
    assessment_id: null,
    is_demo: true,
    ...overrides,
  };
}

async function rawPost(path: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers },
    body,
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as unknown };
}

describe("convenciones de la sección 8", () => {
  it("401 con error uniforme y request_id propagado", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/x`, { headers: { "X-Request-Id": "req_from_caller" } });
    assert.equal(res.status, 401);
    const body = ErrorBody.parse(await res.json());
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal(body.error.request_id, "req_from_caller");
    assert.equal(res.headers.get("x-request-id"), "req_from_caller");
  });

  it("400 ante JSON inválido", async () => {
    const res = await rawPost("/v1/assessments", "{no es json");
    assert.equal(res.status, 400);
    assert.equal(ErrorBody.parse(res.json).error.code, "INVALID_JSON");
  });

  it("422 con details en forma measurements[0].unit y campos desconocidos", async () => {
    const session = newSession();
    const plotId = await confirmFirst(session, KNOWN_PHONE);
    const body = {
      ...report(session, plotId),
      measurements: [{ name: "ph", value: 6.1, sample_type: "suelo", measured_at: null, method: null, source: "farmer_reported" }],
      plotId: "camelCase no está permitido",
    };
    const res = await rawPost("/v1/reports", JSON.stringify(body), { "Idempotency-Key": `k-${session}` });
    assert.equal(res.status, 422);
    const details = ErrorBody.parse(res.json).error.details;
    assert.deepEqual(details.find((d) => d.field === "measurements[0].unit"), { field: "measurements[0].unit", reason: "required" });
    assert.ok(details.some((d) => d.field === "plotId" && d.reason === "unrecognized"));
  });

  it("un teléfono inválido no aparece en el error público", async () => {
    const res = await rawPost("/v1/contact-resolution", JSON.stringify(resolution(newSession(), "55 1234 5678")));
    assert.equal(res.status, 422);
    assert.doesNotMatch(JSON.stringify(res.json), /1234/);
  });

  it("rechaza is_demo=false: demo y producción no se mezclan", async () => {
    const res = await rawPost("/v1/contact-resolution", JSON.stringify({ ...resolution(newSession(), KNOWN_PHONE), is_demo: false }));
    assert.equal(res.status, 422);
    assert.equal(ErrorBody.parse(res.json).error.code, "DEMO_MODE_MISMATCH");
  });

  it("observed_at null se conserva como null (desconocido)", async () => {
    const session = newSession();
    const plotId = await confirmFirst(session, KNOWN_PHONE);
    const created = await client.submitReport(report(session, plotId), reportIdempotencyKey(session, 1));
    assert.ok(created.ok);
    const detail = await client.getReport(created.data.report_id);
    assert.ok(detail.ok);
    assert.equal(detail.data.observed_at, null);
    assert.equal(detail.data.is_demo, true);
    assert.equal(created.data.correlation_id, session);
  });
});

describe("resolución de contacto (sección 15)", () => {
  it("número conocido: pide confirmación y no expone datos antes", async () => {
    const session = newSession();
    const found = await client.resolveContact(resolution(session, KNOWN_PHONE));
    assert.ok(found.ok);
    assert.equal(found.data.resolution_status, "candidates");
    assert.equal(found.data.requires_confirmation, true);
    assert.equal(found.data.confirmed, null);
    assert.deepEqual(Object.keys(found.data.candidates[0]!).sort(), ["candidate_token", "label"]);

    const before = await client.getPlotContext("plot_demo_01", session);
    assert.ok(!before.ok);
    assert.equal(before.status, 403);

    const plotId = await confirmFirst(session, KNOWN_PHONE);
    const context = await client.getPlotContext(plotId, session);
    assert.ok(context.ok);
    assert.equal(context.data.crop, "coffee");
  });

  it("teléfono compartido: dos candidatos y confirmar uno no expone al otro", async () => {
    const session = newSession();
    const found = await client.resolveContact(resolution(session, SHARED_PHONE));
    assert.ok(found.ok);
    assert.equal(found.data.is_shared_phone, true);
    assert.equal(found.data.candidates.length, 2);

    const confirmed = await client.resolveContact(resolution(session, SHARED_PHONE, found.data.candidates[1]!.candidate_token));
    assert.ok(confirmed.ok);
    const ownPlot = confirmed.data.confirmed!.plots[0]!.plot_id;
    const otherPlot = ownPlot === "plot_demo_02" ? "plot_demo_03" : "plot_demo_02";

    assert.ok((await client.getPlotContext(ownPlot, session)).ok);
    const other = await client.getPlotContext(otherPlot, session);
    assert.ok(!other.ok);
    assert.equal(other.code, "PLOT_NOT_CONFIRMED");
  });

  it("número desconocido: sin candidatos ni parcela", async () => {
    const found = await client.resolveContact(resolution(newSession(), UNKNOWN_PHONE));
    assert.ok(found.ok);
    assert.equal(found.data.resolution_status, "no_match");
    assert.equal(found.data.candidates.length, 0);
  });

  it("un candidate_token no sirve en otra sesión", async () => {
    const found = await client.resolveContact(resolution(newSession(), KNOWN_PHONE));
    assert.ok(found.ok);
    const stolen = await client.resolveContact(resolution(newSession(), KNOWN_PHONE, found.data.candidates[0]!.candidate_token));
    assert.ok(!stolen.ok);
    assert.equal(stolen.status, 403);
  });

  it("reporte de parcela no confirmada por la sesión: 403", async () => {
    const res = await client.submitReport(report(newSession(), "plot_demo_01"), "k-unconfirmed");
    assert.ok(!res.ok);
    assert.equal(res.code, "PLOT_NOT_CONFIRMED");
  });

  it("número desconocido puede dejar registro mínimo sin parcela ni caso", async () => {
    const session = newSession();
    const res = await client.submitReport(report(session, null), reportIdempotencyKey(session, 1));
    assert.ok(res.ok);
    assert.equal(res.data.case_id, null);
  });
});

describe("idempotencia (webhook duplicado)", () => {
  it("misma clave y cuerpo → mismo reporte; otro cuerpo → 409", async () => {
    const session = newSession();
    const plotId = await confirmFirst(session, KNOWN_PHONE);
    const key = reportIdempotencyKey(session, 3);
    const before = state.reports.size;

    const first = await client.submitReport(report(session, plotId), key);
    const replay = await client.submitReport(report(session, plotId), key);
    assert.ok(first.ok && replay.ok);
    assert.equal(first.status, 201);
    assert.equal(replay.data.report_id, first.data.report_id);
    assert.equal(replay.replayed, true);
    assert.equal(state.reports.size, before + 1);

    const conflict = await client.submitReport(report(session, plotId, { user_statement: "otra cosa" }), key);
    assert.ok(!conflict.ok);
    assert.equal(conflict.status, 409);
  });

  it("falta Idempotency-Key → 422", async () => {
    const session = newSession();
    const plotId = await confirmFirst(session, KNOWN_PHONE);
    const res = await rawPost("/v1/reports", JSON.stringify(report(session, plotId)));
    assert.equal(res.status, 422);
  });

  it("tres reportes de la misma parcela se agrupan en un caso", async () => {
    const session = newSession();
    const plotId = await confirmFirst(session, "+12025550107");
    const ids = new Set<string | null>();
    for (const turn of [1, 2, 3]) {
      const res = await client.submitReport(report(session, plotId, { user_statement: `turno ${turn}` }), reportIdempotencyKey(session, turn));
      assert.ok(res.ok);
      ids.add(res.data.case_id);
    }
    assert.equal(ids.size, 1);
  });

  it("timeout ambiguo: el reintento con la misma clave devuelve el original", async () => {
    const session = newSession();
    const plotId = await confirmFirst(session, KNOWN_PHONE);
    const key = reportIdempotencyKey(session, 1);
    const impatient = new BackendClient({ baseUrl, serviceToken: TOKEN, timeoutMs: 100 });
    const before = state.reports.size;

    const timedOut = await impatient.submitReport(report(session, plotId), key, { mockScenario: "delay:400" });
    assert.ok(!timedOut.ok);
    assert.equal(timedOut.kind, "timeout");

    const retry = await client.submitReport(report(session, plotId), key);
    assert.ok(retry.ok);
    assert.equal(retry.replayed, true);
    assert.equal(state.reports.size, before + 1);
  });
});

describe("asesor mock (v2: information_needs)", () => {
  type Answer = { need_code: string; value: string | number | boolean | null; unit: string | null; raw_text: string; unknown: boolean };
  const known = (need_code: string, value: string): Answer => ({ need_code, value, unit: null, raw_text: value, unknown: false });
  const dontKnow = (need_code: string): Answer => ({ need_code, value: null, unit: null, raw_text: "no sé", unknown: true });

  async function assessFor(
    phone: string,
    answers: Answer[],
    { crop = "coffee", asked = [], statement = "Desde ayer veo manchas" }: { crop?: string | null; asked?: string[]; statement?: string } = {},
  ) {
    const session = newSession();
    const plotId = await confirmFirst(session, phone);
    return client.assess({
      schema_version: SCHEMA_VERSION,
      session_id: session,
      plot_id: plotId,
      language: "es",
      observation: {
        observed_at: null,
        symptoms: ["manchas en hojas"],
        user_statement: statement,
        measurements: [],
        answers,
        completeness: "partial",
      },
      asked_need_codes: asked,
      plot_context: { crop, variety: null },
      is_demo: true,
    });
  }

  it("devuelve dos necesidades ordenadas, sin texto de pregunta, y declara los datos consultados", async () => {
    const res = await assessFor(KNOWN_PHONE, []);
    assert.ok(res.ok);
    assert.equal(res.data.disposition, "ask_more");
    assert.deepEqual(
      res.data.information_needs.map((n) => [n.need_code, n.priority]),
      [["local_weather_perception", 1], ["leaf_underside", 2]],
    );
    assert.ok(res.data.information_needs.every((n) => n.farmer_hint.length > 0));
    assert.ok(!("spoken_response" in res.data) && !("next_question" in res.data));
    assert.equal(res.data.data_used[0]?.data_freshness, "fresh");
  });

  it("no repite necesidades ya preguntadas", async () => {
    const res = await assessFor(KNOWN_PHONE, [known("local_weather_perception", "llovió mucho")], { asked: ["leaf_underside"] });
    assert.ok(res.ok);
    const codes = res.data.information_needs.map((n) => n.need_code);
    assert.ok(!codes.includes("local_weather_perception") && !codes.includes("leaf_underside"));
    assert.equal(codes[0], "spot_appearance");
  });

  it("\"no sé\" no cuenta como respuesta: sigue preguntando", async () => {
    const res = await assessFor(KNOWN_PHONE, [dontKnow("leaf_underside")], { asked: ["local_weather_perception"] });
    assert.ok(res.ok);
    assert.equal(res.data.disposition, "ask_more");
    assert.equal(res.data.information_needs[0]?.need_code, "spot_appearance");
  });

  it("unknown=true con un valor distinto de null se rechaza (nunca cero)", async () => {
    const session = newSession();
    const plotId = await confirmFirst(session, KNOWN_PHONE);
    const body = {
      schema_version: SCHEMA_VERSION,
      session_id: session,
      plot_id: plotId,
      language: "es",
      observation: { observed_at: null, symptoms: [], user_statement: "manchas", measurements: [], completeness: "partial",
        answers: [{ need_code: "symptom_onset_days", value: 0, unit: "d", raw_text: "no sé", unknown: true }] },
      asked_need_codes: [],
      plot_context: { crop: "coffee", variety: null },
      is_demo: true,
    };
    const res = await rawPost("/v1/assessments", JSON.stringify(body));
    assert.equal(res.status, 422);
    assert.ok(ErrorBody.parse(res.json).error.details.some((d) => d.field === "observation.answers[0].value"));
  });

  it("orienta con protocolo, sin confirmar enfermedad, y menciona primero un caso verificado", async () => {
    const res = await assessFor(KNOWN_PHONE, [known("leaf_underside", "polvo naranja o amarillo")]);
    assert.ok(res.ok);
    assert.equal(res.data.disposition, "advise");
    assert.equal(res.data.suspected_issue?.certainty, "suspected");
    assert.equal(res.data.protocol_version, "coffee-rust-demo-v1");
    assert.ok(res.data.recommendations.every((r) => r.protocol_id === "coffee-rust-demo-v1"));
    assert.equal(res.data.resolved_case_mentions[0]?.verification, "verified");
  });

  it("caso resuelto con producto y dosis: nunca se menciona", async () => {
    const saved = state.resolutions.splice(0, state.resolutions.length);
    state.resolutions.push(...saved.filter((r) => r.matches_protocol === false));
    try {
      const res = await assessFor(KNOWN_PHONE, [known("leaf_underside", "polvo naranja o amarillo")]);
      assert.ok(res.ok);
      assert.deepEqual(res.data.resolved_case_mentions, []);
      assert.doesNotMatch(JSON.stringify(res.data), /fungicida|ml por litro/);
    } finally {
      state.resolutions.splice(0, state.resolutions.length, ...saved);
    }
  });

  it("pregunta por fungicida o dosis → deriva", async () => {
    const res = await assessFor(KNOWN_PHONE, [], { statement: "¿Qué fungicida le echo y qué dosis?" });
    assert.ok(res.ok);
    assert.equal(res.data.disposition, "refer");
    assert.equal(res.data.human_review_required, true);
  });

  it("límite de 5 preguntas → deriva", async () => {
    const asked = ["local_weather_perception", "leaf_underside", "spot_appearance", "affected_extent", "leaf_drop"];
    const res = await assessFor(KNOWN_PHONE, [], { asked });
    assert.ok(res.ok);
    assert.equal(res.data.disposition, "refer");
  });

  it("parcela fuera de cobertura: lo declara en data_used sin inventar datos", async () => {
    const res = await assessFor("+12025550104", []);
    assert.ok(res.ok);
    assert.match(res.data.data_used[0]!.summary, /fuera de cobertura/);
    assert.equal(res.data.data_used[0]!.data_freshness, "unknown");
  });

  it("parcela sin contexto → deriva", async () => {
    const res = await assessFor("+12025550108", [], { crop: null });
    assert.ok(res.ok);
    assert.equal(res.data.disposition, "refer");
    assert.equal(res.data.human_review_required, true);
  });

  it("asesor caído → 503 reintentable", async () => {
    const res = await client.assess(
      {
        schema_version: SCHEMA_VERSION,
        session_id: "s",
        plot_id: "plot_demo_01",
        language: "es",
        observation: { observed_at: null, symptoms: [], user_statement: "", measurements: [], answers: [], completeness: "partial" },
        asked_need_codes: [],
        plot_context: { crop: "coffee", variety: null },
        is_demo: true,
      },
      { mockScenario: "advisor_unavailable" },
    );
    assert.ok(!res.ok);
    assert.equal(res.status, 503);
    assert.equal(res.retryable, true);
  });
});

describe("contexto de parcela", () => {
  it("incluye el resumen ambiental con unidades; sin resumen → null", async () => {
    const session = newSession();
    const plotId = await confirmFirst(session, KNOWN_PHONE);
    const context = await client.getPlotContext(plotId, session);
    assert.ok(context.ok);
    const humidity = context.data.environment_summary?.features.find((f) => f.name === "humidity_mean_14d");
    assert.equal(humidity?.unit, "%");

    const other = newSession();
    const noContextPlot = await confirmFirst(other, "+12025550107");
    const empty = await client.getPlotContext(noContextPlot, other);
    assert.ok(empty.ok);
    assert.equal(empty.data.environment_summary, null);
  });
});

describe("seguimientos (v2)", () => {
  const NOW = "2026-10-03T23:00:00.000Z";

  function attempt(session: string, status: "contacting" | "no_response" | "failed") {
    return {
      schema_version: SCHEMA_VERSION,
      session_id: session,
      status,
      channel: "voice" as const,
      call_reference: `conv_${session}`,
      occurred_at: NOW,
      is_demo: true,
    };
  }

  function response(session: string, status_reported: "worse" | "same" | "improved" | "resolved" | "unknown") {
    return {
      schema_version: SCHEMA_VERSION,
      session_id: session,
      channel: "voice" as const,
      status_reported,
      user_statement: status_reported === "resolved" ? "Ya no salen manchas desde que quité las hojas" : "Sigue igual o peor",
      actions_taken: "Quitó hojas con manchas y regó menos",
      action_worked: status_reported === "resolved" ? ("yes" as const) : ("no" as const),
      change_noticed_at: null,
      provider_reference: `conv_${session}`,
      is_demo: true,
    };
  }

  it("lista los vencidos con resumen del caso y contacto para la llamada", async () => {
    const res = await client.listFollowups("scheduled");
    assert.ok(res.ok);
    const due = res.data.followups.find((f) => f.followup_id === "followup_demo_05");
    assert.ok(due);
    assert.equal(due.case_summary.farmer_name, "Marta");
    assert.equal(due.case_summary.threat_code, "coffee_leaf_rust");
    assert.ok(due.case_summary.guidance_given);
    assert.equal(due.contact.followup_call_consent, true);
    assert.equal(due.contact.timezone, "America/Mexico_City");
  });

  it("llamada saliente: `contacting` liga la sesión; sin respuesta no cierra nada", async () => {
    const session = newSession();
    const blocked = await client.submitFollowupResponse("followup_demo_05", response(session, "same"), `fu-${session}-early`);
    assert.ok(!blocked.ok);
    assert.equal(blocked.status, 403);

    const started = await client.recordFollowupAttempt("followup_demo_05", attempt(session, "contacting"), `att-${session}-c`);
    assert.ok(started.ok);
    assert.equal(started.data.status, "contacting");
    assert.equal(started.data.attempt_count, 1);

    const replay = await client.recordFollowupAttempt("followup_demo_05", attempt(session, "contacting"), `att-${session}-c`);
    assert.ok(replay.ok && replay.replayed);
    assert.equal(replay.data.attempt_count, 1, "repetir el callback no cuenta otro intento");

    const silent = await client.recordFollowupAttempt("followup_demo_05", attempt(session, "no_response"), `att-${session}-n`);
    assert.ok(silent.ok);
    assert.equal(silent.data.status, "no_response");
    assert.equal(state.cases.find((c) => c.id === "case_demo_05")?.status, "suspected", "sin respuesta no cambia el caso");
  });

  it("resuelto: crea una sola resolución y cierra el caso; repetir no duplica", async () => {
    const session = newSession();
    const before = state.resolutions.length;
    const started = await client.recordFollowupAttempt("followup_demo_05", attempt(session, "contacting"), `att-${session}-c`);
    assert.ok(started.ok);
    assert.equal(started.data.attempt_count, 2);

    const first = await client.submitFollowupResponse("followup_demo_05", response(session, "resolved"), `fu-${session}`);
    assert.ok(first.ok);
    assert.equal(first.status, 201);
    assert.equal(first.data.case_status, "resolved");
    assert.ok(first.data.resolution_id);
    assert.equal(first.data.next_followup_at, null);

    const replay = await client.submitFollowupResponse("followup_demo_05", response(session, "resolved"), `fu-${session}`);
    assert.ok(replay.ok && replay.replayed);
    assert.equal(replay.data.resolution_id, first.data.resolution_id);

    const again = await client.submitFollowupResponse("followup_demo_05", response(session, "resolved"), `fu-${session}-otra`);
    assert.ok(!again.ok);
    assert.equal(again.code, "FOLLOWUP_CLOSED");

    assert.equal(state.resolutions.length, before + 1);
    const created = state.resolutions.find((r) => r.id === first.data.resolution_id)!;
    assert.equal(created.verification, "farmer_reported");
    assert.equal(created.matches_protocol, null);
    assert.equal(created.solution_statement, "Quitó hojas con manchas y regó menos");
  });

  it("empeora: programa otro seguimiento y no crea resolución", async () => {
    const session = newSession();
    await confirmFirst(session, "+12025550106");
    const res = await client.submitFollowupResponse("followup_demo_06", response(session, "worse"), `fu-${session}`);
    assert.ok(res.ok);
    assert.equal(res.data.resolution_id, null);
    assert.ok(res.data.next_followup_at);
    assert.notEqual(res.data.case_status, "resolved");
  });
});

describe("consentimiento (PROPUESTO)", () => {
  it("guarda los permisos por separado; null conserva el anterior", async () => {
    const session = newSession();
    const found = await client.resolveContact(resolution(session, "+12025550107"));
    assert.ok(found.ok);
    const confirmed = await client.resolveContact(resolution(session, "+12025550107", found.data.candidates[0]!.candidate_token));
    assert.ok(confirmed.ok);
    const farmerId = confirmed.data.confirmed!.farmer_id;
    assert.deepEqual(confirmed.data.confirmed!.consent, { reports: null, notifications: null, followup_calls: null, consent_at: null });

    const body = {
      schema_version: SCHEMA_VERSION,
      session_id: session,
      farmer_id: farmerId,
      channel: "voice" as const,
      reports: true,
      notifications: false,
      followup_calls: null,
      provider_reference: null,
      is_demo: true,
    };
    const res = await client.recordConsent(body, `consent-${session}`);
    assert.ok(res.ok);
    assert.equal(res.data.consent.reports, true);
    assert.equal(res.data.consent.notifications, false);
    assert.equal(res.data.consent.followup_calls, null);
    assert.ok(res.data.consent.consent_at);
  });

  it("sin agricultor confirmado en la sesión → 403", async () => {
    const res = await client.recordConsent(
      {
        schema_version: SCHEMA_VERSION,
        session_id: newSession(),
        farmer_id: "farmer_demo_01",
        channel: "sms",
        reports: true,
        notifications: true,
        followup_calls: true,
        provider_reference: null,
        is_demo: true,
      },
      "consent-unconfirmed",
    );
    assert.ok(!res.ok);
    assert.equal(res.code, "FARMER_NOT_CONFIRMED");
  });

  it("BAJA revoca avisos y seguimientos de ese teléfono; desconocido → 0", async () => {
    const body = (phone: string) => ({
      schema_version: SCHEMA_VERSION,
      phone_e164: phone,
      channel: "sms" as const,
      scopes: ["notifications" as const, "followup_calls" as const],
      provider_reference: "SM_demo_baja",
      is_demo: true,
    });
    const res = await client.revokeConsent(body("+12025550102"), "revocation-SM_demo_baja");
    assert.ok(res.ok);
    assert.equal(res.data.contacts_updated, 1);
    const contact = state.contacts.find((c) => c.id === "contact_demo_02")!;
    assert.equal(contact.notification_consent, false);
    assert.equal(contact.followup_call_consent, false);
    assert.equal(contact.report_consent, true, "BAJA no toca el permiso de guardar reportes");

    const unknown = await client.revokeConsent(body(UNKNOWN_PHONE), "revocation-SM_demo_unknown");
    assert.ok(unknown.ok);
    assert.equal(unknown.data.contacts_updated, 0);
  });
});

describe("cliente", () => {
  it("rechaza respuestas que no cumplen el contrato", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ report_id: "r", case_id: "c" }), { status: 201 })) as typeof fetch;
    const bad = new BackendClient({ baseUrl, serviceToken: TOKEN, fetch: fakeFetch });
    const res = await bad.submitReport(report("s", "plot_demo_01"), "k");
    assert.ok(!res.ok);
    assert.equal(res.kind, "invalid_response");
  });
});
