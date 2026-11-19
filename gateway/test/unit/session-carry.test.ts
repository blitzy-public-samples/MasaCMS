// The session values legacy-bound admin requests share with target routes: identity's carried in before, legacy's imported after.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { jsessionidForSessionId } from '@opt2/platform/legacy-compat';
import { IDENTITY_SERVICE, ServiceUnavailableError, fixedClock } from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeCallOptions, CarriedValue, CarryResult, ExportedValue, LegacyCookies } from '../../src/session/bridge-client.js';
import { SHARED_SESSION_VALUES, createSessionCarry } from '../../src/session/carry.js';
import type { SessionAdminState } from '../../src/session/identity-client.js';
import type { JarCookies, JarRow } from '../../src/session/jar.js';
import type { SessionMode } from '../../src/session/mode.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import { TEST_CLOCK } from '../helpers/env.js';
import { SHARED_NAMES, sharedValue, type CarriedUserBean } from '../helpers/legacy-origin.js';

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

/** `session.flatViewArgs`: each site's flat view arguments. */
type FlatViewArgs = Record<string, Record<string, unknown>>;

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

interface SeamOptions {
  row?: JarRow;
  /** identity's stored admin state, or the error its reads fail with. */
  state?: SessionAdminState | Error;
  /** The error every bridge op fails with. */
  bridgeError?: Error;
  /** What `op=export` lists. */
  exported?: ExportedValue[];
  /** The error identity's import fails with. */
  importError?: Error;
}

/** A carry over a jar holding `row`, an identity and a bridge that record their calls and answer as `opts` says. */
function seam(opts: SeamOptions = {}): Seam {
  const calls: Call[] = [];
  const row = Object.hasOwn(opts, 'row') ? opts.row : jarRow();
  const carry = createSessionCarry({
    identity: {
      async adminState(sessionId) {
        calls.push(['identity.adminState', sessionId]);
        if (opts.state instanceof Error) throw opts.state;
        return opts.state ?? {};
      },
      async importAdminState(sessionId, values, muraBases) {
        calls.push(muraBases === undefined ? ['identity.importAdminState', sessionId, values] : ['identity.importAdminState', sessionId, values, muraBases]);
        if (opts.importError !== undefined) throw opts.importError;
        return values;
      },
    },
    bridge: {
      async carry(cookies: LegacyCookies, values: CarriedValue[], call: BridgeCallOptions) {
        calls.push(['bridge.carry', cookies, values, call]);
        if (opts.bridgeError !== undefined) throw opts.bridgeError;
        return { body: { applied: values.map(({ name }) => name), serverTime: '' }, setCookies: [] };
      },
      async export(cookies: LegacyCookies, call: BridgeCallOptions) {
        calls.push(['bridge.export', cookies, call]);
        if (opts.bridgeError !== undefined) throw opts.bridgeError;
        return { body: { values: opts.exported ?? [], serverTime: '' }, setCookies: [] };
      },
    },
    jar: { get: async () => row },
    clock: fixedClock(NOW),
  });
  return { calls, carry };
}

/** session.cfm's `sharedNames` list, read from the bridge page itself. */
function bridgeSharedNames(): string[] {
  const page = readFileSync(new URL('../../legacy-bridge/cfml/session.cfm', import.meta.url), 'utf8');
  const list = /^sharedNames = \[(.*)\];$/m.exec(page)?.[1];
  if (list === undefined) throw new Error('session.cfm declares no sharedNames');
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

/** The bridge's answer when the cookies no longer attach the named legacy session. */
function sessionMismatch(): ServiceUnavailableError {
  return new ServiceUnavailableError('legacy-bridge', Object.assign(new Error('mismatch'), { status: 409, error: 'sessionMismatch' }));
}

describe('createSessionCarry', () => {
  it("shares the values session.cfm lists: the flat view, rows, alerts and object instance under mura; the site, its paths, the search keywords, the FW/1 counter and contexts, the module and its tops and login's strike block at the top", () => {
    expect(SHARED_SESSION_VALUES).toEqual([
      { wire: 'flatViewArgs', identity: 'mura.flatViewArgs' },
      { wire: 'mura.nextN', identity: 'mura.nextN' },
      { wire: 'mura.alerts', identity: 'mura.alerts' },
      { wire: 'siteid', identity: 'siteid' },
      { wire: 'userFilesPath', identity: 'userFilesPath' },
      { wire: 'topID', identity: 'topID' },
      { wire: 'openSectionList', identity: 'openSectionList' },
      { wire: 'keywords', identity: 'keywords' },
      { wire: 'datakeywords', identity: 'datakeywords' },
      { wire: 'filterBy', identity: 'filterBy' },
      { wire: '__fw1NextPreserveKey', identity: 'nextPreserveKey' },
      { wire: '__fw1', identity: 'flash' },
      { wire: 'moduleid', identity: 'moduleid' },
      { wire: 'moduleTopIds', identity: 'moduleTopIds' },
      { wire: 'mura.objectInstanceId', identity: 'mura.objectInstanceId' },
      { wire: 'blockLoginUntil', identity: 'blockLoginUntil' },
    ]);
    expect(SHARED_SESSION_VALUES.map(({ wire }) => wire)).toEqual(bridgeSharedNames());
    expect(SHARED_NAMES).toEqual(bridgeSharedNames());
  });

  it('installs every stored shared value with the live jar cookies, the legacy session id, the user agent and its SHA-256 revision', async () => {
    const expired: JarCookies = { JSESSIONID: { name: 'JSESSIONID', value: 'gone', attributes: 'path=/;expires=Thu, 01-Jan-1970 00:00:00 GMT' } };
    const alerts = { 'tenant-a': { cachenotice: false } };
    const { calls, carry } = seam({
      row: jarRow({ cookies: { ...LIVE, ...expired } }),
      state: { siteid: 'tenant-a', keywords: 'home', rb: 'en', mura: { FlatViewArgs: FLAT_VIEW_ARGS, NEXTN: '20', alerts, objectInstanceId: 'I1' } },
    });

    await carry.beforeLegacy(SESSION_ID, 'target-primary', { userAgent: USER_AGENT });

    const carried = (name: string, value: unknown) => ({ name, value, revision: revisionOf(value) });
    expect(calls).toEqual([
      ['identity.adminState', SESSION_ID],
      [
        'bridge.carry',
        LIVE,
        [
          carried('flatViewArgs', FLAT_VIEW_ARGS),
          carried('mura.nextN', '20'),
          carried('mura.alerts', alerts),
          carried('siteid', 'tenant-a'),
          carried('keywords', 'home'),
          carried('mura.objectInstanceId', 'I1'),
        ],
        { legacySessionId: LEGACY_SESSION_ID, userAgent: USER_AGENT },
      ],
    ]);
  });

  it.each<[string, SessionAdminState, SessionAdminState['flash'] | undefined]>([
    ['the contexts from ten keys before the counter on', { nextPreserveKey: 13, flash: { '2': { a: '2' }, '3': { a: '3' }, '12': { a: '12' }, x: { a: 'x' } } }, { '3': { a: '3' }, '12': { a: '12' } }],
    ['no contexts once FW/1 has purged them all', { nextPreserveKey: 13, flash: { '1': { a: '1' } } }, undefined],
    ['every context while no counter is stored', { flash: { '1': { siteid: 'default' } } }, { '1': { siteid: 'default' } }],
  ])('carries the FW/1 counter and, of the preserved contexts, %s', async (_label, state, contexts) => {
    const { calls, carry } = seam({ state });

    await carry.beforeLegacy(SESSION_ID, 'target-primary');

    const carried = (name: string, value: unknown) => ({ name, value, revision: revisionOf(value) });
    const expected = [
      ...(state.nextPreserveKey === undefined ? [] : [carried('__fw1NextPreserveKey', state.nextPreserveKey)]),
      ...(contexts === undefined ? [] : [carried('__fw1', contexts)]),
    ];
    expect(calls.find(([op]) => op === 'bridge.carry')?.[2]).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ['a string', 'tenant-a'],
    ['a number', 5],
    ['a boolean', false],
    ['an array', [FLAT_VIEW_ARGS]],
    ['a struct', FLAT_VIEW_ARGS],
  ])('carries a stored value that is %s as it is', async (_label, value) => {
    const { calls, carry } = seam({ state: { mura: { flatViewArgs: value } } });

    await carry.beforeLegacy(SESSION_ID, 'target-primary');

    expect(calls[1]?.[2]).toEqual([{ name: 'flatViewArgs', value, revision: revisionOf(value) }]);
  });

  it.each<[string, string]>([
    ["a strike block's end", '2026-06-30T12:15:00.000'],
    ['no block', ''],
  ])("carries login's strike block as identity stores it and imports it as legacy exports it: %s", async (_label, blockLoginUntil) => {
    const { calls, carry } = seam({ state: { blockLoginUntil }, exported: [{ name: 'blockLoginUntil', value: blockLoginUntil }] });

    await carry.beforeLegacy(SESSION_ID, 'target-primary');
    await carry.afterLegacy(SESSION_ID, 'target-primary');

    expect(calls[1]?.[2]).toEqual([{ name: 'blockLoginUntil', value: blockLoginUntil, revision: revisionOf(blockLoginUntil) }]);
    expect(calls[3]).toEqual(['identity.importAdminState', SESSION_ID, { blockLoginUntil }]);
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
    ['only values no legacy-served view reads', { rb: 'en', dashboardSpan: 30, mura: { editBean: { errors: {} } } }],
    ['a shared mura value that is null', { mura: { nextN: null } }],
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

  it('imports what legacy changed: top-level values as strings, mura values and the flat view under mura', async () => {
    const tab = { 'tenant-a': { TAB: '1', sortby: 'lastupdate' } };
    const alerts = { 'tenant-a': { cachenotice: false } };
    const { calls, carry } = seam({
      exported: [
        { name: 'flatViewArgs', value: tab },
        { name: 'mura.nextN', value: '5' },
        { name: 'mura.alerts', value: alerts },
        { name: 'siteid', value: 'tenant-a' },
        { name: 'userFilesPath', value: '/sites/tenant-a/assets/' },
        { name: 'topID', value: 1 },
        { name: 'openSectionList', value: '' },
        { name: 'keywords', value: true },
        { name: '__fw1NextPreserveKey', value: '13' },
        { name: 'moduleid', value: '00000000000000000000000000000000000' },
        { name: 'moduleTopIds', value: { m00000000000000000000000000000000000: '00000000000000000000000000000000001', '00000000000000000000000000000000004': 1 } },
        { name: 'mura.objectInstanceId', value: '' },
      ],
    });

    await carry.afterLegacy(SESSION_ID, 'target-primary', { userAgent: USER_AGENT });

    expect(calls).toEqual([
      ['bridge.export', LIVE, { legacySessionId: LEGACY_SESSION_ID, userAgent: USER_AGENT }],
      [
        'identity.importAdminState',
        SESSION_ID,
        {
          siteid: 'tenant-a',
          userFilesPath: '/sites/tenant-a/assets/',
          topID: '1',
          openSectionList: '',
          keywords: 'true',
          nextPreserveKey: 13,
          moduleid: '00000000000000000000000000000000000',
          moduleTopIds: { m00000000000000000000000000000000000: '00000000000000000000000000000000001', '00000000000000000000000000000000004': '1' },
          mura: { flatViewArgs: tab, nextN: '5', alerts, objectInstanceId: '' },
        },
      ],
    ]);
  });

  it("imports each carried mura struct with the base legacy changed it from, and the module tops whole", async () => {
    const flat = { 'tenant-a': { ...FLAT_VIEW_ARGS['tenant-a'], tab: 1, filtered: 'No' } };
    const alerts = { 'tenant-a': { cachenotice: true } };
    const alertsBase = { 'tenant-a': { cachenotice: true, pluginnotice: true } };
    const tops = { m00000000000000000000000000000000000: '00000000000000000000000000000000001' };
    const { calls, carry } = seam({
      exported: [
        { name: 'flatViewArgs', value: flat, base: FLAT_VIEW_ARGS },
        { name: 'mura.alerts', value: alerts, base: alertsBase },
        { name: 'moduleTopIds', value: tops, base: { m00000000000000000000000000000000000: '00000000000000000000000000000000002' } },
      ],
    });

    await carry.afterLegacy(SESSION_ID, 'target-primary');

    expect(calls[1]).toEqual([
      'identity.importAdminState',
      SESSION_ID,
      { moduleTopIds: tops, mura: { flatViewArgs: flat, alerts } },
      { flatViewArgs: FLAT_VIEW_ARGS, alerts: alertsBase },
    ]);
  });

  it.each<[string, ExportedValue[]]>([
    ['nothing', []],
    ['only a name no shared value has', [{ name: 'mura.editBean', value: 'B1' }]],
    ['only a top-level value that is not simple', [{ name: 'keywords', value: { home: true } }]],
    ['only a preserve-key counter that is not a positive integer', [{ name: '__fw1NextPreserveKey', value: '1.5' }, { name: '__fw1NextPreserveKey', value: '0' }]],
    ['only preserved contexts, which travel target to legacy only', [{ name: '__fw1', value: { '1': { siteid: 'default' } } }]],
    ['only module tops that are no struct of simple values', [{ name: 'moduleTopIds', value: { m1: { topid: '1' } } }, { name: 'moduleTopIds', value: {} }]],
  ])('imports nothing when legacy exports %s', async (_label, exported) => {
    const { calls, carry } = seam({ exported });

    await carry.afterLegacy(SESSION_ID, 'target-primary');

    expect(calls.map(([op]) => op)).toEqual(['bridge.export']);
  });

  it.each<[string, JarRow | undefined]>([
    ['no jar', undefined],
    ['a jar without a legacy session id', jarRow({ legacySessionId: null })],
    ['a jar whose cookies are all deleted', jarRow({ cookies: { CFID: { name: 'CFID', value: '', attributes: 'path=/;' } } })],
  ])('exports nothing for a session with %s', async (_label, row) => {
    const { calls, carry } = seam({ row, exported: [{ name: 'siteid', value: 'tenant-a' }] });

    await carry.afterLegacy(SESSION_ID, 'target-primary');

    expect(calls).toEqual([]);
  });

  it.each<[string, SessionMode, SeamOptions, boolean]>([
    ['a session mismatch in legacy-primary', 'legacy-primary', { bridgeError: sessionMismatch() }, true],
    ['a session mismatch in target-primary', 'target-primary', { bridgeError: sessionMismatch() }, false],
    ['an unavailable identity in legacy-primary', 'legacy-primary', { importError: new ServiceUnavailableError(IDENTITY_SERVICE, new Error('refused')) }, true],
    ['an unavailable identity in target-primary', 'target-primary', { importError: new ServiceUnavailableError(IDENTITY_SERVICE, new Error('refused')) }, false],
  ])('settles an import that meets %s, tolerating it only in legacy-primary', async (_label, mode, failure, tolerated) => {
    const { carry } = seam({ ...failure, exported: [{ name: 'siteid', value: 'tenant-a' }] });

    const outcome = carry.afterLegacy(SESSION_ID, mode);

    if (tolerated) await expect(outcome).resolves.toBeUndefined();
    else await expect(outcome).rejects.toBe(failure.bridgeError ?? failure.importError);
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

  /**
   * A gateway at v0002 whose identity session stored `adminState`, and whose legacy answers loadSiteFlat as loadsiteflat.cfm
   * does; `targetWrite`, when given, is a target route's store of identity's flatViewArgs while legacy serves the first one.
   */
  async function start(adminState: SessionAdminState, targetWrite?: (flat: FlatViewArgs) => FlatViewArgs): Promise<TestGateway> {
    let pendingWrite = targetWrite;
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
    const { identity } = gateway;
    gateway.legacy.setResponse((req, attached) => {
      if (!req.url.startsWith(LOAD_SITE_FLAT)) return {};
      if (attached?.values.flatViewArgs === undefined) return { status: 500, body: UNDEFINED_ELEMENT };
      // loadsiteflat.cfm:109-134 sets the request's arguments on the session site's struct, filtered as yesNoFormat gives it
      // and tab as 1: a key the struct holds keeps its spelling, a new one ColdFusion serializes upper-cased.
      const flat = attached.values.flatViewArgs as FlatViewArgs;
      attached.values = { ...attached.values, flatViewArgs: { ...flat, 'tenant-a': { ...flat['tenant-a'], sortby: 'lastupdate', filtered: 'No', tab: 1, LOCKID: '' } } };
      const stored = identity.sessions.get(GATEWAY_SESSION)?.adminState;
      if (pendingWrite !== undefined && stored?.mura !== undefined) {
        stored.mura = { ...stored.mura, flatViewArgs: pendingWrite(stored.mura.flatViewArgs as FlatViewArgs) };
        pendingWrite = undefined;
      }
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

  it("renders the flat view in the legacy session hydrated for the session, holding the flatViewArgs carch.list stored, and imports its tab and filtered 'No'", async () => {
    const { app, identity, legacy } = await start({ siteid: 'tenant-a', mura: { flatViewArgs: FLAT_VIEW_ARGS } });
    const written = { 'tenant-a': { ...FLAT_VIEW_ARGS['tenant-a'], filtered: 'No', tab: 1, LOCKID: '' } };

    const first = await loadSiteFlat(app);
    const second = await loadSiteFlat(app);

    expect([first.statusCode, first.body]).toEqual([200, '<div class="btn-group" id="flatViewArgs">']);
    expect(second.statusCode).toBe(200);
    expect(identity.calls.adminState).toBe(2);
    const ops = legacy.bridgeCalls.map(({ op, status, body }) => [op, status, op === 'carry' || op === 'export' ? body : undefined]);
    expect(ops.filter(([op]) => op === 'carry' || op === 'export')).toEqual([
      ['carry', 200, { applied: ['flatViewArgs', 'siteid'], serverTime: expect.any(String) }],
      ['export', 200, { values: [{ name: 'flatViewArgs', value: written, base: FLAT_VIEW_ARGS }], serverTime: expect.any(String) }],
      // identity now holds loadSiteFlat's write, which legacy already holds as well.
      ['carry', 200, { applied: ['flatViewArgs'], serverTime: expect.any(String) }],
      ['export', 200, { values: [], serverTime: expect.any(String) }],
    ]);
    expect(identity.adminStateImports).toEqual([
      { sessionId: GATEWAY_SESSION, values: { mura: { flatViewArgs: written } }, muraBases: { flatViewArgs: FLAT_VIEW_ARGS } },
    ]);
    // The flat view arguments a target-served carch.list then renders, filtered as yesNoFormat gave it.
    expect(identity.sessions.get(GATEWAY_SESSION)?.adminState.mura?.flatViewArgs).toEqual(written);
    const hydrated = legacy.bridgeCalls.find((call) => call.op === 'hydrate')?.legacySessionId ?? '';
    expect(legacy.bridgeCalls.filter((call) => call.op === 'carry' || call.op === 'export').map((call) => call.legacySessionId)).toEqual([
      hydrated,
      hydrated,
      hydrated,
      hydrated,
    ]);
    expect(legacy.sessions.get(hydrated)?.values.flatViewArgs).toEqual(written);
  });

  it.each<[string, (flat: FlatViewArgs) => FlatViewArgs]>([
    ["another site's keywords", (flat) => ({ ...flat, 'tenant-b': { ...flat['tenant-b'], keywords: 'about' } })],
    ["the session site's keywords", (flat) => ({ ...flat, 'tenant-a': { ...flat['tenant-a'], keywords: 'raceNx' } })],
  ])("keeps %s a target route stored while legacy served loadSiteFlat beside legacy's changes, and carries the merged value next", async (_label, targetWrite) => {
    const carried = { 'tenant-a': { ...FLAT_VIEW_ARGS['tenant-a'], keywords: '' }, 'tenant-b': { tab: 0, keywords: '' } };
    const { app, identity, legacy } = await start({ siteid: 'tenant-a', mura: { flatViewArgs: carried } }, targetWrite);
    const target = targetWrite(carried);
    const merged = { ...target, 'tenant-a': { ...target['tenant-a'], filtered: 'No', tab: 1, LOCKID: '' } };

    await loadSiteFlat(app);
    const afterFirst = identity.sessions.get(GATEWAY_SESSION)?.adminState.mura?.flatViewArgs;
    await loadSiteFlat(app);

    expect(afterFirst).toEqual(merged);
    expect(identity.adminStateImports).toHaveLength(1);
    const carries = legacy.bridgeCalls.filter(({ op }) => op === 'carry').map(({ body }) => body);
    expect(carries[1]).toEqual({ applied: ['flatViewArgs'], serverTime: expect.any(String) });
    const hydrated = legacy.bridgeCalls.find((call) => call.op === 'hydrate')?.legacySessionId ?? '';
    expect(legacy.sessions.get(hydrated)?.values.flatViewArgs).toEqual(merged);
  });

  it('carries no flatViewArgs while identity holds none for the session, so loadSiteFlat fails as on legacy', async () => {
    const { app, identity, legacy } = await start({ siteid: 'tenant-a' });

    const res = await loadSiteFlat(app);

    expect([res.statusCode, res.body]).toEqual([500, UNDEFINED_ELEMENT]);
    expect(identity.calls.adminState).toBe(1);
    const carried = legacy.bridgeCalls.filter(({ op }) => op === 'carry').map(({ body }) => body);
    expect(carried).toEqual([{ applied: ['siteid'], serverTime: expect.any(String) }]);
    expect(identity.adminStateImports).toEqual([]);
  });
});

describe('shared session values across target-served and legacy-served admin requests at the committed v0002 (target-primary)', () => {
  const GATEWAY_SESSION = 'E5F6A7B8-C9D0-E1F2-A3B4C5D6E7F8A9B0';
  const TARGET_COOKIE = `CFID=T-CFID-7301; CFTOKEN=T-CFTOKEN-7301; JSESSIONID=${jsessionidForSessionId(GATEWAY_SESSION)}`;
  const USER_ID = 'USER-CARRY-0002';
  const DISMISS = '/admin/?muraAction=cDashboard.dismissAlert&alertid=cachenotice&siteid=tenant-a';
  const DISMISS_PLUGIN = '/admin/?muraAction=cDashboard.dismissAlert&alertid=pluginnotice&siteid=tenant-a';
  const EDIT = '/admin/?muraAction=cArch.hist&siteid=tenant-b';
  const SITE_MANAGER_TAB = '/admin/?muraAction=cArch.siteManagerTab&tab=1';

  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  /**
   * A gateway at v0002 whose identity session stored `adminState`, and whose legacy writes the session as these admin actions do;
   * `targetWrite`, when given, is a target route's store into identity's admin state while legacy serves the first request.
   */
  async function start(adminState: SessionAdminState, targetWrite?: (stored: SessionAdminState) => void): Promise<TestGateway> {
    let pendingWrite = targetWrite;
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
              csrfSecretKey: 'CSRF-SECRET-CARRY-2',
              usedTokens: [],
            },
          },
        ],
      },
    });
    const { identity } = gateway;
    gateway.legacy.setResponse((req, attached) => {
      if (attached === undefined) return {};
      const stored = identity.sessions.get(GATEWAY_SESSION)?.adminState;
      if (pendingWrite !== undefined && stored !== undefined) {
        pendingWrite(stored);
        pendingWrite = undefined;
      }
      if (req.url.startsWith(DISMISS_PLUGIN)) {
        // cdashboard.cfc:149 deletes a dismissed alert that is not a Masa notice from session.mura.alerts[rc.siteid].
        const alerts = (sharedValue(attached, 'mura.alerts') ?? {}) as Record<string, Record<string, unknown>>;
        const { pluginnotice: _dismissed, ...kept } = alerts['tenant-a'] ?? {};
        attached.user = { ...attached.user, alerts: { ...alerts, 'tenant-a': kept } };
        return { body: '' };
      }
      if (req.url.startsWith(DISMISS)) {
        // cdashboard.cfc:142-153 marks a Masa notice dismissed in session.mura.alerts[rc.siteid].
        const alerts = (sharedValue(attached, 'mura.alerts') ?? {}) as Record<string, Record<string, unknown>>;
        attached.user = { ...attached.user, alerts: { ...alerts, 'tenant-a': { ...alerts['tenant-a'], cachenotice: false } } };
        return { body: '' };
      }
      if (req.url.startsWith(EDIT)) {
        // admin/Application.cfc:384-391 switches the session site to a registered rc.siteid.
        attached.siteId = 'tenant-b';
        attached.values = { ...attached.values, userFilesPath: '/sites/tenant-b/assets/', topID: '00000000000000000000000000000000001', openSectionList: '' };
        return { body: '<h1>History</h1>' };
      }
      if (req.url.startsWith(SITE_MANAGER_TAB)) {
        // carch.cfc:516-523 creates the site entry and sets its tab in dot notation, which ACF upper-cases.
        attached.values = { ...attached.values, flatViewArgs: { 'tenant-b': { TAB: '1' } } };
        return { body: '' };
      }
      return {};
    });
    return gateway;
  }

  const get = (app: TestGateway['app'], url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: TARGET_COOKIE, 'user-agent': USER_AGENT } });

  it('imports into identity what legacy-served admin actions change, keeping the values identity carried in', async () => {
    const { app, identity, legacy } = await start({
      siteid: 'tenant-a',
      keywords: 'zzzznotfound',
      mura: { nextN: '5', alerts: { 'tenant-a': {} } },
    });

    for (const url of [DISMISS, EDIT, SITE_MANAGER_TAB]) expect((await get(app, url)).statusCode).toBe(200);

    expect(identity.adminStateImports.map(({ values }) => values)).toEqual([
      { mura: { alerts: { 'tenant-a': { cachenotice: false } } } },
      { siteid: 'tenant-b', userFilesPath: '/sites/tenant-b/assets/', topID: '00000000000000000000000000000000001', openSectionList: '' },
      { mura: { flatViewArgs: { 'tenant-b': { TAB: '1' } } } },
    ]);
    expect(identity.sessions.get(GATEWAY_SESSION)).toMatchObject({
      adminSite: 'tenant-b',
      adminState: {
        siteid: 'tenant-b',
        keywords: 'zzzznotfound',
        topID: '00000000000000000000000000000000001',
        mura: { nextN: '5', alerts: { 'tenant-a': { cachenotice: false } }, flatViewArgs: { 'tenant-b': { TAB: '1' } } },
      },
    });
    const hydrated = legacy.bridgeCalls.find((call) => call.op === 'hydrate')?.legacySessionId ?? '';
    const session = legacy.sessions.get(hydrated);
    expect(session === undefined ? undefined : sharedValue(session, 'mura.nextN')).toBe('5');
    expect(session === undefined ? undefined : sharedValue(session, 'keywords')).toBe('zzzznotfound');
  });

  it('removes the alert legacy deleted and keeps the alerts a target route stored while legacy served the dismissal', async () => {
    const carried = { 'tenant-a': { cachenotice: true, pluginnotice: true } };
    const { app, identity } = await start({ siteid: 'tenant-a', mura: { alerts: carried } }, (stored) => {
      // A target-served page of tenant-b creating its site's alerts struct, as template.cfm:262-265 does.
      stored.mura = { ...stored.mura, alerts: { ...carried, 'tenant-b': {} } };
    });

    expect((await get(app, DISMISS_PLUGIN)).statusCode).toBe(200);

    expect(identity.adminStateImports).toEqual([
      { sessionId: GATEWAY_SESSION, values: { mura: { alerts: { 'tenant-a': { cachenotice: true } } } }, muraBases: { alerts: carried } },
    ]);
    expect(identity.sessions.get(GATEWAY_SESSION)?.adminState.mura?.alerts).toEqual({ 'tenant-a': { cachenotice: true }, 'tenant-b': {} });
  });
});

describe('FW/1 preserved contexts of target post-actions on legacy-served landings at the committed v0002 (target-primary)', () => {
  const GATEWAY_SESSION = 'F6A7B8C9-D0E1-F2A3-B4C5D6E7F8A9B0C1';
  const TARGET_COOKIE = `CFID=T-CFID-7401; CFTOKEN=T-CFTOKEN-7401; JSESSIONID=${jsessionidForSessionId(GATEWAY_SESSION)}`;
  const USER_ID = 'USER-CARRY-0003';
  const EDITED_USER = '3BEC10FC-F5B5-5517-7E7F2072657EFB68';
  const REMOVE_FROM_GROUP = '/admin/?muraAction=cUsers.removeFromGroup&userid=U1&groupid=G1&siteid=default';
  const UPDATE = '/admin/?muraAction=cUsers.update&userid=' + EDITED_USER + '&routeid=';
  // A roster create, a target write in v0002; the roster edit is halted on legacy (EX-ROSTER-POOLMOVE).
  const FORM = 'type=2&action=Add&siteid=default&fname=QA&lname=Editor&usernameNoCache=admin';
  const ERRORS = { username: "The username 'admin' that you entered is being used by another user." };

  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  /** A gateway at v0002 whose web saves the failed update's flash context in identity as web's saveFlashContext does. */
  async function start(): Promise<TestGateway> {
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
            adminState: { siteid: 'default' },
            snapshot: {
              sessionId: GATEWAY_SESSION,
              epoch: 3,
              loginSnapshot: { user: { userID: USER_ID, username: 'admin', siteID: 'default', membershipIds: USER_ID }, roles: ['S2'] },
              csrfSecretKey: 'CSRF-SECRET-CARRY-3',
              usedTokens: [],
            },
          },
        ],
      },
    });
    const { identity, web, legacy } = gateway;
    web.setResponse(() => {
      const session = identity.sessions.get(GATEWAY_SESSION);
      if (session === undefined) return { status: 500 };
      const key = session.adminState.nextPreserveKey ?? 1;
      const result = { written: false, errors: ERRORS, userBean: { UserID: EDITED_USER, Type: 2, SiteID: 'default' } };
      const context = { muraAction: 'cUsers.update', userid: EDITED_USER, routeid: '', ...Object.fromEntries(new URLSearchParams(FORM)), userBean: JSON.stringify(result) };
      session.adminState = { ...session.adminState, flash: { ...session.adminState.flash, [String(key)]: context }, nextPreserveKey: key + 1 };
      return { status: 302, headers: { location: `./?muraAction=cUsers.edituser&fw1pk=${String(key)}` }, body: '' };
    });
    legacy.setResponse((req, attached) => {
      if (attached === undefined || !req.url.startsWith(REMOVE_FROM_GROUP)) return {};
      // framework.cfc:1432-1456 allocates the next key, and saveFlashContext stores the context under it.
      const key = Number(attached.values.__fw1NextPreserveKey ?? 1);
      attached.values = { ...attached.values, __fw1NextPreserveKey: key + 1, [`__fw1${String(key)}`]: { groupid: 'G1', siteid: 'default' } };
      return { status: 302, headers: { location: `./?muraAction=cUsers.editGroupMembers&fw1pk=${String(key)}` }, body: '' };
    });
    return gateway;
  }

  const request = (app: TestGateway['app'], method: 'GET' | 'POST', url: string, payload?: string) =>
    app.inject({
      method,
      url,
      headers: { cookie: TARGET_COOKIE, 'user-agent': USER_AGENT, ...(payload === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
      payload,
    });

  it('allocates target and legacy keys from one counter and installs the target context, its userBean as a bean, for the landing', async () => {
    const { app, identity, legacy, web } = await start();

    const legacySave = await request(app, 'GET', REMOVE_FROM_GROUP);
    const targetSave = await request(app, 'POST', UPDATE, FORM);
    const landing = await request(app, 'GET', '/admin/?muraAction=cUsers.edituser&fw1pk=2');

    expect([legacySave.statusCode, legacySave.headers.location]).toEqual([302, './?muraAction=cUsers.editGroupMembers&fw1pk=1']);
    expect([targetSave.statusCode, targetSave.headers.location]).toEqual([302, './?muraAction=cUsers.edituser&fw1pk=2']);
    expect(web.requests).toHaveLength(1);
    expect(landing.statusCode).toBe(200);
    const hydrated = legacy.bridgeCalls.find((call) => call.op === 'hydrate')?.legacySessionId ?? '';
    const values = legacy.sessions.get(hydrated)?.values ?? {};
    expect(values.__fw1NextPreserveKey).toBe(3);
    expect(values.__fw11).toEqual({ groupid: 'G1', siteid: 'default' });
    expect(values.__fw12).toMatchObject({ userid: EDITED_USER, action: 'Add', usernameNoCache: 'admin' });
    expect((values.__fw12 as Record<string, unknown>).userBean).toEqual({
      posted: { muraAction: 'cUsers.update', userid: EDITED_USER, routeid: '', ...Object.fromEntries(new URLSearchParams(FORM)) },
      errors: ERRORS,
    } satisfies CarriedUserBean);
    const carried = legacy.bridgeCalls.filter(({ op }) => op === 'carry').map(({ body }) => (body as CarryResult).applied);
    expect(carried).toEqual([['siteid'], ['__fw1NextPreserveKey', '__fw1']]);
    expect(identity.adminStateImports.map(({ values: imported }) => imported)).toEqual([{ nextPreserveKey: 2 }]);
  });
});

describe('carch module, module tops and object instance across target-served and legacy-served admin requests at the committed v0002 (target-primary)', () => {
  const GATEWAY_SESSION = 'A7B8C9D0-E1F2-A3B4-C5D6E7F8A9B0C1D2';
  const TARGET_COOKIE = `CFID=T-CFID-7501; CFTOKEN=T-CFTOKEN-7501; JSESSIONID=${jsessionidForSessionId(GATEWAY_SESSION)}`;
  const USER_ID = 'USER-CARRY-0004';
  const SITE = '00000000000000000000000000000000000';
  const FORMS = '00000000000000000000000000000000004';
  const SITE_TOGGLE = `/admin/?muraAction=cArch.loadSiteManager&siteid=tenant-a&moduleid=${SITE}`;
  const HISTORY = '/admin/?muraAction=cArch.hist&siteid=tenant-a';
  /** What a target-served Forms-module carch.list stored (web carch controller, strategies-content carch before()). */
  const FORMS_TOPS = { [`m${SITE}`]: '00000000000000000000000000000000001', [`m${FORMS}`]: FORMS };

  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  /** A gateway at v0002 whose legacy writes the module values as admin/Application.cfc:419-421 and carch before() do. */
  async function start(): Promise<TestGateway> {
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
            adminState: { siteid: 'tenant-a', moduleid: FORMS, moduleTopIds: FORMS_TOPS, mura: { objectInstanceId: 'I1' } },
            snapshot: {
              sessionId: GATEWAY_SESSION,
              epoch: 3,
              loginSnapshot: { user: { userID: USER_ID, username: 'admin', siteID: 'default', membershipIds: USER_ID }, roles: ['S2'] },
              csrfSecretKey: 'CSRF-SECRET-CARRY-4',
              usedTokens: [],
            },
          },
        ],
      },
    });
    gateway.legacy.setResponse((req, attached) => {
      if (attached === undefined || !req.url.startsWith(SITE_TOGGLE)) return {};
      // Application.cfc:419-421 takes rc.moduleid; before() adds the missing module defaults and keeps the Site top.
      attached.values = {
        ...attached.values,
        moduleid: SITE,
        [`m${SITE}`]: { TOPID: '00000000000000000000000000000000001' },
        m00000000000000000000000000000000003: { TOPID: '00000000000000000000000000000000003' },
        m00000000000000000000000000000000099: { TOPID: '00000000000000000000000000000000099' },
      };
      attached.user = { ...attached.user, objectInstanceId: '' };
      return { body: '{"html":""}' };
    });
    return gateway;
  }

  const get = (app: TestGateway['app'], url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: TARGET_COOKIE, 'user-agent': USER_AGENT } });

  it('installs the module, its tops and the object instance, imports the Site toggle in full, and exports nothing a later carry reinstalled', async () => {
    const { app, identity, legacy } = await start();

    expect((await get(app, SITE_TOGGLE)).statusCode).toBe(200);
    expect((await get(app, HISTORY)).statusCode).toBe(200);

    const allTops = {
      [`m${SITE}`]: '00000000000000000000000000000000001',
      m00000000000000000000000000000000003: '00000000000000000000000000000000003',
      [`m${FORMS}`]: FORMS,
      m00000000000000000000000000000000099: '00000000000000000000000000000000099',
    };
    const ops = legacy.bridgeCalls.filter(({ op }) => op === 'carry' || op === 'export').map(({ op, body }) => [op, body]);
    expect(ops).toEqual([
      ['carry', { applied: ['siteid', 'moduleid', 'moduleTopIds', 'mura.objectInstanceId'], serverTime: expect.any(String) }],
      [
        'export',
        {
          values: [
            { name: 'moduleid', value: SITE },
            // The base goes unused: identity replaces the stored module tops with every top legacy holds.
            { name: 'moduleTopIds', value: allTops, base: FORMS_TOPS },
            { name: 'mura.objectInstanceId', value: '' },
          ],
          serverTime: expect.any(String),
        },
      ],
      ['carry', { applied: ['moduleid', 'moduleTopIds', 'mura.objectInstanceId'], serverTime: expect.any(String) }],
      ['export', { values: [], serverTime: expect.any(String) }],
    ]);
    expect(identity.adminStateImports).toEqual([
      { sessionId: GATEWAY_SESSION, values: { moduleid: SITE, moduleTopIds: allTops, mura: { objectInstanceId: '' } } },
    ]);
    expect(identity.sessions.get(GATEWAY_SESSION)?.adminState).toMatchObject({ moduleid: SITE, moduleTopIds: allTops, mura: { objectInstanceId: '' } });
  });
});

describe("login's strike block across target-served logins and the legacy-served login page at the committed v0002 (target-primary)", () => {
  const GATEWAY_SESSION = 'B8C9D0E1-F2A3-B4C5-D6E7F8A9B0C1D2E3';
  const TARGET_COOKIE = `CFID=T-CFID-7601; CFTOKEN=T-CFTOKEN-7601; JSESSIONID=${jsessionidForSessionId(GATEWAY_SESSION)}`;
  const USER_ID = 'USER-CARRY-0005';
  const LOGIN_PAGE = '/admin/?muraAction=cLogin.main&display=login&status=failed';
  /** The block identity's login stored for a refused attempt, fifteen minutes after the suites' clock. */
  const TARGET_BLOCK = '2026-06-30T12:15:00.000';
  /** The block a legacy-served login set in the legacy session meanwhile. */
  const LEGACY_BLOCK = new Date(2026, 5, 30, 12, 20, 0, 0);

  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  /** A gateway at v0002 whose identity session holds `TARGET_BLOCK`, and whose legacy renders the login notice as main.cfm does. */
  async function start(): Promise<TestGateway> {
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
            adminState: { siteid: 'default', blockLoginUntil: TARGET_BLOCK },
            snapshot: {
              sessionId: GATEWAY_SESSION,
              epoch: 3,
              loginSnapshot: { user: { userID: USER_ID, username: 'admin', siteID: 'default', membershipIds: USER_ID }, roles: ['S2'] },
              csrfSecretKey: 'CSRF-SECRET-CARRY-5',
              usedTokens: [],
            },
          },
        ],
      },
    });
    gateway.legacy.setResponse((req, attached) => {
      if (attached === undefined || !req.url.startsWith(LOGIN_PAGE)) return {};
      // main.cfm:111 shows login.blocked while session.blockLoginUntil is a date after now().
      const until = attached.values.blockLoginUntil;
      return { body: until instanceof Date && until.getTime() > TEST_CLOCK.now().getTime() ? 'login.blocked' : 'login.failed' };
    });
    return gateway;
  }

  it("shows legacy's notice for identity's block, installs the block a target login cleared, and imports the block legacy's login set", async () => {
    const { app, identity, legacy } = await start();
    const page = async () => (await app.inject({ method: 'GET', url: LOGIN_PAGE, headers: { cookie: TARGET_COOKIE, 'user-agent': USER_AGENT } })).body;

    const blocked = await page();
    const stored = identity.sessions.get(GATEWAY_SESSION);
    if (stored !== undefined) stored.adminState = { ...stored.adminState, blockLoginUntil: '' };
    const cleared = await page();
    const hydrated = legacy.bridgeCalls.find((call) => call.op === 'hydrate')?.legacySessionId ?? '';
    const session = legacy.sessions.get(hydrated);
    if (session !== undefined) session.values = { ...session.values, blockLoginUntil: LEGACY_BLOCK };
    const legacyBlocked = await page();

    expect([blocked, cleared, legacyBlocked]).toEqual(['login.blocked', 'login.failed', 'login.blocked']);
    const ops = legacy.bridgeCalls.filter(({ op }) => op === 'carry' || op === 'export').map(({ op, body }) => [op, body]);
    expect(ops).toEqual([
      ['carry', { applied: ['siteid', 'blockLoginUntil'], serverTime: expect.any(String) }],
      ['export', { values: [], serverTime: expect.any(String) }],
      ['carry', { applied: ['blockLoginUntil'], serverTime: expect.any(String) }],
      ['export', { values: [], serverTime: expect.any(String) }],
      // Identity's block is unchanged since its install, so legacy's own block stands and goes out as a wire time.
      ['carry', { applied: [], serverTime: expect.any(String) }],
      ['export', { values: [{ name: 'blockLoginUntil', value: '2026-06-30T12:20:00.000' }], serverTime: expect.any(String) }],
    ]);
    expect(identity.adminStateImports).toEqual([{ sessionId: GATEWAY_SESSION, values: { blockLoginUntil: '2026-06-30T12:20:00.000' } }]);
    expect(identity.sessions.get(GATEWAY_SESSION)?.adminState.blockLoginUntil).toBe('2026-06-30T12:20:00.000');
  });
});
