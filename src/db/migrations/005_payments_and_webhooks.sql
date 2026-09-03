-- What the payment rail said, and what actually happened to it.
--
-- The ledger is insert-only, so a payment's status cannot live there: moving
-- `created` -> `captured` would mean rewriting a hashed row. This table holds
-- the current status, and every transition still appends its own ledger row.
-- The ledger stays the history; this is the projection of it.
create table if not exists payments (
  order_ref    text primary key,
  payment_ref  text,
  mandate_id   text not null,
  quote_id     text,
  amount_paise bigint not null check (amount_paise >= 0),
  -- 'created' is what a charge records. Only a webhook moves it past that.
  status       text not null check (status in ('created', 'captured', 'failed')),
  adapter      text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists payments_mandate_idx on payments (mandate_id);
create index if not exists payments_status_idx on payments (status) where status = 'created';

-- Razorpay redelivers. It retries on any non-200, and it redelivers on its own
-- schedule besides, so the same event id arrives more than once as a matter of
-- course rather than as an error.
--
-- The primary key is the whole defence: a redelivery loses the insert and the
-- handler stops before it can append a second ledger row. Recording the
-- ledger_seq of the row the first delivery wrote makes a replay auditable
-- rather than merely silent.
create table if not exists webhook_events (
  event_id    text primary key,
  event       text not null,
  order_ref   text,
  ledger_seq  bigint,
  received_at timestamptz not null default now()
);
