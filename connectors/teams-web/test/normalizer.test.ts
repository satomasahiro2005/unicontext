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

  it('a room post that names no day is news, not a room fact of the course', async () => {
    const outs = await normalizeAll(await syncItems());
    // 「来週の授業は201講義室で行います。」: 来週 alone cannot be tied to a session here.
    expect(outs.flatMap((o) => o.facts ?? [])).toEqual([]);
    const ann = entities(outs).find(
      (e) =>
        e.entity.kind === 'announcement' &&
        (e.entity.extra as Record<string, unknown> | undefined)?.['roomHint'] !== undefined,
    );
    expect(ann?.entity).toMatchObject({
      kind: 'announcement',
      extra: { roomHint: { room: '201講義室', unresolved: true } },
    });
  });

  describe('room changes are scoped to the session they name', () => {
    // The fixture's 「来週の授業は201講義室で行います。」 post (Fri 2026-10-02 JST), reworded.
    async function roomPost(content: string, arrival?: number): Promise<NormalizeOutput> {
      const items = await syncItems();
      const item = items.find((i) => JSON.stringify(i.payload).includes('201講義室'));
      if (!item) throw new Error('fixture post not found');
      const payload = structuredClone(item.payload) as {
        messages: { content: string; originalArrivalTime: number }[];
      };
      const first = payload.messages[0];
      if (!first) throw new Error('no message');
      first.content = `<p>${content}</p>`;
      if (arrival !== undefined) first.originalArrivalTime = arrival;
      return normalizer.normalize(toView({ ...item, payload }), ctx);
    }
    // 2026-10-06 10:00 JST (Tuesday)
    const TUE = Date.parse('2026-10-06T01:00:00Z');

    it('本日 is the day of the post and nothing else', async () => {
      const out = await roomPost('本日の授業は21教室で行います', TUE);
      expect(out.facts).toHaveLength(1);
      expect(out.facts?.[0]).toMatchObject({
        subject: ctx.id('courseOffering', CLASS_GROUP),
        predicate: 'room',
        value: '21教室',
        origin: 'extracted',
        confidence: 0.6,
        evidence: '本日の授業は21教室で行います',
        validFrom: '2026-10-05T15:00:00.000Z',
        validUntil: '2026-10-06T15:00:00.000Z',
      });
      const ann = out.entities.find((e) => e.entity.kind === 'announcement');
      expect((ann?.entity.extra as Record<string, unknown>)['roomHint']).toBeUndefined();
    });

    it('a named date, with its weekday checked', async () => {
      const out = await roomPost('10月13日(火)の授業は21教室で行います', TUE);
      // 10/13/2026 is a Tuesday: dated.
      expect(out.facts?.[0]).toMatchObject({
        validFrom: '2026-10-12T15:00:00.000Z',
        validUntil: '2026-10-13T15:00:00.000Z',
      });
      const wrong = await roomPost('10月13日(月)の授業は21教室で行います', TUE);
      expect(wrong.facts ?? []).toEqual([]);
    });

    it('no day: no fact, an announcement extra roomHint.unresolved', async () => {
      const out = await roomPost('教室を21教室に変更します', TUE);
      expect(out.facts ?? []).toEqual([]);
      const ann = out.entities.find((e) => e.entity.kind === 'announcement');
      expect(ann?.entity.extra).toMatchObject({ roomHint: { room: '21教室', unresolved: true } });
    });

    it('今後 stays course-wide (no validity window)', async () => {
      const out = await roomPost('今後は21教室で行います', TUE);
      expect(out.facts).toHaveLength(1);
      expect(out.facts?.[0]).toMatchObject({ value: '21教室' });
      expect(out.facts?.[0]).not.toHaveProperty('validFrom');
      expect(out.facts?.[0]).not.toHaveProperty('validUntil');
    });

    it('a greeting with 今後とも does not make a one-day change permanent', async () => {
      const out = await roomPost('本日は21教室で行います。今後ともよろしくお願いします。', TUE);
      expect(out.facts?.[0]).toMatchObject({ validUntil: '2026-10-06T15:00:00.000Z' });
    });
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
