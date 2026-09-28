import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { TransportFactory } from './domain/mail.ts';
import { getGeneralSettings } from './domain/settings.ts';
import type { GeneralSettings } from './domain/settings.ts';
import type { downloadPublicFile } from './lib/safe-fetch.ts';

const SETTINGS_TTL_MS = 15_000;

export interface AppContext {
  config: Config;
  db: Db;
  /** General settings, cached briefly because every public request needs them. */
  generalSettings(): Promise<GeneralSettings>;
  invalidateSettings(): void;
  /** Test hooks. */
  mailTransport?: TransportFactory;
  download?: typeof downloadPublicFile;
}

export function createContext(
  config: Config,
  db: Db,
  hooks: Pick<AppContext, 'mailTransport' | 'download'> = {},
): AppContext {
  let cached: { value: GeneralSettings; expires: number } | undefined;
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
  };
}
