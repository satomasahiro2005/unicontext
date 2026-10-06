import type { RawItem, SyncInput, SyncResult } from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  ConnectorError,
  type FetchLike,
  OfflineError,
  parseDuration,
  RateLimitedError,
  ValidationError,
} from '@unicontext/core';
import { toIsoDateTime } from './coerce.js';
import { evalExpr, renderTemplate, toArray } from './expr.js';
import { PARENT_KEY } from './normalizer.js';
import { stripCredentials } from './sanitize.js';
import type { MappingSpec, ResourceSpec } from './spec.js';

/** One adapter-specific call (MCP tool, CLI invocation, REST request), already templated. */
export interface ResourceRequest {
  resource: ResourceSpec;
  /** `resource.call` with every `{{...}}` rendered. */
  call: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ResourceResponse {
  /** Parsed result (JSON). `select` is applied to it. */
  data: unknown;
  /** Pagination hook: the (templated) call that fetches the next page of this resource. */
  next?: Record<string, unknown>;
  productVersion?: { product: string; version: string };
  warnings?: string[];
}

/** The only adapter-specific part of syncing a mapping. */
export interface ResourceCaller {
  call(request: ResourceRequest): Promise<ResourceResponse>;
}

export interface RunOptions {
  /** Max adapter calls per SyncResult page; the rest continues via nextPageToken (default 25). */
  maxCallsPerPage?: number;
  /** Safety cap on pagination of a single call chain (default 200 pages). */
  maxPagesPerCall?: number;
  /**
   * Parent items of fan-out resources, kept between pages of one run. Adapters keep one instance
   * per adapter object; when it is empty (new process) parents are fetched again.
   */
  parentCache?: Map<string, unknown[]>;
  /**
   * When each fan-out call of a resource with `forEach.refreshAfter` last succeeded (epoch ms),
   * keyed by resource and rendered call. Adapters keep one per adapter object, so the politeness
   * window lasts as long as the process (a restart calls everything once).
   */
  fetchLog?: Map<string, number>;
  /** Clock for `refreshAfter` (default Date.now). */
  now?: () => number;
  /**
   * On-request detail run (runMappedDetails): payloads of resources taken as given (the requested
   * items), only the `only` resources are called, `onRequest` resources included, and
   * `refreshAfter` never skips a call.
   */
  detail?: { seed: Record<string, unknown[]>; only: readonly string[] };
  onWarning?: (message: string) => void;
  /** HTTP used for the spec's `files:` downloads (default: global fetch; tests inject one). */
  fileFetch?: FetchLike;
}

/** nextPageToken payload: where the run continues. Plain JSON so it survives a restart. */
interface RunState {
  /** Resource index. */
  r: number;
  /** Fan-out (parent item) index. */
  f: number;
  /** Rendered call still to execute for (r, f) when a paginated chain was interrupted. */
  n?: Record<string, unknown>;
  /** Source types that must not be reported as complete (failed or partial fetches). */
  x?: string[];
}

function decodeState(token: string | undefined): RunState {
  if (!token) return { r: 0, f: 0 };
  try {
    const v = JSON.parse(token) as Partial<RunState>;
    if (typeof v.r === 'number' && typeof v.f === 'number')
      return {
        r: v.r,
        f: v.f,
        ...(v.n && typeof v.n === 'object' ? { n: v.n } : {}),
        ...(Array.isArray(v.x) ? { x: v.x.filter((s): s is string => typeof s === 'string') } : {}),
      };
  } catch {
    // fall through
  }
  throw new ValidationError('Invalid mapping page token');
}

const FATAL = [AuthRequiredError, RateLimitedError, OfflineError];

function isFatal(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') return true;
  return FATAL.some((c) => e instanceof c);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class Budget {
  constructor(public left: number) {}
}

/**
 * Run the mapping's resources through `caller` and produce one page of a SyncResult. Handles
 * fan-out (`forEach`), `{{...}}` templating, pagination hooks (`ResourceResponse.next`), `complete`
 * bookkeeping, the credential guard, and spreading a large fan-out over several pages with
 * `nextPageToken`. Raw payloads are the selected items, unmodified except for stripped credential
 * keys and the `_parent` attachment.
 */
export async function runMappedResources(
  spec: MappingSpec,
  caller: ResourceCaller,
  input: SyncInput,
  options: RunOptions = {},
): Promise<SyncResult> {
  const maxCalls = options.maxCallsPerPage ?? 25;
  const maxPagesPerCall = options.maxPagesPerCall ?? 200;
  const cache = options.parentCache ?? new Map<string, unknown[]>();
  const state = decodeState(input.pageToken);
  if (!input.pageToken) cache.clear();
  const detail = options.detail;
  if (detail) for (const [name, items] of Object.entries(detail.seed)) cache.set(name, items);
  const fetchLog = options.fetchLog;
  const now = options.now ?? Date.now;

  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
    options.onWarning?.(m);
  };
  const incomplete = new Set(state.x ?? []);
  const items: RawItem[] = [];
  const seen = new Set<string>();
  let productVersion: SyncResult['productVersion'];
  let maxUpdated: string | undefined;

  const parentNames = new Set(
    spec.resources.flatMap((r) => (r.forEach ? [r.forEach.resource] : [])),
  );
  const skipped = (r: ResourceSpec): boolean =>
    (!!input.capabilities && !!r.capability && !input.capabilities.includes(r.capability)) ||
    (detail ? !detail.only.includes(r.name) : r.onRequest);

  /**
   * Convert the selected items of one response into payloads (credentials stripped, `_parent`
   * attached) and, when `emit` is set, into raw items. Returns the payloads: they are what
   * fan-out children see as `{{<as>.field}}` (so `{{assignment._parent.courseId}}` works).
   */
  const consume = async (
    res: ResourceSpec,
    data: unknown,
    scope: Record<string, unknown>,
    emit: boolean,
  ): Promise<unknown[]> => {
    let selected: unknown[];
    try {
      selected = toArray(await evalExpr(res.select, data));
    } catch (e) {
      throw new ConnectorError(`select of resource ${res.name} failed: ${errText(e)}`, {
        cause: e,
      });
    }
    const removedAll = new Set<string>();
    const payloads: unknown[] = [];
    for (const item of selected) {
      let externalId: string | undefined;
      try {
        const v = await evalExpr(res.externalId, item);
        externalId = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
      } catch (e) {
        warn(`${res.name}: externalId failed: ${errText(e)}`);
      }
      if (!externalId) {
        warn(`${res.name}: item without externalId skipped`);
        continue;
      }
      const key = `${res.sourceType}|${externalId}`;
      if (emit) {
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const guarded = stripCredentials(item);
      let payload: unknown = guarded.value;
      for (const p of guarded.removed) removedAll.add(p);
      if (res.attach) {
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const attached: Record<string, unknown> = {};
          for (const [k, expr] of Object.entries(res.attach)) {
            try {
              const v = await evalExpr(expr, scope);
              if (v !== undefined) attached[k] = v;
            } catch (e) {
              warn(`${res.name}: attach ${k} failed: ${errText(e)}`);
            }
          }
          payload = {
            ...(payload as Record<string, unknown>),
            [PARENT_KEY]: stripCredentials(attached).value,
          };
        } else warn(`${res.name}: attach ignored for non-object items`);
      }
      payloads.push(payload);
      if (!emit) continue;

      let sourceUpdatedAt: string | undefined;
      if (res.updatedAt) {
        try {
          sourceUpdatedAt = toIsoDateTime(await evalExpr(res.updatedAt, item), 'UTC');
        } catch (e) {
          warn(`${res.name}: updatedAt failed: ${errText(e)}`);
        }
      }
      if (sourceUpdatedAt && (!maxUpdated || Date.parse(sourceUpdatedAt) > Date.parse(maxUpdated)))
        maxUpdated = sourceUpdatedAt;
      items.push({
        sourceType: res.sourceType,
        externalId,
        payload,
        ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
      });
    }
    if (emit && removedAll.size > 0)
      warn(
        `${res.name}: removed credential-like keys from the payload (${[...removedAll].slice(0, 5).join(', ')})`,
      );
    return payloads;
  };

  /**
   * Execute the call chain of one (resource, parent) pair. Returns the interrupted continuation
   * when the budget ran out, otherwise undefined.
   */
  const runChain = async (
    res: ResourceSpec,
    scope: Record<string, unknown>,
    start: Record<string, unknown> | undefined,
    budget: Budget | undefined,
    emit: boolean,
    collected: unknown[] | undefined,
  ): Promise<{ pending: Record<string, unknown> } | undefined> => {
    let call = start ?? ((await renderTemplate(res.call, scope)) as Record<string, unknown>);
    for (let page = 0; page < maxPagesPerCall; page++) {
      if (budget) {
        if (budget.left <= 0) return { pending: call };
        budget.left -= 1;
      }
      const response = await caller.call({
        resource: res,
        call,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      for (const w of response.warnings ?? []) warn(`${res.name}: ${w}`);
      if (response.productVersion && !productVersion) productVersion = response.productVersion;
      const selected = await consume(res, response.data, scope, emit);
      collected?.push(...selected);
      if (!response.next) return undefined;
      call = response.next;
    }
    warn(`${res.name}: pagination stopped after ${maxPagesPerCall} pages`);
    incomplete.add(res.sourceType);
    return undefined;
  };

  /**
   * Fan-out elements of a resource: the parent's payloads, filtered by `forEach.where`, expanded by
   * `forEach.expand`.
   */
  const parentsFor = async (res: ResourceSpec): Promise<unknown[]> => {
    if (!res.forEach) return [];
    const kept = await keptParents(res);
    const expand = res.forEach.expand;
    if (!expand) return kept;
    const out: unknown[] = [];
    for (const p of kept) {
      try {
        out.push(...toArray(await evalExpr(expand, p)));
      } catch (e) {
        warn(`${res.name}: forEach.expand failed: ${errText(e)}`);
        incomplete.add(res.sourceType);
      }
    }
    return out;
  };

  const keptParents = async (res: ResourceSpec): Promise<unknown[]> => {
    if (!res.forEach) return [];
    const all = await parentsOf(res.forEach.resource);
    const where = res.forEach.where;
    if (!where) return all;
    const kept: unknown[] = [];
    for (const p of all) {
      try {
        const v = await evalExpr(where, p);
        if (
          v !== undefined &&
          v !== null &&
          v !== false &&
          v !== 0 &&
          v !== '' &&
          !(Array.isArray(v) && v.length === 0)
        )
          kept.push(p);
      } catch (e) {
        warn(`${res.name}: forEach.where failed: ${errText(e)}`);
        incomplete.add(res.sourceType);
      }
    }
    return kept;
  };

  /**
   * The rendered first call of a fan-out element, and whether `refreshAfter` skips it this run
   * (made within the window and not `always`). `logKey` records a successful call.
   */
  const planCall = async (
    res: ResourceSpec,
    scope: Record<string, unknown>,
    element: unknown,
  ): Promise<{ call: Record<string, unknown>; skip: boolean; logKey: string | undefined }> => {
    const call = (await renderTemplate(res.call, scope)) as Record<string, unknown>;
    const after = res.forEach?.refreshAfter;
    if (!after || !fetchLog) return { call, skip: false, logKey: undefined };
    const logKey = `${res.name}|${JSON.stringify(call)}`;
    if (detail) return { call, skip: false, logKey };
    const last = fetchLog.get(logKey);
    if (last === undefined || now() - last >= parseDuration(after))
      return { call, skip: false, logKey };
    if (res.forEach?.always) {
      try {
        const v = await evalExpr(res.forEach.always, element);
        if (v !== undefined && v !== null && v !== false && v !== 0 && v !== '')
          if (!(Array.isArray(v) && v.length === 0)) return { call, skip: false, logKey };
      } catch (e) {
        warn(`${res.name}: forEach.always failed: ${errText(e)}`);
        return { call, skip: false, logKey };
      }
    }
    return { call, skip: true, logKey };
  };

  /** Parent items of a fan-out resource (cached, or fetched again after a restart). */
  const parentsOf = async (name: string): Promise<unknown[]> => {
    const hit = cache.get(name);
    if (hit) return hit;
    const idx = spec.resources.findIndex((r) => r.name === name);
    const res = spec.resources[idx];
    if (!res) throw new ValidationError(`Unknown resource ${name}`);
    const all: unknown[] = [];
    if (res.forEach) {
      for (const p of await parentsFor(res)) {
        const scope = { [res.forEach.as]: p };
        const plan = await planCall(res, scope, p);
        if (!plan.skip) await runChain(res, scope, plan.call, undefined, false, all);
      }
    } else await runChain(res, {}, undefined, undefined, false, all);
    cache.set(name, all);
    return all;
  };

  const budget = new Budget(maxCalls);
  let resumeN = state.n;
  let nextState: RunState | undefined;

  outer: for (let ri = state.r; ri < spec.resources.length; ri++) {
    const res = spec.resources[ri];
    if (!res || skipped(res)) continue;
    let collected: unknown[] | undefined = parentNames.has(res.name) ? [] : undefined;
    if (collected && ri === state.r && (state.f > 0 || state.n !== undefined)) {
      // Resumed in the middle of a parent resource: keep appending to what earlier pages cached,
      // or (after a restart) fetch the whole parent list again without emitting it twice.
      const cached = cache.get(res.name);
      if (cached) collected = cached;
      else {
        await parentsOf(res.name);
        collected = undefined;
      }
    }
    const parents = res.forEach ? await parentsFor(res) : [undefined];
    const startF = ri === state.r ? state.f : 0;
    for (let fi = startF; fi < parents.length; fi++) {
      const parent = parents[fi];
      const scope = res.forEach ? { [res.forEach.as]: parent } : {};
      let start = ri === state.r && fi === state.f ? resumeN : undefined;
      resumeN = undefined;
      try {
        let logKey: string | undefined;
        if (res.forEach && start === undefined) {
          const plan = await planCall(res, scope, parent);
          if (plan.skip) continue;
          start = plan.call;
          logKey = plan.logKey;
        }
        const interrupted = await runChain(res, scope, start, budget, true, collected);
        if (!interrupted && logKey) fetchLog?.set(logKey, now());
        if (interrupted) {
          nextState = {
            r: ri,
            f: fi,
            n: interrupted.pending,
            ...(incomplete.size ? { x: [...incomplete] } : {}),
          };
          if (collected) cache.set(res.name, collected);
          break outer;
        }
      } catch (e) {
        if (isFatal(e) || (!res.forEach && !res.optional)) throw e;
        warn(`${res.name}${res.forEach ? ` [${fi}]` : ''}: ${errText(e)}`);
        incomplete.add(res.sourceType);
      }
    }
    if (collected) cache.set(res.name, collected);
  }

  const result: SyncResult = { items };
  if (nextState) {
    result.hasMore = true;
    result.nextPageToken = JSON.stringify(nextState);
  } else {
    result.hasMore = false;
    // A fan-out child is only as complete as its parent list: if the parent failed (optional),
    // was cut by the page limit or lost rows to forEach.where errors, the children of the
    // missing parents were never listed and must not be retired.
    const byName = new Map(spec.resources.map((r) => [r.name, r] as const));
    const parentIncomplete = (r: ResourceSpec): boolean => {
      const visited = new Set<string>();
      let cur: ResourceSpec | undefined = r;
      while (cur?.forEach && !visited.has(cur.name)) {
        visited.add(cur.name);
        cur = byName.get(cur.forEach.resource);
        if (!cur || incomplete.has(cur.sourceType)) return true;
      }
      return false;
    };
    const completeTypes = [
      ...new Set(
        spec.resources
          .filter(
            (r) =>
              r.complete && !skipped(r) && !incomplete.has(r.sourceType) && !parentIncomplete(r),
          )
          .map((r) => r.sourceType),
      ),
    ];
    // A detail run reads single items: it never completes a listing nor moves the sync cursor.
    if (completeTypes.length > 0 && !detail) result.complete = { sourceTypes: completeTypes };
    if (maxUpdated && !detail) result.cursor = { lastModified: maxUpdated };
    cache.clear();
  }
  if (productVersion) result.productVersion = productVersion;
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

export interface DetailRequest {
  externalId: string;
  /** Raw source type of the stored item (picks the `details` rule; default: the first rule). */
  sourceType?: string | undefined;
  /** The stored payload: the fan-out parent the rule's resources run for. */
  payload: unknown;
}

/**
 * On-request detail fetch for one stored item: runs the `details` rule's resources for it alone
 * (`onRequest` resources included, `refreshAfter` ignored) and returns the raw items. A failing
 * call is reported in `error` (warnings for optional / fan-out failures).
 */
export async function runMappedDetails(
  spec: MappingSpec,
  caller: ResourceCaller,
  request: DetailRequest,
  options: Omit<RunOptions, 'detail' | 'parentCache'> & { signal?: AbortSignal } = {},
): Promise<{ items: RawItem[]; warnings: string[]; error?: string }> {
  const rule =
    spec.details.find((d) => d.sourceType === request.sourceType) ??
    (request.sourceType === undefined ? spec.details[0] : undefined);
  if (!rule)
    return {
      items: [],
      warnings: [],
      error: `no on-request details for ${request.sourceType ?? 'this item'}`,
    };
  const { signal, ...runOptions } = options;
  const items: RawItem[] = [];
  const warnings: string[] = [];
  const parentCache = new Map<string, unknown[]>();
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < 50; page++) {
      const res = await runMappedResources(
        spec,
        caller,
        {
          mode: 'incremental',
          ...(pageToken ? { pageToken } : {}),
          ...(signal ? { signal } : {}),
        },
        {
          ...runOptions,
          parentCache,
          detail: { seed: { [rule.resource]: [request.payload] }, only: rule.run },
        },
      );
      items.push(...res.items);
      for (const w of res.warnings ?? []) if (!warnings.includes(w)) warnings.push(w);
      if (!res.hasMore || !res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
  } catch (e) {
    return { items, warnings, error: errText(e) };
  }
  return { items, warnings };
}
