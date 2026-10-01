import type { CanonicalEntity } from '@unicontext/canonical-model';
import { CanonicalEntitySchema } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  type NormalizeOutput,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { describe, expect, it } from 'vitest';
import { createMicrosoft365Normalizer } from '../src/index.js';
import { CH_DB_GENERAL, fixtureValues, SELF_ID, TEAM_DB, TEAM_MISC } from './helpers.js';

const ctx = createNormalizeContext({
  sourceId: 'm365',
  sourceSystem: 'microsoft365',
  sourceLabel: 'Microsoft 365',
  defaultAuthority: 'collaboration',
  timezone: 'Asia/Tokyo',
  now: new Date('2026-10-01T00:00:00Z'),
});
const normalizer = createMicrosoft365Normalizer();

function view(sourceType: string, externalId: string, payload: unknown): RawItemView {
  return {
    id: `raw:${externalId}`,
    sourceId: 'm365',
    sourceType,
    externalId,
    payload: JSON.parse(JSON.stringify(payload)) as unknown,
    fetchedAt: '2026-10-01T00:00:00.000Z',
    sourceUpdatedAt: undefined,
    contentHash: 'h',
  };
}

const find = (name: string, id: string): Record<string, unknown> =>
  (fixtureValues(name) as Record<string, unknown>[]).find((x) => x['id'] === id) as Record<
    string,
    unknown
  >;

async function run(
  sourceType: string,
  externalId: string,
  payload: unknown,
): Promise<NormalizeOutput> {
  const out = await normalizer.normalize(view(sourceType, externalId, payload), ctx);
  for (const e of out.entities)
    expect(CanonicalEntitySchema.safeParse(e.entity).success, JSON.stringify(e.entity)).toBe(true);
  return out;
}

const entity = (out: NormalizeOutput, i = 0): CanonicalEntity =>
  out.entities[i]?.entity as CanonicalEntity;

describe('graph.event → calendarEvent', () => {
  it('maps a UTC event to ISO, with location, description and webLink', async () => {
    const out = await run('graph.event', 'EVT-DB-1005', find('events.json', 'EVT-DB-1005'));
    expect(out.entities).toHaveLength(1);
    expect(entity(out)).toMatchObject({
      kind: 'calendarEvent',
      title: 'データベースシステム論',
      startsAt: '2026-10-05T01:20:00.000Z',
      endsAt: '2026-10-05T02:50:00.000Z',
      allDay: false,
      location: '11教室',
      description: '第1回 ガイダンス。教科書を持参してください。',
      category: '授業',
    });
    expect((entity(out) as { url?: string }).url).toContain('outlook.office365.com');
    expect(out.entities[0]?.ref).toMatchObject({ authority: 'calendar' });
    expect(out.entities[0]?.ref?.url).toContain('outlook.office365.com');
    expect(out.drift?.filter((d) => d.kind !== 'unknown')).toEqual([]);
  });

  it('all-day events become local midnights; cancelled events produce nothing', async () => {
    const holiday = await run(
      'graph.event',
      'EVT-HOLIDAY-1012',
      find('events.json', 'EVT-HOLIDAY-1012'),
    );
    expect(entity(holiday)).toMatchObject({
      allDay: true,
      startsAt: '2026-10-12T00:00:00+09:00',
      endsAt: '2026-10-13T00:00:00+09:00',
    });
    const cancelled = await run(
      'graph.event',
      'EVT-CANCELLED-1019',
      find('events.json', 'EVT-CANCELLED-1019'),
    );
    expect(cancelled.entities).toEqual([]);
  });

  it('is deterministic and keeps ids stable', async () => {
    const a = await run('graph.event', 'EVT-DB-1005', find('events.json', 'EVT-DB-1005'));
    const b = await run('graph.event', 'EVT-DB-1005', find('events.json', 'EVT-DB-1005'));
    expect(entity(a).id).toBe(entity(b).id);
    expect(entity(a).id).toBe(ctx.id('calendarEvent', 'EVT-DB-1005'));
  });
});

describe('graph.message → thread + message', () => {
  it('threads by conversation and strips Re: from the title', async () => {
    const reply = await run('graph.message', 'MSG-0002', find('mail.json', 'MSG-0002'));
    const original = await run('graph.message', 'MSG-0003', find('mail.json', 'MSG-0003'));
    expect(entity(reply, 0)).toMatchObject({
      kind: 'thread',
      title: 'レポート課題の提出について',
      platform: 'outlook',
    });
    expect(entity(reply, 0).id).toBe(entity(original, 0).id);
    expect(entity(reply, 1)).toMatchObject({
      kind: 'message',
      authorName: '学習 花子',
      body: '先生、提出期限は10月8日で間違いないでしょうか？',
      sentAt: '2026-09-30T02:00:00Z',
      threadId: entity(reply, 0).id,
    });
    expect(out_ref(reply, 1)).toMatchObject({ location: { messageId: 'MSG-0002' } });
    expect(out_ref(reply, 1)?.url).toContain('outlook.office365.com');
    expect((entity(original, 1) as { extra?: Record<string, unknown> }).extra).toMatchObject({
      fromAddress: 'lecturer.taro@example.ac.jp',
      hasAttachments: true,
    });
  });
});

function out_ref(out: NormalizeOutput, i: number) {
  return out.entities[i]?.ref;
}

describe('graph.driveItem → document + material', () => {
  it('maps a pptx to a slides material and a document with path and hash', async () => {
    const out = await run('graph.driveItem', 'ITEM-PPTX', find('drive.json', 'ITEM-PPTX'));
    expect(out.entities.map((e) => e.entity.kind)).toEqual(['document', 'material']);
    expect(entity(out, 0)).toMatchObject({
      title: '第1回_ガイダンス.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      path: '/授業/データベース/第1回_ガイダンス.pptx',
      sizeBytes: 123456,
      contentHash: 'QXH-PPTX',
      modifiedAt: '2026-09-30T00:00:00Z',
    });
    expect(entity(out, 1)).toMatchObject({ materialKind: 'slides', documentId: entity(out, 0).id });
  });

  it('pdf → handout, other → other, folders are skipped', async () => {
    const pdf = await run('graph.driveItem', 'ITEM-PDF', find('drive.json', 'ITEM-PDF'));
    expect(entity(pdf, 1)).toMatchObject({ materialKind: 'handout' });
    const docx = await run('graph.driveItem', 'ITEM-DOCX', find('drive.json', 'ITEM-DOCX'));
    expect(entity(docx, 1)).toMatchObject({ materialKind: 'other' });
    expect((entity(docx, 0) as { path?: string }).path).toBe('/メモ.docx');
    const folder = await run(
      'graph.driveItem',
      'ITEM-FOLDER-DB',
      find('drive.json', 'ITEM-FOLDER-DB'),
    );
    expect(folder.entities).toEqual([]);
  });
});

describe('graph.team → courseOffering, graph.channel → thread', () => {
  it('parses 「2026年度（データベースシステム論・1クラス）」', async () => {
    const out = await run('graph.team', TEAM_DB, find('teams.json', TEAM_DB));
    expect(entity(out)).toMatchObject({
      kind: 'courseOffering',
      title: 'データベースシステム論',
      academicYear: 2026,
      id: ctx.id('courseOffering', TEAM_DB),
      extra: {
        teamId: TEAM_DB,
        teamName: '2026年度（データベースシステム論・1クラス）',
        className: '1クラス',
        parsedFromName: true,
      },
    });
  });

  it('other team names: title = displayName', async () => {
    const out = await run('graph.team', TEAM_MISC, find('teams.json', TEAM_MISC));
    expect(entity(out)).toMatchObject({ title: '情報科学基礎演習 自主ゼミ' });
    expect((entity(out) as { academicYear?: number }).academicYear).toBeUndefined();
  });

  it('a channel becomes a thread under the team offering', async () => {
    const payload = { ...find('channels-db.json', CH_DB_GENERAL), _context: { teamId: TEAM_DB } };
    const out = await run('graph.channel', `${TEAM_DB}/${CH_DB_GENERAL}`, payload);
    expect(entity(out)).toMatchObject({
      kind: 'thread',
      title: 'General',
      platform: 'teams',
      courseOfferingId: ctx.id('courseOffering', TEAM_DB),
      id: ctx.id('thread', 'channel', CH_DB_GENERAL),
    });
  });
});

describe('graph.channelMessage', () => {
  const payload = (id: string, self: string | undefined = SELF_ID) => ({
    ...find('channel-messages.json', id),
    _context: { teamId: TEAM_DB, channelId: CH_DB_GENERAL, ...(self ? { selfUserId: self } : {}) },
  });
  const ext = (id: string): string => `${TEAM_DB}/${CH_DB_GENERAL}/${id}`;

  it('a top-level post by someone else is an instructor-announcement with a room fact', async () => {
    const out = await run('graph.channelMessage', ext('1759300000001'), payload('1759300000001'));
    expect(out.entities).toHaveLength(1);
    expect(entity(out)).toMatchObject({
      kind: 'announcement',
      title: '教室変更のお知らせ',
      scope: 'course',
      importance: 'high',
      authorName: '講義 太郎',
      courseOfferingId: ctx.id('courseOffering', TEAM_DB),
      publishedAt: '2026-09-30T08:00:00Z',
    });
    expect((entity(out) as { body: string }).body).toBe(
      '来週の授業について連絡します。\n教室を11教室に変更します。\n教科書を忘れずに持参してください。',
    );
    expect(out.entities[0]?.ref).toMatchObject({
      authority: 'instructor-announcement',
      location: { messageId: '1759300000001' },
    });
    expect(out.facts).toHaveLength(1);
    expect(out.facts?.[0]).toMatchObject({
      subject: ctx.id('courseOffering', TEAM_DB),
      predicate: 'room',
      value: '11教室',
      origin: 'extracted',
      confidence: 0.6,
      evidence: '教室を11教室に変更します。',
      ref: { authority: 'instructor-announcement' },
    });
  });

  it('urgent importance maps to critical; the title falls back to the first line', async () => {
    const urgent = {
      ...find('channel-messages-incremental.json', '1759300000006'),
      _context: { teamId: TEAM_DB, channelId: CH_DB_GENERAL, selfUserId: SELF_ID },
    };
    const out = await run('graph.channelMessage', ext('1759300000006'), urgent);
    expect(entity(out)).toMatchObject({
      kind: 'announcement',
      importance: 'critical',
      title: '本日の授業は21教室で行います。',
    });
    expect(out.facts?.[0]).toMatchObject({ predicate: 'room', value: '21教室' });
  });

  it('replies become messages in the channel thread; questions are flagged', async () => {
    const reply = await run('graph.channelMessage', ext('1759300000003'), payload('1759300000003'));
    expect(entity(reply)).toMatchObject({
      kind: 'message',
      body: '締切後は減点になります。',
      isQuestion: false,
      threadId: ctx.id('thread', 'channel', CH_DB_GENERAL),
    });
    expect(reply.facts ?? []).toEqual([]);
    expect(reply.entities[0]?.ref?.authority).toBeUndefined();
  });

  it('a student top-level question by another user is still a course post (documented heuristic)', async () => {
    const out = await run('graph.channelMessage', ext('1759300000002'), payload('1759300000002'));
    expect(entity(out)).toMatchObject({ kind: 'announcement' });
    expect(out.facts ?? []).toEqual([]);
  });

  it('own posts are messages (with isQuestion), not announcements', async () => {
    const own = await run('graph.channelMessage', ext('1759300000004'), payload('1759300000004'));
    expect(entity(own)).toMatchObject({
      kind: 'message',
      isQuestion: true,
      authorName: '試験 花子',
    });
  });

  it('without the own user id every top-level post is an announcement', async () => {
    const out = await run(
      'graph.channelMessage',
      ext('1759300000004'),
      payload('1759300000004', ''),
    );
    expect(entity(out)).toMatchObject({ kind: 'announcement' });
  });

  it('system events and deleted messages produce nothing', async () => {
    const sys = await run('graph.channelMessage', ext('1759300000005'), payload('1759300000005'));
    expect(sys.entities).toEqual([]);
    const deleted = await run('graph.channelMessage', ext('x'), {
      ...payload('1759300000001'),
      deletedDateTime: '2026-10-01T00:00:00Z',
    });
    expect(deleted.entities).toEqual([]);
  });
});

describe('drift and invalid payloads', () => {
  it('reports a missing required field as drift and a warning-free empty result for unknown types', async () => {
    const out = await normalizer.normalize(
      view('graph.event', 'E1', {
        id: 'E1',
        subject: 'x',
        start: { dateTime: '2026-10-05T01:00:00', timeZone: 'UTC' },
        brandNewField: 1,
      }),
      ctx,
    );
    expect(out.drift).toEqual(expect.arrayContaining([{ path: 'brandNewField', kind: 'unknown' }]));
    const missing = await normalizer.normalize(
      view('graph.event', 'E2', { id: 'E2', subject: 'x' }),
      ctx,
    );
    expect(missing.entities).toEqual([]);
    expect(missing.warnings?.[0]).toContain('invalid graph.event');
    expect(missing.drift).toEqual(expect.arrayContaining([{ path: 'start', kind: 'missing' }]));
    expect((await normalizer.normalize(view('graph.other', 'z', {}), ctx)).entities).toEqual([]);
  });
});
