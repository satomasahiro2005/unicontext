import { CanonicalEntitySchema, type CanonicalEntity } from '@unicontext/canonical-model';
import {
  createNormalizeContext,
  type NormalizeOutput,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { loadProfile } from '@unicontext/core';
import { DEADLINE_PREDICATE, EXTRACTOR_ID } from '@unicontext/task-engine';
import { describe, expect, it } from 'vitest';
import {
  academicTermOf,
  academicYearOf,
  courseKeyOf,
  createChatGptRecordNormalizer,
  defaultTranscriptImporter,
  inferPeriod,
  type ImportOptions,
} from '../src/index.js';
import { SRT_LECTURE, TXT_LECTURE, VTT_LECTURE } from './helpers.js';

const profile = loadProfile('shizuoka-university');
const ctx = createNormalizeContext({
  sourceId: 'record',
  sourceSystem: 'chatgpt-record',
  sourceLabel: 'ChatGPT Record',
  defaultAuthority: 'transcript',
  profile,
  now: new Date('2026-10-01T05:00:00Z'),
});
const normalizer = createChatGptRecordNormalizer();

function run(
  fileName: string,
  content: string,
  options: ImportOptions & { folderHint?: string } = {},
  externalId = 'rec-1',
): NormalizeOutput {
  const { folderHint, ...importOptions } = options;
  const payload = defaultTranscriptImporter.toPayload({
    fileName,
    content,
    timezone: ctx.timezone,
    mtime: new Date('2026-10-01T09:00:00Z'),
    ...(folderHint ? { folderHint } : {}),
    options: importOptions,
  });
  const view: RawItemView = {
    id: `raw:${externalId}`,
    sourceId: 'record',
    sourceType: 'transcript.file',
    externalId,
    payload: JSON.parse(JSON.stringify(payload)) as unknown,
    fetchedAt: '2026-10-01T05:00:00.000Z',
    sourceUpdatedAt: undefined,
    contentHash: 'h',
  };
  return normalizer.normalize(view, ctx) as NormalizeOutput;
}

const ofKind = <K extends CanonicalEntity['kind']>(
  out: NormalizeOutput,
  kind: K,
): Extract<CanonicalEntity, { kind: K }>[] =>
  out.entities
    .map((e) => CanonicalEntitySchema.parse(e.entity))
    .filter((e): e is Extract<CanonicalEntity, { kind: K }> => e.kind === kind);

describe('chatgpt-record normalizer', () => {
  const out = run('2026-10-01 10-40.vtt', VTT_LECTURE, { folderHint: 'データベースシステム論' });

  it('emits lecture, transcript, segments and a source-local course offering', () => {
    for (const e of out.entities)
      expect(CanonicalEntitySchema.safeParse(e.entity).success).toBe(true);
    const [offering] = ofKind(out, 'courseOffering');
    expect(offering).toMatchObject({
      title: 'データベースシステム論',
      academicYear: 2026,
      term: '後期',
    });
    expect(offering?.id).toBe(
      ctx.id('courseOffering', courseKeyOf('データベースシステム論'), '2026'),
    );

    const [lecture] = ofKind(out, 'lecture');
    expect(lecture).toMatchObject({
      date: '2026-10-01',
      title: '2026-10-01 10-40',
      courseOfferingId: offering?.id,
      extra: { period: 2 },
    });
    expect(lecture?.id).toBe(
      ctx.id('lecture', courseKeyOf('データベースシステム論'), '2026-10-01'),
    );

    const [transcript] = ofKind(out, 'lectureTranscript');
    expect(transcript).toMatchObject({
      lectureId: lecture?.id,
      courseOfferingId: offering?.id,
      importer: 'chatgpt-record',
      recordedAt: '2026-10-01T01:40:00.000Z',
      durationMs: 3_725_000,
      language: 'ja',
    });
  });

  it('emits ordered segments with ref.location timestamps', () => {
    const segs = ofKind(out, 'lectureSegment');
    expect(segs.map((s) => [s.ordinal, s.startMs, s.endMs, s.speaker])).toEqual([
      [0, 1000, 4000, '先生'],
      [1, 4500, 7000, '先生'],
      [2, 7000, 10_000, '先生'],
      [3, 3_723_250, 3_725_000, '学生'],
    ]);
    const transcript = ofKind(out, 'lectureTranscript')[0];
    expect(segs.every((s) => s.transcriptId === transcript?.id)).toBe(true);
    const locations = out.entities
      .filter((e) => e.entity.kind === 'lectureSegment')
      .map((e) => e.ref?.location);
    expect(locations[0]).toEqual({ timestampMs: 1000, timestamp: '00:00:01' });
    expect(locations[3]).toEqual({ timestampMs: 3_723_250, timestamp: '01:02:03' });
  });

  it('extracts a deadline that a caption split across cues, with evidence and timestamp', () => {
    expect(out.facts).toHaveLength(1);
    const [fact] = out.facts ?? [];
    const lecture = ofKind(out, 'lecture')[0];
    const offering = ofKind(out, 'courseOffering')[0];
    expect(fact).toMatchObject({
      subject: lecture?.id,
      predicate: DEADLINE_PREDICATE,
      origin: 'extracted',
      producer: { type: 'rule', id: EXTRACTOR_ID },
      observedAt: '2026-10-01T01:40:00.000Z',
    });
    expect(fact?.value).toMatchObject({
      dueAt: '2026-10-15T14:59:00.000Z',
      rule: 'absolute_date',
      courseOfferingId: offering?.id,
      timestampMs: 4500,
      timestamp: '00:00:04',
    });
    expect(fact?.evidence).toContain('レポートは10月15日23時59分までに提出してください');
    expect(fact?.confidence).toBeGreaterThan(0.5);
    expect(fact?.ref?.location).toEqual({ timestampMs: 4500, timestamp: '00:00:04' });
  });

  it('extracts deadlines from txt segments and points at the right segment', () => {
    const txt = run('2026-10-01 10-40.txt', TXT_LECTURE);
    const [fact] = txt.facts ?? [];
    expect(fact?.value).toMatchObject({ dueAt: '2026-10-15T14:59:00.000Z', timestampMs: 30_000 });
    expect(fact?.ref?.location).toEqual({ timestampMs: 30_000, timestamp: '00:00:30' });
    expect(fact?.evidence).toBe('レポートは10月15日23時59分までに提出してください。');
    // course hint came from the 授業: header
    expect(ofKind(txt, 'courseOffering')[0]?.title).toBe('データベースシステム論');
  });

  it('resolves relative deadlines against the recording time (来週の金曜日まで)', () => {
    const srt = run('2026-10-01 10-40.srt', SRT_LECTURE);
    const [fact] = srt.facts ?? [];
    expect(fact).toBeDefined();
    // Thursday 2026-10-01 -> next week's Friday 2026-10-09, end of day JST
    expect((fact?.value as { dueAt: string }).dueAt).toBe('2026-10-09T14:59:00.000Z');
    expect((fact?.value as { rule: string }).rule).toBe('weekday');
    expect(fact?.evidence).toContain('来週の金曜日までに');
  });

  it('without a course hint: no offering, lecture keyed by the transcript, no courseOfferingId on facts', () => {
    const o = run('2026-10-01 10-40.vtt', VTT_LECTURE);
    expect(ofKind(o, 'courseOffering')).toHaveLength(0);
    expect(ofKind(o, 'lecture')[0]?.courseOfferingId).toBeUndefined();
    expect(ofKind(o, 'lecture')[0]?.id).toBe(ctx.id('lecture', 'transcript', 'rec-1'));
    expect((o.facts?.[0]?.value as Record<string, unknown>).courseOfferingId).toBeUndefined();
  });

  it('lecture date is the local date in ctx.timezone', () => {
    const late = run('x.vtt', VTT_LECTURE, { date: '2026-10-01T23:30:00+09:00' });
    expect(ofKind(late, 'lecture')[0]?.date).toBe('2026-10-01');
    const early = run('x.vtt', VTT_LECTURE, { date: '2026-10-02T00:30:00+09:00' });
    expect(ofKind(early, 'lecture')[0]?.date).toBe('2026-10-02');
  });

  it('segments without timestamps carry no location', () => {
    const o = run('notes.txt', '先生: こんにちは\nレポートは10月15日23時59分までです。');
    expect(
      o.entities.filter((e) => e.entity.kind === 'lectureSegment').every((e) => !e.ref?.location),
    ).toBe(true);
    expect(o.facts?.[0]?.ref).toBeUndefined();
    expect((o.facts?.[0]?.value as Record<string, unknown>).timestampMs).toBeUndefined();
  });

  it('deduplicates the same deadline stated twice and keeps distinct ones', () => {
    const txt = [
      '[00:00:10] レポートは10月15日23時59分までに出してください。',
      '[00:05:00] 繰り返します。レポートは10月15日23時59分までに出してください。',
      '[00:06:00] 小テストは10月20日17時までです。',
    ].join('\n');
    const o = run('2026-10-01 10-40.txt', txt);
    expect(o.facts?.map((f) => (f.value as { dueAt: string }).dueAt)).toEqual([
      '2026-10-15T14:59:00.000Z',
      '2026-10-20T08:00:00.000Z',
    ]);
  });

  it('is deterministic and reports invalid payloads', () => {
    const again = run('2026-10-01 10-40.vtt', VTT_LECTURE, {
      folderHint: 'データベースシステム論',
    });
    expect(again.entities.map((e) => e.entity.id)).toEqual(out.entities.map((e) => e.entity.id));
    const bad = normalizer.normalize(
      {
        id: 'raw:x',
        sourceId: 'record',
        sourceType: 'transcript.file',
        externalId: 'x',
        payload: { nope: 1 },
        fetchedAt: '2026-10-01T00:00:00.000Z',
        sourceUpdatedAt: undefined,
        contentHash: 'h',
      },
      ctx,
    ) as NormalizeOutput;
    expect(bad.entities).toEqual([]);
    expect(bad.warnings?.[0]).toMatch(/invalid/);
    expect(bad.drift?.length).toBeGreaterThan(0);
  });

  it('uses the importer id from the payload', () => {
    const o = run('x.vtt', VTT_LECTURE, { importer: 'zoom' });
    expect(ofKind(o, 'lectureTranscript')[0]?.importer).toBe('zoom');
  });
});

describe('period and academic year helpers', () => {
  it('infers the timetable period from the recording time', () => {
    expect(inferPeriod(ctx, '2026-10-01T01:40:00.000Z')).toBe(2); // 10:40
    expect(inferPeriod(ctx, '2026-10-01T00:30:00.000Z')).toBe(1); // 09:30
    expect(inferPeriod(ctx, '2026-10-01T03:35:00.000Z')).toBe(3); // 12:35 (10 min early for 3限)
    expect(inferPeriod(ctx, '2026-10-01T13:00:00.000Z')).toBeUndefined(); // 22:00 JST
    expect(
      inferPeriod({ profile: undefined, timezone: 'Asia/Tokyo' }, '2026-10-01T01:40:00.000Z'),
    ).toBeUndefined();
  });

  it('derives the academic year from hints, profile terms and the April rule', () => {
    expect(academicYearOf(ctx, '2026-10-01T01:40:00.000Z')).toBe(2026);
    expect(academicYearOf(ctx, '2027-01-15T01:40:00.000Z', undefined)).toBe(2026);
    expect(academicYearOf(ctx, '2026-10-01T01:40:00.000Z', '2025 データベース')).toBe(2025);
    expect(
      academicYearOf({ profile: undefined, timezone: 'Asia/Tokyo' }, '2027-02-01T00:00:00.000Z'),
    ).toBe(2026);
    expect(
      academicYearOf({ profile: undefined, timezone: 'Asia/Tokyo' }, '2027-04-10T00:00:00.000Z'),
    ).toBe(2027);
  });

  it('takes the term word only from the profile term definitions', () => {
    expect(academicTermOf(ctx, '2026-10-01T01:40:00.000Z')).toBe('後期');
    expect(academicTermOf(ctx, '2026-05-01T01:40:00.000Z')).toBe('前期');
    // 学年暦: 前期 runs 4/1–9/30 (summer break included); no term defined yet for 2027
    expect(academicTermOf(ctx, '2026-08-20T01:40:00.000Z')).toBe('前期');
    expect(academicTermOf(ctx, '2027-04-10T01:40:00.000Z')).toBeUndefined();
    expect(
      academicTermOf({ profile: undefined, timezone: 'Asia/Tokyo' }, '2026-10-01T01:40:00.000Z'),
    ).toBeUndefined();
  });

  it('normalizes course keys', () => {
    expect(courseKeyOf('データベース システム論')).toBe(courseKeyOf('データベースシステム論'));
    expect(courseKeyOf('2026 DB Systems')).toBe('dbsystems');
  });
});
