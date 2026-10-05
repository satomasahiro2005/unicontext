import { createNormalizeContext, type RawItemView } from '@unicontext/connector-sdk';
import { silentLogger } from '@unicontext/core';
import { describe, expect, it } from 'vitest';
import {
  createShizuokaVpnFilesNormalizer,
  type FilePayload,
  type FileTextPayload,
} from '../src/index.js';

const SRC = 'shizuoka-vpn-files';
const ctx = createNormalizeContext({
  sourceId: SRC,
  sourceSystem: 'shizuoka-vpn-files',
  sourceLabel: 'VPNファイル共有',
  defaultAuthority: 'collaboration',
  timezone: 'Asia/Tokyo',
  now: new Date('2026-10-05T01:00:00Z'),
  logger: silentLogger,
});
const norm = createShizuokaVpnFilesNormalizer();
const view = (sourceType: string, payload: unknown): RawItemView =>
  ({ sourceType, externalId: 'x', payload }) as unknown as RawItemView;

function filePayload(over: Partial<FilePayload> = {}): FilePayload {
  return {
    root: 'fs-share',
    parent: 'class/2024コンピュータ入門（教員A）/資料',
    path: 'class/2024コンピュータ入門（教員A）/資料/第1回.pdf',
    name: '第1回.pdf',
    label: 'FS share / class / 2024コンピュータ入門（教員A） / 資料 / 第1回.pdf',
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    resourceId: 'resource_x',
    bookmark: 'FS share',
    dir: 'class/2024コンピュータ入門（教員A）/資料',
    version: 'ts|1024',
    listedAt: '2026-10-05T01:00:00.000Z',
    course: {
      coursePath: 'class/2024コンピュータ入門（教員A）',
      title: 'コンピュータ入門',
      year: 2024,
      teacher: '教員A',
    },
    prefetch: false,
    ...over,
  };
}

describe('shizuoka-vpn-files normalizer', () => {
  it('a folder item produces no canonical entity (kept raw for the browse tree)', async () => {
    const out = await norm.normalize(view('szvpn.folder', { root: 'fs-share', path: 'class', children: [] }), ctx);
    expect(out.entities).toHaveLength(0);
  });

  it('a file → document + material with the full path, and a best-effort course candidate', async () => {
    const out = await norm.normalize(view('szvpn.file', filePayload()), ctx);
    const doc = out.entities.find((e) => e.entity.kind === 'document');
    const mat = out.entities.find((e) => e.entity.kind === 'material');
    const offering = out.entities.find((e) => e.entity.kind === 'courseOffering');
    expect((doc?.entity as { path?: string }).path).toBe(
      '/class/2024コンピュータ入門（教員A）/資料/第1回.pdf',
    );
    expect((doc?.entity as { extra?: Record<string, unknown> }).extra?.platform).toBe('vpn-fs');
    expect(mat?.entity.kind).toBe('material');
    // The course candidate carries the parsed title + year so identity can PROPOSE a link.
    expect((offering?.entity as { title?: string }).title).toBe('コンピュータ入門');
    expect((offering?.entity as { academicYear?: number }).academicYear).toBe(2024);
    // The document is attributed to that candidate offering.
    expect((doc?.entity as { courseOfferingId?: string }).courseOfferingId).toBe(offering?.entity.id);
  });

  it('a file with no course hint stays visible with no course', async () => {
    const out = await norm.normalize(
      view('szvpn.file', filePayload({ course: null, path: 'class/共通/注意事項.pdf', parent: 'class/共通' })),
      ctx,
    );
    expect(out.entities.some((e) => e.entity.kind === 'courseOffering')).toBe(false);
    const doc = out.entities.find((e) => e.entity.kind === 'document');
    expect((doc?.entity as { courseOfferingId?: string }).courseOfferingId).toBeUndefined();
  });

  it('an explicit mapping to a known offering id attributes the file directly (no candidate)', async () => {
    const offeringId = 'courseOffering:abc123';
    const out = await norm.normalize(
      view(
        'szvpn.file',
        filePayload({
          course: { coursePath: 'class/x', title: 'x', explicitCourse: offeringId },
        }),
      ),
      ctx,
    );
    expect(out.entities.some((e) => e.entity.kind === 'courseOffering')).toBe(false);
    const doc = out.entities.find((e) => e.entity.kind === 'document');
    expect((doc?.entity as { courseOfferingId?: string }).courseOfferingId).toBe(offeringId);
  });

  it('file text → document chunks pointing at the same document id', async () => {
    const fileOut = await norm.normalize(view('szvpn.file', filePayload()), ctx);
    const docId = fileOut.entities.find((e) => e.entity.kind === 'document')!.entity.id;
    const text: FileTextPayload = {
      externalId: 'fs-share:class/2024コンピュータ入門（教員A）/資料/第1回.pdf',
      path: 'class/2024コンピュータ入門（教員A）/資料/第1回.pdf',
      name: '第1回.pdf',
      version: 'ts|1024',
      text: 'データベースの正規化について'.repeat(200),
    };
    const out = await norm.normalize(view('szvpn.fileText', text), ctx);
    expect(out.entities.length).toBeGreaterThan(0);
    for (const e of out.entities) {
      expect(e.entity.kind).toBe('documentChunk');
      expect((e.entity as { documentId: string }).documentId).toBe(docId);
    }
  });
});
