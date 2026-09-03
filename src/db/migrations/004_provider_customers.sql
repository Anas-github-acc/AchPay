-- One provider customer per user, in its own table.
--
-- This deliberately does not live on `mandates`. A charge runs inside the
-- checkout transaction, which holds `select ... for update` on the mandate row
-- for its whole duration. An adapter writing that same row on a different
-- connection blocks on that lock, and the transaction cannot commit until the
-- adapter returns: the two wait on each other forever.
--
-- A separate table has no lock overlap, so the adapter can record the customer
-- it created without reaching into the row its own caller is holding.
create table if not exists provider_customers (
  provider    text not null,
  user_ref    text not null,
  customer_id text not null,
  created_at  timestamptz not null default now(),
  primary key (provider, user_ref)
);
