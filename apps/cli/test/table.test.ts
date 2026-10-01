import { describe, expect, it } from 'vitest';
import { colorEnabled, createStyle } from '../src/format/style.js';
import {
  charWidth,
  displayWidth,
  padEnd,
  padStart,
  renderTable,
  sanitizeText,
  stripAnsi,
  truncate,
} from '../src/format/table.js';

describe('displayWidth', () => {
  it('counts ASCII as 1 and Japanese as 2 columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('データ')).toBe(6);
    expect(displayWidth('DB論')).toBe(4);
    expect(displayWidth('1限')).toBe(3);
  });

  it('treats full-width forms and CJK punctuation as wide, half-width katakana as narrow', () => {
    expect(displayWidth('ＡＢ')).toBe(4);
    expect(displayWidth('「」')).toBe(4);
    expect(displayWidth('ｱｲｳ')).toBe(3);
    expect(charWidth('ー'.codePointAt(0) ?? 0)).toBe(2);
  });

  it('gives combining marks and zero-width characters no width', () => {
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('a​b')).toBe(2);
  });

  it('ignores ANSI colour codes', () => {
    const red = createStyle(true).red('競合');
    expect(red).not.toBe('競合');
    expect(displayWidth(red)).toBe(4);
    expect(stripAnsi(red)).toBe('競合');
  });
});

describe('padEnd / padStart / truncate', () => {
  it('pads by display width', () => {
    expect(padEnd('教室', 8)).toBe('教室    ');
    expect(displayWidth(padEnd('教室', 8))).toBe(8);
    expect(padStart('21', 5)).toBe('   21');
    expect(padEnd('long text', 3)).toBe('long text');
  });

  it('truncates with an ellipsis without splitting a wide character', () => {
    expect(truncate('データベースシステム論', 11)).toBe('データベー…');
    expect(displayWidth(truncate('データベースシステム論', 11))).toBeLessThanOrEqual(11);
    expect(truncate('データベース', 6)).toBe('データベース'.slice(0, 2) + '…');
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 0)).toBe('');
  });
});

describe('renderTable', () => {
  it('aligns Japanese columns so every row has the same display width', () => {
    const rows = [
      { a: '線形代数学II', b: '共通教育A棟301' },
      { a: 'DB', b: '21教室' },
    ];
    const lines = renderTable(
      [
        { header: '科目', value: (r: (typeof rows)[number]) => r.a },
        { header: '教室', value: (r: (typeof rows)[number]) => r.b },
      ],
      rows,
    );
    expect(lines).toHaveLength(4);
    const header = lines[0] ?? '';
    const row1 = lines[2] ?? '';
    expect(displayWidth(header.slice(0, header.indexOf('教室')))).toBe(
      displayWidth(row1.slice(0, row1.indexOf('共通教育A棟301'))),
    );
    expect(lines[1]).toMatch(/^-+ {2}-+$/);
  });

  it('truncates columns with max and right-aligns numbers', () => {
    const lines = renderTable(
      [
        { header: '内容', value: (r: [string, number]) => r[0], max: 8 },
        { header: '件数', value: (r: [string, number]) => String(r[1]), align: 'right' },
      ],
      [
        ['とても長い内容の文字列', 3],
        ['短い', 120],
      ],
    );
    expect(lines[2]).toContain('…');
    expect(displayWidth((lines[2] ?? '').split('  ')[0] ?? '')).toBeLessThanOrEqual(8);
    expect(lines[3]?.endsWith('120')).toBe(true);
    expect(lines[2]?.endsWith('  3')).toBe(true);
  });

  it('strips control characters so source text cannot inject terminal escapes', () => {
    expect(sanitizeText('本日\u001b[31m赤\nの\r\n教室変更')).toBe('本日 [31m赤 の 教室変更');
    const [, , row] = renderTable(
      [{ header: 'x', value: (s: string) => s }],
      ['a\u001b]0;evil\u0007b'],
    );
    expect(row).not.toContain('\u001b');
    expect(row).not.toContain('\u0007');
  });

  it('applies styles after padding', () => {
    const style = createStyle(true);
    const lines = renderTable(
      [{ header: '状態', value: (s: string) => s, style: (padded) => style.red(padded) }],
      ['競合'],
    );
    expect(displayWidth(lines[2] ?? '')).toBe(4);
    expect(lines[2]).toContain('\u001b[31m');
  });
});

describe('colours', () => {
  it('are off without a TTY and with NO_COLOR, on otherwise', () => {
    expect(colorEnabled(false, {})).toBe(false);
    expect(colorEnabled(true, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled(true, { NO_COLOR: '' })).toBe(true);
    expect(colorEnabled(true, { TERM: 'dumb' })).toBe(false);
    expect(colorEnabled(true, {})).toBe(true);
    expect(createStyle(false).red('x')).toBe('x');
  });
});
