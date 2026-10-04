import { z } from "zod";
import { PhoneE164 } from "./contracts/index.ts";

const Url = z.url({ protocol: /^https?$/ });
const Flag = (fallback: "true" | "false") => z.enum(["true", "false"]).default(fallback).transform((v) => v === "true");
/** Vacío o ausente → null. */
const Optional = z.string().optional().transform((v) => v || null);
const Secret = z.string().min(16, "mínimo 16 caracteres").optional().or(z.literal("")).transform((v) => v || null);
const Ms = (fallback: number) => z.coerce.number().int().positive().default(fallback);
/** "a, b,c" → ["a", "b", "c"]. */
const List = (fallback = "") => z.string().default(fallback).transform((v) => v.split(",").map((n) => n.trim()).filter(Boolean));

const PRODUCTION_REQUIRED = [
  "TWILIO_ACCOUNT_SID",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_HELP_AGENT_ID",
  "ELEVENLABS_FOLLOWUP_AGENT_ID",
  "ELEVENLABS_TOOL_SECRET",
  "COMMS_SERVICE_TOKEN",
] as const;

const Env = z
  .object({
    COMMS_PORT: z.coerce.number().int().positive().default(8080),
    /** Dominio público exacto (sin ruta ni "/" final). Twilio firma con él. */
    PUBLIC_BASE_URL: Url.refine((u) => new URL(u).pathname === "/" && !u.endsWith("/"), "solo el origen, sin ruta ni / final"),
    TWILIO_AUTH_TOKEN: z.string().min(1),
    /** Sin él, los SMS salientes usan el stub (no se envía nada). */
    TWILIO_ACCOUNT_SID: Optional,
    TWILIO_PHONE_NUMBER: PhoneE164,
    BACKEND_BASE_URL: Url,
    /** El backend real aún no exige token (el mock sí); sin él no se envía `Authorization`. */
    BACKEND_SERVICE_TOKEN: Optional,
    /** El asesor del Integrante 2 es otro servicio (`advisor/`); vacío = BACKEND_BASE_URL (el mock sirve ambos). */
    ADVISOR_BASE_URL: Url.optional().or(z.literal("")).transform((v) => v || null),
    /** Tope de las herramientas de voz, que esperan una evaluación (≤ 5 s) y el guardado. */
    BACKEND_TIMEOUT_MS: Ms(8000),
    /** Todo lo que produce este servicio va marcado así; demo y producción no se mezclan. */
    IS_DEMO: Flag("true"),
    /** Solo demo: contactar fuera de 08:00–19:00 para probar de noche. Consentimiento y lista blanca se siguen exigiendo. */
    DEMO_IGNORE_ALLOWED_HOURS: Flag("false"),
    DEFAULT_LANGUAGE: z.string().default("es"),
    /** Tope por llamada al backend dentro del webhook (Twilio corta a los 15 s; hacemos ≤ 2 llamadas). */
    SMS_STEP_TIMEOUT_MS: Ms(4000),
    /** Inactividad tras la que una llamada de ayuda se da por cortada: lo descrito con permiso se guarda como parcial. */
    VOICE_SESSION_IDLE_MS: Ms(15 * 60 * 1000),
    /** Inactividad tras la que una conversación SMS se cierra (y se guarda como parcial si procede). */
    SMS_SESSION_IDLE_MS: Ms(30 * 60 * 1000),
    /** Cuánto se espera la respuesta a un seguimiento por SMS antes de registrar `no_response`. */
    FOLLOWUP_SMS_REPLY_WINDOW_MS: Ms(24 * 60 * 60 * 1000),
    /** Lista blanca de demo (E.164 separados por comas): en demo solo se contacta a estos números. Vacía = a nadie. */
    DEMO_ALLOWED_NUMBERS: List().pipe(z.array(PhoneE164)).transform((list) => new Set(list)),
    // --- Agentes de ElevenLabs: se crean en el panel y aquí solo se referencian (ver agents/README.md) ---
    /** Sin la clave, el ID del agente de seguimiento y el del número, las llamadas salientes usan el stub. */
    ELEVENLABS_API_KEY: Optional,
    /** Agente de ayuda (llamadas entrantes). Solo se usa para comprobar su configuración al arrancar. */
    ELEVENLABS_HELP_AGENT_ID: Optional,
    ELEVENLABS_FOLLOWUP_AGENT_ID: Optional,
    /** Un solo número para ambos agentes: su ID en ElevenLabs (Phone Numbers), no el E.164. Con dos números, usa los de abajo. */
    ELEVENLABS_AGENT_PHONE_NUMBER_ID: Optional,
    /** Número que contesta las llamadas entrantes (agente de ayuda): E.164 y su ID en ElevenLabs. */
    HELP_AGENT_TELEPHONE: PhoneE164.optional().or(z.literal("")).transform((v) => v || null),
    HELP_AGENT_TELEPHONE_ID: Optional,
    /** Número desde el que llama el agente de seguimiento: E.164 y su ID en ElevenLabs. */
    FOLLOW_UP_AGENT_PHONE: PhoneE164.optional().or(z.literal("")).transform((v) => v || null),
    FOLLOW_UP_AGENT_PHONE_ID: Optional,
    /** Secreto que ElevenLabs envía como `Authorization: Bearer …` a /v1/tools/*. Sin él, esas rutas responden 503. */
    ELEVENLABS_TOOL_SECRET: Secret,
    /** Token con el que el worker del backend entrega `followup.due` (PROPUESTO). Sin él, esa ruta responde 503. */
    COMMS_SERVICE_TOKEN: Secret,
    /** Sondeo de seguimientos vencidos como respaldo del evento; 0 lo desactiva. */
    FOLLOWUP_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
    /** Intentos de llamada antes del SMS de respaldo (sección 17). */
    FOLLOWUP_CALL_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
    /** Si no llega `submit_followup` en este plazo tras colocar la llamada, se registra `no_response`. */
    FOLLOWUP_CALL_RESULT_TIMEOUT_MS: Ms(10 * 60 * 1000),
    /** Espera tras un fallo transitorio de ElevenLabs al colocar la llamada. */
    FOLLOWUP_PLACEMENT_BACKOFF_MS: Ms(2 * 60 * 1000),
    /** Reintentos en segundo plano de una escritura no confirmada (máximo 3 intentos en total). */
    REPORT_RETRY_DELAYS_MS: List("5000,30000").transform((list) => list.map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 2)),
  })
  .refine((env) => env.IS_DEMO || !env.DEMO_IGNORE_ALLOWED_HOURS, {
    path: ["DEMO_IGNORE_ALLOWED_HOURS"],
    message: "solo se permite con IS_DEMO=true",
  })
  .superRefine((env, ctx) => {
    // Producción: nada de stubs ni rutas sin credenciales; todo lo que llama o escribe debe estar configurado.
    if (env.IS_DEMO) return;
    for (const key of PRODUCTION_REQUIRED) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "obligatorio con IS_DEMO=false" });
    }
    for (const key of ["HELP_AGENT_TELEPHONE_ID", "FOLLOW_UP_AGENT_PHONE_ID"] as const) {
      if (!env[key] && !env.ELEVENLABS_AGENT_PHONE_NUMBER_ID) {
        ctx.addIssue({ code: "custom", path: [key], message: "obligatorio con IS_DEMO=false (o ELEVENLABS_AGENT_PHONE_NUMBER_ID si es un solo número)" });
      }
    }
    if (!env.PUBLIC_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "debe ser https con IS_DEMO=false" });
    }
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
