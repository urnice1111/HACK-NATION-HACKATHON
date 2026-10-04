/**
 * Communications' own fixtures for the /v1 mock. Everything is demo
 * (`is_demo: true`). Phones use the fictional +1 202 555 01xx range, so they
 * belong to nobody. The readable IDs are not production IDs.
 *
 * They cover what communications needs to test (sections 13, 15 and 17): a
 * single-owner phone, a shared phone, a contact without alert or follow-up
 * consent, two plots without context, one outside dataset coverage, a due
 * follow-up, an unanswered one and three resolved cases (one `verified`, one
 * `farmer_reported` and one with a product and dose the advisor must leave
 * out). The agronomic content is synthetic: it tests flow and rules, not
 * diagnostic accuracy.
 */
import type { CaseStatus, EnvironmentSummary, FollowupStatus, ResolutionVerification } from "../contracts/index.ts";

export interface FixtureContact {
  id: string;
  phone_e164: string;
  is_shared: boolean;
  /** AGREED: third permission of section 17. null = never asked. */
  report_consent: boolean | null;
  notification_consent: boolean | null;
  followup_call_consent: boolean | null;
  consent_at: string | null;
  allowed_hours: { start: string; end: string } | null;
}

export interface FixtureFarmer {
  id: string;
  name: string;
  preferred_language: string;
  timezone: string;
  contact_id: string;
}

export interface FixturePlot {
  id: string;
  farmer_id: string;
  name: string;
  crop: string | null;
  variety: string | null;
  altitude_m: number | null;
}

export interface FixtureCase {
  id: string;
  plot_id: string;
  threat_code: string;
  status: CaseStatus;
  opened_at: string;
  last_observation_at: string | null;
  closed_at: string | null;
  /** For the follow-up agent's dynamic variables. */
  symptoms: string[];
  guidance_given: string | null;
}

export interface FixtureFollowup {
  id: string;
  case_id: string;
  due_at: string;
  status: FollowupStatus;
  channel: "voice" | "sms";
  attempt_count: number;
  questionnaire_version: string;
  call_reference: string | null;
  response_report_id: string | null;
}

export interface FixtureResolution {
  id: string;
  case_id: string;
  plot_id: string;
  threat_code: string;
  symptoms: string[];
  resolved_at: string;
  solution_statement: string;
  solution_codes: string[] | null;
  /** null = Member 2 hasn't checked it against the protocol yet. */
  matches_protocol: boolean | null;
  outcome: "resolved" | "improved_enough";
  verification: ResolutionVerification;
  followup_id: string | null;
  verified_by: string | null;
  /** Mock only: what the advisor would say. In the real system Member 2 writes it. */
  speech_summary: string | null;
}

export const THREAT_CODE = "coffee_leaf_rust";
export const PROTOCOL_ID = "coffee-rust-demo-v1";
export const QUESTIONNAIRE_VERSION = "followup-demo-v2";
/** Demo follow-up interval (section 17): 3 minutes. */
export const FOLLOWUP_INTERVAL_MS = 3 * 60 * 1000;
/** Demo retry after an unanswered call (section 17): 2 minutes. */
export const FOLLOWUP_RETRY_MS = 2 * 60 * 1000;
/** Call attempts before switching to SMS (section 17). */
export const FOLLOWUP_CALL_ATTEMPTS = 3;

const TZ = "America/Mexico_City";
const HOURS = { start: "08:00", end: "19:00" };
const CONSENTED = { report_consent: true, notification_consent: true, followup_call_consent: true } as const;

export const contacts: FixtureContact[] = [
  { id: "contact_demo_01", phone_e164: "+12025550101", is_shared: false, ...CONSENTED, consent_at: "2026-10-01T15:00:00Z", allowed_hours: HOURS },
  { id: "contact_demo_02", phone_e164: "+12025550102", is_shared: true, ...CONSENTED, consent_at: "2026-10-01T15:05:00Z", allowed_hours: HOURS },
  // Saves reports, but declined alerts and follow-up calls.
  { id: "contact_demo_04", phone_e164: "+12025550104", is_shared: false, report_consent: true, notification_consent: false, followup_call_consent: false, consent_at: "2026-10-01T15:07:00Z", allowed_hours: null },
  { id: "contact_demo_05", phone_e164: "+12025550105", is_shared: false, ...CONSENTED, consent_at: "2026-10-01T15:10:00Z", allowed_hours: HOURS },
  { id: "contact_demo_06", phone_e164: "+12025550106", is_shared: false, ...CONSENTED, consent_at: "2026-10-01T15:15:00Z", allowed_hours: HOURS },
  // Never asked: all three permissions must be requested.
  { id: "contact_demo_07", phone_e164: "+12025550107", is_shared: false, report_consent: null, notification_consent: null, followup_call_consent: null, consent_at: null, allowed_hours: HOURS },
  { id: "contact_demo_08", phone_e164: "+12025550108", is_shared: false, report_consent: null, notification_consent: null, followup_call_consent: null, consent_at: null, allowed_hours: HOURS },
];

export const farmers: FixtureFarmer[] = [
  { id: "farmer_demo_01", name: "Rosa", preferred_language: "en", timezone: TZ, contact_id: "contact_demo_01" },
  { id: "farmer_demo_02", name: "Tomás", preferred_language: "en", timezone: TZ, contact_id: "contact_demo_02" },
  { id: "farmer_demo_03", name: "Lucía", preferred_language: "en", timezone: TZ, contact_id: "contact_demo_02" },
  { id: "farmer_demo_04", name: "Ernesto", preferred_language: "en", timezone: TZ, contact_id: "contact_demo_04" },
  { id: "farmer_demo_05", name: "Marta", preferred_language: "en", timezone: TZ, contact_id: "contact_demo_05" },
  { id: "farmer_demo_06", name: "Julián", preferred_language: "en", timezone: TZ, contact_id: "contact_demo_06" },
  { id: "farmer_demo_07", name: "Inés", preferred_language: "en", timezone: TZ, contact_id: "contact_demo_07" },
  { id: "farmer_demo_08", name: "Raúl", preferred_language: "en", timezone: TZ, contact_id: "contact_demo_08" },
];

/** One plot per farmer in the demo; the model allows more than one. */
export const plots: FixturePlot[] = [
  { id: "plot_demo_01", farmer_id: "farmer_demo_01", name: "Plot 1", crop: "coffee", variety: "typica", altitude_m: 1200 },
  { id: "plot_demo_02", farmer_id: "farmer_demo_02", name: "Plot 2", crop: "coffee", variety: null, altitude_m: 1150 },
  { id: "plot_demo_03", farmer_id: "farmer_demo_03", name: "Plot 3", crop: "coffee", variety: "caturra", altitude_m: 1180 },
  // Outside dataset coverage (see ENVIRONMENT).
  { id: "plot_demo_04", farmer_id: "farmer_demo_04", name: "Plot 4", crop: "coffee", variety: null, altitude_m: null },
  { id: "plot_demo_05", farmer_id: "farmer_demo_05", name: "Plot 5", crop: "coffee", variety: "bourbon", altitude_m: 1300 },
  { id: "plot_demo_06", farmer_id: "farmer_demo_06", name: "Plot 6", crop: "coffee", variety: null, altitude_m: 1250 },
  // No context: crop, variety and altitude unknown (null, never zero).
  { id: "plot_demo_07", farmer_id: "farmer_demo_07", name: "Plot 7", crop: null, variety: null, altitude_m: null },
  { id: "plot_demo_08", farmer_id: "farmer_demo_08", name: "Plot 8", crop: null, variety: null, altitude_m: null },
];

const ENV_DATASETS = ["dataset_humidity_demo", "dataset_rain_demo", "dataset_temperature_demo"];

function summary(humidity: number | null, rainAnomaly: number | null, tempMean: number | null): EnvironmentSummary {
  const covered = humidity !== null || rainAnomaly !== null || tempMean !== null;
  return {
    computed_at: "2026-10-03T06:00:00Z",
    data_freshness: covered ? "fresh" : "unknown",
    features: [
      { name: "humidity_mean_14d", value: humidity, unit: "%" },
      { name: "rain_anomaly_30d", value: rainAnomaly, unit: "ratio" },
      { name: "temp_mean_14d", value: tempMean, unit: "°C" },
    ],
    dataset_ids: covered ? ENV_DATASETS : [],
  };
}

/** Environmental summary per plot (`env.plot_summary`, Member 4). Fictional values. */
export const environment: Record<string, EnvironmentSummary | null> = {
  plot_demo_01: summary(82, 1.8, 21.5),
  plot_demo_02: summary(80, 1.6, 22.0),
  plot_demo_03: summary(81, 1.7, 21.8),
  plot_demo_04: summary(null, null, null),
  plot_demo_05: summary(84, 2.1, 22.4),
  plot_demo_06: summary(78, 1.3, 23.0),
  plot_demo_07: null,
  plot_demo_08: null,
};

export const cases: FixtureCase[] = [
  {
    id: "case_demo_05",
    plot_id: "plot_demo_05",
    threat_code: THREAT_CODE,
    status: "suspected",
    opened_at: "2026-10-02T14:00:00Z",
    last_observation_at: "2026-10-02T14:00:00Z",
    closed_at: null,
    symptoms: ["yellow spots on leaves", "orange powder on the underside"],
    guidance_given: "Remove and bury the affected leaves and watch the neighboring plants",
  },
  {
    id: "case_demo_06",
    plot_id: "plot_demo_06",
    threat_code: THREAT_CODE,
    status: "monitoring",
    opened_at: "2026-09-28T10:00:00Z",
    last_observation_at: "2026-09-28T10:00:00Z",
    closed_at: null,
    symptoms: ["spots on leaves"],
    guidance_given: "Adjust the shade and watch the neighboring plants",
  },
  // Already resolved cases backing the sample resolutions.
  { id: "case_demo_r1", plot_id: "plot_demo_02", threat_code: THREAT_CODE, status: "resolved", opened_at: "2026-09-01T12:00:00Z", last_observation_at: "2026-09-15T12:00:00Z", closed_at: "2026-09-15T12:00:00Z", symptoms: ["yellow spots on leaves"], guidance_given: null },
  { id: "case_demo_r2", plot_id: "plot_demo_03", threat_code: THREAT_CODE, status: "resolved", opened_at: "2026-09-05T12:00:00Z", last_observation_at: "2026-09-20T12:00:00Z", closed_at: "2026-09-20T12:00:00Z", symptoms: ["orange powder on leaves"], guidance_given: null },
  { id: "case_demo_r3", plot_id: "plot_demo_06", threat_code: THREAT_CODE, status: "resolved", opened_at: "2026-08-20T12:00:00Z", last_observation_at: "2026-09-10T12:00:00Z", closed_at: "2026-09-10T12:00:00Z", symptoms: ["spots on leaves", "leaf drop"], guidance_given: null },
];

export const followups: FixtureFollowup[] = [
  // Due: ready for the demo's outbound call.
  { id: "followup_demo_05", case_id: "case_demo_05", due_at: "2026-10-03T22:00:00Z", status: "scheduled", channel: "voice", attempt_count: 0, questionnaire_version: QUESTIONNAIRE_VERSION, call_reference: null, response_report_id: null },
  // Unanswered after the 3 call attempts.
  { id: "followup_demo_06", case_id: "case_demo_06", due_at: "2026-10-01T15:00:00Z", status: "no_response", channel: "voice", attempt_count: 3, questionnaire_version: QUESTIONNAIRE_VERSION, call_reference: null, response_report_id: null },
];

export const resolutions: FixtureResolution[] = [
  {
    id: "resolution_demo_01",
    case_id: "case_demo_r1",
    plot_id: "plot_demo_02",
    threat_code: THREAT_CODE,
    symptoms: ["yellow spots on leaves"],
    resolved_at: "2026-09-15T12:00:00Z",
    solution_statement: "Removed and buried the affected leaves and adjusted the shade",
    solution_codes: ["remove_affected_leaves", "regulate_shade"],
    matches_protocol: true,
    outcome: "resolved",
    verification: "verified",
    followup_id: null,
    verified_by: "agronomist_demo_01",
    speech_summary: "On a similar plot in the area, a technician confirmed it improved after removing and burying the affected leaves and adjusting the shade",
  },
  {
    id: "resolution_demo_02",
    case_id: "case_demo_r2",
    plot_id: "plot_demo_03",
    threat_code: THREAT_CODE,
    symptoms: ["orange powder on leaves"],
    resolved_at: "2026-09-20T12:00:00Z",
    solution_statement: "Pruned to let air through and cleared the weeds",
    solution_codes: ["prune_for_ventilation", "weed_control"],
    matches_protocol: true,
    outcome: "improved_enough",
    verification: "farmer_reported",
    followup_id: null,
    verified_by: null,
    speech_summary: "Another farmer in the area said it improved after pruning to let air through and clearing the weeds",
  },
  {
    // Mentions a product and dose: the advisor must leave it out (doesn't match the protocol).
    id: "resolution_demo_03",
    case_id: "case_demo_r3",
    plot_id: "plot_demo_06",
    threat_code: THREAT_CODE,
    symptoms: ["spots on leaves", "leaf drop"],
    resolved_at: "2026-09-10T12:00:00Z",
    solution_statement: "Applied 3 ml per liter of a copper fungicide every week",
    solution_codes: ["copper_fungicide"],
    matches_protocol: false,
    outcome: "resolved",
    verification: "farmer_reported",
    followup_id: null,
    verified_by: null,
    speech_summary: null,
  },
];
