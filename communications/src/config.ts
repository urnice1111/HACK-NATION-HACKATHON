import { z } from "zod";
import { PhoneE164 } from "./contracts/index.ts";

const Url = z.url({ protocol: /^https?$/ });

const Env = z.object({
  COMMS_PORT: z.coerce.number().int().positive().default(8080),
  /** Dominio público exacto (sin ruta ni "/" final). Twilio firma con él. */
  PUBLIC_BASE_URL: Url.refine((u) => new URL(u).pathname === "/" && !u.endsWith("/"), "solo el origen, sin ruta ni / final"),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  /** Sin él, los SMS salientes usan el stub (no se envía nada). */
  TWILIO_ACCOUNT_SID: z.string().optional().transform((v) => v || null),
  TWILIO_PHONE_NUMBER: PhoneE164,
  BACKEND_BASE_URL: Url,
  BACKEND_SERVICE_TOKEN: z.string().min(1),
  /** Todo lo que produce este servicio va marcado así; demo y producción no se mezclan. */
  IS_DEMO: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  DEFAULT_LANGUAGE: z.string().default("es"),
  /** Tope por llamada al backend dentro del webhook (Twilio corta a los 15 s; hacemos ≤ 2 llamadas). */
  SMS_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  /** Inactividad tras la que una conversación SMS se cierra (y se guarda como parcial si procede). */
  SMS_SESSION_IDLE_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  /** Cuánto se espera la respuesta a un seguimiento por SMS antes de registrar `no_response`. */
  FOLLOWUP_SMS_REPLY_WINDOW_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  /**
   * Lista blanca de demo (E.164 separados por comas): en demo solo se contacta
   * proactivamente a estos números (sección 17). Vacía = a nadie.
   */
  DEMO_ALLOWED_NUMBERS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((n) => n.trim()).filter(Boolean))
    .pipe(z.array(PhoneE164))
    .transform((list) => new Set(list)),
  // --- Agente de seguimiento (llamadas salientes de ElevenLabs vía Twilio) ---
  /** Sin los tres valores, las llamadas salientes usan el stub (no se llama a nadie). */
  ELEVENLABS_API_KEY: z.string().optional().transform((v) => v || null),
  ELEVENLABS_FOLLOWUP_AGENT_ID: z.string().optional().transform((v) => v || null),
  /** ID del número Twilio importado en ElevenLabs (Phone Numbers), no el número E.164. */
  ELEVENLABS_AGENT_PHONE_NUMBER_ID: z.string().optional().transform((v) => v || null),
  /** Secreto que ElevenLabs envía como `Authorization: Bearer …` a /v1/tools/*. Sin él, esas rutas responden 503. */
  ELEVENLABS_TOOL_SECRET: z.string().min(16, "mínimo 16 caracteres").optional().or(z.literal("")).transform((v) => v || null),
  /** Token con el que el worker del backend entrega `followup.due` (PROPUESTO). Sin él, esa ruta responde 503. */
  COMMS_SERVICE_TOKEN: z.string().min(16, "mínimo 16 caracteres").optional().or(z.literal("")).transform((v) => v || null),
  /** Sondeo de seguimientos vencidos como respaldo del evento; 0 lo desactiva. */
  FOLLOWUP_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  /** Intentos de llamada antes del SMS de respaldo (sección 17). */
  FOLLOWUP_CALL_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  /** Si no llega `submit_followup` en este plazo tras colocar la llamada, se registra `no_response`. */
  FOLLOWUP_CALL_RESULT_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  /** Espera tras un fallo transitorio de ElevenLabs al colocar la llamada. */
  FOLLOWUP_PLACEMENT_BACKOFF_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),
  /** Reintentos en segundo plano de una escritura no confirmada (máximo 3 intentos en total). */
  REPORT_RETRY_DELAYS_MS: z
    .string()
    .default("5000,30000")
    .transform((v) => v.split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 2)),
});

export type Config = z.infer<typeof Env>;

/** Valida el entorno al arrancar. El mensaje de error nombra variables, nunca valores. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida:\n${problems}`);
  }
  return parsed.data;
}
