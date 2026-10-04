-- Monotonic graph version per threat, bumped on every recalculation (GET /v1/graph -> graph_version).
create table public.graph_versions (
  threat_code text primary key,
  version int not null default 0,
  updated_at timestamptz not null default now()
);
