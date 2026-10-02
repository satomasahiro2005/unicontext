import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import {
  ADDITION_STATUSES,
  type AdditionStatus,
  type JsonValue,
  type TaskStatus,
  TASK_STATUSES,
} from '@unicontext/canonical-model';
import {
  buildGradeReport,
  downloadCourseFiles,
  getView,
  localFile,
  MAX_DOWNLOADS_PER_REQUEST,
  MAX_OPEN_PER_REQUEST,
  mirrorFiles,
  mirrorStatus,
  openAnnouncements,
  setPaceSlots,
} from '@unicontext/context-engine';
import {
  isUniContextError,
  NotFoundError,
  PolicyViolationError,
  redact,
  REDACTED,
  ValidationError,
  errorMessage,
} from '@unicontext/core';
import {
  applyProposal,
  buildAssignments,
  handleMcpHttp,
  resolveCourse,
  type Proposal,
} from '@unicontext/mcp';
import type { NotificationService } from '@unicontext/notifications';
import { toCitation } from '@unicontext/provenance';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AdditionResponse,
  AdditionsResponse,
  AnnouncementReadResponse,
  AnnouncementResponse,
  AnnouncementsResponse,
  UnopenedAnnouncementsResponse,
  AssignmentsResponse,
  ConflictsResponse,
  CoursesResponse,
  CourseFilesResponse,
  DownloadFilesResponse,
  MirrorResponse,
  MirrorStatusResponse,
  GradesResponse,
  HealthResponse,
  NotificationsResponse,
  PaceResponse,
  PaceSetResponse,
  ProposalsResponse,
  ProposalView,
  SessionResponse,
  SettingsResponse,
  SourceRefResponse,
  SourcesResponse,
  SyncJob,
  SyncJobResponse,
  TeamsActivityResponse,
} from './api-types.js';
import { listCourses } from './courses.js';
import type { Runtime } from './runtime.js';
import { requireSource } from './runtime.js';
import {
  bearerToken,
  CSRF_COOKIE,
  CSRF_HEADER,
  CsrfTokens,
  isLoopbackHost,
  isLoopbackOrigin,
  originMatchesHost,
  parseCookies,
} from './security.js';
import { tokensEqual } from './token.js';

export interface RestServerOptions {
  runtime: Runtime;
  /** Bearer token required for writes (§41). */
  token: string;
  version: string;
  startedAt?: string;
  notifications?: NotificationService | undefined;
  /** Built Web UI (apps/web/dist). Defaults to the monorepo location. */
  webDir?: string | undefined;
  /** Mount the MCP streamable HTTP endpoint at /mcp (§39). Default true. */
  mcp?: boolean;
  /** Called by POST /api/v1/daemon/stop. */
  onStop?: () => void;
}

export function defaultWebDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'web', 'dist');
}

const OPEN_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'unknown'];

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const CorrectBodySchema = z.object({
  value: JsonValueSchema,
  note: z.string().max(2000).optional(),
});
const PaceSlotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  period: z.number().int().positive().optional(),
});
const PaceBodySchema = z.object({
  slots: z.array(z.union([z.string().min(1).max(100), PaceSlotSchema])).max(14),
});
const IdentityBodySchema = z.object({ leftId: z.string().min(1), rightId: z.string().min(1) });
const TaskStatusBodySchema = z.object({
  // expired_past_term is derived from the academic calendar and cannot be set by hand.
  status: z.enum(
    TASK_STATUSES.filter((x) => x !== 'expired_past_term') as unknown as [
      TaskStatus,
      ...TaskStatus[],
    ],
  ),
  note: z.string().max(2000).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new ValidationError(
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  return r.data;
}

function statusFor(e: unknown): number {
  if (e instanceof ValidationError) return 400;
  if (e instanceof NotFoundError) return 404;
  if (e instanceof PolicyViolationError) return 403;
  if (isUniContextError(e)) {
    switch (e.code) {
      case 'auth_required':
        return 401;
      case 'config':
        return 409;
      case 'rate_limited':
        return 429;
      case 'offline':
        return 503;
      default:
        return 500;
    }
  }
  return 500;
}

export function toProposalView(p: Proposal): ProposalView {
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    preview: p.preview,
    subject: p.subject,
    predicate: p.predicate,
    value: p.value,
    note: p.note,
  };
}

/** Keep only scheme and host: webhook URLs (Slack/Discord/...) carry their secret in the path. */
function maskUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}/${REDACTED}`;
  } catch {
    return REDACTED;
  }
}

/** config for GET /api/v1/settings: redacted, with URLs that can embed credentials masked (§41). */
export function settingsConfig(config: Runtime['config']): Record<string, unknown> {
  const out = redact(config) as {
    notifications?: { sinks?: { webhook?: { url?: unknown } } };
    sources?: Record<string, { url?: unknown } | null>;
  } & Record<string, unknown>;
  const hook = out.notifications?.sinks?.webhook;
  if (hook && typeof hook.url === 'string') hook.url = maskUrl(hook.url);
  for (const src of Object.values(out.sources ?? {})) {
    if (!src || typeof src.url !== 'string') continue;
    try {
      const u = new URL(src.url);
      if (u.username || u.password) {
        u.username = '';
        u.password = '';
        src.url = u.toString();
      }
    } catch {
      // not a URL; leave as redacted text
    }
  }
  return out;
}

function profileRedaction(runtime: Runtime): { extraValuePatterns?: RegExp[] } {
  const pattern = runtime.profile?.privacy.studentIdPattern;
  if (!pattern) return {};
  try {
    return { extraValuePatterns: [new RegExp(pattern, 'g')] };
  } catch {
    return {};
  }
}

const FALLBACK_INDEX = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>UniContext</title>
<body style="font-family:system-ui;margin:2rem"><h1>UniContext</h1>
<p>Web UI はまだビルドされていません。<code>pnpm build</code> を実行してください。</p>
<p><a href="/api/v1/today">/api/v1/today</a></p></body></html>`;

/** Fastify app: REST (§41) + static Web UI + MCP over streamable HTTP. Bind it to 127.0.0.1 only. */
export async function createRestServer(options: RestServerOptions): Promise<FastifyInstance> {
  const { runtime, token } = options;
  const { uc } = runtime;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
  const csrf = new CsrfTokens(token);
  const startedAt = options.startedAt ?? new Date().toISOString();
  const log = runtime.logger.child({ component: 'rest' });

  // ---- DNS rebinding / cross-origin protection (§41) -------------------------------------
  app.addHook('onRequest', async (request, reply) => {
    if (!isLoopbackHost(request.headers.host)) {
      return reply.code(403).send({
        error: { code: 'forbidden_host', message: 'Host header must be a loopback name' },
      });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden_origin', message: 'Origin is not allowed' } });
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (request.url.startsWith('/api/') || request.url.startsWith('/mcp'))
      reply.header('Cache-Control', 'no-store');
    return undefined;
  });

  // ---- writes need the bearer token, or the Web UI's CSRF pair ----------------------------
  const requireWrite = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const bearer = bearerToken(request.headers.authorization);
    if (bearer !== undefined) {
      if (tokensEqual(token, bearer)) return;
      return void reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Invalid bearer token' } });
    }
    const header = request.headers[CSRF_HEADER];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const cookie = parseCookies(request.headers.cookie)[CSRF_COOKIE];
    const sameOrigin = originMatchesHost(request.headers.origin, request.headers.host);
    if (headerValue && cookie && headerValue === cookie && csrf.verify(headerValue) && sameOrigin)
      return;
    const code = headerValue || cookie ? 'csrf_failed' : 'unauthorized';
    return void reply.code(code === 'csrf_failed' ? 403 : 401).send({
      error: {
        code,
        message: 'Writes need Authorization: Bearer <token> (CLI) or a valid CSRF token (Web UI)',
      },
    });
  };
  const write = { preHandler: requireWrite };

  // Background syncs started with `?wait=0` (kept in memory; the newest 50).
  const syncJobs = new Map<string, SyncJob>();
  let syncJobSeq = 0;
  const rememberSyncJob = (job: SyncJob): void => {
    syncJobs.set(job.id, job);
    while (syncJobs.size > 50) {
      const oldest = syncJobs.keys().next().value;
      if (oldest === undefined) break;
      syncJobs.delete(oldest);
    }
  };

  app.setErrorHandler((error, request, reply) => {
    const status = statusFor(error);
    const fe = error as { statusCode?: number; code?: string; message?: string };
    const httpStatus =
      fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500 ? fe.statusCode : status;
    if (httpStatus >= 500)
      log.error('request failed', { url: request.url, error: errorMessage(error) });
    const code = isUniContextError(error) ? error.code : (fe.code ?? 'error');
    const message =
      httpStatus >= 500 && !isUniContextError(error) ? 'Internal error' : errorMessage(error);
    void reply.code(httpStatus).send({ error: { code, message: redact(message) as string } });
  });

  const q = (request: FastifyRequest): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries((request.query ?? {}) as Record<string, unknown>))
      out[k] = Array.isArray(v) ? String(v[0]) : typeof v === 'string' ? v : undefined;
    return out;
  };
  const intParam = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0)
      throw new ValidationError(`${name} must be a positive integer`);
    return n;
  };
  const opt = <T extends Record<string, unknown>>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

  // ---- reads ------------------------------------------------------------------------------
  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    ok: true,
    version: options.version,
    startedAt,
    pid: process.pid,
    dev: runtime.dev,
  }));

  app.get('/api/v1/session', async (_request, reply): Promise<SessionResponse> => {
    const csrfToken = csrf.issue();
    reply.header('Set-Cookie', `${CSRF_COOKIE}=${csrfToken}; Path=/; HttpOnly; SameSite=Strict`);
    return { csrfToken };
  });

  app.get('/api/v1/today', async () => getView(uc.context, 'today', {}));
  app.get('/api/v1/tomorrow', async () => getView(uc.context, 'tomorrow', {}));
  app.get('/api/v1/week', async () => getView(uc.context, 'week', {}));
  app.get('/api/v1/admin', async () => getView(uc.context, 'admin', {}));

  app.get<{ Querystring: { term?: string } }>(
    '/api/v1/courses',
    async (request): Promise<CoursesResponse> =>
      listCourses(uc, { term: request.query.term || undefined }),
  );

  app.get<{ Querystring: { year?: string; status?: string; failed?: string } }>(
    '/api/v1/grades',
    async (request): Promise<GradesResponse> => {
      const q = request.query;
      const year = q.year && /^\d{4}$/.test(q.year) ? Number(q.year) : undefined;
      if (q.year && year === undefined) throw new ValidationError('year must be a 4-digit year');
      const statuses = (q.status ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      return buildGradeReport(uc, {
        year,
        ...(statuses.length ? { statuses } : {}),
        failedOnly: q.failed === '1' || q.failed === 'true',
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/sync-jobs/:id', async (request) => {
    const job = syncJobs.get(request.params.id);
    if (!job) throw new NotFoundError(`sync job ${request.params.id}`);
    return { job } satisfies SyncJobResponse;
  });

  app.get<{ Params: { id: string } }>('/api/v1/courses/:id', async (request) =>
    getView(uc.context, 'course', { courseOfferingId: request.params.id }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/courses/:id/files',
    async (request): Promise<CourseFilesResponse> =>
      getView(
        uc.context,
        'course-files',
        opt({ courseOfferingId: request.params.id, path: q(request).path }),
      ),
  );

  app.get('/api/v1/teams-activity', async (request): Promise<TeamsActivityResponse> => {
    const query = q(request);
    return getView(
      uc.context,
      'teams-activity',
      opt({
        since: query.since,
        courseOfferingId: query.course,
        limit: intParam(query.limit, 'limit'),
      }),
    );
  });

  app.get('/api/v1/pace', async (): Promise<PaceResponse> => uc.context.paceOverview());

  app.get<{ Params: { id: string } }>('/api/v1/lectures/:id', async (request) => {
    const bundle = uc.context.lecture({ lectureId: request.params.id });
    return bundle;
  });

  const assignments = async (request: FastifyRequest): Promise<AssignmentsResponse> => {
    const query = q(request);
    const raw = query.status;
    const statuses =
      raw === 'all'
        ? [...TASK_STATUSES]
        : (raw ? raw.split(',').map((s) => s.trim()) : OPEN_STATUSES).map((s) => {
            if (!(TASK_STATUSES as readonly string[]).includes(s))
              throw new ValidationError(`unknown status: ${s}`);
            return s as TaskStatus;
          });
    const includePast = query.includePast === '1' || query.includePast === 'true';
    return {
      assignments: buildAssignments(
        uc,
        opt({ statuses, courseOfferingId: query.course, includePast: includePast || undefined }),
      ),
    };
  };
  app.get('/api/v1/assignments', assignments);
  app.get('/api/v1/tasks', assignments);

  app.get('/api/v1/deadlines', async (request) => {
    const query = q(request);
    return getView(
      uc.context,
      'deadline',
      opt({ days: intParam(query.days, 'days'), courseOfferingId: query.course }),
    );
  });

  app.get('/api/v1/changes', async (request) => {
    const query = q(request);
    if (query.since !== undefined && Number.isNaN(new Date(query.since).getTime()))
      throw new ValidationError('since must be an ISO-8601 timestamp');
    return getView(
      uc.context,
      'changes',
      opt({ since: query.since, courseOfferingId: query.course }),
    );
  });

  app.get('/api/v1/search', async (request) => {
    const query = q(request);
    const text = (query.q ?? '').trim();
    if (!text) throw new ValidationError('q is required');
    const limit = intParam(query.limit, 'limit');
    return uc.search.search(
      text,
      opt({ limit: Math.min(limit ?? 20, 100), courseOfferingId: query.course }),
    );
  });

  app.get('/api/v1/announcements', async (request): Promise<AnnouncementsResponse> => {
    const query = q(request);
    if (query.since !== undefined && Number.isNaN(new Date(query.since).getTime()))
      throw new ValidationError('since must be an ISO-8601 timestamp');
    const limit = intParam(query.limit, 'limit');
    return {
      announcements: uc.context.listAnnouncements(
        opt({
          since: query.since,
          unreadOnly: query.unreadOnly === '1' || query.unreadOnly === 'true' ? true : undefined,
          courseOfferingId: query.course ? resolveCourse(uc, query.course).ref.id : undefined,
          limit: Math.min(limit ?? 50, 200),
        }),
      ),
    };
  });

  app.get('/api/v1/announcements/unopened', async (): Promise<UnopenedAnnouncementsResponse> => ({
    announcements: uc.context.unopenedAnnouncements(),
  }));

  app.get<{ Params: { id: string } }>(
    '/api/v1/announcements/:id',
    async (request): Promise<AnnouncementResponse> => {
      const announcement = uc.context.getAnnouncement(request.params.id);
      if (!announcement) throw new NotFoundError(`announcement ${request.params.id}`);
      return { announcement };
    },
  );

  app.get('/api/v1/conflicts', async (): Promise<ConflictsResponse> => ({
    conflicts: uc.context.admin().conflicts,
  }));

  app.get('/api/v1/sources', async (): Promise<SourcesResponse> => ({
    sources: runtime.describeSources(),
  }));

  app.get<{ Params: { id: string } }>(
    '/api/v1/source-refs/:id',
    async (request): Promise<SourceRefResponse> => {
      const reference = uc.sync.stores.sourceRefs.get(request.params.id);
      if (!reference) throw new NotFoundError(`source reference ${request.params.id}`);
      const raw = reference.rawItemId ? uc.sync.stores.raw.get(reference.rawItemId) : undefined;
      const wantsRaw = q(request).raw === '1';
      const factIds = uc.db.sqlite
        .prepare(
          'SELECT id FROM facts WHERE source_reference_id = ? AND retracted_at IS NULL LIMIT 50',
        )
        .all(reference.id) as { id: string }[];
      const facts = uc.sync.facts.getMany(factIds.map((f) => f.id)).map((f) => ({
        id: f.id,
        subject: f.subject,
        predicate: f.predicate,
        value: f.value,
        origin: f.origin,
        observedAt: f.observedAt,
      }));
      return {
        reference,
        citation: toCitation(reference, uc.timezone),
        rawItem: raw
          ? {
              id: raw.id,
              sourceType: raw.sourceType,
              externalId: raw.externalId,
              fetchedAt: raw.fetchedAt,
              sourceUpdatedAt: raw.sourceUpdatedAt,
              deletedAt: raw.deletedAt,
              ...(wantsRaw
                ? { payload: redact(raw.payload, profileRedaction(runtime)) as JsonValue }
                : {}),
            }
          : undefined,
        facts,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/entities/:id', async (request) => {
    const entity = uc.sync.stores.entities.get(request.params.id);
    if (!entity) throw new NotFoundError(`entity ${request.params.id}`);
    return { entity, citations: uc.context.citationsFor([entity.id]) };
  });

  app.get('/api/v1/identity/links', async (request) => {
    const status = q(request).status;
    const allowed = ['auto', 'suggested', 'confirmed', 'rejected'] as const;
    if (status !== undefined && !(allowed as readonly string[]).includes(status))
      throw new ValidationError(`unknown status: ${status}`);
    return {
      links: uc.identity.listLinks(status ? { status: status as (typeof allowed)[number] } : {}),
    };
  });

  app.get('/api/v1/notifications', async (request): Promise<NotificationsResponse> => {
    const limit = intParam(q(request).limit, 'limit') ?? 50;
    return { notifications: options.notifications?.list({ limit: Math.min(limit, 200) }) ?? [] };
  });

  app.get('/api/v1/proposals', async (request): Promise<ProposalsResponse> => {
    const status = q(request).status;
    const list = runtime.proposals.list(status === 'all' ? {} : { status: 'pending' });
    return { proposals: list.map(toProposalView) };
  });

  app.get('/api/v1/additions', async (request): Promise<AdditionsResponse> => {
    const status = q(request).status;
    if (
      status !== undefined &&
      status !== 'all' &&
      !(ADDITION_STATUSES as readonly string[]).includes(status)
    )
      throw new ValidationError(`unknown status: ${status}`);
    const limit = intParam(q(request).limit, 'limit') ?? 200;
    return {
      additions: uc.additions.list({
        ...(status === undefined
          ? { statuses: ['unconfirmed'] }
          : status === 'all'
            ? {}
            : { statuses: [status as AdditionStatus] }),
        limit: Math.min(limit, 500),
      }),
    };
  });

  app.get('/api/v1/settings', async (): Promise<SettingsResponse> => ({
    version: options.version,
    dataDir: runtime.paths.root,
    configFile: runtime.paths.configFile,
    profile: runtime.profile?.id,
    timezone: uc.timezone,
    telemetry: runtime.config.telemetry.enabled,
    secretBackend: runtime.secrets.backend,
    config: settingsConfig(runtime.config),
  }));

  // ---- writes (bearer token or CSRF) -----------------------------------------------------
  // A sync can outlast any HTTP client timeout (LCU: minutes). `?wait=0` starts it in the
  // background and answers 202 with a job to poll; without it the request waits for the report.
  app.post<{ Params: { id: string }; Querystring: { wait?: string }; Body: unknown }>(
    '/api/v1/sources/:id/sync',
    write,
    async (request, reply) => {
      const sourceId = request.params.id;
      requireSource(runtime, sourceId);
      if (request.query.wait !== '0' && request.query.wait !== 'false') {
        const report = await uc.scheduler.trigger(sourceId);
        return { report };
      }
      const job: SyncJob = {
        id: `${sourceId}-${Date.now().toString(36)}-${(++syncJobSeq).toString(36)}`,
        sourceId,
        state: 'running',
        startedAt: new Date().toISOString(),
      };
      rememberSyncJob(job);
      uc.scheduler.trigger(sourceId).then(
        (report) => {
          job.report = report;
          job.state = report.ok ? 'done' : 'failed';
          if (!report.ok && report.error) job.error = report.error;
          job.finishedAt = new Date().toISOString();
        },
        (e: unknown) => {
          job.state = 'failed';
          job.error = errorMessage(e);
          job.finishedAt = new Date().toISOString();
        },
      );
      return reply.code(202).send({ job } satisfies SyncJobResponse);
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/facts/:id/correct',
    write,
    async (request) => {
      const body = parse(CorrectBodySchema, request.body);
      const id = request.params.id;
      let subject: string | undefined;
      let predicate: string | undefined;
      const conflict = uc.resolver.getConflict(id);
      if (conflict) {
        subject = conflict.subject;
        predicate = conflict.predicate;
      } else {
        const fact = uc.sync.facts.get(id);
        if (fact) {
          subject = fact.subject;
          predicate = fact.predicate;
        }
      }
      if (!subject || !predicate) throw new NotFoundError(`fact or conflict ${id}`);
      const result = uc.resolver.correct({
        subject,
        predicate,
        value: body.value,
        ...(body.note ? { note: body.note } : {}),
      });
      uc.identity.invalidate();
      return { fact: result.fact, conflict: result.conflict };
    },
  );

  const storePace = (idOrName: string, input: (string | z.infer<typeof PaceSlotSchema>)[]) => {
    const { ref } = resolveCourse(uc, idOrName);
    const { slots, fact } = setPaceSlots(uc, ref, input);
    return { course: ref, slots: slots.map((s) => uc.context.paceSlotView(s)), fact };
  };
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/courses/:id/pace',
    write,
    async (request): Promise<PaceSetResponse> =>
      storePace(request.params.id, parse(PaceBodySchema, request.body).slots),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/v1/courses/:id/pace',
    write,
    async (request): Promise<PaceSetResponse> => storePace(request.params.id, []),
  );

  app.post<{ Body: unknown }>('/api/v1/identity/confirm', write, async (request) => {
    const body = parse(IdentityBodySchema, request.body);
    const link = uc.identity.confirm(body.leftId, body.rightId);
    uc.identity.invalidate();
    return { link };
  });
  app.post<{ Body: unknown }>('/api/v1/identity/reject', write, async (request) => {
    const body = parse(IdentityBodySchema, request.body);
    const link = uc.identity.reject(body.leftId, body.rightId);
    uc.identity.invalidate();
    return { link };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/tasks/:id/status',
    write,
    async (request) => {
      const body = parse(TaskStatusBodySchema, request.body);
      const task = uc.tasks.setStatus(request.params.id, body.status, {
        actor: 'user',
        ...(body.note ? { note: body.note } : {}),
      });
      return { task };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/proposals/:id/confirm', write, async (request) => {
    const { proposal, fact } = applyProposal(uc, runtime.proposals, request.params.id);
    uc.identity.invalidate();
    return { proposal: toProposalView(proposal), fact };
  });
  app.post<{ Params: { id: string } }>('/api/v1/proposals/:id/reject', write, async (request) => {
    return { proposal: toProposalView(runtime.proposals.reject(request.params.id)) };
  });

  // Fetch notice bodies on the user's request. Unread LiveCampusU notices become read there
  // (cannot be undone); the adapter serializes this with the sync, which never opens them.
  app.post<{ Body: unknown }>('/api/v1/announcements/open', write, async (request) => {
    const body = parse(
      z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(MAX_OPEN_PER_REQUEST) }),
      request.body,
    );
    return openAnnouncements(uc, body.ids);
  });
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/announcements/:id/read',
    write,
    async (request): Promise<AnnouncementReadResponse> => {
      const body = parse(z.object({ read: z.boolean().optional() }), request.body ?? {});
      return {
        announcement: uc.context.setAnnouncementRead(request.params.id, body.read ?? true),
      };
    },
  );

  // What AI clients wrote from lecture recordings: the user confirms (→ user facts) or rejects.
  app.post<{ Params: { id: string } }>(
    '/api/v1/additions/:id/confirm',
    write,
    async (request): Promise<AdditionResponse> => ({
      addition: await uc.additions.confirm(request.params.id),
    }),
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/additions/:id/reject',
    write,
    async (request): Promise<AdditionResponse> => ({
      addition: await uc.additions.reject(request.params.id),
    }),
  );

  // ---- class files (Teams/SharePoint): on-demand download, local copy, mirror -------------
  // Downloads are read-only at the source; the connector serializes them with its sync.
  app.post<{ Body: unknown }>(
    '/api/v1/files/download',
    write,
    async (request): Promise<DownloadFilesResponse> => {
      const body = parse(
        z.object({
          ids: z.array(z.string().min(1).max(1000)).min(1).max(MAX_DOWNLOADS_PER_REQUEST),
          extract: z.boolean().optional(),
        }),
        request.body,
      );
      return downloadCourseFiles(uc, body.ids, {
        filesDir: runtime.filesDir,
        ...(body.extract !== undefined ? { extract: body.extract } : {}),
      });
    },
  );
  app.get<{ Params: { id: string } }>('/api/v1/files/:id/content', async (request, reply) => {
    const f = localFile(uc, request.params.id, { filesDir: runtime.filesDir });
    if (!f) throw new NotFoundError(`no local copy of ${request.params.id} (download it first)`);
    return reply
      .header('Content-Type', f.mimeType ?? 'application/octet-stream')
      .header('Content-Length', String(f.bytes))
      .header('Content-Disposition', contentDisposition(f.name))
      .send(createReadStream(f.path));
  });
  app.get('/api/v1/files/mirror', async (): Promise<MirrorStatusResponse> => ({
    sources: mirrorStatus(uc, { filesDir: runtime.filesDir }),
  }));
  app.post<{ Body: unknown }>(
    '/api/v1/files/mirror',
    write,
    async (request): Promise<MirrorResponse> => {
      const body = parse(z.object({ sourceId: z.string().min(1).optional() }), request.body ?? {});
      return mirrorFiles(uc, {
        filesDir: runtime.filesDir,
        ...(body.sourceId ? { sourceId: body.sourceId } : {}),
      });
    },
  );

  app.post('/api/v1/daemon/stop', write, async () => {
    setImmediate(() => options.onStop?.());
    return { ok: true };
  });

  // ---- MCP over streamable HTTP (§39), stateless -------------------------------------------
  if (options.mcp !== false) {
    app.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      handler: async (request, reply) => {
        reply.hijack();
        try {
          await handleMcpHttp(
            {
              uc,
              proposals: runtime.proposals,
              logger: runtime.logger,
              version: options.version,
              filesDir: runtime.filesDir,
            },
            request.raw,
            reply.raw,
            request.body,
          );
        } catch (e) {
          log.error('mcp request failed', { error: errorMessage(e) });
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(500, { 'content-type': 'application/json' });
            reply.raw.end(JSON.stringify({ error: { code: 'error', message: 'Internal error' } }));
          }
        }
      },
    });
  }

  app.all('/api/*', async (request, reply) => {
    return reply.code(404).send({
      error: {
        code: 'not_found',
        message: `No route for ${request.method} ${request.url.split('?')[0]}`,
      },
    });
  });

  // ---- Web UI static files (SPA fallback) --------------------------------------------------
  const webDir = options.webDir ?? defaultWebDir();
  if (existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: ['index.html'] });
    const index = readFileSync(path.join(webDir, 'index.html'), 'utf8');
    app.setNotFoundHandler((request, reply) => {
      const wantsPage = request.method === 'GET' && !path.extname(request.url.split('?')[0] ?? '');
      if (wantsPage) return reply.code(200).type('text/html; charset=utf-8').send(index);
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  } else {
    app.get('/', async (_request, reply) =>
      reply.type('text/html; charset=utf-8').send(FALLBACK_INDEX),
    );
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }),
    );
  }

  return app;
}

/** `attachment` with an ASCII fallback name and the real (UTF-8) name (RFC 6266 / 5987). */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
