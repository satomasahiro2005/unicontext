export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  time: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export const REDACTED = '[REDACTED]';

/** Keys whose values are always redacted (§60). */
export const DEFAULT_SENSITIVE_KEY_PATTERN =
  /(password|passwd|passphrase|secret|token|cookie|authorization|auth[-_]?header|api[-_]?key|session[-_]?id|client[-_]?secret|bearer|credential|student[-_]?(id|number|no)|学籍番号|パスワード)/i;

/** Value patterns redacted wherever they appear inside strings. */
export const DEFAULT_SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
  /\b(access_token|refresh_token|id_token|code|client_secret|password|token)=[^&\s"']+/gi,
  /\b(Cookie|Set-Cookie|Authorization)\s*:\s*[^\n]+/gi,
  /(学籍番号|student\s*id)\s*[:：]?\s*[A-Za-z0-9-]+/gi,
];

export interface RedactionOptions {
  keyPattern?: RegExp;
  valuePatterns?: RegExp[];
  /** Extra patterns, e.g. a university's student ID format from the profile. */
  extraValuePatterns?: RegExp[];
}

/** Deep-copy a value with sensitive keys and string patterns replaced by [REDACTED]. */
export function redact(value: unknown, options: RedactionOptions = {}): unknown {
  const keyPattern = options.keyPattern ?? DEFAULT_SENSITIVE_KEY_PATTERN;
  const valuePatterns = [
    ...(options.valuePatterns ?? DEFAULT_SENSITIVE_VALUE_PATTERNS),
    ...(options.extraValuePatterns ?? []),
  ];
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return redactString(v, valuePatterns);
    if (v === null || typeof v !== 'object') return v;
    if (depth > 12) return '[Truncated]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (v instanceof Error) {
      return {
        name: v.name,
        message: redactString(v.message, valuePatterns),
        stack: v.stack ? redactString(v.stack, valuePatterns) : undefined,
      };
    }
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v instanceof Map) return walk(Object.fromEntries(v), depth);
    if (v instanceof Headers) return walk(Object.fromEntries(v.entries()), depth);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = keyPattern.test(k) && x !== undefined && x !== null ? REDACTED : walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

function redactString(s: string, patterns: RegExp[]): string {
  let out = s;
  for (const p of patterns) {
    out = out.replace(p, (match: string, ...groups: unknown[]) => {
      const first = groups[0];
      if (typeof first === 'string' && match.startsWith(first) && first.length < match.length) {
        // keep the label (e.g. "Bearer", "token=") for debuggability
        const sep = match.slice(first.length).match(/^(\s*[:=：]?\s*)/)?.[1] ?? '';
        return `${first}${sep}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  fields?: Record<string, unknown>;
  redaction?: RedactionOptions;
  now?: () => Date;
}

/** JSON-lines sink to stderr (stdout is reserved for MCP stdio transports). */
export const stderrSink: LogSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/** Structured logger. Every record passes through redact() before reaching the sink. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[options.level ?? 'info'];
  const sink = options.sink ?? stderrSink;
  const base = options.fields ?? {};
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < min) return;
    const merged = redact({ ...base, ...(fields ?? {}) }, options.redaction) as Record<
      string,
      unknown
    >;
    const safeMsg = redact(msg, options.redaction) as string;
    sink({ ...merged, time: now().toISOString(), level, msg: safeMsg });
  };

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

/** Logger that discards everything. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** Collects records in memory; useful in tests. */
export function createMemoryLogger(level: LogLevel = 'debug'): {
  logger: Logger;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  return { logger: createLogger({ level, sink: (r) => records.push(r) }), records };
}
