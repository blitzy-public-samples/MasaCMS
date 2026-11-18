// Request-conditional legacy writes: each guard and start-up writer, and the units they leave committed entries.
import { parseCookieHeader, type RouteFamily } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import { loadInventory, loadTableOwnership } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { InventoryDoc } from '../../src/cutover/types.js';
import {
  REQUEST_GUARDS,
  STARTUP_WRITERS,
  asyncDoactionRoutes,
  createRequestWrites,
  type RequestFacts,
} from '../../src/dispatcher/request-writes.js';
import { committedIndex } from '../helpers/versions.js';

// An empty env, so the committed inventory is used whatever OPT2_CUTOVER_DIR the shell sets.
const PATHS = resolveGatewayPaths({});
const [inventory, ownership, v0002] = await Promise.all([loadInventory(PATHS), loadTableOwnership(PATHS), committedIndex('v0002')]);
const writes = createRequestWrites(inventory, ownership);

const REMEMBER_ME = 'userid=U1; userHash=H1';
const RENDER_STARTUP = ['identity.group_account', 'identity.login_state'];
const FORM_UNITS = ['content.file', 'content.form_response_packet', 'content.form_response_question', 'identity.redirect'];

interface FactsInit {
  params?: Record<string, string>;
  url?: Record<string, string>;
  method?: string;
  cookie?: string;
  sessionManaged?: boolean;
}

function factsOf({ params = {}, url = {}, method = 'GET', cookie, sessionManaged = true }: FactsInit = {}): RequestFacts {
  return { params, url, method, cookies: parseCookieHeader(cookie), sessionManaged: () => sessionManaged };
}

function guard(id: string): (typeof REQUEST_GUARDS)[number] {
  const found = REQUEST_GUARDS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new TypeError(`no request guard ${id}`);
  return found;
}

/** The committed v0002 units of `route`. */
function unitsOf(route: string): readonly string[] {
  const entry = v0002.entryFor(route);
  if (entry === undefined) throw new TypeError(`v0002 has no entry ${route}`);
  return entry.units;
}

describe('request guards', () => {
  it.each<[string, FactsInit, boolean]>([
    ['lockdown-login', { params: { locks: 'true' } }, true],
    ['lockdown-login', { params: { locks: 'TRUE' } }, true],
    ['lockdown-login', { params: { locks: 'yes' } }, true],
    ['lockdown-login', { params: { locks: '1' } }, true],
    ['lockdown-login', { params: { locks: 'false' }, url: { locks: 'true' } }, true],
    ['lockdown-login', { params: { locks: 'false' } }, false],
    ['lockdown-login', { params: { locks: '' } }, false],
    ['lockdown-login', {}, false],
    ['magic-link-login', { params: { returnid: 'R1', returnuserid: 'U1' } }, true],
    ['magic-link-login', { params: { returnid: 'R1' }, url: { returnuserid: 'U1' } }, true],
    ['magic-link-login', { params: { returnid: 'R1', returnuserid: '' } }, false],
    ['magic-link-login', { params: { returnuserid: 'U1' } }, false],
    ['image-rendition', { params: { size: 'small' } }, true],
    ['image-rendition', { params: { size: '' } }, false],
    ['orphan-archive-cleanup', { params: { locks: 'true', returnid: 'R1', returnuserid: 'U1', size: 'small' } }, false],
    ['async-account-write', { method: 'POST', params: { object: 'login' } }, true],
    ['async-account-write', { method: 'post', params: { object: 'LOGIN' } }, true],
    ['async-account-write', { method: 'POST', params: { object: 'search' }, url: { object: 'login' } }, true],
    ['async-account-write', { method: 'GET', params: { object: 'login' } }, false],
    ['async-account-write', { params: { object: 'editprofile', doaction: 'updateprofile' } }, true],
    ['async-account-write', { params: { object: 'EditProfile', doaction: 'CreateProfile' } }, true],
    ['async-account-write', { params: { object: 'editprofile', doaction: 'login' } }, false],
    ['async-account-write', { method: 'POST', params: { object: 'search' } }, false],
  ])('%s holds for %j: %s', (id, init, expected) => {
    expect(guard(id).holds(factsOf(init))).toBe(expected);
  });

  it.each<[RouteFamily, string | undefined, boolean, boolean]>([
    ['page', REMEMBER_ME, true, true],
    ['page', 'USERID=U1; USERHASH=H1', true, true],
    ['trackopen', REMEMBER_ME, true, true],
    ['widgets', REMEMBER_ME, true, true],
    ['admin', REMEMBER_ME, true, true],
    ['cfm', REMEMBER_ME, true, true],
    ['rest', REMEMBER_ME, true, true],
    ['rest', REMEMBER_ME, false, false],
    ['static', REMEMBER_ME, true, false],
    ['opt2', REMEMBER_ME, true, false],
    ['bridge', REMEMBER_ME, true, false],
    ['page', 'userid=U1', true, false],
    ['page', 'userid=; userHash=H1', true, false],
    ['page', undefined, true, false],
  ])('the remember-me login of a %s request with cookies %j (session managed: %s) holds: %s', (family, cookie, sessionManaged, expected) => {
    const [rememberMe] = STARTUP_WRITERS;
    expect(rememberMe?.id).toBe('wov:remember-me-login');
    expect(rememberMe?.holds(family, factsOf({ cookie, sessionManaged }))).toBe(expected);
  });
});

describe('asyncDoactionRoutes', () => {
  it.each<[string, FactsInit, string[]]>([
    ['api:processasyncobject', { params: { doaction: 'saveRate' } }, ['page:saverate']],
    ['rest:processasyncobject', { url: { doaction: 'forwardEmail' }, params: { doaction: 'SAVERATE,,saveRate' } }, ['page:forwardemail', 'page:saverate']],
    ['api:processasyncobject', { params: { doaction: '' } }, []],
    ['api:processasyncobject', {}, []],
    ['page:saverate', { params: { doaction: 'saveRate' } }, []],
  ])('names for a request keyed %s with %j the doaction page routes %j', (baseKey, init, expected) => {
    expect(asyncDoactionRoutes({ baseKey }, factsOf(init))).toEqual(expected);
  });
});

describe('createRequestWrites over the committed inventory', () => {
  it.each<[string, string, FactsInit, string[]]>([
    ['an anonymous page render', 'page:render', {}, ['reporting.session_tracking']],
    ['a lockdown login', 'page:render', { params: { locks: 'true' } }, ['identity.login_state', 'identity.user_strike', 'reporting.session_tracking']],
    [
      'a magic-link login',
      'page:render',
      { params: { returnid: 'R1', returnuserid: 'U1' } },
      ['identity.group_account', 'identity.login_state', 'reporting.session_tracking'],
    ],
    ['an image rendition', 'page:render', { params: { size: 'small' } }, ['content.file', 'reporting.session_tracking']],
    ['a display object render', 'api:processasyncobject', { params: { object: 'search' } }, []],
    ['a REST display object render', 'rest:processasyncobject', { method: 'POST', params: { object: 'search' } }, []],
    ['an asynchronous form submission', 'api:processasyncobject{saveform}', { method: 'POST', params: { object: 'form' } }, FORM_UNITS],
  ])('leaves %s (%s) only the units it can write', (_label, route, init, expected) => {
    expect([...writes.entryUnits(route, unitsOf(route), factsOf(init))].sort()).toEqual(expected);
  });

  it.each<[string, FactsInit]>([
    ['an asynchronous login', { method: 'POST', params: { object: 'login' } }],
    ['an asynchronous profile update', { params: { object: 'editprofile', doaction: 'updateprofile' } }],
  ])('keeps every unit of processAsyncObject for %s, whose branches the inventory cannot tell apart', (_label, init) => {
    const units = unitsOf('api:processasyncobject');
    expect(writes.entryUnits('api:processasyncobject', units, factsOf(init))).toBe(units);
  });

  it('returns the units unchanged, as the same array, for an entry without guarded writes', () => {
    const units = unitsOf('page:login');
    expect(writes.entryUnits('page:login', units, factsOf())).toBe(units);
  });

  it.each<[RouteFamily, string, FactsInit, string[]]>([
    ['page', 'page:login', { params: { returnid: 'R1', returnuserid: 'U1' } }, ['identity.group_account', 'identity.login_state']],
    ['page', 'page:return', { params: { locks: 'true' } }, ['identity.login_state', 'identity.user_strike']],
    ['page', 'page:subscribe', {}, []],
    ['static', 'static:/missing.png', { params: { size: 'small' } }, ['content.file']],
    ['api', 'api:processasyncobject', { params: { returnid: 'R1', returnuserid: 'U1' } }, ['identity.group_account', 'identity.login_state']],
    ['api', 'api:processasyncobject', { params: { locks: 'true', size: 'small' } }, []],
    ['feed', 'feed:v1', { params: { returnid: 'R1', returnuserid: 'U1' } }, ['identity.group_account', 'identity.login_state']],
    ['api', 'api:content.findone', { params: { returnid: 'R1', returnuserid: 'U1' } }, []],
  ])('adds to a %s request keyed %s the render-pipeline units its guards reach', (family, baseKey, init, expected) => {
    expect(writes.pipelineUnits({ family, baseKey }, factsOf(init)).sort()).toEqual(expected);
  });

  it.each<[RouteFamily, FactsInit, string[]]>([
    ['page', { cookie: REMEMBER_ME }, RENDER_STARTUP],
    ['trackopen', { cookie: REMEMBER_ME }, RENDER_STARTUP],
    ['static', { cookie: REMEMBER_ME }, []],
    ['page', {}, []],
  ])('maps the start-up writes of a %s request to the units owning tusers.LastLogin', (family, init, expected) => {
    expect(writes.startupUnits(family, factsOf(init)).sort()).toEqual(expected);
  });

  it('fails to build over an inventory with a start-up request writer it does not classify', () => {
    const table = inventory.tables.find((candidate) => candidate.writers.some((writer) => writer.override === 'wov:remember-me-login'));
    if (table === undefined) throw new TypeError('the committed inventory has no remember-me writer');
    const writer = table.writers.find((candidate) => candidate.override === 'wov:remember-me-login');
    if (writer === undefined) throw new TypeError('the committed inventory has no remember-me writer');
    const unclassified: InventoryDoc = {
      ...inventory,
      tables: [...inventory.tables, { ...table, writers: [{ ...writer, override: 'wov:unclassified-start-up' }] }],
    };
    expect(() => createRequestWrites(unclassified, ownership)).toThrow(/reaches no route key and is not a start-up writer/);
  });
});
