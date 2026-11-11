import { describe, expect, it } from 'vitest';
import { IDENTITY_SERVICE, ServiceUnavailableError, type Clock } from '@opt2/platform/service-kit';
import type { IdentityClient, TokenRequest, UserTokenResponse } from '../../src/session/identity-client.js';
import { DEFAULT_SITE_ID, createTokenCache } from '../../src/session/token-cache.js';

const START = Date.UTC(2026, 5, 30, 12);
const SECOND = 1000;
const LIFETIME_SECONDS = 300;
// Differs from every caller epoch, so a cache hit shows the entry carries the caller's epoch.
const IDENTITY_EPOCH = 41;
const TENANT = '00000000-0000-4000-8000-000000000001';

/** A clock the test sets to `START` plus an offset in milliseconds. */
interface ManualClock extends Clock {
  at(offsetMs: number): void;
}

function manualClock(): ManualClock {
  let now = START;
  return {
    now: () => new Date(now),
    at(offsetMs) {
      now = START + offsetMs;
    },
  };
}

interface HeldMint {
  response: UserTokenResponse;
  resolve(response: UserTokenResponse): void;
  reject(error: unknown): void;
}

/** Identity double minting `<session>@<site>#<n>` for the n-th call, valid for `lifetime` seconds. */
interface FakeIdentity {
  client: IdentityClient;
  requests: TokenRequest[];
  lifetime: number;
  /** When true, mints wait for `release` or `fail`. */
  hold: boolean;
  release(n: number): void;
  fail(n: number, error: unknown): void;
}

function fakeIdentity(clock: Clock): FakeIdentity {
  const held = new Map<number, HeldMint>();
  const notCalled = (): Promise<never> => Promise.reject(new Error('unexpected identity call'));

  function heldMint(n: number): HeldMint {
    const mint = held.get(n);
    if (mint === undefined) throw new Error(`mint ${n} is not held`);
    return mint;
  }

  const fake: FakeIdentity = {
    requests: [],
    lifetime: LIFETIME_SECONDS,
    hold: false,
    client: {
      mintToken(request) {
        fake.requests.push(request);
        const n = fake.requests.length;
        const iat = clock.now().getTime() / SECOND;
        const exp = iat + fake.lifetime;
        const response: UserTokenResponse = {
          token: `${request.sessionId}@${request.siteId}#${n}`,
          expiresAt: exp,
          epoch: IDENTITY_EPOCH,
          claims: {
            iss: 'opt2-local-identity',
            aud: 'opt2-local',
            sub: '',
            sid: request.sessionId,
            tid: TENANT,
            site: request.siteId,
            roles: [],
            s2: false,
            epoch: IDENTITY_EPOCH,
            iat,
            exp,
          },
        };
        if (!fake.hold) return Promise.resolve(response);
        return new Promise((resolve, reject) => held.set(n, { response, resolve, reject }));
      },
      authenticate: notCalled,
      adopt: notCalled,
      state: notCalled,
      snapshot: notCalled,
      end: notCalled,
      claim: notCalled,
      settle: notCalled,
    },
    release(n) {
      const mint = heldMint(n);
      mint.resolve(mint.response);
    },
    fail(n, error) {
      heldMint(n).reject(error);
    },
  };
  return fake;
}

function setup() {
  const clock = manualClock();
  const identity = fakeIdentity(clock);
  const cache = createTokenCache({ identity: identity.client, clock });
  return { clock, identity, cache };
}

const identityFailure = (): ServiceUnavailableError =>
  new ServiceUnavailableError(IDENTITY_SERVICE, new Error(`${IDENTITY_SERVICE} answered HTTP 503`));

describe('createTokenCache', () => {
  it('mints through identity and serves the cached token on the next get', async () => {
    const { identity, cache } = setup();
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#1');
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#1');
    expect(identity.requests).toEqual([{ sessionId: 's1', siteId: 'site-a' }]);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('falls back to the default site when the site id is %s', async (_case, siteId) => {
    const { identity, cache } = setup();
    expect(await cache.get('s1', siteId, 1)).toBe('s1@default#1');
    expect(await cache.get('s1', DEFAULT_SITE_ID, 1)).toBe('s1@default#1');
    expect(identity.requests).toEqual([{ sessionId: 's1', siteId: 'default' }]);
  });

  it.each([
    ['session', 's2', 'site-a'],
    ['site', 's1', 'site-b'],
  ])('mints separately for another %s', async (_case, sessionId, siteId) => {
    const { identity, cache } = setup();
    await cache.get('s1', 'site-a', 1);
    expect(await cache.get(sessionId, siteId, 1)).toBe(`${sessionId}@${siteId}#2`);
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#1');
    expect(identity.requests).toHaveLength(2);
  });

  it('replaces the cached token when the epoch changes', async () => {
    const { cache } = setup();
    await cache.get('s1', 'site-a', 1);
    expect(await cache.get('s1', 'site-a', 2)).toBe('s1@site-a#2');
    expect(await cache.get('s1', 'site-a', 2)).toBe('s1@site-a#2');
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#3');
  });

  it('serves a token until the expiry identity reports in epoch seconds', async () => {
    const { clock, cache } = setup();
    await cache.get('s1', 'site-a', 1);
    clock.at(LIFETIME_SECONDS * SECOND - 1);
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#1');
    clock.at(LIFETIME_SECONDS * SECOND);
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#2');
  });
});

// Turning the clock back shows whether an expired entry was pruned or only passed over.
describe('expired entry pruning', () => {
  it('prunes an expired head entry when another session gets a token', async () => {
    const { clock, cache } = setup();
    await cache.get('s1', 'site-a', 1);
    clock.at(LIFETIME_SECONDS * SECOND);
    await cache.get('s2', 'site-a', 1);
    clock.at(0);
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#3');
  });

  it('stops pruning at the first unexpired entry', async () => {
    const { clock, identity, cache } = setup();
    identity.lifetime = 2 * LIFETIME_SECONDS;
    await cache.get('s1', 'site-a', 1);
    identity.lifetime = LIFETIME_SECONDS;
    await cache.get('s2', 'site-a', 1);
    clock.at(LIFETIME_SECONDS * SECOND);
    await cache.get('s3', 'site-a', 1);
    clock.at(0);
    expect(await cache.get('s2', 'site-a', 1)).toBe('s2@site-a#2');
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#1');
  });

  it('mints again for an expired entry behind an unexpired one', async () => {
    const { clock, identity, cache } = setup();
    identity.lifetime = 2 * LIFETIME_SECONDS;
    await cache.get('s1', 'site-a', 1);
    identity.lifetime = LIFETIME_SECONDS;
    await cache.get('s2', 'site-a', 1);
    clock.at(LIFETIME_SECONDS * SECOND);
    expect(await cache.get('s2', 'site-a', 1)).toBe('s2@site-a#3');
  });

  it('moves a re-minted entry behind the entries minted before it', async () => {
    const { clock, cache } = setup();
    // Expiries: s1 #1 at 300 s, s2 #2 at 400 s, s1 #3 at 450 s.
    await cache.get('s1', 'site-a', 1);
    clock.at(100 * SECOND);
    await cache.get('s2', 'site-a', 1);
    clock.at(150 * SECOND);
    await cache.get('s1', 'site-a', 2);
    clock.at(420 * SECOND);
    await cache.get('s3', 'site-a', 1);
    clock.at(200 * SECOND);
    expect(await cache.get('s2', 'site-a', 1)).toBe('s2@site-a#5');
    expect(await cache.get('s1', 'site-a', 2)).toBe('s1@site-a#3');
  });
});

describe('in-flight mints', () => {
  it('shares one mint between callers of the same epoch', async () => {
    const { identity, cache } = setup();
    identity.hold = true;
    const first = cache.get('s1', 'site-a', 1);
    const second = cache.get('s1', 'site-a', 1);
    expect(identity.requests).toHaveLength(1);
    identity.release(1);
    expect(await Promise.all([first, second])).toEqual(['s1@site-a#1', 's1@site-a#1']);
  });

  it('returns a mint superseded by a newer epoch to its caller without caching it', async () => {
    const { identity, cache } = setup();
    identity.hold = true;
    const older = cache.get('s1', 'site-a', 1);
    const newer = cache.get('s1', 'site-a', 2);
    expect(identity.requests).toHaveLength(2);
    identity.release(2);
    expect(await newer).toBe('s1@site-a#2');
    identity.release(1);
    expect(await older).toBe('s1@site-a#1');
    identity.hold = false;
    expect(await cache.get('s1', 'site-a', 2)).toBe('s1@site-a#2');
    expect(identity.requests).toHaveLength(2);
  });
});

describe('drop', () => {
  it('forgets the cached tokens of the dropped session only', async () => {
    const { cache } = setup();
    await cache.get('s1', 'site-a', 1);
    await cache.get('s1', 'site-b', 1);
    await cache.get('s10', 'site-a', 1);
    cache.drop('s1');
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#4');
    expect(await cache.get('s1', 'site-b', 1)).toBe('s1@site-b#5');
    expect(await cache.get('s10', 'site-a', 1)).toBe('s10@site-a#3');
  });

  it('returns a mint superseded by drop to its caller without caching it', async () => {
    const { identity, cache } = setup();
    identity.hold = true;
    const dropped = cache.get('s1', 'site-a', 1);
    const kept = cache.get('s2', 'site-a', 1);
    cache.drop('s1');
    identity.release(1);
    identity.release(2);
    expect(await dropped).toBe('s1@site-a#1');
    expect(await kept).toBe('s2@site-a#2');
    identity.hold = false;
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#3');
    expect(await cache.get('s2', 'site-a', 1)).toBe('s2@site-a#2');
  });
});

describe('identity errors', () => {
  it('rejects every joined caller with the identity error unchanged, then mints again', async () => {
    const { identity, cache } = setup();
    const error = identityFailure();
    identity.hold = true;
    const first = cache.get('s1', 'site-a', 1);
    const second = cache.get('s1', 'site-a', 1);
    identity.fail(1, error);
    await Promise.all([expect(first).rejects.toBe(error), expect(second).rejects.toBe(error)]);
    identity.hold = false;
    expect(await cache.get('s1', 'site-a', 1)).toBe('s1@site-a#2');
  });

  it('keeps the newer mint in flight when a mint superseded by drop fails', async () => {
    const { identity, cache } = setup();
    const error = identityFailure();
    identity.hold = true;
    const dropped = cache.get('s1', 'site-a', 1);
    cache.drop('s1');
    const fresh = cache.get('s1', 'site-a', 1);
    identity.fail(1, error);
    await expect(dropped).rejects.toBe(error);
    const joined = cache.get('s1', 'site-a', 1);
    expect(identity.requests).toHaveLength(2);
    identity.release(2);
    expect(await Promise.all([fresh, joined])).toEqual(['s1@site-a#2', 's1@site-a#2']);
  });
});
