import { mkdirSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';

export interface DataPaths {
  /** Root data directory (§52). */
  root: string;
  database: string;
  raw: string;
  blobs: string;
  cache: string;
  logs: string;
  backups: string;
  configDir: string;
  configFile: string;
}

export interface ResolvePathsOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: string;
}

/**
 * Data dir per platform (§52):
 * - Linux/other: $XDG_DATA_HOME/unicontext (default ~/.local/share/unicontext), config $XDG_CONFIG_HOME/unicontext
 * - macOS: ~/Library/Application Support/unicontext, config ~/.config/unicontext (§53)
 * - Windows: %LOCALAPPDATA%\unicontext for both data and config
 * UNICONTEXT_DATA_DIR / UNICONTEXT_CONFIG_DIR override.
 */
export function resolveDataPaths(options: ResolvePathsOptions = {}): DataPaths {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? osHomedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  // XDG base dirs: an empty or relative value is invalid and must be ignored (it would put the
  // database under the current working directory). Same for an empty LOCALAPPDATA.
  const absEnv = (name: string): string | undefined => {
    const v = env[name];
    return v && p.isAbsolute(v) ? v : undefined;
  };

  let root: string;
  let configDir: string;
  if (platform === 'win32') {
    const local = absEnv('LOCALAPPDATA') ?? p.join(home, 'AppData', 'Local');
    root = p.join(local, 'unicontext');
    configDir = root;
  } else if (platform === 'darwin') {
    root = p.join(home, 'Library', 'Application Support', 'unicontext');
    configDir = p.join(absEnv('XDG_CONFIG_HOME') ?? p.join(home, '.config'), 'unicontext');
  } else {
    root = p.join(absEnv('XDG_DATA_HOME') ?? p.join(home, '.local', 'share'), 'unicontext');
    configDir = p.join(absEnv('XDG_CONFIG_HOME') ?? p.join(home, '.config'), 'unicontext');
  }
  if (env.UNICONTEXT_DATA_DIR) root = env.UNICONTEXT_DATA_DIR;
  if (env.UNICONTEXT_CONFIG_DIR) configDir = env.UNICONTEXT_CONFIG_DIR;

  return dataPathsFromRoot(root, configDir, platform);
}

/** Layout under an explicit root (used by tests and --data-dir flags). */
export function dataPathsFromRoot(
  root: string,
  configDir: string = root,
  platform: NodeJS.Platform = process.platform,
): DataPaths {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return {
    root,
    database: p.join(root, 'unicontext.db'),
    raw: p.join(root, 'raw'),
    blobs: p.join(root, 'blobs'),
    cache: p.join(root, 'cache'),
    logs: p.join(root, 'logs'),
    backups: p.join(root, 'backups'),
    configDir,
    configFile: p.join(configDir, 'config.yaml'),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [
    paths.root,
    paths.raw,
    paths.blobs,
    paths.cache,
    paths.logs,
    paths.backups,
    paths.configDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Expand a leading ~ to the home directory. */
export function expandHome(input: string, home: string = osHomedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(home, input.slice(2));
  return input;
}
