import { Link } from '@tanstack/react-router';
import { describeChange } from '../lib/changes';
import { formatRemaining, formatShort, formatTimeRange, toDate } from '../lib/dates';
import {
  entityKindLabel,
  importanceLabel,
  importanceTone,
  materialKindLabel,
  originLabel,
  scopeLabel,
  taskStatusLabel,
  taskStatusTone,
} from '../lib/labels';
import { periodLabel, safeHttpUrl } from '../lib/text';
import { formatValue } from '../lib/values';
import type {
  AnnouncementItem,
  ChangeItem,
  Citation,
  ClassItem,
  CourseRef,
  MaterialItem,
  ResolvedValue,
  ValueCandidate,
} from '../types';
import { useTimezone } from './AppContext';
import { Citations } from './Citations';
import { Badge } from './ui';

export function CourseLink({ course }: { course: CourseRef | undefined }) {
  if (!course) return null;
  return (
    <Link to="/courses/$id" params={{ id: course.id }} className="course-link">
      {course.title}
    </Link>
  );
}

export function CandidateList({ candidates }: { candidates: readonly ValueCandidate[] }) {
  const tz = useTimezone();
  return (
    <ul className="candidates">
      {candidates.map((c, i) => (
        <li key={`${c.source}-${i}`}>
          <strong className="candidate-value">{formatValue(c.value, tz)}</strong>
          <span className="candidate-source">{c.citation?.sourceLabel ?? c.source}</span>
          <Badge>{originLabel(c.origin)}</Badge>
          <Citations citations={c.citation ? [c.citation] : []} />
        </li>
      ))}
    </ul>
  );
}

/** A resolved value; when the sources disagree, every candidate is shown instead of one pick (§12). */
export function ResolvedField({ label, value }: { label: string; value: ResolvedValue<string> }) {
  const tz = useTimezone();
  if (value.status === 'conflict') {
    return (
      <div className="conflict-box" role="group" aria-label={`${label}の競合`}>
        <p className="field-line">
          <Badge tone="bad">競合</Badge>
          <span className="field-label">{label}</span>
        </p>
        <CandidateList candidates={value.candidates} />
      </div>
    );
  }
  return (
    <p className="field-line">
      <span className="field-label">{label}</span>
      <span>{value.value === undefined ? '未定' : formatValue(value.value, tz)}</span>
    </p>
  );
}

export function ClassCard({ item, compact = false }: { item: ClassItem; compact?: boolean }) {
  const tz = useTimezone();
  const time = formatTimeRange(item.startsAt, item.endsAt, tz);
  const classes = ['card', compact ? 'card-compact' : '', item.cancelled ? 'is-cancelled' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <article className={classes}>
      <header className="card-head">
        {compact ? null : <Badge tone="info">{periodLabel(item.period)}</Badge>}
        <h3>
          <CourseLink course={item.course} />
        </h3>
        {item.cancelled ? <Badge tone="bad">休講</Badge> : null}
      </header>
      {time ? <p className="meta">{time}</p> : null}
      <ResolvedField label="教室" value={item.room} />
      {item.status.status === 'conflict' ? (
        <ResolvedField label="状態" value={item.status} />
      ) : null}
      {item.note ? <p className="note">{item.note}</p> : null}
      <Citations citations={item.citations} />
    </article>
  );
}

export function ChangeRow({ item }: { item: ChangeItem }) {
  const tz = useTimezone();
  const view = describeChange(item, tz);
  return (
    <article className="card">
      <header className="card-head">
        <Badge tone="info">{view.kindLabel}</Badge>
        <Badge>{view.typeLabel}</Badge>
        <h3 className="card-title">{view.headline}</h3>
        <time className="meta" dateTime={item.occurredAt}>
          {formatShort(item.occurredAt, tz)}
        </time>
      </header>
      {view.diffs.length > 0 ? (
        <ul className="diffs">
          {view.diffs.map((d) => (
            <li key={d.field} aria-label={d.text}>
              <span className="field-label">{d.label}</span>
              <del>{d.before}</del>
              <span aria-hidden="true"> → </span>
              <ins>{d.after}</ins>
            </li>
          ))}
          {view.hiddenDiffs > 0 ? <li className="meta">ほか{view.hiddenDiffs}件</li> : null}
        </ul>
      ) : null}
      {item.course ? (
        <p className="meta">
          <CourseLink course={item.course} />
        </p>
      ) : null}
      <Citations citations={item.citations} />
    </article>
  );
}

interface TaskLike {
  taskId: string;
  title: string;
  course: CourseRef | undefined;
  dueAt: string | undefined;
  status: string;
  origin: string;
  overdue?: boolean | undefined;
  hoursLeft?: number | undefined;
  evidence?: string | undefined;
  /** Only heard in a lecture recording (an AI client added it), not confirmed yet. */
  recorded?: { label: string; timestamp: string | undefined; source: string } | undefined;
  citations: Citation[];
}

/** Deadline / task row: due date, remaining time (never colour alone), origin when not authoritative. */
export function TaskRow({ item }: { item: TaskLike }) {
  const tz = useTimezone();
  const due = toDate(item.dueAt);
  const hoursLeft = item.hoursLeft ?? (due ? (due.getTime() - Date.now()) / 3_600_000 : undefined);
  const overdue = item.overdue ?? (hoursLeft !== undefined && hoursLeft < 0);
  const open = item.status === 'pending' || item.status === 'in_progress';
  return (
    <article className="card">
      <header className="card-head">
        <h3 className="card-title">{item.title}</h3>
        <Badge tone={taskStatusTone(item.status)}>{taskStatusLabel(item.status)}</Badge>
        {item.recorded ? (
          <Badge tone="warn">{item.recorded.label}</Badge>
        ) : item.origin !== 'authoritative' ? (
          <Badge>{originLabel(item.origin)}</Badge>
        ) : null}
      </header>
      <p className="meta">
        <CourseLink course={item.course} />
        {item.dueAt ? (
          <>
            <span className="field-label">締切</span>
            <time dateTime={item.dueAt}>{formatShort(item.dueAt, tz)}</time>
            {open && hoursLeft !== undefined ? (
              <Badge tone={overdue ? 'bad' : hoursLeft < 24 ? 'warn' : 'muted'}>
                {formatRemaining(hoursLeft, overdue)}
              </Badge>
            ) : null}
          </>
        ) : (
          <span>期限なし</span>
        )}
      </p>
      {item.evidence ? <blockquote className="evidence">{item.evidence}</blockquote> : null}
      <Citations citations={item.citations} />
    </article>
  );
}

export function AnnouncementRow({ item }: { item: AnnouncementItem }) {
  const tz = useTimezone();
  return (
    <article className="card">
      <header className="card-head">
        {item.importance === 'critical' || item.importance === 'high' ? (
          <Badge tone={importanceTone(item.importance)}>{importanceLabel(item.importance)}</Badge>
        ) : null}
        <Badge>{scopeLabel(item.scope)}</Badge>
        <h3 className="card-title">{item.title}</h3>
        {item.publishedAt ? (
          <time className="meta" dateTime={item.publishedAt}>
            {formatShort(item.publishedAt, tz)}
          </time>
        ) : null}
      </header>
      {item.author || item.course ? (
        <p className="meta">
          {item.author ? <span>{item.author}</span> : null}
          <CourseLink course={item.course} />
        </p>
      ) : null}
      {item.body ? (
        <details>
          <summary>本文</summary>
          <p className="body-text">{item.body}</p>
        </details>
      ) : null}
      <Citations citations={item.citations} />
    </article>
  );
}

export function MaterialRow({ item }: { item: MaterialItem }) {
  const tz = useTimezone();
  const href = safeHttpUrl(item.url);
  return (
    <article className="card">
      <header className="card-head">
        <Badge>{materialKindLabel(item.materialKind)}</Badge>
        <h3 className="card-title">{item.title}</h3>
        {item.publishedAt ? (
          <time className="meta">{formatShort(item.publishedAt, tz)}</time>
        ) : null}
      </header>
      {href ? (
        <p className="meta">
          <a href={href} target="_blank" rel="noopener noreferrer">
            開く
          </a>
        </p>
      ) : null}
      <Citations citations={item.citations} />
    </article>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  return <Badge tone="info">{entityKindLabel(kind)}</Badge>;
}
