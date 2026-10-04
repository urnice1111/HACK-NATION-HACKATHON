/**
 * Las herramientas declaradas en `agents/<agente>/tools/*.json` (lo que se sube a ElevenLabs
 * con `npm run agents:sync`) deben coincidir con lo que aceptan las rutas `/v1/tools/*`.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import type { z } from "zod";

import {
  AssessObservationInput,
  ConfirmFarmerInput,
  GetPlotContextInput,
  RecordConsentInput,
  ResolveFarmerInput,
  SubmitFollowupInput,
  SubmitReportInput,
} from "../src/tools/voice-tools.ts";

const INPUTS: Record<string, z.ZodObject> = {
  resolve_farmer: ResolveFarmerInput,
  confirm_farmer: ConfirmFarmerInput,
  get_plot_context: GetPlotContextInput,
  record_consent: RecordConsentInput,
  assess_observation: AssessObservationInput,
  submit_report: SubmitReportInput,
  submit_followup: SubmitFollowupInput,
};

type Property = { type?: string; description?: string; dynamic_variable?: string; items?: Property; properties?: Record<string, Property>; required?: string[] };
type Tool = { type: string; name: string; api_schema: { url: string; method: string; request_body_schema: Property } };

const AGENTS_DIR = new URL("../agents/", import.meta.url);

/** ElevenLabs rechaza un campo sin descripción ni variable dinámica (también dentro de listas y objetos). */
function undocumented(property: Property, path: string): string[] {
  const own = property.type !== "object" && !property.description && !property.dynamic_variable ? [path] : [];
  const nested = Object.entries(property.properties ?? {}).flatMap(([k, v]) => undocumented(v, `${path}.${k}`));
  return [...own, ...nested, ...(property.items ? undocumented(property.items, `${path}[]`) : [])];
}

for (const agent of ["help", "followup"]) {
  describe(`herramientas del agente ${agent}`, () => {
    const dir = new URL(`${agent}/tools/`, AGENTS_DIR);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      it(file, () => {
        const tool = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Tool;
        const input = INPUTS[tool.name];
        assert.ok(input, `sin esquema para ${tool.name}`);
        assert.equal(tool.type, "webhook");
        assert.equal(tool.api_schema.method, "POST");
        assert.equal(new URL(tool.api_schema.url).pathname, `/v1/tools/${tool.name.replaceAll("_", "-")}`);

        const body = tool.api_schema.request_body_schema;
        const declared = Object.keys(body.properties ?? {});
        const accepted = Object.keys(input.shape);
        for (const key of declared) assert.ok(accepted.includes(key), `${key} no lo acepta la ruta`);
        // Lo que la ruta exige debe llegar siempre: obligatorio para el modelo o de una variable dinámica.
        for (const key of accepted.filter((k) => !input.shape[k]!.safeParse(undefined).success)) {
          const fromVariable = Boolean(body.properties?.[key]?.dynamic_variable);
          assert.ok(fromVariable || body.required?.includes(key), `${key} es obligatorio y no está en required`);
        }
        assert.ok(body.properties?.session_id?.dynamic_variable, "session_id sale de una variable, no del modelo");
        assert.deepEqual(undocumented(body, "body"), []);
      });
    }
  });
}
