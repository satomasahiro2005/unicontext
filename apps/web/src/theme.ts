export type ThemePreference = 'auto' | 'light' | 'dark';

const KEY = 'unicontext.theme';

export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'auto', label: '自動' },
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
];

export function readTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function saveTheme(pref: ThemePreference): void {
  try {
    if (pref === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // storage unavailable: the choice only lasts for this page view
  }
  applyTheme(pref);
}
