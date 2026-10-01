import { sha256, ValidationError, DEFAULT_TIMEZONE } from '@unicontext/core';
import { z } from 'zod';
import { DEFAULT_FORMATS, type ParsedTranscript, type TranscriptFormat } from './parsers.js';
import { findLocalDateTime, localDateOf, localToIso, parseDateTimeText } from './time.js';

export const RAW_TYPE_TRANSCRIPT = 'transcript.file';

export const TranscriptPayloadSchema = z.object({
  /** File name (or a synthetic name for pasted text); never an absolute path. */
  fileName: z.string(),
  format: z.string(),
  title: z.string(),
  /** ISO instant. */
  recordedAt: z.string(),
  courseHint: z.string().optional(),
  language: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  segments: z.array(
    z.object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().nonnegative().optional(),
      speaker: z.string().optional(),
      text: z.string(),
    }),
  ),
  /** sha256 of the file content. */
  hash: z.string(),
  /** False when the source carried no timestamps (all segments start at 0). */
  hasTimestamps: z.boolean().optional(),
  /** Importer id for LectureTranscript.importer. */
  importer: z.string().optional(),
});
export type TranscriptPayload = z.infer<typeof TranscriptPayloadSchema>;

/** Options of a manual import (CLI `import-transcript`, adapter.importFile / importText). */
export interface ImportOptions {
  /** Course name; wins over the header line and the folder name. */
  courseHint?: string;
  /** Recording date `YYYY-MM-DD` (time optional) or an ISO instant; wins over everything else. */
  date?: string;
  title?: string;
  /** Importer id (default: the connector's `importer` config). */
  importer?: string;
  /** Force a format id (default: by extension / content). */
  format?: string;
}

export interface TranscriptInput {
  fileName: string;
  content: string;
  timezone?: string;
  /** File modification time: last-resort recordedAt. */
  mtime?: Date;
  /** Fallback when nothing else says when it was recorded (e.g. "now" for pasted text). */
  now?: Date;
  /** Course hint derived from the folder under watchDir. */
  folderHint?: string;
  options?: ImportOptions;
  importer?: string;
}

function stem(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(0, i) : fileName;
}

function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(i + 1).toLowerCase() : '';
}

/** recordedAt candidates from a file name: "2026-10-01 10-40", "20261001_1040", "2026-10-01T10:40". */
export function recordedAtFromFileName(fileName: string, timezone: string): string | undefined {
  const found = findLocalDateTime(stem(fileName));
  return found ? localToIso(found, timezone) : undefined;
}

/** Format registry: parsers per extension; Zoom/Teams/other importers register more. */
export class TranscriptImporter {
  private readonly formats: TranscriptFormat[];

  constructor(formats: readonly TranscriptFormat[] = DEFAULT_FORMATS) {
    this.formats = [...formats];
  }

  /** Add (or replace by id) a format. */
  register(format: TranscriptFormat): this {
    const i = this.formats.findIndex((f) => f.id === format.id);
    if (i >= 0) this.formats[i] = format;
    else this.formats.push(format);
    return this;
  }

  get extensions(): string[] {
    return [...new Set(this.formats.flatMap((f) => f.extensions))];
  }

  formatById(id: string): TranscriptFormat | undefined {
    return this.formats.find((f) => f.id === id);
  }

  /** Pick the format by explicit id, then by extension; WebVTT content is recognised in any file. */
  detect(fileName: string, content?: string, formatId?: string): TranscriptFormat | undefined {
    if (formatId) return this.formatById(formatId);
    if (content && /^\uFEFF?WEBVTT/.test(content)) return this.formatById('vtt');
    const ext = extensionOf(fileName);
    return this.formats.find((f) => f.extensions.includes(ext));
  }

  /** Parse content into segments + metadata (throws ValidationError for unknown formats). */
  parse(
    fileName: string,
    content: string,
    options: { timezone?: string; format?: string } = {},
  ): ParsedTranscript & { format: TranscriptFormat } {
    const format = this.detect(fileName, content, options.format);
    if (!format)
      throw new ValidationError(
        `Unsupported transcript format: ${fileName} (supported: ${this.extensions.join(', ')})`,
      );
    try {
      return {
        ...format.parse(content, { timezone: options.timezone ?? DEFAULT_TIMEZONE }),
        format,
      };
    } catch (e) {
      throw new ValidationError(
        `Cannot parse ${fileName} as ${format.id}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  /** Full pipeline: parse, resolve recordedAt / course hint / title, build the raw payload. */
  toPayload(input: TranscriptInput): TranscriptPayload {
    const timezone = input.timezone ?? DEFAULT_TIMEZONE;
    const opts = input.options ?? {};
    const parsed = this.parse(input.fileName, input.content, {
      timezone,
      ...(opts.format ? { format: opts.format } : {}),
    });
    if (parsed.segments.length === 0)
      throw new ValidationError(`No transcript segments found in ${input.fileName}`);

    const fromName = recordedAtFromFileName(input.fileName, timezone);
    let recordedAt: string | undefined;
    if (opts.date) {
      const explicit = parseDateTimeText(opts.date, timezone);
      if (explicit) {
        const dateOnly = !/\d{1,2}\s*[:時]\s*\d{2}|T\d{2}:/.test(opts.date.normalize('NFKC'));
        // A bare date keeps the time of day the content/file name knows for the same day.
        const known = parsed.recordedAt ?? fromName;
        recordedAt =
          dateOnly && known && localDateOf(known, timezone) === localDateOf(explicit, timezone)
            ? known
            : explicit;
      }
    }
    recordedAt ??=
      parsed.recordedAt ?? fromName ?? input.mtime?.toISOString() ?? input.now?.toISOString();
    recordedAt ??= new Date().toISOString();

    const courseHint = opts.courseHint?.trim() || parsed.courseHint || input.folderHint;
    const durationMs = parsed.hasTimestamps
      ? Math.max(...parsed.segments.map((s) => s.endMs ?? s.startMs))
      : 0;
    return {
      fileName: input.fileName,
      format: parsed.format.id,
      title: opts.title?.trim() || parsed.title || stem(input.fileName),
      recordedAt,
      ...(courseHint ? { courseHint } : {}),
      ...(parsed.language ? { language: parsed.language } : {}),
      durationMs,
      segments: parsed.segments,
      hash: sha256(input.content),
      hasTimestamps: parsed.hasTimestamps,
      importer: opts.importer ?? parsed.format.importer ?? input.importer ?? 'chatgpt-record',
    };
  }
}

/** The shared default importer (txt, md, vtt, srt, json). */
export const defaultTranscriptImporter = new TranscriptImporter();
