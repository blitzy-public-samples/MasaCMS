// CFML loose comparison as ACF evaluates `eq` and `neq` between simple values; the admin scan of `compactDisplay`.
import { cfEq as cfTextEq, cfIsBoolean, cfIsNumeric, javaTrim } from '@opt2/platform/legacy-compat';

/** A JSON boolean literal; the scan re-serializes a padded one as `"YES"` or `"NO"`, which is no boolean. */
const JSON_BOOLEAN = /^(?:true|false)$/;

/** A simple operand as CFML text; null and undefined read as ''. */
const operandText = (v: unknown): string => String(v ?? '');

/**
 * CFML loose `eq` on the operands as given, unscanned: when each side reads as a number or a boolean word, their values
 * as numbers with booleans as 1/0 (ACF: `'yes' eq 'true'`, `' no' eq '0'`); otherwise case-insensitive text.
 */
export function cfEq(a: unknown, b: unknown): boolean {
  return cfTextEq(operandText(a), operandText(b));
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
