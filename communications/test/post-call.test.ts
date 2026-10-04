/**
 * ElevenLabs post-call webhook (`/v1/webhooks/elevenlabs/post-call`): verified with ElevenLabs' HMAC,
 * it closes the call in communications right away instead of waiting for the idle sweeps.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
process.env.LOG_SILENT = "1";

import { BackendClient } from "../src/backend/client.ts";
import { BackendWriter } from "../src/backend/writer.ts";
import { StubOutboundCaller } from "../src/elevenlabs/outbound.ts";
import { signElevenLabsBody } from "../src/elevenlabs/webhook.ts";
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
const WEBHOOK_SECRET = "wsec_test_0123456789abcdef";
const MINUTE = 60 * 1000;

const clock = Date.parse("2026-10-03T23:00:00Z");
let mockState: MockState;
let writer: BackendWriter;
let client: BackendClient;
let dispatcher: FollowupDispatcher;
let commsUrl: string;
const caller = new StubOutboundCaller();
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
  const now = () => new Date(clock);
  const tools = new VoiceTools({ client, writer, isDemo: true, defaultLanguage: "en", idleMs: 15 * MINUTE, now });
  const store: SessionStore = new Map();
  const followups = new FollowupSmsFlow({ client, writer, store, sender: new StubSmsSender(), isDemo: true, demoAllowlist: new Set(), replyWindowMs: MINUTE, now });
  dispatcher = new FollowupDispatcher({
    client,
    writer,
    caller,
    followupSms: followups,
    isDemo: true,
    demoAllowlist: new Set(["+12025550105"]),
    ignoreAllowedHours: true,
    callAttempts: 3,
    callResultTimeoutMs: 10 * MINUTE,
    placementBackoffMs: 2 * MINUTE,
    now,
  });
  const conversation = new SmsConversation({ client, store, writer, followups, isDemo: true, defaultLanguage: "en", idleMs: 30 * MINUTE, now });
  commsUrl = await listen(
    createCommsServer({
      publicBaseUrl: "https://comms.example.test",
      twilioAuthToken: "twilio-token",
      twilioPhoneNumber: "+12025550999",
      conversation,
      voiceTools: tools,
      toolSecret: TOOL_SECRET,
      dispatcher,
      elevenlabsWebhookSecret: WEBHOOK_SECRET,
    }),
  );
});

after(async () => {
  await writer.drain();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function tool(sessionId: string, path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${commsUrl}/v1/tools/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOOL_SECRET}` },
    body: JSON.stringify({ session_id: sessionId, ...body }),
  });
  return (await res.json()) as Record<string, any>;
}

async function postCall(conversationId: string, opts: { signature?: string; type?: string } = {}) {
  const raw = JSON.stringify({ type: opts.type ?? "post_call_transcription", event_timestamp: 1, data: { conversation_id: conversationId, agent_id: "agent_x", transcript: [] } });
  const res = await fetch(`${commsUrl}/v1/webhooks/elevenlabs/post-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ElevenLabs-Signature": opts.signature ?? signElevenLabsBody(WEBHOOK_SECRET, raw) },
    body: raw,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** The webhook answers before closing the call: wait for the background work. */
async function eventually(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  await writer.drain();
  assert.ok(check());
}

const reportsOf = (sessionId: string) => [...mockState.reports.values()].filter((r) => r.session_id === sessionId);

describe("ElevenLabs post-call webhook", () => {
  it("rejects a missing or wrong signature", async () => {
    assert.equal((await postCall("conv_x", { signature: "" })).status, 401);
    assert.equal((await postCall("conv_x", { signature: signElevenLabsBody("other-secret-0123456789", "{}") })).status, 401);
    const old = Date.parse("2026-01-01T00:00:00Z");
    const raw = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_x" } });
    assert.equal((await postCall("conv_x", { signature: signElevenLabsBody(WEBHOOK_SECRET, raw, old) })).status, 401, "old timestamp");
  });

  it("help call that ended without submit_report: saves the evaluated report once", async () => {
    const conv = "conv_ended_help_1";
    await tool(conv, "resolve-farmer", { caller_phone: "+12025550101" });
    await tool(conv, "confirm-farmer", { candidate_number: 1 });
    await tool(conv, "get-plot-context");
    const first = await tool(conv, "assess-observation", { user_statement: "I see orange powder under the leaves", symptoms: ["orange powder"] });
    const advice = await tool(conv, "assess-observation", {
      user_statement: "I see orange powder under the leaves",
      answers: [{ need_code: "leaf_underside", value: "orange or yellow powder", raw_text: "orange powder", unknown: false }],
      asked_need_codes: first.information_needs.map((n: { need_code: string }) => n.need_code),
    });
    assert.equal(advice.disposition, "advise");
    assert.equal(reportsOf(conv).length, 0, "the model hung up without submit_report");

    const res = await postCall(conv);
    assert.deepEqual([res.status, res.json.replayed], [200, false]);
    await eventually(() => reportsOf(conv).length === 1);
    const [report] = reportsOf(conv);
    assert.equal(report?.completeness, "sufficient", "the evaluation had finished (advise)");
    assert.equal(report?.plot_id, "plot_demo_01");
    assert.equal(report?.assessment_id, advice.assessment_id);

    assert.equal((await postCall(conv)).json.replayed, true);
    await writer.drain();
    assert.equal(reportsOf(conv).length, 1, "a retried webhook does not save twice");
  });

  it("does not save when the farmer declined or a report was already submitted", async () => {
    const declined = "conv_ended_declined";
    await tool(declined, "resolve-farmer", { caller_phone: "+12025550107" });
    await tool(declined, "confirm-farmer", { candidate_number: 1 });
    await tool(declined, "record-consent", { reports: false });
    await postCall(declined);
    await writer.drain();
    assert.equal(reportsOf(declined).length, 0);

    const saved = "conv_ended_saved";
    await tool(saved, "resolve-farmer", { caller_phone: "+12025550101" });
    await tool(saved, "confirm-farmer", { candidate_number: 1 });
    await tool(saved, "get-plot-context");
    await tool(saved, "assess-observation", { user_statement: "spots" });
    await tool(saved, "submit-report", { user_statement: "spots", completeness: "partial" });
    await postCall(saved);
    await writer.drain();
    assert.equal(reportsOf(saved).length, 1);
  });

  it("follow-up call that ended without submit_followup: records no_response now", async () => {
    const list = await client.listFollowups("scheduled");
    assert.ok(list.ok);
    const item = list.data.followups.find((f) => f.followup_id === "followup_demo_05")!;
    const placed = await dispatcher.dispatch(item);
    assert.equal(placed.status, "call_placed");
    await writer.drain();
    const conversationId = placed.status === "call_placed" ? placed.conversation_id! : "";

    await postCall(conversationId);
    await eventually(() => mockState.followups.find((f) => f.id === "followup_demo_05")?.status === "no_response");
    assert.equal(mockState.cases.find((c) => c.id === "case_demo_05")?.status, "suspected", "silence never changes the case");
  });
});
