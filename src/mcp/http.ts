import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { safeEqual } from '../lib/crypto.ts';
import { buildMcpServer } from './server.ts';

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

export function mcpRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.all('/mcp', async (c) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (!bearer || !safeEqual(bearer, ctx.config.adminToken)) {
      return c.json(rpcError(-32001, 'Unauthorized'), 401, { 'www-authenticate': 'Bearer' });
    }
    // Stateless: every call is a plain request and answer, there is no stream to open or close.
    if (c.req.method !== 'POST') {
      return c.json(rpcError(-32000, 'Method not allowed'), 405, { allow: 'POST' });
    }

    const server = buildMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => {});
    }
  });

  return app;
}
