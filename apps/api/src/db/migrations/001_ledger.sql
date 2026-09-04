-- The audit ledger. Insert-only by contract: nothing in this codebase issues
-- UPDATE or DELETE against it. Each row's hash chains to the previous row's,
-- so any after-the-fact edit is detectable by verifyChain().
create table if not exists ledger (
  seq          bigserial primary key,
  event_id     uuid not null,
  ts           timestamptz not null default now(),
  actor        text not null,        -- 'agent' | 'user' | 'system'
  event_type   text not null,        -- 'decision' | 'charge' | 'webhook'
  intent_text  text,
  quote_id     text,
  decision     text,                 -- 'allow' | 'gate' | 'deny'
  rule_id      text,
  amount_paise bigint,
  razorpay_ref text,
  payload      jsonb,
  prev_hash    text not null,
  hash         text not null
);

create index if not exists ledger_event_id_idx on ledger (event_id);
create index if not exists ledger_quote_id_idx on ledger (quote_id);
