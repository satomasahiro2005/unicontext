import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DeadlineCoverage } from '@unicontext/context-engine';
import { describe, expect, it } from 'vitest';
import {
  createMcpServer,
  ProposalStore,
  REMOTE_SERVER_INSTRUCTIONS,
  REMOTE_WRITE_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
} from '../src/index.js';
import { createSeeded } from './seeded.js';

interface Envelope {
  data: { coverage?: DeadlineCoverage };
  answerHint: string;
}

describe('deadline coverage in the AI views', () => {
  it('every server variant tells the AI that a missing deadline is not "no deadline"', () => {
    for (const text of [
      SERVER_INSTRUCTIONS,
      REMOTE_SERVER_INSTRUCTIONS,
      REMOTE_WRITE_SERVER_INSTRUCTIONS,
    ]) {
      expect(text).toContain('締切が無いことを意味しません');
      expect(text).toContain('「期限はない」「余裕がある」と言ってはいけません');
      expect(text).toContain('absence in UniContext does not mean there is none');
    }
  });

  it('get_deadlines / get_today / get_week / get_course carry coverage and flag a down source', async () => {
    const { uc } = await createSeeded();
    const tmp = mkdtempSync(path.join(tmpdir(), 'uc-cov-'));
    const server = createMcpServer({
      uc,
      proposals: new ProposalStore(path.join(tmp, 'p'), { clock: uc.clock }),
    });
    const client = new Client({ name: 't', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<Envelope> => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { text: string }[])[0]?.text ?? '';
      expect(res.isError, text).not.toBe(true);
      return JSON.parse(text) as Envelope;
    };

    const tools: [string, Record<string, unknown>][] = [
      ['get_deadlines', {}],
      ['get_today', {}],
      ['get_week', {}],
      ['get_course', { courseOfferingId: 'データベース' }],
    ];
    for (const [name, args] of tools) {
      const env = await call(name, args);
      expect(env.data.coverage, name).toBeDefined();
      expect(env.data.coverage?.sources.length, name).toBeGreaterThan(0);
    }

    // the LMS stops answering: every view says so and warns against "no deadline"
    const lms = uc.sync
      .sources()
      .find((s) => s.metadata.capabilities.includes('assignments'))?.sourceId;
    expect(lms).toBeDefined();
    uc.sync.stores.health.set(lms as string, {
      state: 'auth_required',
      checkedAt: uc.clock.now().toISOString(),
      lastSuccessAt: '2026-09-30T00:00:00.000Z',
      consecutiveFailures: 3,
    });
    for (const [name, args] of tools) {
      const env = await call(name, args);
      const cov = env.data.coverage as DeadlineCoverage;
      expect(cov.complete, name).toBe(false);
      expect(cov.gaps.some((g) => g.kind === 'source_unhealthy' && g.sourceId === lms)).toBe(
        name !== 'get_course' || cov.sources.some((s) => s.sourceId === lms),
      );
      if (cov.gaps.some((g) => g.kind === 'source_unhealthy'))
        expect(env.answerHint, name).toContain(
          '「締切はない」「余裕がある」とは言わないでください',
        );
    }
    await client.close();
    await server.close();
    await uc.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
