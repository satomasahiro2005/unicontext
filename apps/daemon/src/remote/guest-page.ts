import type { GuestDeadline, GuestView } from './guest-view.js';
import { escapeHtml } from './pages.js';

/** The guest's read-only page (`/g/<token>`): server-rendered, no scripts, no external assets. */

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#f6f6f4;--card:#fff;--muted:#6b6b6b;--line:#e4e4e0;--accent:#1f5fbf;--ok:#1e7a3c;--warn:#b3261e;--today:#eef3fc}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--card:#222;--muted:#a0a0a0;--line:#333;--accent:#7aa7ff;--ok:#7bd88f;--warn:#ff8a80;--today:#1d2738}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 40px}
header{margin-bottom:16px}h1{font-size:1.3rem;margin:0}h2{font-size:1rem;margin:0 0 8px}
.muted{color:var(--muted);font-size:.85rem}
section{background:var(--card);border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.day{padding:8px 0;border-top:1px solid var(--line)}.day:first-of-type{border-top:0}
.day.today{background:var(--today);margin:0 -16px;padding:8px 16px}
.date{font-weight:600}ul{list-style:none;margin:4px 0 0;padding:0}li{padding:2px 0;display:flex;gap:8px;flex-wrap:wrap}
.when{color:var(--muted);min-width:7.5em;font-variant-numeric:tabular-nums}.room{color:var(--muted)}
.cancel{text-decoration:line-through;color:var(--muted)}.badge{font-size:.75rem;border-radius:999px;padding:0 8px;border:1px solid currentColor;white-space:nowrap}
.ok{color:var(--ok)}.warn{color:var(--warn)}
textarea{width:100%;min-height:4.5em;padding:10px;font:inherit;border:1px solid var(--muted);border-radius:8px;background:transparent;color:var(--fg)}
button{margin-top:8px;padding:10px 16px;font-size:1rem;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
.answer{white-space:pre-wrap}
`;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return `${m}/${d}(${WEEKDAYS[wd]})`;
}

function zoned(iso: string, timezone: string, withDate: boolean): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  const time = `${parts.hour}:${parts.minute}`;
  if (!withDate) return time;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  return `${parts.month}/${parts.day}(${WEEKDAYS[wd] ?? ''}) ${time}`;
}

function classesHtml(view: GuestView, day: GuestView['days'][number]): string {
  if (day.classes.length === 0)
    return `<p class="muted">授業なし${day.note ? `（${escapeHtml(day.note)}）` : ''}</p>`;
  const items = day.classes.map((c) => {
    const when = [
      c.period !== undefined ? `${c.period}限` : '',
      c.startsAt ? zoned(c.startsAt, view.timezone, false) : '',
    ]
      .filter(Boolean)
      .join(' ');
    const room = c.room
      ? `<span class="room">${escapeHtml(c.room)}${c.roomUncertain ? '（要確認）' : ''}</span>`
      : '';
    return `<li><span class="when">${escapeHtml(when)}</span><span class="${c.cancelled ? 'cancel' : ''}">${escapeHtml(c.course)}</span>${c.cancelled ? '<span class="badge warn">休講</span>' : room}</li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}

function deadlineHtml(view: GuestView, d: GuestDeadline): string {
  const badge = d.done
    ? '<span class="badge ok">提出済み</span>'
    : d.overdue
      ? '<span class="badge warn">期限切れ</span>'
      : '<span class="badge">未提出</span>';
  return `<li><span class="when">${escapeHtml(zoned(d.dueAt, view.timezone, true))}</span><span>${escapeHtml(d.course)}：${escapeHtml(d.title)}</span>${badge}</li>`;
}

export interface GuestPageInput {
  view: GuestView;
  guestName: string;
  /** The form posts here; absent when questions are off or AI is not set up. */
  askUrl?: string | undefined;
  question?: string | undefined;
  answer?: string | undefined;
  answerError?: string | undefined;
}

export function guestPage(input: GuestPageInput): string {
  const { view } = input;
  const sections: string[] = [];

  const days = view.days
    .map(
      (d) =>
        `<div class="day${d.date === view.today ? ' today' : ''}"><div class="date">${dateLabel(d.date)}${d.date === view.today ? ' <span class="badge">今日</span>' : ''}</div>${classesHtml(view, d)}</div>`,
    )
    .join('');
  sections.push(`<section><h2>今週の時間割</h2>${days}</section>`);

  if (view.deadlines) {
    const list = view.deadlines.length
      ? `<ul>${view.deadlines.map((d) => deadlineHtml(view, d)).join('')}</ul>`
      : '<p class="muted">載っている締切はありません（載っていない締切もありえます）</p>';
    sections.push(`<section><h2>締切</h2>${list}</section>`);
  }
  if (view.exams?.length)
    sections.push(
      `<section><h2>試験・小テスト</h2><ul>${view.exams.map((d) => deadlineHtml(view, d)).join('')}</ul></section>`,
    );

  if (input.askUrl) {
    const answer = input.answer
      ? `<p class="muted">Q. ${escapeHtml(input.question ?? '')}</p><p class="answer">${escapeHtml(input.answer)}</p>`
      : input.answerError
        ? `<p class="warn">${escapeHtml(input.answerError)}</p>`
        : '';
    sections.push(
      `<section><h2>質問する</h2>${answer}<form method="post" action="${escapeHtml(input.askUrl)}"><textarea name="q" maxlength="300" required placeholder="例: 来週の水曜は何時に終わる？"></textarea><button type="submit">AIに聞く</button></form><p class="muted">このページの内容だけをもとにAIが答えます。</p></section>`,
    );
  }

  const updated = zoned(view.generatedAt, view.timezone, true);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>今週の予定</title><style>${STYLE}</style></head><body><main><header><h1>今週の予定</h1><p class="muted">${escapeHtml(input.guestName)}さんへの共有・${escapeHtml(updated)}時点</p></header>${sections.join('')}<p class="muted">読み取り専用のページです。リンクを知っている人は見られるので、ほかの人に送らないでください。</p></main></body></html>`;
}

export function guestGonePage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>リンクが無効です</title><style>${STYLE}</style></head><body><main><section><h2>このリンクは使えません</h2><p class="muted">共有が取り消されたか、期限が切れています。</p></section></main></body></html>`;
}
