import type { AppContext } from './context.ts';
import { deliverConfirmations } from './domain/confirmation.ts';
import { expireOverdueOrders } from './domain/orders.ts';

const INTERVAL_MS = 60_000;

/** Recurring housekeeping: closes overdue reservations and sends confirmations that are due. */
export function startJobs(ctx: AppContext): () => void {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    ctx.background('housekeeping', async () => {
      try {
        await expireOverdueOrders(ctx.db);
        await deliverConfirmations(ctx);
      } finally {
        running = false;
      }
    });
  }, INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
