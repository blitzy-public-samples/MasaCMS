import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { percentile, ratioFinding, RATIO_FINDING_THRESHOLD, summariseSamples } from '../../src/performance/run.js';

interface KnownCase {
  label: string;
  samples: readonly number[];
  sorted: readonly number[];
  p50: number;
  p95: number;
}

// Nearest rank: the ceil(q/100 * n)-th smallest sample.
const KNOWN: readonly KnownCase[] = [
  {
    // ceil(0.5*11) = 6th = 16; ceil(0.95*11) = 11th = 40
    label: '11 samples',
    samples: [12, 7, 30, 18, 25, 9, 14, 21, 40, 11, 16],
    sorted: [7, 9, 11, 12, 14, 16, 18, 21, 25, 30, 40],
    p50: 16,
    p95: 40,
  },
  {
    // ceil(0.5*20) = 10th = 30; ceil(0.95*20) = 19th = 57
    label: '20 samples',
    samples: [33, 60, 3, 27, 48, 12, 57, 21, 6, 39, 54, 15, 30, 45, 9, 51, 24, 42, 18, 36],
    sorted: [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60],
    p50: 30,
    p95: 57,
  },
  { label: 'a single sample', samples: [42.5], sorted: [42.5], p50: 42.5, p95: 42.5 },
];

const latencySamples = fc.array(fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }), {
  minLength: 1,
  maxLength: 500,
});

// Rounding to 0.1 ms moves a value by at most 0.05 ms.
const ROUNDING_SLACK_MS = 0.05 + 1e-9;

describe('percentile', () => {
  it.each(KNOWN)('takes the nearest-rank p50 and p95 of $label', ({ samples, p50, p95 }) => {
    expect(percentile(samples, 50)).toBe(p50);
    expect(percentile(samples, 95)).toBe(p95);
  });

  it.each(KNOWN)('gives the same p50 and p95 for $label in request order as sorted', ({ samples, sorted }) => {
    expect(percentile(samples, 50)).toBe(percentile(sorted, 50));
    expect(percentile(samples, 95)).toBe(percentile(sorted, 95));
  });

  it('throws a RangeError on an empty sample set', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
  });

  it('returns one of the samples, between the minimum and the maximum, with p50 at most p95', () => {
    fc.assert(
      fc.property(latencySamples, (samples) => {
        const p50 = percentile(samples, 50);
        const p95 = percentile(samples, 95);
        expect(samples).toContain(p50);
        expect(samples).toContain(p95);
        expect(Math.min(...samples)).toBeLessThanOrEqual(p50);
        expect(p50).toBeLessThanOrEqual(p95);
        expect(p95).toBeLessThanOrEqual(Math.max(...samples));
      }),
    );
  });
});

describe('summariseSamples', () => {
  it.each(KNOWN)('summarises $label as their nearest-rank p50 and p95', ({ samples, p50, p95 }) => {
    expect(summariseSamples(samples)).toStrictEqual({ p50Ms: p50, p95Ms: p95 });
  });

  it('throws a RangeError on an empty sample set', () => {
    expect(() => summariseSamples([])).toThrow(RangeError);
  });

  it('keeps p50 at most p95 and both within the sample range up to rounding', () => {
    fc.assert(
      fc.property(latencySamples, (samples) => {
        const { p50Ms, p95Ms } = summariseSamples(samples);
        expect(Math.min(...samples) - ROUNDING_SLACK_MS).toBeLessThanOrEqual(p50Ms);
        expect(p50Ms).toBeLessThanOrEqual(p95Ms);
        expect(p95Ms).toBeLessThanOrEqual(Math.max(...samples) + ROUNDING_SLACK_MS);
      }),
    );
  });
});

describe('ratioFinding', () => {
  it('uses 1.5 as the finding threshold', () => {
    expect(RATIO_FINDING_THRESHOLD).toBe(1.5);
  });

  it('flags a target p95 above 1.5x legacy as a finding, not a failure', () => {
    expect(ratioFinding({ p50Ms: 90, p95Ms: 160 }, { p50Ms: 60, p95Ms: 100 })).toStrictEqual({
      ratioP95: 1.6,
      finding: 'target p95 160 ms is 1.6x legacy p95 100 ms (above 1.5x)',
    });
  });

  it.each([
    { target: 150, legacy: 100, ratioP95: 1.5 },
    { target: 120, legacy: 100, ratioP95: 1.2 },
    { target: 80, legacy: 100, ratioP95: 0.8 },
    { target: 120, legacy: 0, ratioP95: null },
  ])(
    'raises no finding for target p95 $target ms against legacy p95 $legacy ms',
    ({ target, legacy, ratioP95 }) => {
      expect(ratioFinding({ p50Ms: 50, p95Ms: target }, { p50Ms: 50, p95Ms: legacy })).toStrictEqual({
        ratioP95,
        finding: null,
      });
    },
  );
});
