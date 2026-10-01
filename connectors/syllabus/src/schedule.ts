const DAYS: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

/**
 * 「木3・4」→ dayOfWeek 4, 90-minute period 2. LCU prints 45-minute units in pairs
 * (1・2, 3・4 ... 13・14); the pair index (1..7) is the period number used by every UniContext
 * LCU-related connector, the printed text is kept as `rawPeriod`.
 */
export function parseDayPeriod(
  text: string,
): { dayOfWeek: number; period: number; rawPeriod: string }[] {
  const out: { dayOfWeek: number; period: number; rawPeriod: string }[] = [];
  const re = /([日月火水木金土])\s*(\d{1,2})(?:\s*[・･]\s*(\d{1,2}))?/g;
  const normalized = text.normalize('NFKC');
  for (const m of normalized.matchAll(re)) {
    const day = DAYS[m[1] ?? ''];
    const first = Number(m[2]);
    if (day === undefined || !Number.isFinite(first) || first < 1) continue;
    out.push({
      dayOfWeek: day,
      period: Math.ceil(first / 2),
      rawPeriod: m[3] ? `${m[2]}・${m[3]}` : `${m[2]}`,
    });
  }
  return out;
}
