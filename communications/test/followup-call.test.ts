import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
process.env.LOG_SILENT = "1";

import { BackendClient } from "../src/backend/client.ts";
import { BackendWriter } from "../src/backend/writer.ts";
import type { FollowupListItem } from "../src/contracts/index.ts";
import { StubOutboundCaller } from "../src/elevenlabs/outbound.ts";
import { FollowupDispatcher } from "../src/followups/dispatcher.ts";
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
const COMMS_TOKEN = "test-comms-token-0123456789";
const MINUTE = 60 * 1000;

let clock = Date.parse("2026-10-03T23:00:00Z"); // 17:00 in America/Mexico_City
let mockState: MockState;
let client: BackendClient;
let writer: BackendWriter;
let dispatcher: FollowupDispatcher;
let tools: VoiceTools;
let followupSms: FollowupSmsFlow;
let commsUrl: string;
const caller = new StubOutboundCaller();
const sender = new StubSmsSender();
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  const mock = createMockBackend({ serviceToken: SERVICE_TOKEN, now: () => new Date(clock) });
  mockState = mock.state;
  client = new BackendClient({ baseUrl: await listen(mock.server), serviceToken: SERVICE_TOKEN, timeoutMs: 2000 });
  writer = new BackendWriter(client, [20, 50]);
  const store: SessionStore = new Map();
  const now = () => new Date(clock);
  followupSms = new FollowupSmsFlow({
    client,
    writer,
    store,
    sender,
    isDemo: true,
    demoAllowlist: new Set(["+12025550105", "+12025550106"]),
    replyWindowMs: 24 * 60 * MINUTE,
    now,
  });
  dispatcher = new FollowupDispatcher({
    client,
    writer,
    caller,
    followupSms,
    isDemo: true,
    demoAllowlist: new Set(["+12025550105", "+12025550106"]),
    callAttempts: 3,
    callResultTimeoutMs: 10 * MINUTE,
    placementBackoffMs: 2 * MINUTE,
    now,
  });
  tools = new VoiceTools({ client, writer, isDemo: true, defaultLanguage: "en", now });
  const conversation = new SmsConversation({ client, store, writer, followups: followupSms, isDemo: true, defaultLanguage: "en", idleMs: 30 * MINUTE, now });
  commsUrl = await listen(
    createCommsServer({
      publicBaseUrl: "https://comms.example.test",
      twilioAuthToken: "twilio-token",
      twilioPhoneNumber: "+12025550999",
      conversation,
      voiceTools: tools,
      toolSecret: TOOL_SECRET,
      dispatcher,
      serviceToken: COMMS_TOKEN,
    }),
  );
});

after(async () => {
  await writer.drain();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function followup(predicate: (f: FollowupListItem) => boolean, status: "scheduled" | "no_response" = "scheduled") {
  const list = await client.listFollowups(status);
  assert.ok(list.ok);
  const item = list.data.followups.find(predicate);
  assert.ok(item, "follow-up not found");
  return item;
}

const byId = (id: string) => (f: FollowupListItem) => f.followup_id === id;

async function postJson(path: string, body: unknown, token: string | null) {
  const res = await fetch(`${commsUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function stored(id: string) {
  return mockState.followups.find((f) => f.id === id)!;
}

describe("followup.due dispatch", () => {
  it("outside allowed hours it waits; without permission or outside the allowlist it doesn't call", async () => {
    const item = await followup(byId("followup_demo_05"));
    const contact = (c: Partial<FollowupListItem["contact"]>) => ({ ...item, contact: { ...item.contact, ...c } });
    assert.deepEqual(await dispatcher.dispatch(contact({ allowed_hours: { start: "06:00", end: "07:00" } })), { status: "deferred", reason: "outside_hours" });
    assert.deepEqual(await dispatcher.dispatch(contact({ followup_call_consent: false })), { status: "skipped", reason: "no_consent" });
    assert.deepEqual(await dispatcher.dispatch(contact({ phone_e164: "+12025550101" })), { status: "skipped", reason: "not_allowlisted" });
    assert.equal(caller.calls.length, 0);
  });

  it("calls with the case's dynamic variables and binds the session to the plot", async () => {
    const result = await dispatcher.dispatch(await followup(byId("followup_demo_05")));
    assert.equal(result.status, "call_placed");
    assert.ok(result.status === "call_placed");
    assert.equal(result.attempt_number, 1);

    const call = caller.calls.at(-1)!;
    assert.equal(call.to, "+12025550105");
    assert.equal(call.dynamicVariables.farmer_name, "Marta");
    assert.equal(call.dynamicVariables.threat_label, "coffee leaf rust");
    assert.match(String(call.dynamicVariables.symptoms), /yellow spots/);
    assert.equal(call.dynamicVariables.followup_id, "followup_demo_05");
    assert.equal(call.dynamicVariables.plot_id, "plot_demo_05");
    assert.equal(call.dynamicVariables.session_id, result.session_id);
    assert.ok(!Object.values(call.dynamicVariables).includes("+12025550105"), "the phone never reaches the model");

    const f = stored("followup_demo_05");
    assert.equal(f.status, "contacting");
    assert.equal(f.attempt_count, 1);
    assert.equal(f.call_reference, call.conversation_id);

    assert.deepEqual(await dispatcher.dispatchById("followup_demo_05"), { status: "skipped", reason: "in_progress" });
  });

  it("submit_followup: requires the secret; with all the answers it records and creates the resolution", async () => {
    const sessionId = String(caller.calls.at(-1)!.dynamicVariables.session_id);
    const body = {
      session_id: sessionId,
      followup_id: "followup_demo_05",
      conversation_id: caller.calls.at(-1)!.conversation_id,
      status_reported: "resolved",
      user_statement: "No more spots since I removed the leaves",
      actions_taken: "Removed the spotted leaves and buried them",
      action_worked: "yes",
      change_noticed_days_ago: 3,
    };
    assert.equal((await postJson("/v1/tools/submit-followup", body, null)).status, 401);
    assert.equal((await postJson("/v1/tools/submit-followup", body, "some-other-secret")).status, 401);

    const res = await postJson("/v1/tools/submit-followup", body, TOOL_SECRET);
    assert.equal(res.status, 200);
    assert.equal(res.json.registered, true);
    assert.equal(res.json.resolved, true);

    const resolution = mockState.resolutions.find((r) => r.followup_id === "followup_demo_05")!;
    assert.equal(resolution.solution_statement, "Removed the spotted leaves and buried them");
    assert.equal(resolution.resolved_at, "2026-09-30T00:00:00.000Z");
    assert.equal(stored("followup_demo_05").status, "responded");

    const replay = await postJson("/v1/tools/submit-followup", body, TOOL_SECRET);
    assert.equal(replay.json.registered, true, "repeating the tool call returns the original");
    assert.equal(mockState.resolutions.filter((r) => r.followup_id === "followup_demo_05").length, 1);

    // They answered: after the deadline the sweep doesn't record no_response.
    clock += 11 * MINUTE;
    await dispatcher.sweep();
    await writer.drain();
    assert.equal(stored("followup_demo_05").status, "responded");
  });

  it("invalid parameters → 422 with the uniform error", async () => {
    const res = await postJson("/v1/tools/submit-followup", { session_id: "s", followup_id: "f", status_reported: "fatal" }, TOOL_SECRET);
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "VALIDATION_ERROR");
  });
});

describe("if it got worse: assess_observation and submit_report", () => {
  let sessionId: string;
  let conversationId: string;

  it("submit_followup with worse schedules another follow-up and asks for an assessment", async () => {
    const created = mockState.scheduleFollowup("case_demo_06");
    const result = await dispatcher.dispatch(await followup(byId(created.id)));
    assert.ok(result.status === "call_placed");
    sessionId = result.session_id;
    conversationId = caller.calls.at(-1)!.conversation_id;

    const res = await tools.submitFollowup({
      session_id: sessionId,
      followup_id: created.id,
      conversation_id: conversationId,
      status_reported: "worse",
      user_statement: "It's worse, there are more spots",
      actions_taken: null,
      action_worked: "no",
    });
    const body = res.body as Record<string, unknown>;
    assert.equal(body.registered, true);
    assert.equal(body.next_followup_scheduled, true);
    assert.match(String(body.instruction), /assess_observation/);
  });

  it("assesses with needs, \"I don't know\" without value, guidance and a saved report", async () => {
    const first = (await tools.assessObservation({ session_id: sessionId, plot_id: "plot_demo_06", user_statement: "Now there are more spots and the leaves are falling" })).body as any;
    assert.equal(first.disposition, "ask_more");
    assert.equal(first.information_needs[0].need_code, "local_weather_perception");
    assert.ok(!("reason" in first.information_needs[0]), "the internal reasoning is never passed to the agent");

    // The model omits value when the farmer doesn't know: normalized to null/unknown.
    const weather = { need_code: "local_weather_perception", raw_text: "I don't know", unknown: true };
    const second = (await tools.assessObservation({
      session_id: sessionId,
      plot_id: "plot_demo_06",
      user_statement: "Now there are more spots and the leaves are falling",
      answers: [weather],
      asked_need_codes: ["local_weather_perception"],
    })).body as any;
    assert.equal(second.disposition, "ask_more");
    assert.equal(second.information_needs[0].need_code, "leaf_underside");

    const third = (await tools.assessObservation({
      session_id: sessionId,
      plot_id: "plot_demo_06",
      user_statement: "Now there are more spots and the leaves are falling",
      answers: [weather, { need_code: "leaf_underside", value: "orange or yellow powder", raw_text: "like an orange dust", unknown: false }],
      asked_need_codes: ["local_weather_perception", "leaf_underside"],
    })).body as any;
    assert.equal(third.disposition, "advise");
    assert.ok(third.recommendations.length > 0);
    assert.equal(third.resolved_case_mentions[0].verification, "verified");

    const saved = (await tools.submitReport({
      session_id: sessionId,
      plot_id: "plot_demo_06",
      conversation_id: conversationId,
      user_statement: "More spots, the leaves are falling, orange dust underneath",
      completeness: "sufficient",
    })).body as any;
    assert.equal(saved.registered, true);
    const report = [...mockState.reports.values()].find((r) => r.session_id === sessionId && r.assessment_id !== null);
    assert.equal(report?.assessment_id, third.assessment_id, "uses the last assessment if the model doesn't send it");
    assert.equal(report?.channel, "voice");
    assert.equal(report?.provider_reference, conversationId);
  });

  it("5-question limit: doesn't call the advisor again", async () => {
    const res = (await tools.assessObservation({
      session_id: "voice_fu_limit",
      plot_id: "plot_demo_06",
      user_statement: "spots",
      asked_need_codes: ["a", "b", "c", "d", "e"],
    })).body as any;
    assert.equal(res.disposition, "limit_reached");
  });
});

describe("retries and SMS fallback", () => {
  it("after 3 unanswered calls, sends the fallback SMS", async () => {
    const result = await dispatcher.dispatch(await followup(byId("followup_demo_06"), "no_response"));
    assert.equal(result.status, "sms");
    assert.ok(result.status === "sms" && result.result.status === "sent");
    assert.equal(sender.sent.at(-1)?.to, "+12025550106");
    assert.equal(stored("followup_demo_06").channel, "sms");
  });

  it("call with no result: no_response after the deadline, retry at 2 min via polling", async () => {
    const next = await followup((f) => f.case_id === "case_demo_06" && f.attempt_count === 0);
    const first = await dispatcher.dispatch(next);
    assert.equal(first.status, "call_placed");

    clock += 11 * MINUTE;
    await dispatcher.sweep();
    await writer.drain();
    assert.equal(stored(next.followup_id).status, "no_response");
    assert.equal(stored(next.followup_id).attempt_count, 1);
    assert.equal(mockState.cases.find((c) => c.id === "case_demo_06")?.status, "monitoring", "silence doesn't change the case");

    const callsBefore = caller.calls.length;
    await dispatcher.poll(); // the retry isn't due yet
    assert.equal(caller.calls.length, callsBefore);

    clock += 3 * MINUTE;
    const results = await dispatcher.poll();
    assert.ok(results.some((r) => r.status === "call_placed" && r.attempt_number === 2));
    assert.equal(stored(next.followup_id).attempt_count, 2);
  });

  it("without polling: a call with no result expires on the next event and doesn't block after a backend reset", async () => {
    const fresh = mockState.scheduleFollowup("case_demo_05");
    assert.equal((await dispatcher.dispatchById(fresh.id)).status, "call_placed");
    assert.deepEqual(await dispatcher.dispatchById(fresh.id), { status: "skipped", reason: "in_progress" });
    await writer.drain();

    // Member 3 resets the follow-up by hand (scheduled, 0 attempts).
    Object.assign(mockState.followups.find((f) => f.id === fresh.id)!, { status: "scheduled", attempt_count: 0, call_reference: null });
    clock += 11 * MINUTE;
    const again = await dispatcher.dispatchById(fresh.id);
    assert.equal(again.status, "call_placed");
    await writer.drain();
  });

  it("transient ElevenLabs failure: waits without recording an attempt; ambiguous: records and doesn't repeat", async () => {
    const created = mockState.scheduleFollowup("case_demo_06");
    const item = await followup(byId(created.id));

    caller.queued.push({ ok: false, kind: "rejected", code: "ELEVENLABS_503", retryable: true });
    assert.deepEqual(await dispatcher.dispatch(item), { status: "deferred", reason: "provider_backoff" });
    assert.equal(stored(created.id).attempt_count, 0);
    assert.deepEqual(await dispatcher.dispatch(item), { status: "deferred", reason: "provider_backoff" });

    clock += 3 * MINUTE;
    caller.queued.push({ ok: false, kind: "ambiguous", code: "PROVIDER_TIMEOUT", retryable: false });
    const ambiguous = await dispatcher.dispatch(item);
    assert.equal(ambiguous.status, "call_ambiguous");
    assert.equal(stored(created.id).status, "contacting");
    assert.equal(stored(created.id).call_reference, null);
  });
});

describe("followup.due event over HTTP (PROPOSED)", () => {
  function event(followupId: string, eventId: string) {
    return {
      event_id: eventId,
      schema_version: "2.0",
      event_type: "followup.due",
      occurred_at: new Date(clock).toISOString(),
      aggregate_id: followupId,
      aggregate_version: 1,
      correlation_id: null,
      is_demo: true,
      payload: { followup_id: followupId },
    };
  }

  it("token, validation and deduplication by event_id", async () => {
    const created = mockState.scheduleFollowup("case_demo_06");
    const path = `/v1/followups/${created.id}/dispatch`;

    assert.equal((await postJson(path, event(created.id, "evt_1"), null)).status, 401);
    assert.equal((await postJson(path, event("another_followup", "evt_1"), COMMS_TOKEN)).status, 422);

    const first = await postJson(path, event(created.id, "evt_1"), COMMS_TOKEN);
    assert.equal(first.status, 202);
    assert.equal(first.json.result.status, "call_placed");
    const calls = caller.calls.length;

    const replay = await postJson(path, event(created.id, "evt_1"), COMMS_TOKEN);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);
    assert.equal(caller.calls.length, calls, "a repeated event doesn't call again");
  });
});

describe("DEMO_IGNORE_ALLOWED_HOURS in the dispatcher", () => {
  it("outside allowed hours: without the option it waits; with the option (demo) it calls", async () => {
    const created = mockState.scheduleFollowup("case_demo_06");
    const listed = await followup(byId(created.id));
    // Contact hours already over at this time (17:xx in Mexico).
    const item = { ...listed, contact: { ...listed.contact, allowed_hours: { start: "06:00", end: "07:00" } } };
    assert.deepEqual(await dispatcher.dispatch(item), { status: "deferred", reason: "outside_hours" });

    const nightly = new FollowupDispatcher({
      client,
      writer,
      caller,
      followupSms,
      isDemo: true,
      demoAllowlist: new Set(["+12025550106"]),
      ignoreAllowedHours: true,
      callAttempts: 3,
      callResultTimeoutMs: 10 * MINUTE,
      placementBackoffMs: 2 * MINUTE,
      now: () => new Date(clock),
    });
    const result = await nightly.dispatch(item);
    assert.equal(result.status, "call_placed");
  });
});
