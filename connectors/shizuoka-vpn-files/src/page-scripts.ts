/**
 * Scripts evaluated inside the signed-in portal page (same-origin GET only). The HttpOnly session
 * cookie (DSID) never leaves the browser; the page's own credentials are used. Node builds every
 * URL (path + query) and the page only fetches it, so no portal paths are hard-coded here.
 */

/** `(${script})(${arg})` — the form page.evaluate expects (an arrow function called with one arg). */
export function call(script: string, arg?: unknown): string {
  return `(${script})(${JSON.stringify(arg ?? null)})`;
}

/**
 * A response that was redirected to the Ivanti sign-in area (`/dana-na/…`) or to the bare portal
 * root (where an expired session ends up: `/dana-na/auth/welcome.cgi` → `/`, a 404 page): the
 * session is gone, whatever the final status is.
 */
const SIGNED_OUT_REDIRECT = `(r) => {
  if (!r.redirected) return false;
  try { return /^\\/(?:dana-na\\/|$)/i.test(new URL(r.url).pathname); } catch (e) { return true; }
}`;

/**
 * Is the portal session live? One same-origin GET of a JSON endpoint (the landing-page JSON the
 * signed-in SPA loads first, or the share list). Signed out, the endpoint redirects to the sign-in
 * area instead of answering JSON.
 *
 * Returns what was seen as well as the verdict, so a session that never confirms can be explained:
 * `{live, status, ctype, redirected, finalPath}` (the final path only, never a query).
 * `live` is: 200, not redirected to the sign-in area / portal root, and a JSON content type or a
 * body that parses as a JSON object (the portal sometimes labels JSON as text/html). With
 * `anyKey`, the object must also carry one of those keys as an array (the share / file lists).
 */
export const SESSION_CHECK = `async (arg) => {
  const { url, anyKey } = arg;
  if (new URL(url, location.href).origin !== location.origin) return { live: false, error: 'cross-origin' };
  let r;
  try { r = await fetch(url, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }); }
  catch (e) { return { live: false, error: 'network' }; }
  const signedOut = (${SIGNED_OUT_REDIRECT})(r);
  const ctype = r.headers.get('content-type') || '';
  let finalPath = '';
  try { finalPath = new URL(r.url).pathname; } catch (e) { /* ignore */ }
  let body;
  if (r.status === 200 && !signedOut) {
    try { body = JSON.parse((await r.text()).slice(0, 2000000)); } catch (e) { body = undefined; }
  } else {
    try { await r.body?.cancel(); } catch (e) { /* ignore */ }
  }
  const isObject = body !== undefined && body !== null && typeof body === 'object';
  let live = r.status === 200 && !signedOut && (/json/i.test(ctype) || isObject);
  if (live && Array.isArray(anyKey)) live = isObject && anyKey.some((k) => Array.isArray(body[k]));
  return { live, status: r.status, ctype, redirected: r.redirected, finalPath };
}`;

/**
 * GET a JSON endpoint (the fb list). Returns the parsed body only on 200; otherwise the status and
 * a short snippet so the caller can tell a 403 "ファイル参照エラー" from other failures. The caller
 * treats any non-200 (and a 200 with no entries) as a retryable/flaky result, never a deletion.
 */
export const FETCH_JSON = `async (arg) => {
  const { url } = arg;
  if (new URL(url, location.href).origin !== location.origin) return { error: 'cross-origin' };
  let r;
  try { r = await fetch(url, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }); }
  catch (e) { return { error: 'network', message: String(e && e.message || e) }; }
  const status = r.status;
  const ctype = r.headers.get('content-type') || '';
  if ((${SIGNED_OUT_REDIRECT})(r)) {
    try { await r.body?.cancel(); } catch (e) { /* ignore */ }
    return { ok: false, status, session: true };
  }
  if (!r.ok) {
    let snippet = '';
    try { snippet = (await r.text()).slice(0, 200); } catch (e) { /* ignore */ }
    return { ok: false, status, snippet };
  }
  if (!/json/i.test(ctype)) {
    // A login redirect or an HTML error page: the session is probably gone.
    let snippet = '';
    try { snippet = (await r.text()).slice(0, 200); } catch (e) { /* ignore */ }
    return { ok: false, status, html: true, snippet };
  }
  let body;
  try { body = await r.json(); } catch (e) { return { ok: false, status, parse: true }; }
  return { ok: true, status, body };
}`;

/**
 * Streaming download, step 1: open a same-origin GET and keep the reader on the page under `key`.
 * Node pulls the bytes with DOWNLOAD_READ, so the file is never held whole in either process.
 */
export const DOWNLOAD_OPEN = `async (arg) => {
  const { url, maxBytes, key } = arg;
  if (new URL(url, location.href).origin !== location.origin) return { error: 'cross-origin', status: 0 };
  let res;
  try { res = await fetch(url, { method: 'GET', credentials: 'same-origin' }); }
  catch (e) { return { error: 'network', status: 0, message: String(e && e.message || e) }; }
  if ((${SIGNED_OUT_REDIRECT})(res)) {
    try { await res.body?.cancel(); } catch (e) { /* ignore */ }
    return { error: 'html', status: res.status };
  }
  if (!res.ok || !res.body) {
    const retryAfter = res.headers.get('retry-after');
    try { await res.body?.cancel(); } catch (e) { /* ignore */ }
    return { error: 'http', status: res.status, retryAfter };
  }
  const ctype = res.headers.get('content-type') || '';
  // The portal answers a lost session with an HTML login page at 200: refuse it as a download.
  if (/text\\/html/i.test(ctype)) {
    try { await res.body.cancel(); } catch (e) { /* ignore */ }
    return { error: 'html', status: res.status };
  }
  const length = Number(res.headers.get('content-length') || '0');
  if (length > maxBytes) {
    try { await res.body.cancel(); } catch (e) { /* ignore */ }
    return { error: 'too large', status: res.status, length };
  }
  const store = (window.__ucVpnDownloads = window.__ucVpnDownloads || {});
  store[key] = { reader: res.body.getReader(), total: 0, max: maxBytes };
  return { ok: true, status: res.status, length, contentType: ctype };
}`;

/** Streaming download, step 2: the next chunk (about `maxChunk` bytes) as base64, or done. */
export const DOWNLOAD_READ = `async (arg) => {
  const { key, maxChunk } = arg;
  const store = window.__ucVpnDownloads || {};
  const d = store[key];
  if (!d) return { error: 'no download' };
  const parts = [];
  let size = 0;
  let done = false;
  while (size < maxChunk) {
    const r = await d.reader.read();
    if (r.done) { done = true; break; }
    parts.push(r.value);
    size += r.value.byteLength;
  }
  d.total += size;
  if (d.total > d.max) {
    try { await d.reader.cancel(); } catch (e) { /* ignore */ }
    delete store[key];
    return { error: 'too large' };
  }
  if (done) delete store[key];
  const buf = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.byteLength; }
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { base64: btoa(bin), done };
}`;

/** Streaming download, step 3: drop an unfinished download (cancel its body). */
export const DOWNLOAD_CLOSE = `async (arg) => {
  const store = window.__ucVpnDownloads || {};
  const d = store[arg.key];
  if (d) {
    delete store[arg.key];
    try { await d.reader.cancel(); } catch (e) { /* ignore */ }
  }
  return true;
}`;
