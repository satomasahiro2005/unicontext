import { AuthRequiredError, type SecretStore, secretKey } from '@unicontext/core';
import { z } from 'zod';

/**
 * Names of secrets to inject at spawn/request time. Either `{NAME: secretName}` or a list of
 * `{name, secret, prefix?}` (prefix e.g. "Bearer "). The list form exists because config.yaml
 * rejects record keys such as `GITHUB_TOKEN: value` as inline secrets (§32).
 */
export const SecretBindingsSchema = z.union([
  z.record(z.string(), z.string()),
  z.array(
    z
      .object({ name: z.string().min(1), secret: z.string().min(1), prefix: z.string().optional() })
      .strict(),
  ),
]);
export type SecretBindings = z.infer<typeof SecretBindingsSchema>;

/** `env:` config: names to inherit from the host process, or literal non-secret values. */
export const EnvConfigSchema = z.union([z.array(z.string()), z.record(z.string(), z.string())]);
export type EnvConfig = z.infer<typeof EnvConfigSchema>;

/** Resolve bindings against the SecretStore (key `<sourceId>/<secretName>`). Missing → auth_required. */
export async function resolveSecretBindings(
  secrets: SecretStore,
  sourceId: string,
  bindings: SecretBindings | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!bindings) return out;
  const list: { name: string; secret: string; prefix?: string | undefined }[] = Array.isArray(
    bindings,
  )
    ? bindings
    : Object.entries(bindings).map(([name, secret]) => ({ name, secret }));
  for (const b of list) {
    const value = await secrets.get(secretKey(sourceId, b.secret));
    if (value === undefined || value === '')
      throw new AuthRequiredError(
        `Secret "${b.secret}" for ${b.name} is not set (source ${sourceId})`,
      );
    out[b.name] = `${b.prefix ?? ''}${value}`;
  }
  return out;
}

/** Environment variables a child process may inherit by default (no credentials). */
export const SAFE_ENV_VARS = [
  'HOME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'HOMEDRIVE',
  'HOMEPATH',
];

/** Child-process environment: safe defaults + `env` (list = inherit named vars, record = literals). */
export function buildChildEnv(
  env: EnvConfig | undefined,
  host: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SAFE_ENV_VARS) {
    const v = host[name];
    if (v !== undefined && !v.startsWith('()')) out[name] = v;
  }
  if (Array.isArray(env)) {
    for (const name of env) {
      const v = host[name];
      if (v !== undefined) out[name] = v;
    }
  } else if (env) Object.assign(out, env);
  return out;
}
