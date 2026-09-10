create table if not exists shops (
  id text primary key,
  owner_id uuid,
  name text not null,
  slug text not null unique,
  is_default boolean not null default false,
  razorpay_key_id text,
  razorpay_key_secret_encrypted text,
  razorpay_webhook_secret_encrypted text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists one_default_shop_idx on shops (is_default) where is_default;
create index if not exists shops_owner_created_idx on shops (owner_id, created_at desc);

create table if not exists shop_products (
  shop_id text not null references shops(id) on delete cascade,
  sku text not null,
  title text not null,
  description text,
  price_paise bigint not null check (price_paise >= 0),
  stock integer not null check (stock >= 0),
  category text not null,
  source text not null default 'verified' check (source in ('verified', 'unverified')),
  flagged boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (shop_id, sku)
);
create index if not exists shop_products_shop_category_idx on shop_products (shop_id, category);

alter table shops enable row level security;
alter table shop_products enable row level security;
