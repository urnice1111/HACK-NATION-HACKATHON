/**
 * Deterministic mock advisor (v2 contract) to test voice/SMS without Member 2.
 * It doesn't diagnose: it returns `information_needs` (never the question
 * text), declares in `data_used` what it "queried" and exercises all three
 * dispositions. Its agronomic content is synthetic and must not be presented
 * as real.
 *
 * Rules it mimics (sections 5.1 and 17):
 *  - First turn with a description: two fixed needs (`local_weather_perception`
 *    and `leaf_underside`), like example 10.1.
 *  - Never repeats needs in `asked_need_codes` or already answered.
 *  - At most 5 questions; after that, refers.
 *  - Fungicide, product or dose → `refer` (protocol `coffee-rust-demo-v1`).
 *  - Resolved cases: prefers `verified`; leaves out those that don't match the
 *    protocol; for unreviewed ones, never repeats the solution.
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
    variable: "Recent rain and humidity on the plot",
    reason: "Area data shows above-normal humidity; confirm whether the plot does too",
    farmer_hint: "Ask how the weather has been these days: whether it has rained, been cloudy or humid",
    answer_type: "free_text",
    options: null,
    can_be_unknown: true,
  },
  leaf_underside: {
    need_code: "leaf_underside",
    variable: "Appearance of the underside of affected leaves",
    reason: "Tells rust apart from American leaf spot and leaf miner",
    farmer_hint: "Ask what they see on the underside of the leaves: orange powder, white fuzz, little bugs or nothing",
    answer_type: "choice",
    options: ["orange or yellow powder", "white fuzz", "insects or tunnels", "nothing", "don't know"],
    can_be_unknown: true,
  },
  spot_appearance: {
    need_code: "spot_appearance",
    variable: "Color and shape of the spots",
    reason: "Tells rust apart from brown eye spot and American leaf spot",
    farmer_hint: "Ask what color and shape the spots are on the top of the leaf",
    answer_type: "choice",
    options: ["yellow or orange spots", "brown spots with a light center", "round gray spots", "other"],
    can_be_unknown: true,
  },
  affected_extent: {
    need_code: "affected_extent",
    variable: "How widespread the problem is on the plot",
    reason: "Urgency and extent",
    farmer_hint: "Ask whether it is a few plants, one section or almost the whole plot",
    answer_type: "choice",
    options: ["a few plants", "one section", "almost the whole plot", "don't know"],
    can_be_unknown: true,
  },
};

const ORDER_WITH_DESCRIPTION = ["local_weather_perception", "leaf_underside", "spot_appearance", "affected_extent"];
const ORDER_WITHOUT_DESCRIPTION = ["spot_appearance", "affected_extent", "leaf_underside", "local_weather_perception"];
/** A known answer to any of these is enough to give guidance in the demo. */
const DECISIVE = new Set(["leaf_underside", "spot_appearance"]);
const PRODUCT_QUESTION = /fungicide|product|dose|dosage|poison|chemical|what (should|can|do) i (spray|apply|put|use)/i;

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

/** What the advisor "queried" instead of asking. Out of coverage is declared, never made up. */
function dataUsed(environment: EnvironmentSummary | null): DataUsed[] {
  if (!environment) return [];
  const humidity = environment.features.find((f) => f.name === "humidity_mean_14d");
  if (!humidity || humidity.value === null) {
    return [{ query_id: `q_${randomUUID()}`, summary: "No environmental data for the plot (out of coverage)", data_freshness: "unknown", dataset_ids: [] }];
  }
  return [
    {
      query_id: `q_${randomUUID()}`,
      summary: `14-day mean humidity of ${humidity.value} ${humidity.unit}, above normal`,
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
      : // Not checked against the protocol: only the outcome is repeated, never the solution.
        "Another farmer in the area with a similar problem said their plot improved; a technician hasn't reviewed it yet";
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
      suspected_issue: { code: THREAT_CODE, label: "Possible coffee leaf rust (demo)", certainty: "suspected" },
      evidence_quality: "low",
      urgency: "soon",
      information_needs: [],
      data_used: data,
      resolved_case_mentions: resolvedCaseMentions(ctx.resolutions),
      recommendations: [
        { code: "remove_affected_leaves", text: "Remove the spotted leaves and bury them away from the plants.", protocol_id: PROTOCOL_ID, source_ids: sourceIds },
        { code: "monitor_neighbor_plants", text: "Check the neighboring plants over the next few days.", protocol_id: PROTOCOL_ID, source_ids: sourceIds },
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
