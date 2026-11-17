// Carry of the session values target routes keep in identity into the legacy session of legacy-bound admin requests.
import { createHash } from 'node:crypto';
import { jsessionidForSessionId } from '@opt2/platform/legacy-compat';
import { IDENTITY_SERVICE, ServiceUnavailableError, fixedClock } from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeCallOptions, CarriedValue, LegacyCookies } from '../../src/session/bridge-client.js';
import { CARRIED_SESSION_KEYS, createSessionCarry } from '../../src/session/carry.js';
import type { SessionAdminState } from '../../src/session/identity-client.js';
import type { JarCookies, JarRow } from '../../src/session/jar.js';
import type { SessionMode } from '../../src/session/mode.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const SESSION_ID = 'identity-session-carry';
const LEGACY_SESSION_ID = 'OPT2CARRY_1001_12345678';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) OPT2-test';
const LIVE: JarCookies = {
  CFID: { name: 'CFID', value: '1001', attributes: 'path=/;HttpOnly' },
  CFTOKEN: { name: 'CFTOKEN', value: '12345678', attributes: 'path=/;HttpOnly' },
};
/** carch.list's defaults for the session site (list.cfm:494-584), as strategies-content stores them. */
const FLAT_VIEW_ARGS = {
  'tenant-a': { moduleid: '00000000000000000000000000000000000', sortby: 'lastupdate', sortdirection: 'desc', page: 1, tab: 0, filtered: false },
};

type Call = [op: string, ...args: unknown[]];

/** The revision the carry sends for `value`. */
function revisionOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function jarRow(overrides: Partial<JarRow> = {}): JarRow {
  return {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    cookies: LIVE,
    mode: 'target-primary',
    hydratedEpoch: 3,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Seam {
  calls: Call[];
  carry: ReturnType<typeof createSessionCarry>;
}

/** A carry over a jar holding `row`, identity answering `state` (or failing with it) and a bridge failing with `bridgeError` when set. */
function seam(opts: { row?: JarRow; state?: SessionAdminState | Error; bridgeError?: Error } = {}): Seam {
  const calls: Call[] = [];
  const row = Object.hasOwn(opts, 'row') ? opts.row : jarRow();
  const carry = createSessionCarry({
    identity: {
      async adminState(sessionId) {
        calls.push(['identity.adminState', sessionId]);
        if (opts.state instanceof Error) throw opts.state;
        return opts.state ?? {};
      },
    },
    bridge: {
      async carry(cookies: LegacyCookies, values: CarriedValue[], call: BridgeCallOptions) {
        calls.push(['bridge.carry', cookies, values, call]);
        if (opts.bridgeError !== undefined) throw opts.bridgeError;
        return { body: { applied: values.map(({ name }) => name), serverTime: '' }, setCookies: [] };
      },
    },
    jar: { get: async () => row },
    clock: fixedClock(NOW),
  });
  return { calls, carry };
}

/** The bridge's answer when the cookies no longer attach the named legacy session. */
function sessionMismatch(): ServiceUnavailableError {
  return new ServiceUnavailableError('legacy-bridge', Object.assign(new Error('mismatch'), { status: 409, error: 'sessionMismatch' }));
}

describe('createSessionCarry', () => {
  it('carries only carch.list flatViewArgs, the value strategies-content keeps under mura', () => {
    expect(CARRIED_SESSION_KEYS).toEqual(['flatViewArgs']);
  });

  it('installs the stored flatViewArgs with the live jar cookies, the legacy session id, the user agent and its SHA-256 revision', async () => {
    const expired: JarCookies = { JSESSIONID: { name: 'JSESSIONID', value: 'gone', attributes: 'path=/;expires=Thu, 01-Jan-1970 00:00:00 GMT' } };
    const { calls, carry } = seam({
      row: jarRow({ cookies: { ...LIVE, ...expired } }),
      state: { siteid: 'tenant-a', mura: { FlatViewArgs: FLAT_VIEW_ARGS, nextN: '20' } },
    });

    await carry.beforeLegacy(SESSION_ID, 'target-primary', { userAgent: USER_AGENT });

    expect(calls).toEqual([
      ['identity.adminState', SESSION_ID],
      [
        'bridge.carry',
        LIVE,
        [{ name: 'flatViewArgs', value: FLAT_VIEW_ARGS, revision: revisionOf(FLAT_VIEW_ARGS) }],
        { legacySessionId: LEGACY_SESSION_ID, userAgent: USER_AGENT },
      ],
    ]);
  });

  it('sends the same revision for an unchanged value and a new one once a target route changed it', async () => {
    const changed = { 'tenant-a': { ...FLAT_VIEW_ARGS['tenant-a'], tab: 1 } };
    const first = seam({ state: { mura: { flatViewArgs: FLAT_VIEW_ARGS } } });
    const again = seam({ state: { mura: { flatViewArgs: { ...FLAT_VIEW_ARGS } } } });
    const next = seam({ state: { mura: { flatViewArgs: changed } } });

    for (const { carry } of [first, again, next]) await carry.beforeLegacy(SESSION_ID, 'target-primary');

    const revisions = [first, again, next].map(({ calls }) => (calls[1]?.[2] as CarriedValue[] | undefined)?.[0]?.revision);
    expect(revisions).toEqual([revisionOf(FLAT_VIEW_ARGS), revisionOf(FLAT_VIEW_ARGS), revisionOf(changed)]);
    expect(revisions[2]).not.toBe(revisions[0]);
  });

  it.each<[string, SessionAdminState]>([
    ['no admin state', {}],
    ['no session.mura values', { siteid: 'tenant-a' }],
    ['session.mura without flatViewArgs', { mura: { nextN: '20' } }],
    ['flatViewArgs that is not a struct', { mura: { flatViewArgs: 'tenant-a' } }],
    ['flatViewArgs that is an array', { mura: { flatViewArgs: [FLAT_VIEW_ARGS] } }],
  ])('calls no bridge op when identity holds %s', async (_label, state) => {
    const { calls, carry } = seam({ state });

    await carry.beforeLegacy(SESSION_ID, 'target-primary');

    expect(calls).toEqual([['identity.adminState', SESSION_ID]]);
  });

  it.each<[string, JarRow | undefined]>([
    ['no jar', undefined],
    ['a jar without a legacy session id', jarRow({ legacySessionId: null })],
    ['a jar whose cookies are all deleted', jarRow({ cookies: { CFID: { name: 'CFID', value: '', attributes: 'path=/;' } } })],
  ])('reads nothing from identity for a session with %s', async (_label, row) => {
    const { calls, carry } = seam({ row, state: { mura: { flatViewArgs: FLAT_VIEW_ARGS } } });

    await carry.beforeLegacy(SESSION_ID, 'target-primary');

    expect(calls).toEqual([]);
  });

  it.each<[SessionMode, boolean]>([
    ['legacy-primary', true],
    ['target-primary', false],
  ])('in %s, an unavailable identity leaves the legacy session as it is: %s', async (mode, tolerated) => {
    const down = new ServiceUnavailableError(IDENTITY_SERVICE, new Error('refused'));
    const { calls, carry } = seam({ state: down });

    const outcome = carry.beforeLegacy(SESSION_ID, mode);

    if (tolerated) await expect(outcome).resolves.toBeUndefined();
    else await expect(outcome).rejects.toBe(down);
    expect(calls.map(([op]) => op)).toEqual(['identity.adminState']);
  });

  it.each<[string, SessionMode, () => Error, boolean]>([
    ['a session mismatch in legacy-primary', 'legacy-primary', sessionMismatch, true],
    ['a session mismatch in target-primary', 'target-primary', sessionMismatch, false],
    ['an unreachable bridge in legacy-primary', 'legacy-primary', () => new ServiceUnavailableError('legacy-bridge', new Error('refused')), false],
  ])('settles %s as tolerated: %s', async (_label, mode, failure, tolerated) => {
    const error = failure();
    const { carry } = seam({ state: { mura: { flatViewArgs: FLAT_VIEW_ARGS } }, bridgeError: error });

    const outcome = carry.beforeLegacy(SESSION_ID, mode);

    if (tolerated) await expect(outcome).resolves.toBeUndefined();
    else await expect(outcome).rejects.toBe(error);
  });
});

describe('carch.loadSiteFlat after a target-served carch.list at the committed v0002 (target-primary)', () => {
  const GATEWAY_SESSION = 'D4E5F6A7-B8C9-D0E1-F2A3B4C5D6E7F8A9';
  const TARGET_COOKIE = `CFID=T-CFID-7201; CFTOKEN=T-CFTOKEN-7201; JSESSIONID=${jsessionidForSessionId(GATEWAY_SESSION)}`;
  const USER_ID = 'USER-CARRY-0001';
  const LOAD_SITE_FLAT = '/admin/?muraAction=cArch.loadSiteFlat';
  const FORM = 'siteID=tenant-a&moduleid=00000000000000000000000000000000000&sortBy=lastupdate&sortDirection=desc&page=1';
  /** loadsiteflat.cfm:109 reads session.flatViewArgs without a default. */
  const UNDEFINED_ELEMENT = 'Element FLATVIEWARGS is undefined in SESSION.';

  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  /** A gateway at v0002 whose identity session stored `adminState`, and whose legacy answers loadSiteFlat as loadsiteflat.cfm does. */
  async function start(adminState: SessionAdminState): Promise<TestGateway> {
    gateway = await buildTestGateway({
      version: 'v0002',
      identity: {
        sessions: [
          {
            sessionId: GATEWAY_SESSION,
            userId: USER_ID,
            epoch: 3,
            state: 'active',
            mode: 'target-primary',
            adminState,
            snapshot: {
              sessionId: GATEWAY_SESSION,
              epoch: 3,
              loginSnapshot: { user: { userID: USER_ID, username: 'admin', siteID: 'default', membershipIds: USER_ID }, roles: ['S2'] },
              csrfSecretKey: 'CSRF-SECRET-CARRY',
              usedTokens: [],
            },
          },
        ],
      },
    });
    gateway.legacy.setResponse((req, attached) => {
      if (!req.url.startsWith(LOAD_SITE_FLAT)) return {};
      if (attached?.values.flatViewArgs === undefined) return { status: 500, body: UNDEFINED_ELEMENT };
      // loadsiteflat.cfm:108-125 writes the request's arguments over the session site's entry.
      const flat = attached.values.flatViewArgs as Record<string, unknown>;
      attached.values = { ...attached.values, flatViewArgs: { ...flat, 'tenant-a': { sortBy: 'lastupdate', tab: 1 } } };
      return { body: '<div class="btn-group" id="flatViewArgs">' };
    });
    return gateway;
  }

  const loadSiteFlat = (app: TestGateway['app']) =>
    app.inject({
      method: 'POST',
      url: LOAD_SITE_FLAT,
      headers: { cookie: TARGET_COOKIE, 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded' },
      payload: FORM,
    });

  it('renders the flat view in the legacy session hydrated for the session, holding the flatViewArgs carch.list stored', async () => {
    const { app, identity, legacy } = await start({ siteid: 'tenant-a', mura: { flatViewArgs: FLAT_VIEW_ARGS } });

    const first = await loadSiteFlat(app);
    const second = await loadSiteFlat(app);

    expect([first.statusCode, first.body]).toEqual([200, '<div class="btn-group" id="flatViewArgs">']);
    expect(second.statusCode).toBe(200);
    expect(identity.calls.adminState).toBe(2);
    const ops = legacy.bridgeCalls.map(({ op, status, body }) => [op, status, op === 'carry' ? body : undefined]);
    expect(ops.filter(([op]) => op === 'carry')).toEqual([
      ['carry', 200, { applied: ['flatViewArgs'], serverTime: expect.any(String) }],
      ['carry', 200, { applied: [], serverTime: expect.any(String) }],
    ]);
    const hydrated = legacy.bridgeCalls.find((call) => call.op === 'hydrate')?.legacySessionId ?? '';
    expect(legacy.bridgeCalls.filter((call) => call.op === 'carry').map((call) => call.legacySessionId)).toEqual([hydrated, hydrated]);
    // The unchanged revision left loadSiteFlat's own write to the session site's entry standing.
    expect(legacy.sessions.get(hydrated)?.values.flatViewArgs).toEqual({ ...FLAT_VIEW_ARGS, 'tenant-a': { sortBy: 'lastupdate', tab: 1 } });
  });

  it('carries nothing while identity holds no flatViewArgs for the session', async () => {
    const { app, identity, legacy } = await start({ siteid: 'tenant-a' });

    const res = await loadSiteFlat(app);

    expect([res.statusCode, res.body]).toEqual([500, UNDEFINED_ELEMENT]);
    expect(identity.calls.adminState).toBe(1);
    expect(legacy.bridgeCalls.map(({ op }) => op)).not.toContain('carry');
  });
});
