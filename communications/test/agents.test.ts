/**
 * Validación de los agentes que viven en la cuenta de ElevenLabs (`npm run agents:check`
 * y el arranque del servidor). Los agentes de prueba se arman con la copia de referencia
 * de agents/ (`npm run agents:pull`), así que esta prueba también falla si esa copia
 * deja de coincidir con lo que aceptan las rutas `/v1/tools/*`.
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

/** Un agente como lo devuelve la API, armado con la copia de referencia de agents/<rol>/. */
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
      if (overrides.down) throw new AgentsApiError(null, "ElevenLabs no respondió");
      const agent = agents[id];
      if (!agent) throw new AgentsApiError(404, "no existe");
      return agent;
    },
    async getPhoneNumber(id) {
      if (id !== IDS.phone) throw new AgentsApiError(404, "no existe");
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

/** Copia profunda de un agente para alterarlo en una prueba. */
function variant(role: AgentRole, change: (agent: AgentRecord) => void): AgentRecord {
  const agent = structuredClone(agentFromSnapshot(role));
  change(agent);
  return agent;
}

describe("agentes de ElevenLabs: comprobación", () => {
  it("la copia de referencia de agents/ está lista para este código", async () => {
    const result = await checkAgents(fakeApi(), config);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.unreachable, []);
    assert.deepEqual(Object.keys(result.agents).sort(), ["followup", "help"]);
  });

  it("detecta herramientas mal configuradas", async () => {
    const help = variant("help", (agent) => {
      const tools = agent.conversation_config.agent.prompt.tools!;
      tools.splice(tools.findIndex((t) => t.name === "record_consent"), 1);
      const resolve = tools.find((t) => t.name === "resolve_farmer")!;
      resolve.api_schema!.url = "https://otro-ngrok.example/v1/tools/resolve-farmer";
      resolve.api_schema!.request_headers = {};
      resolve.api_schema!.request_body_schema!.properties!.session_id = { type: "string", description: "id" };
      resolve.api_schema!.request_body_schema!.properties!.plot_id = { type: "string", description: "parcela" };
    });
    const { problems } = await checkAgents(fakeApi({ agents: { [IDS.help]: help } }), config);
    const text = problems.join("\n");
    assert.match(text, /falta la herramienta record_consent/);
    assert.match(text, /resolve_farmer: la URL apunta a https:\/\/otro-ngrok\.example/);
    assert.match(text, /resolve_farmer: falta la cabecera Authorization/);
    assert.match(text, /resolve_farmer: session_id debe venir de la variable dinámica system__conversation_id/);
    assert.match(text, /resolve_farmer: el parámetro plot_id no lo acepta comunicaciones/);
  });

  it("detecta grabación, idioma, variables desconocidas y colgar ausente", async () => {
    const followup = variant("followup", (agent) => {
      agent.platform_settings = { privacy: { record_voice: true, retention_days: -1 } };
      agent.conversation_config.agent.language = "en";
      agent.conversation_config.agent.first_message = "Hola {{program_name}}, ¿hablo con {{farmer_name}}?";
      agent.conversation_config.agent.prompt.tools = agent.conversation_config.agent.prompt.tools!.filter((t) => t.name !== "end_call");
    });
    const { problems } = await checkAgents(fakeApi({ agents: { [IDS.followup]: followup } }), config);
    const text = problems.join("\n");
    assert.match(text, /graba audio/);
    assert.match(text, /guarda las conversaciones para siempre/);
    assert.match(text, /idioma "en"/);
    assert.match(text, /\{\{program_name\}\}/);
    assert.doesNotMatch(text, /\{\{farmer_name\}\}/, "farmer_name sí lo envía el despachador");
    assert.match(text, /end_call/);
  });

  it("número: debe contestar con el agente de ayuda y admitir salientes; IDs faltantes o inexistentes", async () => {
    const wrongNumber = await checkAgents(fakeApi({ phone: { assigned_agent: { agent_id: "agent_marco" }, supports_outbound: false } }), config);
    assert.match(wrongNumber.problems.join("\n"), /no las contesta el agente de ayuda/);
    assert.match(wrongNumber.problems.join("\n"), /no admite llamadas salientes/);

    const missing = await checkAgents(fakeApi(), { ...config, helpAgentId: null, followupAgentId: "agent_borrado" });
    assert.match(missing.problems.join("\n"), /falta ELEVENLABS_HELP_AGENT_ID/);
    assert.match(missing.problems.join("\n"), /no existe ELEVENLABS_FOLLOWUP_AGENT_ID=agent_borrado/);
  });

  it("dos números: el de ayuda contesta con el agente de ayuda; el de seguimiento llama y no contesta con su propio agente", async () => {
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
    assert.deepEqual(problems.map((p) => p.split(":")[0]), ["número de seguimiento", "número de seguimiento"]);
    assert.match(problems.join("\n"), /FOLLOW_UP_AGENT_PHONE_ID es \+14024486040, no \+14020000000/);
    assert.match(problems.join("\n"), /asígnale el agente de ayuda/);

    numbers.phnum_fu!.assigned_agent = { agent_id: IDS.help };
    env.FOLLOW_UP_AGENT_PHONE = "+14024486040";
    assert.deepEqual((await checkAgents(api, { ...config, phones: phonesFromEnv((name) => env[name]) })).problems, []);
  });

  it("ElevenLabs caído: no se confunde con una configuración incorrecta", async () => {
    const result = await checkAgents(fakeApi({ down: true }), config);
    assert.equal(result.unreachable.length, 2);
    assert.ok(!result.problems.some((p) => p.includes("agente")));
  });

  it("la copia de referencia no guarda el dominio público ni IDs de secretos", () => {
    const files = snapshotFiles(variant("help", (agent) => {
      agent.conversation_config.agent.prompt.tools![0]!.api_schema!.request_headers = { Authorization: { secret_id: "SECRETO_REAL" } };
    }));
    const all = Object.values(files).join("\n");
    assert.doesNotMatch(all, /comms\.example\.test|SECRETO_REAL/);
    assert.ok(files["tools/resolve_farmer.json"]?.includes(URL_PLACEHOLDER));
  });
});
