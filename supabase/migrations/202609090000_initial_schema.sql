-- Supabase CLI bootstrap schema. This is the deployable equivalent of the
-- application migrations under apps/api/src/db/migrations/.
create table if not exists public.ledger (
  seq bigserial primary key, event_id uuid not null, ts timestamptz not null default now(),
  actor text not null, event_type text not null, intent_text text, quote_id text,
  decision text, rule_id text, amount_paise bigint, razorpay_ref text, payload jsonb,
  prev_hash text not null, hash text not null, owner_id uuid
);
create index if not exists ledger_event_id_idx on public.ledger (event_id);
create index if not exists ledger_quote_id_idx on public.ledger (quote_id);
create index if not exists ledger_mandate_charges_idx
  on public.ledger ((payload ->> 'mandate_id'), ts) where event_type = 'charge';
create index if not exists ledger_razorpay_ref_idx
  on public.ledger (razorpay_ref) where razorpay_ref is not null;
create index if not exists ledger_owner_seq_idx on public.ledger (owner_id, seq);

create table if not exists public.mandates (
  id text primary key, user_ref text not null, max_amount_paise bigint not null check (max_amount_paise >= 0),
  used_paise bigint not null default 0 check (used_paise >= 0), expires_at timestamptz not null,
  status text not null check (status in ('active', 'revoked', 'expired')),
  provider_token text, provider_customer_id text, owner_id uuid,
  created_at timestamptz not null default now(),
  constraint mandate_within_ceiling check (used_paise <= max_amount_paise)
);
create index if not exists mandates_user_ref_idx on public.mandates (user_ref);
create index if not exists mandates_owner_created_idx on public.mandates (owner_id, created_at desc);

create table if not exists public.idempotency (
  key text primary key, result jsonb, created_at timestamptz not null default now()
);

create table if not exists public.provider_customers (
  provider text not null, user_ref text not null, customer_id text not null,
  owner_id uuid, created_at timestamptz not null default now(),
  primary key (provider, user_ref)
);

create table if not exists public.payments (
  order_ref text primary key, payment_ref text, mandate_id text not null, quote_id text,
  amount_paise bigint not null check (amount_paise >= 0),
  status text not null check (status in ('awaiting_authorisation', 'created', 'captured', 'failed', 'abandoned')),
  adapter text not null, provider_customer_id text, owner_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists payments_mandate_idx on public.payments (mandate_id);
create index if not exists payments_status_idx on public.payments (status)
  where status in ('awaiting_authorisation', 'created');
create index if not exists payments_owner_created_idx on public.payments (owner_id, created_at desc);

create table if not exists public.webhook_events (
  event_id text primary key, event text not null, order_ref text, ledger_seq bigint,
  received_at timestamptz not null default now()
);

create table if not exists public.pending_approvals (
  token text primary key, quote_id text not null, mandate_id text not null,
  amount_paise bigint not null check (amount_paise >= 0), rule_id text not null,
  reason text not null, quote jsonb not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'expired')),
  expires_at timestamptz not null, created_at timestamptz not null default now(),
  decided_at timestamptz, order_ref text, charge_error text, gate_seq bigint, owner_id uuid
);
create unique index if not exists pending_approvals_open_idx
  on public.pending_approvals (mandate_id, quote_id) where status = 'pending';
create index if not exists pending_approvals_order_ref_idx
  on public.pending_approvals (order_ref) where order_ref is not null;
create index if not exists approvals_owner_created_idx
  on public.pending_approvals (owner_id, created_at desc);

-- Make the bootstrap migration safe when the database already contains the
-- older application schema.
alter table public.ledger add column if not exists owner_id uuid;
alter table public.mandates add column if not exists owner_id uuid;
alter table public.mandates add column if not exists provider_customer_id text;
alter table public.provider_customers add column if not exists owner_id uuid;
alter table public.payments add column if not exists owner_id uuid;
alter table public.payments add column if not exists provider_customer_id text;
alter table public.pending_approvals add column if not exists owner_id uuid;
alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check
  check (status in ('awaiting_authorisation', 'created', 'captured', 'failed', 'abandoned'));
