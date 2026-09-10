create table if not exists user_roles (
  user_id uuid primary key,
  role text not null check (role in ('merchant', 'client')),
  is_demo boolean not null default false,
  auth_provider text not null check (auth_provider in ('google', 'demo')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
