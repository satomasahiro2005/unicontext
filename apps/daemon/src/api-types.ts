/*
 * Wire types of the REST API (§41). Type-only: the Web UI and the CLI import these
 * (`@unicontext/daemon/api-types`) and never any daemon runtime code.
 *
 * Conventions: every response is a JSON object. Errors are `{ error: { code, message } }` with an
 * HTTP status. Bundles from the context engine are returned unchanged (they already carry
 * citations, §49) so the REST shapes equal the MCP shapes.
 */
import type {
  AdminContext,
  ChangesContext,
  ClassItem,
  ConflictItem,
  CourseContext,
  DeadlineContext,
  DeadlineItem,
  LectureBundle,
  PaceCourseItem,
  PaceItem,
  PaceOverview,
  PaceSlotView,
  SourceStatus,
  TodayContext,
  TomorrowContext,
  WeekContext,
  Citation,
  CourseRef,
  ResolvedValue,
} from '@unicontext/context-engine';
import type {
  Conflict,
  Fact,
  FactOrigin,
  IdentityLink,
  JsonValue,
  SourceReference,
  TaskStatus,
} from '@unicontext/canonical-model';
import type { Notification } from '@unicontext/notifications';
import type { SearchResponse } from '@unicontext/search';
import type { SyncRunReport } from '@unicontext/sync-engine';

export type {
  AdminContext,
  ChangesContext,
  ClassItem,
  Citation,
  ConflictItem,
  CourseContext,
  CourseRef,
  DeadlineContext,
  DeadlineItem,
  LectureBundle,
  Notification,
  PaceCourseItem,
  PaceItem,
  PaceOverview,
  PaceSlotView,
  ResolvedValue,
  SearchResponse,
  SourceStatus,
  SyncRunReport,
  TodayContext,
  TomorrowContext,
  WeekContext,
};

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** GET /api/v1/health (no auth, used by `unicontext doctor` and the CLI to detect the daemon). */
export interface HealthResponse {
  ok: true;
  version: string;
  startedAt: string;
  pid: number;
  /** True when running with the synthetic seed (`unicontextd --dev`). */
  dev: boolean;
}

/** GET /api/v1/session: sets the `uc_csrf` cookie and returns the token for `X-CSRF-Token`. */
export interface SessionResponse {
  csrfToken: string;
}

export interface CourseSummary {
  /** Canonical course offering id (identity-resolved, §14). */
  id: string;
  title: string;
  courseCode: string | undefined;
  instructors: string[];
  academicYear: number | undefined;
  term: string | undefined;
  /** Profile term id (e.g. "2026-2") when the term is in the academic calendar. */
  termId: string | undefined;
  /** regular = weekly timetable; unscheduled = 時間割外; intensive = 集中講義. */
  scheduleType: 'regular' | 'unscheduled' | 'intensive';
  /** Registered by the student (the academic system lists it). */
  enrolled: boolean;
  /** 再履修 class. */
  retake: boolean;
  schedule: { dayOfWeek: number; period: number | undefined; room: string | undefined }[];
  room: ResolvedValue<string>;
  linkedIds: string[];
  openConflicts: number;
}
/** A term of the academic calendar and how many of the student's courses fall in it. */
export interface TermSummary {
  id: string;
  name: string;
  current: boolean;
  courses: number;
}
/** GET /api/v1/courses[?term=<id|前期|all>] (default: the current term's registered courses) */
export interface CoursesResponse {
  courses: CourseSummary[];
  /** The term shown; undefined when every term is shown (term=all) or no calendar is known. */
  term?: { id: string; name: string; current: boolean } | undefined;
  /** Terms with the student's courses, for switching (empty without an academic calendar). */
  terms?: TermSummary[];
}

export interface AssignmentItem {
  taskId: string;
  title: string;
  course: CourseRef | undefined;
  dueAt: string | undefined;
  status: TaskStatus;
  taskKind: string;
  origin: FactOrigin;
  createdBy: string;
  overdue: boolean;
  hoursLeft: number | undefined;
  evidence: string | undefined;
  citations: Citation[];
}
/** GET /api/v1/assignments?status=pending,in_progress&course=<id> (default: not cancelled/completed/submitted... all open) and GET /api/v1/tasks */
export interface AssignmentsResponse {
  assignments: AssignmentItem[];
}

/** GET /api/v1/conflicts (open conflicts) */
export interface ConflictsResponse {
  conflicts: ConflictItem[];
}

/** One entry of GET /api/v1/sources: health plus how the source is configured. */
export interface SourceInfo extends SourceStatus {
  /** Connector package this source was loaded from (or `fake` in dev mode). */
  connector: string | undefined;
  enabled: boolean;
  /** False when the connector package is missing or failed to load (health is `failed`). */
  loaded: boolean;
  loadError: string | undefined;
  schedule: string | undefined;
  capabilities: string[];
  apiStability: string | undefined;
  running: boolean;
  /** Shell command the user runs to (re)authenticate, e.g. `unicontext login livecampusu`. */
  loginCommand: string;
}
export interface SourcesResponse {
  sources: SourceInfo[];
}

/** POST /api/v1/sources/:id/sync */
export interface SyncResponse {
  report: SyncRunReport;
}

/** GET /api/v1/source-refs/:id: where a citation points (§49). `rawPayload` only with `?raw=1`. */
export interface SourceRefResponse {
  reference: SourceReference;
  citation: Citation;
  rawItem:
    | {
        id: string;
        sourceType: string;
        externalId: string;
        fetchedAt: string;
        sourceUpdatedAt: string | undefined;
        deletedAt: string | undefined;
        payload?: JsonValue;
      }
    | undefined;
  facts: Pick<Fact, 'id' | 'subject' | 'predicate' | 'value' | 'origin' | 'observedAt'>[];
}

/** POST /api/v1/facts/:id/correct  body { value, note? } (:id = fact id or conflict id) */
export interface CorrectBody {
  value: JsonValue;
  note?: string;
}
export interface CorrectResponse {
  fact: Fact;
  /** The conflict this correction resolved, if one was open. */
  conflict: Conflict | undefined;
}

/** POST /api/v1/identity/confirm  body { leftId, rightId }; also /identity/reject */
export interface IdentityBody {
  leftId: string;
  rightId: string;
}
export interface IdentityResponse {
  link: IdentityLink;
}
/** GET /api/v1/identity/links?status=suggested */
export interface IdentityLinksResponse {
  links: IdentityLink[];
}

/** POST /api/v1/tasks/:id/status  body { status, note? }; the actor is always `user` */
export interface TaskStatusBody {
  status: TaskStatus;
  note?: string;
}

export interface NotificationsResponse {
  notifications: Notification[];
}

/** A pending write proposed by an AI client (§50). Confirmed or rejected only by the user. */
export interface ProposalView {
  id: string;
  kind: 'correct_fact';
  status: 'pending' | 'confirmed' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
  preview: string;
  subject: string;
  predicate: string;
  value: JsonValue;
  note: string | undefined;
}
export interface ProposalsResponse {
  proposals: ProposalView[];
}

/** GET /api/v1/settings (read-only; secrets are never included) */
export interface SettingsResponse {
  version: string;
  dataDir: string;
  configFile: string;
  profile: string | undefined;
  timezone: string;
  telemetry: boolean;
  secretBackend: string;
  config: Record<string, unknown>;
}

/** GET /api/v1/pace: every enrolled course of the current term and any course with self-study slots. */
export type PaceResponse = PaceOverview;

/** One weekly self-study slot: `dayOfWeek` 0 = Sunday … 6 = Saturday, times "HH:MM". */
export interface PaceSlotInput {
  dayOfWeek: number;
  startTime?: string;
  endTime?: string;
  period?: number;
}
/**
 * PUT /api/v1/courses/:id/pace  body { slots } (replaces the set; [] clears). A slot is text such as
 * "土 10:00-11:30" / "土2限", or a PaceSlotInput. :id = course offering id, course code or title.
 * DELETE /api/v1/courses/:id/pace clears the slots. Both answer with PaceSetResponse.
 */
export interface PaceSetBody {
  slots: (string | PaceSlotInput)[];
}
export interface PaceSetResponse {
  course: CourseRef;
  slots: PaceSlotView[];
  fact: Fact;
}

/** GET /api/v1/lectures/:id */
export type LectureResponse = LectureBundle;
