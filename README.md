# Agro Voice MVP

Farmers report crop problems (coffee leaf rust) by **phone call or SMS**, without installing an app. An AI advisor
asks for the missing information, checks environmental data and previously resolved cases, and gives guidance.
Reports feed a graph of plots that prioritizes inspections; an operator reviews and approves collective alerts
from a dashboard, and the system calls the affected farmers back.

Full specification (Spanish): [`INSTRUCTIONS.md`](INSTRUCTIONS.md). Data sources and limits: [`docs/DATOS.md`](docs/DATOS.md).
Demo script: [`docs/DEMO.md`](docs/DEMO.md).

## Architecture

| Folder | What it is | Stack |
| --- | --- | --- |
| [`backend/`](backend) | `/v1` HTTP API, graph engine, risk model, follow-ups, alerts and notifications | Python 3.12, FastAPI, PostgreSQL |
| [`advisor/`](advisor) | Agricultural advisor (`POST /v1/assessments`), runs **inside the backend process** | Claude Haiku 4.5 or OpenAI, Pydantic |
| [`communications/`](communications) | Twilio SMS webhooks, ElevenLabs voice agents and tools, follow-up and alert calls | Node 22, TypeScript |
| [`dashboard/`](dashboard) | Operator dashboard (map, graph, alerts, follow-ups). Also published as its own repo: [A01754754/dashboard](https://github.com/A01754754/dashboard) | React, Vite, MapLibre |
| [`contracts/`](contracts) | Shared Pydantic models and the exported JSON Schemas | Python |
| [`risk_model/`](risk_model) | Offline training of the linear inspection-priority model | Python |

```
Farmer ──call/SMS──▶ Twilio / ElevenLabs ──▶ communications ──▶ backend (+ advisor) ──▶ PostgreSQL
                                                                     ▲
                                                 dashboard ──────────┘
```

## Requirements

- Python **3.12+**
- Node.js **22+** and npm
- Docker (for the local PostgreSQL) and the `psql` client
- Optional, for the real advisor: an Anthropic or OpenAI API key
- Optional, for real calls/SMS: Twilio and ElevenLabs accounts and [ngrok](https://ngrok.com/)

## Installation

### 1. Clone and create the Python environment

```bash
git clone <repo-url> HACK-NATION-HACKATHON
cd HACK-NATION-HACKATHON
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

### 2. Start the database and load the demo data

```bash
docker compose up -d db
backend/scripts/reset_db.sh
```

PostgreSQL listens on `localhost:54322` (`postgres` / `postgres`, database `agro`). `reset_db.sh` drops the business
tables, runs `backend/migrations/*.sql` and loads the demo seed (8 synthetic plots around Xalapa–Coatepec–Huatusco)
plus mock environmental data. Never point it at a database with real data.

Optional, real environmental data and curated external context:

```bash
python -m backend.scripts.load_nasa_power            # downloads NASA POWER (add --offline to reuse the cache)
psql postgresql://postgres:postgres@localhost:54322/agro -f backend/seed/external_context.sql
```

### 3. Configure the backend

```bash
cp .env.example .env
```

Main variables (`.env` at the repo root; exported variables win over the file):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:54322/agro` | PostgreSQL connection string |
| `APP_ENV` | `dev` | Outside `dev`, `TOKEN_SECRET` is required |
| `TOKEN_SECRET` | `dev-token-secret` in dev | Signs candidate tokens |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated dashboard origins |
| `ADVISOR_MODE` | `openai` | `openai` = real model, `mock` = fixed answer without an API key |
| `ADVISOR_PROVIDER` | `openai` | `anthropic` to use Claude Haiku 4.5 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | Key for the chosen provider (server side only) |
| `ADVISOR_BACKEND_BASE_URL` | `http://localhost:8000` | Where the advisor calls the internal API (the backend itself) |

To try everything without an API key, set `ADVISOR_MODE=mock`. Never commit `.env`.

### 4. Run the backend

```bash
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
```

Health check: <http://localhost:8000/v1/health>. Interactive API docs: <http://localhost:8000/docs>.

### 5. Run the dashboard

```bash
cd dashboard
npm install
VITE_API_MODE=http VITE_API_URL=http://localhost:8000/v1 npm run dev
```

Open <http://localhost:5173>. Without `VITE_API_MODE=http` the dashboard uses built-in mock data and needs no backend.

### 6. Run communications (calls and SMS)

```bash
cd communications
npm install
cp .env.example .env
npm run dev                # webhook server on http://127.0.0.1:8080
```

Point `BACKEND_BASE_URL` in `communications/.env` at `http://127.0.0.1:8000`. Without Twilio/ElevenLabs credentials
and with `IS_DEMO=true`, outbound SMS and follow-up calls use stubs. To receive real calls and SMS, expose the
server with `ngrok http 8080`, set `PUBLIC_BASE_URL` and configure the agents and webhooks as described in
[`communications/README.md`](communications/README.md) and [`communications/agents/README.md`](communications/agents/README.md).

`scripts/run_followup_mac.sh` prepares the database and prints the four terminals needed to trigger a follow-up call.

## Tests

```bash
pytest                       # backend and contracts (needs the database from step 2; skipped otherwise)
pytest advisor/tests         # advisor
cd communications && npm test && npm run typecheck
```

After changing [`contracts/models.py`](contracts/models.py), regenerate the JSON Schemas with
`python -m contracts.export_schemas`. To retrain the risk model: `python risk_model/train.py`.

## Deployment

[`render.yaml`](render.yaml) is a Render Blueprint with three services: `agro-backend` (API + advisor),
`agro-communications` and `agro-dashboard` (static site). In Render: **New → Blueprint →** this repository, then fill
in the secrets marked `sync: false` (database URL, API keys, Twilio, ElevenLabs, URLs between services). The database
(Supabase/PostgreSQL) is not managed by the Blueprint: run the migrations and seed against it with `reset_db.sh`.
After the first deploy, update the ElevenLabs tools, the post-call webhook and the Twilio SMS webhooks to the new
URLs and run `npm run agents:check` in `communications/`.

## Data and limitations

All farmers, plots and reports are synthetic (`is_demo = true`). Environmental data comes from NASA POWER (~50 km
cells), so it does not capture plot microclimate. The inspection priority comes from a linear regression trained on
synthetic labels: it is not a validated contagion probability. Details in [`docs/DATOS.md`](docs/DATOS.md).
