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

export interface CreateSecretStoreOptions {
  /** "auto" tries the keychain and falls back to memory (with a warning callback). */
  backend?: 'auto' | 'keyring' | 'memory';
  service?: string;
  onFallback?: (error: unknown) => void;
}

export async function createSecretStore(
  options: CreateSecretStoreOptions = {},
): Promise<SecretStore> {
  const backend = options.backend ?? 'auto';
  if (backend === 'memory') return new MemorySecretStore();
  try {
    return await KeyringSecretStore.create(options.service);
  } catch (e) {
    if (backend === 'keyring') throw e;
    options.onFallback?.(e);
    return new MemorySecretStore();
  }
}
