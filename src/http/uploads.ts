import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppContext } from '../context.ts';
import { MAX_UPLOAD_BYTES, uploadThumbnailWithToken } from '../domain/images.ts';
import { toAdminEventSummary } from '../domain/present.ts';

/** Receives thumbnails through single-use links issued by the MCP tool `create_thumbnail_upload`. */
export function uploadRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.put(
    '/uploads/:token',
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) =>
        c.json(
          { error: 'invalid', message: `The file is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.` },
          413,
        ),
    }),
    async (c) => {
      const body = new Uint8Array(await c.req.arrayBuffer());
      const event = await uploadThumbnailWithToken(ctx.db, c.req.param('token'), body);
      return c.json({ ok: true, event: toAdminEventSummary(event) });
    },
  );

  return app;
}
