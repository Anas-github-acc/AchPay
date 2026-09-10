create table if not exists merchant_accounts (
  user_id uuid primary key,
  username text not null unique,
  email text not null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
