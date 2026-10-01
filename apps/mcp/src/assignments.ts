import type { FactOrigin, Task, TaskStatus } from '@unicontext/canonical-model';
import type { Citation, CourseRef, UniContext } from '@unicontext/context-engine';
import { toCitation, uniqueCitations } from '@unicontext/provenance';

/** One task/assignment as shown to AI clients and the REST twin (apps/daemon `AssignmentItem`). */
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

export interface AssignmentFilter {
  /** Canonical offering id (identity-expanded by the task engine). */
  courseOfferingId?: string;
  /** Explicit statuses; overrides the defaults below. */
  statuses?: TaskStatus[];
  /** Default statuses are pending / in_progress / unknown; this adds submitted and completed. */
  includeCompleted?: boolean;
  /** Restrict to some task kinds (default: all). */
  kinds?: Task['taskKind'][];
}

export const OPEN_TASK_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'unknown'];
export const FINISHED_TASK_STATUSES: TaskStatus[] = ['submitted', 'completed'];
export const ALL_TASK_STATUSES: TaskStatus[] = [
  'pending',
  'in_progress',
  'submitted',
  'completed',
  'cancelled',
  'unknown',
];

function taskCitations(uc: UniContext, t: Task): Citation[] {
  const entityIds = [t.assignmentId, t.examId].filter((x): x is NonNullable<typeof x> => !!x);
  const fromFacts = uc.resolver.facts
    .withSources(uc.resolver.facts.getMany(t.sourceFactIds))
    .flatMap((f) => (f.source ? [toCitation(f.source, uc.timezone)] : []));
  return uniqueCitations([...uc.context.citationsFor(entityIds), ...fromFacts]);
}

/** Tasks as AssignmentItems, due-date order (undated last). Shared with the daemon's REST twin. */
export function buildAssignments(uc: UniContext, filter: AssignmentFilter = {}): AssignmentItem[] {
  const statuses =
    filter.statuses && filter.statuses.length > 0
      ? filter.statuses
      : filter.includeCompleted
        ? [...OPEN_TASK_STATUSES, ...FINISHED_TASK_STATUSES]
        : OPEN_TASK_STATUSES;
  const now = uc.clock.now().getTime();
  return uc.tasks
    .list({
      statuses,
      ...(filter.courseOfferingId ? { courseOfferingId: filter.courseOfferingId } : {}),
    })
    .filter((t) => !filter.kinds || filter.kinds.includes(t.taskKind))
    .map((t): AssignmentItem => {
      const hoursLeft = t.dueAt
        ? Math.round(((new Date(t.dueAt).getTime() - now) / 3_600_000) * 10) / 10
        : undefined;
      return {
        taskId: t.id,
        title: t.title,
        course: uc.context.courseRef(t.courseOfferingId),
        dueAt: t.dueAt,
        status: t.status,
        taskKind: t.taskKind,
        origin: t.origin,
        createdBy: t.createdBy,
        overdue: hoursLeft !== undefined && hoursLeft < 0,
        hoursLeft,
        evidence: t.evidence,
        citations: taskCitations(uc, t),
      };
    });
}
