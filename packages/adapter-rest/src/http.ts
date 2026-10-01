import { ValidationError } from '@unicontext/core';
import type { OperationInfo, OperationParameter } from './openapi.js';

/** Join a base URL (which may have a path prefix such as /v1) and an API path. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function scalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Turn an operation + parameter values into a URL and headers. Path parameters are
 * percent-encoded; query arrays are repeated keys (OpenAPI `explode: true`, the default) or comma
 * separated; header parameters become headers; undeclared names are sent as query parameters.
 */
export function buildRequest(
  base: string,
  operation: Pick<OperationInfo, 'path' | 'parameters' | 'operationId'>,
  values: Record<string, unknown>,
): BuiltRequest {
  const declared = new Map<string, OperationParameter>(
    operation.parameters.map((p) => [p.name, p]),
  );
  let path = operation.path;
  const query: [string, string][] = [];
  const headers: Record<string, string> = {};

  for (const p of operation.parameters) {
    if (p.required && (values[p.name] === undefined || values[p.name] === null))
      throw new ValidationError(
        `Operation ${operation.operationId}: missing required ${p.in} parameter "${p.name}"`,
      );
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const def = declared.get(name);
    if (def?.in === 'path') {
      path = path.split(`{${name}}`).join(encodeURIComponent(scalar(value)));
    } else if (def?.in === 'header') {
      headers[name] = scalar(value);
    } else if (def?.in === 'cookie') {
      throw new ValidationError(
        `Operation ${operation.operationId}: cookie parameters are not supported ("${name}")`,
      );
    } else if (Array.isArray(value)) {
      if (def?.explode === false) query.push([name, value.map(scalar).join(',')]);
      else for (const v of value) query.push([name, scalar(v)]);
    } else query.push([name, scalar(value)]);
  }
  const leftover = /\{([^}]+)\}/.exec(path);
  if (leftover)
    throw new ValidationError(
      `Operation ${operation.operationId}: no value for path parameter "${leftover[1]}"`,
    );

  const qs = query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return { url: joinUrl(base, path) + (qs ? `?${qs}` : ''), headers };
}

/** `Link: <https://x/page2>; rel="next", <...>; rel="last"` → URL of the requested relation. */
export function parseLinkHeader(
  header: string | null | undefined,
  rel = 'next',
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/,\s*(?=<)/)) {
    const m = /^\s*<([^>]*)>\s*(.*)$/.exec(part);
    if (!m) continue;
    const params = m[2] ?? '';
    const relMatch = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(params);
    const rels = (relMatch?.[1] ?? relMatch?.[2] ?? '').split(/\s+/);
    if (rels.includes(rel)) return m[1];
  }
  return undefined;
}
