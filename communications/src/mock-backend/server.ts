/**
 * HTTP mock of the /v1 backend (Member 3) and the advisor (Member 2), with v2
 * contract bodies, to build the voice tools and webhooks without the real
 * backend. Routes marked AGREED aren't in v2 but the backend already
 * implements them the same way (see src/contracts/resources.ts).
 * Follows section 8's conventions: uniform errors, request_id,
 * correlation_id, Idempotency-Key with 409 on a different body, `null` as
 * unknown and `is_demo` everywhere. Only accepts demo data.
 *
 * Test scenarios via the `X-Mock-Scenario` header (mock only):
 *   advisor_unavailable  → /v1/assessments answers a retryable 503
 *   backend_unavailable  → any route answers 503 before processing
 *   delay:<ms>           → processes and answers late (ambiguous timeout)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  AssessmentRequest,
  ConsentRequest,
  ConsentRevocationRequest,
  ContactResolutionRequest,
  FollowupAttemptRequest,
  FollowupResponseRequest,
  FollowupStatus,
  ReportRequest,
  SCHEMA_VERSION,
  type ConsentRecorded,
  type ConsentRevoked,
  type ContactConsent,
  type ContactResolutionResponse,
  type FollowupAttemptRecorded,
  type FollowupList,
  type FollowupListItem,
  type FollowupResponseCreated,
  type PlotContext,
  type ReportCreated,
  type ReportDetail,
} from "../contracts/index.ts";
import { log, maskPhone } from "../http/log.ts";
import { HttpError, bearerMatches, headerValue, parseBody, readJson, requestIdFrom, safeIdHeader, sendJson } from "../http/respond.ts";
import { assess } from "./advisor.ts";
import { FOLLOWUP_CALL_ATTEMPTS, FOLLOWUP_RETRY_MS, type FixtureContact, type FixtureResolution } from "./fixtures.ts";
import { MockState, fingerprint, settleConsent } from "./state.ts";

const MAX_DELAY_MS = 30_000;

export interface MockBackendOptions {
  serviceToken: string;
  phoneOverrides?: Record<string, string>;
  now?: () => Date;
}

interface Ctx {
  req: IncomingMessage;
  query: URLSearchParams;
  requestId: string;
  correlationId: string | null;
  scenario: string | null;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function requireDemo(body: { is_demo: boolean }): void {
  if (!body.is_demo) {
    throw new HttpError(422, "DEMO_MODE_MISMATCH", "The mock only accepts demo data", {
      details: [{ field: "is_demo", reason: "demo_only" }],
    });
  }
}

function requireIdempotencyKey(req: IncomingMessage): string {
  const key = headerValue(req, "idempotency-key");
  if (!key || key.length > 200) {
    throw new HttpError(422, "VALIDATION_ERROR", "Idempotency-Key is required", {
      details: [{ field: "Idempotency-Key", reason: "required" }],
    });
  }
  return key;
}

function consentOf(contact: FixtureContact | undefined): ContactConsent {
  return {
    reports: contact?.report_consent ?? null,
    notifications: contact?.notification_consent ?? null,
    followup_calls: contact?.followup_call_consent ?? null,
    consent_at: contact?.consent_at ?? null,
  };
}

/** Follow-ups that still accept a response (a late response to `no_response` is accepted). */
const OPEN_FOLLOWUP_STATUSES = new Set(["scheduled", "contacting", "no_response"]);

export function createMockBackend(options: MockBackendOptions): { server: Server; state: MockState } {
  if (!options.serviceToken) throw new Error("serviceToken is required");
  const state = new MockState(options.now, options.phoneOverrides);

  /** Replays the original result or returns 409 if the key arrives with a different body. */
  function idempotent(scope: string, key: string, body: unknown, run: () => Reply): Reply {
    const id = `${scope}\u0000${key}`;
    const hash = fingerprint(body);
    const previous = state.idempotency.get(id);
    if (previous && previous.fingerprint !== hash) {
      throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "The Idempotency-Key was already used with a different body");
    }
    if (previous) return { status: previous.status, body: previous.body, headers: { "Idempotency-Replayed": "true" } };
    const reply = run();
    state.idempotency.set(id, { fingerprint: hash, status: reply.status, body: reply.body });
    return reply;
  }

  function contactResolution(ctx: Ctx, raw: unknown): Reply {
    const body = parseBody(ContactResolutionRequest, raw);
    requireDemo(body);
    const matches = state.farmersForPhone(body.phone_e164);
    const isShared = matches.length > 1 || matches.some((f) => state.contactOf(f.id)?.is_shared === true);

    const response: ContactResolutionResponse = {
      schema_version: SCHEMA_VERSION,
      session_id: body.session_id,
      resolution_status: "no_match",
      requires_confirmation: false,
      is_shared_phone: isShared,
      candidates: [],
      confirmed: null,
      is_demo: true,
    };

    if (body.confirm_candidate_token !== null) {
      const farmerId = state.redeemCandidateToken(body.confirm_candidate_token, body.session_id, body.phone_e164);
      if (!farmerId) {
        throw new HttpError(403, "CANDIDATE_TOKEN_INVALID", "The candidate is not valid for this session");
      }
      const farmer = state.farmers.find((f) => f.id === farmerId)!;
      const contact = state.contactOf(farmerId);
      response.resolution_status = "confirmed";
      response.confirmed = {
        farmer_id: farmer.id,
        preferred_language: farmer.preferred_language,
        timezone: farmer.timezone,
        consent: consentOf(contact),
        plots: state.plots.filter((p) => p.farmer_id === farmer.id).map((p) => ({ plot_id: p.id, label: p.name })),
      };
    } else if (matches.length > 0) {
      response.resolution_status = "candidates";
      response.requires_confirmation = true;
      response.candidates = matches.map((f) => ({
        candidate_token: state.issueCandidateToken(body.session_id, body.phone_e164, f.id),
        label: f.name,
      }));
    }

    log("info", "contact_resolution", {
      request_id: ctx.requestId,
      correlation_id: ctx.correlationId,
      phone: maskPhone(body.phone_e164),
      outcome: response.resolution_status,
      candidates: response.candidates.length,
    });
    return { status: 200, body: response };
  }

  function plotContext(ctx: Ctx, plotId: string): Reply {
    const plot = state.plots.find((p) => p.id === plotId);
    if (!plot) throw new HttpError(404, "NOT_FOUND", "Plot not found");
    if (!state.sessionMayAccessPlot(safeIdHeader(ctx.req, "x-session-id"), plotId)) {
      throw new HttpError(403, "PLOT_NOT_CONFIRMED", "The session has not confirmed this plot");
    }
    const activeCases = state.cases.filter((c) => c.plot_id === plotId && c.status !== "resolved");
    const caseIds = new Set(activeCases.map((c) => c.id));
    const hasContext = plot.crop !== null;
    const body: PlotContext = {
      schema_version: SCHEMA_VERSION,
      plot_id: plot.id,
      label: plot.name,
      crop: plot.crop,
      variety: plot.variety,
      altitude_m: plot.altitude_m,
      data_freshness: hasContext ? "fresh" : "unknown",
      environment_summary: state.environment[plot.id] ?? null,
      active_cases: activeCases.map((c) => ({
        case_id: c.id,
        threat_code: c.threat_code,
        status: c.status,
        opened_at: c.opened_at,
        last_observation_at: c.last_observation_at,
      })),
      pending_followups: state.followups
        .filter((f) => caseIds.has(f.case_id) && OPEN_FOLLOWUP_STATUSES.has(f.status))
        .map((f) => ({ followup_id: f.id, case_id: f.case_id, due_at: f.due_at, status: f.status })),
      is_demo: true,
    };
    return { status: 200, body };
  }

  function assessment(ctx: Ctx, raw: unknown): Reply {
    if (ctx.scenario === "advisor_unavailable") {
      throw new HttpError(503, "ADVISOR_UNAVAILABLE", "The advisor is unavailable", { retryable: true });
    }
    const body = parseBody(AssessmentRequest, raw);
    requireDemo(body);
    if (!state.plots.some((p) => p.id === body.plot_id)) throw new HttpError(404, "NOT_FOUND", "Plot not found");
    return {
      status: 200,
      body: assess(body, { environment: state.environment[body.plot_id] ?? null, resolutions: state.resolutions }),
    };
  }

  function createReport(ctx: Ctx, raw: unknown): Reply {
    const key = requireIdempotencyKey(ctx.req);
    const body = parseBody(ReportRequest, raw);
    requireDemo(body);

    return idempotent("POST /v1/reports", key, body, () => {
      if (body.plot_id !== null) {
        if (!state.plots.some((p) => p.id === body.plot_id)) throw new HttpError(404, "NOT_FOUND", "Plot not found");
        if (body.channel !== "operator" && !state.sessionMayAccessPlot(body.session_id, body.plot_id)) {
          throw new HttpError(403, "PLOT_NOT_CONFIRMED", "The session has not confirmed this plot");
        }
      }
      if (body.case_id !== null) {
        const existing = state.cases.find((c) => c.id === body.case_id);
        if (!existing || existing.plot_id !== body.plot_id) {
          throw new HttpError(422, "VALIDATION_ERROR", "case_id does not belong to the plot", {
            details: [{ field: "case_id", reason: "mismatch" }],
          });
        }
      }

      const receivedAt = state.nowIso();
      const caseId = body.plot_id === null ? null : (body.case_id ?? state.attachCase(body.plot_id, body.observed_at, receivedAt, body.symptoms).id);
      const report: ReportDetail = {
        report_id: state.newId("report"),
        case_id: caseId,
        plot_id: body.plot_id,
        session_id: body.session_id,
        channel: body.channel,
        provider_reference: body.provider_reference,
        observed_at: body.observed_at,
        received_at: receivedAt,
        symptoms: body.symptoms,
        measurements: body.measurements,
        user_statement: body.user_statement,
        completeness: body.completeness,
        assessment_id: body.assessment_id ?? null,
        processing_status: "pending",
        created_at: receivedAt,
        is_demo: true,
      };
      state.reports.set(report.report_id, report);

      const created: ReportCreated = {
        report_id: report.report_id,
        case_id: caseId,
        received_at: receivedAt,
        processing_status: "pending",
        correlation_id: ctx.correlationId ?? body.session_id,
      };
      log("info", "report_created", {
        request_id: ctx.requestId,
        correlation_id: created.correlation_id,
        report_id: report.report_id,
        outcome: "created",
      });
      return { status: 201, body: created };
    });
  }

  function getReport(reportId: string): Reply {
    const report = state.reports.get(reportId);
    if (!report) throw new HttpError(404, "NOT_FOUND", "Report not found");
    return { status: 200, body: report };
  }

  /** AGREED: `GET /v1/followups?status=…&due_before=…`, with case summary and contact. */
  function listFollowups(ctx: Ctx): Reply {
    const statusParam = ctx.query.get("status");
    const status = statusParam === null ? null : FollowupStatus.safeParse(statusParam);
    if (status && !status.success) {
      throw new HttpError(422, "VALIDATION_ERROR", "invalid status", { details: [{ field: "status", reason: "invalid_enum_value" }] });
    }
    const dueBefore = ctx.query.get("due_before");
    if (dueBefore !== null && Number.isNaN(Date.parse(dueBefore))) {
      throw new HttpError(422, "VALIDATION_ERROR", "invalid due_before", { details: [{ field: "due_before", reason: "invalid_format" }] });
    }

    const items: FollowupListItem[] = [];
    for (const followup of state.followups) {
      if (status && followup.status !== status.data) continue;
      if (dueBefore !== null && Date.parse(followup.due_at) > Date.parse(dueBefore)) continue;
      const linkedCase = state.cases.find((c) => c.id === followup.case_id);
      const farmer = linkedCase && state.farmerOfPlot(linkedCase.plot_id);
      const contact = farmer && state.contactOf(farmer.id);
      if (!linkedCase || !farmer || !contact) continue;
      items.push({
        followup_id: followup.id,
        case_id: linkedCase.id,
        plot_id: linkedCase.plot_id,
        due_at: followup.due_at,
        status: followup.status,
        channel: followup.channel,
        attempt_count: followup.attempt_count,
        questionnaire_version: followup.questionnaire_version,
        call_reference: followup.call_reference,
        case_summary: {
          farmer_name: farmer.name,
          threat_code: linkedCase.threat_code,
          case_status: linkedCase.status,
          opened_at: linkedCase.opened_at,
          symptoms: linkedCase.symptoms,
          guidance_given: linkedCase.guidance_given,
        },
        contact: {
          phone_e164: contact.phone_e164,
          preferred_language: farmer.preferred_language,
          timezone: farmer.timezone,
          allowed_hours: contact.allowed_hours,
          // null (never asked) authorizes neither calls nor alerts.
          followup_call_consent: contact.followup_call_consent === true,
          notification_consent: contact.notification_consent === true,
        },
        is_demo: true,
      });
    }
    const body: FollowupList = { schema_version: SCHEMA_VERSION, followups: items, next_cursor: null, is_demo: true };
    return { status: 200, body };
  }

  /** AGREED: `POST /v1/followups/{id}/attempts`. */
  function followupAttempt(ctx: Ctx, followupId: string, raw: unknown): Reply {
    const key = requireIdempotencyKey(ctx.req);
    const body = parseBody(FollowupAttemptRequest, raw);
    requireDemo(body);

    return idempotent(`POST /v1/followups/${followupId}/attempts`, key, body, () => {
      const followup = state.followups.find((f) => f.id === followupId);
      if (!followup) throw new HttpError(404, "NOT_FOUND", "Follow-up not found");
      if (!OPEN_FOLLOWUP_STATUSES.has(followup.status)) {
        throw new HttpError(409, "FOLLOWUP_CLOSED", "The follow-up no longer accepts attempts");
      }
      const linkedCase = state.cases.find((c) => c.id === followup.case_id)!;

      if (body.status === "contacting") {
        followup.attempt_count += 1;
        followup.channel = body.channel;
        followup.call_reference = body.call_reference;
        const farmer = state.farmerOfPlot(linkedCase.plot_id);
        if (farmer) state.grantFollowupSession(body.session_id, farmer.id, linkedCase.plot_id);
      }
      // No response changes neither the case nor the risk: only the follow-up status.
      followup.status = body.status;
      if (body.status === "no_response" && followup.channel === "voice") {
        // Like the backend: the scheduler reschedules the retry (2 min in demo); once calls are used up, the SMS goes now.
        const delay = followup.attempt_count < FOLLOWUP_CALL_ATTEMPTS ? FOLLOWUP_RETRY_MS : 0;
        followup.due_at = new Date(Date.parse(state.nowIso()) + delay).toISOString();
      }

      const recorded: FollowupAttemptRecorded = {
        followup_id: followup.id,
        status: followup.status,
        attempt_count: followup.attempt_count,
        is_demo: true,
      };
      log("info", "followup_attempt", { request_id: ctx.requestId, correlation_id: body.session_id, outcome: body.status });
      return { status: 200, body: recorded };
    });
  }

  /** `POST /v1/followups/{id}/responses` (10.4). */
  function followupResponse(ctx: Ctx, followupId: string, raw: unknown): Reply {
    const key = requireIdempotencyKey(ctx.req);
    const body = parseBody(FollowupResponseRequest, raw);
    requireDemo(body);

    return idempotent(`POST /v1/followups/${followupId}/responses`, key, body, () => {
      const followup = state.followups.find((f) => f.id === followupId);
      if (!followup) throw new HttpError(404, "NOT_FOUND", "Follow-up not found");
      const linkedCase = state.cases.find((c) => c.id === followup.case_id)!;
      if (!state.sessionMayAccessPlot(body.session_id, linkedCase.plot_id)) {
        throw new HttpError(403, "PLOT_NOT_CONFIRMED", "The session has not confirmed the follow-up's plot");
      }
      if (!OPEN_FOLLOWUP_STATUSES.has(followup.status)) {
        throw new HttpError(409, "FOLLOWUP_CLOSED", "The follow-up no longer accepts responses");
      }

      const receivedAt = state.nowIso();
      const report: ReportDetail = {
        report_id: state.newId("report"),
        case_id: linkedCase.id,
        plot_id: linkedCase.plot_id,
        session_id: body.session_id,
        channel: body.channel,
        provider_reference: body.provider_reference,
        observed_at: null,
        received_at: receivedAt,
        symptoms: [],
        measurements: [],
        user_statement: body.user_statement,
        completeness: body.status_reported === "unknown" ? "partial" : "sufficient",
        assessment_id: null,
        processing_status: "pending",
        created_at: receivedAt,
        is_demo: true,
      };
      state.reports.set(report.report_id, report);
      followup.status = "responded";
      followup.channel = body.channel;
      followup.response_report_id = report.report_id;
      if (!linkedCase.last_observation_at || linkedCase.last_observation_at < receivedAt) {
        linkedCase.last_observation_at = receivedAt;
      }

      let resolutionId: string | null = null;
      let nextFollowupAt: string | null = null;
      if (body.status_reported === "resolved") {
        // A single resolution per case, even if two "resolved" follow-ups arrive.
        const existing = state.resolutions.find((r) => r.case_id === linkedCase.id);
        if (existing) {
          resolutionId = existing.id;
        } else {
          const resolution: FixtureResolution = {
            id: state.newId("resolution"),
            case_id: linkedCase.id,
            plot_id: linkedCase.plot_id,
            threat_code: linkedCase.threat_code,
            symptoms: linkedCase.symptoms,
            resolved_at: body.change_noticed_at ?? receivedAt,
            solution_statement: body.actions_taken ?? body.user_statement,
            // Member 2 normalizes them; meanwhile null, and the text is kept.
            solution_codes: null,
            matches_protocol: null,
            outcome: "resolved",
            verification: "farmer_reported",
            followup_id: followup.id,
            verified_by: null,
            speech_summary: null,
          };
          state.resolutions.push(resolution);
          resolutionId = resolution.id;
        }
        linkedCase.status = "resolved";
        linkedCase.closed_at = receivedAt;
      } else {
        // Improved, same, worse or unknown: another follow-up (and review if worse or the same).
        nextFollowupAt = state.scheduleFollowup(linkedCase.id).due_at;
      }

      const created: FollowupResponseCreated = {
        report_id: report.report_id,
        case_id: linkedCase.id,
        case_status: linkedCase.status,
        resolution_id: resolutionId,
        next_followup_at: nextFollowupAt,
      };
      log("info", "followup_responded", {
        request_id: ctx.requestId,
        correlation_id: ctx.correlationId ?? body.session_id,
        outcome: body.status_reported,
        review_proposed: body.status_reported === "worse" || body.status_reported === "same",
      });
      return { status: 201, body: created };
    });
  }

  /** AGREED: `POST /v1/consents`. Only for the farmer the session confirmed. */
  function recordConsent(ctx: Ctx, raw: unknown): Reply {
    const key = requireIdempotencyKey(ctx.req);
    const body = parseBody(ConsentRequest, raw);
    requireDemo(body);

    return idempotent("POST /v1/consents", key, body, () => {
      if (state.farmerOfSession(body.session_id) !== body.farmer_id) {
        throw new HttpError(403, "FARMER_NOT_CONFIRMED", "The session has not confirmed this farmer");
      }
      const contact = state.contactOf(body.farmer_id);
      if (!contact) throw new HttpError(404, "NOT_FOUND", "Contact not found");
      if (body.reports !== null) contact.report_consent = body.reports;
      if (body.notifications !== null) contact.notification_consent = body.notifications;
      if (body.followup_calls !== null) contact.followup_call_consent = body.followup_calls;
      contact.consent_at = state.nowIso();
      settleConsent(contact);

      const recorded: ConsentRecorded = { farmer_id: body.farmer_id, consent: consentOf(contact), is_demo: true };
      log("info", "consent_recorded", { request_id: ctx.requestId, correlation_id: body.session_id, outcome: "recorded" });
      return { status: 200, body: recorded };
    });
  }

  /** AGREED: `POST /v1/consents/revocations` ("ALERTS OFF" by SMS). An unknown phone revokes 0 contacts. */
  function revokeConsent(ctx: Ctx, raw: unknown): Reply {
    const key = requireIdempotencyKey(ctx.req);
    const body = parseBody(ConsentRevocationRequest, raw);
    requireDemo(body);

    return idempotent("POST /v1/consents/revocations", key, body, () => {
      const revoked: ConsentRevoked = {
        contacts_updated: state.revokeByPhone(body.phone_e164, body.scopes),
        scopes: body.scopes,
        is_demo: true,
      };
      log("info", "consent_revoked", { request_id: ctx.requestId, phone: maskPhone(body.phone_e164), contacts_updated: revoked.contacts_updated });
      return { status: 200, body: revoked };
    });
  }

  async function route(ctx: Ctx, method: string, path: string): Promise<Reply> {
    if (method === "GET" && path === "/v1/health") return { status: 200, body: { status: "ok", is_demo: true } };

    if (!bearerMatches(headerValue(ctx.req, "authorization"), options.serviceToken)) {
      throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid service credentials");
    }
    if (ctx.scenario === "backend_unavailable") {
      throw new HttpError(503, "SERVICE_UNAVAILABLE", "Dependency temporarily unavailable", { retryable: true });
    }

    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/v1/contact-resolution") return contactResolution(ctx, await readJson(ctx.req));
    if (method === "POST" && path === "/v1/assessments") return assessment(ctx, await readJson(ctx.req));
    if (method === "POST" && path === "/v1/reports") return createReport(ctx, await readJson(ctx.req));
    if (method === "GET" && (m = path.match(/^\/v1\/plots\/([A-Za-z0-9_-]+)\/context$/))) return plotContext(ctx, m[1]!);
    if (method === "GET" && (m = path.match(/^\/v1\/reports\/([A-Za-z0-9_-]+)$/))) return getReport(m[1]!);
    if (method === "GET" && path === "/v1/followups") return listFollowups(ctx);
    if (method === "POST" && (m = path.match(/^\/v1\/followups\/([A-Za-z0-9_-]+)\/responses$/))) {
      return followupResponse(ctx, m[1]!, await readJson(ctx.req));
    }
    if (method === "POST" && (m = path.match(/^\/v1\/followups\/([A-Za-z0-9_-]+)\/attempts$/))) {
      return followupAttempt(ctx, m[1]!, await readJson(ctx.req));
    }
    if (method === "POST" && path === "/v1/consents") return recordConsent(ctx, await readJson(ctx.req));
    if (method === "POST" && path === "/v1/consents/revocations") return revokeConsent(ctx, await readJson(ctx.req));
    throw new HttpError(404, "NOT_FOUND", "Route not found");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const requestId = requestIdFrom(req);
    const ctx: Ctx = {
      req,
      query: new URLSearchParams(),
      requestId,
      correlationId: safeIdHeader(req, "x-correlation-id"),
      scenario: headerValue(req, "x-mock-scenario"),
    };
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://mock.local");
    const path = url.pathname;
    ctx.query = url.searchParams;

    let reply: Reply;
    try {
      reply = await route(ctx, method, path);
    } catch (error) {
      const httpError =
        error instanceof HttpError ? error : new HttpError(500, "INTERNAL_ERROR", "Mock internal error", { retryable: true });
      if (!(error instanceof HttpError)) log("error", "unhandled_error", { request_id: requestId, error: String(error) });
      reply = { status: httpError.status, body: httpError.toBody(requestId) };
    }

    const delay = ctx.scenario?.match(/^delay:(\d+)$/);
    if (delay) await new Promise((r) => setTimeout(r, Math.min(Number(delay[1]), MAX_DELAY_MS)));

    const headers: Record<string, string> = { "X-Request-Id": requestId, ...reply.headers };
    if (ctx.correlationId) headers["X-Correlation-Id"] = ctx.correlationId;
    if (!res.destroyed) sendJson(res, reply.status, reply.body, headers);

    log(reply.status >= 500 ? "error" : "info", "request", {
      request_id: requestId,
      correlation_id: ctx.correlationId,
      method,
      path,
      status: reply.status,
      duration_ms: Math.round(performance.now() - started),
    });
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  return { server, state };
}
