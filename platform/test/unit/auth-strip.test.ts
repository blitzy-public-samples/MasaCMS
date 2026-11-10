// Inbound header stripping of @opt2/platform/auth: invocation credentials, X-Opt2-* headers and exchanged Authorization never pass the gateway.
import { describe, expect, it } from 'vitest';
import { INVOCATION_HEADER } from '../../src/auth/invocation.js';
import { OPT2_HEADER_PREFIX, stripInboundAuthHeaders, type HeaderMap } from '../../src/auth/strip.js';

const USER_TOKEN = 'Bearer user-token';
const COOKIE = 'MURA_SESSION=session-1; MURA_SITE=default';
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const INBOUND: HeaderMap = {
  Authorization: USER_TOKEN,
  'X-Serverless-Authorization': 'Bearer invocation-token',
  'X-Opt2-Write-Position': 'people=42',
  'x-OPT2-anything': 'forged',
  Cookie: COOKIE,
  traceparent: TRACEPARENT,
};

describe('OPT2_HEADER_PREFIX', () => {
  it('is the lower-cased x-opt2- prefix', () => {
    expect(OPT2_HEADER_PREFIX).toBe('x-opt2-');
  });
});

describe('stripInboundAuthHeaders', () => {
  it.each([
    { afterExchange: true, expected: { Cookie: COOKIE, traceparent: TRACEPARENT } },
    { afterExchange: false, expected: { Authorization: USER_TOKEN, Cookie: COOKIE, traceparent: TRACEPARENT } },
  ])('keeps only client headers under their original names when afterExchange is $afterExchange', ({ afterExchange, expected }) => {
    expect(stripInboundAuthHeaders(INBOUND, { afterExchange })).toStrictEqual(expected);
  });

  it.each([true, false])('leaves the input unchanged and returns a new object when afterExchange is %s', (afterExchange) => {
    const input: HeaderMap = { ...INBOUND };
    const snapshot = structuredClone(input);
    const clean: HeaderMap = { cookie: COOKIE };

    expect(stripInboundAuthHeaders(input, { afterExchange })).not.toBe(input);
    expect(input).toStrictEqual(snapshot);
    expect(stripInboundAuthHeaders(clean, { afterExchange })).not.toBe(clean);
    expect(stripInboundAuthHeaders(clean, { afterExchange })).toStrictEqual(clean);
  });

  it('preserves array-valued and undefined headers', () => {
    const setCookie = ['MURA_SESSION=session-1; Path=/', 'MURA_SITE=default; Path=/'];
    const forwardedFor = ['203.0.113.7', '10.0.0.2'];
    const input: HeaderMap = {
      authorization: USER_TOKEN,
      'set-cookie': setCookie,
      'x-forwarded-for': forwardedFor,
      'if-none-match': undefined,
    };

    const result = stripInboundAuthHeaders(input, { afterExchange: true });

    expect(result).toStrictEqual({ 'set-cookie': setCookie, 'x-forwarded-for': forwardedFor, 'if-none-match': undefined });
    expect(result['set-cookie']).toBe(setCookie);
    expect(result['x-forwarded-for']).toBe(forwardedFor);
    expect(Object.hasOwn(result, 'if-none-match')).toBe(true);
  });

  it.each([
    { name: 'AUTHORIZATION', afterExchange: true, kept: false },
    { name: 'AUTHORIZATION', afterExchange: false, kept: true },
    { name: 'X-SERVERLESS-AUTHORIZATION', afterExchange: true, kept: false },
    { name: 'X-SERVERLESS-AUTHORIZATION', afterExchange: false, kept: false },
    { name: INVOCATION_HEADER, afterExchange: false, kept: false },
    { name: 'X-OPT2-WRITE-POSITION', afterExchange: false, kept: false },
    { name: `${OPT2_HEADER_PREFIX}session-barrier`, afterExchange: false, kept: false },
    { name: 'x-opt2', afterExchange: true, kept: true },
    { name: 'x-opt2foo', afterExchange: true, kept: true },
    { name: 'x-csrf_token', afterExchange: true, kept: true },
    { name: 'x-http-method-override', afterExchange: true, kept: true },
    { name: 'x-forwarded-for', afterExchange: true, kept: true },
    { name: 'x-forwarded-host', afterExchange: true, kept: true },
    { name: 'x-forwarded-proto', afterExchange: true, kept: true },
  ])('$name with afterExchange $afterExchange is kept: $kept', ({ name, afterExchange, kept }) => {
    const result = stripInboundAuthHeaders({ [name]: 'value', cookie: COOKIE }, { afterExchange });

    expect(result).toStrictEqual(kept ? { [name]: 'value', cookie: COOKIE } : { cookie: COOKIE });
  });

  it.each([
    [
      'Object.defineProperty',
      (): HeaderMap => {
        const headers: HeaderMap = { cookie: COOKIE };
        Object.defineProperty(headers, '__proto__', { value: ['polluted'], enumerable: true, configurable: true, writable: true });
        return headers;
      },
    ],
    ['JSON.parse', (): HeaderMap => JSON.parse(`{"__proto__":["polluted"],"cookie":${JSON.stringify(COOKIE)}}`) as HeaderMap],
  ])('keeps a __proto__ header from %s as an own property without changing the prototype', (_source, build) => {
    const result = stripInboundAuthHeaders(build(), { afterExchange: true });

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual(['polluted']);
    expect(result.cookie).toBe(COOKIE);
  });

  it.each([true, false])('returns an empty map for empty input when afterExchange is %s', (afterExchange) => {
    expect(stripInboundAuthHeaders({}, { afterExchange })).toStrictEqual({});
  });
});
