import { describe, expect, it } from 'vitest';
import { periodLabel, safeHttpUrl, tightenJa, truncate } from '../src/lib/text.js';

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
