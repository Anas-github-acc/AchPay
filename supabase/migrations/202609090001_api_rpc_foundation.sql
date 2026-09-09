-- Supabase production migration. This file is intentionally separate from
-- the local Docker migration runner because it depends on auth.uid().
create schema if not exists api;

-- RPC-only access: callers cannot use the Data API to read application tables.
revoke all on schema public from anon, authenticated;
grant usage on schema api to authenticated;

create or replace function api.list_my_mandates(p_limit integer default 100)
returns setof public.mandates
language sql
security definer
set search_path = ''
stable
as $$
  select m.*
  from public.mandates as m
  where m.owner_id = (select auth.uid())
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;

create or replace function api.get_my_mandate(p_id text)
returns setof public.mandates
language sql
security definer
set search_path = ''
stable
as $$
  select m.*
  from public.mandates as m
  where m.id = p_id and m.owner_id = (select auth.uid());
$$;

create or replace function api.list_my_ledger(p_limit integer default 100)
returns setof public.ledger
language sql
security definer
set search_path = ''
stable
as $$
  select l.*
  from public.ledger as l
  where l.owner_id = (select auth.uid())
  order by l.seq desc
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;

revoke all on all functions in schema api from public;
revoke all on all functions in schema api from anon;
grant execute on function api.list_my_mandates(integer) to authenticated;
grant execute on function api.get_my_mandate(text) to authenticated;
grant execute on function api.list_my_ledger(integer) to authenticated;

-- Enable the FK after application data has been assigned owner_id. Keep this
-- commented during the first deploy; run it in the ownership backfill step.
-- alter table public.mandates add constraint mandates_owner_fk
--   foreign key (owner_id) references auth.users(id);
