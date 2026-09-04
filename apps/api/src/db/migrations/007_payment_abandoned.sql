-- A fourth payment status: 'abandoned'.
--
-- checkout books used_paise the moment the rail accepts a charge, because an
-- in-flight payment must not be spendable twice. That booking has to be
-- reversible, and until now only two things could end a payment: a capture or
-- a decline, both of which arrive as webhooks.
--
-- A mandate order nobody ever authorises sends neither. It sits at
-- attempts = 0 forever, and the headroom sits reserved behind it forever with
-- it. That is not a decline — the rail was never asked — so recording it as
-- 'failed' would put a refusal in the record that never happened.
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('created', 'captured', 'failed', 'abandoned'));
