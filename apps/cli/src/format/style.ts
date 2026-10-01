export interface Style {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  cyan(s: string): string;
}

/** Colours are used only on a TTY and never when NO_COLOR is set (https://no-color.org). */
export function colorEnabled(isTTY: boolean, env: Record<string, string | undefined>): boolean {
  if (!isTTY) return false;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  return env.TERM !== 'dumb';
}

export function createStyle(enabled: boolean): Style {
  const wrap =
    (open: number, close: number) =>
    (s: string): string =>
      enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s;
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
  };
}
