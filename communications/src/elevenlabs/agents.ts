/**
 * Los agentes de ElevenLabs viven en la cuenta (se crean y ajustan en el panel; ver
 * agents/README.md). Comunicaciones solo los referencia por ID y, antes de usarlos,
 * comprueba que estén configurados como el código espera:
 *
 *  - idioma español, sin grabación de audio y transcripciones 30 días como máximo (sección 17);
 *  - las herramientas que necesita cada agente, apuntando a PUBLIC_BASE_URL con el
 *    secreto de las herramientas y con parámetros que las rutas `/v1/tools/*` aceptan;
 *  - `session_id` y los IDs salen de variables, nunca del modelo;
 *  - el prompt solo usa variables que comunicaciones envía;
 *  - el número de ayuda contesta con el agente de ayuda y el de seguimiento admite salientes.
 *
 * También genera la copia de referencia que `npm run agents:pull` guarda en agents/.
 */
import { z } from "zod";
import { FOLLOWUP_DYNAMIC_VARIABLES } from "../followups/dispatcher.ts";
import {
  AssessObservationInput,
  ConfirmFarmerInput,
  GetPlotContextInput,
  RecordConsentInput,
  ResolveFarmerInput,
  SubmitFollowupInput,
  SubmitReportInput,
} from "../tools/voice-tools.ts";

export type AgentRole = "help" | "followup";

/** Lo que cada agente necesita de la cuenta para funcionar con este código. */
export const AGENT_SPECS: Record<AgentRole, { label: string; sessionVariable: string; tools: string[]; variables: readonly string[] }> = {
  help: {
    label: "agente de ayuda",
    sessionVariable: "system__conversation_id",
    tools: ["resolve_farmer", "confirm_farmer", "get_plot_context", "record_consent", "assess_observation", "submit_report"],
    variables: [],
  },
  followup: {
    label: "agente de seguimiento",
    sessionVariable: "session_id",
    tools: ["submit_followup", "assess_observation", "submit_report"],
    variables: FOLLOWUP_DYNAMIC_VARIABLES,
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
};

// --- Formas de la API de ElevenLabs (solo lo que se valida; el resto se ignora) ---

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
  /** null = no hubo respuesta (red o timeout). */
  constructor(readonly status: number | null, message: string) {
    super(message);
  }
}

export interface AgentsApi {
  getAgent(agentId: string): Promise<AgentRecord>;
  getPhoneNumber(phoneNumberId: string): Promise<PhoneNumberRecord>;
}

/** Lectura de la cuenta de ElevenLabs. Solo necesita permisos de lectura de agentes y números. */
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
      throw new AgentsApiError(null, "ElevenLabs no respondió");
    }
    if (!response.ok) throw new AgentsApiError(response.status, `ElevenLabs respondió ${response.status} en ${path}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new AgentsApiError(response.status, `respuesta inesperada de ElevenLabs en ${path}`);
    return parsed.data;
  }
}

// --- Validación ---

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

/** Problemas de una herramienta webhook. Sin `publicBaseUrl` no se comprueba el dominio (copia de referencia). */
export function toolProblems(tool: AgentTool, role: AgentRole, publicBaseUrl: string | null): string[] {
  const problems: string[] = [];
  const add = (message: string) => problems.push(`${tool.name}: ${message}`);
  const input = TOOL_INPUTS[tool.name];
  if (!input) return [`${tool.name}: comunicaciones no tiene esta herramienta`];
  if (tool.type !== "webhook" || !tool.api_schema) return [`${tool.name}: debe ser una herramienta webhook`];

  const api = tool.api_schema;
  const expectedPath = `/v1/tools/${tool.name.replaceAll("_", "-")}`;
  let url: URL | null = null;
  try {
    url = new URL(api.url);
  } catch {
    add(`URL inválida (${api.url})`);
  }
  if (url && url.pathname !== expectedPath) add(`la URL debe terminar en ${expectedPath}`);
  if (url && publicBaseUrl && url.origin !== new URL(publicBaseUrl).origin) add(`la URL apunta a ${url.origin}, no a PUBLIC_BASE_URL (${new URL(publicBaseUrl).origin})`);
  if ((api.method ?? "").toUpperCase() !== "POST") add("el método debe ser POST");
  if (!isSecretRef(api.request_headers?.Authorization)) add("falta la cabecera Authorization con el secreto \"Bearer <ELEVENLABS_TOOL_SECRET>\"");

  const body = api.request_body_schema;
  const properties = body?.properties ?? {};
  const accepted = Object.keys(input.shape);
  for (const key of Object.keys(properties)) if (!accepted.includes(key)) add(`el parámetro ${key} no lo acepta comunicaciones`);
  for (const key of accepted.filter((k) => !input.shape[k]!.safeParse(undefined).success)) {
    if (!properties[key]?.dynamic_variable && !body?.required?.includes(key)) add(`el parámetro ${key} es obligatorio`);
  }
  const sessionVariable = properties.session_id?.dynamic_variable;
  if (sessionVariable !== AGENT_SPECS[role].sessionVariable) {
    add(`session_id debe venir de la variable dinámica ${AGENT_SPECS[role].sessionVariable}${sessionVariable ? ` (hoy ${sessionVariable})` : ""}`);
  }
  for (const variable of body ? dynamicVariablesIn(body) : []) {
    if (!allowedVariable(variable, role)) add(`usa la variable {{${variable}}}, que comunicaciones no envía a este agente`);
  }
  return problems;
}

/** Problemas de configuración de un agente leído de la cuenta. */
export function agentProblems(agent: AgentRecord, role: AgentRole, publicBaseUrl: string | null): string[] {
  const spec = AGENT_SPECS[role];
  const problems: string[] = [];
  const config = agent.conversation_config.agent;
  if (!config.language?.startsWith("es")) problems.push(`idioma "${config.language ?? "?"}"; debe ser español (es)`);
  if (agent.platform_settings?.privacy?.record_voice !== false) problems.push("graba audio; desactívalo en Privacy (sección 17: sin grabación)");
  const retention = agent.platform_settings?.privacy?.retention_days;
  if (retention == null || retention < 0 || retention > 30) {
    problems.push(`guarda las conversaciones ${retention == null || retention < 0 ? "para siempre" : `${retention} días`}; ponlo en 30 días o menos en Privacy (sección 17)`);
  }

  const tools = config.prompt.tools ?? [];
  for (const name of spec.tools) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) problems.push(`falta la herramienta ${name}`);
    else problems.push(...toolProblems(tool, role, publicBaseUrl));
  }
  if (!tools.some((t) => t.name === "end_call")) problems.push("falta la herramienta de sistema end_call (colgar)");

  const text = `${config.prompt.prompt ?? ""}\n${config.first_message ?? ""}`;
  for (const [, variable] of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    if (!allowedVariable(variable!, role)) problems.push(`el prompt usa {{${variable}}}, que comunicaciones no envía`);
  }
  return [...new Set(problems)].map((p) => `${spec.label} (${agent.name}): ${p}`);
}

/** Un número importado en ElevenLabs y la variable de `.env` de la que salió su ID (para los mensajes). */
export interface PhoneConfig {
  id: string | null;
  /** Número E.164 esperado, si está en `.env`. */
  e164: string | null;
  variable: string;
}

/**
 * Números de cada agente. Con dos números: `HELP_AGENT_TELEPHONE_ID` contesta las entrantes y
 * `FOLLOW_UP_AGENT_PHONE_ID` hace las salientes. Con uno solo, `ELEVENLABS_AGENT_PHONE_NUMBER_ID` hace ambas.
 */
export function phonesFromEnv(get: (name: string) => string | null | undefined): Record<AgentRole, PhoneConfig> {
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
  phones: Record<AgentRole, PhoneConfig>;
  publicBaseUrl: string | null;
}

export interface AgentsCheck {
  /** Configuración incorrecta: hay que corregirla en el panel. */
  problems: string[];
  /** No se pudo consultar (red, permisos): no prueba que esté mal. */
  unreachable: string[];
  agents: Partial<Record<AgentRole, AgentRecord>>;
}

function phoneProblems(role: AgentRole, number: PhoneNumberRecord, phone: PhoneConfig, config: AgentsConfig): string[] {
  const problems: string[] = [];
  if (phone.e164 && number.phone_number && number.phone_number !== phone.e164) {
    problems.push(`${phone.variable} es ${number.phone_number}, no ${phone.e164}`);
  }
  if (role === "help") {
    if (number.supports_inbound === false) problems.push("no admite llamadas entrantes");
    if (config.helpAgentId && number.assigned_agent?.agent_id !== config.helpAgentId) {
      problems.push("las llamadas entrantes no las contesta el agente de ayuda (asígnalo en Phone Numbers)");
    }
  } else {
    if (number.supports_outbound === false) problems.push("no admite llamadas salientes");
    // Si el agricultor devuelve la llamada al número que lo llamó, el de seguimiento contestaría sin sus variables.
    if (phone.id !== config.phones.help.id && config.followupAgentId && number.assigned_agent?.agent_id === config.followupAgentId) {
      problems.push("contesta las entrantes con el agente de seguimiento, que sin sus variables no funciona; asígnale el agente de ayuda para quien devuelva la llamada");
    }
  }
  return problems.map((p) => `número de ${role === "help" ? "ayuda" : "seguimiento"}: ${p}`);
}

/** Lee de la cuenta los agentes y los números configurados y los valida contra lo que espera el código. */
export async function checkAgents(api: AgentsApi, config: AgentsConfig): Promise<AgentsCheck> {
  const result: AgentsCheck = { problems: [], unreachable: [], agents: {} };
  const ids: [AgentRole, string | null, string][] = [
    ["help", config.helpAgentId, "ELEVENLABS_HELP_AGENT_ID"],
    ["followup", config.followupAgentId, "ELEVENLABS_FOLLOWUP_AGENT_ID"],
  ];
  for (const [role, id, variable] of ids) {
    if (!id) {
      result.problems.push(`${AGENT_SPECS[role].label}: falta ${variable}`);
      continue;
    }
    try {
      const agent = await api.getAgent(id);
      result.agents[role] = agent;
      result.problems.push(...agentProblems(agent, role, config.publicBaseUrl));
    } catch (error) {
      if (error instanceof AgentsApiError && error.status === 404) result.problems.push(`${AGENT_SPECS[role].label}: no existe ${variable}=${id} en la cuenta`);
      else result.unreachable.push(`${AGENT_SPECS[role].label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const role of ["help", "followup"] as const) {
    const phone = config.phones[role];
    const label = `número de ${role === "help" ? "ayuda" : "seguimiento"}`;
    if (!phone.id) {
      result.problems.push(`${label}: falta ${phone.variable}`);
      continue;
    }
    try {
      result.problems.push(...phoneProblems(role, await api.getPhoneNumber(phone.id), phone, config));
    } catch (error) {
      if (error instanceof AgentsApiError && error.status === 404) result.problems.push(`${label}: no existe ${phone.variable}=${phone.id} en la cuenta`);
      else result.unreachable.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

// --- Copia de referencia (npm run agents:pull) ---

export const URL_PLACEHOLDER = "https://TU-DOMINIO-PUBLICO";
const SECRET_PLACEHOLDER = { secret_id: "ID_DEL_SECRETO_CON_Bearer_ELEVENLABS_TOOL_SECRET" };

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

/** Archivos de la copia de referencia de un agente, sin IDs de secretos ni el dominio público. */
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
