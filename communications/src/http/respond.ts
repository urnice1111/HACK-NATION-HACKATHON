import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import type { ErrorBody, ErrorDetail } from "../contracts/index.ts";

const MAX_BODY_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Propagates `X-Request-Id` when it is safe; otherwise generates one (section 8). */
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

/** Error with the uniform `{"error": {...}}` shape and its HTTP status. */
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
        reject(new HttpError(400, "PAYLOAD_TOO_LARGE", "Request body exceeds the allowed size"));
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
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

/** Compares `Authorization: Bearer <token>` in constant time. */
export function bearerMatches(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Validates a body against its schema; on failure, 422 with the uniform error's `details[]`. */
export function parseBody<T extends z.ZodType>(schema: T, raw: unknown, message = "Request body does not match the v2 contract"): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(422, "VALIDATION_ERROR", message, { details: validationDetails(result.error) });
  return result.data;
}

/**
 * zod errors → `details[]`, with paths like `measurements[0].unit` (section 8).
 * Never includes the received value: it could be a phone number or part of a transcript.
 */
function validationDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ field: formatPath([...issue.path, key]), reason: "unrecognized" }));
    }
    const missing = issue.code === "invalid_type" && /received undefined/.test(issue.message);
    return [{ field: formatPath(issue.path), reason: missing ? "required" : issue.code }];
  });
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) out += typeof segment === "number" ? `[${segment}]` : out ? `.${String(segment)}` : String(segment);
  return out || "(body)";
}
