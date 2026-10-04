/**
 * Utilidades para webhooks de Twilio, adaptadas de Marco (`server.js`):
 * validación de firma, URL pública de callback y respuestas TwiML.
 */
import twilio from "twilio";

/**
 * Twilio firma con la URL pública exacta que tiene configurada. Detrás de
 * ngrok o un proxy la petición llega como localhost, así que se reconstruye
 * con PUBLIC_BASE_URL + ruta (incluida la query string, si la hay).
 */
export function callbackUrl(publicBaseUrl: string, requestUrl: string): string {
  return new URL(requestUrl, publicBaseUrl).toString();
}

export function isValidTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

/** Cuerpo form-encoded de Twilio → objeto plano (Twilio no repite claves en SMS). */
export function formParams(raw: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `<Response><Message>…</Message></Response>`, o `<Response/>` si no hay que contestar. */
export function messageTwiml(text: string | null): string {
  const body = text ? `\n  <Message>${escapeXml(text)}</Message>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;
}
