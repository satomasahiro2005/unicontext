import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ManualClock } from '@unicontext/core';
import {
  createFakeConnector,
  createShizuokaSeed,
  SEED_DAY1_SYNC_AT,
} from '@unicontext/connector-sdk';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/* Regression tests for data-safety properties of the whole pipeline (§6, §19, §20). */
let uc: UniContext;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-safety-'));
  const clock = new ManualClock(SEED_DAY1_SYNC_AT);
  uc = createUniContext({ dataDir: path.join(tmp, 'data'), profile: 'shizuoka-university', clock });
  for (const s of createShizuokaSeed()) {
    const fake = createFakeConnector(s.options);
    uc.sync.register({
      sourceId: s.sourceId,
      adapter: fake.adapter,
      normalizer: fake.normalizer,
      metadata: fake.metadata,
    });
  }
  for (const s of uc.sync.sources()) expect((await uc.sync.sync(s.sourceId)).ok).toBe(true);
});

afterEach(async () => {
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

const liveDeadlineFacts = (): string[] =>
  (
    uc.db.sqlite
      .prepare(
        "SELECT id FROM facts WHERE predicate = 'deadline' AND retracted_at IS NULL ORDER BY id",
      )
      .all() as { id: string }[]
  ).map((r) => r.id);

describe('integration: data safety', () => {
  it('reprocess() keeps rule-extracted deadlines and their tasks (§6, §20)', async () => {
    const before = liveDeadlineFacts();
    expect(before.length).toBeGreaterThan(0);
    const openExtracted = (): string[] =>
      uc.tasks
        .list()
        .filter((t) => t.taskKind === 'extracted' && t.status !== 'cancelled')
        .map((t) => t.id)
        .sort();
    const tasksBefore = openExtracted();
    expect(tasksBefore.length).toBeGreaterThan(0);

    await uc.sync.reprocess();

    expect(liveDeadlineFacts()).toEqual(before);
    expect(openExtracted()).toEqual(tasksBefore);
  });
});
