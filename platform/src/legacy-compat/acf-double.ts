// Number text as Java's FloatingDecimal and ACF 2023's DoubleParser copy of it read it.

// Java's HexFloatPattern: sign, whole significand or integer and fraction digits, exponent sign and digits.
const HEX_FLOAT = /^([-+])?0[xX](?:([0-9A-Fa-f]+)\.?|([0-9A-Fa-f]*)\.([0-9A-Fa-f]+))[pP]([-+])?([0-9]+)[fFdD]?$/;
const INT_MAX = 2 ** 31 - 1;

/** A positive integer times 2^exponent rounded half-even to a double, subnormals included, as FloatingDecimal rounds. */
function scaleBinary(significand: bigint, exponent: number): number {
  const bits = significand.toString(2).length;
  const top = exponent + bits - 1;
  if (top > 1023) return Infinity;
  if (top < -1075) return 0;
  const kept = top >= -1022 ? 53 : top + 1075;
  const drop = BigInt(bits - kept);
  if (drop <= 0n) return Number(significand << -drop) * 2 ** (top - kept + 1);
  let m = significand >> drop;
  const rest = significand - (m << drop);
  const half = 1n << (drop - 1n);
  if (rest > half || (rest === half && (m & 1n) === 1n)) m += 1n;
  return Number(m) * 2 ** (top - kept + 1);
}

/**
 * Hexadecimal float text as FloatingDecimal.parseHexString (`java`) or ACF DoubleParser's copy reads it; the copy takes
 * its binary exponent's magnitude from the significand digits read as decimal. Null when malformed.
 */
function parseHex(s: string, java: boolean): number | null {
  const m = HEX_FLOAT.exec(s);
  if (m === null) return null;
  const [, sign, whole, integer = '', fraction = '', expSign, expDigits = ''] = m;
  const negative = sign === '-';
  const digits = (whole ?? integer + fraction).replace(/^0+/, '');
  if (digits === '') return negative ? -0 : 0;
  const magnitude = java ? expDigits : digits;
  // An exponent Integer.parseInt refuses (overflow, or a hex digit in the copy) gives infinity or zero by its sign.
  if (!/^[0-9]+$/.test(magnitude) || Number(magnitude) > INT_MAX) {
    const limit = expSign === '-' ? 0 : Infinity;
    return negative ? -limit : limit;
  }
  const value = scaleBinary(BigInt(`0x${digits}`), (expSign === '-' ? -1 : 1) * Number(magnitude) - 4 * fraction.length);
  return negative ? -value : value;
}

/**
 * Number text as Java's FloatingDecimal (`java`, Double.parseDouble) or ACF's DoubleParser copy reads it: sign, NaN,
 * Infinity, a hexadecimal float, digits with one '.', exponent, one trailing f/F/d/D. Null when malformed.
 */
export function parseDecimal(s: string, java: boolean): number | null {
  const len = s.length;
  let i = 0;
  const negative = s.charAt(0) === '-';
  if (negative || s.charAt(0) === '+') i++;
  const signSeen = i > 0;
  if (s.charAt(i) === 'N') return s.slice(i) === 'NaN' ? NaN : null;
  if (s.charAt(i) === 'I') return s.slice(i) === 'Infinity' ? (negative ? -Infinity : Infinity) : null;
  if (s.charAt(i) === '0' && (s.charAt(i + 1) === 'x' || s.charAt(i + 1) === 'X')) return parseHex(s, java);
  let leadZeros = 0;
  let trailZeros = 0;
  let digits = '';
  let decSeen = false;
  let decPt = 0;
  const point = (): boolean => {
    if (decSeen) return false;
    decPt = signSeen ? i - 1 : i;
    decSeen = true;
    return true;
  };
  for (; i < len && (s.charAt(i) === '0' || s.charAt(i) === '.'); i++) {
    if (s.charAt(i) === '0') leadZeros++;
    else if (!point()) return null;
  }
  for (; i < len; i++) {
    const ch = s.charAt(i);
    if (ch >= '1' && ch <= '9') {
      digits += ch;
      trailZeros = 0;
    } else if (ch === '0') {
      digits += ch;
      trailZeros++;
    } else if (ch !== '.') break;
    else if (!point()) return null;
  }
  const nDigits = digits.length - trailZeros;
  if (nDigits === 0 && leadZeros === 0) return null;
  let decExp = decSeen ? decPt - leadZeros : nDigits + trailZeros;
  if (s.charAt(i) === 'e' || s.charAt(i) === 'E') {
    i++;
    if (i >= len) return null;
    const expSign = s.charAt(i) === '-' ? -1 : 1;
    if (s.charAt(i) === '-' || s.charAt(i) === '+') i++;
    const expAt = i;
    let expVal = 0;
    let overflow = false;
    for (; i < len && s.charAt(i) >= '0' && s.charAt(i) <= '9'; i++) {
      if (expVal >= 0xccccccc) overflow = true;
      expVal = expVal * 10 + s.charCodeAt(i) - 48;
    }
    if (i < len && expVal >= 0xccccccc) overflow = true;
    const expLimit = 324 + nDigits + trailZeros;
    if (!overflow && expVal <= expLimit) decExp += expSign * expVal;
    else if (java && !overflow && expSign === 1 && decExp < 0 && expVal + decExp < expLimit) decExp += expVal;
    else decExp = expSign * expLimit;
    if (i === expAt) return null;
  }
  if (i < len && (i !== len - 1 || !'fFdD'.includes(s.charAt(i)))) return null;
  if (nDigits === 0) return negative ? -0 : 0;
  return Number(`${negative ? '-' : ''}0.${digits.slice(0, nDigits)}e${decExp}`);
}

/** CFDouble's guard before parsing: no trailing f/F/d/D and no edge whitespace. */
export const cfDoubleShape = (s: string): boolean => !'FDdf'.includes(s.charAt(s.length - 1)) && s.charCodeAt(s.length - 1) > 32 && s.charCodeAt(0) > 32;

/** Whether `s` is a Java hex float literal without a type suffix, such as `0x1p3`. */
export function isHexFloatLiteral(s: string): boolean {
  return HEX_FLOAT.test(s) && cfDoubleShape(s);
}
