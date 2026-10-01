/**
 * Query router (§15): classify a natural-language question into a search strategy.
 * 「明日締切」→ structured, 「ERモデルの説明どこ？」→ lexical(+semantic), 「先生は試験について何て言った？」→ transcript.
 */
export type QueryRoute = 'structured' | 'lexical' | 'transcript';
export type StructuredIntent =
  'deadlines' | 'classes' | 'exams' | 'changes' | 'conflicts' | 'announcements';
export type RelativeRange =
  'today' | 'tomorrow' | 'yesterday' | 'this_week' | 'next_week' | 'upcoming';

export interface RoutedQuery {
  route: QueryRoute;
  intent: StructuredIntent | undefined;
  range: RelativeRange | undefined;
  /** Search terms with question words/particles removed. */
  terms: string[];
  /** Whether semantic search should be blended in (when an embedding provider exists). */
  semantic: boolean;
  original: string;
}

const RANGE_PATTERNS: [RegExp, RelativeRange][] = [
  [/今日|本日|きょう|today/i, 'today'],
  [/明日|あした|tomorrow/i, 'tomorrow'],
  [/昨日|きのう|yesterday/i, 'yesterday'],
  [/来週|next week/i, 'next_week'],
  [/今週|this week/i, 'this_week'],
];

const INTENT_PATTERNS: [RegExp, StructuredIntent][] = [
  [/締切|締め切り|〆切|期限|提出|課題|deadline|\bdue\b|assignment/i, 'deadlines'],
  [/試験|テスト|exam|quiz/i, 'exams'],
  [/授業|時間割|講義|コマ|教室|class|lecture|schedule/i, 'classes'],
  [/変更|変わった|更新|change/i, 'changes'],
  [/競合|矛盾|食い違|conflict/i, 'conflicts'],
  [/お知らせ|連絡|announcement/i, 'announcements'],
];

const TRANSCRIPT_PATTERN =
  /(先生|教員|教授|講師|professor|instructor|teacher).*(言った|言って|話した|話して|説明した|触れ|say|said|mention)|(授業中|講義中|録音|文字起こし|transcript)/i;
const LOOKUP_PATTERN =
  /(どこ|どれ|説明|について|とは|って何|意味|資料|スライド|where|explain|what is)/i;

const STOP =
  /(について|とは|って|何て|なんて|なに|何|どこ|どれ|教えて|ください|説明|言った|言って|話した|話して|触れた|先生|教員|教授|講師|ありますか|ある|でしたか|ですか|[はがをにでとのへも](?=\s|$)|[?？!！。、,.])/g;

/** Split a question into search terms (particles and question words removed). */
export function extractTerms(q: string): string[] {
  const cleaned = q.normalize('NFKC').replace(STOP, ' ');
  return cleaned
    .split(
      /\s+|(?<=[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9])[のはがをにで](?=[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9])/u,
    )
    .map((t) => t.trim().replace(/^[はがをにでとのへも]+|[はがをにでとのへも]+$/g, ''))
    .filter((t) => t.length >= 2 || /[\p{Script=Han}]/u.test(t))
    .filter((t, i, a) => a.indexOf(t) === i);
}

export function routeQuery(q: string): RoutedQuery {
  const original = q.trim();
  const range = RANGE_PATTERNS.find(([re]) => re.test(original))?.[1];
  const terms = extractTerms(original);
  if (TRANSCRIPT_PATTERN.test(original)) {
    return { route: 'transcript', intent: undefined, range, terms, semantic: true, original };
  }
  const intent = INTENT_PATTERNS.find(([re]) => re.test(original))?.[1];
  // A time window or a short intent-only question is a structured lookup; "どこ/説明" questions are content lookups.
  if (intent && (range || (!LOOKUP_PATTERN.test(original) && original.length <= 12))) {
    return {
      route: 'structured',
      intent,
      range: range ?? 'upcoming',
      terms,
      semantic: false,
      original,
    };
  }
  return { route: 'lexical', intent: undefined, range, terms, semantic: true, original };
}
