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
const AMOUNT_TEXT = /^(-?)([0-9]+)(?:\.([0-9]{1,4}))?$/;
const NUMERIC_TEXT = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;
// ACF prints a non-integral double with 12 significant digits, in E notation outside these decimal exponents.
const SIGNIFICANT_DIGITS = 12;
const MIN_FIXED_EXPONENT = -4;
const MAX_FIXED_EXPONENT = 11;

/** Parses a request amount (string, or JSON number) into Money, accepting exactly what the finance fixture stores. */
export function parseMoney(input: unknown): MoneyParseResult {
  const text = typeof input === 'string' ? input : typeof input === 'number' ? cfNumberText(input) : undefined;
  const match = text === undefined ? null : AMOUNT_TEXT.exec(text);
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
  return fixedText(value, MONEY_SCALE);
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

/** Text of an integer scaled by 10^decimals, with exactly that many fraction digits. */
function fixedText(value: bigint, decimals: number): string {
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, '0');
  const point = digits.length - decimals;
  const fraction = decimals > 0 ? `.${digits.slice(point)}` : '';
  return `${value < 0n ? '-' : ''}${digits.slice(0, point)}${fraction}`;
}

/** A JSON number as ACF's toString renders it after deserializeJSON; undefined where that is E notation or not finite. */
function cfNumberText(n: number): string | undefined {
  if (!Number.isFinite(n)) return undefined;
  // ACF reads JSON integer literals as Integer/Long and prints them verbatim. JSON.parse cannot tell 1e12 (an ACF
  // Double, printed 1E+012) from 1000000000000, so every integral number takes the integer-literal form.
  if (Number.isInteger(n)) return BigInt(n).toString();
  const exponent = Number(n.toExponential().split('e')[1]);
  if (exponent < MIN_FIXED_EXPONENT || exponent > MAX_FIXED_EXPONENT) return undefined;
  const decimals = SIGNIFICANT_DIGITS - 1 - exponent;
  const text = fixedText(scaleHalfEven(n, decimals), decimals);
  return decimals > 0 ? text.replace(/\.?0+$/, '') : text;
}

/** n × 10^decimals rounded half to even on n's exact binary value, as ACF rounds when printing a double. */
function scaleHalfEven(n: number, decimals: number): bigint {
  let mantissa = Math.abs(n);
  let shift = 0n;
  while (!Number.isInteger(mantissa)) {
    mantissa *= 2;
    shift += 1n;
  }
  const numerator = BigInt(mantissa) * 10n ** BigInt(decimals);
  const denominator = 1n << shift;
  const quotient = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  const roundUp = twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n === 1n);
  const rounded = roundUp ? quotient + 1n : quotient;
  return n < 0 ? -rounded : rounded;
}
