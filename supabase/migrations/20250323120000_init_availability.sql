-- Execute no SQL Editor do Supabase (ou via CLI) antes de usar sync/cron.

create table if not exists public.monitored_sites (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  name text not null,
  url text not null,
  category text not null check (category in ('Operacional', 'Cliente', 'Interno')),
  updated_at timestamptz not null default now()
);

create table if not exists public.availability_checks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.monitored_sites (id) on delete cascade,
  checked_at timestamptz not null default now(),
  status text not null check (status in ('online', 'offline', 'unstable')),
  http_code int null,
  response_time_ms double precision null
);

create index if not exists availability_checks_site_checked_at_idx
  on public.availability_checks (site_id, checked_at desc);

alter table public.monitored_sites enable row level security;
alter table public.availability_checks enable row level security;

-- Sem políticas para anon/authenticated: apenas service role grava/lê.
-- Para leitura no browser depois, adicione políticas RLS ou use rotas API.
