create table if not exists security_reports (
  report_key text primary key,
  report jsonb not null,
  catalog jsonb not null,
  generated_at timestamptz not null,
  updated_at timestamptz not null default now()
);
