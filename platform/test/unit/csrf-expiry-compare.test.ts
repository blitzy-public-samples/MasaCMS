// Expiry check of validateCsrfToken: CFML `>`, numeric when both sides are CFML numeric, otherwise string order.
import { describe, expect, it } from 'vitest';
import { generateCsrfToken, validateCsrfToken } from '../../src/legacy-compat/csrf.js';
import { cfHash } from '../../src/legacy-compat/headers.js';

const CONTEXT = 'cusers.update';
const SESSION_KEY = 'session-key';
const NOW = new Date(2026, 10, 10, 14, 0, 0, 0);
const HOUR_MS = 3_600_000;

describe('validateCsrfToken expiry comparison', () => {
  it.each<[string, number, boolean]>([
    ['1 h after issue', HOUR_MS, true],
    ['1 ms before expiry', 3 * HOUR_MS - 1, true],
    ['at expiry', 3 * HOUR_MS, false],
    ['1 h after expiry', 4 * HOUR_MS, false],
  ])('a generated token checked %s is valid: %s', (_label, elapsedMs, expected) => {
    const issued = generateCsrfToken({ context: CONTEXT, secret: SESSION_KEY, now: NOW });
    const result = validateCsrfToken({
      ...issued,
      context: CONTEXT,
      secret: SESSION_KEY,
      used: {},
      now: new Date(NOW.getTime() + elapsedMs),
    });
    expect(result.valid).toBe(expected);
  });

  // The check runs at NOW, whose expiry text is the 15-digit '261110140000000'.
  it.each<[string, string, boolean]>([
    ['a shorter, numerically smaller expiry', '99', false],
    ['a longer, numerically larger expiry', '1000000000000000', true],
    ['a Java-trimmed numeric expiry', '1000000000000000\u0001', true],
    ['an overflowing expiry, compared as text', '1e309', false],
    ['a U+00A0-padded expiry, compared as text', '\u00a099', true],
  ])('a token hashed over %s (%j) is valid: %s', (_label, expires, expected) => {
    const result = validateCsrfToken({
      token: cfHash(CONTEXT + SESSION_KEY + expires),
      expires,
      context: CONTEXT,
      secret: SESSION_KEY,
      used: {},
      now: NOW,
    });
    expect(result.valid).toBe(expected);
  });
});
