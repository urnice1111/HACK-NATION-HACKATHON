/**
 * Communications HTTP server:
 *  - Provider webhooks: authenticated with each provider's signature, not with the operator token.
 *  - ElevenLabs agent tools (`/v1/tools/*`): their own secret in `Authorization`.
 *  - Backend `followup.due` (`POST /v1/followups/{id}/dispatch`, PROPOSED): service token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { OutboxEvent } from "../contracts/index.ts";
import type { DispatchResult, FollowupDispatcher } from "../followups/dispatcher.ts";
import { log, maskPhone } from "../http/log.ts";
import { HttpError, bearerMatches, headerValue, readBody, readJson, requestIdFrom, sendJson } from "../http/respond.ts";
import type { ToolReply, VoiceTools } from "../tools/voice-tools.ts";
import { normalizeE164 } from "../phone.ts";
import type { SmsConversation } from "../sms/conversation.ts";
import { BoundedMap, KeyedMutex } from "../util.ts";
import { callbackUrl, formParams, isValidTwilioSignature, messageTwiml } from "../twilio/webhook.ts";

export interface CommsServerDeps {
  publicBaseUrl: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  /** Other numbers of ours whose SMS are also handled (outbound SMS always go from `twilioPhoneNumber`). */
  extraPhoneNumbers?: string[];
  conversation: SmsConversation;
  /** Voice tools; without them (or without the secret) the `/v1/tools/*` routes answer 503. */
  voiceTools?: VoiceTools;
  toolSecret?: string | null;
  /** Follow-up dispatcher; without it (or without the token) the `followup.due` route answers 503. */
  dispatcher?: FollowupDispatcher;
  serviceToken?: string | null;
}

const FollowupDueEvent = OutboxEvent.extend({
  event_type: z.literal("followup.due"),
  payload: z.looseObject({ followup_id: z.string().min(1) }),
});

const TOOL_ROUTES: Record<string, (tools: VoiceTools, body: unknown) => Promise<ToolReply>> = {
  // Help agent (inbound call).
  "/v1/tools/resolve-farmer": (tools, body) => tools.resolveFarmer(body),
  "/v1/tools/confirm-farmer": (tools, body) => tools.confirmFarmer(body),
  "/v1/tools/get-plot-context": (tools, body) => tools.getPlotContext(body),
  "/v1/tools/record-consent": (tools, body) => tools.recordConsent(body),
  // Both agents.
  "/v1/tools/submit-followup": (tools, body) => tools.submitFollowup(body),
  "/v1/tools/assess-observation": (tools, body) => tools.assessObservation(body),
  "/v1/tools/submit-report": (tools, body) => tools.submitReport(body),
};

export function createCommsServer(deps: CommsServerDeps): Server {
  const phoneLocks = new KeyedMutex();
  /** TwiML already answered per MessageSid: a repeated webhook gets the same answer. */
  const processed = new BoundedMap<string, string>();
  /** Events already processed (section 11: every consumer deduplicates by event_id). */
  const processedEvents = new BoundedMap<string, DispatchResult>();

  async function tool(req: IncomingMessage, res: ServerResponse, requestId: string, path: string): Promise<string> {
    if (!deps.voiceTools || !deps.toolSecret) throw new HttpError(503, "NOT_CONFIGURED", "Voice tools are not configured");
    if (!bearerMatches(headerValue(req, "authorization"), deps.toolSecret)) {
      throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid tool credentials");
    }
    const reply = await TOOL_ROUTES[path]!(deps.voiceTools, await readJson(req));
    sendJson(res, reply.status, reply.body, { "X-Request-Id": requestId });
    return "tool";
  }

  async function followupDue(req: IncomingMessage, res: ServerResponse, requestId: string, followupId: string): Promise<string> {
    if (!deps.dispatcher || !deps.serviceToken) throw new HttpError(503, "NOT_CONFIGURED", "Follow-up dispatcher is not configured");
    if (!bearerMatches(headerValue(req, "authorization"), deps.serviceToken)) {
      throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid service credentials");
    }
    const parsed = FollowupDueEvent.safeParse(await readJson(req));
    if (!parsed.success || parsed.data.payload.followup_id !== followupId) {
      throw new HttpError(422, "VALIDATION_ERROR", "Expected a followup.due event for this follow-up", {
        details: [{ field: parsed.success ? "payload.followup_id" : "(body)", reason: parsed.success ? "mismatch" : "invalid" }],
      });
    }
    const event = parsed.data;
    const previous = processedEvents.get(event.event_id);
    if (previous) {
      sendJson(res, 200, { event_id: event.event_id, followup_id: followupId, result: previous, replayed: true }, { "X-Request-Id": requestId });
      return "replayed";
    }
    const result = await deps.dispatcher.dispatchById(followupId);
    processedEvents.set(event.event_id, result);
    sendJson(res, 202, { event_id: event.event_id, followup_id: followupId, result, replayed: false }, { "X-Request-Id": requestId });
    return result.status;
  }

  function sendTwiml(res: ServerResponse, twiml: string, requestId: string): void {
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8", "X-Request-Id": requestId });
    res.end(twiml);
  }

  async function twilioSms(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<string> {
    const params = formParams(await readBody(req));
    const url = callbackUrl(deps.publicBaseUrl, req.url ?? "/");
    if (!isValidTwilioSignature(deps.twilioAuthToken, headerValue(req, "x-twilio-signature"), url, params)) {
      throw new HttpError(403, "INVALID_SIGNATURE", "Invalid Twilio signature");
    }

    const messageSid = params.MessageSid;
    if (!messageSid) throw new HttpError(400, "VALIDATION_ERROR", "Falta MessageSid");
    const from = normalizeE164(params.From);
    const to = normalizeE164(params.To);
    if (!from || !to || (to !== deps.twilioPhoneNumber && !deps.extraPhoneNumbers?.includes(to))) {
      log("warn", "sms_ignored", { request_id: requestId, message_sid: messageSid, reason: from ? "other_number" : "invalid_from" });
      sendTwiml(res, messageTwiml(null), requestId);
      return "ignored";
    }

    // A repeated webhook (same MessageSid) gets the same answer and repeats no side effects.
    const twiml = await phoneLocks.run(from, async () => {
      const previous = processed.get(messageSid);
      if (previous) return { twiml: previous, replayed: true };
      const reply = await deps.conversation.handle({
        message_sid: messageSid,
        from,
        text: params.Body ?? "",
        num_media: Number(params.NumMedia ?? 0),
      });
      const fresh = messageTwiml(reply);
      processed.set(messageSid, fresh);
      return { twiml: fresh, replayed: false };
    });

    sendTwiml(res, twiml.twiml, requestId);
    log("info", "sms_inbound", { request_id: requestId, message_sid: messageSid, phone: maskPhone(from), replayed: twiml.replayed });
    return twiml.replayed ? "replayed" : "handled";
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const requestId = requestIdFrom(req);
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://comms.local").pathname;
    let outcome = "ok";
    let status = 200;
    let dispatchMatch: RegExpMatchArray | null;

    try {
      if (method === "GET" && path === "/v1/health") {
        sendJson(res, 200, { status: "ok" }, { "X-Request-Id": requestId });
      } else if (method === "POST" && path === "/v1/webhooks/twilio/sms") {
        outcome = await twilioSms(req, res, requestId);
      } else if (method === "POST" && path in TOOL_ROUTES) {
        outcome = await tool(req, res, requestId, path);
      } else if (method === "POST" && (dispatchMatch = path.match(/^\/v1\/followups\/([A-Za-z0-9_-]+)\/dispatch$/))) {
        outcome = await followupDue(req, res, requestId, dispatchMatch[1]!);
      } else {
        throw new HttpError(404, "NOT_FOUND", "Route not found");
      }
    } catch (error) {
      const httpError = error instanceof HttpError ? error : new HttpError(500, "INTERNAL_ERROR", "Error interno", { retryable: true });
      if (!(error instanceof HttpError)) log("error", "unhandled_error", { request_id: requestId, error: String(error) });
      status = httpError.status;
      outcome = httpError.code;
      if (!res.headersSent) sendJson(res, status, httpError.toBody(requestId), { "X-Request-Id": requestId });
    }

    log(status >= 500 ? "error" : "info", "request", {
      request_id: requestId,
      method,
      path,
      status,
      outcome,
      duration_ms: Math.round(performance.now() - started),
    });
  }

  return createServer((req, res) => {
    void handle(req, res);
  });
}
