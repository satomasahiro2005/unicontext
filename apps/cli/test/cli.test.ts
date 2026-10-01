import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import {
  AuthRequiredError,
  ConfigError,
  ConnectorError,
  MigrationError,
  NotFoundError,
  OfflineError,
  PolicyViolationError,
  RateLimitedError,
  ValidationError,
} from '@unicontext/core';
import { DaemonApiError } from '@unicontext/daemon';
import { describe, expect, it } from 'vitest';
import { CliError, describeError, UsageError } from '../src/errors.js';
import { buildProgram, run } from '../src/main.js';
import { VERSION } from '../src/version.js';
import { exec, makeDeps, removeDir, tempDir, writeConfig } from './helpers.js';

function allCommands(cmd: Command, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const sub of cmd.commands) {
    const p = [...prefix, sub.name()];
    out.push(p);
    out.push(...allCommands(sub, p));
  }
  return out;
}

describe('command tree and --help', () => {
  const program = buildProgram(makeDeps().deps);
  const paths = allCommands(program);

  it('has every command from the spec', () => {
    const names = program.commands.map((c) => c.name()).sort();
    for (const expected of [
      'status',
      'sync',
      'login',
      'today',
      'tomorrow',
      'week',
      'courses',
      'assignments',
      'deadlines',
      'changes',
      'search',
      'conflicts',
      'sources',
      'correct',
      'confirm',
      'doctor',
      'backup',
      'export',
      'import',
      'purge',
      'mcp',
      'service',
      'daemon',
    ])
      expect(names).toContain(expected);
    expect(names).not.toContain('open');
  });

  it('prints --help with exit 0 for every command, in Japanese and English', async () => {
    expect(paths.length).toBeGreaterThan(25);
    for (const p of paths) {
      const r = await exec([...p, '--help']);
      expect(r.code, p.join(' ')).toBe(0);
      expect(r.stdout, p.join(' ')).toMatch(/[぀-ヿ一-鿿]/);
      expect(r.stdout, p.join(' ')).toMatch(/ \/ [A-Z]/);
    }
  });

  it('lists the global options on the top-level help', async () => {
    const r = await exec(['--help']);
    for (const opt of ['--json', '--data-dir', '--config', '--dev', '--no-keychain', '--verbose'])
      expect(r.stdout).toContain(opt);
  });

  it('prints the version', async () => {
    const r = await exec(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
  });
});

describe('usage errors exit with 2', () => {
  it('unknown command, unknown option, missing argument and no command', async () => {
    const unknown = await exec(['nonsense']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('エラー:');
    expect(unknown.stderr).toContain('ヒント:');
    expect((await exec(['today', '--bogus'])).code).toBe(2);
    expect((await exec(['search'])).code).toBe(2);
    expect((await exec([])).code).toBe(2);
  });

  it('rejects invalid option values before opening anything', async () => {
    const r = await exec(['deadlines', '--days', 'abc']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--days');
    expect(r.t.runtimeOptions).toHaveLength(0);
    expect((await exec(['search', 'x', '--limit', '0'])).code).toBe(2);
    expect((await exec(['daemon', 'start', '--port', '70000'])).code).toBe(2);
  });

  it('rejects a bad --since', async () => {
    const r = await exec(['--dev', 'changes', '--since', 'someday']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--since');
  });
});

describe('error output', () => {
  it('prints a Japanese one-liner with a hint and no stack trace', async () => {
    const dir = tempDir();
    try {
      writeConfig(dir, 'sources:\n  edstem:\n    token: abc123\n');
      const r = await exec(['--data-dir', dir, 'status']);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^エラー: 設定に問題があります: /);
      expect(r.stderr).toContain('Secrets must not be stored in config.yaml');
      expect(r.stderr).toContain('ヒント: 「unicontext doctor」');
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(r.stderr).not.toContain('abc123');

      const verbose = await exec(['--data-dir', dir, '--verbose', 'status']);
      expect(verbose.code).toBe(1);
      expect(verbose.stderr).toMatch(/\n\s+at /);
    } finally {
      removeDir(dir);
    }
  });

  it('redacts secrets that appear in error messages', async () => {
    const t = makeDeps({
      createRuntime: async () => {
        throw new Error('request failed: Authorization: Bearer abc.def.ghi and token=sekret123');
      },
    });
    const code = await run(['--dev', 'status'], t.deps);
    expect(code).toBe(1);
    expect(t.stderr()).not.toContain('abc.def.ghi');
    expect(t.stderr()).not.toContain('sekret123');
    expect(t.stderr()).toContain('[REDACTED]');
  });
});

describe('describeError', () => {
  it('maps core errors to specific hints', () => {
    const auth = describeError(new AuthRequiredError('expired', { details: { sourceId: 'lcu' } }));
    expect(auth.message).toContain('ログインが必要です');
    expect(auth.hint).toContain('unicontext login lcu');
    expect(describeError(new AuthRequiredError()).hint).toContain('unicontext login');

    expect(describeError(new ConfigError('bad yaml')).hint).toContain('unicontext doctor');
    expect(describeError(new ConfigError('bad yaml')).message).toContain('bad yaml');
    expect(describeError(new MigrationError('checksum')).hint).toContain('unicontext backup');
    expect(describeError(new NotFoundError('proposal p_1')).message).toContain('見つかりません');
    expect(describeError(new ValidationError('x')).exitCode).toBe(1);
    expect(describeError(new PolicyViolationError('AI cannot')).message).toContain('安全のため');
    expect(describeError(new RateLimitedError('slow', { retryAfterMs: 5000 })).message).toContain(
      '5秒後',
    );
    expect(describeError(new OfflineError()).message).toContain('接続できません');
    expect(describeError(new ConnectorError('boom')).hint).toContain('unicontext doctor');
  });

  it('maps daemon, usage, sqlite and unknown failures', () => {
    expect(describeError(new DaemonApiError('nope', 401, 'unauthorized')).hint).toContain(
      'daemon start',
    );
    expect(describeError(new UsageError('bad args')).exitCode).toBe(2);
    expect(describeError(new CliError('plain', 1, 'try this')).hint).toBe('try this');
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(describeError(busy).message).toContain('使用中');
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(describeError(refused).message).toContain('デーモンに接続できません');
    const unknown = describeError(new Error('weird'));
    expect(unknown.message).toContain('weird');
    expect(unknown.hint).toContain('--verbose');
  });
});

describe('source hygiene', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);

  it('never puts a space between Japanese and alphanumerics in authored strings', () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
          if (/[぀-ヿ一-鿿][ ]+[A-Za-z0-9]|[A-Za-z0-9][ ]+[぀-ヿ一-鿿]/.test(line))
            offenders.push(`${path.basename(file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('contains no emoji', () => {
    for (const file of files)
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
