import {
  classifyGradeLabel,
  type CourseOffering,
  type GradeOutcome,
  isEarnedOutcome,
  isIdOf,
} from '@unicontext/canonical-model';
import { buildGradeReport, creditRequirements, type RequirementRowView } from './grades.js';
import type { UniContext } from './runtime.js';

/*
 * Which syllabus details the student needs first. The syllabus catalog lists every course of the
 * year from the list row alone and opens only a budget of detail pages per day, so the host tells
 * the syllabus connector which rows matter to this student (its `priorityProvider`):
 *
 *   enrolled    the offerings the student is or was registered in (their class, when the
 *               syllabus lists that class),
 *   needed      courses not passed yet that count toward graduation: 必修 / 選択必修 courses of a
 *               requirement the student has not filled (単位修得情報), or, without that data,
 *               failed 必 / 選必 courses from the grades,
 *   department  選択 courses of an unfilled requirement, and the 選択 / 選択必修 categories of the
 *               student's department in the syllabus (the groups whose （必修） courses are the
 *               student's 必 courses).
 *
 * The connector itself ranks the campus 全学教育 listing after these and the rest last.
 */

/** One rule, structurally the syllabus connector's `SyllabusDetailPriority`. */
export interface SyllabusDetailPriorityRule {
  priority: 'enrolled' | 'needed' | 'department';
  subjectCode?: string;
  title?: string;
  category?: string;
  year?: number;
  semester?: '1' | '2';
  className?: string;
  reason?: string;
}

function normText(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '');
}

function normClass(s: string): string {
  return normText(s).replace(/クラス$/, '');
}

/** '1' (前期) / '2' (後期) of a printed term. */
export function semesterOfTerm(term: string | undefined): '1' | '2' | undefined {
  const t = normText(term ?? '');
  if (t.startsWith('前期')) return '1';
  if (t.startsWith('後期')) return '2';
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Credit types that make a course required for the student (必, 選必, 必修, 選択必修). */
function isRequiredType(t: string | undefined): boolean {
  return (t ?? '').includes('必');
}

/** Requirement rows whose credits are not all there yet (inherited from the parent rows). */
function unfilledRows(rows: readonly RequirementRowView[]): Set<RequirementRowView> {
  const out = new Set<RequirementRowView>();
  // A group without a required number whose sibling groups have one does not count toward its
  // parent (留学生科目 next to 教養基礎科目 9 / 教養展開科目 6 / 教養科目 選択 13 under 教養科目 28).
  const parent = new Map<RequirementRowView, RequirementRowView | undefined>();
  const childHasRequired = new Set<RequirementRowView | undefined>();
  const chain: RequirementRowView[] = [];
  for (const row of rows) {
    while (chain.length && (chain[chain.length - 1]?.depth ?? 0) >= row.depth) chain.pop();
    const p = chain[chain.length - 1];
    parent.set(row, p);
    if (row.required !== undefined) childHasRequired.add(p);
    chain.push(row);
  }
  for (const row of rows) {
    // The nearest row (itself first) that says how far it is filled.
    for (let r: RequirementRowView | undefined = row; r; r = parent.get(r)) {
      if (r.required !== undefined && r.expected !== undefined) {
        if (r.required > r.expected) out.add(row);
        break;
      }
      if (r.status) {
        if (r.status.includes('不足')) out.add(row);
        break;
      }
      if (r.required === undefined && childHasRequired.has(parent.get(r))) break;
    }
  }
  return out;
}

function syllabusOfferings(uc: UniContext, sourceIds: readonly string[]): CourseOffering[] {
  return sourceIds.flatMap((sourceId) =>
    uc.sync.stores.entities.list('courseOffering', { sourceId }),
  );
}

function classOf(o: CourseOffering): string | undefined {
  return str((o.extra as Record<string, unknown> | undefined)?.['className']);
}

/**
 * The detail priorities of the student (see the module comment). `syllabusSourceIds` are the
 * syllabus sources whose catalog the rules are checked against (classes, department categories).
 */
export function syllabusDetailPriorities(
  uc: UniContext,
  options: { syllabusSourceIds: readonly string[] },
): SyllabusDetailPriorityRule[] {
  const entities = uc.sync.stores.entities;
  const catalog = syllabusOfferings(uc, options.syllabusSourceIds);
  const catalogIds = new Set<string>(catalog.map((o) => o.id));
  const out: SyllabusDetailPriorityRule[] = [];
  const seen = new Set<string>();
  const add = (r: SyllabusDetailPriorityRule): void => {
    const key = JSON.stringify(
      r,
      Object.keys(r)
        .filter((k) => k !== 'reason')
        .sort(),
    );
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };

  // enrolled: the student's own offerings (registered now, or graded), of their class when the
  // syllabus lists that class for the course; otherwise every class of it that term.
  const selfIds = new Set(
    entities
      .list('person')
      .filter((p) => p.isSelf)
      .map((p) => p.id),
  );
  const own = new Set<string>();
  for (const e of entities.list('enrollment'))
    if (
      e.role === 'student' &&
      e.status === 'active' &&
      (selfIds.size === 0 || selfIds.has(e.personId))
    )
      own.add(e.courseOfferingId);
  const report = buildGradeReport(uc, {});
  for (const a of report.attempts) if (a.courseOfferingId) own.add(a.courseOfferingId);
  for (const id of own) {
    // A syllabus offering itself is not a registration.
    if (catalogIds.has(id) || !isIdOf('courseOffering', id)) continue;
    const o = entities.getOfKind('courseOffering', id);
    if (!o?.courseCode) continue;
    const semester = semesterOfTerm(o.term);
    const cls = classOf(o);
    const listed =
      cls !== undefined &&
      catalog.some(
        (c) =>
          c.courseCode === o.courseCode &&
          (o.academicYear === undefined || c.academicYear === o.academicYear) &&
          (semester === undefined || semesterOfTerm(c.term) === semester) &&
          normClass(classOf(c) ?? '') === normClass(cls),
      );
    add({
      priority: 'enrolled',
      subjectCode: o.courseCode,
      ...(o.academicYear !== undefined ? { year: o.academicYear } : {}),
      ...(semester ? { semester } : {}),
      ...(listed && cls ? { className: cls } : {}),
      reason: `履修: ${o.title}`,
    });
  }

  // needed / department from the graduation requirements (単位修得情報) when there are any.
  const codeByTitle = new Map<string, string>();
  for (const c of report.courses)
    if (c.subjectCode) codeByTitle.set(normText(c.title), c.subjectCode);
  const requirements = creditRequirements(uc);
  if (requirements?.rows.length) {
    const unfilled = unfilledRows(requirements.rows);
    for (const row of requirements.rows) {
      if (!unfilled.has(row)) continue;
      for (const course of row.courses) {
        const outcome: GradeOutcome | undefined = course.status
          ? classifyGradeLabel(course.status)
          : undefined;
        if (outcome && (isEarnedOutcome(outcome) || outcome === 'in_progress')) continue;
        const code = codeByTitle.get(normText(course.title));
        add({
          priority: isRequiredType(course.creditType ?? row.creditType) ? 'needed' : 'department',
          ...(code ? { subjectCode: code } : { title: course.title }),
          reason: `卒業要件: ${row.name}`,
        });
      }
    }
  } else {
    // Without requirement data: courses the grades show as not passed (failed / waiting for
    // the re-exam), unless the student is taking them again now.
    for (const c of report.courses) {
      if (c.earned || c.latest.outcome === 'in_progress') continue;
      if (!c.attempts.some((a) => ['failed', 'not_graded', 'withdrawn'].includes(a.outcome)))
        continue;
      add({
        priority: isRequiredType(c.creditType) ? 'needed' : 'department',
        ...(c.subjectCode ? { subjectCode: c.subjectCode } : { title: c.title }),
        reason: `未修得: ${c.title}`,
      });
    }
  }

  // department: the syllabus groups whose （必修） courses are the student's 必 courses.
  const requiredCodes = new Set<string>();
  const requiredTitles = new Set<string>();
  for (const c of report.courses)
    if (c.creditType === '必') {
      if (c.subjectCode) requiredCodes.add(c.subjectCode);
      requiredTitles.add(normText(c.title));
    }
  for (const row of requirements?.rows ?? [])
    for (const c of row.courses)
      if ((c.creditType ?? row.creditType) === '必' && c.status)
        requiredTitles.add(normText(c.title));
  const groups = new Set<string>();
  for (const o of catalog) {
    const mine =
      (o.courseCode !== undefined && requiredCodes.has(o.courseCode)) ||
      requiredTitles.has(normText(o.title));
    if (!mine) continue;
    const categories = (o.extra as Record<string, unknown> | undefined)?.['categories'];
    if (!Array.isArray(categories)) continue;
    for (const cat of categories) {
      if (typeof cat !== 'string') continue;
      const m = /^(.*)\(必修\)$/.exec(cat.normalize('NFKC').trim());
      if (m?.[1]) groups.add(m[1]);
    }
  }
  for (const g of [...groups].sort())
    for (const kind of ['選択', '選択必修'])
      add({ priority: 'department', category: `${g}(${kind})`, reason: `学科の${kind}` });

  return out;
}
