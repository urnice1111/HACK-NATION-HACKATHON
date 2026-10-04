/**
 * The ElevenLabs agents live in the account (created and tuned in the dashboard; see
 * agents/README.md). Communications only references them by ID and, before using them,
 * checks they are configured the way the code expects:
 *
 *  - English language, no audio recording and transcripts kept 30 days at most (section 17);
 *  - the tools each agent needs, pointing at PUBLIC_BASE_URL with the tool secret and
 *    with parameters the `/v1/tools/*` routes accept;
 *  - `session_id` and the IDs come from variables, never from the model;
 *  - the prompt only uses variables communications sends;
 *  - the help number answers with the help agent and the follow-up number (used by the
 *    follow-up and Alerts agents) allows outbound calls.
 *
 * It also builds the reference copy that `npm run agents:pull` saves into agents/.
 */
import { z } from "zod";
import { ALERT_DYNAMIC_VARIABLES } from "../alerts/dispatcher.ts";
import { FOLLOWUP_DYNAMIC_VARIABLES } from "../followups/dispatcher.ts";
import {
  AcknowledgeAlertInput,
  AssessObservationInput,
  ConfirmFarmerInput,
  GetPlotContextInput,
  RecordConsentInput,
  ResolveFarmerInput,
  SubmitFollowupInput,
  SubmitReportInput,
} from "../tools/voice-tools.ts";

export type AgentRole = "help" | "followup" | "alert";
/** Numbers: inbound (help) and outbound (follow-up and Alerts agents). */
export type PhoneRole = "help" | "followup";

/** What each agent needs from the account to work with this code. */
export const AGENT_SPECS: Record<AgentRole, { label: string; sessionVariable: string; tools: string[]; variables: readonly string[] }> = {
  help: {
    label: "help agent",
    sessionVariable: "system__conversation_id",
    tools: ["resolve_farmer", "confirm_farmer", "get_plot_context", "record_consent", "assess_observation", "submit_report"],
    variables: [],
  },
  followup: {
    label: "follow-up agent",
    sessionVariable: "session_id",
    tools: ["submit_followup", "assess_observation", "submit_report"],
    variables: FOLLOWUP_DYNAMIC_VARIABLES,
  },
  alert: {
    label: "alert agent",
    sessionVariable: "session_id",
    tools: ["acknowledge_alert"],
    variables: ALERT_DYNAMIC_VARIABLES,
  },
};

const TOOL_INPUTS: Record<string, z.ZodObject> = {
  resolve_farmer: ResolveFarmerInput,
  confirm_farmer: ConfirmFarmerInput,
  get_plot_context: GetPlotContextInput,
  record_consent: RecordConsentInput,
  assess_observation: AssessObservationInput,
  submit_report: SubmitReportInput,
  submit_followup: SubmitFollowupInput,
  acknowledge_alert: AcknowledgeAlertInput,
};

// --- ElevenLabs API shapes (only what is validated; the rest is ignored) ---

export interface ToolProperty {
  type?: string | null;
  description?: string | null;
  dynamic_variable?: string | null;
  enum?: string[] | null;
  required?: string[] | null;
  properties?: Record<string, ToolProperty> | null;
  items?: ToolProperty | null;
}

const ToolPropertySchema: z.ZodType<ToolProperty> = z.lazy(() =>
  z.object({
    type: z.string().nullish(),
    description: z.string().nullish(),
    dynamic_variable: z.string().nullish(),
    enum: z.array(z.string()).nullish(),
    required: z.array(z.string()).nullish(),
    properties: z.record(z.string(), ToolPropertySchema).nullish(),
    items: ToolPropertySchema.nullish(),
  }),
);

export const AgentTool = z.object({
  type: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  response_timeout_secs: z.number().nullish(),
  api_schema: z
    .object({
      url: z.string(),
      method: z.string().nullish(),
      request_headers: z.record(z.string(), z.unknown()).nullish(),
      request_body_schema: ToolPropertySchema.nullish(),
    })
    .nullish(),
});

export const AgentRecord = z.object({
  agent_id: z.string(),
  name: z.string(),
  conversation_config: z.object({
    agent: z.object({
      language: z.string().nullish(),
      first_message: z.string().nullish(),
      prompt: z.object({
        prompt: z.string().nullish(),
        llm: z.string().nullish(),
        tools: z.array(AgentTool).nullish(),
      }),
      dynamic_variables: z.object({ dynamic_variable_placeholders: z.record(z.string(), z.unknown()).nullish() }).nullish(),
    }),
    tts: z
      .object({
        model_id: z.string().nullish(),
        voice_id: z.string().nullish(),
        expressive_mode: z.boolean().nullish(),
        stability: z.number().nullish(),
        similarity_boost: z.number().nullish(),
      })
      .nullish(),
  }),
  platform_settings: z
    .object({ privacy: z.object({ record_voice: z.boolean().nullish(), retention_days: z.number().nullish() }).nullish() })
    .nullish(),
});

export const PhoneNumberRecord = z.object({
  phone_number_id: z.string(),
  phone_number: z.string().nullish(),
  supports_inbound: z.boolean().nullish(),
  supports_outbound: z.boolean().nullish(),
  assigned_agent: z.object({ agent_id: z.string() }).nullish(),
});

export type AgentTool = z.infer<typeof AgentTool>;
export type AgentRecord = z.infer<typeof AgentRecord>;
export type PhoneNumberRecord = z.infer<typeof PhoneNumberRecord>;

export class AgentsApiError extends Error {
  /** null = no response (network or timeout). */
  constructor(readonly status: number | null, message: string) {
    super(message);
  }
}

export interface AgentsApi {
  getAgent(agentId: string): Promise<AgentRecord>;
  getPhoneNumber(phoneNumberId: string): Promise<PhoneNumberRecord>;
}

/** Reads the ElevenLabs account. Only needs read access to agents and phone numbers. */
export class ElevenLabsAgentsApi implements AgentsApi {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.elevenlabs.io",
  ) {}

  getAgent(agentId: string): Promise<AgentRecord> {
    return this.get(`/v1/convai/agents/${encodeURIComponent(agentId)}`, AgentRecord);
  }

  getPhoneNumber(phoneNumberId: string): Promise<PhoneNumberRecord> {
    return this.get(`/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, PhoneNumberRecord);
  }

  private async get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { "xi-api-key": this.apiKey }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new AgentsApiError(null, "ElevenLabs did not respond");
    }
    if (!response.ok) throw new AgentsApiError(response.status, `ElevenLabs returned ${response.status} for ${path}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new AgentsApiError(response.status, `unexpected ElevenLabs response for ${path}`);
    return parsed.data;
  }
}

// --- Validation ---

function isSecretRef(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { secret_id?: unknown }).secret_id === "string" && (value as { secret_id: string }).secret_id.length > 0;
}

function allowedVariable(name: string, role: AgentRole): boolean {
  return name.startsWith("system__") || AGENT_SPECS[role].variables.includes(name);
}

function dynamicVariablesIn(property: ToolProperty): string[] {
  const own = property.dynamic_variable ? [property.dynamic_variable] : [];
  const nested = Object.values(property.properties ?? {}).flatMap(dynamicVariablesIn);
  return [...own, ...nested, ...(property.items ? dynamicVariablesIn(property.items) : [])];
}

/** Problems with a webhook tool. Without `publicBaseUrl` the domain isn't checked (reference copy). */
export function toolProblems(tool: AgentTool, role: AgentRole, publicBaseUrl: string | null): string[] {
  const problems: string[] = [];
  const add = (message: string) => problems.push(`${tool.name}: ${message}`);
  const input = TOOL_INPUTS[tool.name];
  if (!input) return [`${tool.name}: communications doesn't have this tool`];
  if (tool.type !== "webhook" || !tool.api_schema) return [`${tool.name}: must be a webhook tool`];

  const api = tool.api_schema;
  const expectedPath = `/v1/tools/${tool.name.replaceAll("_", "-")}`;
  let url: URL | null = null;
  try {
    url = new URL(api.url);
  } catch {
    add(`invalid URL (${api.url})`);
  }
  if (url && url.pathname !== expectedPath) add(`the URL must end in ${expectedPath}`);
  if (url && publicBaseUrl && url.origin !== new URL(publicBaseUrl).origin) add(`the URL points to ${url.origin}, not to PUBLIC_BASE_URL (${new URL(publicBaseUrl).origin})`);
  if ((api.method ?? "").toUpperCase() !== "POST") add("the method must be POST");
  if (!isSecretRef(api.request_headers?.Authorization)) add("missing the Authorization header with the secret \"Bearer <ELEVENLABS_TOOL_SECRET>\"");

  const body = api.request_body_schema;
  const properties = body?.properties ?? {};
  const accepted = Object.keys(input.shape);
  for (const key of Object.keys(properties)) if (!accepted.includes(key)) add(`communications doesn't accept the parameter ${key}`);
  for (const key of accepted.filter((k) => !input.shape[k]!.safeParse(undefined).success)) {
    if (!properties[key]?.dynamic_variable && !body?.required?.includes(key)) add(`the parameter ${key} is required`);
  }
  const sessionVariable = properties.session_id?.dynamic_variable;
  if (sessionVariable !== AGENT_SPECS[role].sessionVariable) {
    add(`session_id must come from the dynamic variable ${AGENT_SPECS[role].sessionVariable}${sessionVariable ? ` (currently ${sessionVariable})` : ""}`);
  }
  // IDs the dispatcher sends (followup_id, plot_id, notification_id) are never written by the model.
  for (const key of Object.keys(properties).filter((k) => k !== "session_id" && k.endsWith("_id") && AGENT_SPECS[role].variables.includes(k))) {
    if (properties[key]!.dynamic_variable !== key) add(`${key} must come from the dynamic variable ${key}`);
  }
  for (const variable of body ? dynamicVariablesIn(body) : []) {
    if (!allowedVariable(variable, role)) add(`uses the variable {{${variable}}}, which communications doesn't send to this agent`);
  }
  return problems;
}

/** Configuration problems of an agent read from the account. */
export function agentProblems(agent: AgentRecord, role: AgentRole, publicBaseUrl: string | null): string[] {
  const spec = AGENT_SPECS[role];
  const problems: string[] = [];
  const config = agent.conversation_config.agent;
  if (!config.language?.startsWith("en")) problems.push(`language "${config.language ?? "?"}"; must be English (en)`);
  if (agent.platform_settings?.privacy?.record_voice !== false) problems.push("records audio; turn it off in Privacy (section 17: no recording)");
  const retention = agent.platform_settings?.privacy?.retention_days;
  if (retention == null || retention < 0 || retention > 30) {
    problems.push(`keeps conversations ${retention == null || retention < 0 ? "forever" : `${retention} days`}; set it to 30 days or less in Privacy (section 17)`);
  }

  const tools = config.prompt.tools ?? [];
  for (const name of spec.tools) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) problems.push(`missing the tool ${name}`);
    else problems.push(...toolProblems(tool, role, publicBaseUrl));
  }
  if (!tools.some((t) => t.name === "end_call")) problems.push("missing the end_call system tool (hang up)");

  const text = `${config.prompt.prompt ?? ""}\n${config.first_message ?? ""}`;
  for (const [, variable] of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    if (!allowedVariable(variable!, role)) problems.push(`the prompt uses {{${variable}}}, which communications doesn't send`);
  }
  return [...new Set(problems)].map((p) => `${spec.label} (${agent.name}): ${p}`);
}

/** A number imported into ElevenLabs and the `.env` variable its ID came from (for messages). */
export interface PhoneConfig {
  id: string | null;
  /** Expected E.164 number, if set in `.env`. */
  e164: string | null;
  variable: string;
}

/**
 * Each agent's number. With two numbers: `HELP_AGENT_TELEPHONE_ID` answers inbound calls and
 * `FOLLOW_UP_AGENT_PHONE_ID` places outbound ones. With one, `ELEVENLABS_AGENT_PHONE_NUMBER_ID` does both.
 */
export function phonesFromEnv(get: (name: string) => string | null | undefined): Record<PhoneRole, PhoneConfig> {
  const shared = get("ELEVENLABS_AGENT_PHONE_NUMBER_ID") || null;
  const phone = (idVariable: string, e164Variable: string): PhoneConfig => {
    const own = get(idVariable) || null;
    return { id: own ?? shared, e164: get(e164Variable) || null, variable: own || !shared ? idVariable : "ELEVENLABS_AGENT_PHONE_NUMBER_ID" };
  };
  return { help: phone("HELP_AGENT_TELEPHONE_ID", "HELP_AGENT_TELEPHONE"), followup: phone("FOLLOW_UP_AGENT_PHONE_ID", "FOLLOW_UP_AGENT_PHONE") };
}

export interface AgentsConfig {
  helpAgentId: string | null;
  followupAgentId: string | null;
  alertAgentId: string | null;
  phones: Record<PhoneRole, PhoneConfig>;
  publicBaseUrl: string | null;
}

export interface AgentsCheck {
  /** Wrong configuration: must be fixed in the dashboard. */
  problems: string[];
  /** Couldn't be read (network, permissions): doesn't prove it's wrong. */
  unreachable: string[];
  agents: Partial<Record<AgentRole, AgentRecord>>;
}

function phoneProblems(role: PhoneRole, number: PhoneNumberRecord, phone: PhoneConfig, config: AgentsConfig): string[] {
  const problems: string[] = [];
  if (phone.e164 && number.phone_number && number.phone_number !== phone.e164) {
    problems.push(`${phone.variable} is ${number.phone_number}, not ${phone.e164}`);
  }
  if (role === "help") {
    if (number.supports_inbound === false) problems.push("doesn't support inbound calls");
    if (config.helpAgentId && number.assigned_agent?.agent_id !== config.helpAgentId) {
      problems.push("inbound calls aren't answered by the help agent (assign it in Phone Numbers)");
    }
  } else {
    if (number.supports_outbound === false) problems.push("doesn't support outbound calls");
    // If the farmer calls back the number that called them, an outbound agent would answer without its variables.
    const assigned = number.assigned_agent?.agent_id;
    if (phone.id !== config.phones.help.id && assigned && (assigned === config.followupAgentId || assigned === config.alertAgentId)) {
      const agent = assigned === config.followupAgentId ? "follow-up" : "alert";
      problems.push(`answers inbound calls with the ${agent} agent, which doesn't work without its variables; assign the help agent for people who call back`);
    }
  }
  return problems.map((p) => `${role === "help" ? "help" : "follow-up"} number: ${p}`);
}

/** Reads the configured agents and numbers from the account and validates them against what the code expects. */
export async function checkAgents(api: AgentsApi, config: AgentsConfig): Promise<AgentsCheck> {
  const result: AgentsCheck = { problems: [], unreachable: [], agents: {} };
  const ids: [AgentRole, string | null, string][] = [
    ["help", config.helpAgentId, "ELEVENLABS_HELP_AGENT_ID"],
    ["followup", config.followupAgentId, "ELEVENLABS_FOLLOWUP_AGENT_ID"],
    ["alert", config.alertAgentId, "ELEVENLABS_ALERT_AGENT_ID"],
  ];
  for (const [role, id, variable] of ids) {
    if (!id) {
      result.problems.push(`${AGENT_SPECS[role].label}: ${variable} is missing`);
      continue;
    }
    try {
      const agent = await api.getAgent(id);
      result.agents[role] = agent;
      result.problems.push(...agentProblems(agent, role, config.publicBaseUrl));
    } catch (error) {
      if (error instanceof AgentsApiError && error.status === 404) result.problems.push(`${AGENT_SPECS[role].label}: ${variable}=${id} doesn't exist in the account`);
      else result.unreachable.push(`${AGENT_SPECS[role].label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const role of ["help", "followup"] as const) {
    const phone = config.phones[role];
    const label = `${role === "help" ? "help" : "follow-up"} number`;
    if (!phone.id) {
      result.problems.push(`${label}: ${phone.variable} is missing`);
      continue;
    }
    try {
      result.problems.push(...phoneProblems(role, await api.getPhoneNumber(phone.id), phone, config));
    } catch (error) {
      if (error instanceof AgentsApiError && error.status === 404) result.problems.push(`${label}: ${phone.variable}=${phone.id} doesn't exist in the account`);
      else result.unreachable.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

// --- Reference copy (npm run agents:pull) ---

export const URL_PLACEHOLDER = "https://YOUR-PUBLIC-DOMAIN";
const SECRET_PLACEHOLDER = { secret_id: "ID_OF_SECRET_WITH_Bearer_ELEVENLABS_TOOL_SECRET" };

function cleanProperty(property: ToolProperty): ToolProperty {
  const out: ToolProperty = {};
  if (property.type) out.type = property.type;
  if (property.description) out.description = property.description;
  if (property.dynamic_variable) out.dynamic_variable = property.dynamic_variable;
  if (property.enum?.length) out.enum = property.enum;
  if (property.required?.length) out.required = property.required;
  if (property.properties) out.properties = Object.fromEntries(Object.entries(property.properties).map(([k, v]) => [k, cleanProperty(v)]));
  if (property.items) out.items = cleanProperty(property.items);
  return out;
}

/** Files of an agent's reference copy, without secret IDs or the public domain. */
export function snapshotFiles(agent: AgentRecord): Record<string, string> {
  const config = agent.conversation_config.agent;
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const files: Record<string, string> = {
    "prompt.md": config.prompt.prompt ?? "",
    "first_message.txt": `${(config.first_message ?? "").trim()}\n`,
    "agent.json": json({
      name: agent.name,
      language: config.language ?? null,
      llm: config.prompt.llm ?? null,
      tts: agent.conversation_config.tts ?? null,
      privacy: agent.platform_settings?.privacy ?? null,
      dynamic_variable_placeholders: config.dynamic_variables?.dynamic_variable_placeholders ?? {},
    }),
  };
  for (const tool of config.prompt.tools ?? []) {
    if (tool.type !== "webhook" || !tool.api_schema) continue;
    const url = new URL(tool.api_schema.url);
    files[`tools/${tool.name}.json`] = json({
      type: tool.type,
      name: tool.name,
      description: tool.description ?? "",
      response_timeout_secs: tool.response_timeout_secs ?? null,
      api_schema: {
        url: `${URL_PLACEHOLDER}${url.pathname}`,
        method: tool.api_schema.method ?? "POST",
        request_headers: { Authorization: SECRET_PLACEHOLDER },
        request_body_schema: cleanProperty(tool.api_schema.request_body_schema ?? {}),
      },
    });
  }
  return files;
}
