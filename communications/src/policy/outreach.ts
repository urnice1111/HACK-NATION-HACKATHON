/**
 * Reglas para contactar de forma proactiva (seguimientos y avisos), sección 17:
 * consentimiento explícito, horario permitido en la hora local del agricultor
 * (08:00–19:00 por defecto) y, en demo, solo números de la lista blanca.
 * Fuera de horario el trabajo espera; nunca se fuerza.
 */
export const DEFAULT_ALLOWED_HOURS = { start: "08:00", end: "19:00" } as const;

export type OutreachDecision =
  | { ok: true }
  | { ok: false; reason: "no_consent" | "outside_hours" | "not_allowlisted" };

export interface OutreachInput {
  phone_e164: string;
  timezone: string;
  allowed_hours: { start: string; end: string } | null;
  consent: boolean;
  now: Date;
  isDemo: boolean;
  /** Lista blanca de demo; vacía = no se contacta a nadie. */
  demoAllowlist: ReadonlySet<string>;
}

function minutes(hhmm: string): number | null {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutos desde medianoche en la zona del agricultor. */
function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
}

export function isWithinAllowedHours(now: Date, timezone: string, hours: { start: string; end: string } | null): boolean {
  const window = hours ?? DEFAULT_ALLOWED_HOURS;
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start === null || end === null) return false;
  const current = localMinutes(now, timezone);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export function canContact(input: OutreachInput): OutreachDecision {
  if (!input.consent) return { ok: false, reason: "no_consent" };
  if (input.isDemo && !input.demoAllowlist.has(input.phone_e164)) return { ok: false, reason: "not_allowlisted" };
  if (!isWithinAllowedHours(input.now, input.timezone, input.allowed_hours)) return { ok: false, reason: "outside_hours" };
  return { ok: true };
}
