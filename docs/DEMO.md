# Demo runbook

How to set up, run and rescue the 9-step demo of INSTRUCTIONS.md §16. Rehearse it **twice** with this page open before presenting.
Product UI and voice agents are in English.

## Phones and roles

| Who | Role during the demo |
| --- | --- |
| Presenter | Narrates; reads the "Say" lines. |
| Operator (Integrante 4) | Drives the dashboard on the projected screen. |
| Farmer (holds **Phone A**) | Calls the help line in steps 2–4; answers the follow-up call in step 7. |
| Neighbor (holds **Phone B**) | Answers the alert call in step 6; optional caller in step 9. |
| Integrante 1 (communications) | Watches communications logs and ElevenLabs; fires the step 7 trigger. |
| Integrante 2 (advisor) | Watches advisor logs. |
| Integrante 3 (backend) | Watches backend logs; resets the DB. |

| Number | Used for |
| --- | --- |
| **+1 937 358 8143** | Help line. Phone A dials it (steps 2 and 9). The ElevenLabs "Help" agent answers. |
| **+1 402 448 6040** | Caller ID of every outbound call: follow-up (step 7) and alert (step 6). Save it in both phones as "Coffee alerts" so people pick up. |

Phone A and Phone B must be two different real phones (they can't share a SIM). Both must be able to call or receive calls from a US number. Neither one may be on Do Not Disturb.

## 1. Setup

### What runs where

Use three laptops on the same Wi-Fi network. Write the LAN IP of machine 1 here before rehearsing: `BACKEND_HOST = __________`.

| Machine | Owner | Runs | Port |
| --- | --- | --- | --- |
| 1 | Integrante 3 | Postgres (`docker compose up -d db`, from the repo root) | 54322 |
| 1 | Integrante 3 | Backend: `.venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 8000` | 8000 |
| 1 (or 2's machine) | Integrante 2 | Advisor: `.venv/bin/uvicorn advisor.app:app --app-dir advisor/src --host 0.0.0.0 --port 8001`. Its default port is also 8000, so `--port 8001` is required on a shared machine. | 8001 |
| 2 | Integrante 1 | Communications: `cd communications && npm run dev` | 8080 |
| 2 | Integrante 1 | ngrok: `ngrok http 8080 --url=<PUBLIC_BASE_URL>` (the reserved domain, so the URL in ElevenLabs stays valid) | — |
| 3 | Integrante 4 | Dashboard: `cd dashboard && VITE_API_MODE=http VITE_API_URL=http://<BACKEND_HOST>:8000/v1 npm run dev`, opened at http://localhost:5173 | 5173 |

Communications `.env` (machine 2) must have:

- `BACKEND_BASE_URL=http://<BACKEND_HOST>:8000` and `ADVISOR_BASE_URL=http://<advisor host>:8001`.
- `PUBLIC_BASE_URL` set to the ngrok URL.
- Help, follow-up and **alerts** agent IDs (`ELEVENLABS_ALERT_AGENT_ID`). Without the alerts agent ID, alert calls are off.
- `ALERT_POLL_INTERVAL_MS` > 0 (default is 15 s).
- `DEMO_ALLOWED_NUMBERS` with **both** Phone A and Phone B. A number left out ends as "Could not notify — number not on the demo allowlist".
- To rehearse outside 08:00–19:00 Mexico City time, set `DEMO_IGNORE_ALLOWED_HOURS=true`. It only works with `IS_DEMO=true`.

Backend (machine 1): the dashboard's origin `http://localhost:5173` is allowed by CORS by default. If the dashboard runs on another origin, start the backend with `CORS_ORIGINS=<origin>`.

### Map the demo phones to demo farmers

The seed uses fictional numbers. Real phones are mapped in `backend/seed/local_overrides.sql`, which is git-ignored, so each machine 1 needs its own copy. `reset_db.sh` applies it automatically.

- **Phone A** → `contact_demo_01` (the farmer of Plot 1 and Plot 2, a shared phone, so the agent asks who is speaking).
- **Phone B** → the contact of the plot that gets the **pending alert** after step 5. Find it in rehearsal 1: after the report, open **Alerts** and note the plot. That contact needs `notification_consent = true` (`contact_demo_06` has none).

### Reset the database (before every run)

On machine 1, from the repo root:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:54322/agro backend/scripts/reset_db.sh
```

It must print `Applied backend/seed/local_overrides.sql` and `Database reset with demo seed.` Then:

- Restart communications (`Ctrl-C`, `npm run dev`). Sessions and in-flight calls live in memory.
- Reload the dashboard.

### Check that everything is up

```bash
curl -s http://<BACKEND_HOST>:8000/v1/health
```
Expect `{"status":"ok"}`. This checks the database too; a 503 means Postgres is down.

```bash
curl -s http://127.0.0.1:8080/v1/health
```
Run on machine 2: communications is up.

```bash
curl -s <PUBLIC_BASE_URL>/v1/health
```
Same check through ngrok. This is what ElevenLabs and Twilio reach.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<advisor host>:8001/docs
```
Expect `200`. The advisor has no `/v1/health` yet, so this only proves the process answers.

```bash
cd communications && npm run agents:check
```
All agents (help, follow-up, alerts) must pass, including language `en`.

On the dashboard, the map loads with 8 plots and the green **Demo mode: simulated data** pill. There must be no orange **Offline** banner. **Alerts** shows no pending alerts.

## 2. The 9 steps

Timings: the dashboard polls every 5 s. Communications picks up approved alerts every 15 s. Each alert call attempt waits up to 2 min for an answer, with 3 attempts.

### Step 1 — Initial state

- **Who:** Operator.
- **Dashboard:** the map. Point at the **Demo mode: simulated data** pill, the priority filter counts and the legend. Click Plot 1 to show the score, contributions and model version.
- **Say:** "Eight demo coffee plots in central Veracruz. Everything you see is simulated data, and it's labelled as such. Colour is inspection priority, never a diagnosis."
- **Fallback:** if the map doesn't load, check backend health, then reload. Last resort: run the dashboard in mock mode (`npm run dev` with no env vars) and **say** "this is the offline fixture, not the live system".

### Step 2 — Farmer calls the help line

- **Who:** Farmer, using **Phone A**. Dial **+1 937 358 8143** on speaker.
- **Action:** confirm identity (the phone is shared, so the agent asks which farmer: say Plot 1's farmer) and give permissions. Describe it: "Since yesterday I see yellow spots with orange powder on several plants."
- **Dashboard:** nothing yet.
- **Say:** "No app, no data plan: a plain phone call."
- **Fallback:** if it doesn't ring, check the Twilio number's voice URL points to ElevenLabs, and that ngrok is up (`<PUBLIC_BASE_URL>/v1/health`). If the call drops mid-way, call again: identity and consent are already saved.

### Step 3 — The advisor checks data first and only asks what's missing

- **Who:** Farmer answers the agent's questions (for example about the underside of the leaves and the weather).
- **Dashboard (after the call):** **Plot 1** → **History** → "The advisor checked data before asking", with **Environmental data it checked**.
- **Say:** "The agent never asked about humidity or rain: the advisor queried the environmental datasets first. It only asks what the farmer alone knows."
- **Fallback:** open the conversation in ElevenLabs (**Agents → Help → History**) and show the `assess_observation` tool response with `data_used`. Known risk to confirm in rehearsal 1: the real advisor may not store its assessments in the backend yet, so the dashboard history can come up empty.

### Step 4 — Allowed guidance and a similar resolved case

- **Who:** Farmer listens. The agent gives protocol-only cultural practices and mentions a similar resolved case.
- **Dashboard:** **Plot 1 → History** → "The advisor gave guidance", with recommendations and **Resolved case it mentioned**.
- **Say:** "Only practices from the protocol. Any fungicide or dose is referred to an agronomist."
- **Fallback:** same as step 3: the ElevenLabs transcript and tool calls.

### Step 5 — Report saved, model recalculates

- **Who:** the agent saves the report at the end of the call (`submit_report`). It only says "it's been recorded" after the backend confirms.
- **Dashboard:** within ~5 s, Plot 1 and its neighbours change colour on the map. Click a neighbour to show **Source: exposure to neighboring plots with an active case** and its reasons. A new pending alert appears on **Alerts** (badge on the nav).
- **Say:** "The regression recalculates the plot and its neighbours, and every change is traceable to evidence, features and a model version."
- **Fallback:** if the map doesn't change, ask Integrante 3 to run `curl -X POST http://<BACKEND_HOST>:8000/v1/graph/recalculate`. If the report never saved, show the report in **Plot 1 → History** or the backend logs.

### Step 6 — Operator approves the alert → Phone B gets a call

- **Who:** Operator, then the Neighbor with **Phone B**.
- **Action:** **Alerts** → the pending alert → read the reasons aloud → **Approve and call**.
- **Phone:** Phone B rings from **+1 402 448 6040** within ~15–20 s. The "Alerts" agent reads the approved message and asks the neighbor to confirm they heard it. Answer, listen, confirm.
- **Dashboard:** the alert moves to **Reviewed** and its badge walks: **Queued** → **Calling (attempt 1)** → **Call in progress** → **Farmer confirmed they heard the alert**. **Details** opens the same status for that alert alone.
- **Say:** "A person approves every alert before anyone is contacted. 'Confirmed' means the farmer said they heard it, not that they acted on it."
- **Fallback:**
  - Stuck on **Queued** for more than 30 s: communications isn't polling. Check `ELEVENLABS_ALERT_AGENT_ID` and `ALERT_POLL_INTERVAL_MS`, and look in the communications logs.
  - **Could not notify — number not on the demo allowlist**: Phone B is missing from `DEMO_ALLOWED_NUMBERS`.
  - **Could not notify — no consent for alerts**: Phone B's contact has `notification_consent = false`.
  - **Could not notify — someone else answered**: the agent didn't recognise the person. Say so; it's correct behaviour.
  - **No answer**: the next attempt goes out after 2 min, so keep talking. To show it without waiting, open the ElevenLabs call in **Agents → Alerts → History**.
  - Approving gives "Another operator already reviewed this alert": someone approved it in another window. The list shows the real state; carry on.

### Step 7 — Follow-up call: the farmer says it's resolved (SIMULATED TRIGGER)

There is no worker yet, so `followup.due` does not fire on its own. **Integrante 1 triggers it by hand with a curl to communications. This is a simulated stage: the presenter must say it out loud.**

- **Who:** Integrante 1 runs the trigger. Farmer answers **Phone A**.
- **Action:**
  1. Find the follow-up id. On the dashboard, **Follow-ups** shows the follow-up for Plot 1 under Overdue or Scheduled. The id comes from `curl -s 'http://<BACKEND_HOST>:8000/v1/followups?status=scheduled'`.
  2. Run the trigger. Ask Integrante 1 for the exact command and paste it here before rehearsal 1. It is a `POST <comms>/v1/followups/<followup_id>/dispatch` with the `followup.due` event as the body and the communications service token. `scripts/run_followup_mac.sh` prints the shape. Use a new `event_id` on every run, because repeats are deduplicated.

     ```
     (paste Integrante 1's command here — keep the token out of git)
     ```
  3. Phone A rings from **+1 402 448 6040**. The farmer says: "It's resolved. I removed and buried the spotted leaves and opened up the shade."
- **Dashboard:** **Follow-ups** moves Plot 1 to **In progress**, then **Responded**.
- **Say:** "**This trigger is simulated:** in production the scheduler fires it, 7 days after the report (3 minutes in the demo). We fire it by hand because the worker isn't built yet. Everything after the trigger is real."
- **Fallback:** if the phone doesn't ring, check the communications logs (a stub means missing ElevenLabs credentials) and the allowed hours. If the call happened but nothing was saved, show the transcript in ElevenLabs (**Agents → Follow-up → History**).

### Step 8 — Resolution recorded, neighbours recalculated

- **Who:** Operator.
- **Dashboard:** **Resolved** shows Plot 1 with the solution, **Reported by the farmer** and **Matches the protocol**. On the map, Plot 1 is no longer a source case, and its neighbours' exposure drops.
- **Say:** "Resolutions are labelled by who confirmed them. Next time, the advisor can use this one."
- **Fallback:** if the map didn't change, use the step 5 recalculation curl. If **Resolved** is empty, show the follow-up answer in ElevenLabs and the backend logs.

### Step 9 (optional) — A neighbour calls with similar symptoms

- **Who:** Neighbor, using **Phone B**. Dial **+1 937 358 8143** and describe similar spots.
- **Dashboard:** the neighbour's plot history shows **Resolved case it mentioned** pointing to Plot 1's resolution.
- **Say:** "What worked on Plot 1 now helps its neighbour, without sharing anyone's identity."
- **Fallback:** skip it. It's optional.

## 3. Known gaps to say out loud if they show

- Step 7's trigger is manual (no worker yet).
- Some text from the backend seed and the advisor (plot names, reasons, recommendations) is still in Spanish until those modules are translated.
- Offline requirement: declared **not met** for this MVP (INSTRUCTIONS.md §17).

## 4. Rehearsals

Do the first full rehearsal only once **Integrante 3's alert notifications** (voice channel, `/v1/notifications`) and **Integrante 2's real advisor** are merged into `main`. Every machine runs `main` plus its own `.env` and `local_overrides.sql`.

| # | Date | Steps that worked | Problems and fixes | Total time |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |

After each rehearsal, update this runbook (step 7 command, Phone B's contact, real timings).
