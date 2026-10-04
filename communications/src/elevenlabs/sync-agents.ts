/**
 * Crea o actualiza en ElevenLabs los agentes de `agents/<carpeta>/` (los archivos
 * son la fuente de verdad): secreto de las herramientas, herramientas webhook y agente.
 * Idempotente: reutiliza por nombre lo que ya existe.
 *
 *   npm run agents:sync -- help                    # agente de ayuda (llamadas entrantes)
 *   npm run agents:sync -- followup                # agente de seguimiento (salientes)
 *   npm run agents:sync -- help --assign-number    # además, el número ELEVENLABS_AGENT_PHONE_NUMBER_ID contesta con él
 *
 * Necesita ELEVENLABS_API_KEY, PUBLIC_BASE_URL y ELEVENLABS_TOOL_SECRET. Nunca imprime secretos.
 */
import { readFileSync, readdirSync } from "node:fs";
import { z } from "zod";

const API = "https://api.elevenlabs.io";
const SECRET_NAME = "comms_tool_secret";
const AGENTS_DIR = new URL("../../agents/", import.meta.url);

const Env = z.object({
  ELEVENLABS_API_KEY: z.string().min(1),
  PUBLIC_BASE_URL: z.url({ protocol: /^https$/ }).transform((u) => u.replace(/\/+$/, "")),
  ELEVENLABS_TOOL_SECRET: z.string().min(16),
  ELEVENLABS_AGENT_PHONE_NUMBER_ID: z.string().optional(),
});

const AgentFile = z.object({
  name: z.string().min(1),
  language: z.string().min(2),
  tts: z.object({ model_id: z.string().min(1), voice_id: z.string().min(1) }),
  dynamic_variable_placeholders: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

type ToolConfig = {
  name: string;
  api_schema: { url: string; request_headers: unknown; request_body_schema: { properties: Record<string, { dynamic_variable?: string }> } };
};

const [folder, ...flags] = process.argv.slice(2);
if (!folder || !["help", "followup"].includes(folder)) {
  console.error("Uso: npm run agents:sync -- <help|followup> [--assign-number]");
  process.exit(1);
}
const env = Env.safeParse(process.env);
if (!env.success) {
  console.error(`Faltan variables: ${env.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  process.exit(1);
}
const { ELEVENLABS_API_KEY, PUBLIC_BASE_URL, ELEVENLABS_TOOL_SECRET, ELEVENLABS_AGENT_PHONE_NUMBER_ID } = env.data;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 1500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function read(path: string): string {
  return readFileSync(new URL(path, AGENTS_DIR), "utf8");
}

/** La misma herramienta existe para varios agentes: se distingue por nombre y por de dónde sale `session_id`. */
function toolKey(config: ToolConfig): string {
  return `${config.name}|${config.api_schema.request_body_schema.properties.session_id?.dynamic_variable ?? ""}`;
}

// 1. Secreto: el valor de la cabecera Authorization de las herramientas.
const secretValue = `Bearer ${ELEVENLABS_TOOL_SECRET}`;
const { secrets = [] } = await api<{ secrets?: { secret_id: string; name: string }[] }>("GET", "/v1/convai/secrets");
let secretId = secrets.find((s) => s.name === SECRET_NAME)?.secret_id;
if (secretId) {
  await api("PATCH", `/v1/convai/secrets/${secretId}`, { type: "update", name: SECRET_NAME, value: secretValue });
} else {
  secretId = (await api<{ secret_id: string }>("POST", "/v1/convai/secrets", { type: "new", name: SECRET_NAME, value: secretValue })).secret_id;
}
console.log(`secreto ${SECRET_NAME}: ${secretId}`);

// 2. Herramientas webhook.
const { tools: existing = [] } = await api<{ tools?: { id: string; tool_config: ToolConfig }[] }>("GET", "/v1/convai/tools");
const existingIds = new Map(existing.map((t) => [toolKey(t.tool_config), t.id]));
const toolIds: string[] = [];
for (const file of readdirSync(new URL(`${folder}/tools/`, AGENTS_DIR)).filter((f) => f.endsWith(".json")).sort()) {
  const config = JSON.parse(read(`${folder}/tools/${file}`)) as ToolConfig;
  config.api_schema.url = config.api_schema.url.replace("https://TU-DOMINIO-PUBLICO", PUBLIC_BASE_URL);
  config.api_schema.request_headers = { Authorization: { secret_id: secretId } };
  const id = existingIds.get(toolKey(config));
  if (id) {
    await api("PATCH", `/v1/convai/tools/${id}`, { tool_config: config });
    toolIds.push(id);
  } else {
    toolIds.push((await api<{ id: string }>("POST", "/v1/convai/tools", { tool_config: config })).id);
  }
  console.log(`herramienta ${config.name}: ${toolIds.at(-1)} (${id ? "actualizada" : "creada"})`);
}

// 3. Agente. Sección 17: sin grabación de audio; transcripciones 30 días.
const agent = AgentFile.parse(JSON.parse(read(`${folder}/agent.json`)));
const agentConfig = {
  name: agent.name,
  conversation_config: {
    agent: {
      language: agent.language,
      first_message: read(`${folder}/first_message.txt`).trim(),
      prompt: {
        prompt: read(`${folder}/prompt.md`),
        tool_ids: toolIds,
        built_in_tools: { end_call: { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } } },
      },
      dynamic_variables: { dynamic_variable_placeholders: agent.dynamic_variable_placeholders },
    },
    tts: agent.tts,
  },
  platform_settings: { privacy: { record_voice: false, retention_days: 30 } },
};
const { agents = [] } = await api<{ agents?: { agent_id: string; name: string }[] }>("GET", "/v1/convai/agents?page_size=100");
let agentId = agents.find((a) => a.name === agent.name)?.agent_id;
if (agentId) {
  await api("PATCH", `/v1/convai/agents/${agentId}`, agentConfig);
} else {
  agentId = (await api<{ agent_id: string }>("POST", "/v1/convai/agents/create", agentConfig)).agent_id;
}
console.log(`agente "${agent.name}": ${agentId}`);

// 4. Opcional: el número importado contesta las llamadas entrantes con este agente.
if (flags.includes("--assign-number")) {
  if (!ELEVENLABS_AGENT_PHONE_NUMBER_ID) throw new Error("Falta ELEVENLABS_AGENT_PHONE_NUMBER_ID");
  await api("PATCH", `/v1/convai/phone-numbers/${ELEVENLABS_AGENT_PHONE_NUMBER_ID}`, { agent_id: agentId });
  console.log(`número ${ELEVENLABS_AGENT_PHONE_NUMBER_ID} → "${agent.name}"`);
}
if (folder === "followup") console.log(`Pon ELEVENLABS_FOLLOWUP_AGENT_ID=${agentId} en .env`);
