import sharp from 'sharp';
import type { Db, Queryable } from '../db/index.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { DomainError } from '../lib/errors.ts';
import { getEvent } from './events.ts';

export const MAX_UPLOAD_BYTES = 15_000_000;
export const IMAGE_VARIANTS = ['large', 'small'] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

const UPLOAD_TOKEN_MINUTES = 15;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'heif', 'tiff']);
const VARIANT_WIDTH: Record<ImageVariant, number> = { large: 1600, small: 640 };

export interface ProcessedImage {
  hash: string;
  large: Buffer;
  small: Buffer;
  width: number;
  height: number;
}

/** Converts an uploaded picture to WebP in two sizes. Rejects anything that is not a raster image. */
export async function processImage(input: Uint8Array): Promise<ProcessedImage> {
  if (input.byteLength === 0) throw new DomainError('invalid', 'The file is empty.');
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    throw new DomainError('invalid', `The file is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.`);
  }

  try {
    const source = sharp(input, { limitInputPixels: 60_000_000 });
    const { format } = await source.metadata();
    if (!format || !ACCEPTED_FORMATS.has(format)) {
      throw new DomainError('invalid', 'Supported image formats: JPEG, PNG, WebP, AVIF, GIF, HEIC, TIFF.');
    }

    const render = (variant: ImageVariant) =>
      source
        .clone()
        .rotate()
        .resize({ width: VARIANT_WIDTH[variant], height: VARIANT_WIDTH[variant], fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });

    const [large, small] = await Promise.all([render('large'), render('small')]);
    return {
      hash: sha256Hex(large.data).slice(0, 32),
      large: large.data,
      small: small.data,
      width: large.info.width,
      height: large.info.height,
    };
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError('invalid', 'The file could not be read as an image.');
  }
}

export async function setEventThumbnail(db: Db, idOrSlug: string, input: Uint8Array) {
  const image = await processImage(input);
  const id = await db.tx(async (tx) => {
    const event = await getEvent(tx, idOrSlug);
    await attachImage(tx, event.id, image);
    return event.id;
  });
  return getEvent(db, id);
}

export async function removeEventThumbnail(db: Db, idOrSlug: string) {
  const id = await db.tx(async (tx) => {
    const event = await getEvent(tx, idOrSlug);
    await tx.query('update events set thumbnail_hash = null, updated_at = now() where id = $1', [
      event.id,
    ]);
    await deleteUnusedImages(tx);
    return event.id;
  });
  return getEvent(db, id);
}

export async function findImage(
  db: Queryable,
  hash: string,
  variant: ImageVariant,
): Promise<Buffer | null> {
  if (!/^[0-9a-f]{32}$/.test(hash)) return null;
  const [row] = await db.query<{ data: Uint8Array }>(
    `select ${variant} as data from images where hash = $1`,
    [hash],
  );
  return row ? Buffer.from(row.data) : null;
}

export interface UploadTicket {
  token: string;
  expires_at: Date;
}

/** Issues a single-use token that allows one thumbnail upload for the event. */
export async function createUploadToken(db: Db, idOrSlug: string): Promise<UploadTicket & { event_id: string }> {
  const event = await getEvent(db, idOrSlug);
  const token = randomToken();
  await db.query('delete from upload_tokens where expires_at < now() or used_at is not null');
  const [row] = await db.query<{ expires_at: Date }>(
    `insert into upload_tokens (token_hash, event_id, expires_at)
     values ($1, $2, now() + make_interval(mins => $3))
     returning expires_at`,
    [sha256Hex(token), event.id, UPLOAD_TOKEN_MINUTES],
  );
  if (!row) throw new Error('insert returned no row');
  return { token, expires_at: row.expires_at, event_id: event.id };
}

export async function uploadThumbnailWithToken(db: Db, token: string, input: Uint8Array) {
  const tokenHash = sha256Hex(token);
  const invalid = new DomainError('not_found', 'The upload link is invalid, expired or already used.');

  const [open] = await db.query(
    'select 1 from upload_tokens where token_hash = $1 and used_at is null and expires_at > now()',
    [tokenHash],
  );
  if (!open) throw invalid;

  // A broken file must not use up the link, so the image is checked before the token is claimed.
  const image = await processImage(input);

  const id = await db.tx(async (tx) => {
    const [claimed] = await tx.query<{ event_id: string }>(
      `update upload_tokens set used_at = now()
       where token_hash = $1 and used_at is null and expires_at > now()
       returning event_id`,
      [tokenHash],
    );
    if (!claimed) throw invalid;
    await attachImage(tx, claimed.event_id, image);
    return claimed.event_id;
  });
  return getEvent(db, id);
}

async function attachImage(tx: Queryable, eventId: string, image: ProcessedImage): Promise<void> {
  await tx.query(
    `insert into images (hash, large, small, width, height) values ($1, $2, $3, $4, $5)
     on conflict (hash) do nothing`,
    [image.hash, image.large, image.small, image.width, image.height],
  );
  await tx.query('update events set thumbnail_hash = $1, updated_at = now() where id = $2', [
    image.hash,
    eventId,
  ]);
  await deleteUnusedImages(tx);
}

async function deleteUnusedImages(tx: Queryable): Promise<void> {
  await tx.query(
    `delete from images
     where hash not in (select thumbnail_hash from events where thumbnail_hash is not null)`,
  );
}
