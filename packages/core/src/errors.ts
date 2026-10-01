export type ErrorCode =
  | 'config'
  | 'validation'
  | 'not_found'
  | 'auth_required'
  | 'rate_limited'
  | 'offline'
  | 'policy_violation'
  | 'migration'
  | 'connector'
  | 'internal';

export interface ErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class UniContextError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = options?.details;
  }
}

export class ConfigError extends UniContextError {
  constructor(message: string, options?: ErrorOptions) {
    super('config', message, options);
  }
}

export class ValidationError extends UniContextError {
  constructor(message: string, options?: ErrorOptions) {
    super('validation', message, options);
  }
}

export class NotFoundError extends UniContextError {
  constructor(message: string, options?: ErrorOptions) {
    super('not_found', message, options);
  }
}

/** Credentials are missing or expired; the user has to log in again. */
export class AuthRequiredError extends UniContextError {
  constructor(message = 'Authentication required', options?: ErrorOptions) {
    super('auth_required', message, options);
  }
}

/** Remote service asked us to slow down. retryAfterMs comes from Retry-After when present. */
export class RateLimitedError extends UniContextError {
  readonly retryAfterMs: number | undefined;
  constructor(message = 'Rate limited', options?: ErrorOptions & { retryAfterMs?: number }) {
    super('rate_limited', message, options);
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** Network unreachable / DNS failure / timeout. */
export class OfflineError extends UniContextError {
  constructor(message = 'Source is unreachable', options?: ErrorOptions) {
    super('offline', message, options);
  }
}

/** A safety rule was violated (e.g. AI output stored as authoritative, AI marking a task submitted). */
export class PolicyViolationError extends UniContextError {
  constructor(message: string, options?: ErrorOptions) {
    super('policy_violation', message, options);
  }
}

export class MigrationError extends UniContextError {
  constructor(message: string, options?: ErrorOptions) {
    super('migration', message, options);
  }
}

export class ConnectorError extends UniContextError {
  constructor(message: string, options?: ErrorOptions) {
    super('connector', message, options);
  }
}

export function isUniContextError(e: unknown): e is UniContextError {
  return e instanceof UniContextError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
