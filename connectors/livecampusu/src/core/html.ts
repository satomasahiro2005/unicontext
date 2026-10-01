import { type CheerioAPI, load } from 'cheerio';

/** Tokens every LCU form carries; the latest HTML response always wins (research §1.5). */
export interface PageTokens {
  /** Spring Security CSRF token (`_csrf`, also sent as X-CSRF-TOKEN on JSON POSTs). */
  csrf?: string | undefined;
  /** TERASOLUNA transaction token (`_TRANSACTION_TOKEN`). */
  transactionToken?: string | undefined;
}

export const ERROR_MESSAGE_MARKER = '処理を続行することができませんでした';
export const CSRF_FAILURE_MARKERS = ['CSRFトークンの検証に失敗しました', 'Invalid CSRF Token'];

export function loadHtml(html: string): CheerioAPI {
  return load(html);
}

export function extractTokens(html: string | CheerioAPI): PageTokens {
  const $ = typeof html === 'string' ? load(html) : html;
  const val = (sel: string, attr = 'value'): string | undefined => {
    const v = $(sel).first().attr(attr);
    return v !== undefined && v.length > 0 ? v : undefined;
  };
  return {
    csrf: val('input[name="_csrf"]') ?? val('meta[name="_csrf"]', 'content'),
    transactionToken: val('input[name="_TRANSACTION_TOKEN"]'),
  };
}

export type PageKind = 'ok' | 'login' | 'error' | 'csrf';

export interface PageClassification {
  kind: PageKind;
  reason?: string;
}

export interface ClassifyOptions {
  loginFormId: string;
  ssoStartSelector: string;
}

/**
 * Distinguish a normal screen from the signs of a lost session: the login screen, the generic
 * error screen (`<title>error`, 「処理を続行することができませんでした」 — stale token, timeout,
 * "multiple tabs"), and CSRF failures.
 */
export function classifyPage(
  html: string | CheerioAPI,
  options: ClassifyOptions,
): PageClassification {
  const $ = typeof html === 'string' ? load(html) : html;
  const title = $('title').first().text().trim();
  const text = $.root().text();
  if (CSRF_FAILURE_MARKERS.some((m) => text.includes(m)))
    return { kind: 'csrf', reason: 'CSRF token rejected' };
  if (
    $(`form#${cssEscape(options.loginFormId)}`).length > 0 ||
    $(options.ssoStartSelector).length > 0
  )
    return { kind: 'login', reason: 'login screen' };
  if (title.toLowerCase() === 'error' || text.includes(ERROR_MESSAGE_MARKER))
    return { kind: 'error', reason: 'LCU error screen' };
  return { kind: 'ok' };
}

function cssEscape(id: string): string {
  return id.replace(/([^A-Za-z0-9_-])/g, '\\$1');
}

const SCREEN_ID_RE = /\b(SC_[A-Za-z0-9]{8}_\d{2})\b/;

/** Screen id from a URL path such as /lcu-web/SC_17001B00_01 or /lcu-web/SC_17001B00_01;jsessionid=… */
export function screenIdFromUrl(url: string): string | undefined {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // relative path
  }
  const segments = path.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = SCREEN_ID_RE.exec(segments[i] ?? '');
    if (m) return m[1];
  }
  return undefined;
}

/** Remove `;jsessionid=…` URL rewriting; returns the clean URL and the id when present. */
export function stripJsessionid(url: string): { url: string; jsessionid?: string } {
  const m = /;jsessionid=([^/?#;]*)/i.exec(url);
  if (!m) return { url };
  return { url: url.replace(/;jsessionid=[^/?#;]*/gi, ''), jsessionid: m[1] ?? '' };
}

/** Collapse whitespace (incl. full-width spaces) and trim. */
export function cleanText(s: string | undefined): string {
  // JS \s includes U+3000 (full-width space).
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Trim each line, drop empty lines; keeps line structure (for "科目名\n学期/曜日・時限"). */
export function cleanLines(s: string | undefined): string {
  return (s ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/** Text of an HTML fragment with <br> turned into newlines. */
export function fragmentText(html: string): string {
  const $ = load(`<div id="__frag">${html.replace(/<br\s*\/?>/gi, '\n')}</div>`);
  return cleanLines($('#__frag').text());
}

/** Inner text of the element(s) with <br> as newlines (pass `$(el).html()`). */
export function htmlText(innerHtml: string | null | undefined): string {
  return fragmentText(innerHtml ?? '');
}
