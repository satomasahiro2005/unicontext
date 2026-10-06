import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** File name inside the source's cacheDir. */
export const LOGIN_TRACE_FILE = 'login-trace.jsonl';

/** The trace stops growing here (the start of a sign-in is what matters). */
export const LOGIN_TRACE_MAX_BYTES = 64 * 1024;

export interface LoginTrace {
  /** Start a fresh trace (one interactive sign-in per file). */
  reset(): void;
  /** Append one entry; dropped silently once the cap is reached or on any I/O error. */
  add(kind: string, fields?: Record<string, unknown>): void;
}

/**
 * A small, secret-free record of what an interactive sign-in window went through: tab paths
 * (never queries), what each session probe saw, the non-read requests the read-only route blocked
 * (method and path), and whether the portal's Continue button was on screen. It exists so the
 * next reader is UniContext itself, not a student copying a line off a terminal.
 */
export function createLoginTrace(
  file: string,
  now: () => Date,
  maxBytes = LOGIN_TRACE_MAX_BYTES,
): LoginTrace {
  let bytes = 0;
  let capped = false;
  const write = (line: string, fresh: boolean): void => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (fresh) writeFileSync(file, line);
      else appendFileSync(file, line);
    } catch {
      // best effort: a missing trace never affects the sign-in
    }
  };
  return {
    reset() {
      bytes = 0;
      capped = false;
      write('', true);
    },
    add(kind, fields = {}) {
      if (capped) return;
      const line = `${JSON.stringify({ at: now().toISOString(), kind, ...fields })}\n`;
      const size = Buffer.byteLength(line);
      if (bytes + size > maxBytes) {
        capped = true;
        write(`${JSON.stringify({ at: now().toISOString(), kind: 'truncated' })}\n`, false);
        return;
      }
      bytes += size;
      write(line, false);
    },
  };
}
