import { useState, type FormEvent } from 'react';
import { apiDelete, apiPut, enc, errorMessage } from '../api';
import { scheduleTypeLabel } from '../lib/labels';
import type { CourseContext, PaceSetBody, PaceSetResponse } from '../types';
import { useToast } from './Toast';
import { Badge, Empty } from './ui';

/** The course's schedule type and its self-study slots, with a form to add or remove a slot. */
export function PaceSection({
  course,
  onChanged,
}: {
  course: CourseContext;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const path = `/api/v1/courses/${enc(course.course.id)}/pace`;
  const slots = course.paceSlots;

  async function save(texts: string[], done: string): Promise<boolean> {
    setBusy(true);
    try {
      if (texts.length === 0) await apiDelete<PaceSetResponse>(path);
      else await apiPut<PaceSetResponse>(path, { slots: texts } satisfies PaceSetBody);
      toast.success(done);
      onChanged();
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault();
    const value = text.trim();
    if (value === '') return;
    if (await save([...slots.map((s) => s.text), value], '自習時間を保存しました')) setText('');
  }

  return (
    <div className="card">
      <p className="meta">
        <Badge tone={course.scheduleType === 'regular' ? 'muted' : 'info'}>
          {scheduleTypeLabel(course.scheduleType)}
        </Badge>
      </p>
      {slots.length === 0 ? (
        <Empty />
      ) : (
        <ul className="inline-list">
          {slots.map((s) => (
            <li key={s.text}>
              <span>{s.text}</span>{' '}
              <button
                type="button"
                disabled={busy}
                aria-label={`${s.text}を削除`}
                onClick={() =>
                  void save(
                    slots.filter((x) => x.text !== s.text).map((x) => x.text),
                    '自習時間を更新しました',
                  )
                }
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="search-form" onSubmit={(e) => void add(e)}>
        <input
          type="text"
          aria-label="自習時間"
          placeholder="土 10:00-11:30 / 土2限"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={busy || text.trim() === ''}>
          追加
        </button>
      </form>
    </div>
  );
}
