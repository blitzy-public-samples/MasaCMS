// CFML loose comparison as ACF evaluates `eq` and `neq` between simple values; the admin scan of `compactDisplay`.
import { cfIsBoolean, cfIsNumeric } from '@opt2/platform/legacy-compat';

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOLEAN_WORD = /^(?:true|false|yes|no)$/i;
/** A JSON boolean literal; the scan re-serializes a padded one as `"YES"` or `"NO"`, which is no boolean. */
const JSON_BOOLEAN = /^(?:true|false)$/;

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
 * CFML loose `eq` on the operands as given, unscanned: when each side is numeric or a boolean word, their values as
 * numbers with booleans as 1/0 (ACF: `'yes' eq 'true'`, `' no' eq '0'`); otherwise case-insensitive text.
 */
export function cfEq(a: unknown, b: unknown): boolean {
  const x = numericOperand(a) ?? booleanOperand(a);
  const y = numericOperand(b) ?? booleanOperand(b);
  if (x !== undefined && y !== undefined) return x === y;
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/**
 * A raw `compactDisplay` request value as admin start-up's Portcullis scan leaves it in rc
 * (admin/Application.cfc:246-265, core/mura/Portcullis.cfc:113-192,373-400): NUL dropped, a numeric or boolean value
 * trimmed, a padded JSON boolean (ACF reads every char <= U+0020 as JSON whitespace) re-serialized, the rest trimmed.
 * Idempotent. Exact for every boolean reading; the tag, word, smart-quote and JSON-container rewrites, which never
 * yield a boolean, are not modelled.
 */
export function scanCompactDisplay(value: string): string {
  const text = value.replace(/\0/g, '');
  const trimmed = javaTrim(text);
  if (cfIsBoolean(text) || cfIsNumeric(text)) return trimmed;
  if (JSON_BOOLEAN.test(trimmed)) return trimmed === 'true' ? '"YES"' : '"NO"';
  return trimmed;
}

/** ACF's `rc.compactDisplay eq 'true'` on a raw or scanned request value; absent is legacy's `'false'`. */
export function isCompactDisplay(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && cfEq(scanCompactDisplay(value), 'true');
}
