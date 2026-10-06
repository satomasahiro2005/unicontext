/**
 * Places and travel time (stream D).
 *
 * Rooms come in as the academic system prints them (「情１３」「工５－２２」「共通講義棟２１」). `normalizeRoom`
 * turns one into a building and a room, `placeKey` into the key travel times hang on (the building
 * or area, so 工５－２２ and 工３－３１ are both 「工」). Location entities are built lazily from the
 * key (id derived from it) and only in the view layer: no connector writes them.
 *
 * Travel time is the student's own word (MCP `set_travel_time`): a user-origin fact
 * `travel:minutes` on subject `location:<from>` with value `{to, minutes, mode?}`. UniContext never
 * asks a maps service.
 */
import { type Id, type JsonValue, stableId } from '@unicontext/canonical-model';
import type { Fact } from '@unicontext/canonical-model';
import type { PlaceInfo } from './types.js';

export interface NormalizedRoom {
  building?: string;
  room: string;
  campus?: string;
}

/** The key for where the student lives. */
export const HOME_KEY = 'home';
export const TRAVEL_PREDICATE = 'travel:minutes';
export const TRAVEL_MODES = ['walk', 'bike', 'train', 'bus', 'car'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

interface BuildingRule {
  /** The building / area key (travel keys, `NormalizedRoom.building`). */
  key: string;
  label: string;
  campus?: string;
  /** Matches a normalized room (NFKC, hyphens ASCII). */
  room: RegExp;
  /** Matches free text that names the building or area (an event's location, a travel statement). */
  text: RegExp;
}

// TODO(profile): move to an optional `places` section of profiles/<university>/profile.yaml once
// ProfileSchema carries it (it strips unknown keys today). Campus is only stated where it is certain:
// 工学部 and 情報学部 are on the Hamamatsu campus.
const BUILDINGS: readonly BuildingRule[] = [
  { key: '工', label: '工学部', campus: '浜松', room: /^工\d/, text: /工学部|^工$/ },
  { key: '情', label: '情報学部', campus: '浜松', room: /^情\d/, text: /情報学部|^情$/ },
  { key: '総', label: '総合研究棟', room: /^総\d/, text: /総合研究棟|^総$/ },
  {
    key: '共通講義棟',
    label: '共通講義棟',
    room: /^共通講義棟/,
    text: /共通講義棟/,
  },
  { key: '共A', label: '共通教育A棟', room: /^共A\d/, text: /共通教育A棟|^共A$/ },
  { key: '共L', label: '共通教育L棟', room: /^共L\d/, text: /共通教育L棟|^共L$/ },
];

const HOME_TEXT = /^(home|my home|自宅|家|実家|寮|下宿|アパート|自分の家)$/i;
const ONLINE_TEXT = /zoom|teams|meet\.|google meet|webex|オンライン|online|遠隔|https?:\/\//i;

function nfkc(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‐‑‒–—―−－]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(s: string): string {
  return nfkc(s).toLowerCase().replace(/\s+/g, '');
}

/** True for locations that are not a place (a meeting link, 「オンライン」). */
export function isOnlineLocation(text: string): boolean {
  return ONLINE_TEXT.test(text);
}

/**
 * Building, room and campus of a room as the academic system prints it. Several rooms (「情２４、
 * 共通講義棟２１」) or 「…他」: the first one.
 */
export function normalizeRoom(raw: string): NormalizedRoom {
  const first = nfkc(raw.split(/[、,，;；]/)[0] ?? raw)
    .replace(/\s*他$/, '')
    .trim();
  const rule = BUILDINGS.find((b) => b.room.test(first) || b.text.test(first));
  return {
    ...(rule ? { building: rule.key } : {}),
    room: first,
    ...(rule?.campus ? { campus: rule.campus } : {}),
  };
}

/**
 * The key travel time hangs on for a room or a place named in words: `home`, a building / area
 * (工 for every 工N号館 room), else the compacted text.
 */
export function placeKey(text: string): string {
  const t = nfkc(text);
  if (HOME_TEXT.test(t)) return HOME_KEY;
  const byText = BUILDINGS.find((b) => b.text.test(t));
  if (byText) return byText.key;
  const room = normalizeRoom(t);
  return room.building ?? compact(room.room);
}

/** 「自宅」「工学部」 or the key itself for an unknown place. */
export function placeLabel(key: string): string {
  if (key === HOME_KEY) return '自宅';
  return BUILDINGS.find((b) => b.key === key)?.label ?? key;
}

/** Location entity id of a place key: the same key always gives the same id. */
export function locationIdFor(key: string): Id<'location'> {
  return stableId('location', 'place', key);
}

/** The place of a room (or an event's location text) for the views; undefined for online / empty. */
export function placeOf(raw: string | undefined): PlaceInfo | undefined {
  if (!raw || raw.trim() === '' || isOnlineLocation(raw)) return undefined;
  const room = normalizeRoom(raw);
  if (!room.room) return undefined;
  return { ...room, locationId: locationIdFor(placeKey(raw)) };
}

/** What `placeOf` keys travel on. */
export function travelKeyOf(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === '' || isOnlineLocation(raw)) return undefined;
  return placeKey(raw);
}

/** A Location entity for a place key, built when it is needed (never read from a connector). */
export function locationEntity(key: string): {
  id: Id<'location'>;
  kind: 'location';
  name: string;
  building?: string;
} {
  const rule = BUILDINGS.find((b) => b.key === key);
  return {
    id: locationIdFor(key),
    kind: 'location',
    name: placeLabel(key),
    ...(rule ? { building: rule.key } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Travel time

export interface TravelRecord {
  from: string;
  to: string;
  minutes: number;
  mode?: string;
  factId: string;
  observedAt: string;
}

/** Subject of the facts for trips starting at `fromKey`. */
export function travelSubject(fromKey: string): string {
  return `location:${fromKey}`;
}

export function travelValue(
  from: string,
  to: string,
  minutes: number,
  mode?: string,
): Record<string, JsonValue> {
  return {
    to,
    minutes,
    ...(mode ? { mode } : {}),
    fromLabel: placeLabel(from),
    toLabel: placeLabel(to),
  };
}

function recordOf(f: Fact): TravelRecord | undefined {
  const v = f.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const to = typeof v['to'] === 'string' ? v['to'] : undefined;
  const minutes = typeof v['minutes'] === 'number' ? v['minutes'] : undefined;
  const from = f.subject.startsWith('location:') ? f.subject.slice('location:'.length) : undefined;
  if (!to || !from || minutes === undefined || !Number.isFinite(minutes) || minutes < 0)
    return undefined;
  const mode = typeof v['mode'] === 'string' ? v['mode'] : undefined;
  return {
    from,
    to,
    minutes,
    ...(mode ? { mode } : {}),
    factId: f.id,
    observedAt: f.observedAt,
  };
}

/** The student's stated trips. The newest statement of a pair wins; a trip counts both ways. */
export class TravelBook {
  private readonly records: TravelRecord[];
  constructor(facts: readonly Fact[]) {
    this.records = facts
      .filter((f) => f.predicate === TRAVEL_PREDICATE && !f.retractedAt)
      .flatMap((f) => recordOf(f) ?? [])
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  }

  get size(): number {
    return this.records.length;
  }

  between(from: string, to: string): TravelRecord | undefined {
    if (from === to) return undefined;
    return (
      this.records.find((r) => r.from === from && r.to === to) ??
      this.records.find((r) => r.from === to && r.to === from)
    );
  }
}
