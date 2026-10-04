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

// Los agentes viven en la cuenta de ElevenLabs: se comprueba que estén configurados como espera este código.
if (config.ELEVENLABS_API_KEY) {
  const check = await checkAgents(new ElevenLabsAgentsApi(config.ELEVENLABS_API_KEY), {
    helpAgentId: config.ELEVENLABS_HELP_AGENT_ID,
    followupAgentId: config.ELEVENLABS_FOLLOWUP_AGENT_ID,
    phones,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  });
  for (const problem of check.problems) log("error", "elevenlabs_agent_misconfigured", { problem });
  for (const detail of check.unreachable) log("warn", "elevenlabs_agents_unreachable", { detail });
  if (check.problems.length === 0 && check.unreachable.length === 0) log("info", "elevenlabs_agents_ok", { agents: Object.keys(check.agents) });
  // En producción no se arranca con un agente mal configurado (corrígelo en el panel y vuelve a correr npm run agents:check).
  if (!config.IS_DEMO && check.problems.length > 0) process.exit(1);
}

// Timeout corto: el webhook de SMS hace como máximo dos llamadas y Twilio corta a los 15 s.
const client = new BackendClient({
  baseUrl: config.BACKEND_BASE_URL,
  advisorBaseUrl: config.ADVISOR_BASE_URL,
  serviceToken: config.BACKEND_SERVICE_TOKEN,
  timeoutMs: config.SMS_STEP_TIMEOUT_MS,
});
const writer = new BackendWriter(client, config.REPORT_RETRY_DELAYS_MS);
const store: SessionStore = new Map();
const sender = config.TWILIO_ACCOUNT_SID
  ? new TwilioSmsSender({
      accountSid: config.TWILIO_ACCOUNT_SID,
      authToken: config.TWILIO_AUTH_TOKEN,
      from: config.TWILIO_PHONE_NUMBER,
      // El webhook de estado llega en la fase 6; hasta entonces no se pide callback.
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
// Las herramientas de voz esperan a una evaluación de hasta 5 s más el guardado: timeout más amplio que el del SMS.
const voiceClient = new BackendClient({
  baseUrl: config.BACKEND_BASE_URL,
  advisorBaseUrl: config.ADVISOR_BASE_URL,
  serviceToken: config.BACKEND_SERVICE_TOKEN,
  timeoutMs: config.BACKEND_TIMEOUT_MS,
});
const voiceTools = new VoiceTools({
  client: voiceClient,
  writer: new BackendWriter(voiceClient, config.REPORT_RETRY_DELAYS_MS),
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
  // Un SMS a cualquiera de nuestros números (p. ej. al que llamó al agricultor) entra a la misma conversación.
  extraPhoneNumbers: [config.HELP_AGENT_TELEPHONE, config.FOLLOW_UP_AGENT_PHONE].filter((n): n is string => n !== null),
  conversation,
  voiceTools,
  toolSecret: config.ELEVENLABS_TOOL_SECRET,
  dispatcher,
  serviceToken: config.COMMS_SERVICE_TOKEN,
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

const sweeper = setInterval(() => {
  void conversation.sweep();
  void voiceTools.sweep();
  // Llamadas sin `submit_followup` en el plazo → `no_response`, también con el sondeo apagado.
  void dispatcher.sweep();
}, 60_000);
sweeper.unref();

if (config.DEMO_IGNORE_ALLOWED_HOURS) {
  log("warn", "demo_ignore_allowed_hours", { message: "Demo: se contacta fuera del horario permitido (08:00–19:00). No usar con agricultores reales." });
}

server.listen(config.COMMS_PORT, "127.0.0.1", () => {
  log("info", "comms_listening", {
    local_url: `http://127.0.0.1:${config.COMMS_PORT}`,
    sms_webhook: `${config.PUBLIC_BASE_URL}/v1/webhooks/twilio/sms`,
    backend: config.BACKEND_BASE_URL,
    advisor: config.ADVISOR_BASE_URL ?? config.BACKEND_BASE_URL,
    is_demo: config.IS_DEMO,
    outbound_sms: sender instanceof TwilioSmsSender ? "twilio" : "stub",
    outbound_calls: caller instanceof ElevenLabsOutboundCaller ? "elevenlabs" : "stub",
    voice_tools: config.ELEVENLABS_TOOL_SECRET ? "enabled" : "disabled",
    followup_poll_ms: config.FOLLOWUP_POLL_INTERVAL_MS,
    demo_ignore_allowed_hours: config.DEMO_IGNORE_ALLOWED_HOURS,
    demo_allowlist_size: config.DEMO_ALLOWED_NUMBERS.size,
  });
});
