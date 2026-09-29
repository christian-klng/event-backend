import sharp from 'sharp';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { createContext } from '../src/context.ts';
import type { Hooks } from '../src/context.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import type { EventInput } from '../src/domain/events.ts';

export const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-characters';
export const BASE_URL = 'https://events.example.test';

export const testConfig: Config = {
  env: 'test',
  port: 0,
  // Set TEST_DATABASE_URL to run the suite against a real Postgres (with --no-file-parallelism).
  databaseUrl: process.env.TEST_DATABASE_URL ?? 'pglite://memory',
  adminToken: ADMIN_TOKEN,
  appSecret: 'test-app-secret-with-at-least-32-characters',
  publicBaseUrl: BASE_URL,
  smtpPasswordOverride: undefined,
  stripeSecretKeyOverride: undefined,
  stripeWebhookSecretOverride: undefined,
};

const DAY = 24 * 60 * 60 * 1000;

export function daysFromNow(days: number, hours = 0): Date {
  return new Date(Date.now() + days * DAY + hours * 60 * 60 * 1000);
}

export function eventInput(overrides: Partial<EventInput> = {}): EventInput {
  return {
    title: 'Einführung in KI für Führungskräfte',
    format: 'hybrid',
    starts_at: daysFromNow(30),
    ends_at: daysFromNow(30, 8),
    online_url: 'https://meet.example.test/secret-room',
    location_name: 'Seminarhaus',
    location_address: 'Beispielweg 1, 10115 Berlin',
    ticket_types: [
      { name: 'Präsenz', attendance: 'onsite', price_cents: 49000, capacity: 20 },
      { name: 'Online', attendance: 'online', price_cents: 29000, capacity: null },
    ],
    ...overrides,
  };
}

export function samplePng(width = 2000, height = 1000): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3366aa' } })
    .png()
    .toBuffer();
}

export async function createTestApp(hooks: Hooks = {}) {
  const db = await openDb(testConfig.databaseUrl);
  await migrate(db);
  const ctx = createContext(testConfig, db, hooks);
  const app = await createApp(ctx);
  let nextId = 1;

  async function rpc(method: string, params: unknown, token: string | null = ADMIN_TOKEN) {
    return app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
  }

  return {
    db,
    ctx,
    app,
    rpc,

    /** Calls an MCP tool over HTTP and returns the parsed result. */
    async callTool<T = any>(name: string, args: Record<string, unknown> = {}) {
      const response = await rpc('tools/call', { name, arguments: args });
      const body = (await response.json()) as any;
      if (body.error) throw new Error(`rpc error: ${JSON.stringify(body.error)}`);
      const text: string = body.result.content[0].text;
      const isError = body.result.isError === true;
      return { isError, text, data: (isError ? null : JSON.parse(text)) as T };
    },

    async addOrder(order: {
      event_id: string;
      ticket_type_id: string;
      quantity: number;
      status: string;
      expires_at?: Date;
    }) {
      // Orders made by hand, without a checkout.
      await db.query(
        `insert into orders (event_id, ticket_type_id, quantity, status, expires_at)
         values ($1, $2, $3, $4, $5)`,
        [order.event_id, order.ticket_type_id, order.quantity, order.status, order.expires_at ?? null],
      );
    },

    async reset() {
      await ctx.idle();
      await db.exec(
        'truncate orders, stripe_events, upload_tokens, ticket_types, events, images, settings cascade',
      );
      ctx.invalidateSettings();
    },

    close: () => db.close(),
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
