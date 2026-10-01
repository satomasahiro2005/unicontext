import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DataPaths } from '@unicontext/core';

/**
 * Audit trail of the remote surface: who (client id/name), when, what (tool or OAuth event), from
 * which address. Never arguments, results or tokens. JSON lines in `<logs>/remote-audit.jsonl`,
 * rotated at 5 MiB (one generation kept).
 */
export type AuditRecord = { at: string; event: string } & Record<
  string,
  string | number | boolean | undefined
>;

export function remoteAuditFile(paths: Pick<DataPaths, 'logs'>): string {
  return path.join(paths.logs, 'remote-audit.jsonl');
}

export function createAuditLog(
  file: string,
  now: () => Date = () => new Date(),
  maxBytes = 5 * 1024 * 1024,
): (event: Omit<AuditRecord, 'at'>) => void {
  mkdirSync(path.dirname(file), { recursive: true });
  return (event) => {
    try {
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      } catch {
        // no file yet
      }
      const record: Record<string, unknown> = { at: now().toISOString() };
      for (const [k, v] of Object.entries(event)) if (v !== undefined) record[k] = v;
      appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // auditing must not take the daemon down
    }
  };
}
