import { describe, expect, it } from 'vitest';
import {
  chunkMarkdown,
  chunkText,
  compileGlobs,
  decodeText,
  extractContent,
  htmlToText,
  inferCourseFolder,
  academicYearFromFolder,
  matchesExclude,
  matchesInclude,
  parseDateFromName,
  DEFAULT_EXCLUDE,
  DEFAULT_TERM_FOLDER_PATTERN,
} from '../src/index.js';
import { makeDocx, makePdf, makePng, makePptx } from './helpers.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('text extraction', () => {
  it('reads utf-8 and strips the BOM', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('こんにちは\nworld')]);
    expect((await extractContent(bom, 'txt')).text).toBe('こんにちは\nworld');
    expect(decodeText(bom).charCodeAt(0)).not.toBe(0xfeff);
  });

  it('falls back to Shift_JIS for non utf-8 bytes', () => {
    // 「データ」 in Shift_JIS
    const sjis = new Uint8Array([0x83, 0x66, 0x81, 0x5b, 0x83, 0x5e]);
    expect(decodeText(sjis)).toBe('データ');
  });

  it('reads UTF-16LE with BOM', () => {
    const body = Buffer.from('abc日本', 'utf16le');
    expect(decodeText(new Uint8Array([0xff, 0xfe, ...body]))).toBe('abc日本');
  });

  it('treats markdown, csv and source code as text', async () => {
    expect((await extractContent(enc('# T\n\nbody'), 'md')).text).toBe('# T\n\nbody');
    expect((await extractContent(enc('a,b\n1,2\n'), 'csv')).text).toBe('a,b\n1,2');
    expect((await extractContent(enc('def f():\n    return 1\n'), 'py')).text).toContain('def f()');
  });

  it('strips tags, scripts and styles from HTML and decodes entities', async () => {
    const html =
      '<html><head><title>授業ページ</title><style>x{}</style></head><body><h1>DB</h1><p>A &amp; B &lt;3 &#x65E5;</p><script>alert(1)</script></body></html>';
    const text = (await extractContent(enc(html), 'html')).text ?? '';
    expect(text).toContain('授業ページ');
    expect(text).toContain('A & B <3 日');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('<h1>');
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });

  it('returns nothing for unknown binary types', async () => {
    expect(await extractContent(new Uint8Array([1, 2, 3]), 'bin')).toEqual({});
  });
});

describe('PDF / DOCX / PPTX / image extraction', () => {
  it('extracts text per page from a PDF', async () => {
    const res = await extractContent(makePdf(['Hello database', 'Second page text']), 'pdf');
    expect(res.pages).toHaveLength(2);
    expect(res.pages?.[0]).toEqual({ page: 1, text: 'Hello database' });
    expect(res.pages?.[1]?.text).toBe('Second page text');
  });

  it('throws on a corrupt PDF (caller turns it into a warning)', async () => {
    await expect(extractContent(enc('not a pdf'), 'pdf')).rejects.toThrow();
  });

  it('extracts raw text from a DOCX', async () => {
    const res = await extractContent(await makeDocx(['レポート本文', '第二段落']), 'docx');
    expect(res.text).toContain('レポート本文');
    expect(res.text).toContain('第二段落');
  });

  it('extracts PPTX slides in presentation order with titles and notes', async () => {
    const buf = await makePptx(
      [
        { title: 'First title', body: ['body one'], notes: 'speaker note' },
        { title: 'Second title', body: ['body two', 'A & B'] },
        { body: ['untitled slide'] },
      ],
      [2, 1, 3],
    );
    const res = await extractContent(buf, 'pptx');
    expect(res.slides?.map((s) => s.title)).toEqual(['Second title', 'First title', undefined]);
    expect(res.slides?.map((s) => s.slide)).toEqual([1, 2, 3]);
    expect(res.slides?.[0]?.text).toBe('Second title\nbody two\nA & B');
    expect(res.slides?.[1]?.notes).toBe('speaker note');
    expect(res.slides?.[1]?.notes).not.toContain('1');
    expect(res.slides?.[2]?.text).toBe('untitled slide');
  });

  it('reads image dimensions', async () => {
    const res = await extractContent(makePng(64, 32), 'png');
    expect(res.image).toEqual({ width: 64, height: 32 });
  });

  it('yields no image info for a corrupt image', async () => {
    expect((await extractContent(enc('nope'), 'jpg')).image).toBeUndefined();
  });
});

describe('globs', () => {
  const excl = compileGlobs(DEFAULT_EXCLUDE);
  it('excludes dotfiles, node_modules and Office lock files by default', () => {
    expect(matchesExclude('.hidden/a.txt', excl)).toBe(true);
    expect(matchesExclude('a/.git/config', excl)).toBe(true);
    expect(matchesExclude('a/node_modules/x/index.js', excl)).toBe(true);
    expect(matchesExclude('a/~$report.docx', excl)).toBe(true);
    expect(matchesExclude('a/report.docx', excl)).toBe(false);
  });
  it('supports include patterns on file names and relative paths', () => {
    const inc = compileGlobs(['*.pdf', 'notes/**/*.md']);
    expect(matchesInclude('a/b/x.PDF', inc)).toBe(true);
    expect(matchesInclude('notes/2026/week1.md', inc)).toBe(true);
    expect(matchesInclude('other/week1.md', inc)).toBe(false);
    expect(matchesInclude('anything', compileGlobs([]))).toBe(true);
  });
  it('anchored exclude patterns match parent folders', () => {
    const e = compileGlobs(['archive/old']);
    expect(matchesExclude('archive/old/a.txt', e)).toBe(true);
    expect(matchesExclude('x/archive/old/a.txt', e)).toBe(false);
  });
});

describe('course inference', () => {
  const termPattern = new RegExp(DEFAULT_TERM_FOLDER_PATTERN, 'i');
  const infer = (rel: string, depth = 1): ReturnType<typeof inferCourseFolder> =>
    inferCourseFolder(rel, { termPattern, depth });

  it('skips term folders and takes the course folder', () => {
    expect(infer('2026前期/データベースシステム論/第3回.pdf')).toEqual({
      courseFolder: 'データベースシステム論',
      termFolder: '2026前期',
    });
  });
  it.each(['2026前期', '2026-1', 'R8後期', '2026', '2026年度', '令和8年度', '2026_後期', '前期'])(
    'recognises term folder %s',
    (term) => {
      expect(infer(`${term}/線形代数/a.pdf`)).toEqual({
        courseFolder: '線形代数',
        termFolder: term,
      });
    },
  );
  it('does not mistake course names for terms', () => {
    expect(infer('Rust入門/a.pdf').courseFolder).toBe('Rust入門');
    expect(infer('データベース2/a.pdf').courseFolder).toBe('データベース2');
  });
  it('has no course for root-level or term-only files', () => {
    expect(infer('readme.txt')).toEqual({});
    expect(infer('2026前期/a.txt')).toEqual({ termFolder: '2026前期' });
  });
  it('honours courseFolderDepth', () => {
    expect(infer('2026前期/情報学部/DB論/a.pdf', 2).courseFolder).toBe('DB論');
  });
  it('derives academic years', () => {
    expect(academicYearFromFolder('2026前期')).toBe(2026);
    expect(academicYearFromFolder('2026-1')).toBe(2026);
    expect(academicYearFromFolder('R8後期')).toBe(2026);
    expect(academicYearFromFolder('令和7年度')).toBe(2025);
    expect(academicYearFromFolder('前期')).toBeUndefined();
  });
});

describe('file name dates', () => {
  it.each([
    ['slides 2026-10-01.pptx', '2026-10-01'],
    ['report_20261001.pdf', '2026-10-01'],
    ['2026年10月1日 講義.pdf', '2026-10-01'],
    ['2026.10.01.txt', '2026-10-01'],
    ['第3回.pdf', undefined],
    ['report_20261301.pdf', undefined],
    ['id12345678901.pdf', undefined],
  ])('%s -> %s', (name, expected) => {
    expect(parseDateFromName(name)).toBe(expected);
  });
  it('resolves 10月1日 with the academic or fallback year', () => {
    expect(parseDateFromName('10月1日.pdf', { fallbackYear: 2026 })).toBe('2026-10-01');
    expect(parseDateFromName('1月15日.pdf', { academicYear: 2026 })).toBe('2027-01-15');
    expect(parseDateFromName('10月1日.pdf')).toBeUndefined();
  });
});

describe('chunking', () => {
  it('returns nothing for empty text and one chunk for short text', () => {
    expect(chunkText('  \n ', 100, 10)).toEqual([]);
    expect(chunkText('short text', 100, 10)).toEqual(['short text']);
  });
  it('splits long text with overlap, preferring sentence ends', () => {
    const sentence = 'これは文です。';
    const text = sentence.repeat(60); // 420 chars
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.every((c) => c.endsWith('。'))).toBe(true);
    // overlap: the start of the next chunk occurs inside the previous one
    const second = chunks[1] ?? '';
    expect((chunks[0] ?? '').includes(second.slice(0, 5))).toBe(true);
    // everything is covered
    expect(chunks.join('').length).toBeGreaterThanOrEqual(text.length - 20 * chunks.length);
  });
  it('hard-splits text without break points', () => {
    const chunks = chunkText('x'.repeat(1000), 300, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
  });
  it('markdown chunks carry their heading', () => {
    const chunks = chunkMarkdown('# 概要\n\n本文A\n\n## 課題\n\n本文B', 1000, 50);
    expect(chunks.map((c) => c.heading)).toEqual(['概要', '課題']);
    expect(chunks[1]?.text).toContain('本文B');
  });
});
