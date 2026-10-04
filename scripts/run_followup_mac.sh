#!/usr/bin/env bash
# Prepares the local DB and prints the four terminals you need for a follow-up call.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Starting Postgres…"
docker compose up -d db >/dev/null
for i in $(seq 1 30); do
  pg_isready -h localhost -p 54322 -U postgres >/dev/null 2>&1 && break
  sleep 1
done

psql postgresql://postgres:postgres@localhost:54322/agro -v ON_ERROR_STOP=1 -q \
  -f backend/seed/local_overrides.sql
echo "contact_demo_01 -> +525569656769"

cat <<'EOF'

Open FOUR terminals from the repo root.

Terminal 1 — backend
  .venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload

Terminal 2 — communications
  cd communications && npm run dev

Terminal 3 — ngrok (leave it open; copy the https Forwarding URL)
  ngrok http 8080

  Then put that URL (no trailing slash) in communications/.env as PUBLIC_BASE_URL
  and restart Terminal 2. ElevenLabs tools need the public URL.

Terminal 4 — trigger the call (08:00–19:00 Mexico City)
  curl -X POST "http://127.0.0.1:8080/v1/followups/followup_demo_01/dispatch" \
    -H "Authorization: Bearer emiliano123emiliano123" \
    -H "Content-Type: application/json" \
    -d '{"event_id":"evt_test_1","schema_version":"2.0","event_type":"followup.due","occurred_at":"2026-10-04T05:00:00Z","aggregate_id":"followup_demo_01","aggregate_version":1,"correlation_id":null,"is_demo":true,"payload":{"followup_id":"followup_demo_01"}}'

  Use localhost, not the old ngrok hostname. Change event_id if you retry.

If the phone does not ring, communications is using the stub: Integrante 1 must
set ELEVENLABS_API_KEY, ELEVENLABS_FOLLOWUP_AGENT_ID and
ELEVENLABS_AGENT_PHONE_NUMBER_ID in communications/.env.

EOF
