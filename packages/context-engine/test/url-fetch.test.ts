import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUniContext,
  fetchPublicUrl,
  isHttpUrl,
  isNonPublicAddress,
  readDocument,
  resolveDocument,
  UrlFetchError,
} from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('links opened as public web files', () => {
  it('recognises http(s) links only', () => {
    expect(isHttpUrl('https://wwp.shizuoka.ac.jp/a.pdf')).toBe(true);
    expect(isHttpUrl('http://example.com/')).toBe(true);
    expect(isHttpUrl('document:abc')).toBe(false);
    expect(isHttpUrl('file:///C:/x.pdf')).toBe(false);
    expect(isHttpUrl('情報学/資料/a.pdf')).toBe(false);
  });

  it('never reaches this computer, the home network or the tailnet', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.20.1.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.77.178.77',
      '0.0.0.0',
      '::1',
      'fd7a:115c:a1e0::1',
      'fe80::1',
      '::ffff:192.168.0.1',
    ])
      expect(isNonPublicAddress(ip), ip).toBe(true);
    for (const ip of ['133.70.1.1', '8.8.8.8', '2606:4700::6810:85e5'])
      expect(isNonPublicAddress(ip), ip).toBe(false);
  });

  it('refuses private addresses before any request, also after a redirect', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8787/api' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPublicUrl('http://192.168.1.1/admin')).rejects.toBeInstanceOf(UrlFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fetchPublicUrl('http://localhost:8787/')).rejects.toBeInstanceOf(UrlFetchError);
    await expect(fetchPublicUrl('http://8.8.8.8/x.pdf')).rejects.toBeInstanceOf(UrlFetchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the bytes with a file name the renderer understands', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body><p>説明会は10月15日です</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      ),
    );
    const r = await fetchPublicUrl('http://8.8.8.8/careersupport/');
    expect(r.fileName).toBe('careersupport.html');
    expect(r.mimeType).toBe('text/html');

    const uc = createUniContext();
    try {
      const read = await readDocument(resolveDocument(uc, 'http://8.8.8.8/careersupport/'));
      expect(read.unsupported).toBeUndefined();
      expect(read.document.title).toBe('careersupport.html');
      expect(read.pages.map((p) => p.text).join('\n')).toContain('説明会は10月15日です');
    } finally {
      await uc.close();
    }
  });

  it('get_document on a private link says why instead of asking the student', async () => {
    const uc = createUniContext();
    try {
      const read = await readDocument(resolveDocument(uc, 'http://10.0.0.1/x.pdf'));
      expect(read.unsupported?.reason).toMatch(/家のネットワーク/);
    } finally {
      await uc.close();
    }
  });
});
