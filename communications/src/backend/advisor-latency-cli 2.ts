/**
 * Measures `POST /v1/assessments` latency against the configured advisor (ADVISOR_BASE_URL, or
 * BACKEND_BASE_URL when empty) to choose ADVISOR_TIMEOUT_MS.
 *
 *   npm run advisor:latency            # 5 requests
 *   npm run advisor:latency -- 10      # 10 requests
 *
 * Sends a demo observation for plot_demo_01 with a generous timeout and prints each duration and
 * the percentiles next to SMS_STEP_TIMEOUT_MS, BACKEND_TIMEOUT_MS and ADVISOR_TIMEOUT_MS.
 */
import { BackendClient } from "./client.ts";
import { SCHEMA_VERSION } from "../contracts/index.ts";

const runs = Math.max(1, Math.min(Number(process.argv[2] ?? 5) || 5, 50));
const env = (name: string) => process.env[name]?.trim() || null;
const backend = env("BACKEND_BASE_URL");
if (!backend) {
  console.error("BACKEND_BASE_URL is missing from .env");
  process.exit(1);
}
const advisor = env("ADVISOR_BASE_URL") ?? backend;
const client = new BackendClient({ baseUrl: backend, advisorBaseUrl: advisor, serviceToken: env("BACKEND_SERVICE_TOKEN"), timeoutMs: 30_000 });

console.log(`POST ${advisor.replace(/\/+$/, "")}/v1/assessments × ${runs}`);
const durations: number[] = [];
for (let i = 1; i <= runs; i++) {
  const started = performance.now();
  const result = await client.assess({
    schema_version: SCHEMA_VERSION,
    session_id: `latency_probe_${Date.now()}_${i}`,
    plot_id: "plot_demo_01",
    language: "en",
    observation: {
      observed_at: null,
      symptoms: ["yellow spots on leaves"],
      user_statement: "Some leaves have yellow spots and orange powder underneath",
      measurements: [],
      answers: [],
      completeness: "partial",
    },
    asked_need_codes: [],
    plot_context: { crop: "coffee", variety: null },
    is_demo: true,
  });
  const ms = Math.round(performance.now() - started);
  durations.push(ms);
  console.log(`  ${i}: ${ms} ms  ${result.ok ? result.data.disposition : `${result.kind} ${result.code}`}`);
}

const sorted = [...durations].sort((a, b) => a - b);
const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
console.log(`p50 ${pick(50)} ms · p90 ${pick(90)} ms · max ${sorted.at(-1)} ms`);
for (const name of ["SMS_STEP_TIMEOUT_MS", "BACKEND_TIMEOUT_MS", "ADVISOR_TIMEOUT_MS"]) {
  const limit = Number(env(name) ?? { SMS_STEP_TIMEOUT_MS: 4000, BACKEND_TIMEOUT_MS: 8000, ADVISOR_TIMEOUT_MS: 10_000 }[name]);
  const over = durations.filter((d) => d > limit).length;
  console.log(`  ${name}=${limit}: ${over}/${runs} over`);
}
