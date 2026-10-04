/**
 * Twilio webhook utilities, adapted from Marco (`server.js`):
 * signature validation, public callback URL and TwiML replies.
 */
import twilio from "twilio";

/**
 * Twilio signs with the exact public URL it has configured. Behind ngrok or
 * a proxy the request arrives as localhost, so it is rebuilt from
 * PUBLIC_BASE_URL + path (including the query string, if any).
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

/** Twilio form-encoded body → plain object (Twilio doesn't repeat keys in SMS). */
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

/** `<Response><Message>…</Message></Response>`, or `<Response/>` when there's nothing to reply. */
export function messageTwiml(text: string | null): string {
  const body = text ? `\n  <Message>${escapeXml(text)}</Message>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;
}
