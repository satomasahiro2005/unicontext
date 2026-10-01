import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeConnector } from '@unicontext/connector-sdk';
import { parseConfig } from '@unicontext/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectorLoadError,
  loadConnectorModule,
  type ModuleImporter,
  resolveConnectorPackage,
} from '../src/registry.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

const notFound = (pkg: string): Error =>
  Object.assign(new Error(`Cannot find package '${pkg}' imported from /x`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });

describe('resolveConnectorPackage', () => {
  it('maps source keys to connector packages', () => {
    expect(resolveConnectorPackage('livecampusu', {}).packageName).toBe('@unicontext/livecampusu');
    expect(resolveConnectorPackage('microsoft365', {}).packageName).toBe(
      '@unicontext/microsoft365',
    );
    expect(resolveConnectorPackage('files', {}).packageName).toBe('@unicontext/local-files');
    expect(resolveConnectorPackage('syllabus', {}).packageName).toBe('@unicontext/syllabus');
    expect(resolveConnectorPackage('chatgpt-record', {}).packageName).toBe(
      '@unicontext/chatgpt-record',
    );
  });

  it('explicit connector: short names and full package names', () => {
    expect(resolveConnectorPackage('mine', { connector: 'livecampusu' }).packageName).toBe(
      '@unicontext/livecampusu',
    );
    expect(resolveConnectorPackage('mine', { connector: '@acme/unicontext-moodle' })).toEqual({
      packageName: '@acme/unicontext-moodle',
      via: 'explicit',
    });
    expect(resolveConnectorPackage('mine', { connector: 'moodle' }).packageName).toBe(
      '@unicontext/moodle',
    );
  });

  it('adapter: keys select the generic adapter packages', () => {
    expect(resolveConnectorPackage('edstem', { adapter: 'mcp' }).packageName).toBe(
      '@unicontext/adapter-mcp',
    );
    expect(resolveConnectorPackage('x', { adapter: 'cli' }).packageName).toBe(
      '@unicontext/adapter-cli',
    );
    expect(resolveConnectorPackage('x', { adapter: 'rest' }).packageName).toBe(
      '@unicontext/adapter-rest',
    );
    expect(resolveConnectorPackage('x', { adapter: 'browser' }).packageName).toBe(
      '@unicontext/adapter-browser',
    );
    expect(resolveConnectorPackage('notes', { adapter: 'filesystem' }).packageName).toBe(
      '@unicontext/local-files',
    );
  });

  it('falls back to the profile product for role-named sources, and to none', () => {
    const profile = { sources: { academic: { product: 'livecampusu' } } };
    expect(resolveConnectorPackage('academic', {}, profile).packageName).toBe(
      '@unicontext/livecampusu',
    );
    expect(resolveConnectorPackage('mystery', {}).packageName).toBeUndefined();
  });
});

describe('loadConnectorModule', () => {
  const fake = createFakeConnector({
    product: 'livecampusu',
    authority: 'academic-system',
    dataset: {},
  });

  it('loads a default export module', async () => {
    const importer: ModuleImporter = async () => ({ default: fake.module });
    const r = await loadConnectorModule({
      sourceId: 'livecampusu',
      config: parseCfg({}),
      importer,
    });
    expect(r.packageName).toBe('@unicontext/livecampusu');
    expect(r.module.metadata.product).toBe('livecampusu');
  });

  it('loads a named `connector` export and an async factory export', async () => {
    const a = await loadConnectorModule({
      sourceId: 'livecampusu',
      config: parseCfg({}),
      importer: async () => ({ connector: fake.module }),
    });
    expect(a.module).toBe(fake.module);
    let received: unknown;
    const b = await loadConnectorModule({
      sourceId: 'edstem',
      config: parseCfg({ adapter: 'mcp', command: 'npx' }),
      importer: async () => ({
        default: async (init: unknown) => {
          received = init;
          return fake.module;
        },
      }),
    });
    expect(b.packageName).toBe('@unicontext/adapter-mcp');
    expect(received).toMatchObject({
      sourceId: 'edstem',
      config: { adapter: 'mcp', command: 'npx' },
    });
  });

  it('missing package -> not_installed with an actionable message', async () => {
    const err = await loadConnectorModule({
      sourceId: 'livecampusu',
      config: parseCfg({}),
      importer: async (spec) => {
        throw notFound(spec);
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorLoadError);
    expect((err as ConnectorLoadError).code).toBe('not_installed');
    expect((err as ConnectorLoadError).message).toContain('@unicontext/livecampusu');
  });

  it('a package that fails for another reason -> import_failed (not "not installed")', async () => {
    const err = await loadConnectorModule({
      sourceId: 'livecampusu',
      config: parseCfg({}),
      importer: async () => {
        throw new SyntaxError('boom');
      },
    }).catch((e: unknown) => e);
    expect((err as ConnectorLoadError).code).toBe('import_failed');
    expect((err as ConnectorLoadError).message).toContain('boom');
  });

  it('a stub package without a connector export -> bad_export', async () => {
    const err = await loadConnectorModule({
      sourceId: 'livecampusu',
      config: parseCfg({}),
      importer: async () => ({ PACKAGE_NAME: '@unicontext/livecampusu' }),
    }).catch((e: unknown) => e);
    expect((err as ConnectorLoadError).code).toBe('bad_export');
  });

  it('unmapped source -> unmapped', async () => {
    const err = await loadConnectorModule({ sourceId: 'mystery', config: parseCfg({}) }).catch(
      (e: unknown) => e,
    );
    expect((err as ConnectorLoadError).code).toBe('unmapped');
  });

  it('the real default importer reports a missing third-party package as not_installed', async () => {
    const err = await loadConnectorModule({
      sourceId: 'x',
      config: parseCfg({ connector: '@definitely-not/installed-unicontext' }),
    }).catch((e: unknown) => e);
    expect((err as ConnectorLoadError).code).toBe('not_installed');
  });
});

function parseCfg(src: Record<string, unknown>) {
  return parseConfig(`sources:\n  s: ${JSON.stringify(src)}`).sources.s!;
}

describe('createRuntime with configured sources', () => {
  let runtime: Runtime | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await runtime?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    runtime = undefined;
  });

  it('a missing connector degrades that source to failed; the others load', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'uc-runtime-'));
    const okFake = createFakeConnector({
      product: 'syllabus',
      authority: 'syllabus',
      dataset: { courses: [] },
    });
    const config = parseConfig(
      [
        'sources:',
        '  livecampusu: { enabled: true }',
        '  syllabus: { enabled: true }',
        '  files: { enabled: false }',
        '  edstem: { adapter: mcp, command: npx }',
        '  weird: { enabled: true }',
      ].join('\n'),
    );
    runtime = await createRuntime({
      dataDir: dir,
      noKeychain: true,
      config,
      importer: async (spec) => {
        if (spec === '@unicontext/syllabus') return { default: okFake.module };
        throw notFound(spec);
      },
    });
    const sources = runtime.describeSources();
    const by = Object.fromEntries(sources.map((s) => [s.sourceId, s]));
    expect(by.syllabus).toMatchObject({
      loaded: true,
      enabled: true,
      connector: '@unicontext/syllabus',
    });
    expect(by.livecampusu).toMatchObject({ loaded: false, state: 'failed' });
    expect(by.livecampusu?.loadError).toContain('@unicontext/livecampusu');
    expect(by.livecampusu?.loginCommand).toBe('unicontext login livecampusu');
    expect(by.edstem).toMatchObject({ loaded: false, state: 'failed' });
    expect(by.edstem?.loadError).toContain('adapter-mcp');
    expect(by.weird?.loadError).toContain('対応するコネクタが見つかりません');
    expect(by.files).toMatchObject({ enabled: false, loaded: false });
    expect(by.files?.state).toBe('unknown');
    // only the loaded one is registered with the sync engine
    expect(runtime.uc.sync.sources().map((s) => s.sourceId)).toEqual(['syllabus']);
    const report = await runtime.uc.sync.sync('syllabus');
    expect(report.ok).toBe(true);
  });

  it('dev mode seeds the synthetic sources', async () => {
    runtime = await createRuntime({ dev: true, noKeychain: true });
    expect(
      runtime.uc.sync
        .sources()
        .map((s) => s.sourceId)
        .sort(),
    ).toEqual(['lcu', 'lms', 'record', 'teams']);
    expect(runtime.uc.context.today().date).toBe('2026-10-01');
  }, 30_000);
});
