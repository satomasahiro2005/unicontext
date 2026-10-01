import type { BrowserCookie } from './types.js';

function domainMatches(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === '/' || requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/** Parse one Set-Cookie header value (RFC 6265, the parts browsers actually use). */
export function parseSetCookie(header: string, requestUrl: string, nowMs: number): BrowserCookie {
  const url = new URL(requestUrl);
  const [pair = '', ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  const name = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
  const value = eq >= 0 ? pair.slice(eq + 1).trim() : '';
  const defaultPath = url.pathname.includes('/')
    ? url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
    : '/';
  const cookie: BrowserCookie = {
    name,
    value,
    domain: url.hostname,
    path: defaultPath,
    expires: -1,
    httpOnly: false,
    secure: false,
  };
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i >= 0 ? attr.slice(0, i) : attr).trim().toLowerCase();
    const val = i >= 0 ? attr.slice(i + 1).trim() : '';
    if (key === 'domain' && val) cookie.domain = `.${val.replace(/^\./, '')}`;
    else if (key === 'path' && val.startsWith('/')) cookie.path = val;
    else if (key === 'max-age') {
      const n = Number(val);
      if (Number.isFinite(n)) cookie.expires = n <= 0 ? 0 : Math.floor(nowMs / 1000) + n;
    } else if (key === 'expires' && cookie.expires === -1) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') {
      const v = val.toLowerCase();
      cookie.sameSite = v === 'strict' ? 'Strict' : v === 'none' ? 'None' : 'Lax';
    }
  }
  return cookie;
}

/**
 * Small cookie jar for replaying a browser session over plain HTTP (adapter-browser exports the
 * cookies once; connectors such as LiveCampusU then use Node fetch). Values live only in memory
 * and in the SecretStore — never in the database (§32).
 */
export class CookieJar {
  private cookies: BrowserCookie[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  static fromBrowserCookies(cookies: BrowserCookie[], now?: () => number): CookieJar {
    const jar = new CookieJar(now);
    for (const c of cookies) jar.set(c);
    return jar;
  }

  private isExpired(c: BrowserCookie): boolean {
    return c.expires !== -1 && c.expires * 1000 <= this.now();
  }

  set(cookie: BrowserCookie): void {
    this.cookies = this.cookies.filter(
      (c) =>
        !(
          c.name === cookie.name &&
          c.path === cookie.path &&
          c.domain.replace(/^\./, '') === cookie.domain.replace(/^\./, '')
        ),
    );
    if (!this.isExpired(cookie)) this.cookies.push(cookie);
  }

  /** Apply Set-Cookie headers of a response (use `response.headers.getSetCookie()`). */
  update(requestUrl: string, setCookie: string[]): void {
    for (const header of setCookie) this.set(parseSetCookie(header, requestUrl, this.now()));
  }

  /** Cookies that would be sent to `url`. */
  matching(url: string): BrowserCookie[] {
    const u = new URL(url);
    return this.cookies
      .filter(
        (c) =>
          !this.isExpired(c) &&
          domainMatches(u.hostname, c.domain) &&
          pathMatches(u.pathname, c.path) &&
          (!c.secure || u.protocol === 'https:'),
      )
      .sort((a, b) => b.path.length - a.path.length);
  }

  /** Value for the `Cookie` request header ('' when nothing matches). */
  header(url: string): string {
    return this.matching(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  get(name: string, url?: string): string | undefined {
    const list = url ? this.matching(url) : this.cookies.filter((c) => !this.isExpired(c));
    return list.find((c) => c.name === name)?.value;
  }

  delete(name: string): void {
    this.cookies = this.cookies.filter((c) => c.name !== name);
  }

  clear(): void {
    this.cookies = [];
  }

  get size(): number {
    return this.cookies.filter((c) => !this.isExpired(c)).length;
  }

  toBrowserCookies(): BrowserCookie[] {
    return this.cookies.filter((c) => !this.isExpired(c)).map((c) => ({ ...c }));
  }
}
