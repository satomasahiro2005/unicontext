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
import { ConfigError, sha256 } from '@unicontext/core';
import chokidar from 'chokidar';
import { inferCourseFolder } from './course.js';
import { type LocalFilesConfig, resolveRoots } from './config.js';
import { extractContent, mimeTypeFor } from './extract.js';
import { type CompiledPattern, compileGlobs, matchesExclude, matchesInclude } from './glob.js';
import { Manifest } from './manifest.js';
import { type FileDocumentPayload, RAW_TYPE_DOCUMENT } from './types.js';
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
  /** Absolute path -> true to ignore (pruned folders, dotfiles, ...). */
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

export interface LocalFilesAdapterOptions {
  createWatcher?: WatcherFactory;
  /** Home directory used for the default root (tests). */
  home?: string;
}

interface RootInfo {
  root: string;
  key: string;
}

interface ScanFile {
  info: RootInfo;
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
  | { kind: 'emit'; item: RawItem; warning?: string }
  | { kind: 'unchanged' }
  | { kind: 'error'; warning: string };

const MB = 1024 * 1024;

export function externalIdFor(rootKey: string, relativePath: string): string {
  return `${rootKey}:${relativePath}`;
}

export function rootKeyFor(root: string): string {
  return sha256(root).slice(0, 8);
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

export class LocalFilesAdapter implements WatchableAdapter {
  readonly id = 'local-files';
  readonly version = '1.0.0';

  private readonly config: LocalFilesConfig;
  private readonly roots: RootInfo[];
  private readonly manifest: Manifest;
  private readonly exclude: CompiledPattern[];
  private readonly include: CompiledPattern[];
  private readonly termPattern: RegExp;
  private readonly createWatcher: WatcherFactory;
  private loaded: Promise<void> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private plan: Plan | undefined;
  private readonly handles = new Set<WatchHandle>();

  constructor(
    private readonly ctx: ConnectorContext<LocalFilesConfig>,
    options: LocalFilesAdapterOptions = {},
  ) {
    this.config = ctx.config;
    this.roots = resolveRoots(this.config, options.home).map((root) => ({
      root,
      key: rootKeyFor(root),
    }));
    this.manifest = new Manifest(
      ctx.cacheDir ? path.join(ctx.cacheDir, 'manifest.json') : undefined,
    );
    this.exclude = compileGlobs(this.config.exclude);
    this.include = compileGlobs(this.config.include);
    try {
      this.termPattern = new RegExp(this.config.termFolderPattern, 'i');
    } catch (e) {
      throw new ConfigError(`Invalid termFolderPattern: ${errorMessage(e)}`, { cause: e });
    }
    this.createWatcher = options.createWatcher ?? chokidarWatcherFactory;
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve(['files', 'materials']);
  }

  authenticate(): Promise<AuthResult> {
    return Promise.resolve({ status: 'not_required' });
  }

  async health(): Promise<HealthStatus> {
    const checkedAt = this.ctx.clock.now().toISOString();
    const missing: string[] = [];
    for (const r of this.roots) {
      try {
        if (!(await stat(r.root)).isDirectory()) missing.push(r.root);
      } catch {
        missing.push(r.root);
      }
    }
    if (missing.length === 0) return { state: 'healthy', checkedAt };
    return {
      state: 'degraded',
      checkedAt,
      message: `Root directory not found: ${missing.join(', ')}`,
    };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.handles].map((h) => h.close()));
    this.handles.clear();
    await this.chain.catch(() => undefined);
    await this.manifest.save().catch(() => undefined);
  }

  // ---------------------------------------------------------------- sync

  sync(input: SyncInput): Promise<SyncResult> {
    return this.serialize(async () => {
      input.signal?.throwIfAborted();
      await this.ensureLoaded();
      if (!input.pageToken || !this.plan) {
        // initial / full re-extract everything; incremental diffs against the manifest.
        this.plan = await this.buildPlan(input.mode !== 'incremental');
      }
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
        if (out.kind === 'emit') {
          items.push(out.item);
          if (out.warning) warnings.push(out.warning);
        } else if (out.kind === 'error') warnings.push(out.warning);
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

  private isIncluded(rel: string): boolean {
    return !matchesExclude(rel, this.exclude) && matchesInclude(rel, this.include);
  }

  private async walk(
    info: RootInfo,
    dirRel: string,
    out: ScanFile[],
    warnings: string[],
  ): Promise<void> {
    const dirAbs = dirRel ? path.join(info.root, ...dirRel.split('/')) : info.root;
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (e) {
      warnings.push(`Cannot read ${dirRel || info.root}: ${errorMessage(e)}`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (matchesExclude(rel, this.exclude)) continue;
      if (entry.isDirectory()) await this.walk(info, rel, out, warnings);
      else if (entry.isFile()) {
        if (!matchesInclude(rel, this.include)) continue;
        try {
          const s = await stat(path.join(dirAbs, entry.name));
          out.push({ info, rel, size: s.size, mtimeMs: s.mtimeMs });
        } catch (e) {
          warnings.push(`Cannot stat ${rel}: ${errorMessage(e)}`);
        }
      }
    }
  }

  private async buildPlan(force: boolean): Promise<Plan> {
    const warnings: string[] = [];
    const files: ScanFile[] = [];
    const scanned = new Set<string>();
    for (const info of this.roots) {
      if (!(await isDirectory(info.root))) {
        warnings.push(`Root directory not found, keeping its files as they are: ${info.root}`);
        continue;
      }
      scanned.add(info.key);
      await this.walk(info, '', files, warnings);
    }
    const seen = new Set(files.map((f) => externalIdFor(f.info.key, f.rel)));
    const knownRoots = new Set(this.roots.map((r) => r.key));
    const candidates = files.filter((f) => {
      if (force) return true;
      const prev = this.manifest.get(externalIdFor(f.info.key, f.rel));
      return !prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs;
    });
    const deletions: RawDeletion[] = [];
    for (const [key, entry] of this.manifest.entries) {
      if (seen.has(key)) continue;
      // Files of a root that exists but no longer contain them are deleted; files of a root that is
      // currently unreachable (unplugged drive) are kept; files of a root no longer configured go.
      if (scanned.has(entry.rootKey) || !knownRoots.has(entry.rootKey))
        deletions.push({ sourceType: RAW_TYPE_DOCUMENT, externalId: key });
    }
    return { candidates, deletions, warnings, offset: 0, force };
  }

  private async processFile(file: ScanFile, force: boolean): Promise<ProcessOutcome> {
    const { info, rel } = file;
    const key = externalIdFor(info.key, rel);
    const abs = path.join(info.root, ...rel.split('/'));
    const name = path.basename(rel);
    const ext = path.extname(name).slice(1).toLowerCase();
    const tooLarge = file.size > this.config.maxFileSizeMb * MB;
    try {
      let buf: Buffer | undefined;
      let hash: string;
      if (tooLarge) hash = sha256(`meta:${file.size}:${file.mtimeMs}`);
      else {
        buf = await readFile(abs);
        hash = sha256(buf);
      }
      const prev = this.manifest.get(key);
      const entry = { rootKey: info.key, size: file.size, mtimeMs: file.mtimeMs, hash };
      if (!force && prev?.hash === hash) {
        this.manifest.set(key, entry);
        return { kind: 'unchanged' };
      }
      let content: Awaited<ReturnType<typeof extractContent>> = {};
      let note: string | undefined;
      let warning: string | undefined;
      if (!buf) note = `larger than ${this.config.maxFileSizeMb} MB: metadata only`;
      else {
        try {
          content = await extractContent(buf, ext);
        } catch (e) {
          note = 'text extraction failed: metadata only';
          warning = `${rel}: text extraction failed: ${errorMessage(e)}`;
        }
      }
      const course = inferCourseFolder(rel, {
        termPattern: this.termPattern,
        depth: this.config.courseFolderDepth,
      });
      const mtime = new Date(file.mtimeMs).toISOString();
      const payload: FileDocumentPayload = {
        root: info.root,
        relativePath: rel,
        name,
        ext,
        mimeType: mimeTypeFor(ext),
        size: file.size,
        mtime,
        hash,
        ...(content.pages ? { pages: content.pages } : {}),
        ...(content.text !== undefined ? { text: content.text } : {}),
        ...(content.slides ? { slides: content.slides } : {}),
        ...(content.image ? { image: content.image } : {}),
        ...course,
        ...(note ? { note } : {}),
      };
      this.manifest.set(key, entry);
      return {
        kind: 'emit',
        item: { sourceType: RAW_TYPE_DOCUMENT, externalId: key, payload, sourceUpdatedAt: mtime },
        ...(warning ? { warning } : {}),
      };
    } catch (e) {
      return { kind: 'error', warning: `${rel}: ${errorMessage(e)}` };
    }
  }

  // --------------------------------------------------------------- watch

  private locate(absolutePath: string): { info: RootInfo; rel: string } | undefined {
    for (const info of this.roots) {
      const rel = path.relative(info.root, absolutePath);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      return { info, rel: toPosix(rel) };
    }
    return undefined;
  }

  /** Process one batch of watcher events into a SyncResult (exported for tests via watch()). */
  private async processEvents(batch: Map<string, FileEventKind>): Promise<SyncResult> {
    await this.ensureLoaded();
    const items: RawItem[] = [];
    const deletions: RawDeletion[] = [];
    const warnings: string[] = [];
    for (const [abs, kind] of batch) {
      const loc = this.locate(abs);
      if (!loc || !this.isIncluded(loc.rel)) continue;
      const key = externalIdFor(loc.info.key, loc.rel);
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
          deletions.push({ sourceType: RAW_TYPE_DOCUMENT, externalId: key });
        }
        continue;
      }
      const out = await this.processFile(
        { info: loc.info, rel: loc.rel, size: st.size, mtimeMs: st.mtimeMs },
        false,
      );
      if (out.kind === 'emit') {
        items.push(out.item);
        if (out.warning) warnings.push(out.warning);
      } else if (out.kind === 'error') warnings.push(out.warning);
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
    const existing: RootInfo[] = [];
    for (const r of this.roots) {
      try {
        if ((await stat(r.root)).isDirectory()) existing.push(r);
      } catch {
        // Missing root: nothing to watch there until it exists and the next sync runs.
      }
    }
    if (existing.length === 0) {
      listener.onError?.(new Error('local-files: no root directory exists, not watching'));
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
    const watcher = this.createWatcher(
      existing.map((r) => r.root),
      {
        ignored: (p) => {
          const loc = this.locate(p);
          return loc ? matchesExclude(loc.rel, this.exclude) : false;
        },
        stabilityMs: this.config.watchStabilityMs,
      },
    );
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
