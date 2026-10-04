/**
 * ElevenLabs post-call webhook (`POST /v1/webhooks/elevenlabs/post-call`). It is verified with
 * ElevenLabs' HMAC, not with Twilio's signature or the operator token:
 *
 *   ElevenLabs-Signature: t=<unix seconds>,v0=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Only the conversation ID and the event type are read: transcripts are data and are not
 * stored or logged here (section 12).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Older signatures are rejected (replays). */
const MAX_AGE_SECONDS = 30 * 60;

export function isValidElevenLabsSignature(secret: string, header: string | null, rawBody: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  const signature = parts.v0;
  if (!Number.isInteger(timestamp) || !signature) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > MAX_AGE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Only what communications uses; the rest of the payload (transcript, analysis) is ignored. */
export const PostCallEvent = z.looseObject({
  type: z.string().min(1),
  data: z.looseObject({ conversation_id: z.string().min(1) }),
});

export type PostCallEvent = z.infer<typeof PostCallEvent>;

/** Signs a body like ElevenLabs does (tests and local checks). */
export function signElevenLabsBody(secret: string, rawBody: string, nowMs = Date.now()): string {
  const timestamp = Math.floor(nowMs / 1000);
  return `t=${timestamp},v0=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}
