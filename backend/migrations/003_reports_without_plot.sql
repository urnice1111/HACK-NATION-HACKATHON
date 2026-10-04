-- Reports from unknown numbers ("registro mínimo") have no plot and no case yet.
alter table public.reports alter column plot_id drop not null;
alter table public.reports alter column case_id drop not null;
alter table public.reports add constraint reports_case_requires_plot
  check (case_id is null or plot_id is not null);
