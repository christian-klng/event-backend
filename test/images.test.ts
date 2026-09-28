import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, duplicateEvent } from '../src/domain/events.ts';
import { downloadPublicFile } from '../src/lib/safe-fetch.ts';
import { createTestApp, daysFromNow, eventInput, samplePng, BASE_URL } from './helpers.ts';
import type { TestApp } from './helpers.ts';

let downloads: Record<string, Buffer> = {};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    download: async (url) => {
      const file = downloads[url];
      if (!file) throw new Error(`unexpected download: ${url}`);
      return file;
    },
  });
});
beforeEach(async () => {
  downloads = {};
  await t.reset();
});
afterAll(() => t.close());

const put = (url: string, body: Uint8Array) =>
  t.app.request(url.replace(BASE_URL, ''), { method: 'PUT', body: new Uint8Array(body) });

const imageCount = async () =>
  (await t.db.query<{ count: number }>('select count(*)::int as count from images'))[0]!.count;

describe('uploading a thumbnail', () => {
  it('stores the picture as WebP in two sizes and serves it', async () => {
    const event = await createEvent(t.db, eventInput());
    const link = await t.callTool('create_thumbnail_upload', { event: event.slug });
    expect(link.data.upload_url).toMatch(new RegExp(`^${BASE_URL}/uploads/`));
    expect(link.data.curl).toContain(link.data.upload_url);

    const upload = await put(link.data.upload_url, await samplePng(2400, 1200));
    expect(upload.status).toBe(200);

    const { thumbnail } = (await t.callTool('get_event', { event: event.slug })).data;
    expect(thumbnail).toMatchObject({ width: 1600, height: 800 });

    for (const [url, width] of [
      [thumbnail.large, 1600],
      [thumbnail.small, 640],
    ] as const) {
      const response = await t.app.request(url.replace(BASE_URL, ''));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/webp');
      expect(response.headers.get('cache-control')).toContain('immutable');
      const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      expect(meta).toMatchObject({ format: 'webp', width });
    }
  });

  it('does not enlarge small pictures', async () => {
    const event = await createEvent(t.db, eventInput());
    const link = await t.callTool('create_thumbnail_upload', { event: event.id });
    await put(link.data.upload_url, await samplePng(400, 300));
    const { thumbnail } = (await t.callTool('get_event', { event: event.id })).data;
    expect(thumbnail).toMatchObject({ width: 400, height: 300 });
  });

  it('accepts each link once', async () => {
    const event = await createEvent(t.db, eventInput());
    const link = await t.callTool('create_thumbnail_upload', { event: event.id });
    expect((await put(link.data.upload_url, await samplePng())).status).toBe(200);
    expect((await put(link.data.upload_url, await samplePng())).status).toBe(404);
    expect((await put(`${BASE_URL}/uploads/made-up-token`, await samplePng())).status).toBe(404);
  });

  it('rejects expired links', async () => {
    const event = await createEvent(t.db, eventInput());
    const link = await t.callTool('create_thumbnail_upload', { event: event.id });
    await t.db.query('update upload_tokens set expires_at = $1', [daysFromNow(0, -1)]);
    expect((await put(link.data.upload_url, await samplePng())).status).toBe(404);
  });

  it('keeps the link usable after a broken file', async () => {
    const event = await createEvent(t.db, eventInput());
    const link = await t.callTool('create_thumbnail_upload', { event: event.id });

    const broken = await put(link.data.upload_url, Buffer.from('this is not a picture'));
    expect(broken.status).toBe(400);
    const svg = await put(link.data.upload_url, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(svg.status).toBe(400);

    expect((await put(link.data.upload_url, await samplePng())).status).toBe(200);
  });
});

describe('thumbnail from a URL', () => {
  it('downloads and stores the picture', async () => {
    const event = await createEvent(t.db, eventInput());
    downloads['https://cdn.example.test/cover.png'] = await samplePng(1000, 500);

    const result = await t.callTool('set_event_thumbnail_from_url', {
      event: event.slug,
      url: 'https://cdn.example.test/cover.png',
    });
    expect(result.data.thumbnail).toMatchObject({ width: 1000, height: 500 });
  });

  it('does not download for unknown events', async () => {
    const result = await t.callTool('set_event_thumbnail_from_url', {
      event: 'unknown',
      url: 'https://cdn.example.test/cover.png',
    });
    expect(result.text).toContain('not_found');
  });
});

describe('cleaning up', () => {
  it('drops pictures that no event uses any more', async () => {
    const event = await createEvent(t.db, eventInput());
    downloads['https://cdn.example.test/a.png'] = await samplePng(800, 400);
    downloads['https://cdn.example.test/b.png'] = await samplePng(900, 400);

    await t.callTool('set_event_thumbnail_from_url', { event: event.id, url: 'https://cdn.example.test/a.png' });
    const copy = await duplicateEvent(t.db, event.id, {
      starts_at: daysFromNow(60),
      ends_at: daysFromNow(61),
    });
    expect(copy.thumbnail_hash).toBe((await t.callTool('get_event', { event: event.id })).data.thumbnail.large.split('/').at(-2));

    await t.callTool('set_event_thumbnail_from_url', { event: event.id, url: 'https://cdn.example.test/b.png' });
    expect(await imageCount()).toBe(2);

    await t.callTool('remove_event_thumbnail', { event: copy.id });
    expect(await imageCount()).toBe(1);
    await t.callTool('remove_event_thumbnail', { event: event.id });
    expect(await imageCount()).toBe(0);
  });
});

describe('downloading from URLs', () => {
  it('refuses private and local addresses', async () => {
    for (const url of [
      'http://127.0.0.1/cover.png',
      'http://localhost:3000/cover.png',
      'http://10.0.0.5/cover.png',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/cover.png',
      'file:///etc/passwd',
    ]) {
      await expect(downloadPublicFile(url, { maxBytes: 1000 }), url).rejects.toMatchObject({
        code: 'invalid',
      });
    }
  });

  it('checks redirect targets as well', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })) as typeof fetch;
    await expect(
      downloadPublicFile('https://93.184.216.34/cover.png', { maxBytes: 1000, fetchImpl }),
    ).rejects.toThrow('private or local');
  });

  it('stops at the size limit', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array(5000))) as typeof fetch;
    await expect(
      downloadPublicFile('https://93.184.216.34/cover.png', { maxBytes: 1000, fetchImpl }),
    ).rejects.toThrow('larger than');
  });
});
