import {
  ENTITY_SCHEMAS,
  isIdOf,
  type CanonicalEntityInput,
  type EntityKind,
  type JsonValue,
} from '@unicontext/canonical-model';
import {
  contentHash,
  extractDeadlines,
  markupToText,
  parseExternalTermLabel,
  termForDate,
  termForExternalLabel,
} from '@unicontext/core';
import {
  detectSchemaDrift,
  FILE_TEXT_SOURCE_TYPE,
  type FactInput,
  type FileTextPayload,
  type NormalizeContext,
  type NormalizedEntity,
  type NormalizeOutput,
  type Normalizer,
  type RawItemView,
  type SourceRefSpec,
} from '@unicontext/connector-sdk';
import type { z } from 'zod';
import {
  coerceExplicit,
  coerceForField,
  toIsoDateTime,
  toLocalDate,
  toNumber,
  toStringValue,
} from './coerce.js';
import { miniSchemaToZod } from './drift.js';
import { evalExpr, toArray } from './expr.js';
import { stripCredentials } from './sanitize.js';
import type { EntityRule, FactRule, FieldValue, MappingSpec, RefSpecInput } from './spec.js';

/** Key under which the runner stores fan-out context (`attach`) in a payload. */
export const PARENT_KEY = '_parent';

type Bindings = Record<string, unknown>;

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Term names a label can carry when there is no academic calendar to map it through. */
const UNIVERSITY_TERM_WORD = /(前|後)学?期|通年|集中/;

/** Markup (Ed document XML, simple HTML) → text, one line per paragraph / break / list item. */
function plainText(markup: unknown): string | undefined {
  return markupToText((Array.isArray(markup) ? markup : [markup]).map((m) => toStringValue(m)));
}

/**
 * Functions the mapping expressions can call (bound per raw item):
 *  - `$profileTerm(label, year)` an external term label (Ed session "Semester 2", "S2", "Spring",
 *    前期 …) of academic year `year` → the university's term name (後期) through the profile's
 *    academic calendar. Undefined when the label is not a term (Ed's placeholder "X") or does not
 *    fit the calendar. Without a calendar, a recognizable term label is kept as written.
 *  - `$profileTermAt(date)` → `{year, term}` of the profile term containing that date (local date
 *    in the source time zone), or undefined.
 *  - `$plainText(markup)` → the text of Ed document XML / simple HTML (one line per paragraph).
 *  - `$extractDeadline(text, reference)` → `{dueAt, phrase, evidence, confidence, timeAssumed}`: the
 *    deadline stated in free text (「提出期限: 10月6日 17:00」, rule-based §20, no LLM). Wall-clock
 *    times are read in the university's time zone; `reference` (when the text was written)
 *    anchors the year and relative expressions. Undefined when the text states none.
 */
function helperFunctions(ctx: NormalizeContext): Bindings {
  const cal = ctx.profile?.academicCalendar;
  const hasTerms = cal !== undefined && cal.terms.length > 0;
  return {
    profileTerm: (label: unknown, year: unknown): string | undefined => {
      const text = toStringValue(label)?.trim();
      if (!text) return undefined;
      if (hasTerms) return termForExternalLabel(cal, text, toNumber(year))?.termCode;
      return parseExternalTermLabel(text) || UNIVERSITY_TERM_WORD.test(text.normalize('NFKC'))
        ? text
        : undefined;
    },
    profileTermAt: (date: unknown): { year: number; term: string } | undefined => {
      if (!hasTerms) return undefined;
      const local = toLocalDate(date, ctx.timezone);
      const t = local ? termForDate(cal, local) : undefined;
      return t ? { year: t.year, term: t.termCode ?? t.name } : undefined;
    },
    plainText: (markup: unknown): string | undefined => plainText(markup),
    extractDeadline: (
      text: unknown,
      reference: unknown,
    ):
      | {
          dueAt: string;
          phrase: string;
          evidence: string;
          confidence: number;
          timeAssumed: boolean;
        }
      | undefined => {
      const body = toStringValue(text);
      if (!body) return undefined;
      const iso = toIsoDateTime(reference, ctx.timezone);
      const found = extractDeadlines(body, {
        reference: iso ? new Date(iso) : ctx.now,
        timezone: ctx.timezone,
      });
      // A labelled date (「提出期限: …」) is the deadline; otherwise the most confident, first one.
      const best = [...found].sort(
        (a, b) =>
          Number(b.rule === 'labeled_date') - Number(a.rule === 'labeled_date') ||
          b.confidence - a.confidence,
      )[0];
      return best
        ? {
            dueAt: best.dueAt,
            phrase: best.phrase,
            evidence: best.evidence,
            confidence: best.confidence,
            timeAssumed: best.timeAssumed,
          }
        : undefined;
    },
  };
}

function toJson(v: unknown): JsonValue | undefined {
  if (v === undefined) return undefined;
  try {
    const text = JSON.stringify(v);
    return text === undefined ? undefined : (JSON.parse(text) as JsonValue);
  } catch {
    return undefined;
  }
}

class RuleRunner {
  readonly warnings: string[] = [];
  private readonly functions: Bindings;

  constructor(
    private readonly item: RawItemView,
    private readonly ctx: NormalizeContext,
    private readonly payload: unknown,
    private readonly vars: MappingSpec['vars'] = {},
  ) {
    this.functions = helperFunctions(ctx);
  }

  private warn(message: string): void {
    const text = `${this.item.sourceType}/${this.item.externalId}: ${message}`;
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  bindings(): Bindings {
    return {
      root: this.payload,
      tz: this.ctx.timezone,
      sourceId: this.ctx.sourceId,
      externalId: this.item.externalId,
      vars: this.vars,
      ...this.functions,
    };
  }

  /** Evaluate; failures become warnings and yield undefined. */
  async ev(source: string, input: unknown, what: string): Promise<unknown> {
    try {
      return await evalExpr(source, input, this.bindings());
    } catch (e) {
      this.warn(`${what} (${source}) failed: ${errText(e)}`);
      return undefined;
    }
  }

  async elements(rule: {
    when?: string | undefined;
    forEach?: string | undefined;
  }): Promise<unknown[]> {
    if (rule.when) {
      const w = await this.ev(rule.when, this.payload, 'when');
      if (!truthy(w)) return [];
    }
    if (!rule.forEach) return [this.payload];
    return toArray(await this.ev(rule.forEach, this.payload, 'forEach'));
  }

  private refId(kind: EntityKind, key: unknown): string | undefined {
    const text = toStringValue(key);
    return text && text.length > 0 ? this.ctx.id(kind, text) : undefined;
  }

  /** Evaluate one FieldValue. `kind`/`field` enable schema-driven coercion for entity fields. */
  async fieldValue(
    v: FieldValue,
    element: unknown,
    target?: { kind: EntityKind; field: string },
  ): Promise<unknown> {
    const coerce = (value: unknown): unknown => {
      if (!target) return value;
      const c = coerceForField(target.kind, target.field, value, this.ctx.timezone);
      if (!c.ok) {
        this.warn(`field ${target.field}: cannot convert ${JSON.stringify(value)}`);
        return undefined;
      }
      return c.value;
    };
    if (typeof v === 'string')
      return coerce(await this.ev(v, element, `field ${target?.field ?? ''}`));
    if (typeof v === 'number' || typeof v === 'boolean') return coerce(v);
    if ('const' in v) return v.const;
    if ('expr' in v) {
      const value = await this.ev(v.expr, element, `field ${target?.field ?? ''}`);
      if (v.as) return coerceExplicit(value, v.as, this.ctx.timezone);
      return coerce(value);
    }
    if (v.keys !== undefined) {
      const ids = toArray(await this.ev(v.keys, element, `field ${target?.field ?? ''}`))
        .map((k) => this.refId(v.ref, k))
        .filter((x): x is string => x !== undefined);
      return ids.length > 0 ? ids : undefined;
    }
    return this.refId(v.ref, await this.ev(v.key ?? '""', element, `field ${target?.field ?? ''}`));
  }

  async refSpec(
    ref: RefSpecInput | undefined,
    element: unknown,
  ): Promise<SourceRefSpec | undefined> {
    if (!ref) return undefined;
    const out: SourceRefSpec = {};
    if (ref.authority !== undefined) {
      const a =
        typeof ref.authority === 'string'
          ? ref.authority
          : toStringValue(await this.ev(ref.authority.expr, element, 'ref.authority'));
      if (a) out.authority = a;
    }
    if (ref.url) {
      const u = toStringValue(await this.ev(ref.url, element, 'ref.url'));
      if (u) out.url = u;
    }
    if (ref.sourceItemId) {
      const s = toStringValue(await this.ev(ref.sourceItemId, element, 'ref.sourceItemId'));
      if (s) out.sourceItemId = s;
    }
    if (ref.sourceLabel) out.sourceLabel = ref.sourceLabel;
    if (ref.location) {
      const loc: NonNullable<SourceRefSpec['location']> = {};
      const get = (e: string | undefined): Promise<unknown> =>
        e ? this.ev(e, element, 'ref.location') : Promise.resolve(undefined);
      const page = toNumber(await get(ref.location.page));
      if (page !== undefined && Number.isInteger(page) && page > 0) loc.page = page;
      const ts = toStringValue(await get(ref.location.timestamp));
      if (ts) loc.timestamp = ts;
      const ms = toNumber(await get(ref.location.timestampMs));
      if (ms !== undefined && Number.isInteger(ms) && ms >= 0) loc.timestampMs = ms;
      const mid = toStringValue(await get(ref.location.messageId));
      if (mid) loc.messageId = mid;
      const line = toNumber(await get(ref.location.line));
      if (line !== undefined && Number.isInteger(line) && line > 0) loc.line = line;
      const sel = toStringValue(await get(ref.location.selector));
      if (sel) loc.selector = sel;
      if (Object.keys(loc).length > 0) out.location = loc;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async entities(rule: EntityRule, index: number): Promise<NormalizedEntity[]> {
    const out: NormalizedEntity[] = [];
    const elements = await this.elements(rule);
    for (const [i, element] of elements.entries()) {
      const keyValue = rule.key
        ? toStringValue(await this.ev(rule.key, element, 'key'))
        : rule.forEach
          ? `${this.item.externalId}:${i}`
          : this.item.externalId;
      if (!keyValue) {
        this.warn(`entity rule #${index} (${rule.kind}) produced no key`);
        continue;
      }
      const entity: Record<string, unknown> = {
        id: this.ctx.id(rule.kind, keyValue),
        kind: rule.kind,
      };
      for (const [field, spec] of Object.entries(rule.fields)) {
        const value = await this.fieldValue(spec, element, { kind: rule.kind, field });
        if (value !== undefined && value !== null) entity[field] = value;
      }
      if (rule.extra) {
        const extra: Record<string, JsonValue> = {};
        for (const [k, e] of Object.entries(rule.extra)) {
          const v = toJson(await this.ev(e, element, `extra.${k}`));
          if (v !== undefined && v !== null) extra[k] = v;
        }
        const guarded = stripCredentials(extra);
        if (guarded.removed.length > 0)
          this.warn(`dropped credential-like extra keys: ${guarded.removed.join(', ')}`);
        if (Object.keys(guarded.value).length > 0) entity.extra = guarded.value;
      }
      const parsed = ENTITY_SCHEMAS[rule.kind].safeParse(entity);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`)
          .join('; ');
        this.warn(`invalid ${rule.kind} entity skipped (${detail})`);
        continue;
      }
      const ref = await this.refSpec(rule.ref, element);
      out.push({
        entity: parsed.data as CanonicalEntityInput,
        ...(ref ? { ref } : {}),
        ...(rule.origin ? { origin: rule.origin } : {}),
        ...(rule.deriveFacts !== undefined ? { deriveFacts: rule.deriveFacts } : {}),
      });
    }
    return out;
  }

  async facts(rule: FactRule, index: number): Promise<FactInput[]> {
    const out: FactInput[] = [];
    for (const element of await this.elements(rule)) {
      const key = toStringValue(await this.ev(rule.subject.key, element, 'fact subject'));
      if (!key) {
        this.warn(`fact rule #${index} (${rule.predicate}) produced no subject`);
        continue;
      }
      const raw = await this.fieldValue(rule.value, element);
      const value = toJson(raw);
      if (value === undefined || value === null) continue;
      const fact: FactInput = {
        subject: this.ctx.id(rule.subject.ref, key),
        predicate: rule.predicate,
        value,
        origin: rule.origin,
      };
      if (rule.confidence !== undefined) fact.confidence = rule.confidence;
      if (rule.evidence) {
        const e = toStringValue(await this.ev(rule.evidence, element, 'fact evidence'));
        if (e) fact.evidence = e;
      }
      for (const k of ['observedAt', 'validFrom', 'validUntil'] as const) {
        const src = rule[k];
        if (!src) continue;
        const iso = toIsoDateTime(await this.ev(src, element, `fact ${k}`), this.ctx.timezone);
        if (iso) fact[k] = iso;
      }
      const ref = await this.refSpec(rule.ref, element);
      if (ref) fact.ref = ref;
      out.push(fact);
    }
    return out;
  }
}

/**
 * Text the host extracted from a downloaded file (FILE_TEXT_SOURCE_TYPE): one documentChunk per
 * piece, tied to the document the file belongs to, so search and the file text excerpt see it.
 */
function normalizeFileText(item: RawItemView, ctx: NormalizeContext): NormalizeOutput {
  const p = item.payload as Partial<FileTextPayload> | null;
  if (
    !p ||
    typeof p.documentId !== 'string' ||
    !isIdOf('document', p.documentId) ||
    !Array.isArray(p.chunks)
  )
    return { entities: [], warnings: [`invalid ${item.sourceType} payload`] };
  const cite: SourceRefSpec = {};
  if (typeof p.ref?.sourceLabel === 'string') cite.sourceLabel = p.ref.sourceLabel;
  if (typeof p.ref?.url === 'string') cite.url = p.ref.url;
  if (typeof p.ref?.authority === 'string') cite.authority = p.ref.authority;
  const entities: NormalizedEntity[] = [];
  for (const piece of p.chunks) {
    if (typeof piece?.text !== 'string' || !piece.text.trim()) continue;
    const page = typeof piece.page === 'number' && piece.page > 0 ? piece.page : undefined;
    entities.push({
      entity: {
        id: ctx.id('documentChunk', p.documentId, String(entities.length)),
        kind: 'documentChunk',
        documentId: p.documentId,
        ordinal: entities.length,
        text: piece.text,
        ...(page ? { page } : {}),
        ...(piece.heading ? { heading: piece.heading } : {}),
      },
      ref: { ...cite, ...(page ? { location: { page } } : {}) },
    });
  }
  return { entities };
}

export interface MappedNormalizer extends Normalizer {
  readonly spec: MappingSpec;
}

/** A normalizer driven entirely by a MappingSpec (`entities`, `facts`, `drift`). */
export function createMappedNormalizer(spec: MappingSpec): MappedNormalizer {
  const driftSchemas = new Map<string, z.ZodType>();
  for (const [type, def] of Object.entries(spec.drift ?? {}))
    driftSchemas.set(type, miniSchemaToZod(def));
  const sourceTypes = [
    ...new Set([...Object.keys(spec.entities), ...spec.facts.map((f) => f.sourceType)]),
    // text of downloaded files, when the mapping has `files:` (see FileDownloadAdapter)
    ...(spec.files ? [FILE_TEXT_SOURCE_TYPE] : []),
  ];
  // vars take part: another Ed region (mappingVars) changes every web link, so items re-normalize.
  const version = `${spec.version}.${contentHash({ e: spec.entities, f: spec.facts, d: spec.drift, ...(Object.keys(spec.vars).length > 0 ? { v: spec.vars } : {}) }).slice(0, 8)}`;

  return {
    id: `mapped:${spec.id}`,
    version,
    sourceTypes,
    spec,
    async normalize(item: RawItemView, ctx: NormalizeContext): Promise<NormalizeOutput> {
      if (item.sourceType === FILE_TEXT_SOURCE_TYPE && spec.files)
        return normalizeFileText(item, ctx);
      const runner = new RuleRunner(item, ctx, item.payload, spec.vars);
      const entities: NormalizedEntity[] = [];
      const facts: FactInput[] = [];
      const rules = spec.entities[item.sourceType] ?? [];
      for (const [i, rule] of rules.entries()) entities.push(...(await runner.entities(rule, i)));
      for (const [i, rule] of spec.facts.entries())
        if (rule.sourceType === item.sourceType) facts.push(...(await runner.facts(rule, i)));

      const out: NormalizeOutput = { entities, facts, warnings: runner.warnings };
      const driftSchema = driftSchemas.get(item.sourceType);
      if (driftSchema) {
        let subject = item.payload;
        if (isPlainObject(subject) && PARENT_KEY in subject) {
          const { [PARENT_KEY]: _parent, ...rest } = subject;
          subject = rest;
        }
        const findings = detectSchemaDrift(subject, driftSchema);
        out.drift = spec.strictDrift ? findings : findings.filter((f) => f.kind !== 'unknown');
      }
      return out;
    },
  };
}
