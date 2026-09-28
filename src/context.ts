import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { TransportFactory } from './domain/mail.ts';
import { getGeneralSettings } from './domain/settings.ts';
import type { GeneralSettings } from './domain/settings.ts';
import type { downloadPublicFile } from './lib/safe-fetch.ts';

const SETTINGS_TTL_MS = 15_000;

export interface StripeConnection {
  /** Replaces the network layer of the Stripe SDK. */
  fetch?: typeof fetch;
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
}

export interface Hooks {
  mailTransport?: TransportFactory;
  download?: typeof downloadPublicFile;
  stripe?: StripeConnection;
}

export interface AppContext extends Hooks {
  config: Config;
  db: Db;
  /** General settings, cached briefly because every public request needs them. */
  generalSettings(): Promise<GeneralSettings>;
  invalidateSettings(): void;
  /** Runs work after the response was sent. Failures are logged, never thrown. */
  background(label: string, work: () => Promise<unknown>): void;
  /** Resolves when all background work is done. */
  idle(): Promise<void>;
}

export function createContext(config: Config, db: Db, hooks: Hooks = {}): AppContext {
  let cached: { value: GeneralSettings; expires: number } | undefined;
  const running = new Set<Promise<unknown>>();

  return {
    config,
    db,
    ...hooks,
    async generalSettings() {
      if (!cached || cached.expires < Date.now()) {
        cached = { value: await getGeneralSettings(db), expires: Date.now() + SETTINGS_TTL_MS };
      }
      return cached.value;
    },
    invalidateSettings() {
      cached = undefined;
    },
    background(label, work) {
      const task = work()
        .catch((err) => console.error(`${label} failed`, err))
        .finally(() => running.delete(task));
      running.add(task);
    },
    async idle() {
      while (running.size > 0) await Promise.all(running);
    },
  };
}
