import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { DomainError } from './errors.ts';

const blocked = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DomainError('invalid', 'Only http and https URLs are supported.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0) {
    throw new DomainError('invalid', `The host ${host} could not be resolved.`);
  }
  if (addresses.some(isBlockedAddress)) {
    throw new DomainError('invalid', 'URLs that point to private or local addresses are not allowed.');
  }
}

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs?: number;
  /** Test hook. */
  fetchImpl?: typeof fetch;
  /** Test hook, skips the public address check. */
  allowPrivate?: boolean;
}

/** Downloads a file from a public URL, with a size cap and without following redirects into private networks. */
export async function downloadPublicFile(rawUrl: string, options: DownloadOptions): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainError('invalid', 'The URL is not valid.');
  }

  try {
    for (let hop = 0; hop < 4; hop++) {
      if (!options.allowPrivate) await assertPublicUrl(url);
      const response = await fetchImpl(url, { redirect: 'manual', signal });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new DomainError('invalid', 'The server sent a redirect without a target.');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DomainError('invalid', `The download failed with status ${response.status}.`);
      }
      return await readCapped(response, options.maxBytes);
    }
  } catch (err) {
    if (err instanceof DomainError) throw err;
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
    throw new DomainError('invalid', `The download ${reason}.`);
  }
  throw new DomainError('invalid', 'The URL redirects too many times.');
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const tooLarge = () =>
    new DomainError('invalid', `The file is larger than ${Math.floor(maxBytes / 1_000_000)} MB.`);
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
