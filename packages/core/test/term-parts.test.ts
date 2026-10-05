import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  classDay,
  halvesWindow,
  inHalfSwitchover,
  isWholeTerm,
  loadProfile,
  parseTermPartLabel,
  parseTermSpan,
  termHalfOf,
  termPartLabel,
  type StudentScope,
  type TermDefinition,
} from '../src/index.js';

describe('half-term text (前半 / 後半)', () => {
  it('parses the labels the academic system prints', () => {
    expect(parseTermPartLabel('後期前半')).toEqual({ term: '後期', half: '前半' });
    expect(parseTermPartLabel('前期後半')).toEqual({ term: '前期', half: '後半' });
    expect(parseTermPartLabel('後学期後半')).toEqual({ term: '後期', half: '後半' });
    expect(parseTermPartLabel('前半')).toEqual({ half: '前半' });
    expect(parseTermPartLabel('後期')).toBeUndefined();
    expect(parseTermPartLabel('')).toBeUndefined();
  });

  it('turns the syllabus 開講時期 into the halves it covers', () => {
    expect(parseTermSpan('後期前半　～　後期後半')).toEqual(['前半', '後半']);
    expect(parseTermSpan('後期後半')).toEqual(['後半']);
    expect(parseTermSpan('前期前半')).toEqual(['前半']);
    expect(parseTermSpan('前期前半、前期後半')).toEqual(['前半', '後半']);
    // No half in the text: unknown, not "both".
    expect(parseTermSpan('前期')).toBeUndefined();
    expect(parseTermSpan('通年')).toBeUndefined();
    expect(parseTermSpan(undefined)).toBeUndefined();
  });

  it('labels and whole-term checks', () => {
    expect(termPartLabel('後期', ['後半'])).toBe('後期後半');
    expect(termPartLabel('後期', ['後半', '前半'])).toBe('後期（前半・後半）');
    expect(termPartLabel(undefined, ['前半'])).toBe('前半');
    expect(termPartLabel('後期', undefined)).toBeUndefined();
    expect(isWholeTerm(undefined)).toBe(true);
    expect(isWholeTerm(['前半', '後半'])).toBe(true);
    expect(isWholeTerm(['後半'])).toBe(false);
  });
});

describe('Shizuoka 2026 halves (行事予定表 class counters)', () => {
  const cal = loadProfile('shizuoka-university').academicCalendar;
  const term = (id: string): TermDefinition => {
    const t = cal.terms.find((x) => x.id === id);
    if (!t) throw new Error(id);
    return t;
  };
  const autumn = term('2026-2');
  const spring = term('2026-1');

  it('places each class day in its half per weekday', () => {
    expect(termHalfOf(autumn, '2026-10-05')).toBe('前半'); // 月1
    expect(termHalfOf(autumn, '2026-11-19')).toBe('前半'); // 木8
    expect(termHalfOf(autumn, '2026-11-26')).toBe('後半'); // 木9
    expect(termHalfOf(autumn, '2026-11-27')).toBe('前半'); // 金8
    expect(termHalfOf(autumn, '2026-11-30')).toBe('前半'); // 月8
    expect(termHalfOf(autumn, '2026-12-02')).toBe('前半'); // 水8
    expect(termHalfOf(autumn, '2026-12-04')).toBe('後半'); // 金9
    expect(termHalfOf(autumn, '2026-12-07')).toBe('後半'); // 月9
    // 11/25(水) follows the Monday timetable (月曜授業): Monday's 7th class, 前半.
    expect(termHalfOf(autumn, '2026-11-25', 1)).toBe('前半');
    // Weekends follow the neighbouring weekday (Sat → Fri before, Sun → Mon after).
    expect(termHalfOf(autumn, '2026-11-28')).toBe('前半');
    expect(termHalfOf(autumn, '2026-12-05')).toBe('後半');
    expect(termHalfOf(autumn, '2026-12-06')).toBe('後半');
    expect(termHalfOf(autumn, '2027-03-01')).toBeUndefined(); // spring break
    expect(termHalfOf(spring, '2026-06-05')).toBe('前半'); // 金8
    expect(termHalfOf(spring, '2026-06-08')).toBe('前半'); // 月8
    expect(termHalfOf(spring, '2026-06-12')).toBe('後半'); // 金9
    // 7/17(金) is 月曜授業: Monday's 14th class.
    expect(termHalfOf(spring, '2026-07-17', 1)).toBe('後半');
  });

  it('switch-over weeks and windows', () => {
    expect(inHalfSwitchover(autumn, '2026-11-19')).toBe(false);
    expect(inHalfSwitchover(autumn, '2026-11-30')).toBe(true);
    expect(halvesWindow(autumn, ['後半'])).toEqual({ start: '2026-11-26', end: '2027-02-05' });
    expect(halvesWindow(autumn, ['前半'])).toEqual({ start: '2026-10-01', end: '2026-12-02' });
    expect(halvesWindow(autumn, ['前半', '後半'])).toEqual({
      start: '2026-10-01',
      end: '2027-02-05',
    });
  });

  // The profile's per-weekday boundaries must equal the 1st, 8th and 9th class day of each weekday
  // counted with the same calendar (holidays, 振替, campus closures). Either campus gives the same
  // dates: 10/30 is closed only in 静岡, 11/6 only in 浜松.
  for (const campus of ['浜松', '静岡']) {
    it(`boundaries match the class-day count (${campus})`, () => {
      const student: StudentScope = { campus, faculty: '情報学部' };
      for (const t of [spring, autumn]) {
        const first = t.parts?.find((p) => p.half === '前半');
        const second = t.parts?.find((p) => p.half === '後半');
        const win = t.classes ?? { start: t.start, end: t.end };
        for (let weekday = 1; weekday <= 5; weekday++) {
          const days: string[] = [];
          for (let d = win.start; d <= win.end; d = addLocalDays(d, 1)) {
            const info = classDay(cal, d, { student });
            if (!info.noClasses && info.dayOfWeek === weekday) days.push(d);
          }
          const key = String(weekday);
          expect(first?.weekdays?.[key]?.start, `${t.id} ${weekday} 第1回`).toBe(days[0]);
          expect(first?.weekdays?.[key]?.end, `${t.id} ${weekday} 第8回`).toBe(days[7]);
          expect(second?.weekdays?.[key]?.start, `${t.id} ${weekday} 第9回`).toBe(days[8]);
        }
      }
    });
  }
});
