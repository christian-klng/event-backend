create table images (
  hash text primary key,
  large bytea not null,
  small bytea not null,
  width integer not null,
  height integer not null,
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'cancelled', 'archived')),
  title text not null,
  summary text not null default '',
  description_md text not null default '',
  format text not null check (format in ('online', 'onsite', 'hybrid')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Europe/Berlin',
  location_name text,
  location_address text,
  online_url text,
  thumbnail_hash text references images (hash) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index events_status_starts_at on events (status, starts_at);

create table ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  name text not null,
  description text not null default '',
  attendance text not null check (attendance in ('online', 'onsite')),
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'eur',
  capacity integer check (capacity is null or capacity >= 0),
  max_per_order integer not null default 10 check (max_per_order between 1 and 50),
  sales_start timestamptz,
  sales_end timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index ticket_types_event on ticket_types (event_id);

-- Orders are written by the checkout flow. The table exists from the start so that
-- seat availability has a single definition.
create table orders (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id),
  ticket_type_id uuid not null references ticket_types (id),
  quantity integer not null check (quantity > 0),
  status text not null
    check (status in ('pending', 'paid', 'expired', 'refunded', 'cancelled')),
  customer_email text,
  customer_name text,
  amount_total_cents integer,
  currency text,
  stripe_session_id text unique,
  stripe_payment_intent_id text,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_ticket_type_status on orders (ticket_type_id, status);

create table upload_tokens (
  token_hash text primary key,
  event_id uuid not null references events (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
