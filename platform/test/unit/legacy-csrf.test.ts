import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  CSRF_TOKEN_LIFETIME_HOURS,
  cfHash,
  formatCsrfExpires,
  generateCsrfToken,
  purgeUsedTokens,
  renderCsrfFields,
  validateCsrfToken,
  type CsrfTokens,
  type CsrfUsedLedger,
} from '../../src/legacy-compat/index.js';

type ValidateArgs = Parameters<typeof validateCsrfToken>[0];

const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const SECRET = 'SECRET';
const CONTEXT = 'cusers.update';
const SECOND_MS = 1_000;
const HOUR_MS = 3_600_000;

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

/** Token for CONTEXT and SECRET expiring `lifetimeHours` after `issued`, as generateCSRFTokens(timespan) issues it. */
function tokenFor(issued: Date, lifetimeHours: number): CsrfTokens {
  const expires = formatCsrfExpires(new Date(issued.getTime() + lifetimeHours * HOUR_MS));
  return { token: cfHash(CONTEXT + SECRET + expires), expires };
}

/** Pins `new Date()` to `now` without touching timers. */
function freezeClock(now: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
}

afterEach(() => {
  vi.useRealTimers();
});

// ACF 2023 tokens are 64-hex SHA-256 and expire at issue + 3 h with the issuing millisecond counted once, as the
// oracle's login form shows; an MD5 token or a doubled millisecond (…000246) would never validate on legacy.
describe('generateCsrfToken', () => {
  it('expires three hours after issue, keeping the issuing millisecond', () => {
    expect(generateCsrfToken({ secret: SECRET, now: NOW }).expires).toBe('260630150000123');
  });

  it.each([
    ['', '6D6D9A9E3058BA3B07F6443189529C30706936803052A72E3C283B7545EAE340'],
    [CONTEXT, '9BE2C8DE446D7E90110F494392AD681B8B1A87ECCCCF959700CBDBD4A80C56B0'],
  ])('hashes context %j, secret and expiry into %s', (context, token) => {
    expect(generateCsrfToken({ context, secret: SECRET, now: NOW })).toEqual({ token, expires: '260630150000123' });
  });

  it('is the uppercase hash of context, secret and expiry', () => {
    expect(generateCsrfToken({ context: CONTEXT, secret: SECRET, now: NOW })).toEqual(tokenFor(NOW, 3));
  });

  it('defaults to an empty context and the current clock', () => {
    freezeClock(NOW);
    expect(generateCsrfToken({ secret: SECRET })).toEqual(generateCsrfToken({ context: '', secret: SECRET, now: NOW }));
  });
});

describe('formatCsrfExpires', () => {
  it('renders yyMMddHHnnsslll in local time', () => {
    expect(formatCsrfExpires(new Date(2026, 5, 30, 15, 0, 0, 246))).toBe('260630150000246');
  });
});

describe('validateCsrfToken', () => {
  const issued = generateCsrfToken({ context: CONTEXT, secret: SECRET, now: NOW });
  const check = (overrides: Partial<ValidateArgs>): ReturnType<typeof validateCsrfToken> =>
    validateCsrfToken({ ...issued, context: CONTEXT, secret: SECRET, used: {}, now: at(HOUR_MS), ...overrides });

  it('accepts a fresh token once, recording it in a new ledger', () => {
    const callerLedger = new Map([['OTHER-TOKEN', NOW]]);
    const first = check({ used: callerLedger });
    expect(first.valid).toBe(true);
    expect([...first.used]).toEqual([
      ['OTHER-TOKEN', NOW],
      [issued.token, at(HOUR_MS)],
    ]);
    expect([...callerLedger]).toEqual([['OTHER-TOKEN', NOW]]);
    expect(check({ used: first.used })).toEqual({ valid: false, used: first.used });
  });

  it('treats a missing context as the empty context', () => {
    const emptyContext = generateCsrfToken({ secret: SECRET, now: NOW });
    expect(validateCsrfToken({ ...emptyContext, secret: SECRET, used: {}, now: at(HOUR_MS) }).valid).toBe(true);
  });

  it('accepts a lower-case token, then refuses the token in any case', () => {
    const first = check({ token: issued.token.toLowerCase() });
    expect(first.valid).toBe(true);
    expect(check({ used: first.used }).valid).toBe(false);
  });

  it.each<[string, Partial<ValidateArgs>]>([
    ['an expired token', { now: at(3 * HOUR_MS + SECOND_MS) }],
    ['a token for another context', { context: 'cusers.delete' }],
    ['a token for another secret', { secret: 'OTHER' }],
    ['an empty token', { token: '' }],
    ['a missing token', { token: undefined }],
    ['a missing expiry', { expires: undefined }],
  ])('rejects %s and records nothing', (_label, overrides) => {
    expect(check(overrides)).toEqual({ valid: false, used: new Map() });
  });

  it('checks against the current clock when no time is given', () => {
    freezeClock(at(HOUR_MS));
    const result = validateCsrfToken({ ...issued, context: CONTEXT, secret: SECRET, used: {} });
    expect(result).toEqual({ valid: true, used: new Map([[issued.token, at(HOUR_MS)]]) });
  });
});

describe('used-token ledger purge', () => {
  const STALE = at(-(3 * HOUR_MS + SECOND_MS));
  const entries: [string, Date][] = [
    ['STALE', STALE],
    ['BOUNDARY', at(-3 * HOUR_MS)],
    ['RECENT', at(-2 * HOUR_MS)],
  ];

  it.each<[string, CsrfUsedLedger]>([
    ['map', new Map(entries)],
    ['record', Object.fromEntries(entries)],
  ])('drops only entries consumed more than three hours ago from a %s ledger', (_form, ledger) => {
    expect([...purgeUsedTokens(ledger, NOW).keys()]).toEqual(['BOUNDARY', 'RECENT']);
  });

  it('purges against the current clock when no time is given', () => {
    freezeClock(NOW);
    expect([...purgeUsedTokens(new Map(entries)).keys()]).toEqual(['BOUNDARY', 'RECENT']);
  });

  it.each<[string, CsrfTokens, Date, boolean, Date | undefined]>([
    ['a purged token whose expiry is still ahead', tokenFor(at(-4 * HOUR_MS), 6), STALE, true, NOW],
    ['a purged three-hour token, expired by then', tokenFor(STALE, 3), STALE, false, undefined],
    ['a token consumed two hours ago', tokenFor(at(-2 * HOUR_MS), 3), at(-2 * HOUR_MS), false, at(-2 * HOUR_MS)],
  ])('validation purges first: %s is valid: %s', (_label, tokens, consumedAt, valid, listedAt) => {
    const result = validateCsrfToken({
      ...tokens,
      context: CONTEXT,
      secret: SECRET,
      used: { [tokens.token]: consumedAt },
      now: NOW,
    });
    expect(result).toEqual({ valid, used: new Map(listedAt ? [[tokens.token, listedAt]] : []) });
  });
});

describe('renderCsrfFields', () => {
  const tokens: CsrfTokens = { token: 'T', expires: 'E' };

  it.each([
    ['form', '<input type="hidden" name="csrf_token" value="T" /><input type="hidden" name="csrf_token_expires" value="E" />'],
    ['url', '&csrf_token=T&csrf_token_expires=E'],
    ['json', "{csrf_token:'T',csrf_token_expires:'E'}"],
  ] as const)('renders the %s format', (format, expected) => {
    expect(renderCsrfFields(tokens, format)).toBe(expected);
  });

  it('renders hidden form fields by default', () => {
    expect(renderCsrfFields(tokens)).toBe(renderCsrfFields(tokens, 'form'));
  });
});

describe('CSRF names and lifetime', () => {
  it('match the fields, headers and three-hour lifetime legacy uses', () => {
    expect({
      CSRF_FIELD_TOKEN,
      CSRF_FIELD_EXPIRES,
      CSRF_HEADER_TOKEN,
      CSRF_HEADER_EXPIRES,
      CSRF_TOKEN_LIFETIME_HOURS,
    }).toEqual({
      CSRF_FIELD_TOKEN: 'csrf_token',
      CSRF_FIELD_EXPIRES: 'csrf_token_expires',
      CSRF_HEADER_TOKEN: 'X-csrf_token',
      CSRF_HEADER_EXPIRES: 'X-csrf_token_expires',
      CSRF_TOKEN_LIFETIME_HOURS: 3,
    });
  });
});
