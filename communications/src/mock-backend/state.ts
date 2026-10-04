/**
 * The mock's in-memory state. Enough to test contracts, but lost on restart:
 * the real backend (Member 3) persists idempotency in PostgreSQL.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ReportDetail } from "../contracts/index.ts";
import * as fixtures from "./fixtures.ts";

/** Like the real backend (`candidate_token_ttl_s` = 900). */
const CANDIDATE_TOKEN_TTL_MS = 15 * 60 * 1000;

interface CandidateGrant {
  session_id: string;
  phone_e164: string;
  farmer_id: string;
  expires_at: number;
}

interface SessionGrant {
  farmer_id: string;
  plot_ids: Set<string>;
}

/** Canonical JSON (sorted keys) to compare bodies sent with the same key. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(body: unknown): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

export class MockState {
  readonly contacts = structuredClone(fixtures.contacts);
  readonly farmers = structuredClone(fixtures.farmers);
  readonly plots = structuredClone(fixtures.plots);
  readonly cases = structuredClone(fixtures.cases);
  readonly followups = structuredClone(fixtures.followups);
  readonly resolutions = structuredClone(fixtures.resolutions);
  readonly environment = structuredClone(fixtures.environment);
  readonly alerts = structuredClone(fixtures.alerts);
  readonly notifications = structuredClone(fixtures.notifications);
  readonly reports = new Map<string, ReportDetail>();
  /** `scope\0key` → original response and body fingerprint (Idempotency-Key). */
  readonly idempotency = new Map<string, { fingerprint: string; status: number; body: unknown }>();

  private readonly candidateGrants = new Map<string, CandidateGrant>();
  private readonly sessionGrants = new Map<string, SessionGrant>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    /** contact_id → your own test phone (e.g. your cell), to test with real SMS. */
    phoneOverrides: Record<string, string> = {},
  ) {
    for (const contact of this.contacts) {
      const phone = phoneOverrides[contact.id];
      if (phone) contact.phone_e164 = phone;
    }
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  newId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }

  // --- Contacts and sessions ---

  farmersForPhone(phone: string) {
    const contactIds = new Set(this.contacts.filter((c) => c.phone_e164 === phone).map((c) => c.id));
    return this.farmers.filter((f) => contactIds.has(f.contact_id));
  }

  contactOf(farmerId: string) {
    const farmer = this.farmers.find((f) => f.id === farmerId);
    return farmer ? this.contacts.find((c) => c.id === farmer.contact_id) : undefined;
  }

  issueCandidateToken(sessionId: string, phone: string, farmerId: string): string {
    const token = `cand_${randomBytes(18).toString("base64url")}`;
    this.candidateGrants.set(token, {
      session_id: sessionId,
      phone_e164: phone,
      farmer_id: farmerId,
      expires_at: this.now().getTime() + CANDIDATE_TOKEN_TTL_MS,
    });
    return token;
  }

  /** The token is only valid for the same session and phone that requested it. */
  redeemCandidateToken(token: string, sessionId: string, phone: string): string | null {
    const grant = this.candidateGrants.get(token);
    if (!grant) return null;
    if (grant.expires_at < this.now().getTime()) {
      this.candidateGrants.delete(token);
      return null;
    }
    if (grant.session_id !== sessionId || grant.phone_e164 !== phone) return null;

    const plotIds = new Set(this.plots.filter((p) => p.farmer_id === grant.farmer_id).map((p) => p.id));
    this.sessionGrants.set(sessionId, { farmer_id: grant.farmer_id, plot_ids: plotIds });
    return grant.farmer_id;
  }

  /**
   * Outbound follow-up call: there is no contact-resolution, so the
   * `contacting` attempt binds the session to the case's plot (only the mock requires it).
   */
  grantFollowupSession(sessionId: string, farmerId: string, plotId: string): void {
    const grant = this.sessionGrants.get(sessionId);
    if (grant) grant.plot_ids.add(plotId);
    else this.sessionGrants.set(sessionId, { farmer_id: farmerId, plot_ids: new Set([plotId]) });
  }

  farmerOfSession(sessionId: string): string | null {
    return this.sessionGrants.get(sessionId)?.farmer_id ?? null;
  }

  sessionMayAccessPlot(sessionId: string | null, plotId: string): boolean {
    if (!sessionId) return false;
    return this.sessionGrants.get(sessionId)?.plot_ids.has(plotId) ?? false;
  }

  // --- Cases ---

  /** Links the report to an open case for the same plot/threat or creates a new one. */
  attachCase(plotId: string, observedAt: string | null, receivedAt: string, symptoms: string[] = []) {
    const open = this.cases.find(
      (c) => c.plot_id === plotId && c.threat_code === fixtures.THREAT_CODE && c.status !== "resolved",
    );
    const observationAt = observedAt ?? receivedAt;
    if (open) {
      if (!open.last_observation_at || open.last_observation_at < observationAt) open.last_observation_at = observationAt;
      return open;
    }
    const created: fixtures.FixtureCase = {
      id: this.newId("case"),
      plot_id: plotId,
      threat_code: fixtures.THREAT_CODE,
      status: "reported",
      opened_at: receivedAt,
      last_observation_at: observationAt,
      closed_at: null,
      symptoms,
      guidance_given: null,
    };
    this.cases.push(created);
    return created;
  }

  // --- Follow-ups ---

  farmerOfPlot(plotId: string) {
    const plot = this.plots.find((p) => p.id === plotId);
    return plot ? this.farmers.find((f) => f.id === plot.farmer_id) : undefined;
  }

  /** Schedules the case's next follow-up (section 17's demo interval). */
  scheduleFollowup(caseId: string): fixtures.FixtureFollowup {
    const followup: fixtures.FixtureFollowup = {
      id: this.newId("followup"),
      case_id: caseId,
      due_at: new Date(this.now().getTime() + fixtures.FOLLOWUP_INTERVAL_MS).toISOString(),
      status: "scheduled",
      channel: "voice",
      attempt_count: 0,
      questionnaire_version: fixtures.QUESTIONNAIRE_VERSION,
      call_reference: null,
      response_report_id: null,
    };
    this.followups.push(followup);
    return followup;
  }

  // --- Consent ---

  /** Revokes permissions for every contact with that phone; returns how many changed. */
  revokeByPhone(phone: string, scopes: ("notifications" | "followup_calls")[]): number {
    let updated = 0;
    for (const contact of this.contacts.filter((c) => c.phone_e164 === phone)) {
      if (scopes.includes("notifications")) contact.notification_consent = false;
      if (scopes.includes("followup_calls")) contact.followup_call_consent = false;
      contact.consent_at = this.nowIso();
      settleConsent(contact);
      updated += 1;
    }
    return updated;
  }
}

/**
 * Like the backend's `contacts` table: each permission is a boolean (false by default) and only
 * `consent_at: null` means "never asked". Saving any permission leaves the unasked ones as false.
 */
export function settleConsent(contact: fixtures.FixtureContact): void {
  contact.report_consent ??= false;
  contact.notification_consent ??= false;
  contact.followup_call_consent ??= false;
}
