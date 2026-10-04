# ElevenLabs agents

The agents **live in the ElevenLabs account**: they are created and tuned in the dashboard. Communications only references them by ID (`.env`) and, before using them, checks they are configured the way the code expects.

| Agent | Purpose | `.env` variable | Reference copy |
| --- | --- | --- | --- |
| Help (e.g. "Coffee Help") | Inbound calls to the Twilio number | `ELEVENLABS_HELP_AGENT_ID` | [`help/`](help/) |
| Follow-up (e.g. "Coffee Follow-up") | Outbound calls triggered by `followup.due` | `ELEVENLABS_FOLLOWUP_AGENT_ID` | [`followup/`](followup/) |

```bash
npm run agents:check   # reads the agents and the number from the account and reports what's missing or wrong
npm run agents:pull    # saves a reference copy (prompt, voice, tools) into agents/ to review in git
```

The server runs the same check at startup: in demo it only logs it; with `IS_DEMO=false` it **won't start** if an agent is misconfigured (if ElevenLabs doesn't respond, it only warns).

What is checked ([`src/elevenlabs/agents.ts`](../src/elevenlabs/agents.ts)): English language; no audio recording; each agent's tools, with the `PUBLIC_BASE_URL` URL, POST method, the `Authorization` header from a secret and only parameters the `/v1/tools/*` routes accept; `session_id` and the IDs come from variables, never from the model; the prompt only uses variables communications sends; the system tool to hang up; and that the number answers with the help agent and allows outbound calls. What can't be read through the API (the secret's value) is checked with a test call.

## Creating everything from scratch

Before you start: communications deployed with a fixed HTTPS URL (`PUBLIC_BASE_URL`, no trailing "/"), a Twilio number with voice and SMS and permission to call the farmers' country (Twilio → Voice → Geo permissions → e.g. Mexico), and an ElevenLabs API key with agent and phone number permissions.

### 1. Number

1. ElevenLabs → **Phone Numbers** → **Import number** → Twilio: the number, the Account SID and the Auth Token.
2. Copy its ID (`phnum_…`) into `ELEVENLABS_AGENT_PHONE_NUMBER_ID`.
3. **Important:** when it's imported, ElevenLabs rewrites the number's webhooks in Twilio (voice goes to `https://api.elevenlabs.io/twilio/inbound_call`, which is correct) and also the SMS one. In Twilio → Phone Numbers → the number → *Messaging configuration*, set `<PUBLIC_BASE_URL>/v1/webhooks/twilio/sms` (POST) again.
4. If someone later changes the number's voice settings in Twilio, inbound calls stop reaching the agent: you have to re-import the number (its ID changes) and repeat step 3.

### 2. Tool secret

1. Generate a random value: `openssl rand -hex 24`. Put it in `ELEVENLABS_TOOL_SECRET`.
2. ElevenLabs → **Workspace settings → Secrets → Add secret**: name `comms_tool_secret`, value `Bearer <that value>` (with the word Bearer and a space).

### 3. Tools (Agents → Tools → Add tool → Webhook)

For all of them: **Method** POST; **URL** `<PUBLIC_BASE_URL>` + the path in the table; **Headers**: `Authorization` → *Secret* `comms_tool_secret`; **Body parameters** as in the tables. "Variable" = the parameter is filled from that *dynamic variable* (in the dashboard: *Value type → Dynamic variable*); the model never writes it. The model fills the rest using the description in the reference JSON ([`help/tools/`](help/tools/), [`followup/tools/`](followup/tools/)): copy the tool's name, description and each parameter's description as they are.

`assess_observation` and `submit_report` exist twice (once per agent) because `session_id` comes from different variables: create two separate tools.

**Help agent** — `session_id` ← variable `system__conversation_id` in all of them:

| Tool | Path | Parameters (required in bold) | Timeout |
| --- | --- | --- | --- |
| `resolve_farmer` | `/v1/tools/resolve-farmer` | **`session_id`**; `caller_phone` ← variable `system__caller_id` | 10 s |
| `confirm_farmer` | `/v1/tools/confirm-farmer` | **`session_id`**; **`candidate_number`** (integer) | 10 s |
| `get_plot_context` | `/v1/tools/get-plot-context` | **`session_id`**; `plot_number` (integer) | 10 s |
| `record_consent` | `/v1/tools/record-consent` | **`session_id`**; `reports`, `notifications`, `followup_calls` (boolean) | 10 s |
| `assess_observation` | `/v1/tools/assess-observation` | **`session_id`**; **`user_statement`** (string); `symptoms` (array of string); `answers` (array of objects: **`need_code`** string, `value` string, `unit` string, **`raw_text`** string, **`unknown`** boolean); `asked_need_codes` (array of string) | 15 s |
| `submit_report` | `/v1/tools/submit-report` | **`session_id`**; **`user_statement`** (string); `symptoms` (array of string); **`completeness`** (enum `partial`, `sufficient`); `assessment_id` (string) | 10 s |

**Follow-up agent** — `session_id` ← variable `session_id` in all of them:

| Tool | Path | Parameters (required in bold) | Timeout |
| --- | --- | --- | --- |
| `submit_followup` | `/v1/tools/submit-followup` | **`session_id`**; **`followup_id`** ← variable `followup_id`; `conversation_id` ← variable `system__conversation_id`; **`status_reported`** (enum `worse`, `same`, `improved`, `resolved`, `unknown`); **`user_statement`** (string); `actions_taken` (string); **`action_worked`** (enum `yes`, `no`, `partial`, `unknown`); `change_noticed_days_ago` (integer) | 10 s |
| `assess_observation` | `/v1/tools/assess-observation` | As in help, plus **`plot_id`** ← variable `plot_id` | 15 s |
| `submit_report` | `/v1/tools/submit-report` | As in help, plus `plot_id` ← variable `plot_id` and `conversation_id` ← variable `system__conversation_id` | 10 s |

ElevenLabs requires a description on every parameter the model fills, including array items.

### 4. Help agent

ElevenLabs → **Agents → New agent → Blank**:

1. Name, e.g. "Coffee Help".
2. **Agent**: language *English*; *First message* = [`help/first_message.txt`](help/first_message.txt); *System prompt* = [`help/prompt.md`](help/prompt.md); whichever LLM the team chooses.
3. **Tools**: the six help tools from step 3 and the **End call** system tool.
4. **Voice**: a native English voice from the Voice Library (listen to the preview before choosing), with the team's model, today *V4 Turbo* with *Expressive mode*. The voice and model currently in use are in [`help/agent.json`](help/agent.json).
5. **Privacy** (section 17): turn off audio recording and set conversation retention to 30 days (not "unlimited"; `agents:check` requires it).
6. Save and copy the ID (`agent_…`) into `ELEVENLABS_HELP_AGENT_ID`.
7. **Phone Numbers** → the number → *Agent*: this agent (it answers inbound calls).

### 5. Follow-up agent

Same as the help agent, with [`followup/first_message.txt`](followup/first_message.txt), [`followup/prompt.md`](followup/prompt.md), its three tools and **End call**. Also, under **Dynamic variables**, declare these with test values (the dashboard asks for them to test without a call): `farmer_name`, `threat_label`, `symptoms`, `guidance_given`, `followup_id`, `plot_id`, `session_id`, `attempt_number`. They are the only ones communications sends; the prompt can't use any others. Copy the ID into `ELEVENLABS_FOLLOWUP_AGENT_ID`.

### 6. Check and save the copy

```bash
npm run agents:check   # must end with "Agents ready to use with this code."
npm run agents:pull    # updates agents/; commit it
```

End-to-end test: call the number from a phone registered in the backend (help agent) and trigger a `followup.due` (follow-up agent; see below). Only `registered: true` in the tools confirms that the secret and the backend work.

### 7. Production `.env`

| Variable | Value |
| --- | --- |
| `IS_DEMO` | `false`. With this, the server requires everything in this table and uses no stubs. |
| `PUBLIC_BASE_URL` | Fixed HTTPS domain of the deployment (the one used by the tools and the Twilio webhooks). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Twilio account and number (the one imported into ElevenLabs). |
| `ELEVENLABS_API_KEY` | With agent and phone number permissions. |
| `ELEVENLABS_HELP_AGENT_ID`, `ELEVENLABS_FOLLOWUP_AGENT_ID`, `ELEVENLABS_AGENT_PHONE_NUMBER_ID` | Steps 1, 4 and 5. |
| `ELEVENLABS_TOOL_SECRET` | Step 2. |
| `COMMS_SERVICE_TOKEN` | Token the backend uses to deliver `followup.due`; share it only with Member 3. |
| `BACKEND_BASE_URL`, `BACKEND_SERVICE_TOKEN`, `ADVISOR_BASE_URL` | Deployed backend and advisor. |
| `FOLLOWUP_POLL_INTERVAL_MS` | `30000` while the backend doesn't deliver `followup.due` on its own. |

`DEMO_ALLOWED_NUMBERS`, `DEMO_IGNORE_ALLOWED_HOURS` and `MOCK_*` are demo only.

## Changing an agent

Edit it in the dashboard → `npm run agents:check` → `npm run agents:pull` → commit. If the change touches a tool (parameters, name, URL), `agents:check` tells you whether the code accepts it; if a new parameter is needed, it must first be added in `src/tools/voice-tools.ts`.

## How they work

### Help agent (section 2.1)

The session is `system__conversation_id` and the phone is `system__caller_id`: the model doesn't write them. Identity, plot and permissions live in communications ([`src/tools/voice-tools.ts`](../src/tools/voice-tools.ts)); the model only sees numbered names, never tokens or IDs.

| Tool | What it does |
| --- | --- |
| `resolve_farmer` | Candidates by caller ID (`POST /v1/contact-resolution`). Names only: "1 Rosa, 2 Marta". |
| `confirm_farmer` | Confirms the candidate the person named; returns their numbered plots and which permissions are missing. If the candidate expired (15 min), asks to confirm again. |
| `get_plot_context` | Sets a plot of the confirmed farmer (`GET /v1/plots/{id}/context`) for the rest of the call. |
| `record_consent` | Three separate permissions (`POST /v1/consents`). Unregistered number: valid for this call only. |
| `assess_observation` | Advisor needs or guidance, with the confirmed plot; at most 3 rounds and 5 questions. |
| `submit_report` | Only with permission to save; uses the confirmed plot (or none for an unregistered number). |

If the call drops without `submit_report`, after `VOICE_SESSION_IDLE_MS` (15 min) what was described is saved as `completeness: "partial"`, only if there was permission.

### Follow-up agent (sections 2.2 and 17)

1. `followup.due` arrives at `POST /v1/followups/{id}/dispatch` (with `COMMS_SERVICE_TOKEN`) or, as a fallback, through polling `GET /v1/followups`.
2. The dispatcher requires follow-up permission, allowed hours (08:00–19:00 local time) and, in demo, the `DEMO_ALLOWED_NUMBERS` allowlist.
3. Attempts 1 to 3: an outbound call (`POST /v1/convai/twilio/outbound-call`, no recording) with these variables:

   | Variable | Contents |
   | --- | --- |
   | `farmer_name` | Farmer's name |
   | `threat_label` | Threat in words ("coffee leaf rust") |
   | `symptoms` | Reported symptoms, comma-separated |
   | `guidance_given` | Guidance that was given, or "none" |
   | `followup_id`, `plot_id`, `session_id` | IDs the tools use |
   | `attempt_number` | Attempt number |

4. The agent asks, in order: how the plot is doing, what they did, whether it worked and since when, and calls `submit_followup` once. If it got worse, it continues with `assess_observation` and `submit_report`.
5. Without `submit_followup` within `FOLLOWUP_CALL_RESULT_TIMEOUT_MS` (10 min), `no_response` is recorded (expired by the next event or by the sweep every minute) and the backend reschedules the retry. After 3 unanswered calls, an SMS. Silence never lowers the risk.

Triggering a call by hand (demo):

```bash
curl -X POST "http://127.0.0.1:8080/v1/followups/<followup_id>/dispatch" \
  -H "Authorization: Bearer $COMMS_SERVICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"event_id":"evt_<unique>","schema_version":"2.0","event_type":"followup.due","occurred_at":"2026-10-04T06:00:00Z","aggregate_id":"<followup_id>","aggregate_version":1,"correlation_id":null,"is_demo":true,"payload":{"followup_id":"<followup_id>"}}'
```

Without ElevenLabs credentials (demo only), the dispatcher uses a stub: it records the attempt and calls nobody.

The `symptoms` and `guidance_given` text comes from the backend: with the real backend it stays in Spanish until Member 3 translates the seeds.
