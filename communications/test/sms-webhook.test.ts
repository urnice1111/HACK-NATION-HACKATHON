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
/** Mock scenario injected into calls whose path matches. */
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
    defaultLanguage: "en",
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

/** Sends an SMS like Twilio: form-encoded and signed with the public URL. */
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

describe("SMS webhook: security", () => {
  it("invalid signature → 403 and no backend call", async () => {
    const before = mockState.reports.size;
    const res = await sendSms("+12025550101", "spots", { signature: "fake-signature" });
    assert.equal(res.status, 403);
    assert.match(res.text, /INVALID_SIGNATURE/);
    assert.equal(mockState.reports.size, before);
  });

  it("SMS addressed to another number → ignored without a reply", async () => {
    const res = await sendSms("+12025550101", "hi", { to: "+12025550000" });
    assert.equal(res.status, 200);
    assert.equal(res.reply, null);
  });
});

describe("SMS webhook: conversation", () => {
  it("known number: confirms identity, asks for consent, asks questions and records the report", async () => {
    const phone = "+12025550101";
    const first = await sendSms(phone, "I have spots on my coffee leaves");
    assert.equal(first.reply, sms.identify(["Rosa"]));

    // Report permission already granted: only this report is confirmed.
    assert.equal((await sendSms(phone, "1")).reply, sms.confirmReport);

    // The advisor returns two needs; one is asked per turn, highest priority first.
    const weather = await sendSms(phone, "Y");
    assert.match(weather.reply!, /weather/);
    assert.equal(reportsFrom(first.sid).length, 0, "nothing is saved before finishing");

    const leaf = await sendSms(phone, "It has rained a lot");
    assert.match(leaf.reply!, /underside of the leaves/);
    assert.match(leaf.reply!, /1 orange or yellow powder/);

    const closing = await sendSms(phone, "1");
    assert.match(closing.reply!, /doesn't confirm any disease/);
    assert.match(closing.reply!, /bury them/);
    assert.match(closing.reply!, /a technician confirmed/, "mentions the verified resolved case");
    assert.ok(closing.reply!.endsWith(sms.saved));

    const [report] = reportsFrom(first.sid);
    assert.ok(report);
    assert.equal(report.channel, "sms");
    assert.equal(report.plot_id, "plot_demo_01");
    assert.equal(report.completeness, "sufficient");
    assert.equal(report.observed_at, null);
    assert.match(report.user_statement, /spots[\s\S]*rained/);
    assert.ok(report.assessment_id);
  });

  it("duplicate webhook: same reply and a single report", async () => {
    const phone = "+12025550105";
    const first = await sendSms(phone, "I see leaves with brown spots");
    await sendSms(phone, "1");
    await sendSms(phone, "yes");
    await sendSms(phone, "dont know");
    const last = await sendSms(phone, "orange powder underneath");
    const duplicate = await sendSms(phone, "orange powder underneath", { sid: last.sid });
    assert.equal(duplicate.text, last.text);
    assert.equal(reportsFrom(first.sid).length, 1);
  });

  it("shared phone: names only before confirming; uses the chosen person's plot", async () => {
    const phone = "+12025550102";
    const first = await sendSms(phone, "hi");
    assert.equal(first.reply, sms.identify(["Tomás", "Lucía"]));
    assert.doesNotMatch(first.reply!, /Plot|plot_/);

    await sendSms(phone, "2");
    await sendSms(phone, "yes");
    assert.match((await sendSms(phone, "there are spots on many plants")).reply!, /weather/);
    assert.match((await sendSms(phone, "I don't know")).reply!, /underside/);
    await sendSms(phone, "yellow powder");
    assert.equal(reportsFrom(first.sid)[0]?.plot_id, "plot_demo_03");
  });

  it("unknown number: minimal record without a plot", async () => {
    const phone = "+12025550177";
    const first = await sendSms(phone, "My plants are drying out");
    assert.equal(first.reply, `${sms.unknownNumber} ${sms.consent}`);
    const closing = await sendSms(phone, "y");
    assert.equal(closing.reply, sms.savedUnknown);
    const [report] = reportsFrom(first.sid);
    assert.equal(report?.plot_id, null);
    assert.equal(report?.case_id, null);
  });

  it("says they are not the candidate: no plot is picked", async () => {
    const phone = "+12025550106";
    const first = await sendSms(phone, "There are pests in the coffee field");
    assert.equal((await sendSms(phone, "0")).reply, sms.consent);
    await sendSms(phone, "yes");
    assert.equal(reportsFrom(first.sid)[0]?.plot_id, null);
  });

  it("nothing is saved without consent", async () => {
    const phone = "+12025550107";
    const first = await sendSms(phone, "spots on leaves");
    await sendSms(phone, "1");
    assert.equal((await sendSms(phone, "NO")).reply, sms.consentDeclined);
    assert.equal(reportsFrom(first.sid).length, 0);
  });

  it("\"I don't know\" is treated as unknown: the advisor keeps asking", async () => {
    const phone = "+12025550104";
    const first = await sendSms(phone, "spots on the leaves");
    await sendSms(phone, "1");
    await sendSms(phone, "yes"); // weather question
    await sendSms(phone, "no idea"); // leaf underside question
    const next = await sendSms(phone, "5"); // "don't know" option
    assert.match(next.reply!, /color and shape are the spots/);
    const closing = await sendSms(phone, "1");
    assert.ok(closing.reply!.endsWith(sms.saved));
    assert.equal(reportsFrom(first.sid)[0]?.completeness, "sufficient");
  });

  it("first time: asks for the three permissions separately and saves them", async () => {
    const phone = "+12025550108";
    const first = await sendSms(phone, "spots on leaves");
    assert.equal(first.reply, sms.identify(["Raúl"]));
    assert.equal((await sendSms(phone, "1")).reply, sms.consent);
    assert.equal((await sendSms(phone, "y")).reply, sms.consentNotifications);
    assert.equal((await sendSms(phone, "n")).reply, sms.consentFollowupCalls);
    const closing = await sendSms(phone, "yes"); // plot without context: the advisor refers
    assert.ok(closing.reply!.startsWith(sms.refer));
    assert.ok(closing.reply!.endsWith(sms.saved));

    await writer.drain();
    const contact = mockState.contacts.find((c) => c.id === "contact_demo_08")!;
    assert.equal(contact.report_consent, true);
    assert.equal(contact.notification_consent, false);
    assert.equal(contact.followup_call_consent, true);
    assert.ok(contact.consent_at);
  });

  it("STOP: no reply (Twilio answers) but revokes in the backend", async () => {
    const res = await sendSms("+12025550108", "STOP");
    assert.equal(res.reply, null);
    await writer.drain();
    const contact = mockState.contacts.find((c) => c.id === "contact_demo_08")!;
    assert.equal(contact.followup_call_consent, false);
    assert.equal(contact.notification_consent, false);
  });
});

describe("SMS webhook: ALERTS OFF", () => {
  it("revokes alerts and follow-ups, not the permission to report", async () => {
    const res = await sendSms("+12025550102", "Alerts off");
    assert.equal(res.reply, sms.optedOut);
    const contact = mockState.contacts.find((c) => c.id === "contact_demo_02")!;
    assert.equal(contact.notification_consent, false);
    assert.equal(contact.followup_call_consent, false);
    assert.equal(contact.report_consent, true);
  });

  it("halfway through a report: saves what was received as partial and confirms the opt-out", async () => {
    const phone = "+12025550101";
    const first = await sendSms(phone, "spots in the coffee field");
    await sendSms(phone, "1");
    await sendSms(phone, "yes"); // weather question
    const res = await sendSms(phone, "ALERTS OFF");
    assert.equal(res.reply, sms.optedOut);
    assert.equal(reportsFrom(first.sid)[0]?.completeness, "partial");
  });

  it("backend down: doesn't claim the opt-out and retries it", async () => {
    scenario = { path: /\/v1\/consents\/revocations$/, value: "backend_unavailable" };
    const res = await sendSms("+12025550104", "alerts off");
    assert.equal(res.reply, sms.optOutPending);
    scenario = null;
    await writer.drain();
    assert.equal(mockState.contacts.find((c) => c.id === "contact_demo_04")!.notification_consent, false);
  });
});

describe("SMS webhook: failures", () => {
  it("advisor down: says so and saves the report without an assessment", async () => {
    const phone = "+12025550104";
    const first = await sendSms(phone, "spots on the leaves");
    await sendSms(phone, "1");
    scenario = { path: /\/v1\/assessments$/, value: "advisor_unavailable" };
    const closing = await sendSms(phone, "yes");
    assert.equal(closing.reply, `${sms.advisorFailed} ${sms.saved}`);
    const [report] = reportsFrom(first.sid);
    assert.equal(report?.assessment_id, null);
    assert.equal(report?.completeness, "partial");
  });

  it("backend doesn't save: doesn't claim it was recorded and retries with the same key", async () => {
    const phone = "+12025550101";
    const first = await sendSms(phone, "spots again");
    await sendSms(phone, "1");
    await sendSms(phone, "yes");
    await sendSms(phone, "it rained");
    scenario = { path: /\/v1\/reports$/, value: "backend_unavailable" };
    const closing = await sendSms(phone, "yellow powder");
    assert.ok(closing.reply!.endsWith(sms.notConfirmed));
    assert.doesNotMatch(closing.reply!, /has been recorded\.$/);
    assert.equal(reportsFrom(first.sid).length, 0);

    scenario = null; // the backend recovers before the retry
    await writer.drain();
    assert.equal(reportsFrom(first.sid).length, 1);
  });

  it("abandoned conversation: saves what was received as partial", async () => {
    const phone = "+12025550105";
    const first = await sendSms(phone, "the leaves have spots");
    await sendSms(phone, "1");
    await sendSms(phone, "yes"); // left waiting for the advisor answer
    clock += 31 * 60 * 1000;
    await conversation.sweep();
    const [report] = reportsFrom(first.sid);
    assert.equal(report?.completeness, "partial");
  });
});

describe("SMS follow-up (fallback)", () => {
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

  it("doesn't send without consent, outside allowed hours or to numbers outside the allowlist", async () => {
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

  it("doesn't step on an ongoing conversation", async () => {
    const item = await dueFollowup("followup_demo_05");
    await sendSms("+12025550105", "I see spots");
    assert.deepEqual(await followups.start(item), { status: "skipped", reason: "busy" });
    await sendSms("+12025550105", "0");
    await sendSms("+12025550105", "no"); // closes the conversation without saving anything
  });

  it("resolved: the replies are saved as a follow-up and create a resolution", async () => {
    const item = await dueFollowup("followup_demo_05");
    const started = await followups.start(item);
    assert.equal(started.status, "sent");
    const outbound = sender.sent.at(-1)!;
    assert.equal(outbound.to, "+12025550105");
    assert.equal(outbound.body, sms.followupIntro("Marta"));

    assert.equal((await sendSms("+12025550105", "4")).reply, sms.followupActions);
    assert.equal((await sendSms("+12025550105", "I removed the leaves and buried them")).reply, sms.followupWorked);
    assert.equal((await sendSms("+12025550105", "1")).reply, sms.followupSaved("resolved"));

    assert.equal(mockState.followups.find((f) => f.id === "followup_demo_05")?.status, "responded");
    assert.equal(mockState.cases.find((c) => c.id === "case_demo_05")?.status, "resolved");
    const resolution = mockState.resolutions.find((r) => r.followup_id === "followup_demo_05");
    assert.equal(resolution?.solution_statement, "I removed the leaves and buried them");
    assert.equal(resolution?.verification, "farmer_reported");
  });

  it("no reply within the window: records no_response and never a resolution", async () => {
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
