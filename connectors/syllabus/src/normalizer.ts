import type { JsonValue } from '@unicontext/canonical-model';
import {
  detectSchemaDrift,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { findPeriod } from '@unicontext/core';
import { parseDayPeriod } from './schedule.js';
import {
  SYLLABUS_ENTRY,
  type SyllabusDetail,
  type SyllabusEntryPayload,
  SyllabusEntryPayloadSchema,
} from './types.js';

function pad(t: string): string {
  return /^\d:/.test(t) ? `0${t}` : t;
}

function compact(o: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<
    string,
    JsonValue
  >;
}

interface Section {
  heading: string;
  body: string;
}

/** Text sections of a syllabus, in reading order (also the chunks of the searchable document). */
export function syllabusSections(p: SyllabusEntryPayload): Section[] {
  const d: SyllabusDetail = p.detail;
  const out: Section[] = [];
  const add = (heading: string, body: string | undefined): void => {
    if (body && body.trim()) out.push({ heading, body: body.trim() });
  };
  const name = d.name ?? p.row['講義名'] ?? '';
  const overview = [
    `科目: ${name}${d.nameEn ? `（${d.nameEn}）` : ''}`,
    `科目コード: ${p.subjectCode}${d.numbering ? ` / ナンバリング: ${d.numbering}` : ''}`,
    `クラス: ${d.className ?? p.className}`,
    d.instructors.length ? `担当教員: ${d.instructors.join('、')}` : undefined,
    `開講: ${[p.year ? `${p.year}年度` : undefined, d.semester, d.dayPeriod].filter(Boolean).join(' ')}`,
    d.room ? `教室: ${d.room}` : undefined,
    d.credits !== undefined ? `単位数: ${d.credits}` : undefined,
    d.requirement ? `必修選択区分: ${d.requirement}` : undefined,
  ]
    .filter((l): l is string => Boolean(l))
    .join('\n');
  add('概要', overview);
  add('キーワード', d.keywords.join('、'));
  add('授業の目標', d.goals);
  add('学修内容', d.content);
  add(
    '授業計画',
    [d.planNote, ...d.plan.map((r) => `第${r.no}回 ${r.content}`)].filter(Boolean).join('\n'),
  );
  add('受講要件', d.prerequisites);
  add('テキスト', d.textbook);
  add('参考書', d.references);
  add('予習・復習', d.preparation);
  add('成績評価の方法・基準', d.evaluation);
  add('オフィスアワー', d.officeHours);
  add('担当教員からのメッセージ', d.message);
  add(
    'アクティブ・ラーニング',
    d.activeLearning.map((a) => (a.note ? `${a.type}: ${a.note}` : a.type)).join('、'),
  );
  add('授業実施形態', d.delivery.join('、'));
  add('オンライン授業（詳細）', d.onlineDetail);
  return out;
}

/**
 * Normalizer for syllabus entries. Convention shared with the livecampusu connector:
 * ScheduleSlot.period is the LCU 90-minute period (1・2 -> 1, 3・4 -> 2 ... 13・14 -> 7); the
 * printed form is kept in courseOffering.extra.slots[].rawPeriod.
 */
export function createSyllabusNormalizer(): Normalizer {
  return {
    id: 'syllabus-normalizer',
    version: '1',
    sourceTypes: [SYLLABUS_ENTRY],
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const drift = detectSchemaDrift(item.payload, SyllabusEntryPayloadSchema);
      const parsed = SyllabusEntryPayloadSchema.safeParse(item.payload);
      if (!parsed.success)
        return {
          entities: [],
          drift,
          warnings: [
            `invalid ${item.sourceType} payload: ${parsed.error.issues[0]?.message ?? ''}`,
          ],
        };
      const p = parsed.data;
      const d = p.detail;
      const name = d.name ?? p.row['講義名'] ?? p.subjectCode;
      const term = d.semester ?? p.row['開講学期'];
      const instructors = [
        ...(d.instructors.length ? d.instructors : splitRowNames(p.row['担当教員'])),
        ...d.coInstructors,
      ];
      const slots = d.slots.length ? d.slots : parseDayPeriod(p.row['曜日・時限'] ?? '');
      const ref = { url: p.url };

      const courseId = ctx.id('course', p.subjectCode);
      const offeringId = ctx.id('courseOffering', item.externalId);
      const documentId = ctx.id('document', item.externalId);
      const entities: NormalizedEntity[] = [];

      entities.push({
        entity: {
          id: courseId,
          kind: 'course',
          courseCode: p.subjectCode,
          title: name,
          ...(d.nameEn ? { titleEn: d.nameEn } : {}),
          ...(d.credits !== undefined ? { credits: d.credits } : {}),
          ...(d.department ? { department: d.department } : {}),
          extra: compact({ numbering: d.numbering }),
        },
        ref,
      });

      entities.push({
        entity: {
          id: offeringId,
          kind: 'courseOffering',
          courseId,
          title: name,
          courseCode: p.subjectCode,
          ...(p.year !== undefined ? { academicYear: p.year } : {}),
          ...(term ? { term } : {}),
          instructorIds: [],
          instructorNames: instructors,
          schedule: slots.map((s) => {
            const def = ctx.profile ? findPeriod(ctx.profile, s.period) : undefined;
            return {
              dayOfWeek: s.dayOfWeek,
              period: s.period,
              ...(def ? { startTime: pad(def.start), endTime: pad(def.end) } : {}),
            };
          }),
          ...(d.room ? { room: d.room } : {}),
          url: p.url,
          extra: compact({
            className: d.className ?? p.className,
            rawSchedule: d.dayPeriod ?? p.row['曜日・時限'],
            slots: slots.map((s) => ({
              dayOfWeek: s.dayOfWeek,
              period: s.period,
              rawPeriod: s.rawPeriod,
            })),
            termSpan: d.termSpan,
            categories: p.categories,
            grade: d.grade,
            campus: d.campus,
            requirement: d.requirement,
            delivery: d.delivery,
            officeHours: d.officeHours,
            laboratory: d.laboratory,
            instructorsEn: d.instructorsEn,
            title: p.title,
            ...(Object.keys(d.extra).length ? { unmapped: d.extra } : {}),
          }),
        },
        ref,
      });

      const sections = syllabusSections(p);
      const text = sections.map((s) => `${s.heading}\n${s.body}`).join('\n\n');
      entities.push({
        entity: {
          id: documentId,
          kind: 'document',
          title: `シラバス: ${name}`,
          mimeType: 'text/html',
          url: p.url,
          text,
          courseOfferingId: offeringId,
        },
        ref,
      });
      sections.forEach((s, i) => {
        entities.push({
          entity: {
            id: ctx.id('documentChunk', item.externalId, String(i)),
            kind: 'documentChunk',
            documentId,
            ordinal: i,
            text: s.body,
            heading: s.heading,
          },
          ref: { ...ref, location: { selector: s.heading } },
        });
      });
      return { entities, drift };
    },
  };
}

function splitRowNames(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[、,，／/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
