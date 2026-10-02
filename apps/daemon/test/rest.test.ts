import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AnnouncementResponse,
  AnnouncementsResponse,
  AssignmentsResponse,
  ConflictsResponse,
  CoursesResponse,
  SourcesResponse,
  SourceRefResponse,
  TodayContext,
} from '../src/api-types.js';
import { settingsConfig } from '../src/rest.js';
import { bearer, createTestServer, type TestServer, TOKEN } from './helpers.js';

let s: TestServer;
const json = <T>(res: { body: string }): T => JSON.parse(res.body) as T;
const get = (url: string, headers: Record<string, string> = {}) =>
  s.app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:17878', ...headers } });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  s.app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { host: '127.0.0.1:17878', ...headers },
  });

beforeAll(async () => {
  s = await createTestServer();
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe('read endpoints (§41)', () => {
  it('GET /health', async () => {
    const res = await get('/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(json<{ ok: boolean; dev: boolean; version: string }>(res)).toMatchObject({
      ok: true,
      dev: true,
      version: '1.0.0-test',
    });
  });

  it('GET /today returns the seed day with a room conflict and citations', async () => {
    const res = await get('/api/v1/today');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    const today = json<TodayContext>(res);
    expect(today.view).toBe('today');
    expect(today.date).toBe('2026-10-01');
    expect(today.classes.length).toBeGreaterThanOrEqual(3);
    const db = today.classes.find((c) => c.course.title.includes('データベース'));
    expect(db?.room.status).toBe('conflict');
    expect(db?.citations.length).toBeGreaterThan(0);
    expect(today.conflicts.length).toBeGreaterThan(0);
  });

  it('GET /tomorrow and /week', async () => {
    expect(json<{ view: string }>(await get('/api/v1/tomorrow')).view).toBe('tomorrow');
    const week = json<{ view: string; days: unknown[] }>(await get('/api/v1/week'));
    expect(week.view).toBe('week');
    expect(week.days).toHaveLength(7);
  });

  it('GET /courses lists canonical offerings only and /courses/:id returns the bundle', async () => {
    const { courses } = json<CoursesResponse>(await get('/api/v1/courses'));
    expect(courses.length).toBeGreaterThanOrEqual(4);
    const titles = courses.map((c) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
    const db = courses.find((c) => c.title.includes('データベース'));
    expect(db).toBeDefined();
    expect(db?.linkedIds.length).toBeGreaterThan(1);
    const detail = await get(`/api/v1/courses/${encodeURIComponent(db?.id ?? '')}`);
    expect(detail.statusCode).toBe(200);
    expect(json<{ view: string }>(detail).view).toBe('course');
  });

  it('unknown course id -> 404 error body', async () => {
    const res = await get('/api/v1/courses/courseOffering:nope');
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBeTruthy();
  });

  it('GET /assignments, ?status=all and bad status', async () => {
    const open = json<AssignmentsResponse>(await get('/api/v1/assignments'));
    expect(open.assignments.length).toBeGreaterThan(0);
    for (const a of open.assignments)
      expect(['pending', 'in_progress', 'unknown']).toContain(a.status);
    const all = json<AssignmentsResponse>(await get('/api/v1/assignments?status=all'));
    expect(all.assignments.length).toBeGreaterThanOrEqual(open.assignments.length);
    expect((await get('/api/v1/assignments?status=bogus')).statusCode).toBe(400);
  });

  it('GET /deadlines, /changes', async () => {
    const d = json<{ view: string; upcoming: unknown[] }>(await get('/api/v1/deadlines?days=30'));
    expect(d.view).toBe('deadline');
    expect(d.upcoming.length).toBeGreaterThan(0);
    expect((await get('/api/v1/deadlines?days=abc')).statusCode).toBe(400);
    const c = json<{ view: string; changes: { summary: string }[] }>(await get('/api/v1/changes'));
    expect(c.view).toBe('changes');
    expect(c.changes.some((x) => x.summary.includes('締切'))).toBe(true);
    expect((await get('/api/v1/changes?since=not-a-date')).statusCode).toBe(400);
  });

  it('GET /search needs q and finds seed content', async () => {
    expect((await get('/api/v1/search')).statusCode).toBe(400);
    const res = await get(`/api/v1/search?q=${encodeURIComponent('正規化')}`);
    expect(res.statusCode).toBe(200);
    expect(json<{ hits: unknown[] }>(res).hits.length).toBeGreaterThan(0);
  });

  it('GET /announcements and /announcements/:id expose read state and the full body', async () => {
    const entities = s.runtime.uc.sync.stores.entities;
    const read = 'announcement:lcu:rest-read';
    const unread = 'announcement:lcu:rest-unread';
    const body = `${'あ'.repeat(500)}
https://example.com/a`;
    entities.upsert({
      id: read,
      kind: 'announcement',
      title: 'RESTテスト既読',
      body,
      publishedAt: '2026-09-30T05:00:00Z',
      authorName: '教務課',
      category: '教務',
      scope: 'university',
      extra: { read: true, bodyStatus: 'fetched', attachments: [{ name: '案内.pdf', size: 10 }] },
    });
    entities.upsert({
      id: unread,
      kind: 'announcement',
      title: 'RESTテスト未読',
      body: '',
      publishedAt: '2026-09-30T06:00:00Z',
      scope: 'university',
      extra: { read: false, bodyStatus: 'notOpened' },
    });
    try {
      const list = json<AnnouncementsResponse>(await get('/api/v1/announcements?since=2026-09-30'));
      const ids = list.announcements.map((a) => a.id);
      expect(ids.indexOf(unread)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(unread)).toBeLessThan(ids.indexOf(read));
      const item = list.announcements.find((a) => a.id === read);
      expect(item).toMatchObject({ read: true, category: '教務', bodyStatus: 'fetched' });
      expect(item?.body.length).toBeLessThanOrEqual(401);
      const only = json<AnnouncementsResponse>(
        await get('/api/v1/announcements?unreadOnly=1&limit=5'),
      );
      expect(only.announcements.map((a) => a.id)).toContain(unread);
      expect(only.announcements.map((a) => a.id)).not.toContain(read);
      expect((await get('/api/v1/announcements?since=nope')).statusCode).toBe(400);
      expect((await get('/api/v1/announcements?limit=x')).statusCode).toBe(400);

      const one = await get(`/api/v1/announcements/${encodeURIComponent(read)}`);
      expect(one.statusCode).toBe(200);
      expect(json<AnnouncementResponse>(one).announcement.body).toBe(body);
      expect(
        json<AnnouncementResponse>(await get(`/api/v1/announcements/${encodeURIComponent(unread)}`))
          .announcement,
      ).toMatchObject({ read: false, bodyStatus: 'notOpened', body: '' });
      const missing = await get('/api/v1/announcements/announcement:nope');
      expect(missing.statusCode).toBe(404);
      expect(json<{ error: { code: string } }>(missing).error.code).toBe('not_found');
    } finally {
      entities.hardDelete(read);
      entities.hardDelete(unread);
    }
  });

  it('GET /conflicts and /sources', async () => {
    const { conflicts } = json<ConflictsResponse>(await get('/api/v1/conflicts'));
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]?.note).toBeTruthy();
    const { sources } = json<SourcesResponse>(await get('/api/v1/sources'));
    expect(sources.map((x) => x.sourceId).sort()).toEqual(['lcu', 'lms', 'record', 'teams']);
    const lcu = sources.find((x) => x.sourceId === 'lcu');
    expect(lcu?.state).toBe('healthy');
    expect(lcu?.loaded).toBe(true);
    expect(lcu?.loginCommand).toBe('unicontext login lcu');
  });

  it('GET /source-refs/:id resolves a citation without leaking raw payload by default', async () => {
    const today = json<TodayContext>(await get('/api/v1/today'));
    const cite = today.classes[0]?.citations[0];
    expect(cite).toBeDefined();
    const res = await get(
      `/api/v1/source-refs/${encodeURIComponent(cite?.sourceReferenceId ?? '')}`,
    );
    expect(res.statusCode).toBe(200);
    const body = json<SourceRefResponse>(res);
    expect(body.citation.label).toBe(cite?.label);
    expect(body.rawItem).toBeDefined();
    expect(body.rawItem).not.toHaveProperty('payload');
    const raw = json<SourceRefResponse>(
      await get(`/api/v1/source-refs/${encodeURIComponent(cite?.sourceReferenceId ?? '')}?raw=1`),
    );
    expect(raw.rawItem).toHaveProperty('payload');
    expect((await get('/api/v1/source-refs/sourceReference:none')).statusCode).toBe(404);
  });

  it('GET /settings never includes secrets and /notifications is empty without a service', async () => {
    const res = await get('/api/v1/settings');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN);
    expect(json<{ telemetry: boolean }>(res).telemetry).toBe(false);
    expect(
      json<{ notifications: unknown[] }>(await get('/api/v1/notifications')).notifications,
    ).toEqual([]);
  });

  it('settings config masks webhook URLs and URL credentials', () => {
    const base = s.runtime.config;
    const cfg = settingsConfig({
      ...base,
      sources: { portal: { enabled: true, url: 'https://alice:pw123@portal.example.ac.jp/x' } },
      notifications: {
        ...base.notifications,
        sinks: {
          ...base.notifications.sinks,
          webhook: {
            enabled: true,
            url: 'https://discord.com/api/webhooks/123/SECRETHOOKTOKEN',
            minPriority: 'high',
          },
        },
      },
    });
    const text = JSON.stringify(cfg);
    expect(text).not.toContain('SECRETHOOKTOKEN');
    expect(text).not.toContain('pw123');
    expect(text).toContain('https://discord.com/');
    expect(text).toContain('portal.example.ac.jp');
  });

  it('unknown /api route -> JSON 404', async () => {
    const res = await get('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('not_found');
  });
});

describe('DNS rebinding and origin protection (§41)', () => {
  it('rejects a non-loopback Host', async () => {
    const res = await s.app.inject({
      method: 'GET',
      url: '/api/v1/today',
      headers: { host: 'evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('forbidden_host');
  });

  it('rejects a loopback-lookalike Host', async () => {
    for (const host of [
      '127.0.0.1.evil.com',
      'localhost.evil.com',
      'evil.com:80',
      '0.0.0.0:17878',
    ]) {
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/health', headers: { host } });
      expect(res.statusCode, host).toBe(403);
    }
  });

  it('accepts localhost, 127.0.0.1 and [::1]', async () => {
    for (const host of ['localhost:17878', '127.0.0.1:17878', '[::1]:17878', 'localhost']) {
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/health', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
  });

  it('rejects a foreign Origin even for reads, accepts loopback origins and no Origin', async () => {
    expect((await get('/api/v1/today', { origin: 'https://evil.example.com' })).statusCode).toBe(
      403,
    );
    expect((await get('/api/v1/today', { origin: 'null' })).statusCode).toBe(403);
    expect((await get('/api/v1/today', { origin: 'http://127.0.0.1:17878' })).statusCode).toBe(200);
    expect((await get('/api/v1/today')).statusCode).toBe(200);
  });

  it('sends no CORS headers and hardening headers', async () => {
    const res = await get('/api/v1/health', { origin: 'http://127.0.0.1:17878' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('GET /api/v1/grades', () => {
  it('returns the grade report shape and validates the year', async () => {
    const res = await get('/api/v1/grades');
    expect(res.statusCode).toBe(200);
    const body = json<{
      attempts: unknown[];
      courses: unknown[];
      terms: unknown[];
      totals: { attempts: number };
    }>(res);
    expect(Array.isArray(body.attempts)).toBe(true);
    expect(Array.isArray(body.courses)).toBe(true);
    expect(body.totals.attempts).toBe(body.attempts.length);
    expect((await get('/api/v1/grades?year=2026&failed=1&status=failed,不可')).statusCode).toBe(
      200,
    );
    expect((await get('/api/v1/grades?year=abc')).statusCode).toBe(400);
  });
});

describe('writes need a bearer token or the Web UI CSRF pair (§41)', () => {
  it('no credentials -> 401', async () => {
    const res = await post('/api/v1/sources/lcu/sync', {});
    expect(res.statusCode).toBe(401);
  });

  it('wrong bearer -> 401', async () => {
    const res = await post('/api/v1/sources/lcu/sync', {}, { authorization: 'Bearer nope' });
    expect(res.statusCode).toBe(401);
  });

  it('bearer -> sync runs', async () => {
    const res = await post('/api/v1/sources/lcu/sync', {}, bearer);
    expect(res.statusCode).toBe(200);
    const body = json<{ report: { ok: boolean; sourceId: string } }>(res);
    expect(body.report).toMatchObject({ ok: true, sourceId: 'lcu' });
  });

  it('?wait=0 starts the sync in the background and returns a job to poll (202)', async () => {
    const res = await post('/api/v1/sources/lcu/sync?wait=0', {}, bearer);
    expect(res.statusCode).toBe(202);
    const { job } = json<{ job: { id: string; state: string; sourceId: string } }>(res);
    expect(job).toMatchObject({ sourceId: 'lcu', state: 'running' });
    let state = job.state;
    let body: { job: { state: string; report?: { ok: boolean }; finishedAt?: string } } | undefined;
    for (let i = 0; i < 200 && state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const polled = json<NonNullable<typeof body>>(
        await get(`/api/v1/sync-jobs/${encodeURIComponent(job.id)}`),
      );
      body = polled;
      state = polled.job.state;
    }
    expect(body?.job).toMatchObject({ state: 'done', report: { ok: true } });
    expect(body?.job.finishedAt).toBeTruthy();
    expect((await get('/api/v1/sync-jobs/nope')).statusCode).toBe(404);
    // starting a job is a write: no token, no job
    expect((await post('/api/v1/sources/lcu/sync?wait=0', {})).statusCode).toBe(401);
  });

  it('sync of an unknown source -> 409 with a clear message', async () => {
    const res = await post('/api/v1/sources/zzz/sync', {}, bearer);
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { message: string } }>(res).error.message).toContain('zzz');
  });

  it('CSRF: session cookie + header + same Origin -> ok', async () => {
    const session = await get('/api/v1/session');
    const { csrfToken } = json<{ csrfToken: string }>(session);
    const setCookie = String(session.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const headers = {
      cookie: `uc_csrf=${csrfToken}`,
      'x-csrf-token': csrfToken,
      origin: 'http://127.0.0.1:17878',
    };
    const res = await post('/api/v1/sources/lcu/sync', {}, headers);
    expect(res.statusCode).toBe(200);
  });

  it('CSRF: missing origin, foreign origin, mismatched or forged token -> rejected', async () => {
    const { csrfToken } = json<{ csrfToken: string }>(await get('/api/v1/session'));
    const other = json<{ csrfToken: string }>(await get('/api/v1/session')).csrfToken;
    const base = { cookie: `uc_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
    expect((await post('/api/v1/sources/lcu/sync', {}, base)).statusCode).toBe(403);
    expect(
      (await post('/api/v1/sources/lcu/sync', {}, { ...base, origin: 'http://localhost:9999' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          '/api/v1/sources/lcu/sync',
          {},
          {
            cookie: `uc_csrf=${csrfToken}`,
            'x-csrf-token': other,
            origin: 'http://127.0.0.1:17878',
          },
        )
      ).statusCode,
    ).toBe(403);
    const forged = 'AAAA.BBBB';
    expect(
      (
        await post(
          '/api/v1/sources/lcu/sync',
          {},
          {
            cookie: `uc_csrf=${forged}`,
            'x-csrf-token': forged,
            origin: 'http://127.0.0.1:17878',
          },
        )
      ).statusCode,
    ).toBe(403);
  });

  it('bearer from a foreign Origin is still blocked by the origin rule', async () => {
    const res = await post(
      '/api/v1/sources/lcu/sync',
      {},
      { ...bearer, origin: 'https://evil.example.com' },
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('write endpoints', () => {
  it('POST /facts/:conflictId/correct resolves the conflict with a user fact (§74)', async () => {
    const before = json<ConflictsResponse>(await get('/api/v1/conflicts')).conflicts;
    const target = before.find((c) => c.predicate === 'room');
    expect(target).toBeDefined();
    const bad = await post(
      `/api/v1/facts/${encodeURIComponent(target?.id ?? '')}/correct`,
      {},
      bearer,
    );
    expect(bad.statusCode).toBe(400);
    const res = await post(
      `/api/v1/facts/${encodeURIComponent(target?.id ?? '')}/correct`,
      { value: '情報学部2号館11教室', note: '先生に確認' },
      bearer,
    );
    expect(res.statusCode).toBe(200);
    const body = json<{ fact: { origin: string; value: string } }>(res);
    expect(body.fact.origin).toBe('user');
    expect(body.fact.value).toBe('情報学部2号館11教室');
    const after = json<ConflictsResponse>(await get('/api/v1/conflicts')).conflicts;
    expect(after.some((c) => c.id === target?.id)).toBe(false);
    const today = json<TodayContext>(await get('/api/v1/today'));
    const db = today.classes.find((c) => c.course.title.includes('データベース'));
    expect(db?.room.value).toBe('情報学部2号館11教室');
    expect(db?.room.origin).toBe('user');
  });

  it('correcting an unknown id -> 404', async () => {
    const res = await post('/api/v1/facts/fact:unknown/correct', { value: 'x' }, bearer);
    expect(res.statusCode).toBe(404);
  });

  it('POST /tasks/:id/status sets a user status; invalid status -> 400', async () => {
    const { assignments } = json<AssignmentsResponse>(await get('/api/v1/assignments'));
    const id = assignments[0]?.taskId ?? '';
    expect(
      (await post(`/api/v1/tasks/${encodeURIComponent(id)}/status`, { status: 'weird' }, bearer))
        .statusCode,
    ).toBe(400);
    const res = await post(
      `/api/v1/tasks/${encodeURIComponent(id)}/status`,
      { status: 'in_progress' },
      bearer,
    );
    expect(res.statusCode).toBe(200);
    expect(json<{ task: { status: string } }>(res).task.status).toBe('in_progress');
    expect(
      (await post('/api/v1/tasks/task:none/status', { status: 'completed' }, bearer)).statusCode,
    ).toBe(404);
  });

  it('POST /identity/confirm confirms a suggested link', async () => {
    const { links } = json<{ links: { leftId: string; rightId: string }[] }>(
      await get('/api/v1/identity/links?status=suggested'),
    );
    expect(links.length).toBeGreaterThan(0);
    const l = links[0];
    const res = await post(
      '/api/v1/identity/confirm',
      { leftId: l?.leftId, rightId: l?.rightId },
      bearer,
    );
    expect(res.statusCode).toBe(200);
    expect(json<{ link: { status: string } }>(res).link.status).toBe('confirmed');
    expect((await post('/api/v1/identity/confirm', { leftId: 'x' }, bearer)).statusCode).toBe(400);
  });

  it('proposals: AI proposal is pending until the user confirms (§50)', async () => {
    const subject = json<ConflictsResponse>(await get('/api/v1/conflicts')).conflicts[0]?.subject;
    const p = s.runtime.proposals.create({
      kind: 'correct_fact',
      subject: subject ?? 'courseOffering:x',
      predicate: 'room',
      value: '共通教育A棟301',
      createdBy: 'mcp',
      preview: 'room を 共通教育A棟301 に訂正',
    });
    const list = json<{ proposals: { id: string; status: string }[] }>(
      await get('/api/v1/proposals'),
    );
    expect(list.proposals.map((x) => x.id)).toContain(p.id);
    expect((await post(`/api/v1/proposals/${p.id}/confirm`, {})).statusCode).toBe(401);
    const rej = await post(`/api/v1/proposals/${p.id}/reject`, {}, bearer);
    expect(rej.statusCode).toBe(200);
    expect(json<{ proposal: { status: string } }>(rej).proposal.status).toBe('rejected');
    const again = await post(`/api/v1/proposals/${p.id}/confirm`, {}, bearer);
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects oversized bodies', async () => {
    const res = await post(
      '/api/v1/facts/x/correct',
      { value: 'a'.repeat(2 * 1024 * 1024) },
      bearer,
    );
    expect(res.statusCode).toBe(413);
  });
});

describe('web UI hosting', () => {
  it('serves a fallback page when the UI is not built', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect((await get('/some/missing.js')).statusCode).toBe(404);
  });
});
