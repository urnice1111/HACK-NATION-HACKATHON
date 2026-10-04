/**
 * Compatibilidad con los contratos publicados por el Integrante 3 (`contracts/schemas/*.json`,
 * generados desde `contracts/models.py` con `python -m contracts.export_schemas`).
 *
 *  - Respuestas: nuestros esquemas zod son estrictos, así que un campo de más o de menos en el
 *    backend rompe el cliente. Las claves deben coincidir exactamente.
 *  - Solicitudes: el backend rechaza campos desconocidos (`extra="forbid"`), así que todo lo que
 *    enviamos debe existir allí, y todo lo que exige debe estar en lo que enviamos.
 *  - Enums: lo que el backend puede devolver debe caber en el nuestro; lo que enviamos, en el suyo.
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
  FollowupResponseCreated,
  FollowupResponseRequest,
  OutboxEvent,
  PlotContext,
  ReportCreated,
  ReportDetail,
  ReportRequest,
} from "../src/contracts/index.ts";

const SCHEMAS_DIR = new URL("../../contracts/schemas/", import.meta.url);
const skip = existsSync(SCHEMAS_DIR) ? false : "no está contracts/schemas (repo del equipo)";

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

// Introspección mínima de zod 4: `def.type` y sus envoltorios.
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

/** Devuelve las diferencias encontradas, con la ruta del campo. */
function compare(zod: ZodLike, json: JsonSchema, defs: Record<string, JsonSchema>, mode: Mode, path: string): string[] {
  const z = unwrapZod(zod);
  const j = resolve(json, defs);
  const problems: string[] = [];

  if (z.def.type === "object" && z.def.shape) {
    const ours = Object.keys(z.def.shape).sort();
    const theirs = Object.keys(j.properties ?? {}).sort();
    if (mode === "response") {
      if (ours.join() !== theirs.join()) problems.push(`${path || "(raíz)"}: claves ${ours.join(",")} ≠ backend ${theirs.join(",")}`);
    } else {
      for (const key of ours) if (!theirs.includes(key)) problems.push(`${join(path, key)}: el backend no lo acepta (extra="forbid")`);
      for (const key of j.required ?? []) if (!ours.includes(key)) problems.push(`${join(path, key)}: el backend lo exige y no lo enviamos`);
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
    // Respuesta: todo lo que puede llegar debe caber en el nuestro. Solicitud: lo que enviamos debe caber en el suyo.
    const [inner, outer] = mode === "response" ? [theirs, ours] : [ours, theirs];
    const missing = inner.filter((v) => !outer.includes(v));
    if (missing.length > 0) problems.push(`${path}: valores ${missing.join(",")} no admitidos por el ${mode === "response" ? "cliente" : "backend"}`);
  }
  return problems;
}

function check(schema: z.ZodType, file: string, mode: Mode): void {
  const json = load(file);
  assert.deepEqual(compare(schema as unknown as ZodLike, json, json.$defs ?? {}, mode, ""), []);
}

describe("compatibilidad con contracts/ del backend", { skip }, () => {
  describe("respuestas que leemos (claves exactas)", () => {
    const pairs: [string, z.ZodType, string][] = [
      ["contact-resolution", ContactResolutionResponse, "ContactResolutionResponse"],
      ["plots/{id}/context", PlotContext, "PlotContext"],
      ["reports (201)", ReportCreated, "ReportCreated"],
      ["reports/{id}", ReportDetail, "ReportDetail"],
      ["consents", ConsentRecorded, "ConsentRecorded"],
      ["consents/revocations", ConsentRevoked, "ConsentRevoked"],
      ["followups/{id}/responses (10.4)", FollowupResponseCreated, "FollowUpResponseResult"],
      ["assessments (10.1)", AssessmentResponse, "AssessmentResponse"],
      ["error uniforme", ErrorBody, "ErrorResponse"],
      ["evento outbox (followup.due)", OutboxEvent, "OutboxEvent"],
    ];
    for (const [label, schema, file] of pairs) it(label, () => check(schema, file, "response"));
  });

  describe("solicitudes que enviamos (el backend prohíbe campos extra)", () => {
    const pairs: [string, z.ZodType, string][] = [
      ["contact-resolution", ContactResolutionRequest, "ContactResolutionRequest"],
      ["consents", ConsentRequest, "ConsentRequest"],
      ["consents/revocations", ConsentRevocationRequest, "ConsentRevocationRequest"],
      ["reports", ReportRequest, "ReportCreate"],
      ["followups/{id}/responses", FollowupResponseRequest, "FollowUpResponseRequest"],
      ["assessments", AssessmentRequest, "AssessmentRequest"],
    ];
    for (const [label, schema, file] of pairs) it(label, () => check(schema, file, "request"));
  });

  it("detecta divergencias en la raíz, anidadas y en enums (control de la propia prueba)", () => {
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
    assert.match(compare(ReportRequest as unknown as ZodLike, report, channelDefs, "request", "")[0] ?? "", /^channel: valores sms/);
  });
});
