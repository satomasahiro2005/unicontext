import { describe, expect, it } from 'vitest';
import {
  drivePath,
  extractRoomChange,
  graphDatePart,
  graphDateTimeToIso,
  localMidnightIso,
  looksLikeQuestion,
  materialKindFor,
  parseTeamName,
  stripHtml,
  threadSubject,
} from '../src/index.js';

describe('parseTeamName', () => {
  it('parses 「yyyy年度（科目・クラス名等）」', () => {
    expect(parseTeamName('2026年度（データベースシステム論・1クラス）')).toEqual({
      title: 'データベースシステム論',
      academicYear: 2026,
      className: '1クラス',
      structured: true,
    });
  });

  it('keeps 「・」 inside the subject when the last segment is not a class marker', () => {
    const p = parseTeamName('２０２６年度（情報・通信工学概論）');
    expect(p.title).toBe('情報・通信工学概論');
    expect(p.academicYear).toBe(2026);
    expect(p.className).toBeUndefined();
  });

  it('accepts half-width parentheses and A/B class names', () => {
    expect(parseTeamName('2025年度(線形代数学I・A)')).toMatchObject({
      title: '線形代数学I',
      className: 'A',
      academicYear: 2025,
    });
  });

  it('uses the display name for anything else', () => {
    expect(parseTeamName('情報科学基礎演習 自主ゼミ')).toEqual({
      title: '情報科学基礎演習 自主ゼミ',
      structured: false,
    });
  });
});

describe('graphDateTimeToIso', () => {
  it('treats UTC (Prefer outlook.timezone="UTC") as Z', () => {
    expect(graphDateTimeToIso({ dateTime: '2026-10-05T01:20:00.0000000', timeZone: 'UTC' })).toBe(
      '2026-10-05T01:20:00.000Z',
    );
  });
  it('converts Windows time zone names with an offset', () => {
    expect(
      graphDateTimeToIso({
        dateTime: '2026-10-05T10:20:00.0000000',
        timeZone: 'Tokyo Standard Time',
      }),
    ).toBe('2026-10-05T10:20:00+09:00');
  });
  it('converts IANA names and honours an explicit offset in the value', () => {
    expect(graphDateTimeToIso({ dateTime: '2026-10-05T10:20:00', timeZone: 'Asia/Tokyo' })).toBe(
      '2026-10-05T10:20:00+09:00',
    );
    expect(graphDateTimeToIso({ dateTime: '2026-10-05T10:20:00+09:00' })).toBe(
      '2026-10-05T01:20:00.000Z',
    );
  });
  it('returns undefined for unknown zones and garbage', () => {
    expect(
      graphDateTimeToIso({ dateTime: '2026-10-05T10:20:00', timeZone: 'Mars/Olympus' }),
    ).toBeUndefined();
    expect(graphDateTimeToIso({ dateTime: 'soon', timeZone: 'UTC' })).toBeUndefined();
  });
  it('helpers for all-day events', () => {
    expect(graphDatePart({ dateTime: '2026-10-12T00:00:00.0000000' })).toBe('2026-10-12');
    expect(localMidnightIso('2026-10-12', 'Asia/Tokyo')).toBe('2026-10-12T00:00:00+09:00');
  });
});

describe('text helpers', () => {
  it('strips Teams HTML, decodes entities and keeps line breaks', () => {
    expect(
      stripHtml(
        '<p>A&amp;B &lt;1&gt;</p><p>教室を<at id="0">山田</at>へ<br>変更&nbsp;します</p><attachment id="x"></attachment>',
      ),
    ).toBe('A&B <1>\n教室を山田へ\n変更 します');
  });
  it('detects questions', () => {
    expect(looksLikeQuestion('いつですか？')).toBe(true);
    expect(looksLikeQuestion('When is it? ')).toBe(true);
    expect(looksLikeQuestion('ありがとうございます')).toBe(false);
  });
  it('normalizes mail subjects for threading', () => {
    expect(threadSubject('RE: Re: レポート課題')).toBe('レポート課題');
    expect(threadSubject('転送：お知らせ')).toBe('お知らせ');
    expect(threadSubject(null)).toBe('(件名なし)');
  });
});

describe('extractRoomChange', () => {
  it('教室を…に変更', () => {
    const r = extractRoomChange(
      '来週の授業について連絡します。\n教室を11教室に変更します。\n教科書を持参してください。',
    );
    expect(r?.room).toBe('11教室');
    expect(r?.sentence).toBe('教室を11教室に変更します。');
  });
  it('…教室で行います', () => {
    expect(extractRoomChange('本日の授業は21教室で行います。')?.room).toBe('21教室');
  });
  it('…教室に変更になりました (full-width digits are normalized)', () => {
    expect(extractRoomChange('授業は１２教室に変更になりました')?.room).toBe('12教室');
  });
  it('教室を201に変更', () => {
    expect(extractRoomChange('教室を201に変更します')?.room).toBe('201');
  });
  it('ignores unrelated text', () => {
    expect(
      extractRoomChange('教科書を持参してください。教室の場所は変わりません。'),
    ).toBeUndefined();
    expect(extractRoomChange('オンラインで行います')).toBeUndefined();
  });
});

describe('drive helpers', () => {
  it('material kind by extension', () => {
    expect(materialKindFor('a.pptx')).toBe('slides');
    expect(materialKindFor('a.KEY')).toBe('slides');
    expect(materialKindFor('a.pdf')).toBe('handout');
    expect(materialKindFor('a.docx')).toBe('other');
    expect(materialKindFor('noext', 'application/pdf')).toBe('handout');
  });
  it('path from parentReference', () => {
    expect(drivePath('/drive/root:/授業/データベース', '配布資料.pdf')).toBe(
      '/授業/データベース/配布資料.pdf',
    );
    expect(drivePath('/drive/root:', 'メモ.docx')).toBe('/メモ.docx');
    expect(drivePath(undefined, 'x.txt')).toBe('/x.txt');
  });
});
