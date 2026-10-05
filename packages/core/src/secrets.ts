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

/** One credential a source's config names (`envSecrets` / `headerSecrets`), never its value. */
export interface NamedSecret {
  /** Secret name; the SecretStore key is `secretKey(sourceId, secret)`. */
  secret: string;
  /** Environment variable or header the value is injected as. */
  target: string;
  via: 'envSecrets' | 'headerSecrets';
}

/**
 * The secrets a source config asks for: `envSecrets` / `headerSecrets` in record form
 * (`{ENV_NAME: secretName}`) or list form (`[{name, secret, prefix?}]`), as the generic adapters
 * (mcp, cli, rest) read them. Malformed entries are skipped (config validation reports them).
 */
export function namedSecrets(config: Readonly<Record<string, unknown>>): NamedSecret[] {
  const out: NamedSecret[] = [];
  const seen = new Set<string>();
  for (const via of ['envSecrets', 'headerSecrets'] as const) {
    const bindings = config[via];
    const pairs: [unknown, unknown][] = Array.isArray(bindings)
      ? bindings.map((b) => {
          const o = (b ?? {}) as { name?: unknown; secret?: unknown };
          return [o.name, o.secret];
        })
      : bindings && typeof bindings === 'object'
        ? Object.entries(bindings)
        : [];
    for (const [target, secret] of pairs) {
      if (typeof target !== 'string' || typeof secret !== 'string' || !target || !secret) continue;
      const id = `${via}:${target}:${secret}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ secret, target, via });
    }
  }
  return out;
}
