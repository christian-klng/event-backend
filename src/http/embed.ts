import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sha256Hex } from '../lib/crypto.ts';

const PUBLIC_DIR = join(import.meta.dirname, '../../public');

const FILES = {
  '/embed.js': { file: 'embed.js', type: 'text/javascript; charset=utf-8' },
  '/demo': { file: 'demo.html', type: 'text/html; charset=utf-8' },
  '/demo/danke': { file: 'demo-danke.html', type: 'text/html; charset=utf-8' },
} as const;

/** Serves the script that websites embed, and two pages that show it in action. */
export async function embedRoutes(): Promise<Hono> {
  const app = new Hono();

  for (const [path, { file, type }] of Object.entries(FILES)) {
    const body = await readFile(join(PUBLIC_DIR, file), 'utf8');
    const etag = `"${sha256Hex(body).slice(0, 16)}"`;

    app.get(path, (c) => {
      const headers = {
        etag,
        // Short, so that websites pick up a new version within minutes.
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
      };
      if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
      return new Response(body, { headers: { ...headers, 'content-type': type } });
    });
  }

  return app;
}
