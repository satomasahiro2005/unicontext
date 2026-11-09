/**
 * What someone the student shares with may see, chosen per person from these categories. The
 * student sees everything; a shared person connects with the same connector (signing in with
 * their own invite code) and gets only the tools their categories unlock, read-only.
 */

export const ACCESS_CATEGORIES = [
  'schedule',
  'courses',
  'deadlines',
  'submissions',
  'assignments',
  'announcements',
  'materials',
  'lectures',
  'grades',
  'attendance',
] as const;
export type AccessCategory = (typeof ACCESS_CATEGORIES)[number];

export const ACCESS_LABELS: Record<AccessCategory, string> = {
  schedule: '時間割（授業・教室・休講）',
  courses: '履修科目・シラバス',
  deadlines: '締切・試験',
  submissions: '提出状況',
  assignments: '課題（中身と提出状況）',
  announcements: 'お知らせ',
  materials: '授業資料・ファイル・Teamsの投稿',
  lectures: '講義録・メモ',
  grades: '成績・単位',
  attendance: '出席',
};

export const ACCESS_PRESETS = {
  friend: ['schedule', 'courses'],
  family: ['schedule', 'courses', 'deadlines', 'submissions'],
  all: [...ACCESS_CATEGORIES],
} as const satisfies Record<string, readonly AccessCategory[]>;
export type AccessPreset = keyof typeof ACCESS_PRESETS;

/**
 * The student's own tools a shared person may call, by the category that unlocks each. Tools that
 * mix categories (get_today, get_week, search, get_course, …) are never shared; the schedule,
 * course list and deadlines come from projections registered for shared people (the daemon's
 * member tools). open_announcement is left out: it opens the notice in the university's system.
 */
export const SHARED_TOOLS: Record<AccessCategory, readonly string[]> = {
  schedule: [],
  courses: ['get_syllabus', 'search_syllabus'],
  deadlines: [],
  submissions: [],
  assignments: ['get_assignments', 'get_assignment'],
  announcements: ['get_announcements', 'get_announcement'],
  materials: [
    'get_document',
    'list_course_files',
    'download_course_file',
    'get_teams_activity',
    'browse_vpn_files',
    'search_vpn_files',
    'list_recent_vpn_files',
  ],
  lectures: ['get_notes'],
  grades: ['get_credit_summary'],
  attendance: ['get_attendance'],
};

export function sharedTools(access: ReadonlySet<AccessCategory>): Set<string> {
  return new Set([...access].flatMap((c) => SHARED_TOOLS[c]));
}

export function isAccessCategory(value: string): value is AccessCategory {
  return (ACCESS_CATEGORIES as readonly string[]).includes(value);
}

/**
 * `schedule,deadlines` or a preset name (`family`), comma- or space-separated; unknown words are
 * returned in `unknown` (never silently dropped).
 */
export function parseAccess(input: readonly string[]): {
  categories: AccessCategory[];
  unknown: string[];
} {
  const out = new Set<AccessCategory>();
  const unknown: string[] = [];
  for (const word of input.flatMap((s) => s.split(/[\s,、]+/)).filter(Boolean)) {
    const w = word.toLowerCase();
    if (w in ACCESS_PRESETS) for (const c of ACCESS_PRESETS[w as AccessPreset]) out.add(c);
    else if (isAccessCategory(w)) out.add(w);
    else unknown.push(word);
  }
  return { categories: ACCESS_CATEGORIES.filter((c) => out.has(c)), unknown };
}
