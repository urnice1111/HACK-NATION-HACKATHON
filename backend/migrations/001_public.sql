-- Business schema (owner: integrante 3). See INSTRUCTIONS.md sections 9 and 11.
-- Every table: id, created_at, is_demo. Editable tables: updated_at, version.

create extension if not exists pgcrypto;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

-- People and plots ---------------------------------------------------------------

create table public.contacts (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  is_shared boolean not null default false,
  report_consent boolean not null default false,
  notification_consent boolean not null default false,
  followup_call_consent boolean not null default false,
  consent_at timestamptz,
  allowed_hours jsonb not null default '{"start": "08:00", "end": "19:00"}'
);

create table public.farmers (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  name text not null,
  preferred_language text not null default 'es',
  timezone text not null default 'America/Mexico_City',
  contact_id text not null references public.contacts(id)
);

create table public.plots (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  farmer_id text not null references public.farmers(id),
  name text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  crop text,
  variety text,
  altitude_m double precision
);

-- Cases, reports, assessments ------------------------------------------------------

create table public.cases (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  plot_id text not null references public.plots(id),
  threat_code text not null,
  status text not null default 'reported'
    check (status in ('reported', 'suspected', 'confirmed', 'monitoring', 'resolved')),
  opened_at timestamptz not null default now(),
  last_observation_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  closed_by text
);
-- One open episode per plot and threat; repeated reports join it.
create unique index cases_one_open_per_plot_threat
  on public.cases (plot_id, threat_code) where status <> 'resolved';

-- Reports are immutable observations; only processing_status changes.
create table public.reports (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  is_demo boolean not null default false,
  case_id text not null references public.cases(id),
  plot_id text not null references public.plots(id),
  session_id text not null,
  channel text not null check (channel in ('voice', 'sms', 'operator')),
  observed_at timestamptz,
  received_at timestamptz not null default now(),
  symptoms text[] not null default '{}',
  measurements jsonb not null default '[]',
  user_statement text,
  completeness text not null check (completeness in ('partial', 'sufficient')),
  provider_reference text,
  assessment_id text,
  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processed', 'failed'))
);
create index reports_plot_idx on public.reports (plot_id, received_at desc);

create table public.assessments (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  is_demo boolean not null default false,
  report_id text references public.reports(id),
  session_id text not null,
  plot_id text not null references public.plots(id),
  disposition text not null check (disposition in ('ask_more', 'advise', 'refer')),
  suspected_issue jsonb,
  evidence_quality text not null check (evidence_quality in ('insufficient', 'low', 'medium', 'high')),
  urgency text not null check (urgency in ('unknown', 'routine', 'soon', 'urgent')),
  information_needs jsonb not null default '[]',
  data_used jsonb not null default '[]',
  resolved_case_ids text[] not null default '{}',
  recommendations jsonb not null default '[]',
  human_review_required boolean not null default false,
  source_ids text[] not null default '{}',
  model_version text not null,
  protocol_version text not null
);

-- Risk model and graph ------------------------------------------------------------------

create table public.risk_models (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  threat_code text not null,
  model_version text not null,
  artifact jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  activated_at timestamptz,
  unique (threat_code, model_version)
);
create unique index risk_models_one_active
  on public.risk_models (threat_code) where status = 'active';

-- Append-only history: the latest row per (plot, threat) is the current priority.
create table public.risk_evaluations (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  is_demo boolean not null default false,
  plot_id text not null references public.plots(id),
  threat_code text not null,
  score double precision check (score between 0 and 1),
  inspection_priority text not null check (inspection_priority in ('unknown', 'low', 'medium', 'high')),
  feature_vector jsonb not null default '{}',
  contributions jsonb not null default '[]',
  reasons text[] not null default '{}',
  evidence_report_ids text[] not null default '{}',
  source_case_ids text[] not null default '{}',
  model_version text,
  heuristic boolean not null default true,
  data_freshness text not null default 'unknown' check (data_freshness in ('fresh', 'stale', 'unknown')),
  expires_at timestamptz
);
create index risk_evaluations_latest_idx
  on public.risk_evaluations (plot_id, threat_code, created_at desc);

-- Undirected edges are stored once with source_plot_id < target_plot_id.
create table public.edges (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  source_plot_id text not null references public.plots(id),
  target_plot_id text not null references public.plots(id),
  threat_code text not null,
  distance_km double precision not null check (distance_km >= 0),
  environment_similarity double precision check (environment_similarity between 0 and 1),
  exposure_type text not null default 'proximity',
  exposure_strength double precision check (exposure_strength between 0 and 1),
  missing_features text[] not null default '{}',
  rule_version text not null,
  check (source_plot_id < target_plot_id),
  unique (source_plot_id, target_plot_id, threat_code, rule_version)
);

-- Alerts, notifications, follow-ups -------------------------------------------------------

create table public.alerts (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  plot_id text not null references public.plots(id),
  threat_code text not null,
  risk_evaluation_id text not null references public.risk_evaluations(id),
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'rejected', 'queued', 'cancelled')),
  message text,
  dedup_key text not null unique,
  review_reason text,
  approved_by text,
  approved_at timestamptz
);

create table public.followups (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  case_id text not null references public.cases(id),
  due_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'contacting', 'responded', 'no_response', 'failed', 'cancelled')),
  channel text not null default 'voice' check (channel in ('voice', 'sms')),
  attempt_count int not null default 0,
  questionnaire_version text not null default 'followup-v1',
  call_reference text,
  response_report_id text references public.reports(id)
);
create index followups_due_idx on public.followups (due_at) where status = 'scheduled';

create table public.notifications (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  alert_id text references public.alerts(id),
  followup_id text references public.followups(id),
  report_id text references public.reports(id),
  contact_id text not null references public.contacts(id),
  channel text not null check (channel in ('voice', 'sms')),
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'cancelled')),
  provider_reference text,
  attempt_count int not null default 0,
  last_error text,
  -- alert, follow-up or advisory_response (report): exactly one reason.
  check (num_nonnulls(alert_id, followup_id, report_id) = 1)
);
-- An alert is sent at most once per contact.
create unique index notifications_alert_contact
  on public.notifications (alert_id, contact_id) where alert_id is not null;

create table public.case_resolutions (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  is_demo boolean not null default false,
  case_id text not null references public.cases(id),
  plot_id text not null references public.plots(id),
  threat_code text not null,
  symptoms text[] not null default '{}',
  resolved_at timestamptz not null,
  solution_statement text,
  solution_codes text[],
  matches_protocol boolean,
  outcome text not null check (outcome in ('resolved', 'improved_enough')),
  verification text not null default 'farmer_reported'
    check (verification in ('farmer_reported', 'verified', 'disputed')),
  followup_id text unique references public.followups(id),
  verified_by text
);

-- Events and idempotency ---------------------------------------------------------------------

create table public.outbox_events (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  is_demo boolean not null default false,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  aggregate_id text not null,
  aggregate_version int not null default 1,
  correlation_id text,
  payload jsonb not null,
  published_at timestamptz,
  attempt_count int not null default 0,
  locked_until timestamptz,
  last_error text
);
create index outbox_pending_idx on public.outbox_events (created_at) where published_at is null;

-- Same key + same body -> stored response; same key + different body -> 409.
create table public.idempotency_keys (
  key text primary key,
  created_at timestamptz not null default now(),
  scope text not null,
  request_hash text not null,
  response_status int,
  response_body jsonb
);

-- updated_at / version triggers -----------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['contacts', 'farmers', 'plots', 'cases', 'risk_models', 'edges',
                           'alerts', 'followups', 'notifications', 'case_resolutions']
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;
