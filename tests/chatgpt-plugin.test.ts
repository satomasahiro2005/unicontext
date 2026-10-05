import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const BASE = join(__dirname, '..', 'integrations', 'chatgpt');
const SCRIPT = join(BASE, 'scripts', 'plugin.mjs');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uc-chatgpt-'));
  dirs.push(dir);
  cpSync(BASE, dir, { recursive: true, filter: (src) => !src.includes(`${join(BASE, 'dist')}`) });
  return dir;
}

function run(base: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(base, 'scripts', 'plugin.mjs'), ...args], {
    encoding: 'utf8',
  });
}

/** Minimal ZIP reader: name -> content, via the central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}

describe('ChatGPT plugin package', () => {
  it('passes the package check', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('points the MCP server at the UniContext remote endpoint', () => {
    const mcp = JSON.parse(readFileSync(join(BASE, 'plugin', 'unicontext', 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.unicontext).toEqual({
      type: 'streamable-http',
      url: 'https://uc.nemut.ai',
    });
  });

  it('packs a ZIP rooted at the plugin, optionally mapped to a developer-mode app', () => {
    const base = tempCopy();
    const out = join(base, 'out.zip');
    const r = run(base, 'pack', '--app-id', 'plugin_asdk_app_0123abcd', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    const files = unzip(readFileSync(out));
    expect([...files.keys()].sort()).toEqual([
      '.app.json',
      'assets/icon-dark.svg',
      'assets/icon.svg',
      'assets/logo.png',
      'mcp.json',
      'plugin.json',
      'skills/lecture-ingest/SKILL.md',
      'skills/student-briefing/SKILL.md',
      'skills/student-support/SKILL.md',
    ]);
    const manifest = JSON.parse(files.get('plugin.json')!.toString('utf8'));
    expect(manifest.extensions['com.openai'].apps).toBe('./.app.json');
    expect(JSON.parse(files.get('.app.json')!.toString('utf8'))).toEqual({
      apps: { unicontext: { id: 'plugin_asdk_app_0123abcd' } },
    });
    expect(files.get('assets/logo.png')).toEqual(
      readFileSync(join(BASE, 'plugin', 'unicontext', 'assets', 'logo.png')),
    );
  });

  it('rejects listing text over the documented limits and a skill name mismatch', () => {
    const base = tempCopy();
    const manifestPath = join(base, 'plugin', 'unicontext', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.extensions['com.openai'].interface.shortDescription = 'x'.repeat(31);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const skill = join(base, 'plugin', 'unicontext', 'skills', 'student-support', 'SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf8').replace('name: student-support', 'name: x'));
    const r = run(base, 'check');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('shortDescription is 31 characters (max 30)');
    expect(r.stderr).toContain(
      'skills/student-support: front matter name must be "student-support"',
    );
  });

  it('keeps the scheduled task prompts silent by default and read-only', () => {
    for (const task of ['watcher.ja.txt', 'morning.ja.txt']) {
      const text = readFileSync(join(BASE, 'tasks', task), 'utf8');
      expect(text).toContain('書き込み');
      // Gmail / Google Calendar are read only and never stored in UniContext.
      expect(text).toContain('既読にする');
      expect(text).toContain('UniContextに保存もしない');
      expect(text).toContain('effectiveSchedule');
    }
    const morning = readFileSync(join(BASE, 'tasks', 'morning.ja.txt'), 'utf8');
    expect(morning).toContain('「通知なし」の1行だけ');
    for (const h of [
      'まず今やること',
      '時間が決まっている今日の予定',
      '今日中に終えること',
      '近いうちに注意すること',
    ])
      expect(morning).toContain(h);
    // The watcher says nothing at all when nothing would hurt by waiting.
    const watcher = readFileSync(join(BASE, 'tasks', 'watcher.ja.txt'), 'utf8');
    expect(watcher).toContain('何も出力しない');
    expect(watcher).toContain('attentionId');
  });
});
