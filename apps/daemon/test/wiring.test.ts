import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeConnector, type ConnectorModule } from '@unicontext/connector-sdk';
import { ManualClock, loadProfile, parseConfig, type FetchLike } from '@unicontext/core';
import { cancellationsConnector } from '@unicontext/syllabus';
import { afterEach, describe, expect, it } from 'vitest';
import { effectiveSources } from '../src/registry.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { academicYearOf, enrolledCourses } from '../src/wiring.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const shizuoka = loadProfile('shizuoka-university', {
  searchPaths: [path.join(root, 'profiles')],
});

describe('effectiveSources', () => {
  it('adds every profile source under its product name, with its connector settings', () => {
    const s = effectiveSources({}, shizuoka);
    expect(Object.keys(s).sort()).toEqual([
      'chatgpt-record',
      'edstem',
      'lcu-public-cancellations',
      'livecampusu',
      'local-files',
      'microsoft365',
      'syllabus',
      'wordpress-portal',
    ]);
    expect(s['lcu-public-cancellations']).toMatchObject({
      enabled: true,
      connector: 'syllabus',
      module: 'public-cancellations',
    });
    expect(s.edstem).toMatchObject({ enabled: false, adapter: 'mcp', mapping: 'edstem-mcp.yaml' });
    expect(s.livecampusu).not.toHaveProperty('product');
  });

  it('config entries named by product or role merge over the profile entry', () => {
    const config = parseConfig(
      [
        'sources:',
        '  edstem: { command: npx, args: [edstem-mcp] }',
        '  files: { roots: [~/Uni] }',
        '  microsoft365: { enabled: false }',
      ].join('\n'),
    );
    const s = effectiveSources(config.sources, shizuoka);
    // EdStem is off in the profile; listing it in config.yaml switches it on
    expect(s.edstem).toMatchObject({
      enabled: true,
      connector: 'adapter-mcp',
      mapping: 'edstem-mcp.yaml',
      command: 'npx',
    });
    // `files` is the profile role of local-files: no duplicate local-files source
    expect(s.files).toMatchObject({ connector: 'local-files' });
    expect(s.files?.roots).toHaveLength(1);
    expect(s['local-files']).toBeUndefined();
    expect(s.microsoft365?.enabled).toBe(false);
  });

  it('a product without a profile still gets its implied module', () => {
    const config = parseConfig('sources:\n  lcu-public-cancellations: {}');
    expect(effectiveSources(config.sources)['lcu-public-cancellations']).toMatchObject({
      module: 'public-cancellations',
    });
  });
});

describe('academicYearOf', () => {
  it('starts the academic year in April (JST)', () => {
    expect(academicYearOf(new Date('2026-03-31T15:30:00Z'), 'Asia/Tokyo')).toBe(2026);
    expect(academicYearOf(new Date('2026-03-31T14:30:00Z'), 'Asia/Tokyo')).toBe(2025);
  });
});

describe('createRuntime with the Shizuoka profile', () => {
  let runtime: Runtime | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('loads every connector package of the profile through the real package entries', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'uc-wiring-'));
    runtime = await createRuntime({
      dataDir: dir,
      noKeychain: true,
      config: parseConfig('profile: shizuoka-university'),
      profile: shizuoka,
    });
    const by = Object.fromEntries(runtime.describeSources().map((s) => [s.sourceId, s]));
    for (const id of [
      'livecampusu',
      'microsoft365',
      'syllabus',
      'lcu-public-cancellations',
      'wordpress-portal',
      'local-files',
      'chatgpt-record',
    ]) {
      expect(by[id]?.loadError, id).toBeUndefined();
      expect(by[id]?.loaded, id).toBe(true);
    }
    expect(by.edstem).toMatchObject({ enabled: false, loaded: false });
    const products = Object.fromEntries(
      runtime.uc.sync.sources().map((s) => [s.sourceId, s.metadata.product]),
    );
    expect(products['lcu-public-cancellations']).toBe('lcu-public-cancellations');
    expect(products.syllabus).toBe('syllabus');
  }, 60_000);

  it("feeds LiveCampusU's enrolled courses into the 休講 module so own cancellations reach Today", async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'uc-wiring-'));
    const html = readFileSync(
      path.join(root, 'connectors/syllabus/test/fixtures/lcu-kyuko-SC_90002szu_01.html'),
      'utf8',
    );
    const fetchHtml: FetchLike = () =>
      Promise.resolve(
        new Response(html, { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } }),
      );
    const lcu = createFakeConnector({
      product: 'livecampusu',
      authority: 'academic-system',
      dataset: { courses: [{ id: 'c1', code: '1100', title: '外国史概論', year: 2026 }] },
    });
    const kyuko: ConnectorModule = {
      ...(cancellationsConnector as ConnectorModule),
      createAdapter: (ctx) =>
        (cancellationsConnector as ConnectorModule).createAdapter({ ...ctx, fetch: fetchHtml }),
    };
    const clock = new ManualClock('2026-10-01T23:00:00.000Z'); // 2026-10-02 08:00 JST
    runtime = await createRuntime({
      dataDir: dir,
      noKeychain: true,
      clock,
      config: parseConfig(
        [
          'profile: shizuoka-university',
          'sources:',
          '  livecampusu: {}',
          '  lcu-public-cancellations: {}',
          ...['microsoft365', 'syllabus', 'wordpress-portal', 'local-files', 'chatgpt-record'].map(
            (id) => `  ${id}: { enabled: false }`,
          ),
        ].join('\n'),
      ),
      profile: shizuoka,
      importer: async (spec) => {
        if (spec === '@unicontext/livecampusu') return { default: lcu.module };
        if (spec === '@unicontext/syllabus') return { default: kyuko };
        throw new Error(`unexpected ${spec}`);
      },
    });
    const uc = runtime.uc;
    expect((await uc.sync.sync('livecampusu')).ok).toBe(true);
    expect(enrolledCourses(uc)).toEqual([
      { title: '外国史概論', subjectCode: '1100', academicYear: 2026 },
    ]);
    expect((await uc.sync.sync('lcu-public-cancellations')).ok).toBe(true);
    const classes = uc.context.today().classes;
    const own = classes.filter((c) => c.course.title === '外国史概論');
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((c) => c.cancelled)).toBe(true);
    // other faculties' cancellations stay off Today
    expect(classes.every((c) => c.course.title === '外国史概論')).toBe(true);
  }, 60_000);
});
