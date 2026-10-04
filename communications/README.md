# communications (Member 1)

Twilio/ElevenLabs adapters, sessions, delivery and follow-up for the agriculture MVP. Source of truth: [`INSTRUCTIONS.md`](../INSTRUCTIONS.md) (repo root); agent guide in [`CLAUDE.md`](CLAUDE.md).

## Getting started

```bash
npm install
cp .env.example .env   # set MOCK_SERVICE_TOKEN and BACKEND_SERVICE_TOKEN to the same random value
npm run mock:backend   # /v1 mock at http://127.0.0.1:8787
npm run dev            # webhook server at http://127.0.0.1:8080
npm test               # contract, SMS webhook and follow-up tests against the mock
npm run typecheck
```

## Testing with real SMS

1. Terminal 1: `npm run mock:backend`. With `MOCK_PHONE_OVERRIDES` in `.env` you map your cell to a demo farmer; otherwise you're treated as an unknown number.
2. Terminal 2: `npm run dev`.
3. Terminal 3: `ngrok http 8080 --url=<PUBLIC_BASE_URL>`.
4. In Twilio: Phone Numbers → Active numbers → your number → *Messaging configuration* → "A message comes in": Webhook, `<PUBLIC_BASE_URL>/v1/webhooks/twilio/sms`, HTTP POST (or in its Messaging Service). Don't touch the voice configuration: ElevenLabs manages it.
5. Send an SMS from your cell.

## SMS conversation

Identity (the number isn't enough) → plot if there are several → consent → description → questions based on the advisor's `information_needs` → guidance → report.

- The advisor doesn't write the question: `src/sms/messages.ts` phrases it from a template per `need_code`, one per turn, starting with the highest `priority`. Answers are normalized by `answer_type` (`{need_code, value, unit, raw_text, unknown}`); "I don't know" → `value: null, unknown: true`, never zero. `asked_need_codes` is sent with every assessment; at most 3 rounds and 5 questions.
- Replies go out as TwiML in the same webhook, with at most two blocking backend calls per SMS (`SMS_STEP_TIMEOUT_MS` each).
- One conversation produces one report with `Idempotency-Key: report-sms-<MessageSid of the first SMS>`: a repeated webhook never duplicates anything, even if the process restarts. "It's been recorded" is only said after a 201; if the save is ambiguous, the farmer is told and it's retried with the same key (at most 3 attempts).
- An abandoned conversation (`SMS_SESSION_IDLE_MS`) is saved as `completeness: "partial"` if there was consent.
- Yes/no questions ask for **Y or N** (also accepts yes, no, 1, 0…). The copy avoids "reply YES" because Twilio treats YES as an opt-in keyword and may answer on its own.

**Consent** (three permissions, section 17). `contact-resolution` returns the stored ones (`null` = never asked):

- Reports: if never given, the permission is requested; if already given, only this report is confirmed. If they say N, nothing is saved.
- Alerts and follow-ups: only asked of a confirmed farmer who never answered.
- Saved with `POST /v1/consents` in the background, with retries. An unknown number only answers the report permission, valid for that conversation.

**Opt-out.** "ALERTS OFF" revokes alerts and follow-up calls (`POST /v1/consents/revocations`) and is answered only after a 200; if it's pending, we say it's being processed. It doesn't revoke the permission to report. STOP and similar keywords do the same in the backend, but we don't reply: Twilio replies and blocks the number. An ongoing conversation is closed, saving what was received as partial.

**SMS follow-up.** Fallback after 3 unanswered calls; the dispatcher starts it with `FollowupSmsFlow.start(item)`. It requires follow-up permission, allowed hours (08:00–19:00 local time) and, in demo, `DEMO_ALLOWED_NUMBERS`; it never steps on an open conversation. It records the `contacting` attempt **before** sending. It asks, one per SMS, how the plot is doing (1 worse, 2 same, 3 better, 4 resolved), what they did and whether it worked, and saves it with `POST /v1/followups/{id}/responses`. With no reply within `FOLLOWUP_SMS_REPLY_WINDOW_MS` (24 h) it records `no_response`: silence never declares a resolution. An ambiguous send is never resent. Without `TWILIO_ACCOUNT_SID`, outbound SMS use a stub.

Limitation: sessions live in memory. If the process restarts, the ongoing conversation starts over. Persisting them needs a table from Member 3.

## ElevenLabs agents

They are created and tuned in the ElevenLabs dashboard; the code only uses their IDs (`ELEVENLABS_HELP_AGENT_ID`, `ELEVENLABS_FOLLOWUP_AGENT_ID`) and checks their configuration. Step-by-step guide and production `.env`: [`agents/README.md`](agents/README.md).

## Help agent (inbound calls)

Whoever calls the Twilio number talks to the ElevenLabs help agent: identity by caller ID and confirmation → plot → permissions → description → advisor questions → guidance → report. The tools (`resolve_farmer`, `confirm_farmer`, `get_plot_context`, `record_consent`, `assess_observation`, `submit_report`) keep identity, plot and permissions in communications, so the model can't pick another plot or save without permission. Details and configuration in [`agents/README.md`](agents/README.md).

## Follow-up agent (outbound calls)

Flow, dynamic variables and ElevenLabs configuration: [`agents/README.md`](agents/README.md).

- `followup.due` arrives via `POST /v1/followups/{id}/dispatch` (token `COMMS_SERVICE_TOKEN`, deduplicated by `event_id`) or by polling every `FOLLOWUP_POLL_INTERVAL_MS`.
- Attempts 1–3: a call with the follow-up agent; then an SMS; if the SMS goes unanswered, no further contact.
- The tools (`/v1/tools/*`) authenticate with `ELEVENLABS_TOOL_SECRET`; only `registered: true` allows saying "it's been recorded".
- Without `submit_followup` within `FOLLOWUP_CALL_RESULT_TIMEOUT_MS`, `no_response` is recorded. A transient ElevenLabs failure waits `FOLLOWUP_PLACEMENT_BACKOFF_MS` without using up an attempt; an ambiguous response is never repeated. Without credentials, calls use a stub.
- To test at night: `DEMO_IGNORE_ALLOWED_HOURS=true` skips the allowed hours. Only with `IS_DEMO=true` (otherwise the server won't start), and it never skips consent or the allowlist.

Limitation: in-progress calls are remembered in memory. If the process restarts with a call that has no result, the follow-up stays in `contacting` until the ElevenLabs post-call webhook (phase 6) reconciles it.

## Structure

| Path | Contents |
| --- | --- |
| `src/server/` | HTTP server: SMS webhook, voice tools (`/v1/tools/*`) and `followup.due` (`/v1/followups/{id}/dispatch`). `main.ts` wires up the dependencies. |
| `src/sms/` | SMS conversation (`conversation.ts`), SMS follow-up (`followup.ts`), session types (`session.ts`) and copy (`messages.ts`). |
| `src/followups/dispatcher.ts` | `followup.due` dispatcher: permission, hours and allowlist; up to 3 calls, then SMS. |
| `src/tools/voice-tools.ts` | Server tools for the agents: help (`resolve_farmer`, `confirm_farmer`, `get_plot_context`, `record_consent`) and shared (`assess_observation`, `submit_report`, `submit_followup`). |
| `src/elevenlabs/agents.ts` | Reads the agents from the ElevenLabs account and checks their configuration (at startup and with `npm run agents:check`); `npm run agents:pull` saves the reference copy into `agents/`. |
| `src/backend/` | `/v1` client that validates every response (`client.ts`) and writes with a fixed Idempotency-Key and bounded retries (`writer.ts`). |
| `src/twilio/`, `src/elevenlabs/` | Twilio signature and TwiML, SMS sending and outbound calls, both with a stub. |
| `src/policy/outreach.ts` | Proactive contact: consent, local hours and demo allowlist. |
| `src/contracts/` | Provisional copy of the v2 contracts as zod schemas. |
| `src/http/`, `src/util.ts` | request_id, uniform error, 422 validation, logs with masked phones; per-key mutex and capped map. |
| `src/mock-backend/` | `/v1` mock (backend + advisor) with demo fixtures and in-memory state. |
| `agents/` | Prompts and tools of the ElevenLabs agents. |

## /v1 mock

Routes: `POST /v1/contact-resolution`, `GET /v1/plots/{id}/context` (`X-Session-Id` header), `POST /v1/assessments`, `POST /v1/reports`, `GET /v1/reports/{id}`, `GET /v1/followups?status=…&due_before=…`, `POST /v1/followups/{id}/responses`, `GET /v1/health`. PROPOSED (not in v2): `POST /v1/followups/{id}/attempts`, `POST /v1/consents`, `POST /v1/consents/revocations`. All except health require `Authorization: Bearer <MOCK_SERVICE_TOKEN>` and only accept `is_demo: true`.

The mock advisor mimics v2: a first turn with two needs (`local_weather_perception`, `leaf_underside`), never repeats `asked_need_codes`, "I don't know" doesn't count as an answer, refers after 5 questions or on fungicide/dose questions, declares what it queried in `data_used`, and in `advise` mentions a `verified` case first, never one with a product and dose. A `resolved` follow-up creates a single resolution and closes the case; the others schedule another one 3 minutes later.

Scenarios with the `X-Mock-Scenario` header: `advisor_unavailable`, `backend_unavailable`, `delay:<ms>`.

Fixtures (`src/mock-backend/fixtures.ts`, fictional phones +1 202 555 01xx; threat `coffee_leaf_rust`, protocol `coffee-rust-demo-v1`):

| Phone | Test case |
| --- | --- |
| `+12025550101` | Known number, one plot, with environmental summary |
| `+12025550102` | Phone shared by two farmers |
| `+12025550104` | No alert or follow-up consent; plot out of coverage |
| `+12025550105` | Active case with a **due** follow-up (`followup_demo_05`) |
| `+12025550106` | Case with a `no_response` follow-up after 3 attempts |
| `+12025550107`, `+12025550108` | Plots without context (`crop: null`) and consent never asked |
| any other | Unknown number (`no_match`) |

Resolved cases: `resolution_demo_01` (`verified`), `resolution_demo_02` (`farmer_reported`) and `resolution_demo_03` (product and dose: the advisor leaves it out).

## Real backend (Member 3)

`backend/` and `contracts/` already implement the shapes communications proposed (marked AGREED in `src/contracts/resources.ts`): two-step `contact-resolution`, `consents`, `consents/revocations`, `plots/{id}/context`, `reports`, `reports/{id}`, `GET /v1/followups`, `…/attempts` and `…/responses`. `test/contracts-compat.test.ts` checks it against `contracts/schemas/*.json`. Also, every report with a case schedules a follow-up 3 minutes later (demo).

To use it: `BACKEND_BASE_URL=http://<host>:8000` (with or without `/v1`) and an empty `BACKEND_SERVICE_TOKEN`. Differences communications already absorbs:

- The advisor is a separate service (`advisor/`): `ADVISOR_BASE_URL`. If it isn't running, use the mock's advisor (`ADVISOR_BASE_URL=http://127.0.0.1:8787` with `npm run mock:backend` running; it only knows the `plot_demo_*` plots). Its errors arrive as `{"detail": …}`.
- The `candidate_token` lasts 15 min: SMS and voice ask again who they're speaking with.
- A permission never asked becomes `false` as soon as another one is saved (only `consent_at: null` means "never").
- The backend doesn't deliver `followup.due` yet: you need polling (`FOLLOWUP_POLL_INTERVAL_MS` > 0) or the `/v1/followups/{id}/dispatch` curl.
- Language: communications is in English, but the backend and the advisor still produce Spanish text (seed data, need catalog, recommendations). Until they are translated, the voice agents are told to convey guidance in English, but SMS show the advisor's options and recommendations as they arrive.

## Still to agree with Member 3

1. **How `followup.due` arrives** (PROPOSED): `POST /v1/followups/{id}/dispatch` (body = outbox event, 202 with the result), in addition to polling. The worker still needs to call it.
2. **`guidance_given`** comes from the `assessments` table, but the advisor (`advisor/`) doesn't store its assessments there: for new cases it arrives as `null` and the follow-up agent says "none".
3. **Service token:** section 17 asks for a Bearer per consumer (`comms`); the backend doesn't authenticate yet, so anyone on the network can see phone numbers in `GET /v1/followups`.
4. **Follow-up SMS as a `Notification`:** today it's sent directly and recorded as an attempt (`channel: sms`); if the notification queue is preferred, it moves to `/v1/notifications/{id}/dispatch` (phase 6), which also needs to read the queued notification and report its status.
5. **Language:** `preferred_language` defaults to `'es'` in the backend, and the seeds, `contracts/need_catalog.json`, the advisor prompt and its recommendations are in Spanish.
