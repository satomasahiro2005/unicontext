import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DataPaths } from '@unicontext/core';

/*
 * Which tools each connection last listed (issue #4). An AI app keeps the tool list it read when it
 * connected: ChatGPT read UniContext's on 10/5 and never again, so every tool added after that
 * (verify_submission, get_assignment, ...) "failed internally" there without ever reaching this
 * server. The daemon cannot push a new list over stateless HTTP, so it remembers, per grant, the
 * tool set (names) of the last tools/list, and while the connection's set differs from the one it
 * would be served now, every answer tells the AI to have the student refresh the connector once.
 *
 * Plain JSON next to oauth-state.json, written atomically, only on tools/list (rare).
 */

export const TOOL_LISTS_FILE = 'tool-lists.json';

interface Listed {
  listedAt: string;
  /** Hash of the sorted tool names served then. */
  toolSet: string;
}

interface ToolListsFile {
  version: 1;
  grants: Record<string, Listed>;
}

export function toolSetHash(names: readonly string[]): string {
  return createHash('sha256')
    .update([...names].sort().join('\n'))
    .digest('base64url')
    .slice(0, 16);
}

export class ToolListTracker {
  private cache: Record<string, Listed> | undefined;

  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static forPaths(paths: DataPaths, now?: () => Date): ToolListTracker {
    return new ToolListTracker(path.join(paths.root, 'remote', TOOL_LISTS_FILE), now);
  }

  private read(): Record<string, Listed> {
    if (this.cache) return this.cache;
    let grants: Record<string, Listed> = {};
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ToolListsFile>;
        if (parsed.grants && typeof parsed.grants === 'object') grants = parsed.grants;
      }
    } catch {
      grants = {}; // unreadable: as if nothing was listed (the notice asks for one refresh)
    }
    this.cache = grants;
    return grants;
  }

  /** The connection read the tool list (tools/list) and was served this set. */
  listed(grantId: string, toolSet: string): void {
    const grants = { ...this.read(), [grantId]: { listedAt: this.now().toISOString(), toolSet } };
    this.cache = grants;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body: ToolListsFile = { version: 1, grants };
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    if (process.platform !== 'win32') chmodSync(this.file, 0o600);
  }

  /**
   * undefined while the connection's last list is the set it would be served now; otherwise when
   * it last listed (null: never seen listing, e.g. connected before this was recorded).
   */
  outdated(grantId: string, toolSet: string): { listedAt: string | null } | undefined {
    const rec = this.read()[grantId];
    if (rec?.toolSet === toolSet) return undefined;
    return { listedAt: rec?.listedAt ?? null };
  }
}

/** The sentence added to answerHint while a connection's tool list is outdated. */
export function outdatedToolListHint(
  listedAt: string | null,
  formatDate: (iso: string) => string,
): string {
  const when = listedAt
    ? `${formatDate(listedAt)}に読み込んだもので、今の UniContext のツールと違います`
    : 'いつ読み込んだものか UniContext に記録がなく、今のツールと違う可能性があります';
  return `この AI アプリが持っている UniContext のツール一覧は${when}（その後に増えたツール、例えば verify_submission・get_assignment は、このアプリからは呼べず「内部エラー」になります）。本人に一度だけ、AI アプリのコネクタ設定で UniContext を更新してもらうよう伝えてください（ChatGPT: 設定 → アプリ → UniContext → 更新）。`;
}
