import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanonicalEntitySchema } from '@unicontext/canonical-model';
import {
  AuthRequiredError,
  ConfigError,
  ConnectorError,
  OfflineError,
  type SecretStore,
} from '@unicontext/core';
import {
  createNormalizeContext,
  instantiateConnector,
  type RawItem,
  type RawItemView,
  type SourceAdapter,
  type SyncResult,
} from '@unicontext/connector-sdk';
import { testConnectorCompliance } from '@unicontext/connector-sdk/testing';
import {
  createMappedNormalizer,
  loadMappingFile,
  type MappingSpec,
  parseMappingSpec,
} from '@unicontext/mapping';
import { describe, expect, it } from 'vitest';
import {
  CliConfigSchema,
  CliSourceAdapter,
  cliConnector,
  cliMetadata,
  commandExists,
  createCliConnector,
  MAPPINGS_DIR,
  parseOutput,
  runCommand,
  type CliConfigInput,
} from '../src/index.js';
import cliDefault from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'fixtures', 'fake-cli.mjs');

class MemorySecrets implements SecretStore {
  readonly backend = 'memory';
  constructor(private readonly map = new Map<string, string>()) {}
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
}

const edSpec = (): MappingSpec => loadMappingFile(join(MAPPINGS_DIR, 'edstem-cli.yaml'));

/** A one-resource mapping around a single fake-cli command. */
function simpleSpec(
  call: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): MappingSpec {
  return parseMappingSpec({
    id: 'simple',
    product: 'simple',
    capabilities: ['courses'],
    resources: [
      {
        name: 'items',
        call,
        select: '$',
        sourceType: 'simple.item',
        externalId: '$string(id)',
        ...extra,
      },
    ],
  });
}

function adapterFor(
  spec: MappingSpec,
  config: Partial<CliConfigInput> = {},
  secrets: SecretStore = new MemorySecrets(),
): CliSourceAdapter {
  return new CliSourceAdapter({
    sourceId: 'src',
    spec,
    config: CliConfigSchema.parse({
      command: process.execPath,
      args: [SCRIPT],
      timeoutMs: 20000,
      ...config,
    }),
    secrets,
  });
}

async function syncAll(adapter: SourceAdapter): Promise<{ items: RawItem[]; pages: SyncResult[] }> {
  const pages: SyncResult[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await adapter.sync({ mode: 'initial', ...(pageToken ? { pageToken } : {}) });
    pages.push(res);
    if (!res.hasMore) break;
    pageToken = res.nextPageToken;
  }
  return { items: pages.flatMap((p) => p.items), pages };
}

describe('parseOutput', () => {
  it('parses json and jsonl, tolerating BOM and blank lines', () => {
    expect(parseOutput('﻿[{"a":1}]', 'json')).toEqual([{ a: 1 }]);
    expect(parseOutput('{"a":1}\n\n{"a":2}\r\n', 'jsonl')).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it('rejects bad json, bad jsonl lines and empty output', () => {
    expect(() => parseOutput('nope', 'json', 'tool')).toThrow(/did not print valid JSON/);
    expect(() => parseOutput('{"a":1}\nnope', 'jsonl', 'tool')).toThrow(/line 2/);
    expect(() => parseOutput('  \n', 'json', 'tool')).toThrow(/no output/);
  });
});

describe('runCommand', () => {
  const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };

  it('passes arguments as separate argv entries (no shell)', async () => {
    const nasty = ['a b', '$(echo pwned)', '; echo pwned', '"quoted"', '*', '`x`', 'ü'];
    const r = await runCommand({
      command: process.execPath,
      args: [SCRIPT, 'argv', ...nasty],
      env,
      timeoutMs: 20000,
    });
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { argv: string[] }[])[0]?.argv).toEqual(nasty);
  });

  it('kills a process that exceeds the timeout', async () => {
    const started = Date.now();
    await expect(
      runCommand({ command: process.execPath, args: [SCRIPT, 'slow'], env, timeoutMs: 300 }),
    ).rejects.toThrow(/timed out after 300 ms/);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('kills a process that prints more than the output cap', async () => {
    await expect(
      runCommand({
        command: process.execPath,
        args: [SCRIPT, 'big'],
        env,
        timeoutMs: 20000,
        maxOutputBytes: 100_000,
      }),
    ).rejects.toThrow(/more than 100000 bytes/);
  });

  it('reports exit code and stderr tail, and supports stdin', async () => {
    const r = await runCommand({
      command: process.execPath,
      args: [SCRIPT, 'fail'],
      env,
      timeoutMs: 20000,
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('boom');
    const s = await runCommand({
      command: process.execPath,
      args: [SCRIPT, 'stdin'],
      env,
      timeoutMs: 20000,
      stdin: 'héllo',
    });
    expect(JSON.parse(s.stdout)).toEqual([{ id: 'stdin', received: 'héllo' }]);
  });

  it('maps a missing program to OfflineError and honours abort', async () => {
    await expect(
      runCommand({ command: 'definitely-not-a-real-binary-xyz', args: [], env, timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(OfflineError);
    const ac = new AbortController();
    const p = runCommand({
      command: process.execPath,
      args: [SCRIPT, 'slow'],
      env,
      timeoutMs: 20000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      runCommand({
        command: process.execPath,
        args: [SCRIPT, 'slow'],
        env,
        timeoutMs: 20000,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('commandExists finds node and rejects unknown names', () => {
    expect(commandExists(process.execPath)).toBe(true);
    expect(commandExists('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});

describe('CliConfigSchema', () => {
  it('requires a command and keeps credentials out of env', () => {
    expect(CliConfigSchema.safeParse({}).success).toBe(false);
    const ok = CliConfigSchema.parse({ command: 'edstem' });
    expect(ok.timeoutMs).toBe(60000);
    expect(ok.maxOutputBytes).toBe(10 * 1024 * 1024);
    expect(CliConfigSchema.safeParse({ command: 'x', env: { API_TOKEN: 'abc' } }).success).toBe(
      false,
    );
    expect(
      CliConfigSchema.safeParse({ command: 'x', envSecrets: [{ name: 'API_TOKEN', secret: 't' }] })
        .success,
    ).toBe(true);
    expect(CliConfigSchema.safeParse({ command: 'x', authErrorPattern: '(' }).success).toBe(false);
  });
});

describe('edstem-cli mapping end to end', () => {
  it('syncs through a real child process and normalizes to canonical entities', async () => {
    const adapter = adapterFor(edSpec());
    expect(await adapter.capabilities()).toEqual(['courses', 'announcements', 'messages']);
    expect((await adapter.authenticate()).status).toBe('not_required');
    const { items, pages } = await syncAll(adapter);
    expect(items.map((i) => `${i.sourceType}:${i.externalId}`).sort()).toEqual([
      'edstem.course:55',
      'edstem.thread:1',
      'edstem.thread:2',
      'edstem.thread_detail:2',
    ]);
    expect(pages.at(-1)?.complete?.sourceTypes).toEqual(['edstem.course']);

    const normalizer = createMappedNormalizer(edSpec());
    const ctx = createNormalizeContext({
      sourceId: 'src',
      sourceSystem: 'edstem',
      timezone: 'Asia/Tokyo',
    });
    const kinds: string[] = [];
    const authorities: Record<string, string | undefined> = {};
    for (const item of items) {
      const view: RawItemView = {
        id: `raw:${item.externalId}`,
        sourceId: 'src',
        sourceType: item.sourceType,
        externalId: item.externalId,
        payload: item.payload,
        fetchedAt: '2026-10-01T00:00:00.000Z',
        sourceUpdatedAt: item.sourceUpdatedAt,
        contentHash: 'h',
      };
      const out = await normalizer.normalize(view, ctx);
      expect(out.warnings).toEqual([]);
      for (const e of out.entities) {
        expect(CanonicalEntitySchema.safeParse(e.entity).success).toBe(true);
        kinds.push(e.entity.kind);
        authorities[`${item.sourceType}:${item.externalId}:${e.entity.kind}`] = e.ref?.authority;
      }
    }
    expect(kinds.sort()).toEqual([
      'announcement',
      'courseOffering',
      'message',
      'message',
      'message',
      'thread',
    ]);
    expect(authorities['edstem.thread:1:announcement']).toBe('instructor-announcement');
    expect(authorities['edstem.thread:2:message']).toBe('discussion');
    await adapter.dispose();
  });

  it('is described by connector metadata', async () => {
    const mod = createCliConnector(edSpec());
    expect(mod.metadata).toMatchObject({
      product: 'edstem',
      adapter: 'cli',
      apiStability: 'experimental',
      risk: 'experimental',
    });
    expect(cliMetadata.adapter).toBe('cli');
    expect(typeof cliDefault).toBe('function');
    await expect(cliDefault({ sourceId: 's', config: {} })).resolves.toBe(cliConnector);
    const fromMapping = await cliDefault({ sourceId: 's', config: { mapping: 'edstem-cli' } });
    expect(fromMapping.metadata.product).not.toBe(cliConnector.metadata.product);
  });
});

describe('failure handling', () => {
  it('non-zero exit becomes a ConnectorError with a redacted stderr tail', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['fail'] }));
    const err = await adapter.sync({ mode: 'initial' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    const msg = (err as Error).message;
    expect(msg).toContain('exited with code 3');
    expect(msg).toContain('boom');
    expect(msg).not.toContain('abc123');
    expect((err as ConnectorError).details).toMatchObject({ code: 3 });
  });

  it('okExitCodes can accept non-zero exits', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['fail'], okExitCodes: [0, 3] }));
    await expect(adapter.sync({ mode: 'initial' })).rejects.toThrow(
      /did not print valid JSON|no output/,
    );
  });

  it('recognizes "not logged in" as auth_required', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['login'] }));
    await expect(adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
    const custom = adapterFor(simpleSpec({ args: ['fail'] }), { authErrorPattern: 'boom' });
    await expect(custom.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('fails on invalid JSON and empty output', async () => {
    await expect(
      adapterFor(simpleSpec({ args: ['badjson'] })).sync({ mode: 'initial' }),
    ).rejects.toThrow(/valid JSON/);
    await expect(
      adapterFor(simpleSpec({ args: ['empty'] })).sync({ mode: 'initial' }),
    ).rejects.toThrow(/no output/);
  });

  it('kills slow commands (timeoutMs) and huge outputs (maxOutputBytes)', async () => {
    await expect(
      adapterFor(simpleSpec({ args: ['slow'] }), { timeoutMs: 300 }).sync({ mode: 'initial' }),
    ).rejects.toThrow(/timed out/);
    await expect(
      adapterFor(simpleSpec({ args: ['big'] }), { maxOutputBytes: 50_000 }).sync({
        mode: 'initial',
      }),
    ).rejects.toThrow(/more than 50000 bytes/);
  });

  it('a missing command is offline: sync throws OfflineError, health says offline', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['courses'] }), {
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
    });
    await expect(adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(OfflineError);
    expect(await adapter.health()).toMatchObject({
      state: 'offline',
      message: expect.stringContaining('not found'),
    });
  });

  it('rejects invalid call blocks with a ConfigError', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['courses'], format: 'xml' }));
    await expect(adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('health', () => {
  it('is healthy and reports the detected version when healthArgs print one', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['courses'] }), { healthArgs: ['--version'] });
    expect(await adapter.health()).toMatchObject({ state: 'healthy', detectedVersion: '1.2.3' });
    expect(await adapter.detectProductVersion()).toEqual({ product: 'simple', version: '1.2.3' });
  });
  it('is degraded when the health invocation fails', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['courses'] }), { healthArgs: ['badversion'] });
    expect(await adapter.health()).toMatchObject({
      state: 'degraded',
      message: expect.stringContaining('code 2'),
    });
  });
  it('is healthy without healthArgs when the command exists', async () => {
    expect((await adapterFor(simpleSpec({ args: ['courses'] })).health()).state).toBe('healthy');
  });
});

describe('credentials and environment', () => {
  it('injects envSecrets and literal env, but nothing else from the host', async () => {
    process.env.UC_HOST_ONLY = 'must-not-leak';
    const secrets = new MemorySecrets();
    await secrets.set('src/tok', 'S3CRET');
    try {
      const adapter = adapterFor(
        simpleSpec({ args: ['env'] }),
        {
          env: { UC_TEST_LITERAL: 'lit' },
          envSecrets: [{ name: 'UC_TEST_SECRET', secret: 'tok' }],
        },
        secrets,
      );
      expect((await adapter.authenticate()).status).toBe('authenticated');
      const { items } = await syncAll(adapter);
      expect(items[0]?.payload).toMatchObject({
        injected: 'S3CRET',
        literal: 'lit',
        hostOnly: null,
      });
      // inherit by name
      const inherit = adapterFor(simpleSpec({ args: ['env'] }), { env: ['UC_HOST_ONLY'] });
      expect((await syncAll(inherit)).items[0]?.payload).toMatchObject({
        hostOnly: 'must-not-leak',
      });
    } finally {
      delete process.env.UC_HOST_ONLY;
    }
  });

  it('reports auth_required when a named secret is missing', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['env'] }), {
      envSecrets: { UC_TEST_SECRET: 'missing' },
    });
    expect((await adapter.authenticate()).status).toBe('auth_required');
    await expect(adapter.sync({ mode: 'initial' })).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('templating and call options', () => {
  it('keeps template values as single argv entries and refuses option-like values', async () => {
    const spec = parseMappingSpec({
      id: 's',
      product: 's',
      capabilities: ['courses'],
      resources: [
        {
          name: 'parents',
          call: { args: ['courses'] },
          sourceType: 's.parent',
          externalId: '$string(id)',
        },
        {
          name: 'kids',
          forEach: { resource: 'parents', as: 'p' },
          call: { args: ['argv', '{{p.name}}', 'id={{p.id}}'] },
          sourceType: 's.kid',
          externalId: '$string(id)',
        },
      ],
    });
    const ok = adapterFor(spec);
    const { items } = await syncAll(ok);
    const kid = items.find((i) => i.sourceType === 's.kid');
    expect((kid?.payload as { argv: string[] }).argv).toEqual(['Intro to CS', 'id=55']);

    // a hostile upstream value that starts with "-" must not become an option
    const hostileSpec = parseMappingSpec({
      id: 's',
      product: 's',
      capabilities: ['courses'],
      resources: [
        {
          name: 'parents',
          call: { args: ['dashy'] },
          sourceType: 's.parent',
          externalId: '$string(id)',
        },
        {
          name: 'kids',
          forEach: { resource: 'parents', as: 'p' },
          call: { args: ['argv', '{{p.name}}'] },
          sourceType: 's.kid',
          externalId: '$string(id)',
        },
      ],
    });
    const { items: hostileItems, pages } = await syncAll(adapterFor(hostileSpec));
    expect(hostileItems.filter((i) => i.sourceType === 's.kid')).toHaveLength(0);
    expect(pages.at(-1)?.warnings?.some((w) => /could be read as an option/.test(w))).toBe(true);
  });

  it('writes stdin (strings as-is, objects as JSON)', async () => {
    const a = adapterFor(simpleSpec({ args: ['stdin'], stdin: 'plain text' }));
    expect((await syncAll(a)).items[0]?.payload).toMatchObject({ received: 'plain text' });
    const b = adapterFor(simpleSpec({ args: ['stdin'], stdin: { q: 1 } }));
    expect((await syncAll(b)).items[0]?.payload).toMatchObject({ received: '{"q":1}' });
  });

  it('parses jsonl output', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['jsonl'], format: 'jsonl' }));
    const { items } = await syncAll(adapter);
    expect(items.map((i) => i.externalId)).toEqual(['55']);
  });

  it('follows cursor pagination (cursor argument appended to the original arguments)', async () => {
    const spec = simpleSpec(
      { args: ['paged'], paginate: { cursorArg: '--cursor', nextCursor: 'next' } },
      { select: 'items' },
    );
    const { items } = await syncAll(adapterFor(spec));
    expect(items.map((i) => i.externalId)).toEqual(['1', '2', '3']);
  });

  it('enforces the output cap per call and tracks no leftover processes after dispose', async () => {
    const adapter = adapterFor(simpleSpec({ args: ['slow'] }), { timeoutMs: 20000 });
    const run = adapter.sync({ mode: 'initial' }).catch((e: unknown) => e);
    setTimeout(() => void adapter.dispose(), 200);
    const res = await run;
    expect(res).toBeInstanceOf(Error);
  });
});

describe('connector module', () => {
  it('instantiates from config with the shipped mapping name', async () => {
    const inst = instantiateConnector(cliConnector, {
      sourceId: 'edstem',
      config: {
        adapter: 'cli',
        command: process.execPath,
        args: [SCRIPT],
        mapping: 'edstem-cli',
        timeoutMs: 20000,
      },
      secrets: new MemorySecrets(),
    });
    expect(inst.normalizer.id).toBe('mapped:edstem');
    const res = await inst.adapter.sync({ mode: 'initial' });
    expect(res.items.some((i) => i.sourceType === 'edstem.course')).toBe(true);
    await inst.adapter.dispose();
    expect(() =>
      instantiateConnector(cliConnector, {
        sourceId: 'x',
        config: {},
        secrets: new MemorySecrets(),
      }),
    ).toThrow(ConfigError);
    expect(() =>
      instantiateConnector(cliConnector, {
        sourceId: 'x',
        config: { command: 'x' },
        secrets: new MemorySecrets(),
      }).adapter.capabilities(),
    ).toThrow(/needs a "mapping"/);
  });
});

testConnectorCompliance('adapter-cli (edstem-cli mapping)', {
  metadata: createCliConnector(edSpec()).metadata,
  normalizer: createMappedNormalizer(edSpec()),
  createAdapter: () => adapterFor(edSpec()),
  rawFixtures: [],
});
