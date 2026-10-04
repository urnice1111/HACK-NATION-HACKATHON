/**
 * Validation of the agents that live in the ElevenLabs account (`npm run agents:check`
 * and server startup). The test agents are built from the reference copy in agents/
 * (`npm run agents:pull`), so this test also fails if that copy stops matching what
 * the `/v1/tools/*` routes accept.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import {
  AgentsApiError,
  URL_PLACEHOLDER,
  checkAgents,
  phonesFromEnv,
  snapshotFiles,
  type AgentRecord,
  type AgentRole,
  type AgentsApi,
  type PhoneNumberRecord,
} from "../src/elevenlabs/agents.ts";

const PUBLIC = "https://comms.example.test";
const IDS = { help: "agent_help", followup: "agent_followup", phone: "phnum_test" };
const AGENTS_DIR = new URL("../agents/", import.meta.url);

/** An agent as the API returns it, built from the reference copy in agents/<role>/. */
function agentFromSnapshot(role: AgentRole): AgentRecord {
  const read = (path: string) => readFileSync(new URL(`${role}/${path}`, AGENTS_DIR), "utf8");
  const meta = JSON.parse(read("agent.json"));
  const tools = readdirSync(new URL(`${role}/tools/`, AGENTS_DIR))
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const tool = JSON.parse(read(`tools/${f}`));
      tool.api_schema.url = tool.api_schema.url.replace(URL_PLACEHOLDER, PUBLIC);
      return tool;
    });
  return {
    agent_id: IDS[role],
    name: meta.name,
    conversation_config: {
      agent: {
        language: meta.language,
        first_message: read("first_message.txt"),
        prompt: { prompt: read("prompt.md"), llm: meta.llm, tools: [...tools, { type: "system", name: "end_call" }] },
        dynamic_variables: { dynamic_variable_placeholders: meta.dynamic_variable_placeholders },
      },
      tts: meta.tts,
    },
    platform_settings: { privacy: { record_voice: false, retention_days: 30 } },
  };
}

function fakeApi(overrides: { agents?: Partial<Record<string, AgentRecord>>; phone?: Partial<PhoneNumberRecord>; down?: boolean } = {}): AgentsApi {
  const agents: Record<string, AgentRecord> = { [IDS.help]: agentFromSnapshot("help"), [IDS.followup]: agentFromSnapshot("followup"), ...overrides.agents } as Record<string, AgentRecord>;
  return {
    async getAgent(id) {
      if (overrides.down) throw new AgentsApiError(null, "ElevenLabs did not respond");
      const agent = agents[id];
      if (!agent) throw new AgentsApiError(404, "not found");
      return agent;
    },
    async getPhoneNumber(id) {
      if (id !== IDS.phone) throw new AgentsApiError(404, "not found");
      return { phone_number_id: id, supports_inbound: true, supports_outbound: true, assigned_agent: { agent_id: IDS.help }, ...overrides.phone };
    },
  };
}

const config = {
  helpAgentId: IDS.help,
  followupAgentId: IDS.followup,
  phones: phonesFromEnv((name) => ({ ELEVENLABS_AGENT_PHONE_NUMBER_ID: IDS.phone })[name]),
  publicBaseUrl: PUBLIC,
};

/** Deep copy of an agent to alter it in a test. */
function variant(role: AgentRole, change: (agent: AgentRecord) => void): AgentRecord {
  const agent = structuredClone(agentFromSnapshot(role));
  change(agent);
  return agent;
}

describe("ElevenLabs agents: check", () => {
  it("the reference copy in agents/ is ready for this code", async () => {
    const result = await checkAgents(fakeApi(), config);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.unreachable, []);
    assert.deepEqual(Object.keys(result.agents).sort(), ["followup", "help"]);
  });

  it("detects misconfigured tools", async () => {
    const help = variant("help", (agent) => {
      const tools = agent.conversation_config.agent.prompt.tools!;
      tools.splice(tools.findIndex((t) => t.name === "record_consent"), 1);
      const resolve = tools.find((t) => t.name === "resolve_farmer")!;
      resolve.api_schema!.url = "https://other-ngrok.example/v1/tools/resolve-farmer";
      resolve.api_schema!.request_headers = {};
      resolve.api_schema!.request_body_schema!.properties!.session_id = { type: "string", description: "id" };
      resolve.api_schema!.request_body_schema!.properties!.plot_id = { type: "string", description: "plot" };
    });
    const { problems } = await checkAgents(fakeApi({ agents: { [IDS.help]: help } }), config);
    const text = problems.join("\n");
    assert.match(text, /missing the tool record_consent/);
    assert.match(text, /resolve_farmer: the URL points to https:\/\/other-ngrok\.example/);
    assert.match(text, /resolve_farmer: missing the Authorization header/);
    assert.match(text, /resolve_farmer: session_id must come from the dynamic variable system__conversation_id/);
    assert.match(text, /resolve_farmer: communications doesn't accept the parameter plot_id/);
  });

  it("detects recording, language, unknown variables and missing hang-up", async () => {
    const followup = variant("followup", (agent) => {
      agent.platform_settings = { privacy: { record_voice: true, retention_days: -1 } };
      agent.conversation_config.agent.language = "es";
      agent.conversation_config.agent.first_message = "Hi {{program_name}}, am I speaking with {{farmer_name}}?";
      agent.conversation_config.agent.prompt.tools = agent.conversation_config.agent.prompt.tools!.filter((t) => t.name !== "end_call");
    });
    const { problems } = await checkAgents(fakeApi({ agents: { [IDS.followup]: followup } }), config);
    const text = problems.join("\n");
    assert.match(text, /records audio/);
    assert.match(text, /keeps conversations forever/);
    assert.match(text, /language "es"/);
    assert.match(text, /\{\{program_name\}\}/);
    assert.doesNotMatch(text, /\{\{farmer_name\}\}/, "the dispatcher does send farmer_name");
    assert.match(text, /end_call/);
  });

  it("number: must answer with the help agent and allow outbound calls; missing or unknown IDs", async () => {
    const wrongNumber = await checkAgents(fakeApi({ phone: { assigned_agent: { agent_id: "agent_marco" }, supports_outbound: false } }), config);
    assert.match(wrongNumber.problems.join("\n"), /aren't answered by the help agent/);
    assert.match(wrongNumber.problems.join("\n"), /doesn't support outbound calls/);

    const missing = await checkAgents(fakeApi(), { ...config, helpAgentId: null, followupAgentId: "agent_deleted" });
    assert.match(missing.problems.join("\n"), /ELEVENLABS_HELP_AGENT_ID is missing/);
    assert.match(missing.problems.join("\n"), /ELEVENLABS_FOLLOWUP_AGENT_ID=agent_deleted doesn't exist/);
  });

  it("two numbers: the help one answers with the help agent; the follow-up one calls and doesn't answer with its own agent", async () => {
    const numbers: Record<string, PhoneNumberRecord> = {
      phnum_help: { phone_number_id: "phnum_help", phone_number: "+19373588143", supports_inbound: true, supports_outbound: true, assigned_agent: { agent_id: IDS.help } },
      phnum_fu: { phone_number_id: "phnum_fu", phone_number: "+14024486040", supports_inbound: true, supports_outbound: true, assigned_agent: { agent_id: IDS.followup } },
    };
    const api: AgentsApi = { getAgent: fakeApi().getAgent, getPhoneNumber: async (id) => numbers[id]! };
    const env: Record<string, string> = {
      HELP_AGENT_TELEPHONE_ID: "phnum_help",
      HELP_AGENT_TELEPHONE: "+19373588143",
      FOLLOW_UP_AGENT_PHONE_ID: "phnum_fu",
      FOLLOW_UP_AGENT_PHONE: "+14020000000",
    };
    const { problems } = await checkAgents(api, { ...config, phones: phonesFromEnv((name) => env[name]) });
    assert.deepEqual(problems.map((p) => p.split(":")[0]), ["follow-up number", "follow-up number"]);
    assert.match(problems.join("\n"), /FOLLOW_UP_AGENT_PHONE_ID is \+14024486040, not \+14020000000/);
    assert.match(problems.join("\n"), /assign the help agent/);

    numbers.phnum_fu!.assigned_agent = { agent_id: IDS.help };
    env.FOLLOW_UP_AGENT_PHONE = "+14024486040";
    assert.deepEqual((await checkAgents(api, { ...config, phones: phonesFromEnv((name) => env[name]) })).problems, []);
  });

  it("ElevenLabs down: not mistaken for a wrong configuration", async () => {
    const result = await checkAgents(fakeApi({ down: true }), config);
    assert.equal(result.unreachable.length, 2);
    assert.ok(!result.problems.some((p) => p.includes("agent")));
  });

  it("the reference copy stores neither the public domain nor secret IDs", () => {
    const files = snapshotFiles(variant("help", (agent) => {
      agent.conversation_config.agent.prompt.tools![0]!.api_schema!.request_headers = { Authorization: { secret_id: "REAL_SECRET" } };
    }));
    const all = Object.values(files).join("\n");
    assert.doesNotMatch(all, /comms\.example\.test|REAL_SECRET/);
    assert.ok(files["tools/resolve_farmer.json"]?.includes(URL_PLACEHOLDER));
  });
});
