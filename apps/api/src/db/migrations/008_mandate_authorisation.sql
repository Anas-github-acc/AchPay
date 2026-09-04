-- The first charge on a mandate nobody has authorised yet.
--
-- Razorpay's mandate-registration order is not a payment. It is a request for
-- one, waiting on a person to authorise it in their UPI or card flow. Until
-- now checkout could not say that: an order coming back from the adapter was
-- recorded as `created`, which means "submitted to the rail and in flight",
-- and an agent reading that could reasonably tell a user their money had gone.
--
-- 'awaiting_authorisation' is that missing state. It leaves the reservation in
-- place (an authorised order really does debit this amount) while saying
-- plainly that nothing has been submitted yet and a human still has to act.
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check
  check (status in (
    'awaiting_authorisation', 'created', 'captured', 'failed', 'abandoned'
  ));

-- Razorpay Checkout needs the customer the order was opened against. Kept on
-- the payment rather than looked up again so the authorisation page is one row
-- read, and so it stays right even if the mandate's customer changes later.
alter table payments add column if not exists provider_customer_id text;

-- The sweep and the authorisation page both scan for unsettled rows.
drop index if exists payments_status_idx;
create index if not exists payments_status_idx on payments (status)
  where status in ('awaiting_authorisation', 'created');
