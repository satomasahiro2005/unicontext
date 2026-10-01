import type { FetchLike } from '@unicontext/core';
import { fixture } from './helpers.js';

export interface LoggedRequest {
  method: string;
  path: string;
  cookie: string | undefined;
  contentType: string | undefined;
  rawBody: string | undefined;
  form: Record<string, string> | undefined;
}

export interface LcuServerOptions {
  /** Base path of the app, default "/lcu-web/". */
  basePath?: string;
  host?: string;
  resultsHtml?: string;
  detailHtml?: string;
  /** Put `;jsessionid=` into redirect locations. */
  jsessionidInUrl?: boolean;
  /** Serve the generic error screen for the Nth POST (1-based) once, simulating session loss. */
  failPostNumber?: number;
}

/**
 * A tiny stand-in for the public LiveCampusU syllabus screens: PRG redirects, JSESSIONID cookie,
 * a csrf token that changes with every served page (a request with a stale token gets the error
 * screen) and strict one-request-at-a-time checking.
 */
export function createLcuServer(options: LcuServerOptions = {}) {
  const basePath = options.basePath ?? '/lcu-web/';
  const host = options.host ?? 'lcu.example.ac.jp';
  const log: LoggedRequest[] = [];
  const formPage = fixture('lcu-syllabus-search-form-SC_06001B00_21.html');
  const resultsPage =
    options.resultsHtml ?? fixture('lcu-syllabus-search-result-SC_06001B00_21.html');
  const detailPage = options.detailHtml ?? fixture('lcu-syllabus-detail-SC_06001B00_22.html');
  let csrfCounter = 0;
  let csrf = '';
  let sessionSeq = 0;
  let session: string | undefined;
  let screen: 'form' | 'results' | 'detail' | 'none' = 'none';
  let inflight = 0;
  let postCount = 0;
  const state = {
    maxInflight: 0,
    sessionsCreated: 0,
    searches: [] as Record<string, string>[],
    linkselectRows: [] as number[],
  };

  const errorPage = (): Response =>
    new Response(
      '<html><head><title>error</title></head><body>処理を続行することができませんでした。</body></html>',
      {
        status: 200,
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      },
    );
  const html = (body: string): Response => {
    csrf = `csrf-${++csrfCounter}`;
    return new Response(body.replaceAll('REDACTED', csrf), {
      status: 200,
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  };
  const redirect = (to: string): Response => {
    const suffix = options.jsessionidInUrl && session ? `;jsessionid=${session}` : '';
    return new Response(null, { status: 302, headers: { location: `${to}${suffix}` } });
  };

  const fetchFn: FetchLike = async (input, init) => {
    inflight++;
    state.maxInflight = Math.max(state.maxInflight, inflight);
    try {
      await Promise.resolve();
      const url = new URL(input);
      if (url.host !== host) throw new Error(`unexpected host ${url.host}`);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const cookie = headers.get('cookie') ?? undefined;
      const rawBody = typeof init?.body === 'string' ? init.body : undefined;
      const form = rawBody ? Object.fromEntries(new URLSearchParams(rawBody)) : undefined;
      if (init?.redirect !== 'manual') throw new Error('connector must use redirect: manual');
      const p = url.pathname;
      if (p.includes(';')) throw new Error(`path parameter leaked into request: ${p}`);
      log.push({
        method,
        path: p,
        cookie,
        contentType: headers.get('content-type') ?? undefined,
        rawBody,
        form,
      });
      const rel = p.slice(basePath.length);

      if (method === 'GET' && rel === 'SC_06001B00_21/init') {
        if (!session || !cookie?.includes(`JSESSIONID=${session}`)) {
          session = `sess-${++sessionSeq}`;
          state.sessionsCreated++;
        }
        screen = 'none';
        const res = redirect(`${basePath}SC_06001B00_21`);
        res.headers.append(
          'set-cookie',
          `JSESSIONID=${session}; Path=${basePath.replace(/\/$/, '')}; HttpOnly`,
        );
        screen = 'form';
        return res;
      }
      if (!session || !cookie?.includes(`JSESSIONID=${session}`)) return errorPage();
      if (method === 'GET' && rel === 'SC_06001B00_21')
        return screen === 'results' ? html(resultsPage) : html(formPage);
      if (method === 'GET' && rel === 'SC_06001B00_22') return html(detailPage);
      if (method === 'POST') {
        postCount++;
        if (options.failPostNumber === postCount) {
          session = undefined; // the server forgot us
          return errorPage();
        }
        if (!form || form['_csrf'] !== csrf) return errorPage();
        if (rel === 'SC_06001B00_21/search') {
          state.searches.push(form);
          screen = 'results';
          return redirect(`${basePath}SC_06001B00_21`);
        }
        if (rel === 'SC_06001B00_21/linkselect') {
          if (screen !== 'results') return errorPage();
          state.linkselectRows.push(Number(form['rowIndex']));
          screen = 'detail';
          return redirect(`${basePath}SC_06001B00_22`);
        }
      }
      return new Response('not found', { status: 404 });
    } finally {
      inflight--;
    }
  };

  return { fetch: fetchFn, log, state };
}
