import { stableId } from '@unicontext/canonical-model';
import { ManualClock, ValidationError } from '@unicontext/core';
import { EntityStore } from '@unicontext/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUniContext, type UniContext } from '../src/index.js';

const clock = new ManualClock('2026-10-01T00:00:00Z');
const id = (n: string) => stableId('announcement', 'lcu', n);
const course = stableId('courseOffering', 'lcu', 'c1');
const LONG = `${'あ'.repeat(500)}\nhttps://example.com/a`;

let uc: UniContext;

beforeEach(() => {
  uc = createUniContext({ profile: 'shizuoka-university', clock });
  const store = new EntityStore(uc.db, { clock });
  store.upsert({
    id: course,
    kind: 'courseOffering',
    title: 'データベースシステム論',
  });
  store.upsert({
    id: id('n1'),
    kind: 'announcement',
    title: '休講のお知らせ',
    body: LONG,
    publishedAt: '2026-09-30T01:00:00Z',
    authorName: '教務課',
    importance: 'high',
    scope: 'university',
    category: '教務',
    url: 'https://example.com/n1',
    courseOfferingId: course,
    extra: {
      read: true,
      bodyStatus: 'fetched',
      attachments: [{ name: '資料.pdf', size: 1024 }, { name: 'メモ.txt' }, { size: 3 }, 'x'],
      links: ['https://example.com/a', 5],
      courses: ['データベースシステム論'],
      targetDate: '2026-10-05',
    },
  });
  store.upsert({
    id: id('n2'),
    kind: 'announcement',
    title: '未読のお知らせ',
    body: '',
    publishedAt: '2026-09-29T01:00:00Z',
    scope: 'university',
    extra: { read: false, bodyStatus: 'notOpened' },
  });
  store.upsert({
    id: id('n3'),
    kind: 'announcement',
    title: '他コネクタの投稿',
    body: '本文',
    publishedAt: '2026-09-28T01:00:00Z',
    scope: 'course',
    extra: { read: 'yes', attachments: 'none', targetDate: '10/5' },
  });
});
afterEach(async () => uc.close());

describe('announcements', () => {
  it('adds read state, status, category and attachments to list items with a truncated body', () => {
    const [first] = uc.context.listAnnouncements();
    expect(first?.id).toBe(id('n1'));
    expect(first?.body.length).toBeLessThanOrEqual(401);
    expect(first).toMatchObject({
      read: true,
      bodyStatus: 'fetched',
      category: '教務',
      attachments: [{ name: '資料.pdf', size: 1024 }, { name: 'メモ.txt' }],
    });
  });

  it('treats absent or malformed extra fields as unknown', () => {
    const items = uc.context.listAnnouncements();
    const other = items.find((a) => a.id === id('n3'));
    expect(other).toMatchObject({ read: undefined, bodyStatus: undefined, attachments: [] });
    expect(uc.context.getAnnouncement(id('n3'))).toMatchObject({
      links: [],
      courses: [],
      targetDate: undefined,
    });
  });

  it('returns the full body and detail fields', () => {
    const d = uc.context.getAnnouncement(id('n1'));
    expect(d?.body).toBe(LONG);
    expect(d).toMatchObject({
      url: 'https://example.com/n1',
      links: ['https://example.com/a'],
      courses: ['データベースシステム論'],
      targetDate: '2026-10-05',
      author: '教務課',
      importance: 'high',
    });
    expect(uc.context.getAnnouncement(id('missing'))).toBeUndefined();
    expect(uc.context.getAnnouncement('assignment:nope')).toBeUndefined();
  });

  it('lists newest first and filters', () => {
    expect(uc.context.listAnnouncements().map((a) => a.id)).toEqual([id('n1'), id('n2'), id('n3')]);
    expect(uc.context.listAnnouncements({ limit: 2 })).toHaveLength(2);
    expect(uc.context.listAnnouncements({ unreadOnly: true }).map((a) => a.id)).toEqual([id('n2')]);
    expect(
      uc.context.listAnnouncements({ since: '2026-09-29T00:00:00Z' }).map((a) => a.id),
    ).toEqual([id('n1'), id('n2')]);
    expect(
      uc.context
        .listAnnouncements({ since: '2026-09-29', until: '2026-09-30T01:00:00Z' })
        .map((a) => a.id),
    ).toEqual([id('n2')]);
    expect(uc.context.listAnnouncements({ courseOfferingId: course }).map((a) => a.id)).toEqual([
      id('n1'),
    ]);
    expect(uc.context.listAnnouncements({ importance: ['normal'] }).map((a) => a.id)).toEqual([
      id('n2'),
      id('n3'),
    ]);
    expect(() => uc.context.listAnnouncements({ since: 'yesterday' })).toThrow(ValidationError);
  });
});
