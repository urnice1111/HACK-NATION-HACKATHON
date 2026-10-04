#!/usr/bin/env bash
# Drops the business tables, re-runs migrations and loads the demo seed.
# Usage: DATABASE_URL=postgresql://... backend/scripts/reset_db.sh
# Never point this at a database with real data.
set -euo pipefail

cd "$(dirname "$0")/../.."
: "${DATABASE_URL:=postgresql://postgres:postgres@localhost:54322/agro}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop table if exists
  public.graph_versions, public.idempotency_keys, public.outbox_events, public.case_resolutions, public.notifications,
  public.followups, public.alerts, public.edges, public.risk_evaluations, public.risk_models,
  public.assessments, public.reports, public.cases, public.plots, public.farmers, public.contacts
  cascade;
drop function if exists public.touch_updated_at() cascade;
SQL

for f in backend/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -v artifact="$(cat contracts/fixtures/risk_model_heuristic.json)" \
  -f backend/seed/demo_seed.sql

if [[ "${SKIP_ENV_MOCK:-0}" != "1" ]]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f backend/seed/env_mock.sql
fi

if [[ -f backend/seed/local_overrides.sql ]]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f backend/seed/local_overrides.sql
  echo "Applied backend/seed/local_overrides.sql"
fi

echo "Database reset with demo seed."
