-- At most one open follow-up per case; new reports on the same case don't stack calls.
create unique index followups_one_open_per_case
  on public.followups (case_id) where status in ('scheduled', 'contacting', 'no_response');
