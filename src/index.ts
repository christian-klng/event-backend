import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createContext } from './context.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';

const config = loadConfig();
const db = await openDb(config.databaseUrl);

const applied = await migrate(db);
if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);

const app = createApp(createContext(config, db));
const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`event-backend listening on port ${info.port} (${config.env})`);
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
