import type { ReactNode } from 'react';
import { errorMessage } from '../api';
import type { ApiState } from '../hooks';
import type { Tone } from '../lib/labels';

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Empty() {
  return <p className="empty">なし</p>;
}

export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="alert" role="alert">
      <span>{errorMessage(error)}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          再読み込み
        </button>
      ) : null}
    </div>
  );
}

export function Loading() {
  return (
    <p className="loading" role="status">
      読み込み中
    </p>
  );
}

export function Section({
  title,
  count,
  id,
  children,
}: {
  title: string;
  count?: number;
  id?: string;
  children: ReactNode;
}) {
  const headingId = id ?? `sec-${title}`;
  return (
    <section className="section" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {title}
        {count !== undefined && count > 0 ? <span className="count-chip">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** Renders loading / error / data for a useApi state. */
export function Async<T>({
  state,
  children,
}: {
  state: ApiState<T>;
  children: (data: T) => ReactNode;
}) {
  if (state.data !== undefined) {
    return (
      <>
        {state.error ? (
          <ErrorAlert error={state.error} onRetry={() => void state.refetch()} />
        ) : null}
        {children(state.data)}
      </>
    );
  }
  if (state.error) return <ErrorAlert error={state.error} onRetry={() => void state.refetch()} />;
  return <Loading />;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {children ? <div className="page-header-extra">{children}</div> : null}
    </header>
  );
}
