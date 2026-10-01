// One-off scaffolding helper: writes package.json/tsconfig.json for every workspace package.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pkgs = {
  packages: {
    core: {
      deps: [],
      ext: { yaml: '^2.9.1', zod: '^4.6.5' },
      desc: 'Logger, config, errors, clock, dates and AI provider abstraction',
    },
    'canonical-model': {
      deps: [],
      ext: { zod: '^4.6.5' },
      desc: 'Canonical data model: zod schemas, types and ID conventions',
    },
    database: {
      deps: ['core', 'canonical-model'],
      ext: { 'better-sqlite3': '^13.0.3', 'drizzle-orm': '^0.45.3', zod: '^4.6.5' },
      devExt: { '@types/better-sqlite3': '^9.6.0' },
      desc: 'SQLite storage, migrations, raw store and maintenance (export/import/backup/purge)',
    },
    'connector-sdk': {
      deps: ['core', 'canonical-model'],
      ext: { zod: '^4.6.5' },
      peer: { vitest: '^4.1.0' },
      devExt: { vitest: '^4.1.0' },
      desc: 'SourceAdapter/Normalizer contracts, rate limiter, schema drift and compliance suite',
    },
    auth: {
      deps: ['core'],
      ext: { '@napi-rs/keyring': '^2.1.0' },
      desc: 'Secret storage (OS keychain) and OAuth 2.0 PKCE loopback helper',
    },
    provenance: {
      deps: ['core', 'canonical-model', 'database'],
      extraFiles: ['default-rules.yaml'],
      ext: { yaml: '^2.9.1', zod: '^4.6.5', 'drizzle-orm': '^0.45.3' },
      desc: 'Fact store, source references and conflict resolution',
    },
    identity: {
      deps: ['core', 'canonical-model', 'database'],
      ext: { 'drizzle-orm': '^0.45.3' },
      desc: 'Identity resolution across sources (course offering matching)',
    },
    search: {
      deps: ['core', 'canonical-model', 'database', 'provenance'],
      ext: { 'drizzle-orm': '^0.45.3' },
      desc: 'Structured, FTS5 and optional semantic search with a query router',
    },
    'sync-engine': {
      deps: ['core', 'canonical-model', 'database', 'connector-sdk', 'provenance'],
      ext: {},
      desc: 'Raw ingestion, normalization pipeline, scheduler, health and change events',
    },
    'task-engine': {
      deps: ['core', 'canonical-model', 'database', 'provenance'],
      ext: { 'drizzle-orm': '^0.45.3' },
      desc: 'Task derivation and Japanese deadline extraction',
    },
    'context-engine': {
      deps: [
        'core',
        'canonical-model',
        'database',
        'provenance',
        'identity',
        'search',
        'task-engine',
        'sync-engine',
        'connector-sdk',
      ],
      ext: { zod: '^4.6.5' },
      desc: 'Purpose-built context bundles (today, week, course, ...) with citations',
    },
    'adapter-mcp': {
      stub: true,
      deps: ['connector-sdk'],
      desc: 'External MCP server adapter (stub)',
    },
    'adapter-cli': { stub: true, deps: ['connector-sdk'], desc: 'External CLI adapter (stub)' },
    'adapter-rest': { stub: true, deps: ['connector-sdk'], desc: 'REST/OpenAPI adapter (stub)' },
    'adapter-browser': {
      stub: true,
      deps: ['connector-sdk'],
      desc: 'Browser (Playwright) adapter (stub)',
    },
    notifications: { stub: true, deps: ['core'], desc: 'Notification engine (stub)' },
  },
  apps: {
    daemon: { stub: true, deps: ['core'], desc: 'unicontextd daemon (stub)' },
    cli: { stub: true, deps: ['core'], desc: 'unicontext CLI (stub)' },
    web: { stub: true, deps: ['core'], desc: 'Local web UI (stub)' },
    mcp: { stub: true, deps: ['core'], desc: 'UniContext MCP server (stub)' },
  },
  connectors: {
    microsoft365: { stub: true, deps: ['connector-sdk'], desc: 'Microsoft 365 connector (stub)' },
    livecampusu: { stub: true, deps: ['connector-sdk'], desc: 'LiveCampusU connector (stub)' },
    'local-files': { stub: true, deps: ['connector-sdk'], desc: 'Local files connector (stub)' },
    syllabus: { stub: true, deps: ['connector-sdk'], desc: 'Syllabus connector (stub)' },
    'chatgpt-record': {
      stub: true,
      deps: ['connector-sdk'],
      desc: 'ChatGPT Record / transcript importer connector (stub)',
    },
  },
};

const where = {};
for (const [group, list] of Object.entries(pkgs))
  for (const name of Object.keys(list)) where[name] = group;

const refs = [];
for (const [group, list] of Object.entries(pkgs)) {
  for (const [name, def] of Object.entries(list)) {
    const dir = join(group, name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    const dependencies = {};
    for (const d of def.deps) dependencies[`@unicontext/${d}`] = 'workspace:*';
    Object.assign(dependencies, def.ext ?? {});
    const exportsField = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
    if (name === 'connector-sdk')
      exportsField['./testing'] = { types: './dist/testing.d.ts', import: './dist/testing.js' };
    const pkg = {
      name: `@unicontext/${name}`,
      version: '1.0.0',
      description: def.desc,
      license: 'MIT',
      type: 'module',
      ...(def.stub ? { private: true } : {}),
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: exportsField,
      files: ['dist', ...(def.extraFiles ?? [])],
      scripts: { build: 'tsc -b' },
      dependencies,
      ...(def.devExt ? { devDependencies: def.devExt } : {}),
      ...(def.peer
        ? {
            peerDependencies: def.peer,
            peerDependenciesMeta: Object.fromEntries(
              Object.keys(def.peer).map((k) => [k, { optional: true }]),
            ),
          }
        : {}),
    };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    const tsconfig = {
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: 'src', outDir: 'dist', tsBuildInfoFile: 'dist/.tsbuildinfo' },
      include: ['src'],
      references: def.deps.map((d) => ({ path: `../../${where[d]}/${d}` })),
    };
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
    if (def.stub || !existsSync(join(dir, 'README.md')))
      writeFileSync(join(dir, 'README.md'), `# @unicontext/${name}\n\n${def.desc}.\n`);
    if (def.stub && !existsSync(join(dir, 'src', 'index.ts'))) {
      writeFileSync(
        join(dir, 'src', 'index.ts'),
        `// Placeholder: implemented by a later lane. See docs/ARCHITECTURE.md.\nexport const PACKAGE_NAME = '@unicontext/${name}';\n`,
      );
    }
    refs.push({ path: `./${group}/${name}` });
  }
}
writeFileSync('tsconfig.json', JSON.stringify({ files: [], references: refs }, null, 2) + '\n');
