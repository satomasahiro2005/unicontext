import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import { ManualClock, type SecretStore } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAPPINGS_DIR,
  McpConfigSchema,
  McpSourceAdapter,
} from '../../../packages/adapter-mcp/src/index.js';
import {
  createEdServer,
  inMemoryFactory,
} from '../../../packages/adapter-mcp/test/fixtures/servers.js';
import {
  createMappedNormalizer,
  loadMappingFile,
  mappingMetadata,
} from '../../../packages/mapping/src/index.js';
import { createMcpServer, ProposalStore, type McpEnvelope } from '../src/index.js';
import type { AssignmentDetailView } from '../src/assignment-detail.js';

/*
 * get_assignment on an Ed lesson (edstem-mcp mapping over a fake edstem-mcp server): the whole
 * lesson with its quiz questions, the student's saved answers and files, read on request; and the
 * lesson text and questions found by `search`.
 */

class NoSecrets implements SecretStore {
  readonly backend = 'memory';
  get(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup(options: { failing?: string[] } = {}) {
  const calls: { tool: string; args: unknown }[] = [];
  const uc: UniContext = createUniContext({
    profile: 'shizuoka-university',
    clock: new ManualClock('2026-10-05T00:30:00.000Z'),
  });
  const spec = loadMappingFile(join(MAPPINGS_DIR, 'edstem-mcp.yaml'));
  const adapter = new McpSourceAdapter({
    sourceId: 'edstem',
    spec,
    config: McpConfigSchema.parse({ command: 'fake-edstem-mcp' }),
    secrets: new NoSecrets(),
    transportFactory: inMemoryFactory(() =>
      createEdServer({ calls, ...(options.failing ? { failing: options.failing } : {}) }),
    ),
  });
  uc.sync.register({
    sourceId: 'edstem',
    adapter,
    normalizer: createMappedNormalizer(spec),
    metadata: mappingMetadata(spec, { name: '@unicontext/adapter-mcp', adapter: 'mcp' }),
  });
  expect((await uc.sync.sync('edstem')).ok).toBe(true);
  await uc.runPipeline();
  const server = createMcpServer({
    uc,
    proposals: new ProposalStore(join(process.cwd(), '.never-written'), { clock: uc.clock }),
  });
  const client = new Client({ name: 'assignment-test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup = async () => {
    await client.close();
    await adapter.dispose();
    await uc.close();
  };
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]?.text ?? '';
    if (res.isError) throw new Error(text);
    return JSON.parse(text) as McpEnvelope<T>;
  };
  return { uc, calls, call };
}

type Item = { taskId: string; assignmentId?: string; title: string };

describe('get_assignment (Ed lesson)', () => {
  it('returns every slide, the quiz questions with the saved answers and the files, read live and read-only', async () => {
    const { calls, call } = await setup();
    const list = await call<{ assignments: Item[] }>('get_assignments', {});
    const report = list.data.assignments.find((x) => x.title === '当日課題 (小レポート1)');
    expect(report?.assignmentId).toMatch(/^assignment:/);

    const before = calls.length;
    const out = await call<AssignmentDetailView & { fetch?: { status: string } }>(
      'get_assignment',
      { id: report?.taskId },
    );
    // read on request: the lesson, its quiz questions, the saved answers and the file list
    expect(calls.slice(before).map((c) => c.tool)).toEqual([
      'get_lesson',
      'list_slide_questions',
      'list_slide_responses',
      'list_lesson_files',
    ]);
    expect(calls.some((c) => /^(create|reply|submit|mark)_/.test(c.tool))).toBe(false);
    expect(out.data.fetch).toEqual({ status: 'fetched' });
    expect(out.data.assignment).toMatchObject({
      id: report?.assignmentId,
      title: '当日課題 (小レポート1)',
      url: 'https://edstem.org/au/courses/55/lessons/2002',
      submissionStatus: 'not_submitted',
    });
    // the deadline written in the slide (extracted) is the task's due date
    expect(out.data.task?.dueAt).toBe('2026-10-06T08:00:00.000Z');
    const lesson = out.data.lesson;
    expect(lesson).toMatchObject({
      platform: 'edstem',
      lessonId: 2002,
      module: '第1回: ガイダンス・導入 (10/1)',
      progress: 'unattempted',
    });
    expect(lesson?.answersFetchedAt).toBeDefined();
    expect(lesson?.slides).toHaveLength(1);
    const slide = lesson?.slides[0];
    expect(slide).toMatchObject({
      number: 1,
      title: '課題 (小レポート1)',
      type: 'quiz',
      text: '提出期限: 10月6日 17:00PM',
      url: 'https://edstem.org/au/courses/55/lessons/2002/slides/821141',
    });
    expect(slide?.questions?.map((q) => q.number)).toEqual([1, 2]);
    expect(slide?.questions?.[0]).toMatchObject({
      id: 404981,
      prompt:
        '画像形式のファイルを貼り付けて提出すること\nビデオレンタル店のデータベースの概念モデルを設計し、ER図を提出しなさい。',
      myAnswer: { text: '下書き: 会員・DVD・貸出', savedAt: '2026-10-05T20:00:00+11:00' },
    });
    expect(slide?.questions?.[1]).toMatchObject({
      prompt: '授業の感想をDiscussionのスレッドに投稿し、そのスレッド番号を記載してください',
    });
    expect(slide?.questions?.[1]?.myAnswer).toBeUndefined();
    expect((out.data as { notes?: string[] }).notes).toBeUndefined();
    expect(out.answerHint).toMatch(/質問1・質問2/);
    expect(out.citations[0]?.label).toBeDefined();
  });

  it('numbers choices and saved choices from 1, shows slide files, and never returns the answer key', async () => {
    const { call } = await setup();
    const list = await call<{ assignments: Item[] }>('get_assignments', {
      includeCompleted: true,
    });
    const quiz = list.data.assignments.find((x) => x.title === 'Quiz 2');
    const out = await call<AssignmentDetailView>('get_assignment', { id: quiz?.assignmentId });
    const slides = out.data.lesson?.slides ?? [];
    expect(slides.map((s) => s.title)).toEqual(['前半', '後半']);
    expect(slides[0]?.questions?.[0]).toMatchObject({
      number: 1,
      prompt: '主キーの性質はどれか',
      choices: ['一意である', 'NULL を許す'],
      myAnswer: { choices: [1], correct: true },
    });
    expect(JSON.stringify(out)).not.toContain('SECRET-ANSWER-KEY');
    expect(JSON.stringify(out)).not.toContain('solution');
  });

  it('answers from what the sync stored when Ed cannot be read now', async () => {
    const { call } = await setup({ failing: ['get_lesson'] });
    const list = await call<{ assignments: Item[] }>('get_assignments', {});
    const report = list.data.assignments.find((x) => x.title === '当日課題 (小レポート1)');
    const out = await call<AssignmentDetailView & { fetch?: { status: string }; notes?: string[] }>(
      'get_assignment',
      { id: report?.assignmentId },
    );
    expect(out.data.fetch?.status).toBe('failed');
    expect(out.data.notes?.join(' ')).toMatch(/読み直しができなかった/);
    expect(out.data.notes?.join(' ')).toMatch(/保存済みの回答はまだ読めていません/);
    // nothing stored either (get_lesson failed during the sync too): an empty lesson, no crash
    expect(out.data.lesson?.slides).toEqual([]);
  });

  it('finds the lesson text and each question with search, cited with the Ed lesson', async () => {
    const { call } = await setup();
    const res = await call<{ hits: { title: string; snippet: string; kind: string }[] }>('search', {
      query: '小レポート1 質問2',
    });
    const hit = res.data.hits.find((r) => r.title === '当日課題 (小レポート1) 質問2');
    expect(hit?.snippet).toMatch(/授業の感想/);
    expect(JSON.stringify(res.citations)).toMatch(
      /https:\/\/edstem\.org\/au\/courses\/55\/lessons\/2002\/slides\/821141/,
    );
    // the hit's id opens the whole assignment
    const out = await call<AssignmentDetailView>('get_assignment', {
      id: (hit as unknown as { id: string }).id,
      refresh: false,
    });
    expect(out.data.assignment?.title).toBe('当日課題 (小レポート1)');
    expect(out.data.lesson?.slides[0]?.questions?.[1]?.prompt).toMatch(/スレッド番号/);
    // a lecture-material lesson (not an assignment) opens as the stored lesson
    const material = await call<{ hits: { id: string; title: string }[] }>('search', {
      query: '正規化は第3回',
    });
    const doc = material.data.hits.find((h) => h.title === '当日の講義資料');
    const lesson = await call<{ lesson: { slides: { title: string }[] }; assignment?: unknown }>(
      'get_assignment',
      { id: doc?.id },
    );
    expect(lesson.data.assignment).toBeUndefined();
    expect(lesson.data.lesson.slides.map((x) => x.title)).toEqual(['講義資料', 'まとめ']);
  });
});
