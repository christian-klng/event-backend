import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';

function deriveKey(appSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, '', 'event-backend/settings', 32));
}

/** Encrypts a value for storage in the database (AES-256-GCM). */
export function encryptSecret(plain: string, appSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(appSecret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join(':');
}

export function decryptSecret(stored: string, appSecret: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new Error('stored secret has an unknown format');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(appSecret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Compares two strings without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
