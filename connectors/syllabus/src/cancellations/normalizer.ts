import {
  detectSchemaDrift,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
} from '@unicontext/connector-sdk';
import { findPeriod, WEEKDAYS_JA, zonedTime } from '@unicontext/core';
import { CANCELLATION_TYPE, type CancellationPayload, CancellationPayloadSchema } from './types.js';

function academicYearOf(date: string, ctx: NormalizeContext): number {
  const term = ctx.profile?.academicCalendar.terms.find((t) => t.start <= date && date <= t.end);
  if (term) return term.year;
  const [y = 0, m = 1] = date.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

function hhmm(t: string): { hour: number; minute: number } {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return { hour: h, minute: m };
}

function parseIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

/** "休講: 科目 (クラス) 10/1 3・4限" */
export function cancellationTitle(p: CancellationPayload): string {
  const [, m = '0', d = '0'] = p.date.split('-');
  const klass = p.className ? ` (${p.className})` : '';
  return `休講: ${p.courseTitle}${klass} ${Number(m)}/${Number(d)} ${p.period}限`;
}

/**
 * Cancellation rows -> a university-wide announcement (always) and, for the user's own courses
 * (`payload.matched`, decided by the adapter), a cancelled classSession plus a source-local
 * courseOffering the identity resolver can link to the academic system's offering.
 */
export function createCancellationNormalizer(): Normalizer {
  return {
    id: 'lcu-public-cancellations-normalizer',
    version: '1',
    sourceTypes: [CANCELLATION_TYPE],
    normalize(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
      const drift = detectSchemaDrift(item.payload, CancellationPayloadSchema);
      const parsed = CancellationPayloadSchema.safeParse(item.payload);
      if (!parsed.success)
        return {
          entities: [],
          drift,
          warnings: [
            `invalid ${item.sourceType} payload: ${parsed.error.issues[0]?.message ?? ''}`,
          ],
        };
      const p = parsed.data;
      const ref = { url: p.url };
      const entities: NormalizedEntity[] = [];
      const [yearText = '0', monthText = '1', dayText = '1'] = p.date.split('-');
      const [year, month, day] = [Number(yearText), Number(monthText), Number(dayText)];
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const matched = p.matched !== undefined;

      let offeringId: ReturnType<typeof ctx.id<'courseOffering'>> | undefined;
      if (matched) {
        // One source-local offering per course slot (title, class, weekday, period).
        offeringId = ctx.id(
          'courseOffering',
          [
            p.courseTitle,
            p.className ?? '',
            String(weekday),
            String(p.periodIndex ?? p.period),
          ].join('|'),
        );
        entities.push({
          entity: {
            id: offeringId,
            kind: 'courseOffering',
            title: p.courseTitle,
            academicYear: academicYearOf(p.date, ctx),
            instructorIds: [],
            instructorNames: p.instructors,
            schedule:
              p.periodIndex !== undefined ? [{ dayOfWeek: weekday, period: p.periodIndex }] : [],
            extra: {
              className: p.className ?? null,
              source: 'public-cancellations',
            },
          },
          ref,
          // Auto facts (room) are not claimed by this source.
          deriveFacts: false,
        });
        const def =
          p.periodIndex !== undefined && ctx.profile
            ? findPeriod(ctx.profile, p.periodIndex)
            : undefined;
        const at = (t: string): string =>
          zonedTime({ year, month, day, ...hhmm(t) }, ctx.timezone).toISOString();
        entities.push({
          entity: {
            id: ctx.id('classSession', item.externalId),
            kind: 'classSession',
            courseOfferingId: offeringId,
            date: p.date,
            ...(p.periodIndex !== undefined ? { period: p.periodIndex } : {}),
            ...(def ? { startsAt: at(def.start), endsAt: at(def.end) } : {}),
            status: 'cancelled',
            note: `休講 (${p.period}限)`,
          },
          ref,
        });
      }

      const publishedAt = parseIso(item.sourceUpdatedAt);
      entities.push({
        entity: {
          id: ctx.id('announcement', item.externalId),
          kind: 'announcement',
          title: cancellationTitle(p),
          body: [
            `${year}年${month}月${day}日(${WEEKDAYS_JA[weekday]}) ${p.period}限の「${p.courseTitle}」${p.className ? `（${p.className}）` : ''}は休講です。`,
            p.instructors.length ? `担当教員: ${p.instructors.join('、')}` : undefined,
          ]
            .filter(Boolean)
            .join('\n'),
          ...(publishedAt ? { publishedAt } : {}),
          // The public page lists the whole university. Only the user's own courses are important;
          // other rows stay searchable but must not crowd the Today view (scope 'other', low).
          importance: matched ? 'high' : 'low',
          scope: matched ? 'course' : 'other',
          category: '休講',
          url: p.url,
          ...(offeringId ? { courseOfferingId: offeringId } : {}),
        },
        ref,
      });
      return { entities, drift };
    },
  };
}
