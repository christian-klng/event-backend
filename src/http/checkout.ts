import { Hono } from 'hono';
import Stripe from 'stripe';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { applyStripeEvent, getCheckoutResult, startCheckout } from '../domain/checkout.ts';
import { deliverConfirmations } from '../domain/confirmation.ts';
import { getStripeCredentials, WEBHOOK_PATH } from '../domain/stripe.ts';
import { createRateLimiter } from '../lib/rate-limit.ts';

const checkoutBody = z.object({
  ticket_type_id: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(50).default(1),
});

/** The reverse proxy appends the address it saw, so the last entry is the trustworthy one. */
function clientAddress(forwardedFor: string | undefined): string {
  return forwardedFor?.split(',').at(-1)?.trim() || 'direct';
}

export function checkoutRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  // Every checkout reserves seats, so nobody may open them in bulk.
  const limiter = createRateLimiter(10, 10 * 60_000);

  app.post('/v1/checkout', async (c) => {
    const body = checkoutBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: 'invalid', message: 'Expected ticket_type_id and a quantity between 1 and 50.' },
        400,
      );
    }
    if (!limiter.allow(clientAddress(c.req.header('x-forwarded-for')))) {
      return c.json(
        { error: 'rate_limited', message: 'Too many attempts. Please try again in a few minutes.' },
        429,
      );
    }
    const checkout = await startCheckout(ctx, body.data);
    c.header('cache-control', 'no-store');
    return c.json(checkout, 201);
  });

  app.get('/v1/orders/status', async (c) => {
    const result = await getCheckoutResult(ctx, c.req.query('session_id') ?? '');
    c.header('cache-control', 'no-store');
    return c.json(result);
  });

  app.post(WEBHOOK_PATH, async (c) => {
    const { webhookSecret } = await getStripeCredentials(ctx);
    if (!webhookSecret) {
      console.error('stripe webhook received, but no webhook secret is configured');
      return c.json({ error: 'unavailable', message: 'Webhook is not configured' }, 503);
    }

    let event: Stripe.Event;
    try {
      event = await Stripe.webhooks.constructEventAsync(
        await c.req.text(),
        c.req.header('stripe-signature') ?? '',
        webhookSecret,
      );
    } catch {
      return c.json({ error: 'invalid', message: 'Invalid signature' }, 400);
    }

    // A failure here answers with 500, and Stripe delivers the event again later.
    const outcome = await applyStripeEvent(ctx, event);
    if (outcome.paid_order_ids.length > 0) {
      ctx.background('confirmation mails', () => deliverConfirmations(ctx));
    }
    return c.json({ received: true });
  });

  return app;
}
