import { AuthRequiredError, ConnectorError, redact } from '@unicontext/core';

/** The parts of an MCP CallToolResult this adapter reads. */
export interface ToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean | undefined;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown; resource?: { text?: unknown } };
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'resource' && typeof b.resource?.text === 'string')
      out.push(b.resource.text);
  }
  return out;
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trim();
  if (!t || !/^[[{"\d-]|^(true|false|null)$/.test(t)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Error texts by which servers that wrap a token-based API say "your credentials were rejected"
 * (MCP has no error code for it). Such results become `auth_required` instead of a generic failure,
 * so `unicontext status` points at `unicontext login <source>`. Examples: edstem-mcp
 * `EDSTEM_REAUTH_REQUIRED` / "Authentication failed", "401 Unauthorized", "invalid API token".
 */
export const AUTH_ERROR_PATTERN =
  /\b(?:\w+_)?(?:REAUTH(?:_REQUIRED)?|UNAUTHENTICATED|UNAUTHORI[SZ]ED)\b|authentication failed|invalid (?:api |access )?token|\b(?:HTTP|status)[ :]*401\b/i;

/**
 * Tool results → data for `select`: `structuredContent` first, then JSON in the text content
 * (one block, the concatenation, or one JSON value per block), else `{text}`.
 * `isError` results become ConnectorError (message redacted), or AuthRequiredError when the text
 * matches AUTH_ERROR_PATTERN.
 */
export function parseToolResult(result: ToolResultLike, tool = 'tool'): unknown {
  const blocks = textBlocks(result.content);
  if (result.isError) {
    const message = String(redact(blocks.join('\n').slice(0, 500)) || 'no message');
    if (AUTH_ERROR_PATTERN.test(message))
      throw new AuthRequiredError(`MCP tool ${tool} reports rejected credentials: ${message}`);
    throw new ConnectorError(`MCP tool ${tool} returned an error: ${message}`, {
      details: { tool },
    });
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null)
    return result.structuredContent;
  if (blocks.length === 0) return {};
  if (blocks.length === 1) {
    const parsed = tryJson(blocks[0] ?? '');
    return parsed.ok ? parsed.value : { text: blocks[0] };
  }
  const joined = tryJson(blocks.join(''));
  if (joined.ok) return joined.value;
  const each = blocks.map(tryJson);
  if (each.every((p) => p.ok)) return each.map((p) => (p.ok ? p.value : undefined));
  return { text: blocks.join('\n') };
}
