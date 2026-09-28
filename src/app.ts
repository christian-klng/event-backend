import { Hono } from 'hono';
import type { AppContext } from './context.ts';
import { publicRoutes } from './http/public.ts';
import { uploadRoutes } from './http/uploads.ts';
import { DomainError } from './lib/errors.ts';
import { mcpRoutes } from './mcp/http.ts';

const STATUS_BY_CODE = { not_found: 404, invalid: 400, conflict: 409 } as const;

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ error: err.code, message: err.message }, STATUS_BY_CODE[err.code]);
    }
    console.error('request failed', c.req.method, c.req.path, err);
    return c.json({ error: 'internal', message: 'Unexpected server error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'Not found' }, 404));

  app.get('/healthz', async (c) => {
    try {
      await ctx.db.query('select 1');
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.route('/', publicRoutes(ctx));
  app.route('/', uploadRoutes(ctx));
  app.route('/', mcpRoutes(ctx));

  return app;
}
