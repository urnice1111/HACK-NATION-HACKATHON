import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";

const base = {
  PUBLIC_BASE_URL: "https://comms.example.test",
  TWILIO_AUTH_TOKEN: "t",
  TWILIO_PHONE_NUMBER: "+12025550999",
  BACKEND_BASE_URL: "http://127.0.0.1:8787",
  BACKEND_SERVICE_TOKEN: "s",
};

describe("configuración", () => {
  it("DEMO_IGNORE_ALLOWED_HOURS está apagado por defecto", () => {
    assert.equal(loadConfig(base).DEMO_IGNORE_ALLOWED_HOURS, false);
  });

  it("DEMO_IGNORE_ALLOWED_HOURS se acepta en demo", () => {
    assert.equal(loadConfig({ ...base, IS_DEMO: "true", DEMO_IGNORE_ALLOWED_HOURS: "true" }).DEMO_IGNORE_ALLOWED_HOURS, true);
  });

  it("backend real: el token de servicio es opcional y el asesor puede ir en otra URL", () => {
    const { BACKEND_SERVICE_TOKEN: _, ...withoutToken } = base;
    const config = loadConfig({ ...withoutToken, ADVISOR_BASE_URL: "http://127.0.0.1:8001" });
    assert.equal(config.BACKEND_SERVICE_TOKEN, null);
    assert.equal(config.ADVISOR_BASE_URL, "http://127.0.0.1:8001");
    assert.equal(loadConfig({ ...base, ADVISOR_BASE_URL: "" }).ADVISOR_BASE_URL, null, "vacío = BACKEND_BASE_URL");
    assert.throws(() => loadConfig({ ...base, ADVISOR_BASE_URL: "localhost:8001" }), /ADVISOR_BASE_URL/);
  });

  it("DEMO_IGNORE_ALLOWED_HOURS con IS_DEMO=false impide arrancar", () => {
    assert.throws(() => loadConfig({ ...base, IS_DEMO: "false", DEMO_IGNORE_ALLOWED_HOURS: "true" }), /DEMO_IGNORE_ALLOWED_HOURS: solo se permite con IS_DEMO=true/);
  });
});
