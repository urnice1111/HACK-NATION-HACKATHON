/** Version attached to every log line (section 12). */
const SERVICE_VERSION = process.env.SERVICE_VERSION ?? "communications-0.1.0";

/** "+12025550101" → "+1******0101". A full phone number is never logged. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  const prefix = phone.startsWith("+") ? `+${digits.slice(0, 1)}` : "";
  const hidden = digits.length - 4 - (prefix ? 1 : 0);
  return `${prefix}${"*".repeat(Math.max(hidden, 0))}${digits.slice(-4)}`;
}

export interface LogFields {
  request_id?: string;
  correlation_id?: string | null;
  event_id?: string;
  duration_ms?: number;
  outcome?: string;
  [key: string]: unknown;
}

/** Structured log as one JSON line. Callers mask personal data first. */
export function log(level: "info" | "warn" | "error", message: string, fields: LogFields = {}): void {
  if (process.env.LOG_SILENT === "1") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, version: SERVICE_VERSION, ...fields });
  (level === "error" ? console.error : console.log)(line);
}
