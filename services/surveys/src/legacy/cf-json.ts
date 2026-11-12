// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** JSON numbers as the fixture's ACF 2023 on JDK 17 reads them with deserializeJSON and writes them back as text. */

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const SIGNIFICAND_MASK = (1n << 52n) - 1n;
const HIDDEN_BIT = 1n << 52n;
const EXP_ONE = 0x3ff0000000000000n;
// Bit lengths of 5^0..5^26, the table FloatingDecimal sizes its fixed-width arithmetic with.
const N_5_BITS = Array.from({ length: 27 }, (_, i) => (i === 0 ? 0 : (5n ** BigInt(i)).toString(2).length));
// FloatingDecimal's insignificant digits for 2^p, 0 for any other p; p is at most 8 for an integral double below 2^63.
const INSIGNIFICANT_DIGITS = [0, 0, 0, 0, 1, 1, 1, 2, 2];

/** Decimal digits d1d2… and the exponent `e` of 0.d1d2… × 10^e. */
interface DecimalDigits {
  digits: string;
  decExponent: number;
}

const bitsView = new DataView(new ArrayBuffer(8));

function doubleBits(value: number): bigint {
  bitsView.setFloat64(0, value);
  return bitsView.getBigUint64(0);
}

function trailingZeroBits(value: bigint): number {
  let count = 0;
  for (let rest = value; (rest & 1n) === 0n; rest >>= 1n) count += 1;
  return count;
}

/** floor(log10) estimate of the value, as FloatingDecimal.estimateDecExp computes it. */
function estimateDecExp(fractBits: bigint, binExp: number): number {
  bitsView.setBigUint64(0, EXP_ONE | (fractBits & SIGNIFICAND_MASK));
  const d = (bitsView.getFloat64(0) - 1.5) * 0.289529654 + 0.176091259 + binExp * 0.301029995663981;
  return Math.floor(d) | 0;
}

/** Digits of an integral value, the low `insignificant` digits rounded away. */
function longDigits(value: bigint, insignificant: number): DecimalDigits {
  let rest = value;
  if (insignificant > 0) {
    const pow10 = 10n ** BigInt(insignificant);
    const residue = rest % pow10;
    rest /= pow10;
    if (residue >= pow10 >> 1n) rest += 1n;
  }
  const text = rest.toString();
  return { digits: text.replace(/0+$/, ''), decExponent: insignificant + text.length };
}

/** Adds one unit in the last digit; a carry out of the first digit leaves '1' and zeros and raises the exponent. */
function roundUp({ digits, decExponent }: DecimalDigits): DecimalDigits {
  const kept = digits.replace(/9+$/, '');
  if (kept === '') return { digits: `1${'0'.repeat(digits.length - 1)}`, decExponent: decExponent + 1 };
  const last = kept.length - 1;
  return { digits: `${kept.slice(0, last)}${Number(kept[last]) + 1}${'0'.repeat(digits.length - kept.length)}`, decExponent };
}

/** FloatingDecimal.BinaryToASCIIBuffer.dtoa of JDK 17, which is not always the shortest round-trip form. */
function dtoa(binExp: number, fractBits: bigint, nSignificantBits: number): DecimalDigits {
  const tailZeros = trailingZeroBits(fractBits);
  const nFractBits = 53 - tailZeros;
  const nTinyBits = Math.max(0, nFractBits - binExp - 1);
  if (binExp <= 62 && binExp >= -21 && nTinyBits === 0) {
    const value = binExp >= 52 ? fractBits << BigInt(binExp - 52) : fractBits >> BigInt(52 - binExp);
    return longDigits(value, INSIGNIFICANT_DIGITS[binExp - nSignificantBits - 1] ?? 0);
  }
  let decExp = estimateDecExp(fractBits, binExp);
  const B5 = Math.max(0, -decExp);
  const S5 = Math.max(0, decExp);
  let B2 = B5 + nTinyBits + binExp - (nFractBits - 1);
  let S2 = S5 + nTinyBits;
  let M2 = B5 + nTinyBits + binExp - nSignificantBits;
  const common = Math.min(B2, S2);
  B2 -= common;
  S2 -= common;
  M2 -= common + (nFractBits === 1 ? 1 : 0);
  if (M2 < 0) {
    B2 -= M2;
    S2 -= M2;
    M2 = 0;
  }
  const bBits = nFractBits + B2 + (N_5_BITS[B5] ?? B5 * 3);
  const tenSBits = S2 + 1 + (N_5_BITS[S5 + 1] ?? (S5 + 1) * 3);
  // Java's 32-bit branch needs bBits < 32, which no double reaches (bBits > nSignificantBits), so 64 bits is the narrowest.
  const fixed = bBits < 64 && tenSBits < 64;
  const wrap = (v: bigint): bigint => (fixed ? BigInt.asIntN(64, v) : v);
  let b = wrap(((fractBits >> BigInt(tailZeros)) * 5n ** BigInt(B5)) << BigInt(B2));
  const s = (5n ** BigInt(S5)) << BigInt(S2);
  const tenS = s * 10n;
  let m = (5n ** BigInt(B5)) << BigInt(M2);
  let digits = '';
  let low = false;
  let high = false;
  for (let first = true; first || (!low && !high); first = false) {
    const q = b / s;
    b = wrap(10n * (b % s));
    m = wrap(m * 10n);
    if (fixed && !first && m <= 0n) {
      // FloatingDecimal's overflow guard for the 64-bit m.
      low = true;
      high = true;
    } else {
      low = b < m;
      high = fixed ? wrap(b + m) > tenS : b + m >= tenS;
    }
    if (first && q === 0n && !high) {
      decExp -= 1;
    } else {
      digits += q.toString();
    }
    if (first && (decExp < -3 || decExp >= 8)) {
      low = false;
      high = false;
    }
  }
  const result: DecimalDigits = { digits, decExponent: decExp + 1 };
  if (!high) return result;
  if (!low) return roundUp(result);
  const lowDigitDifference = fixed ? wrap((b << 1n) - tenS) : (b << 1n) - tenS;
  const odd = Number(digits[digits.length - 1]) % 2 === 1;
  return lowDigitDifference > 0n || (lowDigitDifference === 0n && odd) ? roundUp(result) : result;
}

/** Double.toString's layout of the digits: plain from 10^-3 up to 10^7, else computerized scientific notation. */
function layout({ digits, decExponent }: DecimalDigits): string {
  if (decExponent > 0 && decExponent < 8) {
    const whole = digits.slice(0, decExponent).padEnd(decExponent, '0');
    return `${whole}.${digits.slice(decExponent) || '0'}`;
  }
  if (decExponent <= 0 && decExponent > -3) return `0.${'0'.repeat(-decExponent)}${digits}`;
  const exponent = decExponent <= 0 ? `-${1 - decExponent}` : `${decExponent - 1}`;
  return `${digits[0] ?? ''}.${digits.slice(1) || '0'}E${exponent}`;
}

/** JDK 17 Double.toString of `value`, e.g. 1.5, 10.0, 1.0E-7, 1.9999999999999998E23. */
export function javaDoubleText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const bits = doubleBits(value);
  let fractBits = bits & SIGNIFICAND_MASK;
  let binExp = Number((bits >> 52n) & 0x7ffn);
  let nSignificantBits = 53;
  if (binExp === 0) {
    const leadingZeros = 64 - fractBits.toString(2).length;
    fractBits <<= BigInt(leadingZeros - 11);
    binExp = 12 - leadingZeros;
    nSignificantBits = 64 - leadingZeros;
  } else {
    fractBits |= HIDDEN_BIT;
  }
  return `${value < 0 ? '-' : ''}${layout(dtoa(binExp - 1023, fractBits, nSignificantBits))}`;
}

/** Text ACF gives a JSON number token: a long verbatim, else its double by Double.toString, an overflowing token as written. */
export function cfNumberTokenText(token: string): string {
  if (/^-?\d+$/.test(token)) {
    const integer = BigInt(token);
    if (integer >= LONG_MIN && integer <= LONG_MAX) return integer.toString();
  }
  const value = Number(token);
  return Number.isFinite(value) ? javaDoubleText(value) : token;
}

/** Text ACF gives an already parsed JSON number, read as a long when integral and in range; the token's own form is unknown here. */
export function cfNumberValueText(value: number): string {
  return Number.isInteger(value) && value >= -(2 ** 63) && value < 2 ** 63 ? BigInt(value).toString() : javaDoubleText(value);
}

/** JSON.parse with every number replaced by the text ACF gives its token; throws SyntaxError for text that is not JSON. */
export function parseCfJsonText(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? (context?.source === undefined ? cfNumberValueText(value) : cfNumberTokenText(context.source)) : value,
  );
}
