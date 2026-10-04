/**
 * Asesor mock y determinista (contrato v2) para probar voz/SMS sin el
 * Integrante 2. No diagnostica: devuelve `information_needs` (nunca el texto
 * de la pregunta), declara en `data_used` lo que "consultó" y ejerce las tres
 * disposiciones. Su contenido agronómico es sintético y no debe presentarse
 * como real.
 *
 * Reglas que imita (secciones 5.1 y 17):
 *  - Primer turno con descripción: dos necesidades fijas (`local_weather_perception`
 *    y `leaf_underside`), como el ejemplo 10.1.
 *  - No repite necesidades de `asked_need_codes` ni ya respondidas.
 *  - Máximo 5 preguntas; después, deriva.
 *  - Fungicida, producto o dosis → `refer` (protocolo `coffee-rust-demo-v1`).
 *  - Casos resueltos: prefiere `verified`; omite los que no coinciden con el
 *    protocolo; de los no revisados no repite la solución.
 */
import { randomUUID } from "node:crypto";
import {
  MAX_QUESTIONS,
  SCHEMA_VERSION,
  type AssessmentRequest,
  type AssessmentResponse,
  type DataUsed,
  type EnvironmentSummary,
  type InformationNeed,
  type ResolvedCaseMention,
} from "../contracts/index.ts";
import { PROTOCOL_ID, THREAT_CODE, type FixtureResolution } from "./fixtures.ts";

const MOCK_MODEL_VERSION = "mock-advisor-0.2";

type NeedTemplate = Omit<InformationNeed, "priority">;

const NEEDS: Record<string, NeedTemplate> = {
  local_weather_perception: {
    need_code: "local_weather_perception",
    variable: "Lluvia y humedad recientes en la parcela",
    reason: "Los datos de la zona muestran humedad por encima de lo normal; confirmar si en la parcela también",
    farmer_hint: "Preguntar cómo ha estado el clima estos días: si ha llovido, si ha estado nublado o húmedo",
    answer_type: "free_text",
    options: null,
    can_be_unknown: true,
  },
  leaf_underside: {
    need_code: "leaf_underside",
    variable: "Aspecto del envés de las hojas afectadas",
    reason: "Distingue roya de ojo de gallo y minador",
    farmer_hint: "Preguntar qué ve en la parte de abajo de las hojas: polvito naranja, pelusa blanca, bichitos o nada",
    answer_type: "choice",
    options: ["polvo naranja o amarillo", "pelusa blanca", "insectos o galerías", "nada", "no sé"],
    can_be_unknown: true,
  },
  spot_appearance: {
    need_code: "spot_appearance",
    variable: "Color y forma de las manchas",
    reason: "Distingue roya de mancha de hierro y ojo de gallo",
    farmer_hint: "Preguntar de qué color y forma son las manchas por encima de la hoja",
    answer_type: "choice",
    options: ["manchas amarillas o naranjas", "manchas cafés con centro claro", "manchas redondas grises", "otro"],
    can_be_unknown: true,
  },
  affected_extent: {
    need_code: "affected_extent",
    variable: "Extensión del problema en la parcela",
    reason: "Urgencia y extensión",
    farmer_hint: "Preguntar si son pocas plantas, un sector o casi toda la parcela",
    answer_type: "choice",
    options: ["pocas plantas", "un sector", "casi toda la parcela", "no sé"],
    can_be_unknown: true,
  },
};

const ORDER_WITH_DESCRIPTION = ["local_weather_perception", "leaf_underside", "spot_appearance", "affected_extent"];
const ORDER_WITHOUT_DESCRIPTION = ["spot_appearance", "affected_extent", "leaf_underside", "local_weather_perception"];
/** Una respuesta conocida a cualquiera de estas basta para orientar en la demo. */
const DECISIVE = new Set(["leaf_underside", "spot_appearance"]);
const PRODUCT_QUESTION = /fungicida|producto|dosis|veneno|qu[ií]mico|qu[eé] le (echo|pongo|aplico)/i;

export interface AdvisorContext {
  environment: EnvironmentSummary | null;
  resolutions: FixtureResolution[];
}

function base(): Pick<AssessmentResponse, "schema_version" | "assessment_id" | "context_stale" | "model_version" | "protocol_version"> {
  return {
    schema_version: SCHEMA_VERSION,
    assessment_id: `assessment_${randomUUID()}`,
    context_stale: false,
    model_version: MOCK_MODEL_VERSION,
    protocol_version: PROTOCOL_ID,
  };
}

/** Lo que el asesor "consultó" en vez de preguntar. Fuera de cobertura se declara, no se inventa. */
function dataUsed(environment: EnvironmentSummary | null): DataUsed[] {
  if (!environment) return [];
  const humidity = environment.features.find((f) => f.name === "humidity_mean_14d");
  if (!humidity || humidity.value === null) {
    return [{ query_id: `q_${randomUUID()}`, summary: "Sin datos ambientales para la parcela (fuera de cobertura)", data_freshness: "unknown", dataset_ids: [] }];
  }
  return [
    {
      query_id: `q_${randomUUID()}`,
      summary: `Humedad promedio 14 días de ${humidity.value} ${humidity.unit}, por encima de lo normal`,
      data_freshness: environment.data_freshness,
      dataset_ids: environment.dataset_ids,
    },
  ];
}

function refer(data: DataUsed[]): AssessmentResponse {
  return {
    ...base(),
    disposition: "refer",
    suspected_issue: null,
    evidence_quality: "insufficient",
    urgency: "unknown",
    information_needs: [],
    data_used: data,
    resolved_case_mentions: [],
    recommendations: [],
    human_review_required: true,
    source_ids: [],
  };
}

function mentionFor(resolution: FixtureResolution): ResolvedCaseMention | null {
  if (resolution.matches_protocol === false) return null;
  const summary =
    resolution.matches_protocol === true && resolution.speech_summary
      ? resolution.speech_summary
      : // Sin revisar contra el protocolo: no se repite la solución, solo el desenlace.
        "Otro agricultor de la zona con un problema parecido contó que su parcela mejoró; un técnico aún no lo ha revisado";
  return { resolution_id: resolution.id, summary_for_speech: summary, verification: resolution.verification };
}

function resolvedCaseMentions(resolutions: FixtureResolution[]): ResolvedCaseMention[] {
  const rank = (r: FixtureResolution) => (r.verification === "verified" ? 0 : r.verification === "farmer_reported" ? 1 : 2);
  const candidates = resolutions
    .filter((r) => r.threat_code === THREAT_CODE && r.verification !== "disputed")
    .sort((a, b) => rank(a) - rank(b) || (a.resolved_at < b.resolved_at ? 1 : -1));
  for (const candidate of candidates) {
    const mention = mentionFor(candidate);
    if (mention) return [mention];
  }
  return [];
}

export function assess(request: AssessmentRequest, ctx: AdvisorContext): AssessmentResponse {
  const { observation, plot_context } = request;
  const data = dataUsed(ctx.environment);

  if (plot_context.crop === null) return refer(data);

  const farmerText = [observation.user_statement, ...observation.answers.map((a) => a.raw_text)].join(" ");
  if (PRODUCT_QUESTION.test(farmerText)) return refer(data);

  const asked = new Set([...request.asked_need_codes, ...observation.answers.map((a) => a.need_code)]);
  const decisive = observation.answers.some((a) => !a.unknown && DECISIVE.has(a.need_code));

  if (decisive) {
    const sourceIds = [PROTOCOL_ID];
    return {
      ...base(),
      disposition: "advise",
      suspected_issue: { code: THREAT_CODE, label: "Posible roya del café (demostración)", certainty: "suspected" },
      evidence_quality: "low",
      urgency: "soon",
      information_needs: [],
      data_used: data,
      resolved_case_mentions: resolvedCaseMentions(ctx.resolutions),
      recommendations: [
        { code: "remove_affected_leaves", text: "Retira las hojas con manchas y entiérralas lejos de las plantas.", protocol_id: PROTOCOL_ID, source_ids: sourceIds },
        { code: "monitor_neighbor_plants", text: "Revisa las plantas vecinas en los próximos días.", protocol_id: PROTOCOL_ID, source_ids: sourceIds },
      ],
      human_review_required: true,
      source_ids: sourceIds,
    };
  }

  if (asked.size >= MAX_QUESTIONS) return refer(data);

  const hasDescription = observation.symptoms.length > 0 || observation.user_statement.trim().length > 0;
  const order = hasDescription ? ORDER_WITH_DESCRIPTION : ORDER_WITHOUT_DESCRIPTION;
  const remaining = order.filter((code) => !asked.has(code)).slice(0, Math.min(2, MAX_QUESTIONS - asked.size));
  if (remaining.length === 0) return refer(data);

  return {
    ...base(),
    disposition: "ask_more",
    suspected_issue: null,
    evidence_quality: "insufficient",
    urgency: "unknown",
    information_needs: remaining.map((code, i) => ({ ...NEEDS[code]!, priority: i + 1 })),
    data_used: data,
    resolved_case_mentions: [],
    recommendations: [],
    human_review_required: false,
    source_ids: [],
  };
}
