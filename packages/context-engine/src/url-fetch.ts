import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { errorMessage } from '@unicontext/core';

/*
 * A public web file (a PDF linked from a notice, a page of the university site) fetched on the
 * student's request, so the AI reads it instead of asking the student to download and upload it.
 * Only public addresses: the daemon also answers the remote connector, so a link must never reach
 * this computer, the home network or the tailnet (every redirect hop is checked again).
 */

export const MAX_URL_FETCH_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;

export interface UrlFetchResult {
  /** URL after redirects. */
  url: string;
  bytes: Uint8Array;
  fileName: string;
  mimeType: string | undefined;
}

export class UrlFetchError extends Error {}

export const isHttpUrl = (ref: string): boolean => /^https?:\/\/[^\s]+$/i.test(ref.trim());

function v4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, the tailnet
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isNonPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Private(ip);
  if (v !== 6) return true;
  const x = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Private(mapped[1] as string);
  return (
    x === '::' ||
    x === '::1' ||
    /^f[cd]/.test(x) ||
    /^fe[89ab]/.test(x) ||
    x.startsWith('ff') ||
    x.startsWith('64:ff9b:') ||
    x.startsWith('2001:db8')
  );
}

async function assertPublic(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new UrlFetchError(`http(s) のリンクだけ開けます: ${u.protocol}`);
  if (u.username || u.password) throw new UrlFetchError('認証情報つきのリンクは開きません');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host))
    throw new UrlFetchError(`このコンピューターや家のネットワークのアドレスは開きません: ${host}`);
  const addrs = isIP(host)
    ? [host]
    : (
        await lookup(host, { all: true, verbatim: true }).catch((e: unknown) => {
          throw new UrlFetchError(`${host} が見つかりません: ${errorMessage(e)}`);
        })
      ).map((a) => a.address);
  if (addrs.length === 0 || addrs.some(isNonPublicAddress))
    throw new UrlFetchError(`このコンピューターや家のネットワークのアドレスは開きません: ${host}`);
}

function fileNameOf(url: URL, disposition: string | null, mime: string | undefined): string {
  let name: string | undefined;
  const star = disposition && /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  const plain = disposition && /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
  try {
    if (star) name = decodeURIComponent(star[1] as string);
    else if (plain) name = plain[1];
  } catch {
    name = plain?.[1];
  }
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).pop();
    try {
      name = last ? decodeURIComponent(last) : undefined;
    } catch {
      name = last;
    }
  }
  name = [...(name ?? url.hostname)]
    .map((c) => (c.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(c) ? '_' : c))
    .join('')
    .slice(0, 200);
  // A page or a type the name does not say: the extension tells the renderer what it is.
  if (mime === 'text/html' && !/\.html?$/i.test(name)) name += '.html';
  else if (mime === 'application/pdf' && !/\.pdf$/i.test(name)) name += '.pdf';
  return name;
}

/** GET a public URL (redirects followed and re-checked), at most `maxBytes`. */
export async function fetchPublicUrl(
  url: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<UrlFetchResult> {
  const maxBytes = options.maxBytes ?? MAX_URL_FETCH_BYTES;
  let current: URL;
  try {
    current = new URL(url.trim());
  } catch {
    throw new UrlFetchError(`URL として読めません: ${url}`);
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  for (let hop = 0; ; hop++) {
    await assertPublic(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'Mozilla/5.0 UniContext', accept: '*/*' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new UrlFetchError('リダイレクトが多すぎます');
      current = new URL(res.headers.get('location') as string, current);
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UrlFetchError(`${current.hostname} が HTTP ${res.status} を返しました`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      throw new UrlFetchError(`ファイルが大きすぎます（${Math.round(declared / 1e6)}MB）`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body)
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes)
          throw new UrlFetchError(`ファイルが大きすぎます（${Math.round(maxBytes / 1e6)}MB超）`);
        chunks.push(chunk);
      }
    const bytes = Buffer.concat(chunks);
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined;
    return {
      url: current.toString(),
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      fileName: fileNameOf(current, res.headers.get('content-disposition'), mime),
      mimeType: mime === 'application/octet-stream' ? undefined : mime,
    };
  }
}
