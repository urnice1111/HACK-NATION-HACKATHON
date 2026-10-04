/**
 * Compatibility with the contracts published by Member 3 (`contracts/schemas/*.json`,
 * generated from `contracts/models.py` with `python -m contracts.export_schemas`).
 *
 *  - Responses: our zod schemas are strict, so one field too many or too few in the
 *    backend breaks the client. The keys must match exactly.
 *  - Requests: the backend rejects unknown fields (`extra="forbid"`), so everything we
 *    send must exist there, and everything it requires must be in what we send.
 *  - Enums: what the backend can return must fit in ours; what we send, in theirs.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { z } from "zod";

import {
  AssessmentRequest,
  AssessmentResponse,
  ConsentRecorded,
  ConsentRequest,
  ConsentRevocationRequest,
  ConsentRevoked,
  ContactResolutionRequest,
  ContactResolutionResponse,
  ErrorBody,
  FollowupAttemptRecorded,
  FollowupAttemptRequest,
  FollowupList,
  FollowupResponseCreated,
  FollowupResponseRequest,
  NotificationList,
  NotificationStatusRecorded,
  NotificationStatusUpdate,
  OutboxEvent,
  PlotContext,
  ReportCreated,
  ReportDetail,
  ReportRequest,
} from "../src/contracts/index.ts";

const SCHEMAS_DIR = new URL("../../contracts/schemas/", import.meta.url);
const skip = existsSync(SCHEMAS_DIR) ? false : "contracts/schemas is missing (team repo)";

type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
};

type Mode = "request" | "response";

// Minimal zod 4 introspection: `def.type` and its wrappers.
type ZodDef = {
  type: string;
  innerType?: ZodLike;
  in?: ZodLike;
  element?: ZodLike;
  shape?: Record<string, ZodLike>;
  entries?: Record<string, string>;
  values?: unknown[];
};
type ZodLike = { def: ZodDef };

function unwrapZod(schema: ZodLike): ZodLike {
  let current = schema;
  for (;;) {
    const { type } = current.def;
    if ((type === "nullable" || type === "optional" || type === "default" || type === "readonly") && current.def.innerType) {
      current = current.def.innerType;
    } else if (type === "pipe" && current.def.in) {
      current = current.def.in;
    } else {
      return current;
    }
  }
}

function zodEnum(schema: ZodLike): unknown[] | null {
  if (schema.def.type === "enum" && schema.def.entries) return Object.values(schema.def.entries);
  if (schema.def.type === "literal" && schema.def.values) return schema.def.values;
  return null;
}

function load(name: string): JsonSchema {
  return JSON.parse(readFileSync(new URL(`${name}.json`, SCHEMAS_DIR), "utf8")) as JsonSchema;
}

function resolve(node: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema {
  if (node.$ref) return resolve(defs[node.$ref.replace("#/$defs/", "")]!, defs);
  const branches = node.anyOf?.filter((b) => b.type !== "null");
  if (branches?.length === 1) return resolve(branches[0]!, defs);
  return node;
}

function jsonEnum(node: JsonSchema): unknown[] | null {
  if (node.enum) return node.enum;
  if (node.const !== undefined) return [node.const];
  return null;
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/** Returns the differences found, with the field path. */
function compare(zod: ZodLike, json: JsonSchema, defs: Record<string, JsonSchema>, mode: Mode, path: string): string[] {
  const z = unwrapZod(zod);
  const j = resolve(json, defs);
  const problems: string[] = [];

  if (z.def.type === "object" && z.def.shape) {
    const ours = Object.keys(z.def.shape).sort();
    const theirs = Object.keys(j.properties ?? {}).sort();
    if (mode === "response") {
      if (ours.join() !== theirs.join()) problems.push(`${path || "(root)"}: keys ${ours.join(",")} ≠ backend ${theirs.join(",")}`);
    } else {
      for (const key of ours) if (!theirs.includes(key)) problems.push(`${join(path, key)}: the backend doesn't accept it (extra="forbid")`);
      for (const key of j.required ?? []) if (!ours.includes(key)) problems.push(`${join(path, key)}: the backend requires it and we don't send it`);
    }
    for (const key of ours.filter((k) => theirs.includes(k))) {
      problems.push(...compare(z.def.shape[key]!, j.properties![key]!, defs, mode, join(path, key)));
    }
    return problems;
  }

  if (z.def.type === "array" && z.def.element && j.items) {
    return compare(z.def.element, j.items, defs, mode, `${path}[]`);
  }

  const ours = zodEnum(z);
  const theirs = jsonEnum(j);
  if (ours && theirs) {
    // Response: everything that can arrive must fit in ours. Request: what we send must fit in theirs.
    const [inner, outer] = mode === "response" ? [theirs, ours] : [ours, theirs];
    const missing = inner.filter((v) => !outer.includes(v));
    if (missing.length > 0) problems.push(`${path}: values ${missing.join(",")} not accepted by the ${mode === "response" ? "client" : "backend"}`);
  }
  return problems;
}

function check(schema: z.ZodType, file: string, mode: Mode): void {
  const json = load(file);
  assert.deepEqual(compare(schema as unknown as ZodLike, json, json.$defs ?? {}, mode, ""), []);
}

describe("compatibility with the backend's contracts/", { skip }, () => {
  describe("responses we read (exact keys)", () => {
    const pairs: [string, z.ZodType, string][] = [
      ["contact-resolution", ContactResolutionResponse, "ContactResolutionResponse"],
      ["plots/{id}/context", PlotContext, "PlotContext"],
      ["reports (201)", ReportCreated, "ReportCreated"],
      ["reports/{id}", ReportDetail, "ReportDetail"],
      ["consents", ConsentRecorded, "ConsentRecorded"],
      ["consents/revocations", ConsentRevoked, "ConsentRevoked"],
      ["followups (list with summary and contact)", FollowupList, "FollowupList"],
      ["followups/{id}/attempts", FollowupAttemptRecorded, "FollowupAttemptRecorded"],
      ["followups/{id}/responses (10.4)", FollowupResponseCreated, "FollowUpResponseResult"],
      ["assessments (10.1)", AssessmentResponse, "AssessmentResponse"],
      ["uniform error", ErrorBody, "ErrorResponse"],
      ["outbox event (followup.due)", OutboxEvent, "OutboxEvent"],
    ];
    for (const [label, schema, file] of pairs) it(label, () => check(schema, file, "response"));
  });

  describe("requests we send (the backend forbids extra fields)", () => {
    const pairs: [string, z.ZodType, string][] = [
      ["contact-resolution", ContactResolutionRequest, "ContactResolutionRequest"],
      ["consents", ConsentRequest, "ConsentRequest"],
      ["consents/revocations", ConsentRevocationRequest, "ConsentRevocationRequest"],
      ["reports", ReportRequest, "ReportCreate"],
      ["followups/{id}/attempts", FollowupAttemptRequest, "FollowupAttemptRequest"],
      ["followups/{id}/responses", FollowupResponseRequest, "FollowUpResponseRequest"],
      ["assessments", AssessmentRequest, "AssessmentRequest"],
    ];
    for (const [label, schema, file] of pairs) it(label, () => check(schema, file, "request"));
  });

  /**
   * Alert notifications (demo step 6): Member 3 implements them in parallel, so each check is
   * skipped until its schema is published. If the backend names them differently, rename them here.
   */
  describe("alert notifications (skipped until contracts/schemas publishes them)", () => {
    const pairs: [string, z.ZodType, string, Mode][] = [
      ["notifications (list with alert and contact)", NotificationList, "NotificationList", "response"],
      ["notifications/{id}/status (request)", NotificationStatusUpdate, "NotificationStatusUpdate", "request"],
      ["notifications/{id}/status (response)", NotificationStatusRecorded, "NotificationStatusRecorded", "response"],
    ];
    for (const [label, schema, file, mode] of pairs) {
      const missing = existsSync(new URL(`${file}.json`, SCHEMAS_DIR)) ? false : `contracts/schemas/${file}.json is not published yet`;
      it(label, { skip: missing }, () => check(schema, file, mode));
    }
  });

  it("detects divergences at the root, nested and in enums (self-check of the test)", () => {
    const created = load("ReportCreated");
    const extraField = { ...created, properties: { ...created.properties, extra_field: { type: "string" } } };
    assert.deepEqual(compare(ReportCreated as unknown as ZodLike, extraField, created.$defs ?? {}, "response", "").length, 1);

    const resolution = load("ContactResolutionResponse");
    const defs = structuredClone(resolution.$defs!);
    delete defs.ContactConsent!.properties!.consent_at;
    assert.match(compare(ContactResolutionResponse as unknown as ZodLike, resolution, defs, "response", "")[0] ?? "", /^confirmed\.consent:/);

    const report = load("ReportCreate");
    const channelDefs = structuredClone(report.$defs!);
    channelDefs.Channel!.enum = ["voice", "operator"];
    assert.match(compare(ReportRequest as unknown as ZodLike, report, channelDefs, "request", "")[0] ?? "", /^channel: values sms/);
  });
});
