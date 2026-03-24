-- Funções para leitura eficiente do último registro por site (política de log esparsa + resumo temporal).
-- Execute no SQL Editor do Supabase se ainda não aplicou.

create or replace function public.latest_availability_per_site(p_site_ids uuid[])
returns table (
  site_id uuid,
  checked_at timestamptz,
  status text,
  response_time_ms double precision
)
language sql
stable
as $$
  select distinct on (ac.site_id)
    ac.site_id,
    ac.checked_at,
    ac.status,
    ac.response_time_ms
  from public.availability_checks ac
  where ac.site_id = any (p_site_ids)
  order by ac.site_id, ac.checked_at desc;
$$;

create or replace function public.latest_availability_before(p_site_ids uuid[], p_before timestamptz)
returns table (
  site_id uuid,
  checked_at timestamptz,
  status text,
  response_time_ms double precision
)
language sql
stable
as $$
  select distinct on (ac.site_id)
    ac.site_id,
    ac.checked_at,
    ac.status,
    ac.response_time_ms
  from public.availability_checks ac
  where ac.site_id = any (p_site_ids)
    and ac.checked_at < p_before
  order by ac.site_id, ac.checked_at desc;
$$;

grant execute on function public.latest_availability_per_site(uuid[]) to service_role;
grant execute on function public.latest_availability_before(uuid[], timestamptz) to service_role;
