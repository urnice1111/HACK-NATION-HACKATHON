-- Esquema env (dueño: integrante 4). Datos de referencia, solo lectura para los demás módulos.
-- Idempotente: reset_db.sh solo borra public, así que env sobrevive a los reinicios de la demo.
-- Tablas según INSTRUCTIONS.md sección 7.1.

create schema if not exists env;

create table if not exists env.datasets (
  dataset_id text primary key,
  name text not null,
  source text not null,
  license text not null,
  loaded_at timestamptz not null default now(),
  is_demo boolean not null default false,
  notes text
);

create table if not exists env.grid_cells (
  cell_id text primary key,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  dataset_id text not null references env.datasets (dataset_id)
);

-- Formato largo: agregar una variable no requiere columnas nuevas.
create table if not exists env.daily_observations (
  cell_id text not null references env.grid_cells (cell_id) on delete cascade,
  date date not null,
  variable_code text not null,
  value double precision not null,
  dataset_id text not null references env.datasets (dataset_id),
  primary key (cell_id, variable_code, date)
);

create table if not exists env.climatology (
  cell_id text not null references env.grid_cells (cell_id) on delete cascade,
  variable_code text not null,
  month smallint not null check (month between 1 and 12),
  mean double precision not null,
  std double precision,
  primary key (cell_id, variable_code, month)
);

create table if not exists env.variable_catalog (
  variable_code text primary key,
  label text not null,
  unit text not null,
  description text not null,
  temporal_resolution text not null,
  coverage_start date,
  coverage_end date,
  allowed_aggregations text[] not null,
  dataset_id text not null references env.datasets (dataset_id)
);

-- Sin FK a public.plots: env no depende del ciclo de vida del esquema de negocio.
create table if not exists env.plot_cell_map (
  plot_id text primary key,
  cell_id text not null references env.grid_cells (cell_id) on delete cascade,
  distance_km double precision not null check (distance_km >= 0)
);

-- Misma forma que backend/seed/env_mock.sql para que el grafo lo lea sin cambios.
create table if not exists env.plot_summary (
  plot_id text not null,
  computed_at timestamptz not null default now(),
  features jsonb not null,
  data_freshness text not null check (data_freshness in ('fresh', 'stale', 'unknown')),
  primary key (plot_id, computed_at)
);

create table if not exists env.external_context (
  source_id text primary key,
  url text not null,
  title text,
  retrieved_at timestamptz not null default now(),
  valid_until timestamptz,
  region text,
  data_type text,
  content text,
  quality_status text not null default 'unreviewed'
    check (quality_status in ('reviewed', 'unreviewed', 'rejected'))
);
