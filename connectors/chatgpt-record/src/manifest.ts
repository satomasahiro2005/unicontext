import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ManifestEntry {
  rootKey: string;
  size: number;
  mtimeMs: number;
  hash: string;
}

interface ManifestFile {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

/** path -> {size, mtimeMs, hash}; persisted as JSON in the per-source cache directory. */
export class Manifest {
  readonly entries = new Map<string, ManifestEntry>();
  private dirty = false;

  constructor(private readonly file: string | undefined) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<ManifestFile>;
      if (parsed.version !== 1 || !parsed.entries) return;
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (
          v &&
          typeof v.rootKey === 'string' &&
          typeof v.size === 'number' &&
          typeof v.mtimeMs === 'number' &&
          typeof v.hash === 'string'
        )
          this.entries.set(k, v);
      }
    } catch {
      // Missing or corrupt manifest: start empty; everything is re-diffed by hash.
    }
  }

  get(key: string): ManifestEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: ManifestEntry): void {
    this.entries.set(key, entry);
    this.dirty = true;
  }

  delete(key: string): void {
    if (this.entries.delete(key)) this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.file || !this.dirty) return;
    const data: ManifestFile = { version: 1, entries: Object.fromEntries(this.entries) };
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, this.file);
    this.dirty = false;
  }
}
