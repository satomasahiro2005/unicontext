import { sha256 } from '@unicontext/core';

/**
 * Product version fingerprint (§72). LCU-Web prints no version; the bundled plugin folders
 * (`/plugin/jquery/v3.5.1/…`) change with product releases, so their versions form the
 * fingerprint. Static script size/hash (common.js) is an extra check done only when the stored
 * fingerprint is missing or changed.
 */
export const VERSION_PRODUCT = 'lcu-web';

/** Plugins that make up the fingerprint, in output order, with short aliases. */
export const FINGERPRINT_PLUGINS: readonly { name: string; alias: string }[] = [
  { name: 'jquery', alias: 'jq' },
  { name: 'jquery-ui', alias: 'jqui' },
  { name: 'datatables', alias: 'dt' },
  { name: 'dropzone', alias: 'dz' },
  { name: 'modaal', alias: 'modaal' },
];

/** Version string the connector was tested with (静岡大学, 2026-10-01). */
export const TESTED_FINGERPRINT = 'lcu-web+jq3.5.1+jqui1.12.1+dt1.10.20+dz5.7.0+modaal0.4.4';

/** Plugin folder → version, from script/link URLs (`vX.X.X` placeholders are ignored). */
export function collectPluginVersions(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\/plugin\/((?:[A-Za-z0-9._-]+\/)*?)([A-Za-z0-9._-]+)\/v(\d+(?:\.\d+)*)\//g;
  for (const m of html.matchAll(re)) {
    const name = m[2];
    const version = m[3];
    if (name && version && !(name in out)) out[name] = version;
  }
  return out;
}

/** "lcu-web+jq3.5.1+…"; a missing plugin shows as "<alias>?". Undefined when no plugin was found. */
export function pluginFingerprint(html: string): string | undefined {
  const versions = collectPluginVersions(html);
  if (Object.keys(versions).length === 0) return undefined;
  const parts = FINGERPRINT_PLUGINS.map((p) => `${p.alias}${versions[p.name] ?? '?'}`);
  return [VERSION_PRODUCT, ...parts].join('+');
}

export interface ScriptFingerprint {
  path: string;
  size: number;
  sha256: string;
}

export function scriptFingerprint(path: string, body: Uint8Array): ScriptFingerprint {
  return { path, size: body.byteLength, sha256: sha256(body) };
}

/** Does the fetched script match what the deployment profile knows (size and/or sha256)? */
export function scriptMatches(
  fp: ScriptFingerprint,
  known: { size?: number | undefined; sha256?: string | undefined } | undefined,
): boolean {
  if (!known || (known.size === undefined && known.sha256 === undefined)) return true;
  if (known.size !== undefined && known.size !== fp.size) return false;
  if (known.sha256 !== undefined && known.sha256.toLowerCase() !== fp.sha256) return false;
  return true;
}

/** Final version string: the plugin fingerprint, plus a script marker when the script differs. */
export function composeVersion(
  plugins: string,
  script: ScriptFingerprint | undefined,
  matches: boolean,
): string {
  if (!script || matches) return plugins;
  return `${plugins}+${script.path.replace(/^.*\//, '').replace(/\W+/g, '')}-${script.size}-${script.sha256.slice(0, 8)}`;
}
