import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorBody, ErrorDetail } from "../contracts/index.ts";

const MAX_BODY_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Propaga `X-Request-Id` si es seguro; si no, genera uno (sección 8). */
export function requestIdFrom(req: IncomingMessage): string {
  const incoming = req.headers["x-request-id"];
  return typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : `req_${randomUUID()}`;
}

export function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function safeIdHeader(req: IncomingMessage, name: string): string | null {
  const value = headerValue(req, name);
  return value && SAFE_ID.test(value) ? value : null;
}

/** Error con la forma uniforme `{"error": {...}}` y su código HTTP. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: ErrorDetail[];

  constructor(status: number, code: string, message: string, options: { retryable?: boolean; details?: ErrorDetail[] } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
  }

  toBody(requestId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        request_id: requestId,
        details: this.details,
      },
    };
  }
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(400, "PAYLOAD_TOO_LARGE", "El cuerpo excede el tamaño permitido"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "El cuerpo no es JSON válido");
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

/** Compara `Authorization: Bearer <token>` en tiempo constante. */
export function bearerMatches(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
