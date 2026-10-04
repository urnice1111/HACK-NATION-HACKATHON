/**
 * Fixtures propios de comunicaciones para el mock de /v1. Todo es demo
 * (`is_demo: true`). Los teléfonos usan el rango ficticio +1 202 555 01xx,
 * así que no pertenecen a terceros. Los IDs legibles no son IDs de producción.
 *
 * Cubren lo que comunicaciones necesita probar (secciones 13, 15 y 17):
 * teléfono único, teléfono compartido, contacto sin consentimiento de avisos
 * ni seguimientos, dos parcelas sin contexto, una fuera de la cobertura de los
 * datasets, un seguimiento vencido, uno sin respuesta y tres casos resueltos
 * (uno `verified`, uno `farmer_reported` y uno con producto y dosis que el
 * asesor debe omitir). El contenido agronómico es sintético: prueba flujo y
 * reglas, no precisión de diagnóstico.
 */
import type { CaseStatus, EnvironmentSummary, FollowupStatus, ResolutionVerification } from "../contracts/index.ts";

export interface FixtureContact {
  id: string;
  phone_e164: string;
  is_shared: boolean;
  /** ACORDADO: tercer permiso de la sección 17. null = nunca se preguntó. */
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
  /** Para las variables dinámicas del agente de seguimiento. */
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
  /** null = el Integrante 2 aún no lo revisó contra el protocolo. */
  matches_protocol: boolean | null;
  outcome: "resolved" | "improved_enough";
  verification: ResolutionVerification;
  followup_id: string | null;
  verified_by: string | null;
  /** Solo del mock: lo que el asesor diría. En el sistema real lo redacta el Integrante 2. */
  speech_summary: string | null;
}

export const THREAT_CODE = "coffee_leaf_rust";
export const PROTOCOL_ID = "coffee-rust-demo-v1";
export const QUESTIONNAIRE_VERSION = "followup-demo-v2";
/** Intervalo de seguimiento en demo (sección 17): 3 minutos. */
export const FOLLOWUP_INTERVAL_MS = 3 * 60 * 1000;
/** Reintento de llamada sin respuesta en demo (sección 17): 2 minutos. */
export const FOLLOWUP_RETRY_MS = 2 * 60 * 1000;
/** Intentos de llamada antes de pasar a SMS (sección 17). */
export const FOLLOWUP_CALL_ATTEMPTS = 3;

const TZ = "America/Mexico_City";
const HOURS = { start: "08:00", end: "19:00" };
const CONSENTED = { report_consent: true, notification_consent: true, followup_call_consent: true } as const;

export const contacts: FixtureContact[] = [
  { id: "contact_demo_01", phone_e164: "+12025550101", is_shared: false, ...CONSENTED, consent_at: "2026-10-01T15:00:00Z", allowed_hours: HOURS },
  { id: "contact_demo_02", phone_e164: "+12025550102", is_shared: true, ...CONSENTED, consent_at: "2026-10-01T15:05:00Z", allowed_hours: HOURS },
  // Guarda reportes, pero negó avisos y llamadas de seguimiento.
  { id: "contact_demo_04", phone_e164: "+12025550104", is_shared: false, report_consent: true, notification_consent: false, followup_call_consent: false, consent_at: "2026-10-01T15:07:00Z", allowed_hours: null },
  { id: "contact_demo_05", phone_e164: "+12025550105", is_shared: false, ...CONSENTED, consent_at: "2026-10-01T15:10:00Z", allowed_hours: HOURS },
  { id: "contact_demo_06", phone_e164: "+12025550106", is_shared: false, ...CONSENTED, consent_at: "2026-10-01T15:15:00Z", allowed_hours: HOURS },
  // Nunca se les preguntó: hay que pedir los tres permisos.
  { id: "contact_demo_07", phone_e164: "+12025550107", is_shared: false, report_consent: null, notification_consent: null, followup_call_consent: null, consent_at: null, allowed_hours: HOURS },
  { id: "contact_demo_08", phone_e164: "+12025550108", is_shared: false, report_consent: null, notification_consent: null, followup_call_consent: null, consent_at: null, allowed_hours: HOURS },
];

export const farmers: FixtureFarmer[] = [
  { id: "farmer_demo_01", name: "Rosa", preferred_language: "es", timezone: TZ, contact_id: "contact_demo_01" },
  { id: "farmer_demo_02", name: "Tomás", preferred_language: "es", timezone: TZ, contact_id: "contact_demo_02" },
  { id: "farmer_demo_03", name: "Lucía", preferred_language: "es", timezone: TZ, contact_id: "contact_demo_02" },
  { id: "farmer_demo_04", name: "Ernesto", preferred_language: "es", timezone: TZ, contact_id: "contact_demo_04" },
  { id: "farmer_demo_05", name: "Marta", preferred_language: "es", timezone: TZ, contact_id: "contact_demo_05" },
  { id: "farmer_demo_06", name: "Julián", preferred_language: "es", timezone: TZ, contact_id: "contact_demo_06" },
  { id: "farmer_demo_07", name: "Inés", preferred_language: "es", timezone: TZ, contact_id: "contact_demo_07" },
  { id: "farmer_demo_08", name: "Raúl", preferred_language: "es", timezone: TZ, contact_id: "contact_demo_08" },
];

/** Una parcela por agricultor en la demo; el modelo admite más de una. */
export const plots: FixturePlot[] = [
  { id: "plot_demo_01", farmer_id: "farmer_demo_01", name: "Parcela 1", crop: "coffee", variety: "typica", altitude_m: 1200 },
  { id: "plot_demo_02", farmer_id: "farmer_demo_02", name: "Parcela 2", crop: "coffee", variety: null, altitude_m: 1150 },
  { id: "plot_demo_03", farmer_id: "farmer_demo_03", name: "Parcela 3", crop: "coffee", variety: "caturra", altitude_m: 1180 },
  // Fuera de la cobertura de los datasets (ver ENVIRONMENT).
  { id: "plot_demo_04", farmer_id: "farmer_demo_04", name: "Parcela 4", crop: "coffee", variety: null, altitude_m: null },
  { id: "plot_demo_05", farmer_id: "farmer_demo_05", name: "Parcela 5", crop: "coffee", variety: "bourbon", altitude_m: 1300 },
  { id: "plot_demo_06", farmer_id: "farmer_demo_06", name: "Parcela 6", crop: "coffee", variety: null, altitude_m: 1250 },
  // Sin contexto: cultivo, variedad y altitud desconocidos (null, nunca cero).
  { id: "plot_demo_07", farmer_id: "farmer_demo_07", name: "Parcela 7", crop: null, variety: null, altitude_m: null },
  { id: "plot_demo_08", farmer_id: "farmer_demo_08", name: "Parcela 8", crop: null, variety: null, altitude_m: null },
];

const ENV_DATASETS = ["dataset_humedad_demo", "dataset_lluvia_demo", "dataset_temperatura_demo"];

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

/** Resumen ambiental por parcela (`env.plot_summary`, Integrante 4). Valores ficticios. */
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
    symptoms: ["manchas amarillas en hojas", "polvo naranja en el envés"],
    guidance_given: "Retirar y enterrar las hojas afectadas y vigilar las plantas vecinas",
  },
  {
    id: "case_demo_06",
    plot_id: "plot_demo_06",
    threat_code: THREAT_CODE,
    status: "monitoring",
    opened_at: "2026-09-28T10:00:00Z",
    last_observation_at: "2026-09-28T10:00:00Z",
    closed_at: null,
    symptoms: ["manchas en hojas"],
    guidance_given: "Regular la sombra y vigilar las plantas vecinas",
  },
  // Casos ya resueltos que respaldan las resoluciones de ejemplo.
  { id: "case_demo_r1", plot_id: "plot_demo_02", threat_code: THREAT_CODE, status: "resolved", opened_at: "2026-09-01T12:00:00Z", last_observation_at: "2026-09-15T12:00:00Z", closed_at: "2026-09-15T12:00:00Z", symptoms: ["manchas amarillas en hojas"], guidance_given: null },
  { id: "case_demo_r2", plot_id: "plot_demo_03", threat_code: THREAT_CODE, status: "resolved", opened_at: "2026-09-05T12:00:00Z", last_observation_at: "2026-09-20T12:00:00Z", closed_at: "2026-09-20T12:00:00Z", symptoms: ["polvo naranja en hojas"], guidance_given: null },
  { id: "case_demo_r3", plot_id: "plot_demo_06", threat_code: THREAT_CODE, status: "resolved", opened_at: "2026-08-20T12:00:00Z", last_observation_at: "2026-09-10T12:00:00Z", closed_at: "2026-09-10T12:00:00Z", symptoms: ["manchas en hojas", "caída de hojas"], guidance_given: null },
];

export const followups: FixtureFollowup[] = [
  // Vencido: listo para la llamada saliente de la demo.
  { id: "followup_demo_05", case_id: "case_demo_05", due_at: "2026-10-03T22:00:00Z", status: "scheduled", channel: "voice", attempt_count: 0, questionnaire_version: QUESTIONNAIRE_VERSION, call_reference: null, response_report_id: null },
  // Sin respuesta tras los 3 intentos de llamada.
  { id: "followup_demo_06", case_id: "case_demo_06", due_at: "2026-10-01T15:00:00Z", status: "no_response", channel: "voice", attempt_count: 3, questionnaire_version: QUESTIONNAIRE_VERSION, call_reference: null, response_report_id: null },
];

export const resolutions: FixtureResolution[] = [
  {
    id: "resolution_demo_01",
    case_id: "case_demo_r1",
    plot_id: "plot_demo_02",
    threat_code: THREAT_CODE,
    symptoms: ["manchas amarillas en hojas"],
    resolved_at: "2026-09-15T12:00:00Z",
    solution_statement: "Retiró y enterró las hojas afectadas y reguló la sombra",
    solution_codes: ["remove_affected_leaves", "regulate_shade"],
    matches_protocol: true,
    outcome: "resolved",
    verification: "verified",
    followup_id: null,
    verified_by: "agronomist_demo_01",
    speech_summary: "En una parcela parecida de la zona, un técnico confirmó que mejoró al retirar y enterrar las hojas afectadas y regular la sombra",
  },
  {
    id: "resolution_demo_02",
    case_id: "case_demo_r2",
    plot_id: "plot_demo_03",
    threat_code: THREAT_CODE,
    symptoms: ["polvo naranja en hojas"],
    resolved_at: "2026-09-20T12:00:00Z",
    solution_statement: "Podó para que entrara aire y limpió la maleza",
    solution_codes: ["prune_for_ventilation", "weed_control"],
    matches_protocol: true,
    outcome: "improved_enough",
    verification: "farmer_reported",
    followup_id: null,
    verified_by: null,
    speech_summary: "Otro agricultor de la zona contó que mejoró al podar para que entre aire y limpiar la maleza",
  },
  {
    // Menciona producto y dosis: el asesor debe omitirlo (no coincide con el protocolo).
    id: "resolution_demo_03",
    case_id: "case_demo_r3",
    plot_id: "plot_demo_06",
    threat_code: THREAT_CODE,
    symptoms: ["manchas en hojas", "caída de hojas"],
    resolved_at: "2026-09-10T12:00:00Z",
    solution_statement: "Aplicó 3 ml por litro de un fungicida cúprico cada semana",
    solution_codes: ["copper_fungicide"],
    matches_protocol: false,
    outcome: "resolved",
    verification: "farmer_reported",
    followup_id: null,
    verified_by: null,
    speech_summary: null,
  },
];
