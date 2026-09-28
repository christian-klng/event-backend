import type { Db, Queryable } from '../db/index.ts';
import { DomainError } from '../lib/errors.ts';
import { isUuid } from './events.ts';
import type { Attendance, EventStatus } from './events.ts';

export const ORDER_STATUSES = ['pending', 'paid', 'expired', 'refunded', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** How long seats stay reserved for payment methods that confirm days later, e.g. bank debits. */
const ASYNC_PAYMENT_HOLD_DAYS = 10;

export interface Order {
  id: string;
  event_id: string;
  event_title: string;
  event_slug: string;
  ticket_type_id: string;
  ticket_name: string;
  attendance: Attendance;
  quantity: number;
  status: OrderStatus;
  customer_email: string | null;
  customer_name: string | null;
  unit_price_cents: number | null;
  tax_percent: number | null;
  amount_total_cents: number | null;
  currency: string | null;
  livemode: boolean | null;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  expires_at: Date | null;
  paid_at: Date | null;
  refunded_at: Date | null;
  confirmation_sent_at: Date | null;
  confirmation_attempts: number;
  confirmation_error: string | null;
  created_at: Date;
}

export interface Reservation {
  order_id: string;
  expires_at: Date;
  quantity: number;
  unit_price_cents: number;
  currency: string;
  ticket: { id: string; name: string; attendance: Attendance };
  event: {
    id: string;
    slug: string;
    title: string;
    starts_at: Date;
    ends_at: Date;
    timezone: string;
    tax_percent: number | null;
    thumbnail_hash: string | null;
  };
}

export interface PaymentDetails {
  order_id: string;
  session_id: string;
  paid: boolean;
  customer_email: string | null;
  customer_name: string | null;
  amount_total_cents: number | null;
  currency: string | null;
  payment_intent_id: string | null;
  invoice_id: string | null;
}

const ORDER_SELECT = `
  select o.id, o.event_id, e.title as event_title, e.slug as event_slug, o.ticket_type_id,
         t.name as ticket_name, t.attendance, o.quantity, o.status, o.customer_email,
         o.customer_name, o.unit_price_cents, o.tax_percent::float8 as tax_percent,
         o.amount_total_cents, o.currency, o.livemode, o.stripe_session_id,
         o.stripe_payment_intent_id, o.stripe_invoice_id, o.expires_at, o.paid_at,
         o.refunded_at, o.confirmation_sent_at, o.confirmation_attempts, o.confirmation_error,
         o.created_at
  from orders o
  join events e on e.id = o.event_id
  join ticket_types t on t.id = o.ticket_type_id
`;

const SEATS_TAKEN = `
  select coalesce(sum(quantity), 0)::int as taken
  from orders
  where ticket_type_id = $1
    and (status = 'paid' or (status = 'pending' and expires_at > now()))
`;

/**
 * Reserves seats by creating a pending order. The ticket type row is locked while the
 * free seats are counted, so two buyers can never get the same last seat.
 */
export async function reserveSeats(
  db: Db,
  input: { ticket_type_id: string; quantity: number; hold_until: Date },
): Promise<Reservation> {
  const { ticket_type_id, quantity } = input;
  if (!isUuid(ticket_type_id)) throw new DomainError('not_found', 'Unknown ticket type.');
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new DomainError('invalid', 'The quantity must be a whole number of at least 1.', 'quantity');
  }

  return db.tx(async (tx) => {
    const [row] = await tx.query<{
      id: string;
      name: string;
      attendance: Attendance;
      price_cents: number;
      currency: string;
      capacity: number | null;
      max_per_order: number;
      sales_start: Date | null;
      sales_end: Date | null;
      event_id: string;
      slug: string;
      title: string;
      status: EventStatus;
      starts_at: Date;
      ends_at: Date;
      timezone: string;
      tax_percent: number | null;
      thumbnail_hash: string | null;
    }>(
      `select t.id, t.name, t.attendance, t.price_cents, t.currency, t.capacity, t.max_per_order,
              t.sales_start, t.sales_end, e.id as event_id, e.slug, e.title, e.status,
              e.starts_at, e.ends_at, e.timezone, e.tax_percent::float8 as tax_percent,
              e.thumbnail_hash
       from ticket_types t
       join events e on e.id = t.event_id
       where t.id = $1
       for update of t`,
      [ticket_type_id],
    );
    if (!row || row.status === 'draft' || row.status === 'archived') {
      throw new DomainError('not_found', 'Unknown ticket type.');
    }
    if (row.status !== 'published') {
      throw new DomainError('conflict', 'This event was cancelled.', 'not_on_sale');
    }

    const now = Date.now();
    if (row.sales_start && now < row.sales_start.getTime()) {
      throw new DomainError('conflict', 'Ticket sales have not started yet.', 'not_on_sale');
    }
    if (now >= (row.sales_end ?? row.starts_at).getTime()) {
      throw new DomainError('conflict', 'Ticket sales have ended.', 'not_on_sale');
    }
    if (quantity > row.max_per_order) {
      throw new DomainError(
        'invalid',
        `At most ${row.max_per_order} tickets can be bought at once.`,
        'quantity',
      );
    }

    if (row.capacity !== null) {
      const [seats] = await tx.query<{ taken: number }>(SEATS_TAKEN, [row.id]);
      const free = row.capacity - (seats?.taken ?? 0);
      if (free <= 0) throw new DomainError('conflict', 'This ticket is sold out.', 'sold_out');
      if (quantity > free) {
        throw new DomainError(
          'conflict',
          free === 1 ? 'Only 1 seat is left.' : `Only ${free} seats are left.`,
          'not_enough_seats',
        );
      }
    }

    const [order] = await tx.query<{ id: string; expires_at: Date }>(
      `insert into orders (event_id, ticket_type_id, quantity, status, unit_price_cents, currency,
                           expires_at)
       values ($1, $2, $3, 'pending', $4, $5, $6)
       returning id, expires_at`,
      [row.event_id, row.id, quantity, row.price_cents, row.currency, input.hold_until],
    );
    if (!order) throw new Error('insert returned no row');

    return {
      order_id: order.id,
      expires_at: order.expires_at,
      quantity,
      unit_price_cents: row.price_cents,
      currency: row.currency,
      ticket: { id: row.id, name: row.name, attendance: row.attendance },
      event: {
        id: row.event_id,
        slug: row.slug,
        title: row.title,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        timezone: row.timezone,
        tax_percent: row.tax_percent,
        thumbnail_hash: row.thumbnail_hash,
      },
    };
  });
}

export async function attachCheckoutSession(
  db: Queryable,
  orderId: string,
  session: { id: string; livemode: boolean; tax_percent: number },
): Promise<void> {
  await db.query(
    `update orders set stripe_session_id = $2, livemode = $3, tax_percent = $4, updated_at = now()
     where id = $1`,
    [orderId, session.id, session.livemode, session.tax_percent],
  );
}

/** Frees the seats of a reservation whose checkout could not be started. */
export async function discardReservation(db: Queryable, orderId: string): Promise<void> {
  await db.query(
    "delete from orders where id = $1 and status = 'pending' and stripe_session_id is null",
    [orderId],
  );
}

/**
 * Records the result of a finished checkout. Returns the order when it became paid through
 * this call, and null when nothing changed.
 */
export async function recordPayment(db: Queryable, payment: PaymentDetails): Promise<Order | null> {
  if (!isUuid(payment.order_id)) return null;

  if (!payment.paid) {
    // The buyer finished the checkout, the money arrives later. Keep the seats until then.
    await db.query(
      `update orders
       set customer_email = $3, customer_name = $4, stripe_payment_intent_id = $5,
           expires_at = now() + make_interval(days => $6), updated_at = now()
       where id = $1 and stripe_session_id = $2 and status in ('pending', 'expired')`,
      [
        payment.order_id,
        payment.session_id,
        payment.customer_email,
        payment.customer_name,
        payment.payment_intent_id,
        ASYNC_PAYMENT_HOLD_DAYS,
      ],
    );
    return null;
  }

  // A payment can arrive after the reservation ran out. The buyer paid, so the order counts.
  const [updated] = await db.query<{ id: string }>(
    `update orders
     set status = 'paid', paid_at = now(), customer_email = $3, customer_name = $4,
         amount_total_cents = $5, currency = coalesce($6, currency),
         stripe_payment_intent_id = $7, stripe_invoice_id = $8, updated_at = now()
     where id = $1 and stripe_session_id = $2 and status in ('pending', 'expired')
     returning id`,
    [
      payment.order_id,
      payment.session_id,
      payment.customer_email,
      payment.customer_name,
      payment.amount_total_cents,
      payment.currency,
      payment.payment_intent_id,
      payment.invoice_id,
    ],
  );
  return updated ? getOrder(db, updated.id) : null;
}

export async function closeUnpaidOrder(
  db: Queryable,
  sessionId: string,
  status: 'expired' | 'cancelled',
): Promise<void> {
  await db.query(
    `update orders set status = $2, updated_at = now()
     where stripe_session_id = $1 and status = 'pending'`,
    [sessionId, status],
  );
}

export async function markRefunded(
  db: Queryable,
  match: { order_id: string } | { payment_intent_id: string },
): Promise<Order | null> {
  const [column, value] =
    'order_id' in match
      ? ['id', match.order_id]
      : ['stripe_payment_intent_id', match.payment_intent_id];
  const [updated] = await db.query<{ id: string }>(
    `update orders set status = 'refunded', refunded_at = now(), updated_at = now()
     where ${column} = $1 and status = 'paid'
     returning id`,
    [value],
  );
  return updated ? getOrder(db, updated.id) : null;
}

/** Housekeeping. Availability ignores overdue reservations even before this runs. */
export async function expireOverdueOrders(db: Queryable): Promise<number> {
  const rows = await db.query(
    `update orders set status = 'expired', updated_at = now()
     where status = 'pending' and expires_at < now()
     returning id`,
  );
  return rows.length;
}

export async function getOrder(db: Queryable, id: string): Promise<Order> {
  const [order] = isUuid(id) ? await db.query<Order>(`${ORDER_SELECT} where o.id = $1`, [id]) : [];
  if (!order) throw new DomainError('not_found', `No order found for "${id}".`);
  return order;
}

export async function findOrderBySession(db: Queryable, sessionId: string): Promise<Order | null> {
  const [order] = await db.query<Order>(`${ORDER_SELECT} where o.stripe_session_id = $1`, [
    sessionId,
  ]);
  return order ?? null;
}

export async function listOrders(
  db: Queryable,
  filter: { event_id?: string; statuses?: readonly OrderStatus[] } = {},
): Promise<Order[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.event_id) {
    params.push(filter.event_id);
    conditions.push(`o.event_id = $${params.length}`);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    const placeholders = filter.statuses.map((status) => {
      params.push(status);
      return `$${params.length}`;
    });
    conditions.push(`o.status in (${placeholders.join(', ')})`);
  }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  return db.query<Order>(`${ORDER_SELECT} ${where} order by o.created_at desc, o.id limit 500`, params);
}
