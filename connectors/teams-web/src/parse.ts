import { htmlToText } from '@unicontext/adapter-browser';
import {
  DEFAULT_SENSITIVE_KEY_PATTERN,
  findDatePhrase,
  isPermanentChange,
  zonedParts,
  zonedTime,
} from '@unicontext/core';

/** Microsoft's global Assignments bot / app ids (the same in every tenant). */
export const ASSIGNMENTS_BOT_MRI = '28:7254e396-868c-4bf7-96b2-6fe763590b5a';
export const ASSIGNMENTS_APP_ID = '66aeee93-507d-479a-a3ef-8f494af43945';

/** Documented Teams deep-link host. */
export const DEEP_LINK_HOST = 'https://teams.microsoft.com';

// ---------------------------------------------------------------------------------------------
// Secrets

/** Keys that may carry pre-authenticated URLs or tokens (dropped wherever they appear). */
const SECRET_KEY =
  /download\s*url|tempauth|access_?token|refresh_?token|skypetoken|authorization|cookie|sync_?token|continuation_?token|@delta\.token/i;
/** Query parameters that authenticate a URL by themselves. */
const SECRET_PARAM =
  /^(tempauth|token|access_token|sig|signature|code|skypetoken|authtoken|t|se|sp|sv)$/i;

/** Authenticating parameters inside longer text (HTML links): `?tempauth=…`, `&token=…`. */
const EMBEDDED_SECRET_PARAM =
  /([?&])(?:tempauth|access_token|token|sig|skypetoken|authtoken)=[^&"'\s<>]*&?/gi;

/** Strip authenticating query parameters from a URL (keeps the rest). Non-URLs pass through. */
export function scrubUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const u = new URL(value);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(k)) {
        u.searchParams.delete(k);
        changed = true;
      }
    }
    return changed ? u.toString() : value;
  } catch {
    return value;
  }
}

/**
 * Deep copy without anything that could authenticate a request: keys such as
 * `@content.downloadUrl` are removed and URLs lose `tempauth`/`token`/`sig` parameters. Applied
 * to every payload before it leaves the browser.
 */
export function scrubSecrets<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const t = v.trimStart();
      // The client keeps some lists as JSON strings (e.g. properties.files): scrub inside them.
      if ((t.startsWith('[') || t.startsWith('{')) && t.length > 1) {
        try {
          return JSON.stringify(walk(JSON.parse(v)));
        } catch {
          // not JSON
        }
      }
      return scrubUrl(v).replace(EMBEDDED_SECRET_PARAM, '$1');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_KEY.test(k) || DEFAULT_SENSITIVE_KEY_PATTERN.test(k)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

export function toIso(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : /^\d{10,}$/.test(value) ? Number(value) : NaN;
  const d = Number.isNaN(n) ? new Date(String(value)) : new Date(n);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function truthy(v: boolean | string | null | undefined): boolean {
  return v === true || v === 'true' || v === 'True';
}

/** A list stored either as an array or as a JSON string (the client uses both). */
export function jsonList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const s = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Academic year (April start) of an instant in the given zone. */
export function academicYearOf(iso: string, timezone: string): number {
  const p = zonedParts(new Date(iso), timezone);
  return p.month >= 4 ? p.year : p.year - 1;
}

// ---------------------------------------------------------------------------------------------
// Team names

export interface ParsedTeamName {
  title: string;
  academicYear: number | undefined;
  /** Bracketed class/section hint such as 「科学科」. */
  section: string | undefined;
}

/**
 * Class team names carry the year anywhere (`2026情報科学実験B`, `2026-機械語と計算機械`,
 * `PBL演習2024情報科学科`, `認知科学2024`) and sometimes a section in brackets
 * (`2024プログラミング入門(科学科)`). Returns the course title without them.
 */
export function parseClassTeamName(name: string): ParsedTeamName {
  let t = name.normalize('NFKC').trim();
  let academicYear: number | undefined;
  const year = /(?<!\d)(20\d{2})(?:年度|年)?(?!\d)/.exec(t);
  if (year) {
    academicYear = Number(year[1]);
    t = `${t.slice(0, year.index)} ${t.slice(year.index + year[0].length)}`;
  }
  let section: string | undefined;
  const bracket = /[(（[［【]\s*([^)）\]］】]+?)\s*[)）\]］】]\s*$/.exec(t.trim());
  if (bracket) {
    section = bracket[1];
    t = t.trim().slice(0, bracket.index);
  }
  t = t
    .replace(/^[\s\-_‐－―・:：/]+|[\s\-_‐－―・:：/]+$/g, '')
    .replace(/\s+[-_‐－―・]\s+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { title: t || name.trim(), academicYear, section };
}

/** CJK part of "Romaji Name (漢字 名前)" style display names, or the name itself when it is CJK. */
export function cjkName(displayName: string | null | undefined): string | undefined {
  if (!displayName) return undefined;
  const cjk = /[぀-ヿ㐀-鿿]/;
  const bracket = /[(（]([^)）]+)[)）]\s*$/.exec(displayName);
  if (bracket?.[1] && cjk.test(bracket[1])) return bracket[1].trim();
  if (cjk.test(displayName)) return displayName.replace(/[(（][^)）]*[)）]\s*$/, '').trim();
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Deep links (documented formats)

export function channelLink(
  channelId: string,
  channelName: string,
  groupId: string,
  tenantId?: string | null,
): string {
  const q = new URLSearchParams({ groupId, ...(tenantId ? { tenantId } : {}) });
  return `${DEEP_LINK_HOST}/l/channel/${encodeURIComponent(channelId)}/${encodeURIComponent(channelName)}?${q.toString()}`;
}

export function teamLink(teamId: string, groupId: string, tenantId?: string | null): string {
  const q = new URLSearchParams({ groupId, ...(tenantId ? { tenantId } : {}) });
  return `${DEEP_LINK_HOST}/l/team/${encodeURIComponent(teamId)}/conversations?${q.toString()}`;
}

export function messageLink(input: {
  channelId: string;
  messageId: string;
  parentMessageId: string;
  groupId: string;
  tenantId?: string | null;
}): string {
  const q = new URLSearchParams({
    groupId: input.groupId,
    parentMessageId: input.parentMessageId,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
  });
  return `${DEEP_LINK_HOST}/l/message/${encodeURIComponent(input.channelId)}/${input.messageId}?${q.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Message content

/** Plain text of a message's HTML (mentions keep their visible name; images become [画像]). */
export function messageText(content: string | null | undefined): string {
  if (!content) return '';
  const html = content
    .replace(/<URIObject\b[\s\S]*?<\/URIObject>/gi, ' ')
    .replace(/<Swift\b[\s\S]*?<\/Swift>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' [画像] ');
  if (!/[<&]/.test(html)) return html.trim();
  return htmlToText(html);
}

export interface Attachment {
  name: string;
  fileType: string | undefined;
  url: string | undefined;
  uniqueId: string | undefined;
}

export function attachments(files: unknown): Attachment[] {
  const out: Attachment[] = [];
  for (const raw of jsonList(files)) {
    const f = rec(raw);
    const info = rec(f.fileInfo);
    const ids = rec(f.sharepointIds);
    const name = s(f.fileName) ?? s(f.title);
    if (!name) continue;
    const url = s(info.fileUrl) ?? s(f.objectUrl);
    out.push({
      name,
      fileType: s(f.fileType) ?? s(f.type),
      url: url ? scrubUrl(url) : undefined,
      uniqueId: s(ids.listItemUniqueId)?.toLowerCase(),
    });
  }
  return out;
}

export interface Mention {
  type: string;
  name: string;
  mri: string | undefined;
}

export function mentions(value: unknown): Mention[] {
  return jsonList(value).flatMap((raw) => {
    const m = rec(raw);
    const name = s(m.displayName);
    if (!name) return [];
    return [{ type: s(m.mentionType) ?? 'person', name, mri: s(m.mri) }];
  });
}

// ---------------------------------------------------------------------------------------------
// Assignments bot cards

export interface AssignmentCard {
  title: string;
  dueText: string | undefined;
  url: string | undefined;
  classId: string;
  assignmentId: string;
}

function decodeBase64(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

function textBlocks(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const x of node) textBlocks(x, out);
    return out;
  }
  const r = rec(node);
  if (r.type === 'TextBlock' && typeof r.text === 'string') out.push(r);
  for (const k of ['body', 'items', 'columns']) if (r[k]) textBlocks(r[k], out);
  return out;
}

/** Decode the adaptive card the Assignments bot posts (`<Swift b64="…">`). */
export function decodeAssignmentCard(
  content: string | null | undefined,
): AssignmentCard | undefined {
  const m = /<Swift\b[^>]*\bb64="([^"]+)"/i.exec(content ?? '');
  if (!m?.[1]) return undefined;
  let swift: unknown;
  try {
    swift = JSON.parse(decodeBase64(m[1]));
  } catch {
    return undefined;
  }
  const card = rec(rec(jsonList(rec(swift).attachments)[0]).content);
  const blocks = textBlocks(card.body);
  const titleBlock = blocks.find((b) => b.weight === 'bolder' || b.size === 'large') ?? blocks[0];
  const title = s(titleBlock?.text)?.trim();
  const dueText = blocks
    .map((b) => s(b.text))
    .find((t) => t !== undefined && /期限|締切|due/i.test(t));
  const action = jsonList(card.actions)
    .map(rec)
    .find((a) => typeof a.url === 'string');
  const url = s(action?.url);
  if (!title || !url) return undefined;
  let classId: string | undefined;
  let assignmentId: string | undefined;
  try {
    const context: unknown = JSON.parse(new URL(url).searchParams.get('context') ?? '{}');
    const sub: unknown = JSON.parse(s(rec(context).subEntityId) ?? '{}');
    const cls = rec(jsonList(rec(rec(sub).config).classes)[0]);
    classId = s(cls.id);
    assignmentId = s(jsonList(cls.assignmentIds)[0]);
  } catch {
    return undefined;
  }
  if (!classId || !assignmentId) return undefined;
  return { title, dueText: dueText?.trim(), url, classId, assignmentId };
}

/**
 * "期限 5月9日" (+ optional "23:59") → ISO instant. The card has no year: take the posting year,
 * and the next year when that date lies more than 30 days before the post. No time → 23:59.
 */
export function parseCardDue(
  dueText: string | null | undefined,
  postedAt: string | undefined,
  timezone: string,
): string | undefined {
  if (!dueText || !postedAt) return undefined;
  const t = dueText.normalize('NFKC');
  const m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日|(\d{1,2})\s*\/\s*(\d{1,2})/.exec(t);
  if (!m) return undefined;
  const month = Number(m[1] ?? m[3]);
  const day = Number(m[2] ?? m[4]);
  const time = /(\d{1,2}):(\d{2})/.exec(t.slice((m.index ?? 0) + m[0].length));
  const hour = time ? Number(time[1]) : 23;
  const minute = time ? Number(time[2]) : 59;
  const posted = zonedParts(new Date(postedAt), timezone);
  let due = zonedTime({ year: posted.year, month, day, hour, minute }, timezone);
  if (due.getTime() < new Date(postedAt).getTime() - 30 * 86_400_000)
    due = zonedTime({ year: posted.year + 1, month, day, hour, minute }, timezone);
  return due.toISOString();
}

// ---------------------------------------------------------------------------------------------
// Files

export type MaterialKind =
  'slides' | 'handout' | 'recording' | 'reading' | 'code' | 'link' | 'other';

export function extensionOf(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(name);
  return (m?.[1] ?? '').toLowerCase();
}

export function materialKindFor(name: string, mimeType?: string | null): MaterialKind {
  const ext = extensionOf(name);
  if (['ppt', 'pptx', 'key', 'odp'].includes(ext)) return 'slides';
  if (['mp4', 'mov', 'm4a', 'mp3', 'wav', 'webm', 'mkv'].includes(ext)) return 'recording';
  if (['py', 'c', 'cpp', 'h', 'java', 'js', 'ts', 'rb', 'go', 'rs', 'ipynb', 'zip'].includes(ext))
    return 'code';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'odt'].includes(ext)) return 'handout';
  if (ext === 'url' || ext === 'webloc') return 'link';
  if (mimeType?.startsWith('video/') || mimeType?.startsWith('audio/')) return 'recording';
  return 'other';
}

/** "/drive/root:/00_講義資料/sub" → "00_講義資料/sub" ("" = library root). */
export function driveFolder(parentPath: string | null | undefined): string {
  if (!parentPath) return '';
  const i = parentPath.indexOf('root:');
  const rest = i >= 0 ? parentPath.slice(i + 5) : parentPath;
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // keep as is
  }
  return decoded.replace(/^\/+|\/+$/g, '');
}

/** SharePoint list item unique id from an eTag such as `"{5B6C…},3"`. */
export function uniqueIdFromEtag(eTag: string | null | undefined): string | undefined {
  const m = /\{([0-9a-f-]{36})\}/i.exec(eTag ?? '');
  return m?.[1]?.toLowerCase();
}

/** Last path segment of a channel's document folder (`…/Shared Documents/00_講義資料`). */
export function folderNameOf(relativeUrl: string | null | undefined): string | undefined {
  if (!relativeUrl) return undefined;
  const parts = relativeUrl.replace(/\/+$/, '').split('/');
  const last = parts[parts.length - 1];
  return last ? last : undefined;
}

// ---------------------------------------------------------------------------------------------
// Room-change hint in instructor posts (same rules as the Graph connector)

const ROOM_CHARS = '[0-9A-Za-z０-９Ａ-Ｚａ-ｚ\\-－ー棟館号階]';
const ROOM_SUFFIX = '(?:教室|講義室|演習室|実習室|室)';
const ROOM_WITH_SUFFIX = `${ROOM_CHARS}{1,12}${ROOM_SUFFIX}`;
const ROOM_PATTERNS: RegExp[] = [
  new RegExp(`教室を\\s*(${ROOM_CHARS}{1,12}${ROOM_SUFFIX}?)\\s*(?:に|へ)\\s*(?:変更|移動)`),
  new RegExp(`(${ROOM_WITH_SUFFIX})\\s*(?:に|へ)\\s*(?:変更|移動)`),
  new RegExp(`(${ROOM_WITH_SUFFIX})\\s*(?:で|にて)\\s*(?:行い|行う|実施|開催|おこな)`),
];

export interface RoomChangeHint {
  room: string;
  /** The sentence the room was read from. */
  sentence: string;
  /** The words that name the day (「本日」「10/6(月)」「次回」), from this sentence or the one before. */
  datePhrase?: string;
  /** 以降 / 今後 / これから: the change is for the course from now on, not for one day. */
  permanent: boolean;
}

export function extractRoomChange(text: string): RoomChangeHint | undefined {
  for (const re of ROOM_PATTERNS) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    const room = m[1].normalize('NFKC').replace(/\s+/g, '');
    const sentences = text
      .split(/(?<=[。！？!?\n])/)
      .map((x) => x.trim())
      .filter(Boolean);
    const at = sentences.findIndex((x) => x.includes(m[0]));
    const sentence = sentences[at] ?? m[0];
    const near = [sentence, sentences[at - 1]].filter((x): x is string => Boolean(x));
    const datePhrase = near.map((x) => findDatePhrase(x)).find(Boolean);
    return {
      room,
      sentence: sentence.slice(0, 200),
      ...(datePhrase ? { datePhrase } : {}),
      permanent: near.some((x) => isPermanentChange(x)),
    };
  }
  return undefined;
}

export function firstLine(text: string, max = 60): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
