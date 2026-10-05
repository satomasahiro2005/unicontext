import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  comparePriority,
  meetsPriority,
  NOTIFICATION_KINDS,
  type Notification,
  NotificationLog,
  PRIORITIES,
} from '../src/index.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-nlog-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function n(i: number, over: Partial<Notification> = {}): Notification {
  return {
    id: `ntf_${i}`,
    kind: 'new_assignment',
    priority: 'normal',
    title: `t${i}`,
    body: 'b',
    createdAt: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    dedupeKey: `k${i}`,
    citations: [],
    ...over,
  };
}

describe('priorities', () => {
  it('exports the kinds and a most-urgent-first ordering', () => {
    expect(NOTIFICATION_KINDS).toHaveLength(14);
    expect([...PRIORITIES]).toEqual(['critical', 'high', 'normal', 'low']);
    expect(
      ['low', 'critical', 'normal', 'high'].sort((a, b) => comparePriority(a as never, b as never)),
    ).toEqual(['critical', 'high', 'normal', 'low']);
    expect(meetsPriority('high', 'normal')).toBe(true);
    expect(meetsPriority('low', 'normal')).toBe(false);
    expect(meetsPriority('normal', 'normal')).toBe(true);
  });
});

describe('NotificationLog', () => {
  it('works in memory without a file', () => {
    const log = new NotificationLog();
    log.add(n(1));
    log.add(n(2, { priority: 'critical' }));
    expect(log.list().map((x) => x.id)).toEqual(['ntf_2', 'ntf_1']);
    expect(log.has('k1')).toBe(true);
    expect(log.markRead('ntf_1')).toBe(true);
    expect(log.markRead('missing')).toBe(false);
    expect(log.list({ unreadOnly: true }).map((x) => x.id)).toEqual(['ntf_2']);
    expect(log.get('ntf_1')?.read).toBe(true);
  });

  it('creates the parent directory and reloads entries, read state and resets', () => {
    const file = path.join(tmp, 'a', 'b', 'log.jsonl');
    const log = new NotificationLog({ file });
    log.add(n(1));
    log.add(n(2));
    log.markRead('ntf_1');
    log.resetKey('k2');
    const again = new NotificationLog({ file });
    expect(again.list().map((x) => x.id)).toEqual(['ntf_2', 'ntf_1']);
    expect(again.get('ntf_1')?.read).toBe(true);
    expect(again.has('k1')).toBe(true);
    expect(again.has('k2')).toBe(false);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('tolerates corrupt and invalid lines', () => {
    const file = path.join(tmp, 'log.jsonl');
    const log = new NotificationLog({ file });
    log.add(n(1));
    appendFileSync(file, '{not json\n');
    appendFileSync(file, `${JSON.stringify({ t: 'n', n: { id: 'x' } })}\n`);
    appendFileSync(file, '\n');
    appendFileSync(file, `${JSON.stringify({ t: 'n', n: n(2) })}\n`);
    const again = new NotificationLog({ file });
    expect(again.corruptLines).toBe(2);
    expect(again.list().map((x) => x.id)).toEqual(['ntf_2', 'ntf_1']);
  });

  it('caps the in-memory list but keeps dedupe keys of dropped entries', () => {
    const file = path.join(tmp, 'cap.jsonl');
    const log = new NotificationLog({ file, maxEntries: 3 });
    for (let i = 1; i <= 5; i++) log.add(n(i));
    expect(log.size).toBe(3);
    expect(log.list().map((x) => x.id)).toEqual(['ntf_5', 'ntf_4', 'ntf_3']);
    expect(log.has('k1')).toBe(true);
    expect(new NotificationLog({ file, maxEntries: 3 }).size).toBe(3);
  });

  it('survives an unwritable log path without throwing', () => {
    const blocker = path.join(tmp, 'file');
    writeFileSync(blocker, 'x');
    const log = new NotificationLog({ file: path.join(blocker, 'sub', 'log.jsonl') });
    expect(() => log.add(n(1))).not.toThrow();
    expect(log.list()).toHaveLength(1);
    expect(existsSync(path.join(blocker, 'sub'))).toBe(false);
  });

  it('filters by since, minPriority and limit', () => {
    const log = new NotificationLog();
    log.add(n(1, { priority: 'low' }));
    log.add(n(2, { priority: 'high' }));
    log.add(n(3, { priority: 'critical' }));
    expect(log.list({ minPriority: 'high' }).map((x) => x.id)).toEqual(['ntf_3', 'ntf_2']);
    expect(log.list({ since: '2026-10-01T00:00:02.000Z' }).map((x) => x.id)).toEqual([
      'ntf_3',
      'ntf_2',
    ]);
    expect(log.list({ limit: 1 }).map((x) => x.id)).toEqual(['ntf_3']);
  });
});
