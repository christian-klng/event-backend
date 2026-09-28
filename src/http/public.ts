import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { findEvent, listEvents } from '../domain/events.ts';
import { findImage, IMAGE_VARIANTS } from '../domain/images.ts';
import type { ImageVariant } from '../domain/images.ts';
import { toPublicEvent } from '../domain/present.ts';

const PUBLIC_STATUSES = ['published', 'cancelled'] as const;

export function publicRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.use('/v1/*', async (c, next) => {
    const origin = c.req.header('origin');
    const { allowed_origins } = await ctx.generalSettings();
    const allowed =
      allowed_origins.length === 0 ? '*' : origin && allowed_origins.includes(origin) ? origin : null;

    if (c.req.method === 'OPTIONS') {
      const headers = new Headers({ vary: 'Origin' });
      if (allowed) {
        headers.set('access-control-allow-origin', allowed);
        headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
        headers.set('access-control-allow-headers', 'content-type');
        headers.set('access-control-max-age', '86400');
      }
      return new Response(null, { status: 204, headers });
    }

    await next();
    c.header('vary', 'Origin', { append: true });
    if (allowed) c.header('access-control-allow-origin', allowed);
  });

  app.get('/v1/events', async (c) => {
    const when = c.req.query('when') ?? 'upcoming';
    if (when !== 'upcoming' && when !== 'past' && when !== 'all') {
      return c.json({ error: 'invalid', message: 'when must be upcoming, past or all' }, 400);
    }
    const [events, settings] = await Promise.all([
      listEvents(ctx.db, { statuses: ['published'], when }),
      ctx.generalSettings(),
    ]);
    const options = { baseUrl: ctx.config.publicBaseUrl, lowStockThreshold: settings.low_stock_threshold };
    c.header('cache-control', 'public, max-age=15');
    return c.json({ events: events.map((event) => toPublicEvent(event, options, false)) });
  });

  app.get('/v1/events/:slug', async (c) => {
    const event = await findEvent(ctx.db, c.req.param('slug'));
    if (!event || !PUBLIC_STATUSES.some((status) => status === event.status)) {
      return c.json({ error: 'not_found', message: 'Event not found' }, 404);
    }
    const settings = await ctx.generalSettings();
    const options = { baseUrl: ctx.config.publicBaseUrl, lowStockThreshold: settings.low_stock_threshold };
    c.header('cache-control', 'public, max-age=15');
    return c.json({ event: toPublicEvent(event, options, true) });
  });

  app.get('/media/:hash/:file', async (c) => {
    const variant = IMAGE_VARIANTS.find((name) => `${name}.webp` === c.req.param('file'));
    const image = variant
      ? await findImage(ctx.db, c.req.param('hash'), variant satisfies ImageVariant)
      : null;
    if (!image) return c.json({ error: 'not_found', message: 'Image not found' }, 404);
    return new Response(new Uint8Array(image), {
      headers: {
        'content-type': 'image/webp',
        'content-length': String(image.byteLength),
        // The hash in the URL changes with the picture, so browsers may keep it forever.
        'cache-control': 'public, max-age=31536000, immutable',
        'access-control-allow-origin': '*',
      },
    });
  });

  return app;
}
