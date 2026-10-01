import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ManualClock, NotFoundError, ValidationError } from '@unicontext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProposalStore } from '../src/index.js';

let dir: string;
let clock: ManualClock;

const input = {
  kind: 'correct_fact' as const,
  subject: 'courseOffering:abc',
  predicate: 'room',
  value: '情報学部2号館21教室',
  note: 'ホワイトボードで確認',
  createdBy: 'mcp:test',
  preview: 'preview',
};

beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(tmpdir(), 'uc-prop-')), 'proposals');
  clock = new ManualClock('2026-10-01T00:30:00.000Z');
});
afterEach(() => {
  rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('ProposalStore', () => {
  it('creates a pending proposal with a 24h expiry and writes one JSON file', () => {
    const store = new ProposalStore(dir, { clock });
    const p = store.create(input);
    expect(p.status).toBe('pending');
    expect(p.expiresAt).toBe('2026-10-02T00:30:00.000Z');
    expect(p.createdAt).toBe('2026-10-01T00:30:00.000Z');
    expect(p.id).toMatch(/^p_[0-9a-f]{10}$/);
    expect(readdirSync(dir)).toEqual([`${p.id}.json`]);
    expect(JSON.parse(readFileSync(path.join(dir, `${p.id}.json`), 'utf8')).value).toBe(
      '情報学部2号館21教室',
    );
  });

  it('persists across store instances (another process)', () => {
    const p = new ProposalStore(dir, { clock }).create(input);
    const other = new ProposalStore(dir, { clock });
    expect(other.get(p.id)).toEqual(p);
    expect(other.list()).toEqual([p]);
    other.markConfirmed(p.id);
    expect(new ProposalStore(dir, { clock }).get(p.id)?.status).toBe('confirmed');
  });

  it('expires lazily with the clock and persists the expired status', () => {
    const store = new ProposalStore(dir, { clock, ttlMs: 60_000 });
    const p = store.create(input);
    expect(store.get(p.id)?.status).toBe('pending');
    clock.set('2026-10-01T00:31:00.000Z');
    expect(store.get(p.id)?.status).toBe('expired');
    expect(store.list({ status: 'pending' })).toEqual([]);
    expect(store.list({ status: 'expired' })).toHaveLength(1);
    expect(() => store.markConfirmed(p.id)).toThrow(ValidationError);
    expect(JSON.parse(readFileSync(path.join(dir, `${p.id}.json`), 'utf8')).status).toBe('expired');
  });

  it('confirm and reject are one-way from pending', () => {
    const store = new ProposalStore(dir, { clock });
    const a = store.create(input);
    const b = store.create(input);
    expect(store.markConfirmed(a.id).status).toBe('confirmed');
    expect(() => store.markConfirmed(a.id)).toThrow(ValidationError);
    expect(() => store.reject(a.id)).toThrow(ValidationError);
    expect(store.reject(b.id).status).toBe('rejected');
    expect(() => store.markConfirmed(b.id)).toThrow(ValidationError);
  });

  it('unknown or malicious ids are not found and never touch the file system', () => {
    const store = new ProposalStore(dir, { clock });
    store.create(input);
    expect(store.get('p_missing')).toBeUndefined();
    expect(store.get('../../etc/passwd')).toBeUndefined();
    expect(() => store.markConfirmed('../x')).toThrow(NotFoundError);
    expect(() => store.reject('nope')).toThrow(NotFoundError);
  });

  it('lists in creation order, ignores junk files, leaves no temp files', () => {
    const store = new ProposalStore(dir, { clock });
    const a = store.create(input);
    clock.set('2026-10-01T00:40:00.000Z');
    const b = store.create({
      ...input,
      predicate: 'assignment_due',
      value: '2026-10-10T23:59:00+09:00',
    });
    writeFileSync(path.join(dir, 'junk.json'), '{not json');
    writeFileSync(path.join(dir, 'notes.txt'), 'x');
    expect(store.list().map((p) => p.id)).toEqual([a.id, b.id]);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(path.join(dir, 'junk.json'))).toBe(true);
  });

  it('list on a directory that does not exist yet is empty', () => {
    expect(new ProposalStore(path.join(dir, 'nested'), { clock }).list()).toEqual([]);
  });
});
