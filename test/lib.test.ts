import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { decryptSecret, encryptSecret, safeEqual } from '../src/lib/crypto.ts';
import { slugify } from '../src/lib/slug.ts';

const SECRET = 'an-app-secret-with-at-least-32-characters';

describe('secrets', () => {
  it('survive a round trip and look different every time', () => {
    const first = encryptSecret('smtp-password', SECRET);
    const second = encryptSecret('smtp-password', SECRET);
    expect(first).not.toBe(second);
    expect(first).not.toContain('smtp-password');
    expect(decryptSecret(first, SECRET)).toBe('smtp-password');
  });

  it('cannot be read with another key or after tampering', () => {
    const stored = encryptSecret('smtp-password', SECRET);
    expect(() => decryptSecret(stored, `${SECRET}-other`)).toThrow();
    expect(() => decryptSecret(`${stored.slice(0, -4)}AAAA`, SECRET)).toThrow();
    expect(() => decryptSecret('plain text', SECRET)).toThrow();
  });

  it('compares tokens of any length', () => {
    expect(safeEqual('token', 'token')).toBe(true);
    expect(safeEqual('token', 'token-but-longer')).toBe(false);
  });
});

describe('slugify', () => {
  it('handles German text', () => {
    expect(slugify('Größe: Übung für Anfänger!')).toBe('groesse-uebung-fuer-anfaenger');
    expect(slugify('Café & Crème')).toBe('cafe-creme');
    expect(slugify('***')).toBe('event');
    expect(slugify('a'.repeat(200))).toHaveLength(80);
  });
});

describe('configuration', () => {
  const valid = { ADMIN_TOKEN: 'a'.repeat(32), APP_SECRET: 'b'.repeat(32) };

  it('uses the embedded database for local development', () => {
    expect(loadConfig(valid)).toMatchObject({ env: 'development', port: 3000, databaseUrl: 'pglite://.data/pglite' });
  });

  it('strips trailing slashes from the public URL', () => {
    expect(loadConfig({ ...valid, PUBLIC_BASE_URL: 'https://events.example.com/' }).publicBaseUrl).toBe(
      'https://events.example.com',
    );
  });

  it('names what is wrong', () => {
    expect(() => loadConfig({ ...valid, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
  });
});
