import type { AiProviderId } from './config.js';
import { ConfigError, PolicyViolationError, RateLimitedError, UniContextError } from './errors.js';

/** The only jobs AI may do (§47). Everything else must work without AI. */
export const AI_TASKS = [
  'deadline_extraction',
  'course_matching',
  'announcement_classification',
  'task_extraction',
  'lecture_topic_extraction',
] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** §48: anything an AI produced can only be stored with one of these origins. */
export const AI_ALLOWED_ORIGINS = ['extracted', 'inferred'] as const;
export type AiOrigin = (typeof AI_ALLOWED_ORIGINS)[number];

export function assertAiOrigin(origin: string): asserts origin is AiOrigin {
  if (!(AI_ALLOWED_ORIGINS as readonly string[]).includes(origin)) {
    throw new PolicyViolationError(
      `AI output cannot be stored with origin "${origin}" (only extracted/inferred, §48)`,
    );
  }
}

export interface AiRequest {
  task: AiTask;
  /** System-style instructions. */
  instructions: string;
  /** User content (already redacted by the caller where needed). */
  input: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AiResponse {
  text: string;
  provider: AiProviderId;
  model: string | undefined;
}

export interface AiProvider {
  readonly id: AiProviderId;
  /** false for the "none" provider: callers must fall back to rule-based logic. */
  readonly available: boolean;
  complete(request: AiRequest): Promise<AiResponse>;
}

export class AiUnavailableError extends UniContextError {
  constructor(message = 'No AI provider configured') {
    super('config', message);
  }
}

export const noneAiProvider: AiProvider = {
  id: 'none',
  available: false,
  complete: () => Promise.reject(new AiUnavailableError()),
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AiProviderOptions {
  provider: AiProviderId;
  model?: string;
  baseUrl?: string;
  /** Resolved from the SecretStore by the caller; never read from config. */
  apiKey?: string;
  fetch?: FetchLike;
}

function assertTask(task: string): void {
  if (!(AI_TASKS as readonly string[]).includes(task))
    throw new PolicyViolationError(`AI task not allowed: ${task}`);
}

async function postJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new RateLimitedError(
      'AI provider rate limited',
      Number.isFinite(ra) ? { retryAfterMs: ra * 1000 } : undefined,
    );
  }
  if (!res.ok) throw new UniContextError('internal', `AI provider HTTP ${res.status}`);
  return res.json();
}

function readPath(value: unknown, keys: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Build a provider from config. Provider-specific HTTP calls are deliberately minimal (no SDK deps). */
export function createAiProvider(options: AiProviderOptions): AiProvider {
  const fetchFn: FetchLike = options.fetch ?? ((i, init) => fetch(i, init));
  if (options.provider === 'none') return noneAiProvider;
  if (!options.model)
    throw new ConfigError(`ai.model is required for provider ${options.provider}`);
  const model = options.model;

  switch (options.provider) {
    case 'openai': {
      if (!options.apiKey)
        throw new ConfigError(
          'OpenAI API key missing (set ai.apiKeyRef and store it in the keychain)',
        );
      const base = options.baseUrl ?? 'https://api.openai.com/v1';
      const key = options.apiKey;
      return {
        id: 'openai',
        available: true,
        async complete(req) {
          assertTask(req.task);
          const json = await postJson(
            fetchFn,
            `${base}/chat/completions`,
            { authorization: `Bearer ${key}` },
            {
              model,
              max_tokens: req.maxTokens ?? 1024,
              messages: [
                { role: 'system', content: req.instructions },
                { role: 'user', content: req.input },
              ],
            },
            req.signal,
          );
          const text = readPath(json, ['choices', 0, 'message', 'content']);
          return { text: typeof text === 'string' ? text : '', provider: 'openai', model };
        },
      };
    }
    case 'anthropic': {
      if (!options.apiKey)
        throw new ConfigError(
          'Anthropic API key missing (set ai.apiKeyRef and store it in the keychain)',
        );
      const base = options.baseUrl ?? 'https://api.anthropic.com/v1';
      const key = options.apiKey;
      return {
        id: 'anthropic',
        available: true,
        async complete(req) {
          assertTask(req.task);
          const json = await postJson(
            fetchFn,
            `${base}/messages`,
            { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            {
              model,
              max_tokens: req.maxTokens ?? 1024,
              system: req.instructions,
              messages: [{ role: 'user', content: req.input }],
            },
            req.signal,
          );
          const blocks = readPath(json, ['content']);
          const text = Array.isArray(blocks)
            ? blocks
                .map((b) =>
                  readPath(b, ['type']) === 'text' ? String(readPath(b, ['text']) ?? '') : '',
                )
                .join('')
            : '';
          return { text, provider: 'anthropic', model };
        },
      };
    }
    case 'ollama': {
      const base = options.baseUrl ?? 'http://127.0.0.1:11434';
      return {
        id: 'ollama',
        available: true,
        async complete(req) {
          assertTask(req.task);
          const json = await postJson(
            fetchFn,
            `${base}/api/chat`,
            {},
            {
              model,
              stream: false,
              messages: [
                { role: 'system', content: req.instructions },
                { role: 'user', content: req.input },
              ],
            },
            req.signal,
          );
          const text = readPath(json, ['message', 'content']);
          return { text: typeof text === 'string' ? text : '', provider: 'ollama', model };
        },
      };
    }
  }
}
