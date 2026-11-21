// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/

/** Decimal places of every finance amount, as numeric(19,4) stores it. */
export const MONEY_SCALE = 4;

/** A finance amount as an integer scaled by 10^4. */
export type Money = bigint;

/** Why an amount was rejected: not amount text at all, or more than 15 integer digits. */
export type MoneyRejectReason = 'format' | 'range';

/** Result of parsing a request amount. */
export type MoneyParseResult = { ok: true; value: Money } | { ok: false; reason: MoneyRejectReason };

const MAX_INTEGER_DIGITS = 15;
// Without the m flag `$` matches only at end of input, as in finance.cfc's reFind, so U+0085, U+2028 and U+2029 stay rejected.
const AMOUNT_TEXT = /^(-?)([0-9]+)(?:\.([0-9]{1,4}))?$/;
const NUMERIC_TEXT = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

/** Parses a request amount string into Money as the finance fixture accepts it; any non-string is a format rejection. */
export function parseMoney(input: unknown): MoneyParseResult {
  const match = typeof input === 'string' ? AMOUNT_TEXT.exec(cfTrim(input)) : null;
  if (match === null) return { ok: false, reason: 'format' };
  const [, sign = '', integer = '', fraction = ''] = match;
  if (integer.length > MAX_INTEGER_DIGITS) return { ok: false, reason: 'range' };
  return { ok: true, value: scaled(sign, integer, fraction) };
}

/** Reads PostgreSQL numeric text into Money; throws RangeError for text that is not an exact scale-4 decimal. */
export function moneyFromNumeric(text: string): Money {
  const match = NUMERIC_TEXT.exec(text);
  if (match === null) throw new RangeError(`not numeric text: ${JSON.stringify(text)}`);
  const [, sign = '', integer = '', fraction = ''] = match;
  if (/[^0]/.test(fraction.slice(MONEY_SCALE))) throw new RangeError(`numeric text exceeds scale 4: ${JSON.stringify(text)}`);
  return scaled(sign, integer, fraction.slice(0, MONEY_SCALE));
}

/** Formats Money as numeric(19,4) text: four decimals, no grouping, a leading '-' only for negatives. */
export function formatMoney(value: Money): string {
  const digits = (value < 0n ? -value : value).toString().padStart(MONEY_SCALE + 1, '0');
  const point = digits.length - MONEY_SCALE;
  return `${value < 0n ? '-' : ''}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Exact sum of Money values; 0n for none. */
export function sumMoney(values: Iterable<Money>): Money {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/** Money from decimal text parts holding at most four fraction digits. */
function scaled(sign: string, integer: string, fraction: string): Money {
  const magnitude = BigInt(integer + fraction.padEnd(MONEY_SCALE, '0'));
  return sign === '-' ? -magnitude : magnitude;
}

/** Text without leading and trailing U+0000 to U+0020, as ColdFusion trim() strips them, unlike String.prototype.trim. */
function cfTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return text.slice(start, end);
}
