import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SecretStore } from '@unicontext/core';

export type { SecretStore } from '@unicontext/core';
export { secretKey } from '@unicontext/core';

/** Process-local store for tests and for `--no-keychain` runs. Nothing touches disk. */
export class MemorySecretStore implements SecretStore {
  readonly backend = 'memory';
  private readonly map = new Map<string, string>();

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

  /** Test helper. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

interface AsyncEntryLike {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | undefined | null>;
  deletePassword(): Promise<boolean>;
}
type AsyncEntryCtor = new (service: string, username: string) => AsyncEntryLike;

/**
 * OS keychain store (§32): Windows Credential Manager, macOS Keychain, Linux Secret Service,
 * through @napi-rs/keyring. Each key is an entry (service = "unicontext", account = key).
 */
export class KeyringSecretStore implements SecretStore {
  readonly backend = 'keyring';

  private constructor(
    private readonly Entry: AsyncEntryCtor,
    private readonly service: string,
  ) {}

  /** Load the native module; rejects when the platform keychain binding is unavailable. */
  static async create(service = 'unicontext'): Promise<KeyringSecretStore> {
    const mod = (await import('@napi-rs/keyring')) as unknown as { AsyncEntry: AsyncEntryCtor };
    return new KeyringSecretStore(mod.AsyncEntry, service);
  }

  private entry(key: string): AsyncEntryLike {
    return new this.Entry(this.service, key);
  }

  async get(key: string): Promise<string | undefined> {
    const v = await this.entry(key).getPassword();
    return v ?? undefined;
  }

  set(key: string, value: string): Promise<void> {
    return this.entry(key).setPassword(value);
  }

  delete(key: string): Promise<boolean> {
    return this.entry(key).deletePassword();
  }
}

/**
 * A JSON file only its owner can read (mode 0600), for a headless Linux box such as a Raspberry Pi,
 * where the Secret Service is absent or locked until someone signs in at the desktop. It protects
 * the secrets the way an SSH private key is protected: by the account, not by a password.
 */
export class FileSecretStore implements SecretStore {
  readonly backend = 'file';

  constructor(readonly file: string) {}

  private read(): Record<string, string> {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error(`secret file is not a JSON object: ${this.file}`);
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }

  private write(map: Record<string, string>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify(map, null, 2)}
`,
      { mode: 0o600 },
    );
    renameSync(tmp, this.file);
    if (process.platform !== 'win32') chmodSync(this.file, 0o600);
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.read()[key]);
  }

  set(key: string, value: string): Promise<void> {
    this.write({ ...this.read(), [key]: value });
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    const map = this.read();
    if (!(key in map)) return Promise.resolve(false);
    delete map[key];
    this.write(map);
    return Promise.resolve(true);
  }
}

export type SecretBackend = 'auto' | 'keyring' | 'file' | 'memory';

export interface CreateSecretStoreOptions {
  /**
   * "auto": UNICONTEXT_SECRET_STORE (keyring | file | memory) when set, else the file store when
   * `file` already exists, else the OS keychain, falling back to memory (with a warning callback).
   */
  backend?: SecretBackend;
  service?: string;
  /** The file store's path (`<data dir>/secrets.json`). */
  file?: string;
  env?: NodeJS.ProcessEnv;
  onFallback?: (error: unknown) => void;
}

function chooseBackend(options: CreateSecretStoreOptions): Exclude<SecretBackend, 'auto'> | 'auto' {
  const backend = options.backend ?? 'auto';
  if (backend !== 'auto') return backend;
  const fromEnv = (options.env ?? process.env).UNICONTEXT_SECRET_STORE?.trim().toLowerCase();
  if (fromEnv === 'keyring' || fromEnv === 'file' || fromEnv === 'memory') return fromEnv;
  if (options.file && existsSync(options.file)) return 'file';
  return 'auto';
}

export async function createSecretStore(
  options: CreateSecretStoreOptions = {},
): Promise<SecretStore> {
  const backend = chooseBackend(options);
  if (backend === 'memory') return new MemorySecretStore();
  if (backend === 'file') {
    if (!options.file) throw new Error('the file secret store needs a path');
    return new FileSecretStore(options.file);
  }
  try {
    return await KeyringSecretStore.create(options.service);
  } catch (e) {
    if (backend === 'keyring') throw e;
    options.onFallback?.(e);
    return new MemorySecretStore();
  }
}
