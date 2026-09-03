-- A provider customer is created once per user and reused for every mandate
-- that user authorises. It is stored here, next to provider_token, so the
-- payment adapter never has to keep its own map from user_ref to cust_ id.
alter table mandates add column if not exists provider_customer_id text;

create index if not exists mandates_provider_customer_idx
  on mandates (provider_customer_id)
  where provider_customer_id is not null;
