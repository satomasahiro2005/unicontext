import { describe, expect, it } from 'vitest';
import {
  formatTimestamp,
  jsonFormat,
  mdFormat,
  parseTimestampMs,
  srtFormat,
  txtFormat,
  vttFormat,
} from '../src/index.js';
import { SRT_LECTURE, TXT_LECTURE, VTT_LECTURE, WHISPER_JSON } from './helpers.js';

const opts = { timezone: 'Asia/Tokyo' };

describe('timestamps', () => {
  it('parses hh:mm:ss, mm:ss and fractions', () => {
    expect(parseTimestampMs('00:01:23')).toBe(83_000);
    expect(parseTimestampMs('1:23')).toBe(83_000);
    expect(parseTimestampMs('01:02:03.250')).toBe(3_723_250);
    expect(parseTimestampMs('00:00:01,5')).toBe(1_500);
    expect(parseTimestampMs('00:61')).toBeUndefined();
    expect(parseTimestampMs('abc')).toBeUndefined();
  });
  it('formats HH:MM:SS', () => {
    expect(formatTimestamp(42_000)).toBe('00:00:42');
    expect(formatTimestamp(3_723_250)).toBe('01:02:03');
    expect(formatTimestamp(100 * 3_600_000)).toBe('100:00:00');
  });
});

describe('txt parser', () => {
  it('reads [hh:mm:ss] lines with speakers, continuation lines and header lines', () => {
    const r = txtFormat.parse(TXT_LECTURE, opts);
    expect(r.courseHint).toBe('データベースシステム論');
    expect(r.title).toBe('第3回 正規化');
    expect(r.hasTimestamps).toBe(true);
    expect(r.segments).toEqual([
      { startMs: 5000, speaker: '先生', text: '今日は正規化について説明します。' },
      { startMs: 30_000, text: 'レポートは10月15日23時59分までに提出してください。' },
      { startMs: 70_000, speaker: 'Speaker 1', text: '質問です。第3正規形とは何ですか。' },
    ]);
  });

  it('supports hh:mm:ss, mm:ss and "Speaker N (hh:mm:ss):" prefixes', () => {
    const r = txtFormat.parse(
      [
        '00:00:10 最初の発言です',
        '1:05 - 二番目の発言です',
        'Speaker 2 (00:02:03): 三番目の発言です',
        '[3:00] 四番目',
      ].join('\n'),
      opts,
    );
    expect(r.segments).toEqual([
      { startMs: 10_000, text: '最初の発言です' },
      { startMs: 65_000, text: '二番目の発言です' },
      { startMs: 123_000, speaker: 'Speaker 2', text: '三番目の発言です' },
      { startMs: 180_000, text: '四番目' },
    ]);
  });

  it('supports the "Speaker 1  00:01:23" header-line layout', () => {
    const r = txtFormat.parse(
      'Speaker 1  00:01:23\nこんにちは。\n今日は晴れです。\n\nSpeaker 2  00:01:40\nはい',
      opts,
    );
    expect(r.segments).toEqual([
      { startMs: 83_000, speaker: 'Speaker 1', text: 'こんにちは。今日は晴れです。' },
      { startMs: 100_000, speaker: 'Speaker 2', text: 'はい' },
    ]);
  });

  it('plain text without timestamps becomes one segment per line at 0', () => {
    const r = txtFormat.parse('先生: こんにちは\n次の行です\n', opts);
    expect(r.hasTimestamps).toBe(false);
    expect(r.segments).toEqual([
      { startMs: 0, speaker: '先生', text: 'こんにちは' },
      { startMs: 0, text: '次の行です' },
    ]);
  });

  it('joins latin continuation lines with a space and handles CRLF', () => {
    const r = txtFormat.parse('[00:00:01] first line\r\nsecond line\r\n', opts);
    expect(r.segments).toEqual([{ startMs: 1000, text: 'first line second line' }]);
  });

  it('reads recording date and language from headers', () => {
    const r = txtFormat.parse(
      '[course: 線形代数]\n日時: 2026-10-01 10:40\nlanguage: ja\n[00:00:01] はい',
      opts,
    );
    expect(r.courseHint).toBe('線形代数');
    expect(r.recordedAt).toBe('2026-10-01T01:40:00.000Z');
    expect(r.language).toBe('ja');
    expect(r.segments).toHaveLength(1);
  });

  it('does not mistake sentences with a colon for speakers', () => {
    const r = txtFormat.parse('[00:00:01] 注意: 来週は休講です\n[00:00:09] 例: 次回までに', opts);
    expect(r.segments.map((s) => s.text)).toEqual(['注意: 来週は休講です', '例: 次回までに']);
    expect(r.segments.every((s) => s.speaker === undefined)).toBe(true);
  });
});

describe('md parser', () => {
  it('takes the first heading as the title, strips bullets/bold and reads front matter', () => {
    const md = [
      '---',
      'course: データベースシステム論',
      'date: 2026-10-01',
      '---',
      '# 第3回 講義メモ',
      '',
      '- **先生** (00:00:05): 始めます',
      '- [00:00:20] レポートは来週まで',
      '## 質疑',
      '> 00:01:00 質問です',
    ].join('\n');
    const r = mdFormat.parse(md, opts);
    expect(r.title).toBe('第3回 講義メモ');
    expect(r.courseHint).toBe('データベースシステム論');
    expect(r.recordedAt).toBe('2026-09-30T15:00:00.000Z');
    expect(r.segments).toEqual([
      { startMs: 5000, speaker: '先生', text: '始めます' },
      { startMs: 20_000, text: 'レポートは来週まで' },
      { startMs: 60_000, text: '質問です' },
    ]);
  });
});

describe('vtt parser', () => {
  it('reads cues, voice tags, language and ignores NOTE blocks and markup', () => {
    const r = vttFormat.parse(VTT_LECTURE, opts);
    expect(r.language).toBe('ja');
    expect(r.hasTimestamps).toBe(true);
    expect(r.segments).toEqual([
      { startMs: 1000, endMs: 4000, speaker: '先生', text: '今日はレポートについて話します。' },
      { startMs: 4500, endMs: 7000, speaker: '先生', text: 'レポートは10月15日' },
      { startMs: 7000, endMs: 10_000, speaker: '先生', text: '23時59分までに提出してください。' },
      { startMs: 3_723_250, endMs: 3_725_000, speaker: '学生', text: 'ありがとうございます' },
    ]);
  });

  it('handles mm:ss cues, multi-line cues and cue settings', () => {
    const r = vttFormat.parse(
      'WEBVTT - 講義\n\n00:01.500 --> 00:03.000 align:start\nline one\nline two\n',
      opts,
    );
    expect(r.title).toBe('講義');
    expect(r.segments).toEqual([{ startMs: 1500, endMs: 3000, text: 'line one line two' }]);
  });

  it('splits Zoom-style "Name: text" cues into speakers', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:01.000 --> 00:00:02.000',
      'Taro Yamada: Hello everyone',
      '',
      '2',
      '00:00:03.000 --> 00:00:04.000',
      'Hanako Sato: Hi there',
      '',
      '3',
      '00:00:05.000 --> 00:00:06.000',
      'Taro Yamada: Let us start',
    ].join('\n');
    const r = vttFormat.parse(vtt, opts);
    expect(r.segments.map((s) => [s.speaker, s.text])).toEqual([
      ['Taro Yamada', 'Hello everyone'],
      ['Hanako Sato', 'Hi there'],
      ['Taro Yamada', 'Let us start'],
    ]);
  });
});

describe('srt parser', () => {
  it('reads numbered cues with comma milliseconds and strips list dashes', () => {
    const r = srtFormat.parse(SRT_LECTURE, opts);
    expect(r.segments).toEqual([
      { startMs: 1000, endMs: 4000, text: '今日はER図について説明します。' },
      { startMs: 5500, endMs: 9000, text: '来週の金曜日までに課題を出してください。' },
    ]);
  });

  it('handles CRLF and BOM', () => {
    const r = srtFormat.parse('\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nはい\r\n', opts);
    expect(r.segments).toEqual([{ startMs: 1000, endMs: 2000, text: 'はい' }]);
  });
});

describe('json parser', () => {
  it('reads Whisper-style segments in seconds plus metadata', () => {
    const r = jsonFormat.parse(WHISPER_JSON, opts);
    expect(r.language).toBe('ja');
    expect(r.segments).toEqual([
      { startMs: 0, endMs: 4500, text: '今日は始めます。' },
      { startMs: 4500, endMs: 9250, text: 'レポートは10月15日23時59分までです。' },
    ]);
  });

  it('reads a bare array with start/end/text/speaker', () => {
    const r = jsonFormat.parse(
      JSON.stringify([
        { start: 1, end: 2.5, text: 'one', speaker: 'A' },
        { start: '00:00:03', end: '00:00:04.5', text: 'two' },
      ]),
      opts,
    );
    expect(r.segments).toEqual([
      { startMs: 1000, endMs: 2500, speaker: 'A', text: 'one' },
      { startMs: 3000, endMs: 4500, text: 'two' },
    ]);
  });

  it('reads {transcript:[{startMs,...}]} and {segments:[{start_time,...}]}', () => {
    const a = jsonFormat.parse(
      JSON.stringify({ transcript: [{ startMs: 1500, endMs: 2500, text: 'a', speaker: 'S1' }] }),
      opts,
    );
    expect(a.segments).toEqual([{ startMs: 1500, endMs: 2500, speaker: 'S1', text: 'a' }]);
    const b = jsonFormat.parse(
      JSON.stringify({ segments: [{ start_time: 2, end_time: 3, text: 'b' }] }),
      opts,
    );
    expect(b.segments).toEqual([{ startMs: 2000, endMs: 3000, text: 'b' }]);
  });

  it('treats large integers as milliseconds', () => {
    const r = jsonFormat.parse(
      JSON.stringify({
        items: [
          { start: 120000, end: 125000, content: 'x' },
          { start: 130000, text: 'y' },
        ],
      }),
      opts,
    );
    expect(r.segments.map((s) => s.startMs)).toEqual([120_000, 130_000]);
    expect(r.segments[0]?.endMs).toBe(125_000);
  });

  it('finds nested arrays, words, durations and top-level metadata', () => {
    const r = jsonFormat.parse(
      JSON.stringify({
        title: '第2回',
        course: '線形代数',
        recordedAt: '2026-10-02T09:00:00+09:00',
        result: {
          utterances: [
            { begin: 1, duration: 2, words: [{ word: 'こんにちは' }, { word: '世界' }] },
          ],
        },
      }),
      opts,
    );
    expect(r.title).toBe('第2回');
    expect(r.courseHint).toBe('線形代数');
    expect(r.recordedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(r.segments).toEqual([{ startMs: 1000, endMs: 3000, text: 'こんにちは世界' }]);
  });

  it('sorts timestamped segments and treats plain {text} as one untimed segment', () => {
    const r = jsonFormat.parse(
      JSON.stringify([
        { start: 5, text: 'b' },
        { start: 1, text: 'a' },
      ]),
      opts,
    );
    expect(r.segments.map((s) => s.text)).toEqual(['a', 'b']);
    const plain = jsonFormat.parse(JSON.stringify({ text: '全文だけ' }), opts);
    expect(plain.hasTimestamps).toBe(false);
    expect(plain.segments).toEqual([{ startMs: 0, text: '全文だけ' }]);
  });

  it('rejects invalid JSON', () => {
    expect(() => jsonFormat.parse('{nope', opts)).toThrow();
  });
});
