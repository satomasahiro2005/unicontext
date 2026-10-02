/**
 * Scripts evaluated inside the Teams / SharePoint pages. They only read: IndexedDB in read-only
 * transactions (opened without a version, so the client's schema is never upgraded) and
 * same-origin GET requests to documented SharePoint endpoints with the page's own session. They
 * never read cookies, localStorage auth entries or tokens, and they drop pre-authenticated download
 * URLs before anything is returned to Node.
 *
 * Plain JavaScript strings (the build has no DOM typings); `call(script, arg)` wraps one into an
 * expression for `page.evaluate`.
 */

export function call(script: string, arg?: unknown): string {
  return `(${script})(${JSON.stringify(arg ?? null)})`;
}

const OPEN_DB = `
  async function openDb(prefix) {
    const dbs = await indexedDB.databases();
    const names = dbs.map((d) => d.name).filter((n) => typeof n === 'string' && n.startsWith(prefix));
    if (names.length === 0) return undefined;
    const name = names[0];
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onupgradeneeded = () => { r.transaction.abort(); rej(new Error('unexpected upgrade')); };
    });
    return { db, name };
  }
  function getAll(db, store, query) {
    return new Promise((res, rej) => {
      const t = db.transaction(store, 'readonly');
      const r = t.objectStore(store).getAll(query);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
`;

/** Is the client up: its conversation cache holds at least one team? */
export const CLIENT_READY = `async () => {
  ${OPEN_DB}
  if (!/teams\\.(cloud\\.)?microsoft/.test(location.host)) return { ready: false, host: location.host };
  const h = await openDb('Teams:conversation-manager:');
  if (!h) return { ready: false, host: location.host };
  try {
    const rows = await getAll(h.db, 'conversations');
    return { ready: rows.some((r) => r && r.type === 'Space'), host: location.host };
  } finally { h.db.close(); }
}`;

/** Teams (Space rows) and channels (Topic rows) from the client's conversation cache. */
export const READ_CONVERSATIONS = `async () => {
  ${OPEN_DB}
  const h = await openDb('Teams:conversation-manager:');
  if (!h) return undefined;
  try {
    const rows = await getAll(h.db, 'conversations');
    const parts = h.name.split(':');
    // Teams:conversation-manager:react-web-client:<userId>:<tenantId>:<locale>
    const userId = parts[3];
    const tenantId = parts[4];
    const tpKeys = ['spaceThreadTopic', 'topic', 'spaceType', 'threadType', 'description', 'groupId',
      'tenantid', 'creator', 'createdat', 'sharepointSiteUrl', 'sharepointRootLibrary',
      'channelDocsFolderRelativeUrl', 'isdeleted', 'topics', 'spaceId'];
    const pick = (tp) => {
      const o = {};
      for (const k of tpKeys) if (tp && tp[k] !== undefined) o[k] = tp[k];
      return o;
    };
    const spaces = rows.filter((r) => r && r.type === 'Space').map((r) => ({
      id: r.id, lastMessageTimeUtc: r.lastMessageTimeUtc ?? null, threadProperties: pick(r.threadProperties),
    }));
    const topics = rows.filter((r) => r && r.type === 'Topic').map((r) => ({
      id: r.id, teamId: r.teamId ?? (r.threadProperties && r.threadProperties.spaceId) ?? null,
      lastMessageTimeUtc: r.lastMessageTimeUtc ?? null, threadProperties: pick(r.threadProperties),
    }));
    return { userId, tenantId, spaces, topics };
  } finally { h.db.close(); }
}`;

/** All cached reply chains of one channel (`replychain-manager`), messages trimmed. */
export const READ_REPLY_CHAINS = `async (conversationId) => {
  ${OPEN_DB}
  const h = await openDb('Teams:replychain-manager:');
  if (!h) return [];
  try {
    const range = IDBKeyRange.bound([conversationId, ''], [conversationId, '\\uffff']);
    const rows = await getAll(h.db, 'replychains', range);
    const msgKeys = ['id', 'parentMessageId', 'version', 'type', 'messageType', 'contentType',
      'originalArrivalTime', 'imDisplayName', 'creator', 'content', 'isSentByCurrentUser'];
    const propKeys = ['subject', 'title', 'importance', 'mentions', 'files', 'links', 'edittime',
      'deletetime', 'systemdelete'];
    return rows.map((rc) => ({
      replyChainId: String(rc.replyChainId),
      latestDeliveryTime: rc.latestDeliveryTime ?? null,
      messages: Object.values(rc.messageMap || {}).map((m) => {
        const o = {};
        for (const k of msgKeys) if (m[k] !== undefined && m[k] !== null) o[k] = m[k];
        const p = {};
        for (const k of propKeys) if (m.properties && m.properties[k] !== undefined && m.properties[k] !== null) p[k] = m.properties[k];
        o.properties = p;
        return o;
      }),
    }));
  } finally { h.db.close(); }
}`;

/** In-app navigation to a documented deep-link path (no page reload). */
export const NAVIGATE_HASH = `(path) => { location.hash = '#' + path; return location.href.length; }`;

/** Scroll every scrollable element of a document to its end (Assignments list paging). */
export const SCROLL_TO_END = `() => {
  let n = 0;
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
      el.scrollTop = el.scrollHeight; n++;
    }
  }
  return n;
}`;

/**
 * SharePoint drive delta from a page on the site's origin: same-origin GETs with the page's own
 * session. Follows `@odata.nextLink`; returns items without download URLs and the delta link.
 */
export const DRIVE_DELTA = `async (arg) => {
  const { siteUrl, deltaLink, maxPages } = arg;
  const origin = location.origin;
  let url = deltaLink || (siteUrl.replace(/\\/+$/, '') + '/_api/v2.0/drive/root/delta');
  const items = [];
  let pages = 0;
  let finalLink;
  while (url && pages < maxPages) {
    if (new URL(url).origin !== origin) return { error: 'cross-origin', status: 0, items, pages };
    const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) {
      return { error: 'http', status: res.status, retryAfter: res.headers.get('retry-after'), items, pages };
    }
    const j = await res.json();
    pages++;
    for (const v of j.value || []) {
      for (const k of Object.keys(v)) if (/downloadurl/i.test(k)) delete v[k];
      items.push(v);
    }
    finalLink = j['@odata.deltaLink'] || finalLink;
    url = j['@odata.nextLink'];
  }
  return { items, pages, deltaLink: url ? undefined : finalLink, truncated: Boolean(url) };
}`;

/**
 * Streaming download, step 1: start a same-origin GET of the file's content inside the page
 * (documented drive item content endpoint; the classic `GetFileById(…)/$value` when that fails).
 * Any pre-authenticated redirect stays inside the browser. The response body's reader is kept in
 * the page under a random key; Node pulls it in chunks (DOWNLOAD_READ), so the file is never held
 * whole in either process.
 */
export const DOWNLOAD_OPEN = `async (arg) => {
  const { siteUrl, itemId, uniqueId, maxBytes, key } = arg;
  const base = siteUrl.replace(/\\/+$/, '');
  const urls = [base + '/_api/v2.0/drive/items/' + encodeURIComponent(itemId) + '/content'];
  if (uniqueId && /^[0-9a-f-]{36}$/i.test(uniqueId)) urls.push(base + "/_api/web/GetFileById('" + uniqueId + "')/$value");
  let res;
  let status = 0;
  let retryAfter = null;
  for (const url of urls) {
    if (new URL(url).origin !== location.origin) return { error: 'cross-origin', status: 0 };
    const r = await fetch(url, { method: 'GET', credentials: 'same-origin' });
    if (r.ok && r.body) { res = r; break; }
    status = r.status;
    retryAfter = r.headers.get('retry-after');
    try { await r.body?.cancel(); } catch (e) { /* ignore */ }
    if (r.status === 429 || r.status === 503) break;
  }
  if (!res) return { error: 'http', status, retryAfter };
  const length = Number(res.headers.get('content-length') || '0');
  if (length > maxBytes) {
    try { await res.body.cancel(); } catch (e) { /* ignore */ }
    return { error: 'too large', status: res.status, length };
  }
  const store = (window.__ucDownloads = window.__ucDownloads || {});
  store[key] = { reader: res.body.getReader(), total: 0, max: maxBytes };
  return { ok: true, status: res.status, length, contentType: res.headers.get('content-type') || '' };
}`;

/** Streaming download, step 2: the next chunk (about `maxChunk` bytes) as base64, or done. */
export const DOWNLOAD_READ = `async (arg) => {
  const { key, maxChunk } = arg;
  const store = window.__ucDownloads || {};
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
  const store = window.__ucDownloads || {};
  const d = store[arg.key];
  if (d) {
    delete store[arg.key];
    try { await d.reader.cancel(); } catch (e) { /* ignore */ }
  }
  return true;
}`;
