import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { UniContext } from '@unicontext/context-engine';
import { stableId } from '@unicontext/canonical-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyProposal,
  buildAssignments,
  createMcpServer,
  ProposalStore,
  type McpEnvelope,
} from '../src/index.js';
import { createSeeded } from './seeded.js';

let uc: UniContext;
let tmp: string;
let proposals: ProposalStore;
let server: McpServer;
let client: Client;

const dbCourse = stableId('courseOffering', 'lcu', 'J2401-2026-2');

interface CallOut {
  isError: boolean;
  text: string;
  envelope: McpEnvelope<Record<string, unknown>>;
  structured: unknown;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallOut> {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as { type: string; text: string }[])[0];
  const text = first?.text ?? '';
  const isError = res.isError === true;
  return {
    isError,
    text,
    envelope: isError ? ({} as never) : (JSON.parse(text) as McpEnvelope<Record<string, unknown>>),
    structured: res.structuredContent,
  };
}

async function readJson(uri: string): Promise<McpEnvelope<Record<string, unknown>>> {
  const res = await client.readResource({ uri });
  const c = res.contents[0];
  expect(c?.mimeType).toBe('application/json');
  return JSON.parse((c as { text: string }).text) as McpEnvelope<Record<string, unknown>>;
}

beforeAll(async () => {
  const seeded = await createSeeded();
  uc = seeded.uc;
  tmp = mkdtempSync(path.join(tmpdir(), 'uc-mcp-'));
  proposals = new ProposalStore(path.join(tmp, 'proposals'), { clock: uc.clock });
  server = createMcpServer({
    uc,
    proposals,
    sourcesInfo: () => ({ note: 'daemon-supplied', apiToken: 'should-be-redacted' }),
  });
  client = new Client({ name: 'contract-test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await uc.close();
  rmSync(tmp, { recursive: true, force: true });
});

const REQUIRED_TOOLS = [
  'get_today',
  'get_week',
  'get_course',
  'get_assignments',
  'get_deadlines',
  'get_recent_changes',
  'prepare_for_class',
  'review_class',
  'search',
  'get_source',
  'get_conflicts',
  'get_tasks',
  'get_announcements',
  'get_announcement',
  'correct_fact',
  'propose_pace_slot',
];

describe('MCP contract: tools listing', () => {
  it('lists every required tool', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(REQUIRED_TOOLS));
  });

  it('marks read tools readOnly; only the two propose tools are write-capable', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      if (t.name === 'correct_fact' || t.name === 'propose_pace_slot')
        expect(t.annotations?.readOnlyHint).toBe(false);
      else expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('does not expose submission, enrolment or grade tools (§51)', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /submit|enrol|register|grade|delete|drop/i.test(n))).toEqual([]);
    const cf = (await client.listTools()).tools.find((t) => t.name === 'correct_fact');
    expect(cf?.description).toContain('submitted');
    expect(cf?.description).toContain('提案');
  });

  it('declares server instructions: cite, report conflicts, propose-only', async () => {
    const text = client.getInstructions() ?? '';
    expect(text).toContain('出典');
    expect(text).toContain('食い違い');
    expect(text).toContain('propose-only');
  });
});

describe('MCP contract: read tools return the envelope', () => {
  const readCalls: [string, Record<string, unknown>][] = [
    ['get_today', {}],
    ['get_tomorrow', {}],
    ['get_week', {}],
    ['get_course', { courseOfferingId: dbCourse }],
    ['get_assignments', {}],
    ['get_tasks', {}],
    ['get_deadlines', { days: 30 }],
    ['get_recent_changes', { since: '2026-09-29' }],
    ['prepare_for_class', { courseOfferingId: dbCourse }],
    ['review_class', { courseOfferingId: dbCourse }],
    ['get_conflicts', {}],
    ['search', { query: '正規化' }],
  ];
  for (const [name, args] of readCalls)
    it(`${name} -> {data, citations, conflicts, answerHint} with citations on seed data`, async () => {
      const r = await call(name, args);
      expect(r.isError, r.text).toBe(false);
      expect(Object.keys(r.envelope).sort()).toEqual([
        'answerHint',
        'citations',
        'conflicts',
        'data',
      ]);
      expect(r.envelope.data).toBeTruthy();
      expect(r.envelope.citations.length, name).toBeGreaterThan(0);
      expect(Array.isArray(r.envelope.conflicts)).toBe(true);
      expect(r.envelope.answerHint).toContain('根拠');
      // structuredContent and the JSON text are the same envelope
      expect(r.structured).toEqual(r.envelope);
      // citations are de-duplicated across the whole result
      const ids = r.envelope.citations.map((c) => c.sourceReferenceId);
      expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('get_today and conflicts (§12, §75)', () => {
  it('surfaces the room conflict (21教室 vs 11教室) in conflicts', async () => {
    const { envelope } = await call('get_today');
    const notice = envelope.conflicts.find((c) => c.includes('21教室') && c.includes('11教室'));
    expect(notice, JSON.stringify(envelope.conflicts)).toBeTruthy();
    expect(notice).toContain('教室');
    expect(notice).toContain('食い違っています');
    expect(notice).toContain('断定せず');
    expect(envelope.answerHint).toContain('食い違い');
  });

  it('keeps both candidate values with their citations in data', async () => {
    const { envelope } = await call('get_today');
    const classes = envelope.data.classes as { room: { status: string; candidates: unknown[] } }[];
    expect(classes.some((c) => c.room.status === 'conflict' && c.room.candidates.length >= 2)).toBe(
      true,
    );
    expect(envelope.citations.some((c) => c.label.includes('学務情報システム'))).toBe(true);
  });

  it('get_conflicts lists the open room conflict', async () => {
    const { envelope } = await call('get_conflicts');
    const items = envelope.data.conflicts as { predicate: string; subject: string }[];
    expect(items.some((c) => c.predicate === 'room')).toBe(true);
    expect(envelope.conflicts.length).toBeGreaterThan(0);
  });
});

describe('course resolution', () => {
  it('get_course accepts an id, a title fragment and a course code', async () => {
    const byId = await call('get_course', { courseOfferingId: dbCourse });
    const byTitle = await call('get_course', { courseOfferingId: 'データベース' });
    const byCode = await call('get_course', { courseOfferingId: 'j2401' });
    for (const r of [byId, byTitle, byCode]) {
      expect(r.isError, r.text).toBe(false);
      expect((r.envelope.data.course as { title: string }).title).toBe('データベースシステム論');
    }
  });

  it('an unknown course is an error result, not a crash', async () => {
    const r = await call('get_course', { courseOfferingId: '存在しない科目xyz' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not_found');
    const r2 = await call('get_course', { courseOfferingId: 'courseOffering:does-not-exist' });
    expect(r2.isError).toBe(true);
  });

  it('a course filter is resolved for other tools too', async () => {
    const r = await call('get_assignments', { courseOfferingId: 'データベース' });
    expect(r.isError, r.text).toBe(false);
    const items = r.envelope.data.assignments as { course?: { title: string } }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.course?.title === 'データベースシステム論')).toBe(true);
  });
});

describe('assignments and tasks', () => {
  it('get_assignments matches buildAssignments and carries citations per item', async () => {
    const { envelope } = await call('get_assignments');
    const direct = buildAssignments(uc);
    const items = envelope.data.assignments as { taskId: string; citations: unknown[] }[];
    expect(items.map((i) => i.taskId)).toEqual(direct.map((i) => i.taskId));
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.citations.length > 0)).toBe(true);
  });

  it('includeCompleted widens the default (open-only) list; status filters narrow it', async () => {
    const open = (await call('get_assignments')).envelope.data.assignments as { status: string }[];
    const all = (await call('get_assignments', { includeCompleted: true })).envelope.data
      .assignments as { status: string }[];
    expect(all.length).toBeGreaterThanOrEqual(open.length);
    expect(open.every((a) => ['pending', 'in_progress', 'unknown'].includes(a.status))).toBe(true);
    const submitted = (await call('get_assignments', { status: 'submitted' })).envelope.data
      .assignments as { status: string }[];
    expect(submitted.every((a) => a.status === 'submitted')).toBe(true);
    const many = await call('get_tasks', { status: ['pending', 'submitted'] });
    expect(
      (many.envelope.data.tasks as { status: string }[]).every((t) =>
        ['pending', 'submitted'].includes(t.status),
      ),
    ).toBe(true);
  });

  it('rejects an unknown status', async () => {
    expect((await call('get_tasks', { status: 'done' })).isError).toBe(true);
  });
});

describe('invalid arguments become error results', () => {
  it('rejects out-of-range and malformed arguments', async () => {
    for (const [name, args] of [
      ['get_deadlines', { days: -3 }],
      ['get_deadlines', { days: 'soon' }],
      ['get_course', {}],
      ['search', { query: '' }],
      ['review_class', { date: '10/1' }],
      ['get_recent_changes', { since: 'not a date' }],
      ['get_source', {}],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text.length).toBeGreaterThan(0);
    }
  });

  it('an unknown tool is a protocol error, not a server crash', async () => {
    const r = await client.callTool({ name: 'delete_everything', arguments: {} }).catch((e) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError === true).toBe(true);
    expect((await call('get_today')).isError).toBe(false);
  });
});

describe('search and get_source', () => {
  it('search returns hits with citations', async () => {
    const { envelope } = await call('search', { query: '正規化', limit: 5 });
    const hits = (envelope.data as { hits: { citations: unknown[] }[] }).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits.some((h) => h.citations.length > 0)).toBe(true);
  });

  it('get_source resolves a citation id from another result', async () => {
    const today = (await call('get_today')).envelope;
    const cite = today.citations.find((c) => c.rawItemId) ?? today.citations[0];
    expect(cite).toBeTruthy();
    const r = await call('get_source', { sourceReferenceId: cite?.sourceReferenceId });
    expect(r.isError, r.text).toBe(false);
    const data = r.envelope.data as {
      reference: { id: string };
      citation: { sourceReferenceId: string; label: string };
      rawItem?: { id: string; payloadFields?: string[] };
    };
    expect(data.reference.id).toBe(cite?.sourceReferenceId);
    expect(data.citation.label).toBe(cite?.label);
    expect(r.envelope.citations.some((c) => c.sourceReferenceId === cite?.sourceReferenceId)).toBe(
      true,
    );
    if (cite?.rawItemId) {
      expect(data.rawItem?.id).toBe(cite.rawItemId);
      // the same lookup by rawItemId and by the citationId alias
      const byRaw = await call('get_source', { rawItemId: cite.rawItemId });
      expect(byRaw.isError, byRaw.text).toBe(false);
      const byAlias = await call('get_source', { citationId: cite.sourceReferenceId });
      expect((byAlias.envelope.data as { reference: { id: string } }).reference.id).toBe(
        cite.sourceReferenceId,
      );
    }
  });

  it('redacts secrets and truncates big raw payloads; sourcesInfo hook is redacted too', async () => {
    const sourceId = uc.sync.sources()[0]?.sourceId ?? 'lcu';
    const big = 'x'.repeat(6000);
    const { item } = uc.sync.stores.raw.upsertItem(sourceId, {
      sourceType: 'test.payload',
      externalId: 'secret-1',
      payload: {
        title: 'visible',
        accessToken: 'super-secret-token-value',
        header: 'Authorization: Bearer abc.def.ghi',
        big,
      },
    });
    const ref = uc.sync.stores.sourceRefs.upsert({
      id: stableId('sourceReference', item.id, 'test'),
      sourceSystem: 'test',
      authority: 'lms',
      sourceItemId: 'secret-1',
      retrievedAt: '2026-10-01T00:00:00.000Z',
      rawItemId: item.id,
      url: 'https://example.invalid/page?token=abc123&x=1',
    });
    const r = await call('get_source', { sourceReferenceId: ref.id });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain('super-secret-token-value');
    expect(r.text).not.toContain('abc.def.ghi');
    expect(r.text).not.toContain('abc123');
    expect(r.text).not.toContain('should-be-redacted');
    expect(r.text).toContain('[REDACTED]');
    expect(r.text).toContain('daemon-supplied');
    const raw = (r.envelope.data as { rawItem: Record<string, unknown> }).rawItem;
    expect(raw.payloadTruncated).toBe(true);
    expect(String(raw.payloadPreview).length).toBeLessThanOrEqual(4000);
    expect(raw.payloadFields).toEqual(expect.arrayContaining(['title', 'accessToken', 'big']));
  });

  it('unknown ids are error results', async () => {
    expect((await call('get_source', { sourceReferenceId: 'sourceReference:nope' })).isError).toBe(
      true,
    );
    expect((await call('get_source', { rawItemId: 'raw:nope' })).isError).toBe(true);
  });
});

describe('class tools', () => {
  it('prepare_for_class and review_class accept a fuzzy course title', async () => {
    const prep = await call('prepare_for_class', { courseOfferingId: 'データベース' });
    expect(prep.isError, prep.text).toBe(false);
    expect(prep.envelope.data.view).toBe('class-preparation');
    const review = await call('review_class', {
      courseOfferingId: 'データベース',
      date: '2026-09-24',
    });
    expect(review.isError, review.text).toBe(false);
    expect(review.envelope.data.view).toBe('class-review');
  });
});

describe('correct_fact is propose-only (§50, §74)', () => {
  it('creates a pending proposal and changes nothing until applyProposal', async () => {
    const factsBefore = uc.resolver.facts.history(dbCourse, 'room').length;
    const todayBefore = uc.context.today();
    const roomBefore = todayBefore.classes.find((c) => c.course.id === dbCourse)?.room;
    expect(roomBefore?.status).toBe('conflict');

    const r = await call('correct_fact', {
      subject: dbCourse,
      predicate: 'room',
      value: '情報学部2号館21教室',
      note: '掲示で確認',
    });
    expect(r.isError, r.text).toBe(false);
    const data = r.envelope.data as {
      proposalId: string;
      status: string;
      preview: string;
      howToConfirm: string;
      applied: boolean;
    };
    expect(data.status).toBe('pending');
    expect(data.applied).toBe(false);
    expect(data.proposalId).toMatch(/^p_/);
    expect(data.preview).toContain('21教室');
    expect(data.howToConfirm).toBe(
      'unicontext confirm <id> を実行するか Web UI の確認待ちで承認してください',
    );
    expect(r.envelope.answerHint).toContain('何も変更されていません');

    // nothing was written
    expect(uc.resolver.facts.history(dbCourse, 'room').length).toBe(factsBefore);
    expect(uc.resolver.listConflicts({ status: 'open' }).some((c) => c.predicate === 'room')).toBe(
      true,
    );
    const stillConflict = uc.context.today().classes.find((c) => c.course.id === dbCourse)?.room;
    expect(stillConflict?.status).toBe('conflict');
    const pending = proposals.list({ status: 'pending' });
    expect(pending.map((p) => p.id)).toContain(data.proposalId);
    expect(pending.find((p) => p.id === data.proposalId)?.createdBy).toBe('mcp:contract-test');

    // the user confirms (CLI / Web UI path)
    const applied = applyProposal(uc, proposals, data.proposalId);
    expect(applied.proposal.status).toBe('confirmed');
    expect(applied.fact.origin).toBe('user');
    expect(applied.fact.value).toBe('情報学部2号館21教室');

    const after = uc.context.today().classes.find((c) => c.course.id === dbCourse)?.room;
    expect(after?.status).toBe('resolved');
    expect(after?.value).toBe('情報学部2号館21教室');
    expect(after?.origin).toBe('user');
    expect(uc.resolver.resolve(dbCourse, 'room').origin).toBe('user');

    // a confirmed proposal cannot be applied twice
    expect(() => applyProposal(uc, proposals, data.proposalId)).toThrow();
    // and the MCP view now reports no room conflict for it
    const today = (await call('get_today')).envelope;
    expect(today.conflicts.some((c) => c.includes('11教室') && c.includes('21教室'))).toBe(false);
  });

  it('accepts a course title as subject and records the proposal with a readable preview', async () => {
    const r = await call('correct_fact', {
      subject: '線形代数',
      predicate: 'room',
      value: '共通教育A棟302',
    });
    expect(r.isError, r.text).toBe(false);
    const data = r.envelope.data as { proposalId: string; preview: string };
    expect(data.preview).toContain('線形代数学II');
    expect(proposals.get(data.proposalId)?.subject).toContain('courseOffering:');
    proposals.reject(data.proposalId);
    expect(() => applyProposal(uc, proposals, data.proposalId)).toThrow();
  });

  it('refuses grade / submission / enrolment predicates (§51)', async () => {
    const before = proposals.list().length;
    for (const predicate of [
      'grade',
      'grade_letter',
      'submission_status',
      'enrollment_status',
      'final_grade',
      'courseGrade',
      'assignment.submission',
      'task_submitted',
      'course_registration',
      'exam_score',
    ]) {
      const r = await call('correct_fact', { subject: dbCourse, predicate, value: 'A' });
      expect(r.isError, predicate).toBe(true);
      expect(r.text).toContain('not allowed');
    }
    expect(proposals.list().length).toBe(before);
  });

  it('tool error text is redacted before it reaches the AI client (§60)', async () => {
    const r = await call('correct_fact', {
      subject: 'courseOffering:x access_token=SECRETVALUE123',
      predicate: 'room',
      value: 'x',
    });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('SECRETVALUE123');
  });

  it('rejects unknown subjects, bad predicates and non-JSON values', async () => {
    const before = proposals.list().length;
    expect(
      (
        await call('correct_fact', {
          subject: 'courseOffering:nope',
          predicate: 'room',
          value: 'x',
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call('correct_fact', { subject: dbCourse, predicate: 'a b!', value: 'x' })).isError,
    ).toBe(true);
    expect((await call('correct_fact', { subject: dbCourse, predicate: 'room' })).isError).toBe(
      true,
    );
    expect(proposals.list().length).toBe(before);
  });
});

describe('propose_pace_slot is propose-only (§50)', () => {
  const slotsOf = (): string[] =>
    uc.tasks.schedule.paceSlots([dbCourse]).map((s) => `${s.dayOfWeek}:${s.startTime}`);

  it('creates a pace_slots proposal that confirm applies as a user fact', async () => {
    const before = uc.resolver.facts.history(dbCourse, 'pace_slots').length;
    const r = await call('propose_pace_slot', {
      course: dbCourse,
      slots: ['土 10:00-11:30', '水2限'],
    });
    expect(r.isError, r.text).toBe(false);
    const data = r.envelope.data as {
      proposalId: string;
      status: string;
      applied: boolean;
      preview: string;
      howToConfirm: string;
    };
    expect(data).toMatchObject({ status: 'pending', applied: false });
    expect(data.preview).toContain('土 10:00-11:30');
    expect(data.howToConfirm).toContain('unicontext confirm');
    expect(r.envelope.answerHint).toContain('何も変更されていません');

    // nothing is written until the user confirms
    expect(uc.resolver.facts.history(dbCourse, 'pace_slots').length).toBe(before);
    expect(slotsOf()).toEqual([]);
    const proposal = proposals.get(data.proposalId);
    expect(proposal).toMatchObject({
      status: 'pending',
      kind: 'correct_fact',
      subject: dbCourse,
      predicate: 'pace_slots',
    });
    expect(proposal?.createdBy).toBe('mcp:contract-test');

    // pace_slots is not high-risk: the user's confirmation applies it
    const applied = applyProposal(uc, proposals, data.proposalId);
    expect(applied.proposal.status).toBe('confirmed');
    expect(applied.fact.origin).toBe('user');
    expect(slotsOf()).toEqual(['3:10:20', '6:10:00']);
    expect(uc.tasks.schedule.paceSlots([dbCourse]).map((s) => s.period)).toEqual([2, undefined]);
  });

  it('an empty list proposes clearing the slots', async () => {
    const r = await call('propose_pace_slot', { course: '線形代数', slots: [] });
    expect(r.isError, r.text).toBe(false);
    const data = r.envelope.data as { proposalId: string; preview: string };
    expect(data.preview).toContain('解除');
    expect(proposals.get(data.proposalId)?.value).toEqual({ slots: [] });
    proposals.reject(data.proposalId);
  });

  it('rejects unreadable slots and unknown courses without creating a proposal', async () => {
    const before = proposals.list().length;
    expect((await call('propose_pace_slot', { course: dbCourse, slots: ['いつか'] })).isError).toBe(
      true,
    );
    expect(
      (
        await call('propose_pace_slot', {
          course: 'courseOffering:nope',
          slots: ['土 10:00-11:30'],
        })
      ).isError,
    ).toBe(true);
    expect(proposals.list().length).toBe(before);
  });
});

describe('MCP resources (§40)', () => {
  it('lists the fixed resources', async () => {
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    for (const u of ['today', 'week', 'tomorrow', 'deadline', 'changes', 'admin'])
      expect(uris).toContain(`unicontext://${u}`);
  });

  it('lists courses for the course template and the three templates', async () => {
    const { resources } = await client.listResources();
    const courses = resources.filter((r) => r.uri.startsWith('unicontext://course/'));
    expect(courses.map((c) => c.name)).toEqual(
      expect.arrayContaining(['データベースシステム論', '線形代数学II', 'プログラミング演習']),
    );
    const t = (await client.listResourceTemplates()).resourceTemplates.map((x) => x.uriTemplate);
    expect(t).toEqual(
      expect.arrayContaining([
        'unicontext://course/{id}',
        'unicontext://lecture/{id}',
        'unicontext://document/{id}',
      ]),
    );
  });

  it('reads today and week as the same envelope with citations', async () => {
    const today = await readJson('unicontext://today');
    expect(today.data.view).toBe('today');
    expect(today.citations.length).toBeGreaterThan(0);
    expect(Object.keys(today).sort()).toEqual(['answerHint', 'citations', 'conflicts', 'data']);
    const week = await readJson('unicontext://week');
    expect(week.data.view).toBe('week');
    for (const name of ['tomorrow', 'deadline', 'changes', 'admin'])
      expect((await readJson(`unicontext://${name}`)).data.view).toBe(name);
  });

  it('reads a course through the template, using a listed uri', async () => {
    const { resources } = await client.listResources();
    const course = resources.find((r) => r.name === 'データベースシステム論');
    expect(course).toBeTruthy();
    const env = await readJson(course?.uri ?? '');
    expect((env.data.course as { title: string }).title).toBe('データベースシステム論');
    expect(env.citations.length).toBeGreaterThan(0);
  });

  it('reads a lecture and a document with citations', async () => {
    const lecture = uc.sync.stores.entities.list('lecture')[0];
    expect(lecture).toBeTruthy();
    const l = await readJson(`unicontext://lecture/${encodeURIComponent(lecture?.id ?? '')}`);
    expect(l.data.date).toBe(lecture?.date);
    expect(l.citations.length).toBeGreaterThan(0);

    const doc = uc.sync.stores.entities.list('document')[0];
    expect(doc).toBeTruthy();
    const d = await readJson(`unicontext://document/${encodeURIComponent(doc?.id ?? '')}`);
    expect((d.data.document as { title: string }).title).toBe(doc?.title);
    expect(typeof d.data.excerpt).toBe('string');
    expect(d.citations.length).toBeGreaterThan(0);
  });

  it('unknown resources reject instead of crashing the server', async () => {
    await expect(
      client.readResource({ uri: 'unicontext://course/courseOffering:nope' }),
    ).rejects.toThrow();
    await expect(
      client.readResource({ uri: 'unicontext://document/document:nope' }),
    ).rejects.toThrow();
    await expect(
      client.readResource({ uri: 'unicontext://lecture/lecture:nope' }),
    ).rejects.toThrow();
    expect((await call('get_today')).isError).toBe(false);
  });
});

describe('announcements (LiveCampusU notices)', () => {
  const read = stableId('announcement', 'lcu', 'mcp-read');
  const unread = stableId('announcement', 'lcu', 'mcp-unread');
  const entities = (): typeof uc.sync.stores.entities => uc.sync.stores.entities;

  beforeAll(() => {
    entities().upsert({
      id: read,
      kind: 'announcement',
      title: 'MCPテスト既読のお知らせ',
      body: `詳細は https://example.com/x を参照
${'あ'.repeat(500)}`,
      publishedAt: '2026-09-30T05:00:00Z',
      authorName: '教務課',
      category: '教務',
      scope: 'university',
      extra: {
        read: true,
        bodyStatus: 'fetched',
        attachments: [{ name: '案内.pdf', size: 2048 }],
        links: ['https://example.com/x'],
        targetDate: '2026-10-05',
      },
    });
    entities().upsert({
      id: unread,
      kind: 'announcement',
      title: 'MCPテスト未読のお知らせ',
      body: '',
      publishedAt: '2026-09-30T06:00:00Z',
      scope: 'university',
      extra: { read: false, bodyStatus: 'notOpened' },
    });
  });
  afterAll(() => {
    entities().hardDelete(read);
    entities().hardDelete(unread);
  });

  it('get_announcements lists newest first with read state and truncated bodies', async () => {
    const r = await call('get_announcements', { since: '2026-09-30', limit: 100 });
    expect(r.isError, r.text).toBe(false);
    const list = r.envelope.data.announcements as {
      id: string;
      read?: boolean;
      bodyStatus?: string;
      body: string;
      attachments: unknown[];
    }[];
    const ids = list.map((a) => a.id);
    expect(ids.indexOf(unread)).toBeLessThan(ids.indexOf(read));
    const a = list.find((x) => x.id === read);
    expect(a).toMatchObject({
      read: true,
      bodyStatus: 'fetched',
      attachments: [{ name: '案内.pdf', size: 2048 }],
    });
    expect(a?.body.length).toBeLessThanOrEqual(401);
    const unreadOnly = await call('get_announcements', { unreadOnly: true });
    expect((unreadOnly.envelope.data.announcements as { id: string }[]).map((x) => x.id)).toContain(
      unread,
    );
    expect(
      (unreadOnly.envelope.data.announcements as { id: string }[]).map((x) => x.id),
    ).not.toContain(read);
    expect((await call('get_announcements', { limit: 101 })).isError).toBe(true);
    expect((await call('get_announcements', { since: 'not a date' })).isError).toBe(true);
  });

  it('get_announcement returns the full body and details; unknown ids are errors', async () => {
    const r = await call('get_announcement', { id: read });
    expect(r.isError, r.text).toBe(false);
    const d = r.envelope.data.announcement as Record<string, unknown>;
    expect((d.body as string).length).toBeGreaterThan(500);
    expect(d).toMatchObject({
      links: ['https://example.com/x'],
      targetDate: '2026-10-05',
      author: '教務課',
      category: '教務',
    });
    const u = await call('get_announcement', { id: unread });
    expect(u.envelope.data.announcement).toMatchObject({
      read: false,
      bodyStatus: 'notOpened',
      body: '',
    });
    expect((await call('get_announcement', { id: 'announcement:nope' })).text).toContain(
      'not_found',
    );
    expect((await call('get_announcement', { id: 'document:nope' })).isError).toBe(true);
  });

  it('search announcement hits carry the entity id', async () => {
    const r = await call('search', { query: 'MCPテスト既読' });
    const hits = r.envelope.data.hits as { id: string; kind: string }[];
    expect(hits.find((h) => h.kind === 'announcement')?.id).toBe(read);
  });
});

describe('source hygiene', () => {
  it('never calls console.log in the server sources (stdout belongs to the protocol)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = path.join(import.meta.dirname, '..', 'src');
    for (const f of readdirSync(dir)) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/console\.(log|info|debug)\s*\(/);
      expect(text, f).not.toMatch(/process\.stdout\.write/);
    }
  });
});
