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

describe("configuration", () => {
  it("DEMO_IGNORE_ALLOWED_HOURS is off by default", () => {
    assert.equal(loadConfig(base).DEMO_IGNORE_ALLOWED_HOURS, false);
  });

  it("DEMO_IGNORE_ALLOWED_HOURS is accepted in demo", () => {
    assert.equal(loadConfig({ ...base, IS_DEMO: "true", DEMO_IGNORE_ALLOWED_HOURS: "true" }).DEMO_IGNORE_ALLOWED_HOURS, true);
  });

  it("real backend: the service token is optional and the advisor can live at another URL", () => {
    const { BACKEND_SERVICE_TOKEN: _, ...withoutToken } = base;
    const config = loadConfig({ ...withoutToken, ADVISOR_BASE_URL: "http://127.0.0.1:8001" });
    assert.equal(config.BACKEND_SERVICE_TOKEN, null);
    assert.equal(config.ADVISOR_BASE_URL, "http://127.0.0.1:8001");
    assert.equal(loadConfig({ ...base, ADVISOR_BASE_URL: "" }).ADVISOR_BASE_URL, null, "empty = BACKEND_BASE_URL");
    assert.throws(() => loadConfig({ ...base, ADVISOR_BASE_URL: "localhost:8001" }), /ADVISOR_BASE_URL/);
  });

  it("production (IS_DEMO=false): requires credentials and agents; no stubs", () => {
    assert.throws(
      () => loadConfig({ ...base, IS_DEMO: "false" }),
      (error: Error) =>
        ["TWILIO_ACCOUNT_SID", "ELEVENLABS_API_KEY", "ELEVENLABS_HELP_AGENT_ID", "ELEVENLABS_FOLLOWUP_AGENT_ID", "HELP_AGENT_TELEPHONE_ID", "FOLLOW_UP_AGENT_PHONE_ID", "ELEVENLABS_TOOL_SECRET", "COMMS_SERVICE_TOKEN"].every((k) =>
          error.message.includes(`${k}: required with IS_DEMO=false`),
        ),
    );
    const production = {
      ...base,
      IS_DEMO: "false",
      TWILIO_ACCOUNT_SID: "AC123",
      ELEVENLABS_API_KEY: "k",
      ELEVENLABS_HELP_AGENT_ID: "agent_help",
      ELEVENLABS_FOLLOWUP_AGENT_ID: "agent_followup",
      ELEVENLABS_AGENT_PHONE_NUMBER_ID: "phnum_1",
      ELEVENLABS_TOOL_SECRET: "tool-secret-0123456789",
      COMMS_SERVICE_TOKEN: "comms-token-0123456789",
    };
    assert.equal(loadConfig(production).IS_DEMO, false);
    assert.throws(() => loadConfig({ ...production, PUBLIC_BASE_URL: "http://comms.example.test" }), /PUBLIC_BASE_URL: must be https/);
  });

  it("DEMO_IGNORE_ALLOWED_HOURS with IS_DEMO=false prevents startup", () => {
    assert.throws(() => loadConfig({ ...base, IS_DEMO: "false", DEMO_IGNORE_ALLOWED_HOURS: "true" }), /DEMO_IGNORE_ALLOWED_HOURS: only allowed with IS_DEMO=true/);
  });
});
