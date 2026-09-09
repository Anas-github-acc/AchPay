-- Demo ownership foundation. The columns remain nullable during rollout so
-- existing local data can be migrated before production auth is enforced.
-- The foreign keys are added in the Supabase-only production migration. The
-- local Docker database does not provide Supabase's auth schema.
alter table mandates add column if not exists owner_id uuid;
alter table payments add column if not exists owner_id uuid;
alter table pending_approvals add column if not exists owner_id uuid;
alter table provider_customers add column if not exists owner_id uuid;
alter table ledger add column if not exists owner_id uuid;

create index if not exists mandates_owner_created_idx on mandates (owner_id, created_at desc);
create index if not exists payments_owner_created_idx on payments (owner_id, created_at desc);
create index if not exists approvals_owner_created_idx on pending_approvals (owner_id, created_at desc);
create index if not exists ledger_owner_seq_idx on ledger (owner_id, seq);

-- No table policies by design. Direct Data API table access is revoked; the
-- application will expose narrowly-scoped RPC functions in a later migration.
alter table mandates enable row level security;
alter table payments enable row level security;
alter table pending_approvals enable row level security;
alter table provider_customers enable row level security;
alter table ledger enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table mandates, payments, pending_approvals, provider_customers, ledger from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table mandates, payments, pending_approvals, provider_customers, ledger from authenticated';
  end if;
end $$;
