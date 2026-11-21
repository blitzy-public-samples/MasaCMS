// Java 8-18 Double.toString (FloatingDecimal.BinaryToASCIIBuffer), which ACF 2023 on Java 17 prints JSON doubles with.

const EXP_SHIFT = 52;
const EXP_BIAS = 1023;
const FRACT_HOB = 1n << 52n;
const SIGNIF_BIT_MASK = FRACT_HOB - 1n;
const MAX_SMALL_BIN_EXP = 62;
const MIN_SMALL_BIN_EXP = -21;

/** FDBigInteger.SMALL_5_POW and LONG_5_POW. */
const SMALL_5_POW: readonly bigint[] = Array.from({ length: 14 }, (_, i) => 5n ** BigInt(i));
const LONG_5_POW: readonly bigint[] = Array.from({ length: 27 }, (_, i) => 5n ** BigInt(i));

/** Bits needed to hold 5^i. */
const N_5_BITS: readonly number[] = [
  0, 3, 5, 7, 10, 12, 14, 17, 19, 21, 24, 26, 28, 31, 33, 35, 38, 40, 42, 45, 47, 49, 52, 54, 56, 59, 61,
];

/** Decimal digits of 2^i that carry no significance in a 53-bit value. */
const INSIGNIFICANT_DIGITS: readonly number[] = [
  0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 11,
  11, 11, 12, 12, 12, 12, 13, 13, 13, 14, 14, 14, 15, 15, 15, 15, 16, 16, 16, 17, 17, 17, 18, 18, 18, 19,
];

function insignificantDigitsForPow2(p2: number): number {
  return p2 > 1 && p2 < INSIGNIFICANT_DIGITS.length ? (INSIGNIFICANT_DIGITS[p2] as number) : 0;
}

/** Decimal digits and exponent: the value is 0.<digits> * 10^decExponent. */
interface Decimal {
  digits: number[];
  decExponent: number;
}

const int32 = (n: bigint): bigint => BigInt.asIntN(32, n);
const int64 = (n: bigint): bigint => BigInt.asIntN(64, n);

function trailingZeros(n: bigint): number {
  let count = 0;
  while ((n & 1n) === 0n) {
    n >>= 1n;
    count += 1;
  }
  return count;
}

/** floor of the first-order log10 estimate (estimateDecExp). */
function estimateDecExp(fractBits: bigint, binExp: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, 0x3ff0000000000000n | (fractBits & SIGNIF_BIT_MASK));
  const d2 = view.getFloat64(0);
  return Math.floor((d2 - 1.5) * 0.289529654 + 0.176091259 + binExp * 0.301029995663981);
}

/** Digits of an exactly integral value, rounding away `insignificant` low-order digits (developLongDigits). */
function developLongDigits(lvalue: bigint, insignificant: number): Decimal {
  let decExponent = 0;
  if (insignificant !== 0) {
    const pow10 = (LONG_5_POW[insignificant] as bigint) << BigInt(insignificant);
    const residue = lvalue % pow10;
    lvalue /= pow10;
    decExponent += insignificant;
    if (residue >= pow10 >> 1n) lvalue += 1n;
  }
  let c = lvalue % 10n;
  lvalue /= 10n;
  while (c === 0n) {
    decExponent += 1;
    c = lvalue % 10n;
    lvalue /= 10n;
  }
  const reversed: number[] = [];
  while (lvalue !== 0n) {
    reversed.push(Number(c));
    decExponent += 1;
    c = lvalue % 10n;
    lvalue /= 10n;
  }
  reversed.push(Number(c));
  return { digits: reversed.reverse(), decExponent: decExponent + 1 };
}

/** Increments the last digit, carrying (roundup). */
function roundup(decimal: Decimal): void {
  const { digits } = decimal;
  let i = digits.length - 1;
  let q = digits[i] as number;
  if (q === 9) {
    while (q === 9 && i > 0) {
      digits[i] = 0;
      i -= 1;
      q = digits[i] as number;
    }
    if (q === 9) {
      decimal.decExponent += 1;
      digits[0] = 1;
      return;
    }
  }
  digits[i] = q + 1;
}

/** One digit-generation loop of dtoa over integers wrapped to `wrap` bits; the arbitrary-precision path passes no wrap. */
function generate(
  b: bigint,
  s: bigint,
  m: bigint,
  decExp: number,
  wrap: ((n: bigint) => bigint) | null,
): { digits: number[]; decExp: number; low: boolean; high: boolean; lowDigitDifference: bigint } {
  const w = wrap ?? ((n: bigint): bigint => n);
  const tens = w(s * 10n);
  const digits: number[] = [];
  // The fixed-width paths keep m unscaled until the first quotient; the exact path starts with 10*m and compares with >=.
  const reachesHigh = (bm: bigint): boolean => (wrap === null ? bm >= tens : bm > tens);
  let q = b / s;
  b = w(10n * (b % s));
  m = w(m * 10n);
  let low = b < m;
  let high = reachesHigh(w(b + m));
  if (q === 0n && !high) decExp -= 1;
  else digits.push(Number(q));
  // Java requires a digit after the point, so the E-form keeps generating.
  if (decExp < -3 || decExp >= 8) {
    high = false;
    low = false;
  }
  while (!low && !high) {
    q = b / s;
    b = w(10n * (b % s));
    m = w(m * 10n);
    if (wrap === null || m > 0n) {
      low = b < m;
      high = reachesHigh(w(b + m));
    } else {
      // An overflowed m exceeds any b, as in Java.
      low = true;
      high = true;
    }
    digits.push(Number(q));
  }
  let lowDigitDifference: bigint;
  if (wrap !== null) lowDigitDifference = w((b << 1n) - tens);
  else if (high && low) lowDigitDifference = (b << 1n) - tens;
  else lowDigitDifference = 0n;
  return { digits, decExp, low, high, lowDigitDifference };
}

/** Shortest-by-Steele-White digits of a positive finite double as Java 8-18 picks them (dtoa). */
function dtoa(binExp: number, fractBits: bigint, nSignificantBits: number): Decimal {
  const tailZeros = trailingZeros(fractBits);
  const nFractBits = EXP_SHIFT + 1 - tailZeros;
  const nTinyBits = Math.max(0, nFractBits - binExp - 1);
  if (
    binExp <= MAX_SMALL_BIN_EXP &&
    binExp >= MIN_SMALL_BIN_EXP &&
    nTinyBits < LONG_5_POW.length &&
    nFractBits + (N_5_BITS[nTinyBits] as number) < 64 &&
    nTinyBits === 0
  ) {
    const insignificant = binExp > nSignificantBits ? insignificantDigitsForPow2(binExp - nSignificantBits - 1) : 0;
    const lvalue = binExp >= EXP_SHIFT ? fractBits << BigInt(binExp - EXP_SHIFT) : fractBits >> BigInt(EXP_SHIFT - binExp);
    return developLongDigits(lvalue, insignificant);
  }
  const decExp = estimateDecExp(fractBits, binExp);
  const B5 = Math.max(0, -decExp);
  let B2 = B5 + nTinyBits + binExp;
  const S5 = Math.max(0, decExp);
  let S2 = S5 + nTinyBits;
  const M5 = B5;
  let M2 = B2 - nSignificantBits;
  const fract = fractBits >> BigInt(tailZeros);
  B2 -= nFractBits - 1;
  const common2factor = Math.min(B2, S2);
  B2 -= common2factor;
  S2 -= common2factor;
  M2 -= common2factor;
  // At an exact power of two the next lower double is half as far away.
  if (nFractBits === 1) M2 -= 1;
  if (M2 < 0) {
    B2 -= M2;
    S2 -= M2;
    M2 = 0;
  }
  const bBits = nFractBits + B2 + (B5 < N_5_BITS.length ? (N_5_BITS[B5] as number) : B5 * 3);
  const tenSBits = S2 + 1 + (S5 + 1 < N_5_BITS.length ? (N_5_BITS[S5 + 1] as number) : (S5 + 1) * 3);
  let result: ReturnType<typeof generate>;
  if (bBits < 64 && tenSBits < 64) {
    const small = bBits < 32 && tenSBits < 32;
    const pow5 = small ? SMALL_5_POW : LONG_5_POW;
    const w = small ? int32 : int64;
    const b = w(w((small ? int32(fract) : fract) * (pow5[B5] as bigint)) << BigInt(B2));
    const s = w((pow5[S5] as bigint) << BigInt(S2));
    const m = w((pow5[M5] as bigint) << BigInt(M2));
    result = generate(b, s, m, decExp, w);
  } else {
    const s = 5n ** BigInt(S5) << BigInt(S2);
    const b = (fract * 5n ** BigInt(B5)) << BigInt(B2);
    const m = 5n ** BigInt(M5) << BigInt(M2);
    result = generate(b, s, m, decExp, null);
  }
  const decimal: Decimal = { digits: result.digits, decExponent: result.decExp + 1 };
  const { high, low, lowDigitDifference } = result;
  if (high) {
    if (!low) roundup(decimal);
    else if (lowDigitDifference > 0n) roundup(decimal);
    else if (lowDigitDifference === 0n && ((decimal.digits.at(-1) as number) & 1) !== 0) roundup(decimal);
  }
  return decimal;
}

/** Java's plain or computerized-scientific layout of the digits (getChars). */
function layout({ digits, decExponent }: Decimal): string {
  const text = digits.join('');
  if (decExponent > 0 && decExponent < 8) {
    const whole = Math.min(digits.length, decExponent);
    if (whole < decExponent) return `${text}${'0'.repeat(decExponent - whole)}.0`;
    return `${text.slice(0, whole)}.${whole < digits.length ? text.slice(whole) : '0'}`;
  }
  if (decExponent <= 0 && decExponent > -3) return `0.${'0'.repeat(-decExponent)}${text}`;
  const exponent = decExponent <= 0 ? `-${String(-decExponent + 1)}` : String(decExponent - 1);
  return `${text.charAt(0)}.${digits.length > 1 ? text.slice(1) : '0'}E${exponent}`;
}

/** `Double.toString(d)` as Java 8 through 18 prints it (e.g. 2e23 -> "1.9999999999999998E23", 1e-4 -> "1.0E-4"). */
export function javaDoubleToString(d: number): string {
  if (Number.isNaN(d)) return 'NaN';
  if (!Number.isFinite(d)) return d > 0 ? 'Infinity' : '-Infinity';
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, d);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n === 1n ? '-' : '';
  let fractBits = bits & SIGNIF_BIT_MASK;
  let binExp = Number((bits >> 52n) & 0x7ffn);
  if (binExp === 0 && fractBits === 0n) return `${sign}0.0`;
  let nSignificantBits: number;
  if (binExp === 0) {
    const leadingZeros = 64 - fractBits.toString(2).length;
    const shift = leadingZeros - (63 - EXP_SHIFT);
    fractBits <<= BigInt(shift);
    binExp = 1 - shift;
    nSignificantBits = 64 - leadingZeros;
  } else {
    fractBits |= FRACT_HOB;
    nSignificantBits = EXP_SHIFT + 1;
  }
  return sign + layout(dtoa(binExp - EXP_BIAS, fractBits, nSignificantBits));
}
