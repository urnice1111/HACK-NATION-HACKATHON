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
        ["TWILIO_ACCOUNT_SID", "ELEVENLABS_API_KEY", "ELEVENLABS_HELP_AGENT_ID", "ELEVENLABS_FOLLOWUP_AGENT_ID", "ELEVENLABS_ALERT_AGENT_ID", "HELP_AGENT_TELEPHONE_ID", "FOLLOW_UP_AGENT_PHONE_ID", "ELEVENLABS_TOOL_SECRET", "COMMS_SERVICE_TOKEN"].every((k) =>
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
      ELEVENLABS_ALERT_AGENT_ID: "agent_alert",
      ELEVENLABS_AGENT_PHONE_NUMBER_ID: "phnum_1",
      ELEVENLABS_TOOL_SECRET: "tool-secret-0123456789",
      COMMS_SERVICE_TOKEN: "comms-token-0123456789",
    };
    assert.equal(loadConfig(production).IS_DEMO, false);
    assert.throws(() => loadConfig({ ...production, PUBLIC_BASE_URL: "http://comms.example.test" }), /PUBLIC_BASE_URL: must be https/);
  });

  it("advisor timeout and alert calls: defaults and validation", () => {
    const config = loadConfig(base);
    assert.equal(config.ADVISOR_TIMEOUT_MS, 10_000);
    assert.equal(config.ELEVENLABS_ALERT_AGENT_ID, null, "without the Alerts agent, alert calls are off");
    assert.equal(config.ALERT_POLL_INTERVAL_MS, 15_000);
    assert.equal(config.ALERT_CALL_ATTEMPTS, 3);
    assert.equal(config.ALERT_CALL_RESULT_TIMEOUT_MS, 120_000);
    assert.equal(loadConfig({ ...base, ADVISOR_TIMEOUT_MS: "12000", ALERT_POLL_INTERVAL_MS: "0" }).ALERT_POLL_INTERVAL_MS, 0);
    assert.throws(() => loadConfig({ ...base, ADVISOR_TIMEOUT_MS: "0" }), /ADVISOR_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ ...base, ALERT_CALL_ATTEMPTS: "9" }), /ALERT_CALL_ATTEMPTS/);
  });

  it("deployed: listens on PORT and on all interfaces when told so", () => {
    const local = loadConfig(base);
    assert.deepEqual([local.COMMS_PORT, local.COMMS_HOST], [8080, "127.0.0.1"]);
    const deployed = loadConfig({ ...base, PORT: "10000", COMMS_HOST: "0.0.0.0" });
    assert.deepEqual([deployed.COMMS_PORT, deployed.COMMS_HOST], [10000, "0.0.0.0"]);
    assert.equal(loadConfig({ ...base, PORT: "10000", COMMS_PORT: "8081" }).COMMS_PORT, 8081, "COMMS_PORT wins");
  });

  it("DEMO_IGNORE_ALLOWED_HOURS with IS_DEMO=false prevents startup", () => {
    assert.throws(() => loadConfig({ ...base, IS_DEMO: "false", DEMO_IGNORE_ALLOWED_HOURS: "true" }), /DEMO_IGNORE_ALLOWED_HOURS: only allowed with IS_DEMO=true/);
  });
});
