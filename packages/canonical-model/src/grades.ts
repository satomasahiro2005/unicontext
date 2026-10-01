/**
 * Grade outcomes: the raw evaluation label of the university system (秀, 不可, 合, 認定, 再試 …) is
 * always kept verbatim; this module only adds a normalized outcome used for credit totals.
 * A label that is not in the tables below is `unknown` — it is never counted as passed or failed.
 */

export const GRADE_OUTCOMES = [
  /** Credit earned by passing (秀/優/良/可/合 …). */
  'passed',
  /** Not earned (不可/否/不合格 …). */
  'failed',
  /** Registered, the course is running (履修中, or an empty label in a "including in-progress" list). */
  'in_progress',
  /** The course is over but no final evaluation exists yet (未評価, 保留, 再試 = waiting for the re-exam …). */
  'not_graded',
  /** Withdrawn or abandoned (放棄, 欠席, 取消, 履修中止 …). */
  'withdrawn',
  /** Credit recognized without a graded course (認定, 単位認定 …). Counts as earned. */
  'transferred',
  'unknown',
] as const;
export type GradeOutcome = (typeof GRADE_OUTCOMES)[number];

/** Japanese labels for display. */
export const GRADE_OUTCOME_LABELS: Readonly<Record<GradeOutcome, string>> = {
  passed: '合格',
  failed: '不合格',
  in_progress: '履修中',
  not_graded: '未評価',
  withdrawn: '放棄・取消',
  transferred: '認定',
  unknown: '不明',
};

const TABLE: ReadonlyArray<[GradeOutcome, readonly string[]]> = [
  [
    'passed',
    ['秀', '優', '良', '可', '合', '合格', '修得', 'S', 'A', 'B', 'C', 'AA', 'A+', 'P', 'PASS'],
  ],
  ['failed', ['不可', '否', '不合格', '不認定', '未修得', '失格', 'F', 'FAIL']],
  ['in_progress', ['履修中', '受講中', '履修登録中']],
  [
    'not_graded',
    [
      '未評価',
      '評価なし',
      '評価無',
      '保留',
      '再試',
      '再試験',
      '追試',
      '追試験',
      '未報告',
      '未入力',
      '-',
      '－',
      '―',
      'ー',
    ],
  ],
  [
    'withdrawn',
    ['放棄', '欠席', '欠', '取消', '取り消し', '履修取消', '履修中止', '中止', '辞退', 'W'],
  ],
  ['transferred', ['認定', '単位認定', '既修得', '既修得認定', '編入認定']],
];

const LOOKUP = new Map<string, GradeOutcome>();
for (const [outcome, labels] of TABLE)
  for (const l of labels) LOOKUP.set(l.normalize('NFKC').toUpperCase(), outcome);

/** Labels the university marks as pending a re-examination (outcome not_graded). */
export function isReexamLabel(label: string | undefined): boolean {
  return /^(再試|追試)/.test((label ?? '').normalize('NFKC').trim());
}

/**
 * Normalized outcome of a raw evaluation label. An empty label means "no evaluation yet":
 * `in_progress` by default (LCU lists registered courses without a mark), or `emptyAs`.
 */
export function classifyGradeLabel(
  label: string | undefined,
  options: { emptyAs?: GradeOutcome } = {},
): GradeOutcome {
  const key = (label ?? '').normalize('NFKC').trim().toUpperCase();
  if (!key) return options.emptyAs ?? 'in_progress';
  return LOOKUP.get(key) ?? 'unknown';
}

/** Outcomes whose credits are earned. */
export function isEarnedOutcome(o: GradeOutcome): boolean {
  return o === 'passed' || o === 'transferred';
}

export function isGradeOutcome(v: unknown): v is GradeOutcome {
  return typeof v === 'string' && (GRADE_OUTCOMES as readonly string[]).includes(v);
}
