import { createNormalizeContext, type RawItemView } from '@unicontext/connector-sdk';
import { CanonicalEntitySchema, stableId } from '@unicontext/canonical-model';
import { describe, expect, it } from 'vitest';
import { createMappedNormalizer, parseMappingSpec } from '../src/index.js';
import { ANNOUNCEMENTS, ASSIGNMENTS, canvasYaml, COURSES } from './helpers.js';

const SOURCE_ID = 'canvas-src';
const ctx = createNormalizeContext({
  sourceId: SOURCE_ID,
  sourceSystem: 'canvas',
  defaultAuthority: 'lms',
  timezone: 'Asia/Tokyo',
  now: new Date('2026-10-01T00:00:00Z'),
});

function view(sourceType: string, externalId: string, payload: unknown): RawItemView {
  return {
    id: `raw:${sourceType}:${externalId}`,
    sourceId: SOURCE_ID,
    sourceType,
    externalId,
    payload,
    fetchedAt: '2026-10-01T00:00:00.000Z',
    sourceUpdatedAt: undefined,
    contentHash: 'h',
  };
}

const spec = parseMappingSpec(canvasYaml());
const normalizer = createMappedNormalizer(spec);
const id = (kind: Parameters<typeof stableId>[0], key: string): string =>
  stableId(kind, SOURCE_ID, key);

describe('createMappedNormalizer', () => {
  it('exposes id, source types and a content-sensitive version', () => {
    expect(normalizer.id).toBe('mapped:canvas');
    expect([...normalizer.sourceTypes].sort()).toEqual([
      'canvas.announcement',
      'canvas.assignment',
      'canvas.course',
    ]);
    const changed = createMappedNormalizer(
      parseMappingSpec(canvasYaml().replace('title: name', 'title: course_code')),
    );
    expect(changed.version).not.toBe(normalizer.version);
    expect(normalizer.version).toMatch(/^1\.[0-9a-f]{8}$/);
  });

  it('maps a course to a courseOffering with provenance', async () => {
    const out = await normalizer.normalize(view('canvas.course', '101', COURSES[0]), ctx);
    expect(out.warnings).toEqual([]);
    expect(out.entities).toHaveLength(1);
    const e = out.entities[0];
    expect(e?.entity).toMatchObject({
      id: id('courseOffering', '101'),
      kind: 'courseOffering',
      title: 'データベースシステム論',
      courseCode: 'DB-101',
      academicYear: 2026,
    });
    expect(e?.ref).toEqual({ url: 'https://canvas.example/courses/101' });
    expect(CanonicalEntitySchema.safeParse(e?.entity).success).toBe(true);
  });

  it('maps assignments: dates with offsets, references via _parent, local datetimes in ctx.timezone', async () => {
    const a1 = await normalizer.normalize(
      view('canvas.assignment', '5001', {
        ...(ASSIGNMENTS[101]?.[0] as object),
        _parent: { courseId: 101 },
      }),
      ctx,
    );
    expect(a1.entities[0]?.entity).toMatchObject({
      kind: 'assignment',
      title: '課題1: ER図',
      dueAt: '2026-10-08T14:59:00Z',
      courseOfferingId: id('courseOffering', '101'),
    });
    expect(a1.entities[0]?.ref).toEqual({
      url: 'https://canvas.example/courses/101/assignments/5001',
      authority: 'submission-system',
    });
    const a2 = await normalizer.normalize(
      view('canvas.assignment', '5002', {
        ...(ASSIGNMENTS[102]?.[0] as object),
        _parent: { courseId: 102 },
      }),
      ctx,
    );
    expect(a2.entities[0]?.entity).toMatchObject({ dueAt: '2026-10-09T23:59:00+09:00' });
    const tokyoNy = await normalizer.normalize(
      view('canvas.assignment', '5002', {
        ...(ASSIGNMENTS[102]?.[0] as object),
        _parent: { courseId: 102 },
      }),
      createNormalizeContext({
        sourceId: SOURCE_ID,
        sourceSystem: 'canvas',
        timezone: 'America/New_York',
      }),
    );
    expect(tokyoNy.entities[0]?.entity).toMatchObject({ dueAt: '2026-10-09T23:59:00-04:00' });
    // null due date and missing parent are dropped, not errors
    const a3 = await normalizer.normalize(
      view('canvas.assignment', '5003', ASSIGNMENTS[102]?.[1]),
      ctx,
    );
    expect(a3.warnings).toEqual([]);
    const ent = a3.entities[0]?.entity as unknown as Record<string, unknown>;
    expect(ent.dueAt).toBeUndefined();
    expect(ent.courseOfferingId).toBeUndefined();
  });

  it('emits explicit facts with evidence, validity and authority', async () => {
    const out = await normalizer.normalize(
      view('canvas.announcement', '9001', ANNOUNCEMENTS.items[0]),
      ctx,
    );
    expect(out.entities[0]?.entity).toMatchObject({
      kind: 'announcement',
      title: '教室変更のお知らせ',
      publishedAt: '2026-10-01T09:00:00+09:00',
      authorName: '山田先生',
      courseOfferingId: id('courseOffering', '101'),
    });
    expect(out.entities[0]?.ref).toEqual({
      url: 'https://canvas.example/courses/101/discussion_topics/9001',
      location: { messageId: '9001' },
    });
    expect(out.facts).toHaveLength(1);
    expect(out.facts?.[0]).toMatchObject({
      subject: id('courseOffering', '101'),
      predicate: 'room',
      value: '11教室',
      origin: 'extracted',
      confidence: 0.8,
      evidence: '来週から11教室で行います',
      observedAt: '2026-10-01T09:00:00+09:00',
      ref: { authority: 'instructor-announcement' },
    });
    const none = await normalizer.normalize(
      view('canvas.announcement', '9002', {
        ...ANNOUNCEMENTS.items[0],
        id: 9002,
        message: '来週は休講です',
      }),
      ctx,
    );
    expect(none.facts).toEqual([]);
  });

  it('turns invalid entities into warnings instead of throwing', async () => {
    const out = await normalizer.normalize(view('canvas.course', '7', { id: 7 }), ctx);
    expect(out.entities).toEqual([]);
    expect(out.warnings?.[0]).toMatch(/invalid courseOffering entity skipped/);
    const bad = await normalizer.normalize(
      view('canvas.assignment', '8', { id: 8, name: 'x', due_at: 'next friday-ish' }),
      ctx,
    );
    expect(bad.entities).toHaveLength(1); // unusable date is dropped, the entity survives
    expect(bad.warnings?.some((w) => /field dueAt/.test(w))).toBe(true);
  });

  it('reports schema drift from the mini schema (without _parent)', async () => {
    const ok = await normalizer.normalize(
      view('canvas.course', '101', { id: 101, name: 'n', term: { name: '2026' } }),
      ctx,
    );
    expect(ok.drift).toEqual([]);
    const drifted = await normalizer.normalize(
      view('canvas.course', '101', { id: '101', title: 'n', _parent: { x: 1 } }),
      ctx,
    );
    const kinds = Object.fromEntries(
      (drifted.drift ?? []).map((d) => [`${d.kind}:${d.path}`, true]),
    );
    expect(kinds['type_mismatch:id']).toBe(true);
    expect(kinds['missing:name']).toBe(true);
    expect(kinds['unknown:title']).toBeUndefined(); // unknown fields are only reported when strictDrift is set
    const strict = createMappedNormalizer(
      parseMappingSpec(`${canvasYaml()}
strictDrift: true
`),
    );
    const strictOut = await strict.normalize(
      view('canvas.course', '101', { id: 101, name: 'n', title: 'x' }),
      ctx,
    );
    expect(strictOut.drift).toContainEqual({ path: 'title', kind: 'unknown' });
    expect(Object.keys(kinds).some((k) => k.includes('_parent'))).toBe(false);
  });

  it('is deterministic and pure', async () => {
    const v = view('canvas.course', '101', COURSES[0]);
    const a = await normalizer.normalize(v, ctx);
    const b = await normalizer.normalize(v, ctx);
    expect(a).toEqual(b);
  });

  it('supports forEach, when, extra, keys references and explicit coercions', async () => {
    const s = parseMappingSpec({
      id: 'edx',
      product: 'edx',
      capabilities: ['messages'],
      resources: [{ name: 'threads', sourceType: 'edx.thread', externalId: 'id' }],
      entities: {
        'edx.thread': [
          {
            kind: 'thread',
            key: '$string(id)',
            when: 'category != "Hidden"',
            fields: {
              title: 'title',
              platform: { const: 'edstem' },
              courseOfferingId: { ref: 'courseOffering', key: '$string(course)' },
            },
            extra: { votes: 'votes', secret_token: '"x"' },
          },
          {
            kind: 'message',
            forEach: 'comments',
            key: '$string($.id)',
            fields: {
              body: 'text',
              threadId: { ref: 'thread', key: '$string($root.id)' },
              authorRole: { expr: 'role = "staff" ? "instructor" : "student"' },
              isQuestion: { expr: 'q', as: 'boolean' },
              sentAt: { expr: 'at', as: 'datetime' },
            },
            ref: {
              authority: { expr: 'role = "staff" ? "instructor-announcement" : "discussion"' },
              location: { messageId: '$string(id)' },
            },
          },
        ],
      },
    });
    const n = createMappedNormalizer(s);
    const out = await n.normalize(
      view('edx.thread', '1', {
        id: 1,
        course: 55,
        title: 'Q1',
        category: 'General',
        votes: 3,
        comments: [
          { id: 11, text: 'a', role: 'staff', q: 'no', at: '2026-10-01 10:00' },
          { id: 12, text: 'b', role: 'student', q: 'yes', at: 1790000000 },
        ],
      }),
      ctx,
    );
    expect(out.warnings).toEqual([
      expect.stringContaining('credential-like extra keys: secret_token'),
    ]);
    expect(out.entities.map((e) => e.entity.kind)).toEqual(['thread', 'message', 'message']);
    expect(out.entities[0]?.entity).toMatchObject({ platform: 'edstem', extra: { votes: 3 } });
    expect(out.entities[1]?.entity).toMatchObject({
      id: id('message', '11'),
      authorRole: 'instructor',
      isQuestion: false,
      sentAt: '2026-10-01T10:00:00+09:00',
      threadId: id('thread', '1'),
    });
    expect(out.entities[1]?.ref?.authority).toBe('instructor-announcement');
    expect(out.entities[2]?.ref?.authority).toBe('discussion');
    expect(out.entities[2]?.entity).toMatchObject({ isQuestion: true });
    const hidden = await n.normalize(
      view('edx.thread', '2', { id: 2, title: 't', category: 'Hidden' }),
      ctx,
    );
    expect(hidden.entities).toEqual([]);
  });

  it('keeps going when one expression fails at runtime', async () => {
    const s = parseMappingSpec({
      id: 'x',
      product: 'x',
      capabilities: ['assignments'],
      resources: [{ name: 'a', sourceType: 'x.a', externalId: 'id' }],
      entities: {
        'x.a': [{ kind: 'assignment', fields: { title: 'name', points: '$number(pts)' } }],
      },
    });
    const out = await createMappedNormalizer(s).normalize(
      view('x.a', '1', { id: 1, name: 'T', pts: 'abc' }),
      ctx,
    );
    expect(out.entities[0]?.entity).toMatchObject({ title: 'T' });
    expect(out.warnings?.some((w) => /points/.test(w))).toBe(true);
  });
});
