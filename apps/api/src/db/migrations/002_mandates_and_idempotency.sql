create table if not exists mandates (
  id               text primary key,
  user_ref         text not null,
  max_amount_paise bigint not null check (max_amount_paise >= 0),
  used_paise       bigint not null default 0 check (used_paise >= 0),
  expires_at       timestamptz not null,
  status           text not null check (status in ('active', 'revoked', 'expired')),
  provider_token   text,                 -- filled in once real payments land
  created_at       timestamptz not null default now(),
  -- Spending past the ceiling is impossible at the storage layer, whatever the
  -- application does. The policy engine is the first line, not the only one.
  constraint mandate_within_ceiling check (used_paise <= max_amount_paise)
);

create index if not exists mandates_user_ref_idx on mandates (user_ref);

create table if not exists idempotency (
  key        text primary key,
  -- Null while a checkout holds the key but has not finished. The primary key
  -- is what makes concurrent duplicate checkouts serialise: the second insert
  -- blocks on the uncommitted first, then fails with a unique violation.
  result     jsonb,
  created_at timestamptz not null default now()
);

-- Spend history is read back out of the ledger by mandate id, which lives in
-- the payload. Without this index that is a sequential scan on every checkout.
create index if not exists ledger_mandate_charges_idx
  on ledger ((payload ->> 'mandate_id'), ts)
  where event_type = 'charge';
