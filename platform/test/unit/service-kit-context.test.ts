import { setImmediate as nextTick } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceIdentity, UserClaims } from '../../src/auth/index.js';
import { fixedClock } from '../../src/service-kit/clock.js';
import {
  NoRequestContextError,
  REQUEST_ID_HEADER,
  RequestAbortedError,
  currentRequestContext,
  newRequestContext,
  recordWritePosition,
  requestContext,
  requestIdFrom,
  requireRequestContext,
  runWithRequestContext,
  throwIfRequestAborted,
  type RequestContextStore,
} from '../../src/service-kit/context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANT = '2026-06-30T09:15:00.000Z';

afterEach(() => {
  vi.useRealTimers();
});

describe('REQUEST_ID_HEADER', () => {
  it('is the lower-cased x-request-id header name', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });
});

describe('requestIdFrom', () => {
  it.each([
    ['a UUID', 'b3c2f1e0-1111-4222-8333-444455556666'],
    ['one visible character', '!'],
    ['200 visible characters', 'a'.repeat(200)],
    ['every visible ASCII character', Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).join('')],
  ])('accepts %s', (_label, value) => {
    expect(requestIdFrom({ [REQUEST_ID_HEADER]: value })).toBe(value);
  });

  it('takes the first value of a repeated header', () => {
    expect(requestIdFrom({ [REQUEST_ID_HEADER]: ['first-id', 'second-id'] })).toBe('first-id');
  });

  it.each([
    ['an absent header', {}],
    ['an undefined value', { [REQUEST_ID_HEADER]: undefined }],
    ['an empty string', { [REQUEST_ID_HEADER]: '' }],
    ['an empty array', { [REQUEST_ID_HEADER]: [] }],
    ['a 201-character value', { [REQUEST_ID_HEADER]: 'a'.repeat(201) }],
    ['a newline', { [REQUEST_ID_HEADER]: 'abc\ndef' }],
    ['a NUL character', { [REQUEST_ID_HEADER]: 'abc\u0000' }],
    ['a DEL character', { [REQUEST_ID_HEADER]: 'abc\u007f' }],
    ['a space', { [REQUEST_ID_HEADER]: 'abc def' }],
    ['a non-ASCII character', { [REQUEST_ID_HEADER]: 'caf\u00e9' }],
    ['an invalid first value of a repeated header', { [REQUEST_ID_HEADER]: ['bad id', 'good-id'] }],
  ])('replaces %s with a new UUID', (_label, headers: Record<string, string | string[] | undefined>) => {
    const id = requestIdFrom(headers);
    expect(id).toMatch(UUID);
    expect(requestIdFrom(headers)).not.toBe(id);
  });

  it('reads only the x-request-id header', () => {
    expect(requestIdFrom({ 'x-correlation-id': 'other' })).toMatch(UUID);
  });
});

describe('newRequestContext', () => {
  it('stamps startedAt from the injected clock and keeps a given request id', () => {
    const store = newRequestContext({ requestId: 'req-1', clock: fixedClock(INSTANT) });
    expect(store.requestId).toBe('req-1');
    expect(store.startedAt.toISOString()).toBe(INSTANT);
  });

  it('defaults to a new UUID, the system clock and an empty identity', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(INSTANT));
    const store = newRequestContext();
    expect(store.requestId).toMatch(UUID);
    expect(store.startedAt.toISOString()).toBe(INSTANT);
    expect(store.writePositions.size).toBe(0);
    expect(store.user).toBeUndefined();
    expect(store.userToken).toBeUndefined();
    expect(store.service).toBeUndefined();
    expect(store.tenantId).toBeUndefined();
    expect(store.site).toBeUndefined();
  });

  it('gives each store its own write-position map and request id', () => {
    const first = newRequestContext();
    const second = newRequestContext();
    first.writePositions.set('people', '1');
    expect(second.writePositions.size).toBe(0);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('holds verified user and service identities', () => {
    const user: UserClaims = {
      iss: 'opt2-local-identity',
      aud: 'opt2-local',
      sub: 'E1B2C3D4-0000-0000-0000000000000001',
      sid: 'session-1',
      tid: '0b6f8f1e-6c1d-5f3a-9a2b-3c4d5e6f7a8b',
      site: 'tenant-a',
      roles: ['system-user'],
      s2: false,
      epoch: 1,
      iat: 1,
      exp: 2,
    };
    const service: ServiceIdentity = { name: 'gateway', roles: ['service:gateway'] };
    const store: RequestContextStore = newRequestContext();
    store.user = user;
    store.userToken = 'header.payload.signature';
    store.service = service;
    store.tenantId = user.tid;
    store.site = user.site;
    expect(runWithRequestContext(store, () => requireRequestContext().user?.sub)).toBe(user.sub);
  });
});

describe('runWithRequestContext and currentRequestContext', () => {
  it('returns undefined outside a request', () => {
    expect(currentRequestContext()).toBeUndefined();
  });

  it('returns the result of fn', () => {
    expect(runWithRequestContext(newRequestContext(), () => 42)).toBe(42);
  });

  it('keeps the store visible across await and setImmediate', async () => {
    const store = newRequestContext({ requestId: 'async-req' });
    const seen = await runWithRequestContext(store, async () => {
      await Promise.resolve();
      const afterAwait = currentRequestContext();
      await nextTick();
      const afterImmediate = currentRequestContext();
      const inCallback = await new Promise<RequestContextStore | undefined>((resolve) => {
        setImmediate(() => {
          resolve(currentRequestContext());
        });
      });
      return [afterAwait, afterImmediate, inCallback];
    });
    expect(seen).toHaveLength(3);
    for (const visible of seen) {
      expect(visible).toBe(store);
    }
    expect(currentRequestContext()).toBeUndefined();
  });

  it('isolates concurrent requests and restores the outer store after a nested run', async () => {
    const outer = newRequestContext({ requestId: 'outer' });
    const inner = newRequestContext({ requestId: 'inner' });
    const ids = await runWithRequestContext(outer, async () => {
      const nested = runWithRequestContext(inner, async () => {
        await nextTick();
        return requireRequestContext().requestId;
      });
      await nextTick();
      return [requireRequestContext().requestId, await nested, requireRequestContext().requestId];
    });
    expect(ids).toEqual(['outer', 'inner', 'outer']);
  });

  it('runs on the exported requestContext store', () => {
    const store = newRequestContext();
    expect(runWithRequestContext(store, () => requestContext.getStore())).toBe(store);
  });
});

describe('requireRequestContext', () => {
  it('throws NoRequestContextError outside a request', () => {
    let thrown: unknown;
    try {
      requireRequestContext();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NoRequestContextError);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ name: 'NoRequestContextError', message: 'No request context is active' });
  });

  it('returns the active store inside a request', () => {
    const store = newRequestContext();
    expect(runWithRequestContext(store, requireRequestContext)).toBe(store);
  });
});

describe('throwIfRequestAborted', () => {
  it.each<[string, () => void]>([
    ['outside a request', throwIfRequestAborted],
    ['in a request without a signal', () => runWithRequestContext(newRequestContext(), throwIfRequestAborted)],
    ['in a request whose signal has not aborted', () => runWithRequestContext({ ...newRequestContext(), signal: new AbortController().signal }, throwIfRequestAborted)],
  ])('does nothing %s', (_label, run) => {
    expect(run).not.toThrow();
  });

  it("throws the signal's RequestAbortedError once it has aborted, also after an await", async () => {
    const disconnect = new AbortController();
    const reason = new RequestAbortedError();
    const store = { ...newRequestContext(), signal: disconnect.signal };
    const thrown = await runWithRequestContext(store, async () => {
      throwIfRequestAborted();
      disconnect.abort(reason);
      await nextTick();
      try {
        throwIfRequestAborted();
      } catch (error) {
        return error;
      }
      return undefined;
    });
    expect(thrown).toBe(reason);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ name: 'RequestAbortedError', message: 'The client disconnected before the answer' });
  });
});

describe('recordWritePosition', () => {
  function positionsAfter(calls: Array<[string, string | bigint]>): Map<string, string> {
    const store = newRequestContext();
    runWithRequestContext(store, () => {
      for (const [owner, xid] of calls) {
        recordWritePosition(owner, xid);
      }
    });
    return store.writePositions;
  }

  it.each([
    ['a lower xid after a higher one', [['people', '10'], ['people', '9']], '10'],
    ['a higher xid after a lower one', [['people', '9'], ['people', '10']], '10'],
    ['an equal xid', [['people', '10'], ['people', '10']], '10'],
    ['bigint and string inputs', [['people', 7n], ['people', '12'], ['people', 11n]], '12'],
    [
      'xids above 2^53 that collide as numbers',
      [['people', '9007199254740993'], ['people', '9007199254740992']],
      '9007199254740993',
    ],
    [
      'xids above 2^53 recorded in ascending order',
      [['people', 9007199254740992n], ['people', '18446744073709551615']],
      '18446744073709551615',
    ],
  ] as Array<[string, Array<[string, string | bigint]>, string]>)('keeps the maximum for %s', (_label, calls, expected) => {
    expect(positionsAfter(calls).get('people')).toBe(expected);
  });

  it('stores a bigint as its decimal string', () => {
    expect(positionsAfter([['identity', 42n]]).get('identity')).toBe('42');
  });

  it('tracks each owner independently', () => {
    const positions = positionsAfter([
      ['people', '100'],
      ['identity', '5'],
      ['people', '50'],
      ['identity', '6'],
    ]);
    expect(Object.fromEntries(positions)).toEqual({ people: '100', identity: '6' });
  });

  it('throws NoRequestContextError outside a request', () => {
    expect(() => {
      recordWritePosition('people', '10');
    }).toThrow(NoRequestContextError);
  });

  it('rejects an xid that is not an integer', () => {
    const store = newRequestContext();
    expect(() => {
      runWithRequestContext(store, () => {
        recordWritePosition('people', 'not-a-number');
      });
    }).toThrow(SyntaxError);
    expect(store.writePositions.size).toBe(0);
  });
});
