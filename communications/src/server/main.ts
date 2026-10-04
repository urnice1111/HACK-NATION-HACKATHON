import { AlertDispatcher } from "../alerts/dispatcher.ts";
import { BackendClient } from "../backend/client.ts";
import { BackendWriter } from "../backend/writer.ts";
import { loadConfig } from "../config.ts";
import { checkAgents, ElevenLabsAgentsApi, phonesFromEnv } from "../elevenlabs/agents.ts";
import { ElevenLabsOutboundCaller, StubOutboundCaller } from "../elevenlabs/outbound.ts";
import { FollowupDispatcher } from "../followups/dispatcher.ts";
import { VoiceTools } from "../tools/voice-tools.ts";
import { log } from "../http/log.ts";
import { SmsConversation } from "../sms/conversation.ts";
import { FollowupSmsFlow } from "../sms/followup.ts";
import type { SessionStore } from "../sms/session.ts";
import { StubSmsSender, TwilioSmsSender } from "../twilio/sender.ts";
import { createCommsServer } from "./app.ts";

const config = loadConfig();
const phones = phonesFromEnv((name) => config[name as keyof typeof config] as string | null);

// The agents live in the ElevenLabs account: check they are configured the way this code expects.
if (config.ELEVENLABS_API_KEY) {
  const check = await checkAgents(new ElevenLabsAgentsApi(config.ELEVENLABS_API_KEY), {
    helpAgentId: config.ELEVENLABS_HELP_AGENT_ID,
    followupAgentId: config.ELEVENLABS_FOLLOWUP_AGENT_ID,
    alertAgentId: config.ELEVENLABS_ALERT_AGENT_ID,
    phones,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  });
  for (const problem of check.problems) log("error", "elevenlabs_agent_misconfigured", { problem });
  for (const detail of check.unreachable) log("warn", "elevenlabs_agents_unreachable", { detail });
  if (check.problems.length === 0 && check.unreachable.length === 0) log("info", "elevenlabs_agents_ok", { agents: Object.keys(check.agents) });
  // In production, never start with a misconfigured agent (fix it in the dashboard and rerun npm run agents:check).
  if (!config.IS_DEMO && check.problems.length > 0) process.exit(1);
}

// Short timeout: the SMS webhook makes at most two calls and Twilio gives up after 15 s.
const client = new BackendClient({
  baseUrl: config.BACKEND_BASE_URL,
  advisorBaseUrl: config.ADVISOR_BASE_URL,
  serviceToken: config.BACKEND_SERVICE_TOKEN,
  timeoutMs: config.SMS_STEP_TIMEOUT_MS,
  advisorTimeoutMs: config.ADVISOR_TIMEOUT_MS,
});
const writer = new BackendWriter(client, config.REPORT_RETRY_DELAYS_MS);
const store: SessionStore = new Map();
const sender = config.TWILIO_ACCOUNT_SID
  ? new TwilioSmsSender({
      accountSid: config.TWILIO_ACCOUNT_SID,
      authToken: config.TWILIO_AUTH_TOKEN,
      from: config.TWILIO_PHONE_NUMBER,
      // The status webhook arrives in phase 6; until then no callback is requested.
      statusCallbackUrl: null,
    })
  : new StubSmsSender();
const followups = new FollowupSmsFlow({
  client,
  writer,
  store,
  sender,
  isDemo: config.IS_DEMO,
  demoAllowlist: config.DEMO_ALLOWED_NUMBERS,
  ignoreAllowedHours: config.DEMO_IGNORE_ALLOWED_HOURS,
  replyWindowMs: config.FOLLOWUP_SMS_REPLY_WINDOW_MS,
});
const caller =
  config.ELEVENLABS_API_KEY && config.ELEVENLABS_FOLLOWUP_AGENT_ID && phones.followup.id
    ? new ElevenLabsOutboundCaller({
        apiKey: config.ELEVENLABS_API_KEY,
        agentId: config.ELEVENLABS_FOLLOWUP_AGENT_ID,
        agentPhoneNumberId: phones.followup.id,
      })
    : new StubOutboundCaller();
const dispatcher = new FollowupDispatcher({
  client,
  writer,
  caller,
  followupSms: followups,
  isDemo: config.IS_DEMO,
  demoAllowlist: config.DEMO_ALLOWED_NUMBERS,
  ignoreAllowedHours: config.DEMO_IGNORE_ALLOWED_HOURS,
  callAttempts: config.FOLLOWUP_CALL_ATTEMPTS,
  callResultTimeoutMs: config.FOLLOWUP_CALL_RESULT_TIMEOUT_MS,
  placementBackoffMs: config.FOLLOWUP_PLACEMENT_BACKOFF_MS,
});
// The voice tools wait for an assessment of up to 5 s plus the save: a longer timeout than SMS.
const voiceClient = new BackendClient({
  baseUrl: config.BACKEND_BASE_URL,
  advisorBaseUrl: config.ADVISOR_BASE_URL,
  serviceToken: config.BACKEND_SERVICE_TOKEN,
  timeoutMs: config.BACKEND_TIMEOUT_MS,
  advisorTimeoutMs: config.ADVISOR_TIMEOUT_MS,
});
const voiceWriter = new BackendWriter(voiceClient, config.REPORT_RETRY_DELAYS_MS);
// Approved alerts: a call with the Alerts agent from the follow-up number. Off without that agent (no stub:
// a stub would consume real notifications and mark them unanswered).
const alerts =
  config.ELEVENLABS_API_KEY && config.ELEVENLABS_ALERT_AGENT_ID && phones.followup.id
    ? new AlertDispatcher({
        client: voiceClient,
        writer: voiceWriter,
        caller: new ElevenLabsOutboundCaller({
          apiKey: config.ELEVENLABS_API_KEY,
          agentId: config.ELEVENLABS_ALERT_AGENT_ID,
          agentPhoneNumberId: phones.followup.id,
        }),
        isDemo: config.IS_DEMO,
        demoAllowlist: config.DEMO_ALLOWED_NUMBERS,
        ignoreAllowedHours: config.DEMO_IGNORE_ALLOWED_HOURS,
        callAttempts: config.ALERT_CALL_ATTEMPTS,
        callResultTimeoutMs: config.ALERT_CALL_RESULT_TIMEOUT_MS,
      })
    : undefined;
const voiceTools = new VoiceTools({
  client: voiceClient,
  writer: voiceWriter,
  alerts,
  isDemo: config.IS_DEMO,
  defaultLanguage: config.DEFAULT_LANGUAGE,
  idleMs: config.VOICE_SESSION_IDLE_MS,
});
const conversation = new SmsConversation({
  client,
  store,
  writer,
  followups,
  isDemo: config.IS_DEMO,
  defaultLanguage: config.DEFAULT_LANGUAGE,
  idleMs: config.SMS_SESSION_IDLE_MS,
});

const server = createCommsServer({
  publicBaseUrl: config.PUBLIC_BASE_URL,
  twilioAuthToken: config.TWILIO_AUTH_TOKEN,
  twilioPhoneNumber: config.TWILIO_PHONE_NUMBER,
  // An SMS to any of our numbers (e.g. the one that called the farmer) joins the same conversation.
  extraPhoneNumbers: [config.HELP_AGENT_TELEPHONE, config.FOLLOW_UP_AGENT_PHONE].filter((n): n is string => n !== null),
  conversation,
  voiceTools,
  toolSecret: config.ELEVENLABS_TOOL_SECRET,
  dispatcher,
  serviceToken: config.COMMS_SERVICE_TOKEN,
  elevenlabsWebhookSecret: config.ELEVENLABS_WEBHOOK_SECRET,
});

if (config.FOLLOWUP_POLL_INTERVAL_MS > 0) {
  let polling = false;
  const poller = setInterval(() => {
    if (polling) return;
    polling = true;
    void dispatcher.poll().finally(() => (polling = false));
  }, config.FOLLOWUP_POLL_INTERVAL_MS);
  poller.unref();
}

if (alerts && config.ALERT_POLL_INTERVAL_MS > 0) {
  let polling = false;
  const poller = setInterval(() => {
    if (polling) return;
    polling = true;
    void alerts.poll().finally(() => (polling = false));
  }, config.ALERT_POLL_INTERVAL_MS);
  poller.unref();
}

const sweeper = setInterval(() => {
  void conversation.sweep();
  void voiceTools.sweep();
  // Calls without `submit_followup` in time → `no_response`, even with polling turned off.
  void dispatcher.sweep();
}, 60_000);
sweeper.unref();

if (config.DEMO_IGNORE_ALLOWED_HOURS) {
  log("warn", "demo_ignore_allowed_hours", { message: "Demo: contacting outside allowed hours (08:00–19:00). Do not use with real farmers." });
}

server.listen(config.COMMS_PORT, config.COMMS_HOST, () => {
  log("info", "comms_listening", {
    local_url: `http://${config.COMMS_HOST}:${config.COMMS_PORT}`,
    sms_webhook: `${config.PUBLIC_BASE_URL}/v1/webhooks/twilio/sms`,
    backend: config.BACKEND_BASE_URL,
    advisor: config.ADVISOR_BASE_URL ?? config.BACKEND_BASE_URL,
    advisor_timeout_ms: config.ADVISOR_TIMEOUT_MS,
    is_demo: config.IS_DEMO,
    outbound_sms: sender instanceof TwilioSmsSender ? "twilio" : "stub",
    outbound_calls: caller instanceof ElevenLabsOutboundCaller ? "elevenlabs" : "stub",
    voice_tools: config.ELEVENLABS_TOOL_SECRET ? "enabled" : "disabled",
    followup_poll_ms: config.FOLLOWUP_POLL_INTERVAL_MS,
    alert_calls: alerts ? (config.ALERT_POLL_INTERVAL_MS > 0 ? "polling" : "off (ALERT_POLL_INTERVAL_MS=0)") : "off (needs ELEVENLABS_ALERT_AGENT_ID)",
    alert_poll_ms: config.ALERT_POLL_INTERVAL_MS,
    demo_ignore_allowed_hours: config.DEMO_IGNORE_ALLOWED_HOURS,
    demo_allowlist_size: config.DEMO_ALLOWED_NUMBERS.size,
  });
});
