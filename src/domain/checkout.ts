import type Stripe from 'stripe';
import type { AppContext } from '../context.ts';
import { DomainError } from '../lib/errors.ts';
import { formatEventTime } from '../lib/format.ts';
import {
  attachCheckoutSession,
  closeUnpaidOrder,
  discardReservation,
  findOrderBySession,
  getOrder,
  markRefunded,
  recordPayment,
  reserveSeats,
} from './orders.ts';
import type { Order } from './orders.ts';
import { ensureTaxRate, explainStripeError, requireStripe } from './stripe.ts';

/** Stripe keeps a checkout open for at least 30 minutes. */
const CHECKOUT_MINUTES = 31;
/** Seats stay reserved a little longer than the checkout, so a payment in the last second still fits. */
const RESERVATION_GRACE_MINUTES = 3;

export interface CheckoutStart {
  checkout_url: string;
  order_id: string;
  expires_at: Date;
}

function withSessionId(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`;
}

/** Reserves seats and opens a Stripe Checkout for them. */
export async function startCheckout(
  ctx: AppContext,
  input: { ticket_type_id: string; quantity: number },
): Promise<CheckoutStart> {
  const general = await ctx.generalSettings();
  if (!general.checkout_success_url || !general.checkout_cancel_url) {
    console.error('checkout refused: checkout_success_url or checkout_cancel_url is not set');
    throw new DomainError('unavailable', 'Ticket sales are not available at the moment.', 'not_configured');
  }
  const { stripe, mode } = await requireStripe(ctx);

  const checkoutEnds = new Date(Date.now() + CHECKOUT_MINUTES * 60_000);
  const reservation = await reserveSeats(ctx.db, {
    ...input,
    hold_until: new Date(checkoutEnds.getTime() + RESERVATION_GRACE_MINUTES * 60_000),
  });

  try {
    const { event, ticket } = reservation;
    const taxPercent = event.tax_percent ?? general.default_tax_percent;
    if (taxPercent === null) {
      console.error('checkout refused: default_tax_percent is not set');
      throw new DomainError('unavailable', 'Ticket sales are not available at the moment.', 'not_configured');
    }
    const taxRate = await ensureTaxRate(ctx, stripe, mode, taxPercent);
    const metadata = {
      order_id: reservation.order_id,
      event_id: event.id,
      event_slug: event.slug,
      ticket_type_id: ticket.id,
    };
    const label = `${event.title} – ${ticket.name}`;
    const isPublic = ctx.config.publicBaseUrl.startsWith('https://');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: reservation.order_id,
      line_items: [
        {
          quantity: reservation.quantity,
          price_data: {
            currency: reservation.currency,
            unit_amount: reservation.unit_price_cents,
            product_data: {
              name: label,
              description: formatEventTime(event.starts_at, event.ends_at, event.timezone),
              ...(event.thumbnail_hash && isPublic
                ? { images: [`${ctx.config.publicBaseUrl}/media/${event.thumbnail_hash}/small.jpg`] }
                : {}),
            },
          },
          ...(taxRate ? { tax_rates: [taxRate] } : {}),
        },
      ],
      success_url: withSessionId(general.checkout_success_url),
      cancel_url: general.checkout_cancel_url,
      expires_at: Math.floor(checkoutEnds.getTime() / 1000),
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      customer_creation: 'always',
      metadata,
      payment_intent_data: { description: label, metadata },
      ...(general.stripe_invoices
        ? {
            invoice_creation: {
              enabled: true,
              invoice_data: {
                description: label,
                metadata,
                ...(general.invoice_footer ? { footer: general.invoice_footer } : {}),
              },
            },
          }
        : {}),
      ...(general.terms_url
        ? {
            custom_text: {
              submit: {
                message: `Mit dem Kauf akzeptieren Sie unsere [Teilnahmebedingungen](${general.terms_url}).`,
              },
            },
          }
        : {}),
    });
    if (!session.url) throw new DomainError('unavailable', 'Stripe did not return a checkout page.');

    await attachCheckoutSession(ctx.db, reservation.order_id, {
      id: session.id,
      livemode: session.livemode,
      tax_percent: taxPercent,
    });
    return {
      checkout_url: session.url,
      order_id: reservation.order_id,
      expires_at: checkoutEnds,
    };
  } catch (err) {
    await discardReservation(ctx.db, reservation.order_id).catch(() => {});
    if (err instanceof DomainError) throw err;
    // Buyers must not see details of the Stripe setup.
    console.error('checkout failed', explainStripeErrorSafely(err));
    throw new DomainError('unavailable', 'Ticket sales are not available at the moment.', 'payment_provider');
  }
}

function explainStripeErrorSafely(err: unknown): unknown {
  try {
    return explainStripeError(err).message;
  } catch {
    return err;
  }
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export interface WebhookOutcome {
  handled: boolean;
  duplicate: boolean;
  /** Orders that became paid and need a confirmation mail. */
  paid_order_ids: string[];
}

/** Applies a verified Stripe event. Safe to call more than once for the same event. */
export async function applyStripeEvent(ctx: AppContext, event: Stripe.Event): Promise<WebhookOutcome> {
  return ctx.db.tx(async (tx) => {
    const outcome: WebhookOutcome = { handled: true, duplicate: false, paid_order_ids: [] };
    const fresh = await tx.query(
      'insert into stripe_events (id, type) values ($1, $2) on conflict (id) do nothing returning id',
      [event.id, event.type],
    );
    if (fresh.length === 0) return { ...outcome, duplicate: true };

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        const orderId = session.client_reference_id ?? session.metadata?.order_id;
        if (!orderId) break;
        const order = await recordPayment(tx, {
          order_id: orderId,
          session_id: session.id,
          paid: session.payment_status !== 'unpaid',
          customer_email: session.customer_details?.email ?? null,
          customer_name:
            session.customer_details?.business_name ?? session.customer_details?.name ?? null,
          amount_total_cents: session.amount_total ?? null,
          currency: session.currency ?? null,
          payment_intent_id: idOf(session.payment_intent),
          invoice_id: idOf(session.invoice),
        });
        if (order) outcome.paid_order_ids.push(order.id);
        break;
      }
      case 'checkout.session.expired':
        await closeUnpaidOrder(tx, event.data.object.id, 'expired');
        break;
      case 'checkout.session.async_payment_failed':
        await closeUnpaidOrder(tx, event.data.object.id, 'cancelled');
        break;
      case 'charge.refunded': {
        const charge = event.data.object;
        const paymentIntent = idOf(charge.payment_intent);
        // Partial refunds keep the seat.
        if (charge.refunded && paymentIntent) {
          await markRefunded(tx, { payment_intent_id: paymentIntent });
        }
        break;
      }
      default:
        outcome.handled = false;
    }
    return outcome;
  });
}

/** Pays the full amount back through Stripe and frees the seats. */
export async function refundOrder(
  ctx: AppContext,
  orderId: string,
): Promise<{ order: Order; credit_note_id: string | null; refund_id: string | null }> {
  const order = await getOrder(ctx.db, orderId);
  if (order.status !== 'paid') {
    throw new DomainError('conflict', `Only paid orders can be refunded. This order is ${order.status}.`);
  }
  if (!order.stripe_session_id || order.amount_total_cents === null) {
    throw new DomainError('conflict', 'The order has no payment at Stripe.');
  }
  const { stripe, mode } = await requireStripe(ctx);
  if (order.livemode !== null && order.livemode !== (mode === 'live')) {
    throw new DomainError(
      'conflict',
      `The order was paid in ${order.livemode ? 'live' : 'test'} mode, but Stripe is connected in ${mode} mode.`,
    );
  }

  let creditNoteId: string | null = null;
  let refundId: string | null = null;
  try {
    // The invoice is created shortly after the payment, so the stored order may not know it yet.
    const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
    const invoiceId = idOf(session.invoice) ?? order.stripe_invoice_id;
    const paymentIntentId = idOf(session.payment_intent) ?? order.stripe_payment_intent_id;

    if (invoiceId) {
      // A credit note refunds the money and corrects the invoice in one step.
      const creditNote = await stripe.creditNotes.create(
        {
          invoice: invoiceId,
          amount: order.amount_total_cents,
          refund_amount: order.amount_total_cents,
          memo: 'Erstattung',
          metadata: { order_id: order.id },
        },
        { idempotencyKey: `refund-${order.id}` },
      );
      creditNoteId = creditNote.id;
    } else if (paymentIntentId) {
      const refund = await stripe.refunds.create(
        { payment_intent: paymentIntentId, metadata: { order_id: order.id } },
        { idempotencyKey: `refund-${order.id}` },
      );
      refundId = refund.id;
    } else {
      throw new DomainError('conflict', 'Stripe knows no payment for this order.');
    }
  } catch (err) {
    throw explainStripeError(err);
  }

  await markRefunded(ctx.db, { order_id: order.id });
  return { order: await getOrder(ctx.db, order.id), credit_note_id: creditNoteId, refund_id: refundId };
}

/** What the thank-you page may know about an order. */
export async function getCheckoutResult(ctx: AppContext, sessionId: string) {
  const order = /^cs_[A-Za-z0-9_]+$/.test(sessionId)
    ? await findOrderBySession(ctx.db, sessionId)
    : null;
  if (!order) throw new DomainError('not_found', 'Unknown checkout session.');
  return {
    status: order.status,
    quantity: order.quantity,
    ticket_name: order.ticket_name,
    attendance: order.attendance,
    customer_email: order.customer_email,
    event: { slug: order.event_slug, title: order.event_title },
  };
}
