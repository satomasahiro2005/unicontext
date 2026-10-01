import { describe, expect, it } from 'vitest';
import {
  defaultTranscriptImporter,
  findLocalDateTime,
  localDateOf,
  parseDateTimeText,
  recordedAtFromFileName,
  TranscriptImporter,
  type TranscriptFormat,
} from '../src/index.js';
import { TXT_LECTURE, VTT_LECTURE } from './helpers.js';

const TZ = 'Asia/Tokyo';

describe('recordedAt from file names', () => {
  it.each([
    ['2026-10-01 10-40.vtt', '2026-10-01T01:40:00.000Z'],
    ['2026-10-01_10-40.txt', '2026-10-01T01:40:00.000Z'],
    ['20261001_1040.srt', '2026-10-01T01:40:00.000Z'],
    ['2026-10-01T10:40.json', '2026-10-01T01:40:00.000Z'],
    ['lecture 2026-10-01 10.40.md', '2026-10-01T01:40:00.000Z'],
    ['2026年10月1日 10時40分.txt', '2026-10-01T01:40:00.000Z'],
    ['2026-10-01.vtt', '2026-09-30T15:00:00.000Z'],
    ['20261001.txt', '2026-09-30T15:00:00.000Z'],
    ['第3回.vtt', undefined],
    ['2026-13-01.vtt', undefined],
  ])('%s -> %s', (name, expected) => {
    expect(recordedAtFromFileName(name, TZ)).toBe(expected);
  });

  it('uses the timezone given', () => {
    expect(recordedAtFromFileName('2026-10-01 10-40.vtt', 'UTC')).toBe('2026-10-01T10:40:00.000Z');
  });

  it('findLocalDateTime only takes a time that directly follows the date', () => {
    expect(findLocalDateTime('2026-10-01 第2回 10-40')).toEqual({ date: '2026-10-01' });
    expect(findLocalDateTime('x 2026/10/01 9:05:30 y')).toEqual({
      date: '2026-10-01',
      time: '09:05',
    });
  });

  it('parseDateTimeText handles offsets and local forms', () => {
    expect(parseDateTimeText('2026-10-01T10:40:00+09:00', TZ)).toBe('2026-10-01T01:40:00.000Z');
    expect(parseDateTimeText('2026-10-01 10:40', TZ)).toBe('2026-10-01T01:40:00.000Z');
    expect(parseDateTimeText('someday', TZ)).toBeUndefined();
    expect(localDateOf('2026-09-30T15:30:00.000Z', TZ)).toBe('2026-10-01');
  });
});

describe('TranscriptImporter', () => {
  const importer = defaultTranscriptImporter;

  it('lists its formats and detects by extension and by WEBVTT content', () => {
    expect(importer.extensions.sort()).toEqual([
      'json',
      'markdown',
      'md',
      'srt',
      'text',
      'txt',
      'vtt',
    ]);
    expect(importer.detect('a.TXT')?.id).toBe('txt');
    expect(importer.detect('a.vtt')?.id).toBe('vtt');
    expect(importer.detect('transcript.txt', 'WEBVTT\n\n')?.id).toBe('vtt');
    expect(importer.detect('a.docx')).toBeUndefined();
    expect(importer.detect('a.docx', undefined, 'srt')?.id).toBe('srt');
  });

  it('rejects unknown formats and unparsable files with ValidationError', () => {
    expect(() => importer.parse('a.docx', 'x')).toThrow(/Unsupported transcript format/);
    expect(() => importer.parse('a.json', '{nope')).toThrow(/Cannot parse a\.json/);
    expect(() => importer.toPayload({ fileName: 'a.txt', content: '\n\n' })).toThrow(
      /No transcript segments/,
    );
  });

  it('builds a transcript.file payload', () => {
    const p = importer.toPayload({
      fileName: '2026-10-01 10-40.vtt',
      content: VTT_LECTURE,
      timezone: TZ,
      mtime: new Date('2026-10-05T00:00:00Z'),
      folderHint: 'データベースシステム論',
    });
    expect(p).toMatchObject({
      fileName: '2026-10-01 10-40.vtt',
      format: 'vtt',
      title: '2026-10-01 10-40',
      recordedAt: '2026-10-01T01:40:00.000Z',
      courseHint: 'データベースシステム論',
      language: 'ja',
      durationMs: 3_725_000,
      importer: 'chatgpt-record',
      hasTimestamps: true,
    });
    expect(p.segments).toHaveLength(4);
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recordedAt priority: option > content > file name > mtime > now', () => {
    const content = '日時: 2026-10-02 09:00\n[00:00:01] はい';
    const base = {
      fileName: '2026-10-03 11-00.txt',
      content,
      timezone: TZ,
      mtime: new Date('2026-10-09T00:00:00Z'),
    };
    expect(importer.toPayload(base).recordedAt).toBe('2026-10-02T00:00:00.000Z'); // content
    expect(importer.toPayload({ ...base, content: '[00:00:01] はい' }).recordedAt).toBe(
      '2026-10-03T02:00:00.000Z',
    ); // file name
    expect(
      importer.toPayload({ ...base, fileName: 'memo.txt', content: '[00:00:01] はい' }).recordedAt,
    ).toBe('2026-10-09T00:00:00.000Z'); // mtime
    expect(
      importer.toPayload({
        fileName: 'memo.txt',
        content: '[00:00:01] はい',
        now: new Date('2026-10-10T00:00:00Z'),
      }).recordedAt,
    ).toBe('2026-10-10T00:00:00.000Z'); // now
    expect(
      importer.toPayload({ ...base, options: { date: '2026-11-05T10:00:00+09:00' } }).recordedAt,
    ).toBe('2026-11-05T01:00:00.000Z'); // explicit
  });

  it('a date-only option keeps the known time of day for the same day', () => {
    const p = importer.toPayload({
      fileName: '2026-10-01 10-40.vtt',
      content: VTT_LECTURE,
      timezone: TZ,
      options: { date: '2026-10-01' },
    });
    expect(p.recordedAt).toBe('2026-10-01T01:40:00.000Z');
    const other = importer.toPayload({
      fileName: '2026-10-01 10-40.vtt',
      content: VTT_LECTURE,
      timezone: TZ,
      options: { date: '2026-10-08' },
    });
    expect(other.recordedAt).toBe('2026-10-07T15:00:00.000Z');
  });

  it('course hint priority: option > header > folder; title option wins', () => {
    const base = {
      fileName: 'a.txt',
      content: TXT_LECTURE,
      timezone: TZ,
      folderHint: 'フォルダ名',
    };
    expect(importer.toPayload(base).courseHint).toBe('データベースシステム論'); // header
    expect(importer.toPayload({ ...base, options: { courseHint: '指定' } }).courseHint).toBe(
      '指定',
    );
    expect(importer.toPayload({ ...base, content: '[00:00:01] はい' }).courseHint).toBe(
      'フォルダ名',
    );
    expect(
      importer.toPayload({ ...base, content: '[00:00:01] はい', folderHint: undefined }).courseHint,
    ).toBeUndefined();
    expect(importer.toPayload({ ...base, options: { title: '手動タイトル' } }).title).toBe(
      '手動タイトル',
    );
    expect(importer.toPayload(base).title).toBe('第3回 正規化');
  });

  it('supports registering additional formats and importer ids', () => {
    const custom: TranscriptFormat = {
      id: 'zoomchat',
      extensions: ['chat'],
      importer: 'zoom',
      parse: (content) => ({
        segments: content
          .split('\n')
          .filter(Boolean)
          .map((text, i) => ({ startMs: i * 1000, text })),
        hasTimestamps: true,
      }),
    };
    const imp = new TranscriptImporter().register(custom);
    const p = imp.toPayload({
      fileName: 'meeting.chat',
      content: 'a\nb',
      now: new Date('2026-10-01T00:00:00Z'),
    });
    expect(p).toMatchObject({ format: 'zoomchat', importer: 'zoom', durationMs: 1000 });
    expect(imp.extensions).toContain('chat');
  });
});
