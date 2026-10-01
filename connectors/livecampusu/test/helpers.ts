import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CookieJar } from '@unicontext/adapter-browser';
import { MemorySecretStore } from '@unicontext/auth';
import { type ConnectorContext, RateLimiter } from '@unicontext/connector-sdk';
import {
  type FetchLike,
  ManualClock,
  parseProfile,
  silentLogger,
  type UniversityProfile,
} from '@unicontext/core';
import type { AuthResult } from '@unicontext/connector-sdk';
import { LiveCampusUConfigSchema, type LiveCampusUConfig } from '../src/config.js';
import type { LcuAuthStrategy, LcuCookieJar } from '../src/core/auth.js';
import { type LcuDeploymentProfile, LcuDeploymentProfileSchema } from '../src/core/deployment.js';
import { SHIZUOKA_DEPLOYMENT } from '../src/profiles/shizuoka.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, 'fixtures');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function jsonFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

export const BASE = 'https://lcu.example.ac.jp/lcu-web/';
export const HOST = 'lcu.example.ac.jp';

/** Shizuoka screen ids / endpoints on a fake host (CI never touches the real university, §65). */
export const TEST_DEPLOYMENT: LcuDeploymentProfile = LcuDeploymentProfileSchema.parse({
  ...SHIZUOKA_DEPLOYMENT,
  id: 'test',
  baseUrl: BASE,
  maintenanceWindow: undefined,
});

export const TEST_PROFILE: UniversityProfile = parseProfile(`
id: test-university
academicCalendar:
  timezone: Asia/Tokyo
  periods:
    - { period: 1, start: '8:40', end: '10:10' }
    - { period: 2, start: '10:20', end: '11:50' }
    - { period: 3, start: '12:45', end: '14:15' }
    - { period: 4, start: '14:25', end: '15:55' }
    - { period: 5, start: '16:05', end: '17:35' }
products:
  livecampusu:
    deployment: shizuoka
    auth: entra
`);

/** Rows of lcu-kadai-list-rows-SC_14002B00_01.json rendered like the server's DataTables HTML. */
export function kadaiListHtml(): string {
  const data = jsonFixture<{ rows: { _index: string; cells: string[] }[] }>(
    'lcu-kadai-list-rows-SC_14002B00_01.json',
  );
  const ids = [
    ['submissionTypeName', true],
    ['submissionSeq', false],
    ['subjectName', true],
    ['title', true],
    ['statusName', true],
    ['statusCode', false],
    ['submittalTerm', true],
    ['submittalStatusName', true],
  ] as const;
  const head = ids
    .map(([id, vis]) => `<th id="${id}" _visible="${vis}"><p>${id}</p></th>`)
    .join('');
  const rows = data.rows
    .map(
      (r) =>
        `<tr class="is-unread" _index="${r._index}">${r.cells
          .map((c) => `<td class="content is-source " id="content" data-label="">${c}</td>`)
          .join('')}</tr>`,
    )
    .join('\n');
  return `<main><table id="dataTable01" class="c-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></main>`;
}

export interface LoggedRequest {
  method: string;
  path: string;
  at: number;
  csrf?: string | undefined;
  tx?: string | undefined;
  headerCsrf?: string | undefined;
  session?: string | undefined;
  body?: string | undefined;
}

export interface FakeLcuOptions {
  clock: ManualClock;
  /** Invalidate the FIRST session (S1) after this many requests in it. */
  expireAfterRequests?: number;
  /** Notice rows (by _index) the list shows as already READ. */
  readRows?: number[];
  importantNotice?: unknown[];
  submissionInformation?: unknown[];
  warningNotice?: unknown[];
  commonJs?: string;
  /** Replace the landing page HTML (version tests). */
  landingHtml?: string;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * In-memory LCU-Web: PRG 302s, rotating `_csrf` / `_TRANSACTION_TOKEN`, stale tokens → error page
 * + dead session, idle/N-request expiry, concurrency tracking, and a log of every request.
 */
export class FakeLcuServer {
  readonly clock: ManualClock;
  sessionId = 'S1';
  private sessionCounter = 1;
  private valid = new Set<string>(['S1']);
  private requestsInSession = new Map<string, number>();
  private lastActivity = new Map<string, number>();
  csrf = 'csrf-0';
  tx = 'tx-0';
  private tokenCounter = 0;
  inflight = 0;
  maxInflight = 0;
  log: LoggedRequest[] = [];
  readRows: Set<number>;
  openedRows: number[] = [];
  timetableSemester = '1';
  examSemester = '1';
  lastRowIndex = 0;
  options: FakeLcuOptions;
  importantNotice: unknown[];
  submissionInformation: unknown[];
  warningNotice: unknown[];
  detailBody = '（本文）';
  idleMs = 60 * 60_000;

  constructor(options: FakeLcuOptions) {
    this.options = options;
    this.clock = options.clock;
    this.readRows = new Set(options.readRows ?? []);
    const imp = jsonFixture<{ response: unknown[] }>('lcu-home-importantNotice.json');
    const misc = jsonFixture<Record<string, { response: unknown }>>('lcu-home-misc-xhr.json');
    this.importantNotice = options.importantNotice ?? imp.response;
    this.submissionInformation =
      options.submissionInformation ??
      (misc['GET /lcu-web/SC_01002B00_01/submissionInformation']?.response as unknown[]);
    this.warningNotice =
      options.warningNotice ??
      (misc['GET /lcu-web/SC_01002B00_01/warningNoticeInformation']?.response as unknown[]);
  }

  /** New authenticated session (what a successful SSO refresh produces). */
  newSession(): string {
    this.sessionCounter++;
    this.sessionId = `S${this.sessionCounter}`;
    this.valid.add(this.sessionId);
    return this.sessionId;
  }

  invalidate(id = this.sessionId): void {
    this.valid.delete(id);
  }

  requests(filter?: (r: LoggedRequest) => boolean): LoggedRequest[] {
    return filter ? this.log.filter(filter) : this.log;
  }

  paths(): string[] {
    return this.log.map((r) => `${r.method} ${r.path}`);
  }

  private rotate(): void {
    this.tokenCounter++;
    this.csrf = `csrf-${this.tokenCounter}`;
    this.tx = `tx-${this.tokenCounter}`;
  }

  private html(body: string, title = 'LiveCampusU'): Response {
    this.rotate();
    const doc = body.includes('{{CSRF}}')
      ? body.replaceAll('{{CSRF}}', this.csrf).replaceAll('{{TX}}', this.tx)
      : `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>
<form id="emptyForm" method="post"><input type="hidden" name="_csrf" value="${this.csrf}"><input type="hidden" name="_TRANSACTION_TOKEN" value="${this.tx}"></form>
${body}</body></html>`;
    return new Response(doc, {
      status: 200,
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  }

  private json(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json;charset=UTF-8' },
    });
  }

  private redirect(path: string, setCookie?: string): Response {
    const headers = new Headers({ location: `/lcu-web/${path}` });
    if (setCookie) headers.append('set-cookie', setCookie);
    return new Response(null, { status: 302, headers });
  }

  private loginPage(): Response {
    return new Response(fixture('lcu-login-SC_01001B00_01.html'), {
      status: 200,
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  }

  private errorPage(): Response {
    return new Response(fixture('lcu-error.synthetic.html'), {
      status: 200,
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  }

  private noticeListHtml(): string {
    let html = fixture('lcu-renraku-list-SC_17001B00_01.html');
    for (const i of this.readRows)
      html = html.replace(`<tr class="is-unread" _index="${i}">`, `<tr _index="${i}">`);
    return html;
  }

  fetch: FetchLike = async (input, init) => {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      await tick();
      return this.handle(input, init ?? {});
    } finally {
      this.inflight--;
    }
  };

  private handle(input: string, init: RequestInit): Response {
    const url = new URL(input);
    if (url.host !== HOST) throw new TypeError(`fake LCU: unexpected host ${url.host}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const cookie = headers.get('cookie') ?? '';
    const sid = /JSESSIONID=([^;]+)/.exec(cookie)?.[1];
    const rel = url.pathname.replace(/^\/lcu-web\/?/, '').replace(/;jsessionid=[^/]*/, '');
    const query = url.search.slice(1);
    const path = query ? `${rel}?${query}` : rel;
    const body = typeof init.body === 'string' ? init.body : undefined;
    const form =
      body && /form-urlencoded/.test(headers.get('content-type') ?? '')
        ? new URLSearchParams(body)
        : undefined;
    let jsonBody: Record<string, unknown> | undefined;
    if (body && /json/.test(headers.get('content-type') ?? ''))
      jsonBody = JSON.parse(body) as Record<string, unknown>;
    this.log.push({
      method,
      path,
      at: this.clock.now().getTime(),
      csrf: form?.get('_csrf') ?? (jsonBody?._csrf as string | undefined),
      tx: form?.get('_TRANSACTION_TOKEN') ?? undefined,
      headerCsrf: headers.get('x-csrf-token') ?? undefined,
      session: sid,
      body,
    });

    if (rel === 'js/common.js')
      return new Response(this.options.commonJs ?? 'x'.repeat(27988), {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      });

    // Session validity: known id, not idle for > 60 min, not over the request budget.
    const now = this.clock.now().getTime();
    let valid = sid !== undefined && this.valid.has(sid);
    if (valid && sid) {
      const last = this.lastActivity.get(sid);
      if (last !== undefined && now - last > this.idleMs) {
        this.valid.delete(sid);
        valid = false;
      }
      const n = (this.requestsInSession.get(sid) ?? 0) + 1;
      if (
        sid === 'S1' &&
        this.options.expireAfterRequests !== undefined &&
        n > this.options.expireAfterRequests
      ) {
        this.valid.delete(sid);
        valid = false;
      }
      this.requestsInSession.set(sid, n);
    }
    if (!valid) return this.loginPage();
    this.lastActivity.set(sid as string, now);

    if (method === 'POST') {
      if (jsonBody) {
        if (headers.get('x-csrf-token') !== this.csrf || jsonBody._csrf !== this.csrf) {
          this.invalidate(sid);
          return new Response('', { status: 403 });
        }
      } else if (form?.get('_csrf') !== this.csrf || form?.get('_TRANSACTION_TOKEN') !== this.tx) {
        // Stale token (e.g. "multiple tabs"): LCU shows the error screen and the session dies.
        this.invalidate(sid);
        return this.errorPage();
      }
    }

    const initMatch = /^(SC_[A-Za-z0-9]{8}_\d{2})\/init$/.exec(rel);
    if (method === 'POST' && initMatch) return this.redirect(initMatch[1] as string);

    switch (`${method} ${rel}`) {
      case 'GET ':
      case 'GET SC_01002B00_00':
        return this.html(
          this.options.landingHtml ?? fixture('lcu-home-SC_01002B00_00.synthetic.html'),
        );
      case 'GET SC_01002B00_00/importantNotice':
        return this.json(this.importantNotice);
      case 'GET SC_01002B00_01/submissionInformation':
        return this.json(this.submissionInformation);
      case 'GET SC_01002B00_01/warningNoticeInformation':
        return this.json(this.warningNotice);
      case 'GET SC_18001B00_01':
        return this.html(fixture('lcu-scheduler-SC_18001B00_01.synthetic.html'), 'スケジュール');
      case 'POST SC_18001B00_01/timeTable':
        return this.redirect('SC_18001B00_13');
      case 'POST SC_18001B00_13/change':
        this.timetableSemester = form?.get('selectSemesterTermCode') ?? '1';
        return this.redirect('SC_18001B00_13');
      case 'GET SC_18001B00_13':
        return this.html(
          this.timetableSemester === '1'
            ? fixture('lcu-timetable-SC_18001B00_13.html')
            : '<table class="schedule-table"><tbody><tr class="week"><th></th><th id="week1">月</th></tr></tbody></table>',
          '時間割参照',
        );
      case 'POST SC_18001B00_13/testTimeTable':
        return this.redirect('SC_18001B00_19');
      case 'POST SC_18001B00_19/change':
        this.examSemester = form?.get('selectSemesterTermCode') ?? '1';
        return this.redirect('SC_18001B00_19');
      case 'GET SC_18001B00_19':
        return this.html(
          fixture(
            this.examSemester === '1'
              ? 'lcu-exam-timetable-SC_18001B00_19.synthetic.html'
              : 'lcu-exam-timetable-empty-SC_18001B00_19.synthetic.html',
          ),
          '試験時間割',
        );
      case 'GET SC_14002B00_01':
        return this.html(kadaiListHtml(), '課題・アンケートリスト');
      case 'POST SC_14002B00_01/search':
        // URL rewriting as seen when cookies are not trusted: ;jsessionid= in the Location.
        return new Response(null, {
          status: 302,
          headers: { location: `/lcu-web/SC_14002B00_01;jsessionid=${sid ?? ''}` },
        });
      case 'POST SubjectInformationSearch/getClassSubjectList': {
        const sem = String(jsonBody?.startSemester ?? '');
        const list = jsonFixture<{ response: unknown[] }>('lcu-getClassSubjectList.json').response;
        return this.json(sem === '1' ? list : []);
      }
      case 'GET SC_13002B00_01':
        return this.html(fixture('lcu-attendance-SC_13002B00_01.synthetic.html'), '出欠');
      case 'GET SC_17001B00_01':
        return this.html(this.noticeListHtml(), '連絡一覧');
      case 'POST SC_17001B00_01/rowSelect': {
        const idx = Number(form?.get('rowIndex'));
        this.openedRows.push(idx);
        this.readRows.add(idx); // opening marks it read
        this.lastRowIndex = idx;
        return this.redirect('SC_17001B00_02');
      }
      case 'GET SC_17001B00_02':
        return this.html(
          fixture('lcu-renraku-detail-SC_17001B00_02.html').replaceAll('（本文）', this.detailBody),
          '連絡詳細',
        );
      case 'POST SC_17001B00_02/back':
        return this.redirect('SC_17001B00_01');
      case 'GET SC_15005B00_01':
        return this.html('<main><h2>成績ダッシュボード</h2></main>', '成績ダッシュボード');
      case 'POST SC_15005B00_01/gredeInformation':
        return this.redirect('SC_10004B00_01');
      case 'GET SC_10004B00_01':
        return this.html(fixture('lcu-grades-shape-SC_10004B00_01.html'), '成績情報');
      default:
        return this.errorPage();
    }
  }
}

/** Auth strategy backed by the fake server: cookies = the server's current session id. */
export class FakeStrategy implements LcuAuthStrategy {
  readonly id = 'fake';
  hasSession = true;
  reauthOk = true;
  reauthCalls = 0;
  cookieCalls = 0;
  persisted: string[] = [];
  loginCalls = 0;

  constructor(private readonly server: FakeLcuServer) {}

  authenticate(): Promise<AuthResult> {
    return Promise.resolve(
      this.hasSession
        ? { status: 'authenticated' }
        : { status: 'auth_required', message: 'login required' },
    );
  }

  login(): Promise<AuthResult> {
    this.loginCalls++;
    this.hasSession = true;
    return Promise.resolve({ status: 'authenticated' });
  }

  cookies(): Promise<LcuCookieJar | undefined> {
    this.cookieCalls++;
    if (!this.hasSession) return Promise.resolve(undefined);
    return Promise.resolve(
      CookieJar.fromBrowserCookies(
        [
          {
            name: 'JSESSIONID',
            value: this.server.sessionId,
            domain: HOST,
            path: '/lcu-web',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        () => this.server.clock.now().getTime(),
      ),
    );
  }

  reauthenticate(): Promise<boolean> {
    this.reauthCalls++;
    if (!this.reauthOk) return Promise.resolve(false);
    this.server.newSession();
    return Promise.resolve(true);
  }

  persist(jar: LcuCookieJar): Promise<void> {
    this.persisted.push(jar.get('JSESSIONID') ?? '');
    return Promise.resolve();
  }

  logout(): Promise<void> {
    this.hasSession = false;
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

export function fastLimiter(clock: ManualClock): RateLimiter {
  return new RateLimiter({ clock, capacity: 10_000, refillPerSecond: 10_000, maxRetries: 0 });
}

export function testContext(
  clock: ManualClock,
  fetch: FetchLike,
  config: Record<string, unknown> = {},
  profile: UniversityProfile | undefined = TEST_PROFILE,
): ConnectorContext<LiveCampusUConfig> {
  return {
    sourceId: 'livecampusu',
    config: LiveCampusUConfigSchema.parse({
      baseUrl: BASE,
      minRequestIntervalMs: 0,
      maintenanceWindow: undefined,
      academicYear: 2026,
      ...config,
    }),
    secrets: new MemorySecretStore(),
    logger: silentLogger,
    clock,
    rateLimiter: fastLimiter(clock),
    profile,
    cacheDir: undefined,
    fetch,
  };
}

/** 2026-10-01 12:00 JST (outside the nightly window). */
export const NOON = '2026-10-01T03:00:00.000Z';

export function newClock(at = NOON): ManualClock {
  return new ManualClock(at);
}
