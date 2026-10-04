-- LOCAL MOCK of env.plot_summary until integrante 4 publishes the real env schema.
-- Same shape as INSTRUCTIONS.md section 7.1. Never run against the shared Supabase project.
-- Plots 07 (no context) and 08 (outside coverage) intentionally have no summary.

create schema if not exists env;

create table if not exists env.plot_summary (
  plot_id text not null,
  computed_at timestamptz not null default now(),
  features jsonb not null,
  data_freshness text not null check (data_freshness in ('fresh', 'stale', 'unknown')),
  primary key (plot_id, computed_at)
);

delete from env.plot_summary where plot_id like 'plot_demo_%';

insert into env.plot_summary (plot_id, computed_at, features, data_freshness) values
  ('plot_demo_01', now() - interval '6 hours', '{"humidity_mean_14d": 88, "rain_anomaly_30d": 1.8, "temp_optimal_days_14d": 11}', 'fresh'),
  ('plot_demo_02', now() - interval '6 hours', '{"humidity_mean_14d": 86, "rain_anomaly_30d": 1.6, "temp_optimal_days_14d": 10}', 'fresh'),
  ('plot_demo_03', now() - interval '6 hours', '{"humidity_mean_14d": 82, "rain_anomaly_30d": 1.3, "temp_optimal_days_14d": 7}',  'fresh'),
  ('plot_demo_04', now() - interval '6 hours', '{"humidity_mean_14d": 80, "rain_anomaly_30d": 1.2, "temp_optimal_days_14d": 7}',  'fresh'),
  ('plot_demo_05', now() - interval '6 hours', '{"humidity_mean_14d": 74, "rain_anomaly_30d": 0.9, "temp_optimal_days_14d": 5}',  'fresh'),
  ('plot_demo_06', now() - interval '6 hours', '{"humidity_mean_14d": 75, "rain_anomaly_30d": 0.9, "temp_optimal_days_14d": 4}',  'fresh');
