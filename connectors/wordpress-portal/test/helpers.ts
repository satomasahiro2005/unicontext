import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ConnectorContext, RateLimiter } from '@unicontext/connector-sdk';
import {
  type FetchLike,
  silentLogger,
  systemClock,
  type SecretStore,
  type UniversityProfile,
} from '@unicontext/core';
import type { WpPostPayload } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const BASE = 'https://portal.example.ac.jp/site/';

export function fixtureJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8')) as T;
}

/** The two sanitized posts captured from the Shizuoka portal. */
export function samplePosts(): WpPostPayload[] {
  return fixtureJson<{ response: WpPostPayload[] }>('portal-wp-posts.json').response;
}

export function memorySecrets(): SecretStore {
  const m = new Map<string, string>();
  return {
    backend: 'memory',
    get: (k) => Promise.resolve(m.get(k)),
    set: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => Promise.resolve(m.delete(k)),
  };
}

export function makeContext<T>(
  config: T,
  fetchFn: FetchLike,
  profile?: UniversityProfile,
): ConnectorContext<T> {
  return {
    sourceId: 'portal',
    config,
    secrets: memorySecrets(),
    logger: silentLogger,
    clock: systemClock,
    rateLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 10_000 }),
    profile,
    cacheDir: undefined,
    fetch: fetchFn,
  };
}

/** A minimal one-font PDF with one line of (ASCII) text per page. */
export function buildPdf(pages: string[]): Uint8Array {
  const esc = (t: string): string => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${esc(text)}) Tj ET`;
    objects[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[5 + 2 * i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++)
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
