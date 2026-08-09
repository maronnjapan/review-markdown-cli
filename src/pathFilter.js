/**
 * Glob matching for the `--include` / `--exclude` CLI options.
 *
 * Paths are always the POSIX-style relative path from the review root
 * (`docs/guide/intro.md`). Patterns understand `*`, `**`, `?` and `{a,b}`;
 * everything else is literal. A pattern that matches a directory also matches
 * everything below it, so `--exclude drafts` hides the whole `drafts/` subtree.
 */

/** Never walked into, whatever the caller asks for. */
export const ALWAYS_EXCLUDED = ['**/.git', '**/node_modules', '**/.review'];

export function createPathFilter({ include = [], exclude = [] } = {}) {
  const includePatterns = normalizePatterns(include);
  const excludePatterns = normalizePatterns(exclude);
  const includeMatchers = includePatterns.map(compilePattern);
  const excludeMatchers = [...ALWAYS_EXCLUDED, ...excludePatterns].map(compilePattern);

  return {
    include: includePatterns,
    exclude: excludePatterns,
    /** True when the file should appear in the review UI. */
    matchesFile(relativePath) {
      const segments = toSegments(relativePath);
      if (segments.length === 0) return false;
      if (excludeMatchers.some((matcher) => matcher.matches(segments))) return false;
      return includeMatchers.length === 0 || includeMatchers.some((matcher) => matcher.matches(segments));
    },
    /** True when walking into the directory could still turn up an included file. */
    allowsDirectory(relativeDir) {
      const segments = toSegments(relativeDir);
      if (segments.length === 0) return true;
      if (excludeMatchers.some((matcher) => matcher.matches(segments))) return false;
      return includeMatchers.length === 0 || includeMatchers.some((matcher) => matcher.couldMatchInside(segments));
    }
  };
}

/**
 * Accepts repeated flags and comma separated lists alike, so
 * `--exclude a --exclude b` and `--exclude a,b` mean the same thing.
 */
export function normalizePatterns(patterns) {
  return (Array.isArray(patterns) ? patterns : [patterns])
    .flatMap((pattern) => splitPatternList(String(pattern ?? '')))
    .map(normalizePattern)
    .filter(Boolean);
}

/** Splits on commas, except the ones inside a `{a,b}` alternation. */
function splitPatternList(value) {
  const patterns = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '{') depth += 1;
    else if (character === '}' && depth > 0) depth -= 1;
    if (character === ',' && depth === 0) {
      patterns.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  patterns.push(current);
  return patterns;
}

function normalizePattern(pattern) {
  return String(pattern)
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function toSegments(relativePath) {
  return String(relativePath ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

function compilePattern(pattern) {
  const segments = toSegments(pattern).map((segment) => (
    segment === '**' ? '**' : segmentRegExp(segment)
  ));
  return {
    pattern,
    /** A directory pattern implicitly covers everything below it. */
    matches: (pathSegments) => matchSegments(segments, pathSegments, true),
    couldMatchInside: (dirSegments) => matchSegments(segments, dirSegments, false)
  };
}

/**
 * @param allowTrailingPath when true the path may continue past the pattern
 *   (`drafts` matches `drafts/a.md`); when false the pattern may continue past
 *   the path instead (`docs/**` could still match inside `docs`).
 */
function matchSegments(patternSegments, pathSegments, allowTrailingPath) {
  if (patternSegments.length === 0) return pathSegments.length === 0 || allowTrailingPath;
  if (pathSegments.length === 0) return !allowTrailingPath;

  const [head, ...restPattern] = patternSegments;
  if (head === '**') {
    for (let skipped = 0; skipped <= pathSegments.length; skipped += 1) {
      if (matchSegments(restPattern, pathSegments.slice(skipped), allowTrailingPath)) return true;
    }
    return false;
  }
  if (!head.test(pathSegments[0])) return false;
  return matchSegments(restPattern, pathSegments.slice(1), allowTrailingPath);
}

function segmentRegExp(segment) {
  let source = '';
  let braceDepth = 0;
  for (const character of segment) {
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '{') {
      braceDepth += 1;
      source += '(?:';
    } else if (character === '}' && braceDepth > 0) {
      braceDepth -= 1;
      source += ')';
    } else if (character === ',' && braceDepth > 0) source += '|';
    else source += escapeRegExp(character);
  }
  // An unbalanced `{` is a literal brace, not the start of an alternation.
  return braceDepth === 0 ? new RegExp(`^${source}$`) : new RegExp(`^${literalRegExpSource(segment)}$`);
}

function literalRegExpSource(segment) {
  return [...segment]
    .map((character) => (character === '*' ? '[^/]*' : character === '?' ? '[^/]' : escapeRegExp(character)))
    .join('');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
