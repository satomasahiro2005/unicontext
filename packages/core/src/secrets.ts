/**
 * Secret storage contract (§32). Tokens, cookies and passwords go here, never into the DB or
 * config. Implementations live in @unicontext/auth (OS keychain, in-memory).
 */
export interface SecretStore {
  readonly backend: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Conventional key layout: "<sourceId>/<name>", e.g. "microsoft365/refresh_token". */
export function secretKey(sourceId: string, name: string): string {
  if (!sourceId || !name || sourceId.includes('/'))
    throw new RangeError(`Invalid secret key parts: ${sourceId}/${name}`);
  return `${sourceId}/${name}`;
}
