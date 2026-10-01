import type { LcuDeployment, TitleCodes } from './types.js';

/**
 * Shizuoka University deployment of LiveCampusU (docs/research/shizuoka.md §1-§3).
 * The `title` search values are year x faculty codes taken from the public search form; a new
 * academic year adds a block (or the user sets `titleCode` on a target / `titles` in config).
 */
const FACULTIES = [
  'LA-S', // 全学教育科目（静岡）
  'LA-H', // 全学教育科目（浜松）
  'HS-B', // 人文社会科学部
  'ED-B', // 教育学部
  'SC-B', // 理学部
  'EN-B', // 工学部
  'AG-B', // 農学部
  'IN-B', // 情報学部
  'GL-B', // グローバル共創科学部
  'RD-B', // 地域創造学環
  'HS-M',
  'ED-M',
  'SC-M',
  'EN-M',
  'AG-M',
  'IN-M',
  'IS-M',
  'MW-M',
  'GT-D',
  'MP-D',
] as const;

function block(codes: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, String(v)]));
}

const TITLES: TitleCodes = {
  '2026': block({
    'LA-S': 2250,
    'LA-H': 2249,
    'HS-B': 2248,
    'ED-B': 2247,
    'SC-B': 2246,
    'EN-B': 2245,
    'AG-B': 2244,
    'IN-B': 2243,
    'GL-B': 2242,
    'RD-B': 2241,
    'HS-M': 2240,
    'ED-M': 2239,
    'ED-D': 2238,
    'SC-M': 2237,
    'EN-M': 2236,
    'AG-M': 2235,
    'IN-M': 2234,
    'IS-M': 2233,
    'MW-M': 2232,
    'GT-D': 2231,
    'MP-D': 2230,
  }),
  '2025': descending(2227, FACULTIES),
  '2024': descending(2207, FACULTIES),
  // 2175 is absent from the public list, so the codes below ED-M skip one number.
  '2023': block({
    'LA-S': 2187,
    'LA-H': 2186,
    'HS-B': 2185,
    'ED-B': 2184,
    'SC-B': 2183,
    'EN-B': 2182,
    'AG-B': 2181,
    'IN-B': 2180,
    'GL-B': 2179,
    'RD-B': 2178,
    'HS-M': 2177,
    'ED-M': 2176,
    'SC-M': 2174,
    'EN-M': 2173,
    'AG-M': 2172,
    'IN-M': 2171,
    'IS-M': 2170,
    'MW-M': 2169,
    'GT-D': 2168,
    'MP-D': 2167,
  }),
  '2022': block({
    'LA-S': 2162,
    'LA-H': 2161,
    'HS-B': 2160,
    'ED-B': 2159,
    'SC-B': 2158,
    'EN-B': 2157,
    'AG-B': 2156,
    'IN-B': 2155,
    'RD-B': 2154,
    'HS-M': 2153,
    'ED-M': 2152,
    'SC-M': 2151,
    'EN-M': 2150,
    'AG-M': 2149,
    'IN-M': 2148,
    'IS-M': 2147,
    'GT-D': 2146,
    'MP-D': 2145,
  }),
};

function descending(first: number, faculties: readonly string[]): Record<string, string> {
  return Object.fromEntries(faculties.map((f, i) => [f, String(first - i)]));
}

export const shizuokaDeployment: LcuDeployment = {
  id: 'shizuoka',
  baseUrl: 'https://gakujo.shizuoka.ac.jp/lcu-web/',
  screens: {
    syllabusSearch: 'SC_06001B00_21',
    syllabusDetail: 'SC_06001B00_22',
    publicCancellations: 'SC_90002szu_01',
  },
  titles: TITLES,
};
