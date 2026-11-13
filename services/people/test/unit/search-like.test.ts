/** search.ts likeMatcher held to the anchored, case-insensitive regex the LIKE pattern used to compile to and to bounded time on wildcard chains, and likePrefilter to matching every value it matches. */
import { describe, expect, it } from 'vitest';
import { likeMatcher, likePrefilter } from '../../src/domain/search.js';
import { ilikeC } from '../helpers/search-doubles.js';

/** The former LIKE-to-regex construction, the reference the matcher must agree with on every input. */
function regexOracle(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    const close = char === '[' ? pattern.indexOf(']', i + 1) : -1;
    if (char === '%') {
      source += '[\\s\\S]*';
    } else if (char === '_') {
      source += '[\\s\\S]';
    } else if (close !== -1) {
      const body = pattern.slice(i + 1, close);
      const negated = body.startsWith('^');
      source += `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, '\\$&')}]`;
      i = close;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

const PATTERNS = [
  '', '%', '%%', '%%%', '_', '__', 'a_c', 'a%', '%a', '%a%', 'abc', 'ABC', 'a%c', '%b%r%', '%a%b%c%', '%_%_%',
  '[a-c]', '[^a-c]', '[]', '[^]', '[]]', '[^]]', '[abc', 'x[abc', '[a]b]', '[[a]', '[a-c]%', '%[^a-c]_',
  '[\\]', '[a\\b]', '[^^]', '[a^]', '[-a]', '[a-]', '[É]', '[é-ë]', '[^é]', '[ſ]', '[k]', '[^i]',
  '.*+?^${}()|\\/', '.', '*', 'a+', '(a)', 'a|b', '{1}', '$', '^', '\\', '\\%', '\\_', '/',
  'é', 'É', 'ß', 'SS', 'ẞ', 'ı', 'I', 'i', 'İ', 'ſ', 's', 'S', '\u212a', 'k', 'µ', 'μ', 'Σ', 'ς', 'σ',
  'a\nb', '%\n%', '_\n_', 'a ', 'a  ', ' %', '😀', '_😀',
];

const VALUES = [
  '', 'a', 'A', 'b', 'abc', 'ABC', 'aBc', 'abcd', 'xabc', 'a c', 'a\nc', '\n', 'a\nb', 'a ', 'a  ', ' a',
  ']', '[', '[abc', 'x[abc', '[]', 'a]', 'ab]', '^', '\\', '-', '\\%', '\\_', '/',
  'é', 'É', 'ê', 'ë', 'e', 'ß', 'SS', 'ss', 'ẞ', 'ı', 'I', 'i', 'İ', 'ſ', 's', 'S', '\u212a', 'k', 'K',
  'µ', 'μ', 'Μ', 'Σ', 'ς', 'σ', '.*+?^${}()|\\/', '.', '*', 'aa', '(a)', 'a|b', '{1}', '$', '%', '_',
  '😀', 'x😀', '\ud83d', 'Baker', 'baker', 'BRAVO', 'abcabcabc', 'aXbXc',
];

/** Every UTF-16 code unit as a one-unit string. */
const CODE_UNITS = Array.from({ length: 0x10000 }, (_unused, unit) => String.fromCharCode(unit));

describe('likeMatcher', () => {
  it.each(PATTERNS)('agrees with the regex construction on %j', (pattern) => {
    const matcher = likeMatcher(pattern);
    const oracle = regexOracle(pattern);
    expect(VALUES.map((value) => [value, matcher.test(value)])).toEqual(VALUES.map((value) => [value, oracle.test(value)]));
  });

  it.each(['i', 'S', 'ſ', 'k', 'µ', 'ß', 'é', '_', '%', '[a-z]', '[^a-z]', '[^]', '[]', '[é]'])(
    'agrees with the regex construction for %j on every code unit',
    (pattern) => {
      const matcher = likeMatcher(pattern);
      const oracle = regexOracle(pattern);
      expect(CODE_UNITS.filter((unit) => matcher.test(unit) !== oracle.test(unit))).toEqual([]);
    },
  );

  it.each(['[z-a]', '%[a-^]%', '[^z-a]'])('throws the regex SyntaxError for the reversed class range %j', (pattern) => {
    expect(() => regexOracle(pattern)).toThrow(SyntaxError);
    expect(() => likeMatcher(pattern)).toThrow(SyntaxError);
  });

  const nineRuns = 'a%a%a%a%a%a%a%a%a%b';
  const thirtyRuns = `${'a%'.repeat(30)}b`;
  it.each<[string, string, string, boolean]>([
    ['a nine-% chain against 5000 a', nineRuns, 'a'.repeat(5000), false],
    ['a nine-% chain against 255 a', nineRuns, 'a'.repeat(255), false],
    ['a 30-% chain against 5000 a', thirtyRuns, 'a'.repeat(5000), false],
    ['a 30-% chain against 255 a', thirtyRuns, 'a'.repeat(255), false],
    ['the getSearch-wrapped nine-% chain against 5000 a', `%${nineRuns}%`, 'a'.repeat(5000), false],
    ['a 30-unit literal run between % against 5000 a', `%${'a'.repeat(30)}b%`, 'a'.repeat(5000), false],
    ['a nine-% chain against 5000 a and a b', nineRuns, `${'A'.repeat(5000)}b`, true],
    ['a 30-% chain against 254 a and a b', thirtyRuns, `${'a'.repeat(254)}B`, true],
  ])('answers %s within 200 ms', (_label, pattern, value, expected) => {
    const started = performance.now();
    expect(likeMatcher(pattern).test(value)).toBe(expected);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('likePrefilter', () => {
  it.each<[string, string]>([
    ['%smith%', '%smith%'],
    ['%Sm_th%', '%Sm%th%'],
    ['%Sm[iy]th%', '%Sm%th%'],
    ['%[^a-c]x%', '%x%'],
    ['%Müller%', '%M%ller%'],
    ['%%%a%%b__%', '%a%b%'],
    ['%[abc%', '%[abc%'],
    ['%a\\b]%', '%a\\b]%'],
    ['%é😀ß%', '%'],
    ['%', '%'],
    ['', ''],
    ['abc', 'abc'],
  ])('reduces %j to %j', (pattern, expected) => {
    expect(likePrefilter(pattern)).toBe(expected);
  });

  it('matches every code unit when it keeps no literal', () => {
    const any = ilikeC('%');
    expect(CODE_UNITS.filter((unit) => !any(unit))).toEqual([]);
  });

  it('matches every one-unit value likeMatcher matches, for every one-unit search term', () => {
    const missed: [string, string][] = [];
    for (const term of CODE_UNITS) {
      const pattern = `%${term}%`;
      const prefilter = likePrefilter(pattern);
      if (prefilter === '%') continue;
      const matcher = likeMatcher(pattern);
      const prefiltered = ilikeC(prefilter);
      for (const value of CODE_UNITS) {
        if (matcher.test(value) && !prefiltered(value)) missed.push([term, value]);
      }
    }
    expect(missed).toEqual([]);
  });

  /** A seeded generator of uniform numbers in [0, 1). */
  function seeded(seed: number): () => number {
    let state = seed;
    return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  }
  const PATTERN_UNITS = [...'%%__[]^-abcSsKkIi09 .\\', 'é', 'É', 'ß', 'ſ', '\u212a', 'ı', 'İ', 'µ', 'Σ', 'ς', '\ud83d', '\ude00', '中'];
  /** Units a literal may meet in a matching value: its case variants and its non-ASCII look-alikes. */
  const VARIANTS: Readonly<Record<string, string[]>> = { s: ['S', 'ſ'], k: ['K', '\u212a'], i: ['I', 'ı', 'İ'], é: ['É'], ß: ['ẞ', 'SS'], σ: ['Σ', 'ς'] };

  it('matches every value likeMatcher matches over seeded random patterns and values', () => {
    const next = seeded(20260630);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const unit = (): string => pick([...PATTERN_UNITS.filter((char) => char !== '%' && char !== '_'), 'x', 'Y', '😀']);
    let matched = 0;
    const missed: [string, string][] = [];
    for (let round = 0; round < 3000; round += 1) {
      const pattern = `%${Array.from({ length: 1 + Math.floor(next() * 8) }, () => pick(PATTERN_UNITS)).join('')}%`;
      let matcher: { test(value: string): boolean };
      try {
        matcher = likeMatcher(pattern);
      } catch {
        // A reversed class range is the SyntaxError getSearch answers before any prefilter.
        continue;
      }
      const prefilter = likePrefilter(pattern);
      const prefiltered = ilikeC(prefilter);
      for (let sample = 0; sample < 20; sample += 1) {
        // Half the values instantiate the pattern, so many of them match.
        const value =
          sample % 2 === 0
            ? [...pattern]
                .map((char) => {
                  if (char === '%') return Array.from({ length: Math.floor(next() * 3) }, unit).join('');
                  const variants = VARIANTS[char.toLowerCase()];
                  if (variants !== undefined && next() < 0.5) return pick(variants);
                  return next() < 0.3 ? unit() : next() < 0.5 ? char.toUpperCase() : char;
                })
                .join('')
            : Array.from({ length: Math.floor(next() * 10) }, unit).join('');
        if (!matcher.test(value)) continue;
        // Only a prefilter that keeps a literal can miss a value.
        if (prefilter !== '%') matched += 1;
        if (!prefiltered(value)) missed.push([pattern, value]);
      }
    }
    expect(missed).toEqual([]);
    expect(matched).toBeGreaterThan(5000);
  });
});
