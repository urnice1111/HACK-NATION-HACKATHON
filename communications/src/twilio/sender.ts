/**
 * Outbound SMS sending, adapted from Marco (`notifications/sendSms.ts`).
 * Returns the `sid` as `provider_reference` and the provider's initial
 * status. A timeout or network error is ambiguous: never blindly resent
 * (section 11); the caller reconciles before sending again.
 *
 * Without credentials the stub is used (like Marco's `status: "stubbed"`),
 * to test the flow without credits or real phones.
 */
import { randomUUID } from "node:crypto";
import twilio from "twilio";

export type SendResult =
  | { ok: true; provider_reference: string; provider_status: string; stubbed: boolean }
  /** rejected: the provider answered with an error. ambiguous: unknown whether it went out. */
  | { ok: false; kind: "rejected" | "ambiguous"; code: string; retryable: boolean };

export interface SmsSender {
  send(to: string, body: string): Promise<SendResult>;
}

export interface TwilioSmsSenderOptions {
  accountSid: string;
  authToken: string;
  from: string;
  /** `${PUBLIC_BASE_URL}/v1/webhooks/twilio/status`, once that webhook exists. */
  statusCallbackUrl: string | null;
  timeoutMs?: number;
}

/** Twilio codes that are never retried: invalid number, not mobile or opted out (STOP). */
const PERMANENT_TWILIO_CODES = new Set([21211, 21214, 21408, 21610, 21612, 21614]);

export class TwilioSmsSender implements SmsSender {
  private readonly client: ReturnType<typeof twilio>;

  constructor(private readonly options: TwilioSmsSenderOptions) {
    this.client = twilio(options.accountSid, options.authToken, { timeout: options.timeoutMs ?? 8000 });
  }

  async send(to: string, body: string): Promise<SendResult> {
    try {
      const message = await this.client.messages.create({
        from: this.options.from,
        to,
        body,
        ...(this.options.statusCallbackUrl ? { statusCallback: this.options.statusCallbackUrl } : {}),
      });
      return { ok: true, provider_reference: message.sid, provider_status: message.status, stubbed: false };
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      if (typeof status !== "number") return { ok: false, kind: "ambiguous", code: "PROVIDER_TIMEOUT", retryable: true };
      const permanent = typeof code === "number" && PERMANENT_TWILIO_CODES.has(code);
      return {
        ok: false,
        kind: "rejected",
        code: typeof code === "number" ? `TWILIO_${code}` : `HTTP_${status}`,
        retryable: !permanent && (status === 429 || status >= 500),
      };
    }
  }
}

/** Records messages in memory; sends nothing. */
export class StubSmsSender implements SmsSender {
  readonly sent: { to: string; body: string; provider_reference: string }[] = [];
  next: SendResult | null = null;

  async send(to: string, body: string): Promise<SendResult> {
    if (this.next) {
      const result = this.next;
      this.next = null;
      return result;
    }
    const provider_reference = `SMstub${randomUUID().replace(/-/g, "")}`;
    this.sent.push({ to, body, provider_reference });
    return { ok: true, provider_reference, provider_status: "stubbed", stubbed: true };
  }
}
