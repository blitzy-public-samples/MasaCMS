// CFML loose comparison as ACF evaluates `eq` and `neq` between simple values.

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOLEAN_WORD = /^(?:true|false|yes|no)$/i;

/** Java `String.trim()`, which ACF applies before numeric parsing: strips every char <= U+0020. */
function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end -= 1;
  return s.slice(start, end);
}

/** The operand's numeric value when CFML `eq` compares it as a number. */
function numericOperand(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = javaTrim(v);
  // ACF compares '1.' eq '1' as text (false), so a trailing dot keeps the operand textual.
  if (!DECIMAL.test(t) || t.endsWith('.')) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** 1 or 0 for a boolean or a Java-trimmed `true|false|yes|no` word, else undefined. */
function booleanOperand(v: unknown): number | undefined {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return undefined;
  const word = javaTrim(v).toLowerCase();
  if (!BOOLEAN_WORD.test(word)) return undefined;
  return word === 'true' || word === 'yes' ? 1 : 0;
}

/**
 * CFML loose `eq`: when each side is numeric or a boolean word, their values as numbers with booleans as 1/0
 * (ACF: `'yes' eq 'true'`, `' no' eq '0'`); otherwise case-insensitive text.
 */
export function cfEq(a: unknown, b: unknown): boolean {
  const x = numericOperand(a) ?? booleanOperand(a);
  const y = numericOperand(b) ?? booleanOperand(b);
  if (x !== undefined && y !== undefined) return x === y;
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/** ACF's `rc.compactDisplay eq 'true'` (untrimmed for `true`, unlike {@link cfEq}); absent is legacy's default `'false'`. */
export function isCompactDisplay(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return numericOperand(value) === 1 || javaTrim(value).toLowerCase() === 'yes' || value.toLowerCase() === 'true';
}
