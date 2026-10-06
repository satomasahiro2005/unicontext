import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import type {
  AuthResult,
  ConnectorMetadata,
  DetailFetchAdapter,
  DetailFetchResult,
  Normalizer,
  RawItem,
  SyncResult,
} from '../../../packages/connector-sdk/src/index.js';
import { createUniContext, type UniContext } from '@unicontext/context-engine';
import { type FetchLike, ManualClock, type SecretStore } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAPPINGS_DIR,
  McpConfigSchema,
  McpSourceAdapter,
} from '../../../packages/adapter-mcp/src/index.js';
import {
  createEdServer,
  ED_LESSONS,
  inMemoryFactory,
} from '../../../packages/adapter-mcp/test/fixtures/servers.js';
import {
  createMappedNormalizer,
  loadMappingFile,
  mappingMetadata,
} from '../../../packages/mapping/src/index.js';
import {
  createTeamsWebNormalizer,
  metadata as teamsMetadata,
} from '../../../connectors/teams-web/src/index.js';
import {
  createLiveCampusUNormalizer,
  metadata as lcuMetadata,
  SHIZUOKA_DEPLOYMENT,
} from '../../../connectors/livecampusu/src/index.js';
import { createMcpServer, ProposalStore, type McpEnvelope } from '../src/index.js';
import type { VerifySubmissionView } from '../src/verify-submission.js';

/*
 * verify_submission: right after the student says they handed it in, one assignment is read again
 * from its submission system (whatever the sync schedule says), and the answer shows whether it is
 * submitted and what was submitted. File contents are fetched only when get_document opens one;
 * a sync never fetches a file body.
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

const NOW = '2026-10-05T00:30:00.000Z';

async function connect(uc: UniContext, filesDir: string) {
  const server = createMcpServer({
    uc,
    proposals: new ProposalStore(join(filesDir, 'proposals'), { clock: uc.clock }),
    filesDir,
  });
  const client = new Client({ name: 'verify-test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]?.text ?? '';
    if (res.isError) throw new Error(text);
    return JSON.parse(text) as McpEnvelope<T>;
  };
  return { client, call };
}

async function setupEd() {
  const calls: { tool: string; args: unknown }[] = [];
  const fetched: string[] = [];
  const fileFetch: FetchLike = (input) => {
    fetched.push(input);
    return Promise.resolve(
      new Response('ER図の説明: 会員とDVDは多対多', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
  };
  const clock = new ManualClock(NOW);
  const uc = createUniContext({ profile: 'shizuoka-university', clock });
  const spec = loadMappingFile(join(MAPPINGS_DIR, 'edstem-mcp.yaml'));
  const adapter = new McpSourceAdapter({
    sourceId: 'edstem',
    spec,
    config: McpConfigSchema.parse({ command: 'fake-edstem-mcp' }),
    secrets: new NoSecrets(),
    transportFactory: inMemoryFactory(() => createEdServer({ calls })),
    runOptions: { fileFetch },
  });
  uc.sync.register({
    sourceId: 'edstem',
    adapter,
    normalizer: createMappedNormalizer(spec),
    metadata: mappingMetadata(spec, { name: '@unicontext/adapter-mcp', adapter: 'mcp' }),
  });
  expect((await uc.sync.sync('edstem')).ok).toBe(true);
  await uc.runPipeline();
  const tmp = mkdtempSync(join(tmpdir(), 'uc-verify-'));
  const { client, call } = await connect(uc, join(tmp, 'files'));
  cleanup = async () => {
    await client.close();
    await adapter.dispose();
    await uc.close();
    rmSync(tmp, { recursive: true, force: true });
  };
  return { uc, clock, calls, fetched, call };
}

type Item = { taskId: string; assignmentId?: string; title: string };
type Verified = VerifySubmissionView;

describe('verify_submission (Ed lesson)', () => {
  it('a sync reads no saved answer and no file body', async () => {
    const { uc, calls, fetched } = await setupEd();
    const tools = new Set(calls.map((c) => c.tool));
    expect(tools.has('list_slide_responses')).toBe(false);
    expect(tools.has('list_lesson_files')).toBe(false);
    expect(fetched).toEqual([]);
    const responseFiles = uc.sync.stores.entities
      .list('document')
      .filter((d) => (d.extra as { edKind?: string } | undefined)?.edKind === 'response-file');
    expect(responseFiles).toEqual([]);
  });

  it('re-reads the lesson right after submitting and shows the answers and file names; the content only on get_document', async () => {
    const { clock, calls, fetched, call } = await setupEd();
    const list = await call<{ assignments: Item[] }>('get_assignments', {});
    const report = list.data.assignments.find((x) => x.title === '当日課題 (小レポート1)');
    expect(report).toBeDefined();

    // before the student submits: answers saved, the lesson not completed
    const first = await call<Verified>('verify_submission', { id: report?.taskId });
    expect(first.data.live.status).toBe('fetched');
    expect(first.data.assignment).toMatchObject({
      id: report?.assignmentId,
      platform: 'edstem',
      url: 'https://edstem.org/au/courses/55/lessons/2002',
    });
    expect(first.data.submission).toMatchObject({
      status: 'not_submitted',
      submitted: false,
      sourceStatus: 'unattempted',
      answeredQuestions: { answered: 1, total: 2 },
      lastAnswerAt: '2026-10-05T20:00:00+11:00',
      checkedAt: NOW,
    });
    expect(first.data.answers).toEqual([
      expect.objectContaining({
        slide: 1,
        question: 1,
        text: expect.stringContaining('下書き: 会員・DVD・貸出') as unknown as string,
      }),
    ]);
    // the pasted image and the attached file: names and ids, no content fetched
    const names = first.data.files.map((f) => f.name).sort();
    expect(names).toEqual(['ER図の説明.txt', '画像 ERIMG1']);
    expect(first.data.files.every((f) => f.documentId.startsWith('document:'))).toBe(true);
    expect(first.data.files.find((f) => f.name === 'ER図の説明.txt')).toMatchObject({
      mimeType: 'text/plain',
      question: 1,
    });
    expect(fetched).toEqual([]);
    expect(first.answerHint).toMatch(/まだ提出済みになっていません/);
    expect(first.data.limits.join(' ')).toMatch(/提出した日時を返しません/);

    // the student completes the lesson on Ed; a minute later they ask again
    const lesson = ED_LESSONS[1] as { status: string };
    const was = lesson.status;
    lesson.status = 'completed';
    try {
      clock.set(new Date(Date.parse(NOW) + 60_000));
      const before = calls.length;
      const second = await call<Verified>('verify_submission', { id: report?.assignmentId });
      expect(calls.slice(before).map((c) => c.tool)).toEqual([
        'list_lessons',
        'get_lesson',
        'list_slide_questions',
        'list_slide_responses',
        'list_lesson_files',
      ]);
      expect(calls.some((c) => /^(create|reply|submit|mark)_/.test(c.tool))).toBe(false);
      expect(second.data.live.status).toBe('fetched');
      expect(second.data.submission).toMatchObject({
        status: 'submitted',
        submitted: true,
        sourceStatus: 'completed',
        checkedAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
      });
      expect(second.answerHint).toMatch(/提出済み/);
      expect(second.answerHint).toMatch(/get_document/);
      // the task follows the submission system
      const done = await call<{ assignments: (Item & { status: string })[] }>('get_assignments', {
        includeCompleted: true,
      });
      expect(
        done.data.assignments.find((x) => x.assignmentId === report?.assignmentId)?.status,
      ).toBe('submitted');

      // asked again within 30 s: no new read, the read just made is returned
      clock.set(new Date(Date.parse(NOW) + 70_000));
      const n = calls.length;
      const third = await call<Verified>('verify_submission', { id: report?.assignmentId });
      expect(calls.length).toBe(n);
      expect(third.data.live).toMatchObject({ status: 'recent' });
      expect(third.data.live.retryAfterSeconds).toBeGreaterThan(0);
      expect(third.data.submission.submitted).toBe(true);
    } finally {
      lesson.status = was;
    }
    expect(fetched).toEqual([]);

    // the content of one file, only now, only that file
    const file = first.data.files.find((f) => f.name === 'ER図の説明.txt');
    // get_document answers with the document body itself (not an envelope's data)
    const doc = (await call('get_document', {
      id: file?.documentId,
      render: 'text',
    })) as unknown as { document: { title: string }; pages: { text: string }[] };
    expect(fetched).toEqual(['https://static.edusercontent.com/files/NOTE2']);
    expect(doc.document.title).toBe('ER図の説明.txt');
    expect(doc.pages[0]?.text).toContain('会員とDVDは多対多');
  });
});

// ---------------------------------------------------------------------------------------------
// LiveCampusU and Teams: the state only (fake adapters with the real normalizers)

class StateAdapter implements DetailFetchAdapter {
  readonly version = '1';
  detailCalls: string[][] = [];
  constructor(
    readonly id: string,
    public items: RawItem[],
  ) {}
  capabilities(): Promise<Capability[]> {
    return Promise.resolve(['assignments', 'submissions']);
  }
  authenticate(): Promise<AuthResult> {
    return Promise.resolve({ status: 'authenticated' });
  }
  health(): Promise<HealthStatus> {
    return Promise.resolve({ state: 'healthy', checkedAt: NOW });
  }
  sync(): Promise<SyncResult> {
    return Promise.resolve({ items: this.items });
  }
  fetchDetails(
    requests: readonly { externalId: string; sourceType?: string }[],
  ): Promise<DetailFetchResult> {
    this.detailCalls.push(requests.map((r) => r.externalId));
    const items = this.items.filter((i) => requests.some((r) => r.externalId === i.externalId));
    return Promise.resolve({
      items,
      results: requests.map((r) => ({
        externalId: r.externalId,
        status: items.some((i) => i.externalId === r.externalId) ? 'fetched' : 'notFound',
      })),
      warnings: [],
    });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

async function setupState(
  sourceId: string,
  adapter: StateAdapter,
  normalizer: Normalizer,
  metadata: ConnectorMetadata,
) {
  const uc = createUniContext({ profile: 'shizuoka-university', clock: new ManualClock(NOW) });
  uc.sync.register({ sourceId, adapter, normalizer, metadata });
  expect((await uc.sync.sync(sourceId)).ok).toBe(true);
  await uc.runPipeline();
  const tmp = mkdtempSync(join(tmpdir(), 'uc-verify-state-'));
  const { client, call } = await connect(uc, join(tmp, 'files'));
  cleanup = async () => {
    await client.close();
    await uc.close();
    rmSync(tmp, { recursive: true, force: true });
  };
  return { uc, call };
}

const lcuRow = (submittalStatus: string): RawItem => ({
  sourceType: 'lcu.assignment',
  externalId: '95133',
  payload: {
    submissionSeq: '95133',
    year: 2026,
    submissionType: 'レポート',
    subjectText: 'コンピュータネットワーク(1クラス)',
    title: '第3回レポート',
    statusName: '受付中',
    statusCode: '3',
    submittalTerm: '2026/10/01 00:00 ～ 2026/10/08 00:00',
    submittalStatus,
    context: {},
    source: { screen: 'SC_14002B00_01', selector: 'tr[submissionSeq=95133]' },
  },
});

const teamsWork = (status: string, submittedDateTime: string | null): RawItem => ({
  sourceType: 'teamsweb.assignment',
  externalId: 'w-1',
  payload: {
    id: 'w-1',
    classId: 'class-1',
    displayName: '第3回レポート（Teams）',
    dueDateTime: '2026-10-09T14:59:00Z',
    webUrl: 'https://teams.microsoft.com/l/entity/x/y',
    submissions: [{ id: 's-1', status, submittedDateTime }],
  },
});

describe('verify_submission (LiveCampusU / Teams)', () => {
  it('LiveCampusU: re-reads 提出済 / 未提出 and says what cannot be confirmed there', async () => {
    const adapter = new StateAdapter('lcu', [lcuRow('未提出')]);
    const { uc, call } = await setupState(
      'livecampusu',
      adapter,
      createLiveCampusUNormalizer({ deployment: SHIZUOKA_DEPLOYMENT }),
      lcuMetadata,
    );
    const a = uc.sync.stores.entities.list('assignment')[0];
    adapter.items = [lcuRow('提出済')]; // handed in on LiveCampusU
    const out = await call<Verified>('verify_submission', { id: a?.id });
    expect(adapter.detailCalls).toEqual([['95133']]);
    expect(out.data.assignment.platform).toBe('livecampusu');
    expect(out.data.submission).toMatchObject({
      status: 'submitted',
      submitted: true,
      sourceStatus: '提出済',
      acceptance: '受付中',
    });
    expect(out.data.files).toEqual([]);
    expect(out.data.limits.join(' ')).toMatch(/提出済 \/ 未提出/);
    // get_assignment does not read LiveCampusU live (it has no content to add)
    await call('get_assignment', { id: a?.id });
    expect(adapter.detailCalls).toHaveLength(1);
  });

  it('Teams: re-reads the status and the time it was turned in', async () => {
    const adapter = new StateAdapter('teams', [teamsWork('working', null)]);
    const { uc, call } = await setupState(
      'teams-web',
      adapter,
      createTeamsWebNormalizer(),
      teamsMetadata,
    );
    const a = uc.sync.stores.entities.list('assignment')[0];
    adapter.items = [teamsWork('submitted', '2026-10-05T00:29:00Z')];
    const out = await call<Verified>('verify_submission', { id: a?.id });
    expect(out.data.assignment.platform).toBe('teams');
    expect(out.data.submission).toMatchObject({
      status: 'submitted',
      submitted: true,
      submittedAt: '2026-10-05T00:29:00.000Z',
      sourceStatus: 'submitted',
    });
    expect(out.data.limits.join(' ')).toMatch(/Teams の課題画面/);
  });
});
