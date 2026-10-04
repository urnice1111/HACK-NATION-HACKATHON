/**
 * Los agentes viven en la cuenta de ElevenLabs; este comando solo los lee.
 *
 *   npm run agents:check   # valida los agentes y el número del .env contra lo que espera el código
 *   npm run agents:pull    # guarda en agents/ una copia de referencia (prompt, voz, herramientas)
 *
 * Usa ELEVENLABS_API_KEY, ELEVENLABS_HELP_AGENT_ID, ELEVENLABS_FOLLOWUP_AGENT_ID, los números
 * (HELP_AGENT_TELEPHONE[_ID] y FOLLOW_UP_AGENT_PHONE[_ID], o ELEVENLABS_AGENT_PHONE_NUMBER_ID si es uno)
 * y PUBLIC_BASE_URL. Nunca imprime secretos.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgents, ElevenLabsAgentsApi, phonesFromEnv, snapshotFiles, type AgentRole } from "./agents.ts";

const command = process.argv[2];
if (command !== "check" && command !== "pull") {
  console.error("Uso: npm run agents:check | npm run agents:pull");
  process.exit(1);
}
const env = (name: string) => process.env[name]?.trim() || null;
const apiKey = env("ELEVENLABS_API_KEY");
if (!apiKey) {
  console.error("Falta ELEVENLABS_API_KEY en .env");
  process.exit(1);
}

const api = new ElevenLabsAgentsApi(apiKey);
const result = await checkAgents(api, {
  helpAgentId: env("ELEVENLABS_HELP_AGENT_ID"),
  followupAgentId: env("ELEVENLABS_FOLLOWUP_AGENT_ID"),
  phones: phonesFromEnv(env),
  publicBaseUrl: env("PUBLIC_BASE_URL"),
});

if (command === "pull") {
  const agentsDir = fileURLToPath(new URL("../../agents/", import.meta.url));
  for (const [role, agent] of Object.entries(result.agents) as [AgentRole, NonNullable<(typeof result.agents)[AgentRole]>][]) {
    const dir = `${agentsDir}${role}/`;
    mkdirSync(`${dir}tools`, { recursive: true });
    // Las herramientas que ya no tiene el agente desaparecen de la copia.
    for (const file of readdirSync(`${dir}tools`)) if (file.endsWith(".json")) rmSync(`${dir}tools/${file}`);
    for (const [path, content] of Object.entries(snapshotFiles(agent))) {
      mkdirSync(dirname(`${dir}${path}`), { recursive: true });
      writeFileSync(`${dir}${path}`, content);
    }
    console.log(`agents/${role}/ ← "${agent.name}"`);
  }
}

for (const [role, agent] of Object.entries(result.agents)) console.log(`✔ ${role}: "${agent!.name}"`);
for (const line of result.unreachable) console.log(`? ${line}`);
for (const line of result.problems) console.log(`✖ ${line}`);
if (result.problems.length === 0 && result.unreachable.length === 0) console.log("Agentes listos para usarse con este código.");
process.exit(result.problems.length > 0 || result.unreachable.length > 0 ? 1 : 0);
