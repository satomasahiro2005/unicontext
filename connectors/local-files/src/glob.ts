/* Minimal glob support: star (no slash), double star (any depth), question mark. Case-insensitive. */

function escapeRe(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        i++;
        if (pattern.charAt(i + 1) === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, 'i');
}

export interface CompiledPattern {
  re: RegExp;
  /** True when the pattern has a slash and is matched against the relative path. */
  anchored: boolean;
}

export function compileGlobs(patterns: readonly string[]): CompiledPattern[] {
  return patterns
    .map((p) => p.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .map((p) => {
      const anchored = p.includes('/');
      return {
        re: globToRegExp(anchored ? p.replace(/^\.?\//, '').replace(/\/$/, '') : p),
        anchored,
      };
    });
}

/**
 * Exclude semantics (gitignore-like): a slashless pattern matches any path segment, a pattern with
 * a slash matches the relative path or any parent folder of it.
 */
export function matchesExclude(relPath: string, patterns: readonly CompiledPattern[]): boolean {
  if (patterns.length === 0) return false;
  const segments = relPath.split('/');
  for (const p of patterns) {
    if (p.anchored) {
      for (let i = 1; i <= segments.length; i++)
        if (p.re.test(segments.slice(0, i).join('/'))) return true;
    } else if (segments.some((s) => p.re.test(s))) return true;
  }
  return false;
}

/** Include semantics: a slashless pattern matches the file name, others the relative path. */
export function matchesInclude(relPath: string, patterns: readonly CompiledPattern[]): boolean {
  if (patterns.length === 0) return true;
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  return patterns.some((p) => p.re.test(p.anchored ? relPath : name));
}
