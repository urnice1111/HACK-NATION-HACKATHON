import { z } from "zod";
import { PhoneE164 } from "./contracts/index.ts";

const Url = z.url({ protocol: /^https?$/ });
const Flag = (fallback: "true" | "false") => z.enum(["true", "false"]).default(fallback).transform((v) => v === "true");
/** Empty or missing → null. */
const Optional = z.string().optional().transform((v) => v || null);
const Secret = z.string().min(16, "at least 16 characters").optional().or(z.literal("")).transform((v) => v || null);
const Ms = (fallback: number) => z.coerce.number().int().positive().default(fallback);
/** "a, b,c" → ["a", "b", "c"]. */
const List = (fallback = "") => z.string().default(fallback).transform((v) => v.split(",").map((n) => n.trim()).filter(Boolean));

const PRODUCTION_REQUIRED = [
  "TWILIO_ACCOUNT_SID",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_HELP_AGENT_ID",
  "ELEVENLABS_FOLLOWUP_AGENT_ID",
  "ELEVENLABS_ALERT_AGENT_ID",
  "ELEVENLABS_TOOL_SECRET",
  "COMMS_SERVICE_TOKEN",
] as const;

const Env = z
  .object({
    /** Falls back to PORT, which hosting platforms (Render, Railway…) assign. */
    COMMS_PORT: z.coerce.number().int().positive().default(8080),
    /** 127.0.0.1 locally (ngrok in front); 0.0.0.0 when deployed. */
    COMMS_HOST: z.string().min(1).default("127.0.0.1"),
    /** Exact public domain (no path or trailing "/"). Twilio signs with it. */
    PUBLIC_BASE_URL: Url.refine((u) => new URL(u).pathname === "/" && !u.endsWith("/"), "origin only, no path or trailing /"),
    TWILIO_AUTH_TOKEN: z.string().min(1),
    /** Without it, outbound SMS use the stub (nothing is sent). */
    TWILIO_ACCOUNT_SID: Optional,
    TWILIO_PHONE_NUMBER: PhoneE164,
    BACKEND_BASE_URL: Url,
    /** The real backend doesn't require a token yet (the mock does); without it no `Authorization` is sent. */
    BACKEND_SERVICE_TOKEN: Optional,
    /** Member 2's advisor is a separate service (`advisor/`); empty = BACKEND_BASE_URL (the mock serves both). */
    ADVISOR_BASE_URL: Url.optional().or(z.literal("")).transform((v) => v || null),
    /** Cap per backend call in the voice tools and the dispatchers. */
    BACKEND_TIMEOUT_MS: Ms(8000),
    /**
     * Cap for `POST /v1/assessments` only (SMS and voice). The real advisor runs an LLM with up to
     * 3 internal queries in a 5 s budget plus a final structured call, so it can take longer than
     * SMS_STEP_TIMEOUT_MS or BACKEND_TIMEOUT_MS. Keep it under the 15 s of the `assess_observation`
     * tool and of Twilio's SMS webhook (minus the report save that may follow).
     */
    ADVISOR_TIMEOUT_MS: Ms(10_000),
    /** Everything this service produces is tagged this way; demo and production never mix. */
    IS_DEMO: Flag("true"),
    /** Demo only: contact outside 08:00–19:00 to test at night. Consent and the allowlist are still enforced. */
    DEMO_IGNORE_ALLOWED_HOURS: Flag("false"),
    DEFAULT_LANGUAGE: z.string().default("en"),
    /** Cap per backend call inside the webhook (Twilio gives up after 15 s; we make ≤ 2 calls). */
    SMS_STEP_TIMEOUT_MS: Ms(4000),
    /** Inactivity after which a help call is considered dropped: what was described with permission is saved as partial. */
    VOICE_SESSION_IDLE_MS: Ms(15 * 60 * 1000),
    /** Inactivity after which an SMS conversation closes (and is saved as partial if applicable). */
    SMS_SESSION_IDLE_MS: Ms(30 * 60 * 1000),
    /** How long to wait for an SMS follow-up reply before recording `no_response`. */
    FOLLOWUP_SMS_REPLY_WINDOW_MS: Ms(24 * 60 * 60 * 1000),
    /** Demo allowlist (comma-separated E.164): in demo only these numbers are contacted. Empty = nobody. */
    DEMO_ALLOWED_NUMBERS: List().pipe(z.array(PhoneE164)).transform((list) => new Set(list)),
    // --- ElevenLabs agents: created in the dashboard and only referenced here (see agents/README.md) ---
    /** Without the key, the follow-up agent ID and the number ID, outbound calls use the stub. */
    ELEVENLABS_API_KEY: Optional,
    /** Help agent (inbound calls). Only used to check its configuration at startup. */
    ELEVENLABS_HELP_AGENT_ID: Optional,
    ELEVENLABS_FOLLOWUP_AGENT_ID: Optional,
    /** Alerts agent (outbound call for an approved alert, from the follow-up number). Without it, alert calls are off. */
    ELEVENLABS_ALERT_AGENT_ID: Optional,
    /** A single number for both agents: its ElevenLabs ID (Phone Numbers), not the E.164. With two numbers, use the ones below. */
    ELEVENLABS_AGENT_PHONE_NUMBER_ID: Optional,
    /** Number that answers inbound calls (help agent): E.164 and its ElevenLabs ID. */
    HELP_AGENT_TELEPHONE: PhoneE164.optional().or(z.literal("")).transform((v) => v || null),
    HELP_AGENT_TELEPHONE_ID: Optional,
    /** Number the follow-up agent calls from: E.164 and its ElevenLabs ID. */
    FOLLOW_UP_AGENT_PHONE: PhoneE164.optional().or(z.literal("")).transform((v) => v || null),
    FOLLOW_UP_AGENT_PHONE_ID: Optional,
    /** Secret ElevenLabs sends as `Authorization: Bearer …` to /v1/tools/*. Without it, those routes answer 503. */
    ELEVENLABS_TOOL_SECRET: Secret,
    /** Token the backend worker uses to deliver `followup.due` (PROPOSED). Without it, that route answers 503. */
    COMMS_SERVICE_TOKEN: Secret,
    /** HMAC secret of ElevenLabs' post-call webhook (/v1/webhooks/elevenlabs/post-call). Without it, that route answers 503. */
    ELEVENLABS_WEBHOOK_SECRET: Secret,
    /** Polling for due follow-ups as a fallback for the event; 0 turns it off. */
    FOLLOWUP_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
    /** Call attempts before the fallback SMS (section 17). */
    FOLLOWUP_CALL_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
    /** If `submit_followup` doesn't arrive within this time after placing the call, `no_response` is recorded. */
    FOLLOWUP_CALL_RESULT_TIMEOUT_MS: Ms(10 * 60 * 1000),
    /** Wait after a transient ElevenLabs failure placing the call. */
    FOLLOWUP_PLACEMENT_BACKOFF_MS: Ms(2 * 60 * 1000),
    /** Polling for queued alert notifications (voice); 0 turns it off. Needs ELEVENLABS_ALERT_AGENT_ID. */
    ALERT_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(15_000),
    /** Alert call attempts before `failed` NO_ANSWER. */
    ALERT_CALL_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
    /** Without `acknowledge_alert` within this time the attempt counts as unanswered and the next one goes out (2 min in demo). */
    ALERT_CALL_RESULT_TIMEOUT_MS: Ms(2 * 60 * 1000),
    /** Background retries of an unconfirmed write (at most 3 attempts in total). */
    REPORT_RETRY_DELAYS_MS: List("5000,30000").transform((list) => list.map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 2)),
  })
  .refine((env) => env.IS_DEMO || !env.DEMO_IGNORE_ALLOWED_HOURS, {
    path: ["DEMO_IGNORE_ALLOWED_HOURS"],
    message: "only allowed with IS_DEMO=true",
  })
  .superRefine((env, ctx) => {
    // Production: no stubs or routes without credentials; everything that calls or writes must be configured.
    if (env.IS_DEMO) return;
    for (const key of PRODUCTION_REQUIRED) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "required with IS_DEMO=false" });
    }
    for (const key of ["HELP_AGENT_TELEPHONE_ID", "FOLLOW_UP_AGENT_PHONE_ID"] as const) {
      if (!env[key] && !env.ELEVENLABS_AGENT_PHONE_NUMBER_ID) {
        ctx.addIssue({ code: "custom", path: [key], message: "required with IS_DEMO=false (or ELEVENLABS_AGENT_PHONE_NUMBER_ID for a single number)" });
      }
    }
    if (!env.PUBLIC_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "must be https with IS_DEMO=false" });
    }
  });

export type Config = z.infer<typeof Env>;

/** Validates the environment at startup. The error message names variables, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse({ ...env, COMMS_PORT: env.COMMS_PORT || env.PORT });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
