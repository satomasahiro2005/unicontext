import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoursesResponse, PaceResponse, PaceSetResponse } from '../src/api-types.js';
import { bearer, createTestServer, type TestServer } from './helpers.js';

let s: TestServer;
const HOST = { host: '127.0.0.1:17878' };
const json = <T>(res: { body: string }): T => JSON.parse(res.body) as T;
const get = (url: string) => s.app.inject({ method: 'GET', url, headers: HOST });
const send = (
  method: 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  s.app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: { ...HOST, ...headers },
  });

const self = stableId('person', 'pace-self');
const retake = stableId('courseOffering', 'lcu', 'pace-retake');
const SLOT = '土 10:00-11:30';
const path = (id: string = retake): string => `/api/v1/courses/${encodeURIComponent(id)}/pace`;

beforeAll(async () => {
  s = await createTestServer();
  const entities = s.runtime.uc.sync.stores.entities;
  entities.upsert(
    { id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
    { sourceId: 'lcu' },
  );
  entities.upsert(
    {
      id: retake,
      kind: 'courseOffering',
      title: '物理学（再履修）',
      academicYear: 2026,
      term: '後期',
      instructorIds: [],
      instructorNames: [],
      schedule: [],
      scheduleType: 'unscheduled',
    } as CanonicalEntityInput,
    { sourceId: 'lcu' },
  );
  entities.upsert(
    {
      id: stableId('enrollment', retake),
      kind: 'enrollment',
      personId: self as never,
      courseOfferingId: retake as never,
      role: 'student',
      status: 'active',
    },
    { sourceId: 'lcu' },
  );
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe('pace endpoints', () => {
  it('GET /pace lists the enrolled courses of the term (no auth needed for reads)', async () => {
    const res = await get('/api/v1/pace');
    expect(res.statusCode).toBe(200);
    const body = json<PaceResponse>(res);
    const row = body.courses.find((c) => c.course.id === retake);
    expect(row).toMatchObject({
      scheduleType: 'unscheduled',
      enrolled: true,
      slots: [],
      behindWeeks: 0,
    });
    expect(row?.thisWeek).toBeUndefined();
  });

  it('writes need the bearer token or the CSRF pair', async () => {
    expect((await send('PUT', path(), { slots: [SLOT] })).statusCode).toBe(401);
    expect((await send('DELETE', path())).statusCode).toBe(401);
    expect(
      (await send('PUT', path(), { slots: [SLOT] }, { authorization: 'Bearer wrong' })).statusCode,
    ).toBe(401);
    const { csrfToken } = json<{ csrfToken: string }>(await get('/api/v1/session'));
    const csrf = { cookie: `uc_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
    // CSRF pair without a same-origin Origin header, or with a foreign one
    expect((await send('PUT', path(), { slots: [SLOT] }, csrf)).statusCode).toBe(403);
    expect(
      (await send('PUT', path(), { slots: [SLOT] }, { ...csrf, origin: 'http://localhost:9999' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await send('DELETE', path(), undefined, { ...csrf, origin: 'http://localhost:9999' }))
        .statusCode,
    ).toBe(403);
    expect(s.runtime.uc.tasks.schedule.paceSlots([retake])).toEqual([]);

    const ok = await send(
      'PUT',
      path(),
      { slots: ['水2限'] },
      {
        ...csrf,
        origin: 'http://127.0.0.1:17878',
      },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(s.runtime.uc.tasks.schedule.paceSlots([retake])).toHaveLength(1);
  });

  it('PUT replaces the slots (text or objects) and DELETE clears them', async () => {
    const put = await send('PUT', path(), { slots: [SLOT, '水2限'] }, bearer);
    expect(put.statusCode, put.body).toBe(200);
    const body = json<PaceSetResponse>(put);
    expect(body.course.id).toBe(retake);
    expect(body.slots.map((x) => x.text)).toEqual(['水2限', SLOT]);
    expect(body.fact).toMatchObject({ predicate: 'pace_slots', origin: 'user' });

    // the week's task exists and the overview shows slots and the task
    const row = json<PaceResponse>(await get('/api/v1/pace')).courses.find(
      (c) => c.course.id === retake,
    );
    expect(row?.slots.map((x) => x.text)).toEqual(['水2限', SLOT]);
    expect(row?.thisWeek?.status).toBe('pending');
    // course detail carries the slots too
    const detail = json<{ paceSlots: { text: string }[]; scheduleType: string }>(
      await get(`/api/v1/courses/${encodeURIComponent(retake)}`),
    );
    expect(detail.scheduleType).toBe('unscheduled');
    expect(detail.paceSlots.map((x) => x.text)).toEqual(['水2限', SLOT]);

    // objects work as well, and a course can be named by its title
    const objects = await send(
      'PUT',
      path('物理学'),
      { slots: [{ dayOfWeek: 6, startTime: '09:00', endTime: '10:30' }] },
      bearer,
    );
    expect(objects.statusCode, objects.body).toBe(200);
    expect(json<PaceSetResponse>(objects).slots.map((x) => x.text)).toEqual(['土 09:00-10:30']);

    const del = await send('DELETE', path(), undefined, bearer);
    expect(del.statusCode, del.body).toBe(200);
    expect(json<PaceSetResponse>(del).slots).toEqual([]);
    expect(s.runtime.uc.tasks.schedule.paceSlots([retake])).toEqual([]);
    const { courses } = json<CoursesResponse>(await get('/api/v1/courses'));
    expect(courses.find((c) => c.id === retake)?.scheduleType).toBe('unscheduled');
  });

  it('validates the body, the slots and the course', async () => {
    const bad = await send('PUT', path(), { slots: ['いつか'] }, bearer);
    expect(bad.statusCode).toBe(400);
    expect(json<{ error: { message: string } }>(bad).error.message).toContain('読み取れません');
    expect((await send('PUT', path(), { slots: 'x' }, bearer)).statusCode).toBe(400);
    expect((await send('PUT', path(), {}, bearer)).statusCode).toBe(400);
    expect(
      (await send('PUT', path(), { slots: [{ dayOfWeek: 9, period: 1 }] }, bearer)).statusCode,
    ).toBe(400);
    expect(
      (
        await send(
          'PUT',
          path(),
          { slots: [{ dayOfWeek: 1, startTime: '25:00', endTime: '26:00' }] },
          bearer,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await send('PUT', path('courseOffering:nope'), { slots: [SLOT] }, bearer)).statusCode,
    ).toBe(404);
    expect((await send('DELETE', path('courseOffering:nope'), undefined, bearer)).statusCode).toBe(
      404,
    );
    expect(s.runtime.uc.tasks.schedule.paceSlots([retake])).toEqual([]);
  });
});
