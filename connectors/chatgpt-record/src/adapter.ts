import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import {
  type AuthResult,
  type ConnectorContext,
  type RawDeletion,
  type RawItem,
  type SyncInput,
  type SyncResult,
  type WatchableAdapter,
  type WatchHandle,
  type WatchListener,
} from '@unicontext/connector-sdk';
import {
  ConfigError,
  DEFAULT_TIMEZONE,
  expandHome,
  sha256,
  ValidationError,
} from '@unicontext/core';
import chokidar from 'chokidar';
import { type ChatGptRecordConfig, resolveWatchDir } from './config.js';
import { decodeText } from './decode.js';
import {
  type ImportOptions,
  RAW_TYPE_TRANSCRIPT,
  type TranscriptImporter,
  defaultTranscriptImporter,
} from './importer.js';
import { Manifest } from './manifest.js';
import { DebouncedBatch } from './watch-batch.js';

export type FileEventKind = 'add' | 'change' | 'unlink';

/** The slice of a file watcher the adapter needs (chokidar by default, a fake in tests). */
export interface WatcherLike {
  onFile(handler: (event: FileEventKind, absolutePath: string) => void): void;
  onError(handler: (error: unknown) => void): void;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface WatcherOptions {
  ignored: (absolutePath: string) => boolean;
  stabilityMs: number;
}

export type WatcherFactory = (roots: string[], options: WatcherOptions) => WatcherLike;

export const chokidarWatcherFactory: WatcherFactory = (roots, options) => {
  const w = chokidar.watch(roots, {
    ignoreInitial: true,
    ignored: (p: string) => options.ignored(p),
    awaitWriteFinish:
      options.stabilityMs > 0
        ? { stabilityThreshold: options.stabilityMs, pollInterval: 100 }
        : false,
  });
  return {
    onFile(handler) {
      w.on('add', (p) => handler('add', p));
      w.on('change', (p) => handler('change', p));
      w.on('unlink', (p) => handler('unlink', p));
    },
    onError(handler) {
      w.on('error', (e) => handler(e));
    },
    ready: () =>
      new Promise<void>((resolve) => {
        w.once('ready', () => resolve());
      }),
    close: () => w.close(),
  };
};

export interface ChatGptRecordAdapterOptions {
  createWatcher?: WatcherFactory;
  /** Home directory used for the default watchDir (tests). */
  home?: string;
  /** Importer (format registry); default: txt, md, vtt, srt, json. */
  importer?: TranscriptImporter;
}

export type ImportTextOptions = ImportOptions & {
  /** Name used for format detection and the title (default `transcript.<format>`). */
  fileName?: string;
};

interface ScanFile {
  rel: string;
  size: number;
  mtimeMs: number;
}

interface Plan {
  candidates: ScanFile[];
  deletions: RawDeletion[];
  warnings: string[];
  offset: number;
  force: boolean;
}

type ProcessOutcome =
  { kind: 'emit'; item: RawItem } | { kind: 'unchanged' } | { kind: 'error'; warning: string };

const MB = 1024 * 1024;

export function rootKeyFor(root: string): string {
  return sha256(root).slice(0, 8);
}

export function externalIdFor(rootKey: string, relativePath: string): string {
  return `${rootKey}:${relativePath}`;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Dotfiles / dot-folders and Office-style lock files are never transcripts. */
function isHidden(rel: string): boolean {
  return rel.split('/').some((s) => s.startsWith('.') || s.startsWith('~$'));
}

export class ChatGptRecordAdapter implements WatchableAdapter {
  readonly id = 'chatgpt-record';
  readonly version = '1.0.0';

  readonly watchDir: string;
  readonly importer: TranscriptImporter;
  private readonly config: ChatGptRecordConfig;
  private readonly rootKey: string;
  private readonly extensions: Set<string>;
  private readonly termPattern: RegExp;
  private readonly manifest: Manifest;
  private readonly timezone: string;
  private readonly createWatcher: WatcherFactory;
  private loaded: Promise<void> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private plan: Plan | undefined;
  private readonly handles = new Set<WatchHandle>();

  constructor(
    private readonly ctx: ConnectorContext<ChatGptRecordConfig>,
    options: ChatGptRecordAdapterOptions = {},
  ) {
    this.config = ctx.config;
    this.watchDir = resolveWatchDir(this.config, options.home);
    this.rootKey = rootKeyFor(this.watchDir);
    this.importer = options.importer ?? defaultTranscriptImporter;
    this.extensions = new Set(
      [...this.config.extensions, ...this.importer.extensions].map((e) =>
        e.replace(/^\./, '').toLowerCase(),
      ),
    );
    this.timezone = ctx.profile?.academicCalendar.timezone ?? DEFAULT_TIMEZONE;
    this.manifest = new Manifest(
      ctx.cacheDir ? path.join(ctx.cacheDir, 'manifest.json') : undefined,
    );
    try {
      this.termPattern = new RegExp(this.config.termFolderPattern, 'i');
    } catch (e) {
      throw new ConfigError(`Invalid termFolderPattern: ${errorMessage(e)}`, { cause: e });
    }
    this.createWatcher = options.createWatcher ?? chokidarWatcherFactory;
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve(['lectures']);
  }

  authenticate(): Promise<AuthResult> {
    return Promise.resolve({ status: 'not_required' });
  }

  async health(): Promise<HealthStatus> {
    const checkedAt = this.ctx.clock.now().toISOString();
    try {
      if ((await stat(this.watchDir)).isDirectory()) return { state: 'healthy', checkedAt };
    } catch {
      // fall through
    }
    return {
      state: 'degraded',
      checkedAt,
      message: `Watch directory not found: ${this.watchDir} (manual import still works)`,
    };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.handles].map((h) => h.close()));
    this.handles.clear();
    await this.chain.catch(() => undefined);
    await this.manifest.save().catch(() => undefined);
  }

  // ------------------------------------------------------------ manual import

  /**
   * Import one transcript file (any path). The result is meant for SyncEngine.ingest(sourceId, result).
   * Throws ValidationError for unknown formats / empty transcripts.
   */
  importFile(filePath: string, options: ImportOptions = {}): Promise<SyncResult> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const abs = path.resolve(expandHome(filePath));
      const st = await stat(abs);
      if (!st.isFile()) throw new ValidationError(`Not a file: ${filePath}`);
      if (st.size > this.config.maxFileSizeMb * MB)
        throw new ValidationError(
          `File is larger than ${this.config.maxFileSizeMb} MB: ${path.basename(abs)}`,
        );
      const buf = await readFile(abs);
      const loc = this.locate(abs);
      const fileName = path.basename(abs);
      const payload = this.importer.toPayload({
        fileName,
        content: decodeText(buf),
        timezone: this.timezone,
        mtime: new Date(st.mtimeMs),
        now: this.ctx.clock.now(),
        ...(loc ? { folderHint: this.courseFolderOf(loc.rel) } : {}),
        options,
        importer: this.config.importer,
      });
      const externalId = loc
        ? externalIdFor(this.rootKey, loc.rel)
        : `file:${sha256(abs).slice(0, 16)}`;
      if (loc) {
        // The explicit options are baked into this payload; keep the scan from replacing them.
        this.manifest.set(externalId, {
          rootKey: this.rootKey,
          size: st.size,
          mtimeMs: st.mtimeMs,
          hash: payload.hash,
        });
        await this.manifest.save();
      }
      return this.single({
        sourceType: RAW_TYPE_TRANSCRIPT,
        externalId,
        payload,
        sourceUpdatedAt: new Date(st.mtimeMs).toISOString(),
      });
    });
  }

  /** Import pasted/streamed text (no file). Same result shape as importFile. */
  importText(text: string, options: ImportTextOptions = {}): Promise<SyncResult> {
    const format = options.format;
    const sniffed = /^\uFEFF?WEBVTT/.test(text)
      ? 'vtt'
      : /^\s*[[{]/.test(text) && !/^\s*\[\s*\d/.test(text)
        ? 'json'
        : 'txt';
    const ext = this.importer.formatById(format ?? sniffed)?.extensions[0] ?? 'txt';
    const fileName = options.fileName ?? `transcript.${ext}`;
    const { fileName: _ignored, ...importOptions } = options;
    return this.serialize(() => {
      const payload = this.importer.toPayload({
        fileName,
        content: text,
        timezone: this.timezone,
        now: this.ctx.clock.now(),
        options: importOptions,
        importer: this.config.importer,
      });
      return Promise.resolve(
        this.single({
          sourceType: RAW_TYPE_TRANSCRIPT,
          externalId: `text:${sha256(text).slice(0, 16)}`,
          payload,
          sourceUpdatedAt: this.ctx.clock.now().toISOString(),
        }),
      );
    });
  }

  private single(item: RawItem): SyncResult {
    return {
      items: [item],
      cursor: { lastModified: this.ctx.clock.now().toISOString() },
      hasMore: false,
    };
  }

  // -------------------------------------------------------------------- sync

  sync(input: SyncInput): Promise<SyncResult> {
    return this.serialize(async () => {
      input.signal?.throwIfAborted();
      await this.ensureLoaded();
      if (!input.pageToken || !this.plan)
        this.plan = await this.buildPlan(input.mode !== 'incremental');
      const plan = this.plan;
      const items: RawItem[] = [];
      const warnings: string[] = [];
      const deletions: RawDeletion[] = [];
      if (plan.offset === 0) {
        deletions.push(...plan.deletions);
        warnings.push(...plan.warnings);
        for (const d of plan.deletions) this.manifest.delete(d.externalId);
      }
      const end = Math.min(plan.offset + this.config.pageSize, plan.candidates.length);
      for (const file of plan.candidates.slice(plan.offset, end)) {
        input.signal?.throwIfAborted();
        const out = await this.processFile(file, plan.force);
        if (out.kind === 'emit') items.push(out.item);
        else if (out.kind === 'error') warnings.push(out.warning);
      }
      plan.offset = end;
      const hasMore = end < plan.candidates.length;
      if (!hasMore) this.plan = undefined;
      await this.manifest.save();
      return {
        items,
        ...(deletions.length > 0 ? { deletions } : {}),
        cursor: { lastModified: this.ctx.clock.now().toISOString() },
        hasMore,
        ...(hasMore ? { nextPageToken: String(end) } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.manifest.load();
    return this.loaded;
  }

  private isTranscriptPath(rel: string): boolean {
    if (isHidden(rel)) return false;
    const ext = path.extname(rel).slice(1).toLowerCase();
    return this.extensions.has(ext);
  }

  private locate(absolutePath: string): { rel: string } | undefined {
    const rel = path.relative(this.watchDir, absolutePath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return { rel: toPosix(rel) };
  }

  /** Course hint from `Records/<course>/<file>` (term folders such as 2026前期 are skipped). */
  courseFolderOf(rel: string): string | undefined {
    const dirs = rel.split('/').slice(0, -1);
    return dirs.find((d) => !this.termPattern.test(d));
  }

  private async walk(dirRel: string, out: ScanFile[], warnings: string[]): Promise<void> {
    const dirAbs = dirRel ? path.join(this.watchDir, ...dirRel.split('/')) : this.watchDir;
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (e) {
      warnings.push(`Cannot read ${dirRel || this.watchDir}: ${errorMessage(e)}`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (isHidden(rel)) continue;
      if (entry.isDirectory()) await this.walk(rel, out, warnings);
      else if (entry.isFile() && this.isTranscriptPath(rel)) {
        try {
          const s = await stat(path.join(dirAbs, entry.name));
          out.push({ rel, size: s.size, mtimeMs: s.mtimeMs });
        } catch (e) {
          warnings.push(`Cannot stat ${rel}: ${errorMessage(e)}`);
        }
      }
    }
  }

  private async buildPlan(force: boolean): Promise<Plan> {
    const warnings: string[] = [];
    const files: ScanFile[] = [];
    const rootOk = await isDirectory(this.watchDir);
    if (rootOk) await this.walk('', files, warnings);
    else warnings.push(`Watch directory not found, keeping its transcripts: ${this.watchDir}`);
    const seen = new Set(files.map((f) => externalIdFor(this.rootKey, f.rel)));
    const candidates = files.filter((f) => {
      if (force) return true;
      const prev = this.manifest.get(externalIdFor(this.rootKey, f.rel));
      return !prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs;
    });
    const deletions: RawDeletion[] = [];
    for (const [key, entry] of this.manifest.entries) {
      if (seen.has(key)) continue;
      // Entries of the watch dir go only when it is reachable (unplugged drive); entries of a
      // watch dir that is no longer configured always go.
      if (rootOk || entry.rootKey !== this.rootKey)
        deletions.push({ sourceType: RAW_TYPE_TRANSCRIPT, externalId: key });
    }
    return { candidates, deletions, warnings, offset: 0, force };
  }

  private async processFile(file: ScanFile, force: boolean): Promise<ProcessOutcome> {
    const { rel } = file;
    const key = externalIdFor(this.rootKey, rel);
    const abs = path.join(this.watchDir, ...rel.split('/'));
    try {
      if (file.size > this.config.maxFileSizeMb * MB)
        return {
          kind: 'error',
          warning: `${rel}: larger than ${this.config.maxFileSizeMb} MB, skipped`,
        };
      const buf = await readFile(abs);
      const content = decodeText(buf);
      const hash = sha256(content);
      const prev = this.manifest.get(key);
      const entry = { rootKey: this.rootKey, size: file.size, mtimeMs: file.mtimeMs, hash };
      if (!force && prev?.hash === hash) {
        this.manifest.set(key, entry);
        return { kind: 'unchanged' };
      }
      // Remember the file even when it cannot be parsed: it is retried when it changes.
      this.manifest.set(key, entry);
      const folderHint = this.courseFolderOf(rel);
      const payload = this.importer.toPayload({
        fileName: path.basename(rel),
        content,
        timezone: this.timezone,
        mtime: new Date(file.mtimeMs),
        now: this.ctx.clock.now(),
        ...(folderHint ? { folderHint } : {}),
        importer: this.config.importer,
      });
      return {
        kind: 'emit',
        item: {
          sourceType: RAW_TYPE_TRANSCRIPT,
          externalId: key,
          payload,
          sourceUpdatedAt: new Date(file.mtimeMs).toISOString(),
        },
      };
    } catch (e) {
      return { kind: 'error', warning: `${rel}: ${errorMessage(e)}` };
    }
  }

  // ------------------------------------------------------------------- watch

  private async processEvents(batch: Map<string, FileEventKind>): Promise<SyncResult> {
    await this.ensureLoaded();
    const items: RawItem[] = [];
    const deletions: RawDeletion[] = [];
    const warnings: string[] = [];
    for (const [abs, kind] of batch) {
      const loc = this.locate(abs);
      if (!loc || !this.isTranscriptPath(loc.rel)) continue;
      const key = externalIdFor(this.rootKey, loc.rel);
      let removed = kind === 'unlink';
      let st: { size: number; mtimeMs: number } | undefined;
      if (!removed) {
        try {
          const s = await stat(abs);
          if (!s.isFile()) continue;
          st = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          removed = true;
        }
      }
      if (removed || !st) {
        if (this.manifest.get(key)) {
          this.manifest.delete(key);
          deletions.push({ sourceType: RAW_TYPE_TRANSCRIPT, externalId: key });
        }
        continue;
      }
      const out = await this.processFile(
        { rel: loc.rel, size: st.size, mtimeMs: st.mtimeMs },
        false,
      );
      if (out.kind === 'emit') items.push(out.item);
      else if (out.kind === 'error') warnings.push(out.warning);
    }
    await this.manifest.save();
    return {
      items,
      ...(deletions.length > 0 ? { deletions } : {}),
      cursor: { lastModified: this.ctx.clock.now().toISOString() },
      hasMore: false,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async watch(listener: WatchListener): Promise<WatchHandle> {
    if (!(await isDirectory(this.watchDir))) {
      listener.onError?.(
        new Error(`chatgpt-record: ${this.watchDir} does not exist, not watching`),
      );
      return { close: () => Promise.resolve() };
    }
    const batch = new DebouncedBatch<FileEventKind>(
      this.ctx.clock,
      this.config.watchDebounceMs,
      (events) => {
        void this.serialize(() => this.processEvents(events))
          .then(async (result) => {
            if (result.items.length === 0 && (result.deletions ?? []).length === 0) {
              if (result.warnings?.length)
                listener.onError?.(new Error(result.warnings.join('; ')));
              return;
            }
            await listener.onResult(result);
          })
          .catch((e: unknown) => listener.onError?.(e));
      },
    );
    const watcher = this.createWatcher([this.watchDir], {
      ignored: (p) => {
        const loc = this.locate(p);
        return loc ? isHidden(loc.rel) : false;
      },
      stabilityMs: this.config.watchStabilityMs,
    });
    watcher.onFile((event, p) => batch.add(p, event));
    watcher.onError((e) => listener.onError?.(e));
    await watcher.ready();
    const handle: WatchHandle = {
      close: async () => {
        batch.close();
        this.handles.delete(handle);
        await watcher.close();
      },
    };
    this.handles.add(handle);
    return handle;
  }
}
