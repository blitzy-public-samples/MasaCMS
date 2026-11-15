// Session mode by the login group's authority, legacy cookie jar translation, and target-primary absorption and adoption.
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_SESSION_COOKIE_NAMES,
  isLegacySessionCookie,
  jsessionidForSessionId,
  parseSetCookie,
  setCookieLegacy,
} from '@opt2/platform/legacy-compat';
import type { Authority, CutoverTable } from '../../src/cutover/types.js';
import {
  absorbLegacySetCookies,
  legacyCookieHeader,
  legacySetCookiesFrom,
  targetSetCookiesFrom,
  type JarCookies,
} from '../../src/session/jar.js';
import { LOGIN_ROUTE_KEY, sessionModeFor, type SessionMode } from '../../src/session/mode.js';
import { buildTestGateway, operatorHeaders, type TestGateway, type TestGatewayOptions } from '../helpers/app.js';
import { TEST_CLOCK } from '../helpers/env.js';
import type { AdoptHandler, IdentitySessionSpec } from '../helpers/identity-double.js';
import type { LegacyEcho } from '../helpers/legacy-origin.js';
import type { LegacyJarRow, MemoryGatewayDb } from '../helpers/memory-store.js';
import {
  committedGroups,
  committedIndex,
  committedTable,
  cutoverTable,
  entry,
  groupsFile,
  indexFor,
  type CommittedVersion,
} from '../helpers/versions.js';

const NOW = TEST_CLOCK.now();
const LOGIN_GROUP = 'grp:identity.login_state';
const LOGIN_UNIT = 'identity.login_state';
const UNFREEZE_PATH = '/internal/v1/cutover/unfreeze';
/** An admin page no fixture entry routes, so it is legacy-bound; its inventoried session effect is none, unlike a page render's relogin. */
const PAGE_URL = '/admin/?muraAction=cArch.list&siteid=default';
const LEGACY_PAGE = '<p>legacy page</p>';
const LEGACY_DOMAIN = 'example.com';

const TARGET_SESSION_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const ADOPTED_SESSION_ID = 'B2C3D4E5-F6A7-B8C9-D0E1F2A3B4C5D6E7';
const TARGET_VALUES: Record<string, string> = {
  CFID: 'T-CFID-7001',
  CFTOKEN: 'T-CFTOKEN-7001',
  JSESSIONID: jsessionidForSessionId(TARGET_SESSION_ID),
};
const ADOPTED_VALUES: Record<string, string> = {
  CFID: 'T-CFID-8001',
  CFTOKEN: 'T-CFTOKEN-8001',
  JSESSIONID: jsessionidForSessionId(ADOPTED_SESSION_ID),
};

/** `Cookie` header pairs of `values` in legacy session cookie order. */
function cookieHeaderOf(values: Readonly<Record<string, string>>): string {
  return LEGACY_SESSION_COOKIE_NAMES.map((name) => `${name}=${values[name]}`).join('; ');
}

/** The raw text after a Set-Cookie value's first `;`. */
function attributeTail(setCookie: string): string {
  return setCookie.slice(setCookie.indexOf(';') + 1);
}

/** A legacy session Set-Cookie with `path=/`, `HttpOnly` and a domain; CFID and CFTOKEN persist, JSESSIONID lasts the browser session. */
function legacySessionSetCookie(name: string, value: string): string {
  const expires = name.toUpperCase() === 'JSESSIONID' ? '' : 'never';
  return setCookieLegacy({ name, value, domain: LEGACY_DOMAIN, expires }, {}, NOW);
}

/** A non-session cookie legacy sets beside the session cookies. */
const TRACKING_SET_COOKIE = setCookieLegacy({ name: 'MXP_TRACKINGID', value: 'TRK-0001', expires: 'never' }, {}, NOW);

/** Legacy session Set-Cookie values for `values`, in legacy session cookie order. */
function legacySessionSetCookies(values: Readonly<Record<string, string>>): string[] {
  return LEGACY_SESSION_COOKIE_NAMES.map((name) => legacySessionSetCookie(name, values[name] as string));
}

/** A version whose only entries are the `admin:clogin.*` actions, each in `state`, under the given login group authority. */
function cloginTable(tableVersion: string, state: Authority, authority: Authority): CutoverTable {
  return cutoverTable({
    tableVersion,
    entries: [
      entry({ route: LOGIN_ROUTE_KEY, owningService: 'identity', kind: 'write', state, group: LOGIN_GROUP, units: [LOGIN_UNIT] }),
      entry({ route: 'admin:clogin.main', owningService: 'identity', kind: 'write', state, group: LOGIN_GROUP, units: [LOGIN_UNIT] }),
      entry({ route: 'admin:clogin.logout', owningService: 'identity', state, units: [LOGIN_UNIT] }),
    ],
    groupAuthority: { [LOGIN_GROUP]: authority },
  });
}

const TARGET_LOGIN = cloginTable('v9101', 'target', 'target');
const LEGACY_LOGIN = cloginTable('v9102', 'legacy', 'legacy');

describe('sessionModeFor', () => {
  it('is legacy-primary while no version is active', () => {
    expect(sessionModeFor(undefined)).toBe('legacy-primary');
  });

  it.each<[Authority, Authority, SessionMode]>([
    ['legacy', 'legacy', 'legacy-primary'],
    ['legacy', 'target', 'legacy-primary'],
    ['target', 'target', 'target-primary'],
    ['target', 'legacy', 'target-primary'],
  ])('follows the login group authority %s whatever the clogin entries state (%s)', (authority, state, mode) => {
    const groups = groupsFile([{ id: LOGIN_GROUP, units: [LOGIN_UNIT], writeEntries: [LOGIN_ROUTE_KEY, 'admin:clogin.main'] }]);
    expect(sessionModeFor(indexFor(cloginTable('v9001', state, authority), groups))).toBe(mode);
  });

  it('is legacy-primary for the committed v0001', async () => {
    expect(sessionModeFor(await committedIndex('v0001'))).toBe('legacy-primary');
  });

  it.each<CommittedVersion>(['v0002', 'v0003'])('follows the committed login group authority in %s', async (version) => {
    const [table, groups] = await Promise.all([committedTable(version), committedGroups()]);
    const loginGroup = groups.groups.find((group) => group.writeEntries.includes(LOGIN_ROUTE_KEY));
    const authority = loginGroup === undefined ? 'legacy' : (table.groupAuthority[loginGroup.id] ?? 'legacy');
    expect(sessionModeFor(await committedIndex(version))).toBe(authority === 'target' ? 'target-primary' : 'legacy-primary');
  });
});

describe('legacy cookie jar translation', () => {
  const legacyValues = { CFID: '1001', CFTOKEN: '10000001', JSESSIONID: 'node0legacy1001' };
  const sessionSetCookies = legacySessionSetCookies(legacyValues);
  const { sessionCookies, otherSetCookies } = absorbLegacySetCookies([...sessionSetCookies, TRACKING_SET_COOKIE]);

  it('absorbs CFID, CFTOKEN and JSESSIONID and passes every other cookie through verbatim', () => {
    expect(Object.keys(sessionCookies)).toEqual([...LEGACY_SESSION_COOKIE_NAMES]);
    expect(otherSetCookies).toEqual([TRACKING_SET_COOKIE]);
    for (const [index, name] of LEGACY_SESSION_COOKIE_NAMES.entries()) {
      const raw = sessionSetCookies[index] as string;
      expect(sessionCookies[name]).toEqual({ name, value: legacyValues[name], attributes: attributeTail(raw) });
    }
  });

  it('legacy session cookies are re-emitted as target cookies with identical names and attributes', () => {
    const emitted = targetSetCookiesFrom(sessionCookies, TARGET_VALUES, NOW);
    expect(emitted).toHaveLength(sessionSetCookies.length);
    for (const [index, name] of LEGACY_SESSION_COOKIE_NAMES.entries()) {
      const legacy = sessionSetCookies[index] as string;
      const target = emitted[index] as string;
      expect(target).toBe(`${name}=${TARGET_VALUES[name]};${attributeTail(legacy)}`);
      const parsedLegacy = parseSetCookie(legacy);
      const parsedTarget = parseSetCookie(target);
      expect(parsedTarget.name).toBe(parsedLegacy.name);
      expect(parsedTarget.attributes).toEqual(parsedLegacy.attributes);
      expect(parsedTarget.value).toBe(TARGET_VALUES[name]);
    }
  });

  it('hands the jar legacy values back with their original attributes and joins them for a request to legacy', () => {
    expect(legacySetCookiesFrom(sessionCookies)).toEqual(sessionSetCookies);
    expect(legacyCookieHeader(sessionCookies, NOW)).toBe(cookieHeaderOf(legacyValues));
  });
});

/** Every `Set-Cookie` value of an injected response. */
function setCookiesOf(res: { headers: Record<string, string | string[] | number | undefined> }): string[] {
  const value = res.headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** The session cookie Set-Cookie values of an injected response, by upper-case name. */
function sessionSetCookiesOf(res: Parameters<typeof setCookiesOf>[0]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of setCookiesOf(res)) {
    const { name } = parseSetCookie(value);
    if (isLegacySessionCookie(name)) out[name.toUpperCase()] = value;
  }
  return out;
}

function memoryOf(gateway: TestGateway): MemoryGatewayDb {
  if (gateway.memory === undefined) throw new TypeError('the test gateway runs over a memory store');
  return gateway.memory;
}

function jarRow(gateway: TestGateway, sessionId: string): LegacyJarRow | undefined {
  return memoryOf(gateway).tables.legacy_jar.find((row) => row.session_id === sessionId);
}

function jarCookiesOf(row: LegacyJarRow | undefined): JarCookies {
  return (row?.cookies ?? {}) as JarCookies;
}

/** Commits `table` as the active version and loads it into the instance through an operator unfreeze. */
async function activate(gateway: TestGateway, table: CutoverTable, mode: SessionMode): Promise<void> {
  memoryOf(gateway).setActive(table.tableVersion);
  const res = await gateway.app.inject({
    method: 'POST',
    url: UNFREEZE_PATH,
    headers: await operatorHeaders(),
    payload: { routes: [LOGIN_ROUTE_KEY] },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json<{ tableVersion: string; sessionMode: SessionMode }>()).toMatchObject({
    tableVersion: table.tableVersion,
    sessionMode: mode,
  });
}

function requestPage(gateway: TestGateway, cookie?: string) {
  return gateway.app.inject({ method: 'GET', url: PAGE_URL, headers: cookie === undefined ? {} : { cookie } });
}

/** The identity session the browser's target cookies name, with the snapshot hydration installs. */
const TARGET_SESSION: IdentitySessionSpec = {
  sessionId: TARGET_SESSION_ID,
  userId: 'USER-T1',
  epoch: 3,
  state: 'active',
  mode: 'target-primary',
  snapshot: {
    sessionId: TARGET_SESSION_ID,
    epoch: 3,
    loginSnapshot: { user: { userID: 'USER-T1', username: 'qa_editor', siteID: 'default' }, roles: [] },
    csrfSecretKey: 'CSRF-SECRET-T1',
    usedTokens: [],
  },
};

describe('target-primary and legacy-primary session cookies through the gateway', () => {
  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  async function start(opts: TestGatewayOptions): Promise<TestGateway> {
    gateway = await buildTestGateway(opts);
    return gateway;
  }

  /** In target-primary, one legacy-bound request whose legacy response sets new CFID and CFTOKEN values. */
  async function absorbNewLegacyCookies(gw: TestGateway) {
    const replaced = [legacySessionSetCookie('CFID', 'L-CFID-9001'), legacySessionSetCookie('CFTOKEN', 'L-CFTOKEN-9001')];
    gw.legacy.setResponse({ body: LEGACY_PAGE, setCookies: replaced });
    const res = await requestPage(gw, cookieHeaderOf(TARGET_VALUES));
    gw.legacy.setResponse();
    return { res, replaced };
  }

  it('absorbs legacy session cookies into the jar and answers the client with target values under legacy names and attributes', async () => {
    const gw = await start({ version: TARGET_LOGIN, extraTables: [LEGACY_LOGIN], identity: { sessions: [TARGET_SESSION] } });
    const { res, replaced } = await absorbNewLegacyCookies(gw);

    expect(res.statusCode).toBe(200);
    const emitted = sessionSetCookiesOf(res);
    expect(Object.keys(emitted).sort()).toEqual(['CFID', 'CFTOKEN']);
    for (const legacy of replaced) {
      const { name } = parseSetCookie(legacy);
      expect(emitted[name]).toBe(`${name}=${TARGET_VALUES[name]};${attributeTail(legacy)}`);
    }
    const legacyValues = new Set([
      'L-CFID-9001',
      'L-CFTOKEN-9001',
      ...[...gw.legacy.sessions.values()].flatMap((session) => [session.cfid, session.cftoken, session.jsessionid]),
    ]);
    for (const value of setCookiesOf(res)) expect(legacyValues.has(parseSetCookie(value).value)).toBe(false);
    expect(res.body).toBe(LEGACY_PAGE);

    const row = jarRow(gw, TARGET_SESSION_ID);
    expect(row?.mode).toBe('target-primary');
    expect(jarCookiesOf(row).CFID).toEqual({ name: 'CFID', value: 'L-CFID-9001', attributes: attributeTail(replaced[0] as string) });
    expect(jarCookiesOf(row).CFTOKEN).toEqual({ name: 'CFTOKEN', value: 'L-CFTOKEN-9001', attributes: attributeTail(replaced[1] as string) });

    const next = await requestPage(gw, cookieHeaderOf(TARGET_VALUES));
    expect(next.statusCode).toBe(200);
    const echo = next.json<LegacyEcho>();
    const jar = jarCookiesOf(jarRow(gw, TARGET_SESSION_ID));
    expect(echo.cookies).toEqual(
      Object.fromEntries(Object.values(jar).map((cookie) => [cookie.name.toLowerCase(), cookie.value])),
    );
    expect(echo.cookies.cfid).toBe('L-CFID-9001');
    expect(echo.cookie).not.toContain(TARGET_VALUES.CFID);
  });

  it('answers a target cookie with its jar legacy cookies once the login group returns to legacy', async () => {
    const gw = await start({ version: TARGET_LOGIN, extraTables: [LEGACY_LOGIN], identity: { sessions: [TARGET_SESSION] } });
    const { replaced } = await absorbNewLegacyCookies(gw);
    const jar = jarCookiesOf(jarRow(gw, TARGET_SESSION_ID));

    await activate(gw, LEGACY_LOGIN, 'legacy-primary');
    const res = await requestPage(gw, cookieHeaderOf(TARGET_VALUES));

    expect(res.statusCode).toBe(200);
    const emitted = sessionSetCookiesOf(res);
    expect(Object.values(emitted).sort()).toEqual(legacySetCookiesFrom(jar).sort());
    expect(emitted.CFID).toBe(replaced[0]);
    expect(emitted.CFTOKEN).toBe(replaced[1]);
    expect(Object.values(emitted).join('\n')).not.toContain(TARGET_VALUES.CFID);
  });

  it('adopts a legacy session opened before the login group moved and re-emits target cookies with its names and attributes', async () => {
    const gw = await start({ version: LEGACY_LOGIN, extraTables: [TARGET_LOGIN] });
    const created = gw.legacy.createSession({ user: { userID: 'USER-A1', username: 'admin', siteID: 'default' } });
    const legacySessionId = created.session.legacySessionId;

    const before = await requestPage(gw, created.cookieHeader);
    expect(before.statusCode).toBe(200);
    expect(setCookiesOf(before)).toEqual([]);
    expect(gw.identity.calls.adopt).toBe(0);
    expect(memoryOf(gw).tables.legacy_jar).toEqual([]);

    await activate(gw, TARGET_LOGIN, 'target-primary');
    gw.legacy.clearRequests();
    // Identity's own attributes differ, so attributes the client receives can only come from the legacy cookies.
    const issued = LEGACY_SESSION_COOKIE_NAMES.map((name) =>
      setCookieLegacy({ name, value: ADOPTED_VALUES[name] as string, secure: true }, {}, NOW),
    );
    let describedFirst = false;
    const adopt: AdoptHandler = (input) => {
      describedFirst = gw.legacy.bridgeCalls.some((call) => call.op === 'describe' && call.legacySessionId === input.legacySessionId);
      gw.identity.setSession({
        sessionId: ADOPTED_SESSION_ID,
        userId: 'USER-A1',
        epoch: 1,
        state: 'active',
        mode: 'target-primary',
        legacySessionId: input.legacySessionId,
        snapshot: {
          sessionId: ADOPTED_SESSION_ID,
          epoch: 1,
          loginSnapshot: { user: { ...input.describe.user }, roles: [...input.describe.roles] },
          csrfSecretKey: input.describe.csrfSecretKey,
          usedTokens: [...input.describe.usedTokens],
        },
      });
      return { sessionId: ADOPTED_SESSION_ID, epoch: 1, setCookie: issued };
    };
    gw.identity.onAdopt(adopt);

    const res = await requestPage(gw, created.cookieHeader);

    expect(res.statusCode).toBe(200);
    expect(gw.legacy.bridgeCalls).toContainEqual(
      expect.objectContaining({ op: 'describe', legacySessionId, status: 200 }),
    );
    expect(describedFirst).toBe(true);
    expect(gw.identity.calls.adopt).toBe(1);
    expect(jarRow(gw, ADOPTED_SESSION_ID)).toMatchObject({ legacy_session_id: legacySessionId, mode: 'target-primary' });

    const emitted = sessionSetCookiesOf(res);
    expect(Object.keys(emitted).sort()).toEqual([...LEGACY_SESSION_COOKIE_NAMES].sort());
    for (const legacy of created.setCookies) {
      const parsedLegacy = parseSetCookie(legacy);
      const parsedTarget = parseSetCookie(emitted[parsedLegacy.name] as string);
      expect(parsedTarget.attributes).toEqual(parsedLegacy.attributes);
      expect(parsedTarget.value).toBe(ADOPTED_VALUES[parsedLegacy.name]);
      expect(emitted[parsedLegacy.name]).toBe(`${parsedLegacy.name}=${ADOPTED_VALUES[parsedLegacy.name]};${attributeTail(legacy)}`);
    }
  });

  it('passes legacy session Set-Cookie values to the client unchanged in legacy-primary and writes no jar', async () => {
    const gw = await start({ version: LEGACY_LOGIN, extraTables: [TARGET_LOGIN] });
    const created = gw.legacy.createSession();
    const set = [
      ...legacySessionSetCookies({ CFID: 'L-CFID-9101', CFTOKEN: 'L-CFTOKEN-9101', JSESSIONID: 'node0legacy9101' }),
      TRACKING_SET_COOKIE,
    ];
    gw.legacy.setResponse({ body: LEGACY_PAGE, setCookies: set });

    const res = await requestPage(gw, created.cookieHeader);

    expect(res.statusCode).toBe(200);
    expect(setCookiesOf(res)).toEqual(set);
    expect(memoryOf(gw).tables.legacy_jar).toEqual([]);
    expect(gw.identity.calls.adopt).toBe(0);
  });
});
