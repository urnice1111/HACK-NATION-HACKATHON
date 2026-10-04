/**
 * Normaliza a E.164. Twilio ya entrega `From`/`To` en E.164 para SMS y voz;
 * esto solo tolera espacios, guiones, paréntesis y el prefijo internacional 00.
 * Un número sin código de país no se adivina: devuelve null.
 */
export function normalizeE164(value: string | null | undefined): string | null {
  if (!value) return null;
  let compact = value.trim().replace(/[\s\-().]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;
  return /^\+[1-9]\d{1,14}$/.test(compact) ? compact : null;
}
