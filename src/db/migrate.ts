import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './index.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../migrations');
const LOCK_ID = 823471;

/** Applies pending SQL files from `migrations/` in filename order. Returns the applied names. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const name of files) {
    const sql = await readFile(join(dir, name), 'utf8');
    await db.tx(async (tx) => {
      // Two instances starting at once must not apply the same migration twice.
      await tx.query('select pg_advisory_xact_lock($1)', [LOCK_ID]);
      const done = await tx.query('select 1 from schema_migrations where name = $1', [name]);
      if (done.length > 0) return;
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [name]);
      applied.push(name);
    });
  }
  return applied;
}
