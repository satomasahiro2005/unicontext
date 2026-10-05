// Check and package the UniContext ChatGPT plugin (integrations/chatgpt/plugin/unicontext).
//
//   node integrations/chatgpt/scripts/plugin.mjs check
//   node integrations/chatgpt/scripts/plugin.mjs pack [--app-id plugin_asdk_app_...] [--out file.zip]
//
// `check` validates the package against the documented Agent Plugins / OpenAI limits
// (developers.openai.com/plugins/deploy/submission#automatically-provide-submission-and-review-information).
// `pack` writes a ZIP whose root is the plugin root. With --app-id it also adds `.app.json`
// mapping the plugin to an MCP app already registered in ChatGPT developer mode, and the
// `apps` field in plugin.json (personal use only: public submission rejects `.app.json`).
// No dependencies: Node >= 22.2 (zlib.crc32).

import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = resolve(HERE, '..');
const ROOT = join(BASE, 'plugin', 'unicontext');

const IMAGE_FIELDS = ['composerIcon', 'composerIconDark', 'logo', 'logoDark'];
const URL_FIELDS = ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'];
const WRITE_TOOLS = [
  'ingest_lecture',
  'record_lecture',
  'add_deadline',
  'add_task',
  'add_note',
  'retract_addition',
  'open_announcement',
];

/** @param {string} p */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** @param {string} dir @returns {string[]} files relative to dir, '/'-separated */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full).map((f) => `${name}/${f}`));
    else out.push(name);
  }
  return out;
}

/** @param {Buffer} buf */
function imageSize(buf, file) {
  if (file.endsWith('.png')) {
    if (buf.readUInt32BE(12) !== 0x49484452) return null; // 'IHDR'
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (file.endsWith('.svg')) {
    const m = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(buf.toString('utf8'));
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  }
  return null;
}

/** @param {string} text */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return null;
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

/** @returns {string[]} problems; empty when the package is valid */
export function check(root = ROOT) {
  const errors = [];
  const err = (/** @type {string} */ m) => errors.push(m);
  const max = (/** @type {string} */ field, /** @type {unknown} */ v, /** @type {number} */ n) => {
    if (typeof v !== 'string' || v.trim() === '') err(`${field} is required`);
    else if ([...v].length > n) err(`${field} is ${[...v].length} characters (max ${n})`);
  };

  const manifestPath = join(root, 'plugin.json');
  if (!existsSync(manifestPath)) return [`missing ${manifestPath}`];
  const m = readJson(manifestPath);
  if (m.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    err('plugin.json $schema must be the Agent Plugins 1.0.0 schema');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name ?? '') || m.name.length > 64)
    err('name must be kebab-case, at most 64 characters');
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) err('version must be semver x.y.z');
  max('description', m.description, 4000);
  if (existsSync(join(root, '.app.json')) || m.extensions?.['com.openai']?.apps)
    err('the source package must not contain .app.json/apps (use pack --app-id)');

  const oa = m.extensions?.['com.openai'];
  const ui = oa?.interface;
  if (!ui) err('extensions.com.openai.interface is required');
  else {
    max('displayName', ui.displayName, 30);
    max('shortDescription', ui.shortDescription, 30);
    max('longDescription', ui.longDescription, 4000);
    max('developerName', ui.developerName, 80);
    max('category', ui.category, 80);
    if (
      ui.capabilities &&
      (ui.capabilities.length > 20 || ui.capabilities.some((c) => c.length > 120))
    )
      err('capabilities: at most 20 labels of at most 120 characters');
    const prompts = ui.defaultPrompt === undefined ? [] : [ui.defaultPrompt].flat();
    if (prompts.length > 3) err('defaultPrompt: at most 3 prompts');
    for (const p of prompts)
      if ([...p].length > 128) err(`defaultPrompt over 128 characters: ${p}`);
    if (new Set(prompts).size !== prompts.length) err('defaultPrompt entries must be unique');
    for (const f of URL_FIELDS)
      if (ui[f] !== undefined && !/^https:\/\/[^\s@]+$/.test(ui[f]))
        err(`${f} must be an https URL`);
    for (const f of ['brandColor', 'brandColorDark'])
      if (ui[f] !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(ui[f])) err(`${f} must be #RRGGBB`);
    if (!ui.logo) err('logo is required (primary icon)');
    for (const f of [
      ...IMAGE_FIELDS,
      ...(ui.screenshots ?? []).map((_, i) => `screenshots[${i}]`),
    ]) {
      const rel = f.startsWith('screenshots[') ? ui.screenshots[Number(f.slice(12, -1))] : ui[f];
      if (rel === undefined) continue;
      if (!rel.startsWith('./')) {
        err(`${f} must start with ./`);
        continue;
      }
      const full = resolve(root, rel);
      if (!full.startsWith(resolve(root) + sep)) err(`${f} escapes the plugin root`);
      else if (!existsSync(full)) err(`${f}: ${rel} does not exist`);
      else {
        const buf = readFileSync(full);
        if (!/\.(png|jpe?g|webp|svg)$/.test(rel)) err(`${f}: unsupported image type`);
        if (buf.length > 5 * 1024 * 1024) err(`${f}: larger than 5 MiB`);
        if (!f.startsWith('screenshots')) {
          const size = imageSize(buf, rel);
          if (!size) err(`${f}: cannot read the image size`);
          else if (size.w !== size.h || size.w < 48) err(`${f}: must be square and at least 48x48`);
        }
      }
    }
  }
  for (const [locale, t] of Object.entries(oa?.publication?.translations ?? {})) {
    if (t.subtitle != null && ([...t.subtitle].length > 30 || /[\n\t]/.test(t.subtitle)))
      err(`translations.${locale}.subtitle: one line, at most 30 characters`);
    if (t.description != null && [...t.description].length > 4000)
      err(`translations.${locale}.description: at most 4000 characters`);
  }

  const mcpPath = join(root, 'mcp.json');
  if (!existsSync(mcpPath)) err('mcp.json is missing');
  else {
    const mcp = readJson(mcpPath);
    const servers = Object.entries(mcp.mcpServers ?? {});
    if (mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
      err('mcp.json $schema must be the Agent Plugins 1.0.0 MCP schema');
    if (servers.length !== 1) err('mcp.json must declare exactly one server');
    for (const [id, s] of servers) {
      if (s.type !== 'streamable-http') err(`mcp server ${id}: type must be streamable-http`);
      if (!/^https:\/\/[^\s@/]+(\/[^\s@]*)?$/.test(s.url ?? ''))
        err(`mcp server ${id}: url must be https`);
    }
  }

  const skillsDir = join(root, 'skills');
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
  if (skills.length === 0) err('no skills under skills/');
  for (const dir of skills) {
    const p = join(skillsDir, dir, 'SKILL.md');
    if (!existsSync(p)) {
      err(`skills/${dir}/SKILL.md is missing`);
      continue;
    }
    const fm = frontmatter(readFileSync(p, 'utf8'));
    if (!fm) err(`skills/${dir}/SKILL.md has no YAML front matter`);
    else {
      if (fm.name !== dir) err(`skills/${dir}: front matter name must be "${dir}"`);
      if (!fm.description) err(`skills/${dir}: description is required`);
    }
  }

  for (const f of walk(root)) {
    const text = readFileSync(join(root, f)).toString('utf8');
    if (
      /\b(client_secret|refresh_token|access_token)\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/.test(text) ||
      /Bearer\s+[A-Za-z0-9._-]{20,}/.test(text)
    )
      err(`${f} looks like it contains a credential`);
  }

  const ci = join(BASE, 'custom-instructions.ja.txt');
  if (existsSync(ci) && [...readFileSync(ci, 'utf8').trim()].length > 1500)
    err('custom-instructions.ja.txt is over 1500 characters (ChatGPT custom instructions limit)');
  for (const task of ['watcher.ja.txt', 'morning.ja.txt']) {
    const p = join(BASE, 'tasks', task);
    if (!existsSync(p)) err(`tasks/${task} is missing`);
    else {
      const text = readFileSync(p, 'utf8');
      if (!text.includes('通知なし')) err(`tasks/${task} must define the silent answer 通知なし`);
      // Scheduled runs must stay read-only: a write waits for approval and pauses the task.
      if (!WRITE_TOOLS.some((t) => text.includes(t)) && !text.includes('書き込み'))
        err(`tasks/${task} must forbid write tools`);
    }
  }
  return errors;
}

/** @param {{name: string, data: Buffer}[]} entries @returns {Buffer} */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // Fixed timestamp (1980-01-01 00:00) so the archive is reproducible.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** @param {{appId?: string, out?: string}} opts @returns {{out: string, files: string[]}} */
export function pack(opts = {}, root = ROOT) {
  const problems = check(root);
  if (problems.length) throw new Error(`plugin check failed:\n- ${problems.join('\n- ')}`);
  const manifest = readJson(join(root, 'plugin.json'));
  const entries = walk(root).map((name) => ({ name, data: readFileSync(join(root, name)) }));
  if (opts.appId !== undefined) {
    if (
      !/^plugin_asdk_app_[0-9a-f]+$/.test(opts.appId) &&
      !/^connector_[0-9a-f]+$/.test(opts.appId)
    )
      throw new Error(
        '--app-id must look like plugin_asdk_app_<hex> (copy it from the ChatGPT plugin URL)',
      );
    manifest.extensions['com.openai'].apps = './.app.json';
    const app = { apps: { unicontext: { id: opts.appId } } };
    const i = entries.findIndex((e) => e.name === 'plugin.json');
    entries[i] = {
      name: 'plugin.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    };
    entries.unshift({ name: '.app.json', data: Buffer.from(JSON.stringify(app, null, 2) + '\n') });
  }
  const out = resolve(opts.out ?? join(BASE, 'dist', `${manifest.name}-${manifest.version}.zip`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip(entries));
  return { out, files: entries.map((e) => e.name) };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (/** @type {string} */ flag) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'check') {
    const problems = check();
    if (problems.length) {
      process.stderr.write(`plugin check failed:\n- ${problems.join('\n- ')}\n`);
      return 1;
    }
    process.stdout.write(`ok: ${relative(process.cwd(), ROOT) || '.'}\n`);
    return 0;
  }
  if (cmd === 'pack') {
    const { out, files } = pack({ appId: opt('--app-id'), out: opt('--out') });
    process.stdout.write(`wrote ${out}\n${files.map((f) => `  ${f}`).join('\n')}\n`);
    return 0;
  }
  process.stderr.write(
    'usage: plugin.mjs check | pack [--app-id plugin_asdk_app_...] [--out file.zip]\n',
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
