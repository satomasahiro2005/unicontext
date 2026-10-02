import { describe, expect, it } from 'vitest';
import {
  formatFileSize,
  linkifyText,
  periodLabel,
  safeHttpUrl,
  tightenJa,
  truncate,
} from '../src/lib/text.js';

describe('periodLabel', () => {
  it('writes N限 without a space', () => {
    expect(periodLabel(2)).toBe('2限');
    expect(periodLabel(5)).toBe('5限');
  });
  it('has a neutral label for unknown periods', () => {
    expect(periodLabel(undefined)).toBe('時限未定');
    expect(periodLabel(Number.NaN)).toBe('時限未定');
  });
});

describe('safeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(safeHttpUrl('https://example.ac.jp/a?b=1')).toBe('https://example.ac.jp/a?b=1');
    expect(safeHttpUrl('http://localhost:8080/x')).toBe('http://localhost:8080/x');
  });
  it('rejects javascript:, data:, file: and relative URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('  JavaScript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('data:text/html,<script>1</script>')).toBeUndefined();
    expect(safeHttpUrl('file:///etc/passwd')).toBeUndefined();
    expect(safeHttpUrl('/relative/path')).toBeUndefined();
  });
  it('rejects empty and malformed values', () => {
    expect(safeHttpUrl(undefined)).toBeUndefined();
    expect(safeHttpUrl('')).toBeUndefined();
    expect(safeHttpUrl('http://')).toBeUndefined();
  });
});

describe('tightenJa', () => {
  it('removes spaces between Japanese and alphanumerics', () => {
    expect(tightenJa('Teams の通知')).toBe('Teamsの通知');
    expect(tightenJa('10月 8日の締切')).toBe('10月8日の締切');
    expect(tightenJa('第 2 回')).toBe('第2回');
  });
  it('keeps spaces between ASCII words and between Japanese words', () => {
    expect(tightenJa('10/1 09:42')).toBe('10/1 09:42');
    expect(tightenJa('Lecture 3.pdf')).toBe('Lecture 3.pdf');
    expect(tightenJa('山田 太郎')).toBe('山田 太郎');
  });
});

describe('truncate', () => {
  it('cuts by characters and adds an ellipsis', () => {
    expect(truncate('あいうえお', 3)).toBe('あいう…');
    expect(truncate('あい', 3)).toBe('あい');
  });
});

describe('linkifyText', () => {
  it('keeps line breaks and splits http(s) URLs out of the text', () => {
    expect(linkifyText('詳細は https://example.com/a?b=1 を参照\n次の行')).toEqual([
      { type: 'text', text: '詳細は ' },
      { type: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { type: 'text', text: ' を参照\n次の行' },
    ]);
  });
  it('stops at Japanese characters and drops trailing punctuation', () => {
    const segs = linkifyText('(https://example.com/x). https://example.com/y。');
    expect(segs.filter((s) => s.type === 'link').map((s) => s.text)).toEqual([
      'https://example.com/x',
      'https://example.com/y',
    ]);
    expect(segs.map((s) => s.text).join('')).toBe(
      '(https://example.com/x). https://example.com/y。',
    );
  });
  it('never links other schemes and returns plain text unchanged', () => {
    expect(linkifyText('javascript:alert(1) <b>x</b>')).toEqual([
      { type: 'text', text: 'javascript:alert(1) <b>x</b>' },
    ]);
    expect(linkifyText('')).toEqual([]);
  });
});

describe('formatFileSize', () => {
  it('formats sizes without a space before the unit', () => {
    expect(formatFileSize(512)).toBe('512B');
    expect(formatFileSize(1536)).toBe('1.5KB');
    expect(formatFileSize(20 * 1024)).toBe('20KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0MB');
    expect(formatFileSize(-1)).toBe('');
  });
});
