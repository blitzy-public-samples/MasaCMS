import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_ASSERTION_HEADER,
  BRIDGE_AUDIENCE,
  BRIDGE_MAX_TTL_SECONDS,
  BRIDGE_NONCE_WINDOW_SECONDS,
  MemoryNonceStore,
  encodeBridgePayload,
  signBridgeAssertion,
  verifyBridgeAssertion,
  type BridgeAssertionPayload,
  type BridgeAssertionResult,
  type NonceStore,
} from '../../src/legacy-compat/bridge-assertion.js';

const KEY = 'bridge-unit-test-key';
const NOW_S = 1_768_471_200;
const NOW = new Date(NOW_S * 1000);
const NONCE = '00112233445566778899aabbccddeeff';
const WIRE_KEYS = ['aud', 'op', 'sid', 'sub', 'siteId', 'exp', 'nonce'];

/** Returns the instant `seconds` after NOW. */
function at(seconds: number): Date {
  return new Date((NOW_S + seconds) * 1000);
}

/** Returns the lowercase hex HMAC-SHA256 of `p`. */
function mac(p: string, key = KEY): string {
  return createHmac('sha256', key).update(p, 'utf8').digest('hex');
}

/** Returns the unpadded base64url of the JSON of `value`. */
function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Returns `<p>.<sig>` for a raw payload part. */
function withMac(p: string, key = KEY): string {
  return `${p}.${mac(p, key)}`;
}

/** Returns a header value carrying the JSON of `value`, signed with `key`. */
function forge(value: unknown, key = KEY): string {
  return withMac(part(value), key);
}

/** Returns valid wire claims expiring 30 s after NOW; an `undefined` override drops the key. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: BRIDGE_AUDIENCE,
    op: 'hydrate',
    sid: 'SID-1',
    sub: 'USER-1',
    siteId: 'default',
    exp: NOW_S + 30,
    nonce: NONCE,
    ...overrides,
  };
}

/** Returns the parsed JSON of a header value's payload part. */
function decoded(value: string): Record<string, unknown> {
  const [p = ''] = value.split('.');
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Returns a nonce store whose calls are recorded and whose `seen` answers `seenResult`. */
function recordingStore(seenResult: boolean) {
  return {
    seen: vi.fn<NonceStore['seen']>(() => seenResult),
    remember: vi.fn<NonceStore['remember']>(),
  };
}

/** Returns 'ok' or the rejection reason. */
function outcome(result: BridgeAssertionResult): string {
  return result.ok ? 'ok' : result.reason;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bridge assertion constants', () => {
  it('names the header and audience, and fixes the 60 s expiry ceiling and 120 s nonce window', () => {
    expect(BRIDGE_ASSERTION_HEADER).toBe('X-Opt2-Bridge-Assertion');
    expect(BRIDGE_AUDIENCE).toBe('legacy-bridge');
    expect(BRIDGE_MAX_TTL_SECONDS).toBe(60);
    expect(BRIDGE_NONCE_WINDOW_SECONDS).toBe(120);
  });
});

describe('encodeBridgePayload', () => {
  const payload: BridgeAssertionPayload = {
    nonce: NONCE,
    exp: NOW_S + 60,
    siteId: 'default',
    sub: 'USER-1',
    sid: 'SID-1',
    op: 'hydrate',
    aud: 'legacy-bridge',
  };

  it('returns unpadded base64url of compact JSON in wire key order', () => {
    const p = encodeBridgePayload(payload);
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(p, 'base64url').toString('utf8')).toBe(
      '{"aud":"legacy-bridge","op":"hydrate","sid":"SID-1","sub":"USER-1","siteId":"default",' +
        `"exp":${NOW_S + 60},"nonce":"${NONCE}"}`,
    );
  });

  it('leaves out properties outside the wire format', () => {
    const extended = { ...payload, roles: ['S2'] };
    expect(encodeBridgePayload(extended)).toBe(encodeBridgePayload(payload));
  });
});

describe('signBridgeAssertion', () => {
  const input = { op: 'describe', sid: 'SID-1', sub: 'USER-1', siteId: 'default', now: NOW };

  it('returns <p>.<sig> where sig is the lowercase hex HMAC-SHA256 of p', () => {
    const value = signBridgeAssertion(input, KEY);
    const parts = value.split('.');
    expect(parts).toHaveLength(2);
    const [p = '', sig = ''] = parts;
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(mac(p));
  });

  it('signs the wire claims with exp 60 s after now and a 32-character lowercase hex nonce', () => {
    const signed = decoded(signBridgeAssertion(input, KEY));
    expect(Object.keys(signed)).toEqual(WIRE_KEYS);
    expect(signed).toEqual({
      aud: 'legacy-bridge',
      op: 'describe',
      sid: 'SID-1',
      sub: 'USER-1',
      siteId: 'default',
      exp: NOW_S + 60,
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it('signs empty strings for an absent sid, sub and siteId', () => {
    expect(decoded(signBridgeAssertion({ op: 'end', now: NOW }, KEY))).toMatchObject({ sid: '', sub: '', siteId: '' });
  });

  it.each([
    { ttlSeconds: 1, now: NOW, exp: NOW_S + 1 },
    { ttlSeconds: 60, now: NOW, exp: NOW_S + 60 },
    { ttlSeconds: 1, now: new Date(NOW_S * 1000 + 999), exp: NOW_S + 1 },
  ])('sets exp to the whole seconds of $now plus ttlSeconds $ttlSeconds', ({ ttlSeconds, now, exp }) => {
    expect(decoded(signBridgeAssertion({ op: 'describe', ttlSeconds, now }, KEY)).exp).toBe(exp);
  });

  it('draws a fresh nonce for every call', () => {
    const nonces = new Set(
      Array.from({ length: 100 }, () => decoded(signBridgeAssertion({ op: 'describe', now: NOW }, KEY)).nonce),
    );
    expect(nonces.size).toBe(100);
  });

  it('takes now from the clock when it is omitted', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    expect(decoded(signBridgeAssertion({ op: 'describe' }, KEY)).exp).toBe(NOW_S + 60);
  });

  it.each([0, 61, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('throws RangeError for ttlSeconds %s', (ttl) => {
    const sign = () => signBridgeAssertion({ op: 'describe', ttlSeconds: ttl, now: NOW }, KEY);
    expect(sign).toThrow(RangeError);
    expect(sign).toThrow('ttlSeconds must be an integer in 1..60');
  });

  it('throws RangeError for an empty key', () => {
    const sign = () => signBridgeAssertion({ op: 'describe', now: NOW }, '');
    expect(sign).toThrow(RangeError);
    expect(sign).toThrow('bridge HMAC key must not be empty');
  });
});

describe('verifyBridgeAssertion', () => {
  it('accepts a signed assertion and returns its claims', () => {
    const value = signBridgeAssertion({ op: 'hydrate', sid: 'SID-1', sub: 'USER-1', siteId: 'default', now: NOW }, KEY);
    expect(verifyBridgeAssertion(value, KEY, new MemoryNonceStore(), NOW)).toStrictEqual({
      ok: true,
      payload: decoded(value),
    });
  });

  it.each([
    [-1, 'too-far'],
    [0, 'ok'],
    [59, 'ok'],
    [59.999, 'ok'],
    [60, 'expired'],
    [61, 'expired'],
  ])('verifies an assertion expiring at NOW + 60 s, %s s after NOW, as %s', (offset, expected) => {
    const value = signBridgeAssertion({ op: 'describe', now: NOW }, KEY);
    expect(outcome(verifyBridgeAssertion(value, KEY, new MemoryNonceStore(), at(offset)))).toBe(expected);
  });

  it('takes now from the clock when it is omitted', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(60));
    const value = signBridgeAssertion({ op: 'describe', now: NOW }, KEY);
    expect(verifyBridgeAssertion(value, KEY, new MemoryNonceStore())).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts each assertion once and rejects its reuse as a replay', () => {
    const store = new MemoryNonceStore();
    const value = signBridgeAssertion({ op: 'describe', now: NOW }, KEY);
    expect(outcome(verifyBridgeAssertion(value, KEY, store, NOW))).toBe('ok');
    expect(verifyBridgeAssertion(value, KEY, store, at(59))).toEqual({ ok: false, reason: 'replay' });
  });

  it('checks the nonce at now and remembers it until 120 s after now', () => {
    const store = recordingStore(false);
    expect(outcome(verifyBridgeAssertion(forge(claims()), KEY, store, NOW))).toBe('ok');
    expect(store.seen.mock.calls).toEqual([[NONCE, NOW_S]]);
    expect(store.remember.mock.calls).toEqual([[NONCE, NOW_S + 120]]);
  });

  it('accepts any non-empty nonce', () => {
    const nonce = '6F0A2C1E-5B7D-4E8A-9C3F0D1E2F3A4B5C';
    const result = verifyBridgeAssertion(forge(claims({ nonce })), KEY, new MemoryNonceStore(), NOW);
    expect(result).toStrictEqual({ ok: true, payload: claims({ nonce }) });
  });

  it('returns only the wire claims', () => {
    const result = verifyBridgeAssertion(forge(claims({ roles: ['S2'] })), KEY, new MemoryNonceStore(), NOW);
    expect(result).toStrictEqual({ ok: true, payload: claims() });
  });

  it('leaves the nonce of a rejected assertion usable', () => {
    const store = new MemoryNonceStore();
    const value = signBridgeAssertion({ op: 'describe', now: NOW }, KEY);
    expect(outcome(verifyBridgeAssertion(value, KEY, store, at(-1)))).toBe('too-far');
    expect(outcome(verifyBridgeAssertion(value, KEY, store, NOW))).toBe('ok');
  });

  const valid = forge(claims());
  const [validPart = '', validMac = ''] = valid.split('.');

  it.each([
    ['an empty value', '', 'malformed'],
    ['a value without a separator', validPart, 'malformed'],
    ['a value with three parts', `${valid}.${validMac}`, 'malformed'],
    ['an empty payload part', `.${mac('')}`, 'malformed'],
    ['an empty signature part', `${validPart}.`, 'malformed'],
    ['a MAC under another key', forge(claims(), 'another-unit-test-key'), 'signature'],
    ['an upper-case MAC', `${validPart}.${validMac.toUpperCase()}`, 'signature'],
    ['a truncated MAC', `${validPart}.${validMac.slice(0, -1)}`, 'signature'],
    ['a payload changed after signing', `${part(claims({ op: 'end' }))}.${validMac}`, 'signature'],
    ['a padded payload part', withMac(`${validPart}=`), 'malformed'],
    ['a payload part in the standard base64 alphabet', withMac('ab+c/d'), 'malformed'],
    ['a payload that is not JSON', withMac(Buffer.from('not json', 'utf8').toString('base64url')), 'malformed'],
    ['a JSON array', forge([claims()]), 'malformed'],
    ['JSON null', forge(null), 'malformed'],
    ['a JSON string', forge('hydrate'), 'malformed'],
    ['a missing op', forge(claims({ op: undefined })), 'malformed'],
    ['a numeric sid', forge(claims({ sid: 1 })), 'malformed'],
    ['a null sub', forge(claims({ sub: null })), 'malformed'],
    ['a missing siteId', forge(claims({ siteId: undefined })), 'malformed'],
    ['a string exp', forge(claims({ exp: String(NOW_S + 30) })), 'malformed'],
    ['a fractional exp', forge(claims({ exp: NOW_S + 30.5 })), 'malformed'],
    ['a missing nonce', forge(claims({ nonce: undefined })), 'malformed'],
    ['an empty nonce', forge(claims({ nonce: '' })), 'malformed'],
    ['a numeric nonce', forge(claims({ nonce: 7 })), 'malformed'],
    ['another audience', forge(claims({ aud: 'gateway' })), 'audience'],
    ['a missing audience', forge(claims({ aud: undefined })), 'audience'],
  ])('rejects %s and remembers no nonce', (_label, value, reason) => {
    const store = recordingStore(false);
    expect(verifyBridgeAssertion(value, KEY, store, NOW)).toEqual({ ok: false, reason });
    expect(store.remember).not.toHaveBeenCalled();
  });

  it('verifies nothing under an empty key, even with a MAC computed from it', () => {
    const store = recordingStore(false);
    expect(verifyBridgeAssertion(forge(claims(), ''), '', store, NOW)).toEqual({ ok: false, reason: 'signature' });
    expect(store.seen).not.toHaveBeenCalled();
  });

  it.each([
    ['structure before the key', `${valid}.${validMac}`, '', 'malformed'],
    ['the MAC before the payload shape', forge([claims()], 'another-unit-test-key'), KEY, 'signature'],
    ['the payload shape before the audience', forge(claims({ aud: 'gateway', op: 1 })), KEY, 'malformed'],
    ['the audience before expiry', forge(claims({ aud: 'gateway', exp: NOW_S - 1 })), KEY, 'audience'],
    ['expiry before replay', forge(claims({ exp: NOW_S })), KEY, 'expired'],
    ['the expiry ceiling before replay', forge(claims({ exp: NOW_S + 61 })), KEY, 'too-far'],
  ])('checks %s', (_label, value, key, reason) => {
    const store = recordingStore(true);
    expect(verifyBridgeAssertion(value, key, store, NOW)).toEqual({ ok: false, reason });
    expect(store.seen).not.toHaveBeenCalled();
  });

  it('rejects a seen nonce as a replay without remembering it again', () => {
    const store = recordingStore(true);
    expect(verifyBridgeAssertion(forge(claims()), KEY, store, NOW)).toEqual({ ok: false, reason: 'replay' });
    expect(store.seen.mock.calls).toEqual([[NONCE, NOW_S]]);
    expect(store.remember).not.toHaveBeenCalled();
  });
});

describe('MemoryNonceStore', () => {
  it('reports a remembered nonce as seen until its untilSeconds', () => {
    const store = new MemoryNonceStore();
    expect(store.seen(NONCE, NOW_S)).toBe(false);
    store.remember(NONCE, NOW_S + 120);
    expect(store.seen(NONCE, NOW_S + 119)).toBe(true);
    expect(store.seen(NONCE, NOW_S + 120)).toBe(false);
  });

  it('evicts every expired entry on any query and keeps the rest', () => {
    const store = new MemoryNonceStore();
    store.remember('expires-first', NOW_S + 10);
    store.remember('expires-later', NOW_S + 100);
    expect(store.seen('unrelated', NOW_S + 50)).toBe(false);
    expect(store.seen('expires-first', NOW_S)).toBe(false);
    expect(store.seen('expires-later', NOW_S)).toBe(true);
  });
});
