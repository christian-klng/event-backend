import { mkdir } from 'node:fs/promises';
import pg from 'pg';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs one or more statements without parameters. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Opens the database for a URL. `postgres://` connects to a server, `pglite://<dir>`
 * runs an embedded Postgres for local development and `pglite://memory` for tests.
 */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    return openPglite(target === 'memory' ? undefined : target);
  }
  return openPostgres(url);
}

function openPostgres(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', (err) => console.error('database connection error', err));

  const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
    query: async <T>(sql: string, params?: unknown[]) =>
      (await client.query(sql, params)).rows as T[],
    exec: async (sql) => {
      await client.query(sql);
    },
  });

  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(wrap(client));
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dataDir: string | undefined): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const db = new PGlite(dataDir);
  await db.waitReady;

  return {
    query: async <T>(sql: string, params?: unknown[]) =>
      (await db.query(sql, params)).rows as T[],
    exec: async (sql) => {
      await db.exec(sql);
    },
    tx: <T>(fn: (tx: Queryable) => Promise<T>) =>
      db.transaction((tx) =>
        fn({
          query: async <R>(sql: string, params?: unknown[]) =>
            (await tx.query(sql, params)).rows as R[],
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ) as Promise<T>,
    close: () => db.close(),
  };
}
