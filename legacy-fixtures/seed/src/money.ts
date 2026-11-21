// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/

/** A numeric(19,4) value serialised as a string with exactly four decimals. */
export const MONEY_PATTERN = /^-?\d+\.\d{4}$/;

const SCALE = 10_000n;

/** Formats a count of ten-thousandths as a four-decimal string, e.g. `12345000n` -> `"1234.5000"`. */
export function formatUnits(tenThousandths: bigint): string {
  const negative = tenThousandths < 0n;
  const magnitude = negative ? -tenThousandths : tenThousandths;
  const fraction = (magnitude % SCALE).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${magnitude / SCALE}.${fraction}`;
}

/** Ten-thousandths for the decimal `<whole>.<fraction>`; `fraction` (0..9999) takes the sign of `whole`, so `units(-7, 5000)` is -7.5. */
export function units(whole: number, fraction = 0): bigint {
  if (!Number.isSafeInteger(whole)) throw new RangeError(`units: whole must be a safe integer, got ${whole}`);
  if (!Number.isInteger(fraction) || fraction < 0 || fraction > 9999) {
    throw new RangeError(`units: fraction must be an integer in 0..9999, got ${fraction}`);
  }
  const negative = whole < 0 || Object.is(whole, -0);
  const magnitude = BigInt(Math.abs(whole)) * SCALE + BigInt(fraction);
  return negative ? -magnitude : magnitude;
}

/** Ten-thousandths for an integer count of cents. */
export function fromCents(cents: number): bigint {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`fromCents: cents must be a safe integer, got ${cents}`);
  return BigInt(cents) * 100n;
}

/** Exact sum of ten-thousandths values; `0n` for an empty list. */
export function sumUnits(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
