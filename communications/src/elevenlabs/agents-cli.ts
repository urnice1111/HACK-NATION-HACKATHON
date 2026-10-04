/**
 * The agents live in the ElevenLabs account; this command only reads them.
 *
 *   npm run agents:check   # validates the .env agents and number against what the code expects
 *   npm run agents:pull    # saves a reference copy into agents/ (prompt, voice, tools)
 *
 * Uses ELEVENLABS_API_KEY, ELEVENLABS_HELP_AGENT_ID, ELEVENLABS_FOLLOWUP_AGENT_ID, the numbers
 * (HELP_AGENT_TELEPHONE[_ID] and FOLLOW_UP_AGENT_PHONE[_ID], or ELEVENLABS_AGENT_PHONE_NUMBER_ID for a single one)
 * and PUBLIC_BASE_URL. Never prints secrets.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgents, ElevenLabsAgentsApi, phonesFromEnv, snapshotFiles, type AgentRole } from "./agents.ts";

const command = process.argv[2];
if (command !== "check" && command !== "pull") {
  console.error("Usage: npm run agents:check | npm run agents:pull");
  process.exit(1);
}
const env = (name: string) => process.env[name]?.trim() || null;
const apiKey = env("ELEVENLABS_API_KEY");
if (!apiKey) {
  console.error("ELEVENLABS_API_KEY is missing from .env");
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
    // Tools the agent no longer has disappear from the copy.
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
if (result.problems.length === 0 && result.unreachable.length === 0) console.log("Agents ready to use with this code.");
process.exit(result.problems.length > 0 || result.unreachable.length > 0 ? 1 : 0);
