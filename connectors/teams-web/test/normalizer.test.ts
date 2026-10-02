import { CanonicalEntitySchema } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  type NormalizeOutput,
  type RawItem,
} from '@unicontext/connector-sdk';
import { describe, expect, it } from 'vitest';
import { createTeamsWebNormalizer, submissionStatus } from '../src/index.js';
import {
  CARD_ASSIGNMENT,
  CH_MATERIALS,
  CLASS_GROUP,
  harness,
  LAB_GROUP,
  NOW,
  TEAM_ID,
  toView,
} from './helpers.js';

const ctx = createNormalizeContext({
  sourceId: 'teams-web',
  sourceSystem: 'teams-web',
  sourceLabel: 'Teams',
  defaultAuthority: 'collaboration',
  timezone: 'Asia/Tokyo',
  now: NOW,
});
const normalizer = createTeamsWebNormalizer();

async function syncItems(config: Record<string, unknown> = {}): Promise<RawItem[]> {
  const { adapter, client } = harness({ config });
  client.workComplete = false; // keep the bot card as a fallback item
  client.work = client.work.filter((w) => w.id !== CARD_ASSIGNMENT);
  return (await adapter.sync({ mode: 'initial' })).items;
}

async function normalizeAll(items: RawItem[]): Promise<NormalizeOutput[]> {
  const out: NormalizeOutput[] = [];
  for (const item of items) out.push(await normalizer.normalize(toView(item), ctx));
  return out;
}

function entities(outputs: NormalizeOutput[]) {
  return outputs.flatMap((o) => o.entities);
}

describe('teams-web normalizer', () => {
  it('produces valid canonical entities without drift for the fixtures', async () => {
    const outs = await normalizeAll(await syncItems());
    for (const o of outs) {
      expect(o.warnings ?? []).toEqual([]);
      expect(o.drift ?? []).toEqual([]);
      for (const e of o.entities) {
        const parsed = CanonicalEntitySchema.safeParse(e.entity);
        expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true);
      }
    }
  });

  it('maps a class team to a course offering (year and section out of the title) and channels to threads', async () => {
    const all = entities(await normalizeAll(await syncItems()));
    const offerings = all.filter((e) => e.entity.kind === 'courseOffering');
    expect(offerings).toHaveLength(1); // the lab team is not a class
    expect(offerings[0]?.entity).toMatchObject({
      id: ctx.id('courseOffering', CLASS_GROUP),
      title: 'データベース演習X',
      academicYear: 2026,
      instructorNames: ['教員 花子'],
      extra: { platform: 'teams', teamGroupId: CLASS_GROUP, section: '情報科' },
    });
    const threads = all.filter((e) => e.entity.kind === 'thread').map((e) => e.entity);
    expect(threads.map((t) => (t as { title: string }).title).sort()).toEqual([
      '00_講義資料',
      'General',
      'General',
      '質問',
    ]);
    const lab = threads.find(
      (t) => (t.extra as { teamGroupId?: string }).teamGroupId === LAB_GROUP,
    ) as { courseOfferingId?: string };
    expect(lab.courseOfferingId).toBeUndefined();
  });

  it('turns instructor root posts into announcements and everything else into messages', async () => {
    const all = entities(await normalizeAll(await syncItems()));
    const anns = all.filter((e) => e.entity.kind === 'announcement');
    expect(anns.map((a) => (a.entity as { title: string }).title).sort()).toEqual([
      '来週の授業は201講義室で行います。',
      '第1回の資料（合成）',
    ]);
    const first = anns.find((a) => (a.entity as { title: string }).title === '第1回の資料（合成）');
    expect(first?.entity).toMatchObject({
      courseOfferingId: ctx.id('courseOffering', CLASS_GROUP),
      authorName: 'Kyoin Hanako (教員 花子)',
      importance: 'high',
      scope: 'course',
      publishedAt: '2026-10-02T03:00:00.000Z',
      extra: {
        platform: 'teams',
        channelName: '00_講義資料',
        isReply: false,
        mentions: [{ type: 'channel', name: '00_講義資料' }],
        attachments: [{ name: 'week1.pdf', uniqueId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e' }],
      },
    });
    expect(first?.ref?.authority).toBe('instructor-announcement');
    expect(first?.ref?.url).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/message\//);
    // the attachment URL lost its tempauth parameter
    expect(JSON.stringify(first)).not.toContain('tempauth');

    const messages = all.filter((e) => e.entity.kind === 'message').map((e) => e.entity);
    const reply = messages.find((m) => (m as { body: string }).body.includes('資料ありがとう'));
    expect(reply).toMatchObject({
      threadId: ctx.id('thread', 'channel', CH_MATERIALS),
      authorRole: 'student',
      isQuestion: true,
      extra: { isReply: true, replyChainId: '1790910000000' },
    });
    // deleted replies and call events are skipped
    expect(
      messages.some((m) => (m.extra as { replyChainId?: string }).replyChainId === '1790700000000'),
    ).toBe(false);
    expect(messages).toHaveLength(3); // reply, student question, the bot card post
    const card = messages.find(
      (m) => (m.extra as { kindHint?: string }).kindHint === 'assignment-card',
    );
    expect((card as { body: string }).body).toBe('課題: 第2回レポート（合成）（期限 10月9日）');
  });

  it('extracts a room hint from an instructor post', async () => {
    const outs = await normalizeAll(await syncItems());
    const facts = outs.flatMap((o) => o.facts ?? []);
    expect(facts).toEqual([
      expect.objectContaining({
        subject: ctx.id('courseOffering', CLASS_GROUP),
        predicate: 'room',
        value: '201講義室',
        origin: 'extracted',
      }),
    ]);
  });

  it("mirrors Assignments and the student's submission state (never sets it)", async () => {
    const all = entities(await normalizeAll(await syncItems()));
    const as = all.filter((e) => e.entity.kind === 'assignment');
    const api = as.filter(
      (a) => (a.entity.extra as { source?: string }).source === 'assignments-api',
    );
    expect(api).toHaveLength(2);
    expect(api[0]?.ref?.authority).toBe('submission-system');
    expect(
      api.find((a) => (a.entity as { title: string }).title === '第3回レポート（合成）')?.entity,
    ).toMatchObject({
      courseOfferingId: ctx.id('courseOffering', CLASS_GROUP),
      dueAt: '2026-10-16T14:59:00.000Z',
      availableFrom: '2026-10-02T01:00:00.000Z',
      points: 10,
    });
    const subs = all.filter((e) => e.entity.kind === 'submission').map((e) => e.entity);
    expect(subs.map((s) => (s as { status: string }).status).sort()).toEqual([
      'graded',
      'not_submitted',
    ]);
    expect(subs.find((s) => (s as { status: string }).status === 'graded')).toMatchObject({
      score: 4,
      submittedAt: '2026-09-19T03:00:00.000Z',
    });
    // the bot card stands in for the assignment the service did not list
    const card = as.find((a) => (a.entity.extra as { source?: string }).source === 'bot-card');
    expect(card?.entity).toMatchObject({
      id: ctx.id('assignment', 'card', CARD_ASSIGNMENT),
      title: '第2回レポート（合成）',
      dueAt: '2026-10-09T14:59:00.000Z',
    });
    expect(card?.origin).toBe('extracted');
  });

  it('maps Teams submission states', () => {
    expect(submissionStatus('working', undefined, undefined, undefined)).toBe('not_submitted');
    expect(
      submissionStatus('submitted', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', undefined),
    ).toBe('submitted');
    expect(
      submissionStatus('submitted', '2026-10-03T00:00:00Z', '2026-10-02T00:00:00Z', undefined),
    ).toBe('late');
    expect(submissionStatus('returned', undefined, undefined, undefined)).toBe('returned');
    expect(submissionStatus('returned', undefined, undefined, 3)).toBe('graded');
    expect(submissionStatus('reassigned', undefined, undefined, undefined)).toBe('not_submitted');
  });

  it('maps SharePoint files to documents and materials by folder and channel', async () => {
    const all = entities(await normalizeAll(await syncItems()));
    const docs = all.filter((e) => e.entity.kind === 'document').map((e) => e.entity);
    expect(docs.map((d) => (d as { path: string }).path).sort()).toEqual([
      '/00_講義資料/week1.pdf',
      '/00_講義資料/スライド/第1回スライド.pptx',
      '/シラバス.docx',
    ]);
    const week1 = docs.find((d) => (d as { title: string }).title === 'week1.pdf');
    expect(week1).toMatchObject({
      courseOfferingId: ctx.id('courseOffering', CLASS_GROUP),
      sizeBytes: 123456,
      modifiedAt: '2026-10-02T01:48:19.000Z',
      extra: {
        folder: '00_講義資料',
        channelName: '00_講義資料',
        modifiedBy: 'Kyoin Hanako (教員 花子)',
        uniqueId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
      },
    });
    expect(JSON.stringify(docs)).not.toMatch(/tempauth|downloadUrl/i);
    const materials = all.filter((e) => e.entity.kind === 'material').map((e) => e.entity);
    expect(materials.map((m) => (m as { materialKind: string }).materialKind).sort()).toEqual([
      'handout',
      'handout',
      'slides',
    ]);
  });

  it('turns extracted text into searchable chunks of the document', async () => {
    const out = await normalizer.normalize(
      toView({
        sourceType: 'teamsweb.fileText',
        externalId: `${CLASS_GROUP}/01FILEWEEK1`,
        payload: {
          teamGroupId: CLASS_GROUP,
          itemId: '01FILEWEEK1',
          name: 'week1.pdf',
          version: 'v1',
          text: 'ERモデル',
          pages: [
            { page: 1, text: '第1回 ERモデル' },
            { page: 2, text: '正規化' },
          ],
        },
      }),
      ctx,
    );
    expect(out.entities.map((e) => e.entity)).toEqual([
      expect.objectContaining({
        kind: 'documentChunk',
        documentId: ctx.id('document', 'sp', CLASS_GROUP, '01FILEWEEK1'),
        ordinal: 0,
        page: 1,
      }),
      expect.objectContaining({ kind: 'documentChunk', ordinal: 1, page: 2, text: '正規化' }),
    ]);
  });

  it('is deterministic', async () => {
    const items = await syncItems();
    expect(await normalizeAll(items)).toEqual(await normalizeAll(items));
    expect(TEAM_ID).toMatch(/^19:/);
  });
});
