/**
 * Normalizes to E.164. Twilio already delivers `From`/`To` in E.164 for SMS and voice;
 * this only tolerates spaces, dashes, parentheses and the 00 international prefix.
 * A number without a country code is never guessed: returns null.
 */
export function normalizeE164(value: string | null | undefined): string | null {
  if (!value) return null;
  let compact = value.trim().replace(/[\s\-().]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;
  return /^\+[1-9]\d{1,14}$/.test(compact) ? compact : null;
}
