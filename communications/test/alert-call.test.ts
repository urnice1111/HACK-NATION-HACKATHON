/**
 * Alert calls (demo step 6): approved alert → queued voice notification → call with the
 * Alerts agent → `acknowledge_alert` → `delivered`. Against the /v1 mock, with the stub caller.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
process.env.LOG_SILENT = "1";

import { ALERT_DYNAMIC_VARIABLES, AlertDispatcher } from "../src/alerts/dispatcher.ts";
import { BackendClient } from "../src/backend/client.ts";
import { BackendWriter } from "../src/backend/writer.ts";
import { SCHEMA_VERSION } from "../src/contracts/index.ts";
import { StubOutboundCaller, type DynamicVariables, type PlaceCallResult } from "../src/elevenlabs/outbound.ts";
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
const ROSA = "+12025550101";
const ERNESTO = "+12025550104";
const ROSA_ALERT = "notification_demo_01";
const NOON_LOCAL = Date.parse("2026-10-04T18:00:00Z"); // 12:00 in America/Mexico_City

const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Records the notification's status in the backend at the moment each call is placed. */
class ObservedCaller extends StubOutboundCaller {
  readonly statusWhenDialing: string[] = [];
  state!: MockState;

  override placeCall(input: { to: string; dynamicVariables: DynamicVariables }): Promise<PlaceCallResult> {
    const id = String(input.dynamicVariables.notification_id);
    this.statusWhenDialing.push(this.state.notifications.find((n) => n.id === id)!.status);
    return super.placeCall(input);
  }
}

/** A fresh mock and dispatcher per test: every test starts from the fixtures. */
async function setup({ allowlist = [ROSA, ERNESTO], at = NOON_LOCAL } = {}) {
  const clock = { now: at };
  const now = () => new Date(clock.now);
  const mock = createMockBackend({ serviceToken: SERVICE_TOKEN, now });
  const mockUrl = await listen(mock.server);
  const client = new BackendClient({ baseUrl: mockUrl, serviceToken: SERVICE_TOKEN, timeoutMs: 2000 });
  const writer = new BackendWriter(client, [20, 50]);
  const caller = new ObservedCaller();
  caller.state = mock.state;
  const dispatcher = new AlertDispatcher({
    client,
    writer,
    caller,
    isDemo: true,
    demoAllowlist: new Set(allowlist),
    callAttempts: 3,
    callResultTimeoutMs: 2 * MINUTE,
    now,
  });
  const tools = new VoiceTools({ client, writer, isDemo: true, defaultLanguage: "en", alerts: dispatcher, now });
  const store: SessionStore = new Map();
  const followups = new FollowupSmsFlow({ client, writer, store, sender: new StubSmsSender(), isDemo: true, demoAllowlist: new Set(), replyWindowMs: MINUTE, now });
  const commsUrl = await listen(
    createCommsServer({
      publicBaseUrl: "https://comms.example.test",
      twilioAuthToken: "twilio-token",
      twilioPhoneNumber: "+12025550999",
      conversation: new SmsConversation({ client, store, writer, followups, isDemo: true, defaultLanguage: "en", idleMs: MINUTE, now }),
      voiceTools: tools,
      toolSecret: TOOL_SECRET,
    }),
  );

  async function acknowledge(body: Record<string, unknown>, token: string | null = TOOL_SECRET) {
    const res = await fetch(`${commsUrl}/v1/tools/acknowledge-alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  const stored = (id: string) => mock.state.notifications.find((n) => n.id === id)!;
  return { clock, mockUrl, client, writer, caller, dispatcher, tools, state: mock.state, stored, acknowledge };
}

describe("alert calls: who gets called", () => {
  it("without alert permission it is cancelled (NO_CONSENT) and nobody is called", async () => {
    const t = await setup();
    const results = await t.dispatcher.poll();
    assert.ok(results.some((r) => r.status === "cancelled" && r.reason === "NO_CONSENT"));
    assert.equal(t.stored("notification_demo_04").status, "cancelled");
    assert.equal(t.stored("notification_demo_04").last_error, "NO_CONSENT");
    assert.equal(t.stored("notification_demo_04").attempt_count, 0, "no attempt was counted");
    assert.deepEqual(t.caller.calls.map((c) => c.to), [ROSA], "only Rosa, who allows alerts, is called");
  });

  it("a number outside the demo allowlist is cancelled (NOT_ALLOWLISTED)", async () => {
    const t = await setup({ allowlist: [] });
    await t.dispatcher.poll();
    assert.equal(t.stored(ROSA_ALERT).status, "cancelled");
    assert.equal(t.stored(ROSA_ALERT).last_error, "NOT_ALLOWLISTED");
    assert.equal(t.caller.calls.length, 0);
  });

  it("outside allowed hours it stays queued and goes out once they open", async () => {
    const t = await setup({ at: Date.parse("2026-10-04T09:00:00Z") }); // 03:00 local
    const results = await t.dispatcher.poll();
    assert.ok(results.some((r) => r.status === "waiting" && r.reason === "outside_hours"));
    assert.equal(t.stored(ROSA_ALERT).status, "queued");
    assert.equal(t.stored(ROSA_ALERT).attempt_count, 0);
    assert.equal(t.caller.calls.length, 0);

    t.clock.now = NOON_LOCAL;
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 1);
    assert.equal(t.stored(ROSA_ALERT).status, "accepted");
  });
});

describe("alert calls: delivery", () => {
  it("reports sending before dialing, accepted after, and delivered only when the farmer confirms", async () => {
    const t = await setup();
    const results = await t.dispatcher.poll();
    const placed = results.find((r) => r.status === "call_placed");
    assert.ok(placed?.status === "call_placed");
    assert.equal(placed.attempt_number, 1);
    assert.deepEqual(t.caller.statusWhenDialing, ["sending"], "the backend already had the attempt when the phone rang");

    const call = t.caller.calls[0]!;
    assert.deepEqual(Object.keys(call.dynamicVariables).sort(), [...ALERT_DYNAMIC_VARIABLES].sort());
    assert.equal(call.dynamicVariables.farmer_name, "Rosa");
    assert.equal(call.dynamicVariables.plot_label, "Plot 1");
    assert.match(String(call.dynamicVariables.alert_message), /^Coffee leaf rust was reported on farms near your plot/);
    assert.equal(call.dynamicVariables.notification_id, ROSA_ALERT);
    assert.equal(call.dynamicVariables.session_id, placed.session_id);
    assert.ok(!Object.values(call.dynamicVariables).includes(ROSA), "the model never sees the phone");

    const accepted = t.stored(ROSA_ALERT);
    assert.equal(accepted.status, "accepted", "a connected call is not delivered");
    assert.equal(accepted.attempt_count, 1);
    assert.equal(accepted.provider_reference, call.conversation_id);

    const ack = { session_id: placed.session_id, notification_id: ROSA_ALERT, conversation_id: call.conversation_id, outcome: "heard" };
    assert.equal((await t.acknowledge(ack, null)).status, 401);
    assert.equal((await t.acknowledge(ack, "wrong-secret-0123456789")).status, 401);

    const reply = await t.acknowledge(ack);
    assert.equal(reply.status, 200);
    assert.equal(reply.json.registered, true);
    assert.match(reply.json.instruction, /help line/);
    assert.equal(t.stored(ROSA_ALERT).status, "delivered");

    // The model repeating the tool doesn't write again (a new occurred_at with the same key would be a 409).
    assert.deepEqual((await t.acknowledge(ack)).json, reply.json);
    t.clock.now += 30 * MINUTE;
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 1, "a delivered alert is never called again");
  });

  it("without acknowledgement: up to 3 attempts 2 minutes apart, then failed NO_ANSWER", async () => {
    const t = await setup();
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 1);

    t.clock.now += MINUTE;
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 1, "still within the call-result timeout");

    t.clock.now += MINUTE;
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 2);
    assert.equal(t.stored(ROSA_ALERT).attempt_count, 2);
    assert.equal(t.caller.calls[1]!.dynamicVariables.notification_id, ROSA_ALERT);
    assert.notEqual(t.caller.calls[1]!.dynamicVariables.session_id, t.caller.calls[0]!.dynamicVariables.session_id, "a new session per attempt");

    t.clock.now += 2 * MINUTE;
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 3);
    assert.deepEqual(t.caller.statusWhenDialing, ["sending", "sending", "sending"]);

    t.clock.now += 2 * MINUTE;
    const results = await t.dispatcher.poll();
    assert.ok(results.some((r) => r.status === "failed" && r.reason === "NO_ANSWER"));
    assert.equal(t.stored(ROSA_ALERT).status, "failed");
    assert.equal(t.stored(ROSA_ALERT).last_error, "NO_ANSWER");
    assert.equal(t.stored(ROSA_ALERT).attempt_count, 3);

    t.clock.now += 10 * MINUTE;
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 3, "no fourth attempt");
  });

  it("ambiguous ElevenLabs timeout: unknown and never redialed; a late acknowledgement still delivers it", async () => {
    const t = await setup();
    t.caller.queued.push({ ok: false, kind: "ambiguous", code: "PROVIDER_TIMEOUT", retryable: false });
    const results = await t.dispatcher.poll();
    const ambiguous = results.find((r) => r.status === "call_ambiguous");
    assert.ok(ambiguous?.status === "call_ambiguous");
    assert.equal(t.stored(ROSA_ALERT).status, "unknown");
    assert.equal(t.stored(ROSA_ALERT).last_error, "PROVIDER_TIMEOUT");
    assert.equal(t.stored(ROSA_ALERT).attempt_count, 1);

    t.clock.now += 10 * MINUTE;
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 0, "never redials blindly");
    assert.equal(t.stored(ROSA_ALERT).status, "unknown");

    // The call had gone out after all and the farmer confirmed.
    const reply = await t.tools.acknowledgeAlert({ session_id: ambiguous.session_id, notification_id: ROSA_ALERT, outcome: "heard" });
    assert.equal((reply.body as { registered: boolean }).registered, true);
    assert.equal(t.stored(ROSA_ALERT).status, "delivered");
  });

  it("someone else answered: failed WRONG_PERSON, the alert is not read and not called again", async () => {
    const t = await setup();
    const [placed] = (await t.dispatcher.poll()).filter((r) => r.status === "call_placed");
    assert.ok(placed?.status === "call_placed");

    const reply = await t.acknowledge({ session_id: placed.session_id, notification_id: ROSA_ALERT, outcome: "wrong_person" });
    assert.equal(reply.json.registered, true);
    assert.match(reply.json.instruction, /Don't read the alert/);
    assert.doesNotMatch(reply.json.instruction, /help line/);
    assert.equal(t.stored(ROSA_ALERT).status, "failed");
    assert.equal(t.stored(ROSA_ALERT).last_error, "WRONG_PERSON");

    t.clock.now += 10 * MINUTE;
    await t.dispatcher.poll();
    assert.equal(t.caller.calls.length, 1);
  });

  it("an ElevenLabs rejection fails the notification with the provider's code", async () => {
    const t = await setup();
    t.caller.queued.push({ ok: false, kind: "rejected", code: "ELEVENLABS_422", retryable: false });
    const results = await t.dispatcher.poll();
    assert.ok(results.some((r) => r.status === "failed" && r.reason === "PROVIDER_REJECTED" && r.code === "ELEVENLABS_422"));
    assert.equal(t.stored(ROSA_ALERT).status, "failed");
    assert.equal(t.stored(ROSA_ALERT).last_error, "ELEVENLABS_422");
  });

  it("a dispatch interrupted in sending becomes unknown instead of being redialed", async () => {
    const t = await setup();
    Object.assign(t.stored(ROSA_ALERT), { status: "sending", attempt_count: 1, updated_at: new Date(NOON_LOCAL - 5 * MINUTE).toISOString() });
    const results = await t.dispatcher.poll();
    assert.ok(results.some((r) => r.status === "unknown" && r.reason === "SENDING_INTERRUPTED"));
    assert.equal(t.stored(ROSA_ALERT).status, "unknown");
    assert.equal(t.caller.calls.length, 0);
  });
});

describe("alert calls: terminal states", () => {
  it("a terminal notification keeps its status: later updates answer applied false and the tool doesn't claim a record", async () => {
    const t = await setup();
    const [placed] = (await t.dispatcher.poll()).filter((r) => r.status === "call_placed");
    assert.ok(placed?.status === "call_placed");
    assert.equal((await t.acknowledge({ session_id: placed.session_id, notification_id: ROSA_ALERT, outcome: "heard" })).json.registered, true);

    // Another session (e.g. a late second attempt) says someone else answered: delivered stays.
    const late = await t.acknowledge({ session_id: "voice_alert_other", notification_id: ROSA_ALERT, outcome: "wrong_person" });
    assert.equal(late.json.registered, false);
    assert.match(late.json.instruction, /already closed/);
    assert.equal(t.stored(ROSA_ALERT).status, "delivered");

    // Directly against the route: no status change, no new attempt, same key → replay, other body → 409.
    const body = { schema_version: SCHEMA_VERSION, status: "sending" as const, provider_reference: null, error_code: null, occurred_at: new Date(t.clock.now).toISOString(), is_demo: true };
    const first = await t.client.updateNotificationStatus(ROSA_ALERT, body, "late-sending");
    assert.ok(first.ok);
    assert.equal(first.data.applied, false);
    assert.equal(first.data.status, "delivered");
    assert.equal(first.data.attempt_count, 1);
    const replay = await t.client.updateNotificationStatus(ROSA_ALERT, body, "late-sending");
    assert.ok(replay.ok && replay.replayed);
    const conflict = await t.client.updateNotificationStatus(ROSA_ALERT, { ...body, status: "failed", error_code: "X" }, "late-sending");
    assert.ok(!conflict.ok);
    assert.equal(conflict.code, "IDEMPOTENCY_KEY_REUSED");
  });

  it("the list only returns what was asked for and the route validates its input", async () => {
    const t = await setup();
    const queued = await t.client.listNotifications("queued");
    assert.ok(queued.ok);
    assert.deepEqual(queued.data.notifications.map((n) => n.notification_id), [ROSA_ALERT, "notification_demo_04"]);
    assert.equal(queued.data.notifications[0]!.contact.notification_consent, true);
    assert.equal(queued.data.notifications[1]!.contact.notification_consent, false);
    const delivered = await t.client.listNotifications("delivered");
    assert.ok(delivered.ok);
    assert.equal(delivered.data.notifications.length, 0);

    const missingKey = await fetch(`${t.mockUrl}/v1/notifications/${ROSA_ALERT}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_TOKEN}` },
      body: JSON.stringify({}),
    });
    assert.equal(missingKey.status, 422);
    const unknown = await t.client.updateNotificationStatus("notification_nope", { schema_version: SCHEMA_VERSION, status: "sending", provider_reference: null, error_code: null, occurred_at: new Date(t.clock.now).toISOString(), is_demo: true }, "k1");
    assert.ok(!unknown.ok);
    assert.equal(unknown.status, 404);
  });
});
