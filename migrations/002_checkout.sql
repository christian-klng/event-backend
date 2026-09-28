-- null means: use the default tax rate from the settings
alter table events
  add column tax_percent numeric(5, 2)
    check (tax_percent is null or (tax_percent >= 0 and tax_percent <= 100));

alter table orders
  add column unit_price_cents integer,
  add column tax_percent numeric(5, 2),
  add column livemode boolean,
  add column stripe_invoice_id text,
  add column refunded_at timestamptz,
  add column confirmation_sent_at timestamptz,
  add column confirmation_attempts integer not null default 0,
  add column confirmation_last_attempt_at timestamptz,
  add column confirmation_error text;

create index orders_payment_intent on orders (stripe_payment_intent_id);
create index orders_event_created on orders (event_id, created_at);

-- Stripe delivers webhooks at least once. Remembering the IDs makes handling them idempotent.
create table stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
