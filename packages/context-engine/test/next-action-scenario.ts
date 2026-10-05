import { type CanonicalEntityInput, stableId } from '@unicontext/canonical-model';
import { ManualClock } from '@unicontext/core';
import { expect } from 'vitest';
import {
  defineMetadata,
  type NormalizeOutput,
  type Normalizer,
  type SourceAdapter,
} from '../../connector-sdk/src/index.js';
import { createUniContext, type UniContext } from '../src/index.js';

// Scenario (後期, Shizuoka profile): Monday 2026-10-05 09:30 JST.
//  - データベース (月4) with an Ed lesson due tomorrow 17:00, not submitted
//  - 電気回路 (木1) with a big 実験レポート due in two weeks
//  - ネットワーク (火2) tomorrow, slides published yesterday (prep)
//  - 情報倫理 (金1) 小レポート2 without a due date; 小レポート1 already submitted
//  - 古い科目: dropped, with an assignment due tomorrow (must not nag)

export const NOW = '2026-10-05T00:30:00.000Z';
const lcu = <K extends 'courseOffering' | 'person' | 'enrollment'>(kind: K, key: string) =>
  stableId(kind, 'lcu', key);
const self = lcu('person', 'self');
export const db = lcu('courseOffering', 'db');
export const circuit = lcu('courseOffering', 'circuit');
const net = lcu('courseOffering', 'net');
const ethics = lcu('courseOffering', 'ethics');
const old = lcu('courseOffering', 'old');
const ed = <K extends 'assignment' | 'submission' | 'material'>(kind: K, key: string) =>
  stableId(kind, 'ed', key);

function lcuEntities(): CanonicalEntityInput[] {
  const out: CanonicalEntityInput[] = [
    { id: self, kind: 'person', name: '本人', roles: ['student'], isSelf: true },
  ];
  const add = (
    id: string,
    key: string,
    title: string,
    day: number,
    period: number,
    status = 'active',
  ) => {
    out.push({
      id: id as never,
      kind: 'courseOffering',
      title,
      academicYear: 2026,
      term: '後期',
      instructorNames: ['教員 一郎'],
      schedule: [{ dayOfWeek: day, period, room: `${title}教室` }],
      scheduleType: 'regular',
    });
    out.push({
      id: lcu('enrollment', key),
      kind: 'enrollment',
      personId: self,
      courseOfferingId: id as never,
      role: 'student',
      status: status as 'active',
    });
  };
  add(db, 'db', 'データベース', 1, 4);
  add(net, 'net', 'ネットワーク', 2, 2);
  add(circuit, 'circuit', '電気回路', 4, 1);
  add(ethics, 'ethics', '情報倫理', 5, 1);
  add(old, 'old', '古い科目', 3, 1, 'dropped');
  return out;
}

function edEntities(): CanonicalEntityInput[] {
  const assignment = (key: string, course: string, title: string, dueAt?: string) =>
    ({
      id: ed('assignment', key),
      kind: 'assignment',
      courseOfferingId: course,
      title,
      ...(dueAt ? { dueAt } : {}),
      url: `https://edstem.org/au/courses/1/lessons/${key}`,
    }) as CanonicalEntityInput;
  const submission = (key: string, status: string) =>
    ({
      id: ed('submission', key),
      kind: 'submission',
      assignmentId: ed('assignment', key),
      status,
    }) as CanonicalEntityInput;
  return [
    assignment('lesson3', db, 'Lesson 3: SQL演習', '2026-10-06T08:00:00.000Z'),
    submission('lesson3', 'not_submitted'),
    assignment('lab', circuit, '実験レポート: 回路設計', '2026-10-19T14:59:00.000Z'),
    assignment('mini2', ethics, '小レポート2'),
    assignment('mini1', ethics, '小レポート1', '2026-10-07T14:59:00.000Z'),
    submission('mini1', 'submitted'),
    assignment('oldhw', old, '古い課題', '2026-10-06T05:00:00.000Z'),
    {
      id: ed('material', 'net-slides'),
      kind: 'material',
      courseOfferingId: net,
      title: '第2回スライド',
      materialKind: 'slides',
      url: 'https://edstem.org/au/courses/2/resources/2',
      publishedAt: '2026-10-04T03:00:00.000Z',
    } as CanonicalEntityInput,
  ];
}

const meta = (product: string, label: string, authority: string, capabilities: string[]) =>
  defineMetadata({
    name: `@unicontext/${product}`,
    product,
    version: '1.0.0',
    license: 'MIT',
    capabilities: capabilities as never,
    adapter: 'native',
    apiStability: 'unofficial',
    risk: 'unsupported',
    testedVersion: 'test',
    defaultAuthority: authority as never,
    sourceLabel: label,
    rawTypes: ['test.entities'],
  });

function staticAdapter(id: string, entities: () => CanonicalEntityInput[]): SourceAdapter {
  return {
    id,
    version: '1',
    capabilities: () => Promise.resolve(['courses']),
    authenticate: () => Promise.resolve({ status: 'not_required' }),
    sync: () =>
      Promise.resolve({
        items: [
          { sourceType: 'test.entities', externalId: 'all', payload: { entities: entities() } },
        ],
        hasMore: false,
        complete: { sourceTypes: ['test.entities'] },
      }),
    health: () => Promise.resolve({ state: 'healthy', checkedAt: NOW }),
    dispose: () => Promise.resolve(),
  };
}

const normalizer: Normalizer = {
  id: 'test-entities',
  version: '1',
  sourceTypes: ['test.entities'],
  normalize: (item): NormalizeOutput => ({
    entities: (item.payload as { entities: CanonicalEntityInput[] }).entities.map((entity) => ({
      entity,
      ref: { url: 'https://example.ac.jp/' },
    })),
    facts: [],
  }),
};

/** The next-action scenario, synced through two sources (学務情報システム, EdStem). */
export async function createNextActionScenario(): Promise<{ uc: UniContext; clock: ManualClock }> {
  const clock = new ManualClock(NOW);
  const uc = createUniContext({
    profile: 'shizuoka-university',
    clock,
    student: { campus: '浜松', faculty: '情報学部' },
  });
  uc.sync.register({
    sourceId: 'livecampusu',
    adapter: staticAdapter('livecampusu', lcuEntities),
    normalizer,
    metadata: meta('livecampusu', '学務情報システム', 'academic-system', [
      'courses',
      'timetable',
      'enrollments',
    ]),
  });
  uc.sync.register({
    sourceId: 'edstem',
    adapter: staticAdapter('edstem', edEntities),
    normalizer,
    metadata: meta('edstem', 'EdStem', 'submission-system', [
      'courses',
      'assignments',
      'submissions',
      'materials',
    ]),
  });
  for (const id of ['livecampusu', 'edstem']) expect((await uc.sync.sync(id)).ok).toBe(true);
  await uc.runPipeline();

  return { uc, clock };
}
