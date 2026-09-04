-- Human approval for gated purchases.
--
-- A gate decision parks the purchase here instead of charging. The row carries
-- the whole signed quote, not a reference to one, for two reasons:
--
--   1. Quotes live in Redis with a two-minute TTL. A human walking to their
--      phone takes longer than that, and the approval must still be able to
--      show exactly what was quoted.
--   2. The approval page renders from this row and nothing else. Everything in
--      it was produced server-side — catalog prices, our own signature, the
--      policy engine's rule_id. Nothing an agent supplied reaches the screen.
--
-- The row is a decision record, not a lock: money still moves through the one
-- checkout path, under the same idempotency key it would have used anyway.
create table if not exists pending_approvals (
  token        text primary key,
  quote_id     text not null,
  mandate_id   text not null,
  amount_paise bigint not null check (amount_paise >= 0),
  -- Which rule gated it, and the engine's own words for why. Both come from
  -- the policy engine; neither is caller-supplied.
  rule_id      text not null,
  reason       text not null,
  -- The signed quote as it was priced at gate time. Re-verified before any
  -- charge, so a catalog price move between gate and approval refuses rather
  -- than charging a total the approver never saw.
  quote        jsonb not null,
  status       text not null check (status in ('pending', 'approved', 'rejected', 'expired')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  -- Filled in after an approved charge runs, so the approval and the payment
  -- can be joined without guessing.
  order_ref    text,
  charge_error text,
  gate_seq     bigint
);

-- One open approval per (mandate, quote). A gated checkout retried by an agent
-- gets the token it already has rather than minting a second one, so there is
-- never more than one live way to authorise the same purchase.
create unique index if not exists pending_approvals_open_idx
  on pending_approvals (mandate_id, quote_id)
  where status = 'pending';

create index if not exists pending_approvals_order_ref_idx
  on pending_approvals (order_ref)
  where order_ref is not null;

-- GET /receipts/:id reads the ledger by the order it belongs to. Without this
-- it is a sequential scan over the whole audit trail on every page view.
create index if not exists ledger_razorpay_ref_idx
  on ledger (razorpay_ref)
  where razorpay_ref is not null;

create index if not exists ledger_quote_id_idx
  on ledger (quote_id)
  where quote_id is not null;
