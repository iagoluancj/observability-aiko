create table if not exists public.availability_collection_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  source text not null check (source in ('dashboard', 'cron', 'manual', 'unknown')),
  status text not null check (status in ('ok', 'error')),
  checked_count int not null default 0,
  error_message text null
);

create index if not exists availability_collection_runs_run_at_idx
  on public.availability_collection_runs (run_at desc);

create index if not exists availability_collection_runs_status_run_at_idx
  on public.availability_collection_runs (status, run_at desc);

alter table public.availability_collection_runs enable row level security;
