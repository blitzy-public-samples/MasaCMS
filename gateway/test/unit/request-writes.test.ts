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
  orphanArchiveFilenames,
  type RequestFacts,
  type RequestProbes,
} from '../../src/dispatcher/request-writes.js';
import { committedIndex } from '../helpers/versions.js';

// An empty env, so the committed inventory is used whatever OPT2_CUTOVER_DIR the shell sets.
const PATHS = resolveGatewayPaths({});
const [inventory, ownership, v0002] = await Promise.all([loadInventory(PATHS), loadTableOwnership(PATHS), committedIndex('v0002')]);
const writes = createRequestWrites(inventory, ownership);

const REMEMBER_ME = 'userid=U1; userHash=H1';
const RENDER_STARTUP = ['identity.group_account', 'identity.login_state'];
const FORM_UNITS = ['content.file', 'content.form_response_packet', 'content.form_response_question', 'identity.redirect'];
const ORPHAN_ARCHIVE = ['content.filename_archive'];

interface FactsInit {
  path?: string;
  params?: Record<string, string>;
  url?: Record<string, string>;
  method?: string;
  cookie?: string;
  sessionManaged?: boolean;
  probes?: RequestProbes;
}

function factsOf({ path = '/', params = {}, url = {}, method = 'GET', cookie, sessionManaged = true, probes }: FactsInit = {}): RequestFacts {
  const facts = { path, params, url, method, cookies: parseCookieHeader(cookie), sessionManaged: () => sessionManaged };
  return probes === undefined ? facts : { ...facts, probes };
}

/** A path of `count` distinct segments. */
function pathOfSegments(count: number): string {
  return `/${Array.from({ length: count }, (_, i) => `s${i}`).join('/')}`;
}

/** Every run of consecutive `/`-separated segments of any of `paths`, each once. */
function runsOfPaths(...paths: string[]): string[] {
  const runs = paths.flatMap((path) => {
    const segments = path.split('/').filter((segment) => segment !== '');
    return segments.flatMap((_, start) => segments.slice(start).map((__, i) => segments.slice(start, start + i + 1).join('/')));
  });
  return [...new Set(runs)];
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
    ['orphan-archive-cleanup', { path: '/about/', params: { locks: 'true', returnid: 'R1', returnuserid: 'U1', size: 'small' } }, false],
    ['orphan-archive-cleanup', { path: '/about/', probes: { orphanArchive: true } }, true],
    ['orphan-archive-cleanup', { path: '/about/', probes: { orphanArchive: false } }, false],
    ['orphan-archive-cleanup', { path: '/about/', probes: { cfml: true } }, false],
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
    ['static', REMEMBER_ME, false, false],
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

  it.each<[string, FactsInit, string | undefined]>([
    ['a page path', { path: '/about/team/' }, 'orphanArchive'],
    ['a path needing more candidates than one probe sends', { path: pathOfSegments(45) }, 'orphanArchive'],
    ['the home page', { path: '/' }, 'orphanArchive'],
    ['an empty-segment path', { path: '//' }, 'orphanArchive'],
    ['an answered probe', { path: '/about/', probes: { orphanArchive: false } }, undefined],
  ])('the orphan archive cleanup of %s waits on: %s', (_label, init, expected) => {
    expect(guard('orphan-archive-cleanup').pending?.(factsOf(init))).toBe(expected);
  });

  it.each<[string, RouteFamily, FactsInit, boolean, string | undefined]>([
    ['CFML run for a static request', 'static', { cookie: REMEMBER_ME, probes: { cfml: true } }, true, undefined],
    ['a file served for a static request', 'static', { cookie: REMEMBER_ME, probes: { cfml: false } }, false, undefined],
    ['an unprobed static request', 'static', { cookie: REMEMBER_ME }, false, 'cfml'],
    ['an unprobed static request without a managed session', 'static', { cookie: REMEMBER_ME, sessionManaged: false }, false, undefined],
    ['an unprobed static request without the cookies', 'static', { cookie: 'userid=U1' }, false, undefined],
    ['a page request', 'page', { cookie: REMEMBER_ME }, true, undefined],
    ['an OPT-2 request legacy runs CFML for', 'opt2', { cookie: REMEMBER_ME, probes: { cfml: true } }, false, undefined],
    ['a bridge request', 'bridge', { cookie: REMEMBER_ME }, false, undefined],
  ])('the remember-me login with %s holds (%s, %s) and waits on: %s', (_label, family, init, holds, pending) => {
    const [rememberMe] = STARTUP_WRITERS;
    expect(rememberMe?.holds(family, factsOf(init))).toBe(holds);
    expect(rememberMe?.pending?.(family, factsOf(init))).toBe(pending);
  });
});

describe('orphanArchiveFilenames', () => {
  const longSegment = 'x'.repeat(4000);
  it.each<[string, Pick<RequestFacts, 'path' | 'url'>, string[] | undefined]>([
    ['the home page', { path: '/', url: {} }, []],
    ['a path naming the 404 page', { path: '/404/x', url: {} }, ['404/x', 'x']],
    ['a folder path', { path: '/a/b/', url: {} }, ['a', 'a/b', 'b']],
    [
      'an index file mid-path',
      { path: '/about/index.cfm/team', url: {} },
      ['about', 'about/index.cfm', 'about/index.cfm/team', 'index.cfm', 'index.cfm/team', 'team', 'about/team'],
    ],
    ['an upper-case index file', { path: '/INDEX.CFM', url: {} }, ['INDEX.CFM']],
    ['percent-encoded segments', { path: '/caf%C3%A9/a%20b', url: {} }, ['caf%C3%A9', 'caf%C3%A9/a%20b', 'a%20b', 'café', 'café/a b', 'a b']],
    ['a segment that does not decode', { path: '/100%/x', url: {} }, ['100%', '100%/x', 'x']],
    ['a missing template delimiter', { path: '/a,b\\c', url: {} }, ['a,b\\c', 'a', 'a/b', 'a/b/c', 'b', 'b/c', 'c']],
    ['a url path param', { path: '/index.cfm', url: { PATH: '/about/team' } }, ['index.cfm', 'about', 'about/team', 'team']],
    ['ref sections around params', { path: '/missing/ref/a/params/x/y/ref/b/', url: {} }, [...runsOfPaths('/missing/ref/a/params/x/y/ref/b/'), 'a/b']],
    ['the custom URL var delimiter', { path: '/missing/ref/a/_/x/y/ref/b/', url: {} }, [...runsOfPaths('/missing/ref/a/_/x/y/ref/b/'), 'a/b']],
    ['upper-case keywords', { path: '/missing/REF/a/PARAMS/x/y/Ref/b/', url: {} }, [...runsOfPaths('/missing/REF/a/PARAMS/x/y/Ref/b/'), 'a/b']],
    ['a tag taking one item and dropping the next', { path: '/p/ref/a/tag/t/z/ref/b/', url: {} }, [...runsOfPaths('/p/ref/a/tag/t/z/ref/b/'), 'a/b']],
    ['a date section between ref sections', { path: '/p/ref/a/date/2020/ref/b/c', url: {} }, [...runsOfPaths('/p/ref/a/date/2020/ref/b/c'), 'a/b/c', 'a/b']],
    [
      'a linkservid and a showmeta each taking one item',
      { path: '/p/ref/a/linkservid/L1/z/ref/b/showmeta/1/y/ref/c', url: {} },
      [...runsOfPaths('/p/ref/a/linkservid/L1/z/ref/b/showmeta/1/y/ref/c'), 'a/b/c', 'a/b', 'b/c'],
    ],
    [
      'an encoded keyword',
      { path: '/missing/%72ef/a/params/x/y/ref/b', url: {} },
      [...runsOfPaths('/missing/%72ef/a/params/x/y/ref/b', '/missing/ref/a/params/x/y/ref/b'), 'a/b'],
    ],
    ['one segment repeated 999 times', { path: '/a'.repeat(999), url: {} }, Array.from({ length: 999 }, (_, i) => `${'a/'.repeat(i)}a`)],
    ['the longest candidate one probe sends', { path: `/${longSegment}`, url: {} }, [longSegment]],
    ['a longer candidate than one probe sends', { path: `/${longSegment}x`, url: {} }, undefined],
  ])("names for %s render404's 404 and the candidates %j", (_label, facts, expected) => {
    const filenames = orphanArchiveFilenames(facts);
    expect(filenames === undefined ? undefined : [...filenames].sort()).toEqual(expected === undefined ? undefined : ['404', ...expected].sort());
    if (filenames !== undefined) expect(new Set(filenames).size).toBe(filenames.length);
  });

  it.each<[number, number | undefined]>([
    [44, 991],
    [45, undefined],
  ])('names for a path of %i segments %s candidates, at most the 1000 one probe sends', (count, expected) => {
    expect(orphanArchiveFilenames({ path: pathOfSegments(count), url: {} })?.length).toBe(expected);
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
    ['an anonymous page render', 'page:render', {}, []],
    ['a lockdown login', 'page:render', { params: { locks: 'true' } }, ['identity.login_state', 'identity.user_strike']],
    [
      'a magic-link login',
      'page:render',
      { params: { returnid: 'R1', returnuserid: 'U1' } },
      ['identity.group_account', 'identity.login_state'],
    ],
    ['an image rendition', 'page:render', { params: { size: 'small' } }, ['content.file']],
    ['an unprobed 404 render', 'page:render', { path: '/missing/' }, []],
    [
      'a 404 render reaching an orphan archive row',
      'page:render',
      { path: '/missing/', probes: { orphanArchive: true } },
      ['content.filename_archive'],
    ],
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
    ['page', 'page:render', { path: '/missing/' }, []],
    ['page', 'page:render', { path: '/missing/', probes: { orphanArchive: true } }, ORPHAN_ARCHIVE],
    ['static', 'static:/core/vendor/missing.js', { path: '/core/vendor/missing.js', probes: { orphanArchive: true } }, ORPHAN_ARCHIVE],
    ['api', 'api:processasyncobject', { path: '/missing/', probes: { orphanArchive: true } }, []],
    ['api', 'api:processasyncobject', { params: { returnid: 'R1', returnuserid: 'U1' } }, ['identity.group_account', 'identity.login_state']],
    ['api', 'api:processasyncobject', { params: { locks: 'true', size: 'small' } }, []],
    ['feed', 'feed:v1', { params: { returnid: 'R1', returnuserid: 'U1' } }, ['identity.group_account', 'identity.login_state']],
    ['render', 'render:file', { path: '/index.cfm/_api/render/file/', probes: { orphanArchive: true } }, ORPHAN_ARCHIVE],
    ['render', 'render:small', { path: '/index.cfm/_api/render/small/', params: { locks: 'true' } }, ['identity.login_state', 'identity.user_strike']],
    ['asset', 'asset:render', { path: '/index.cfm/_api/asset/image/', probes: { orphanArchive: true } }, ORPHAN_ARCHIVE],
    ['feed', 'feed:v1', { path: '/index.cfm/_api/feed/v1/default/', probes: { orphanArchive: true } }, ORPHAN_ARCHIVE],
    ['api', 'api:content.findone', { params: { returnid: 'R1', returnuserid: 'U1' } }, []],
  ])('adds to a %s request keyed %s the render-pipeline units its guards reach', (family, baseKey, init, expected) => {
    expect(writes.pipelineUnits({ family, baseKey }, factsOf(init)).sort()).toEqual(expected);
  });

  it.each<[RouteFamily, FactsInit, string[]]>([
    ['page', { cookie: REMEMBER_ME }, RENDER_STARTUP],
    ['trackopen', { cookie: REMEMBER_ME }, RENDER_STARTUP],
    ['static', { cookie: REMEMBER_ME }, []],
    ['static', { cookie: REMEMBER_ME, probes: { cfml: true } }, RENDER_STARTUP],
    ['static', { cookie: REMEMBER_ME, probes: { cfml: false } }, []],
    ['page', {}, []],
  ])('maps the start-up writes of a %s request to the units owning tusers.LastLogin', (family, init, expected) => {
    expect(writes.startupUnits(family, factsOf(init)).sort()).toEqual(expected);
  });

  it.each<[RouteFamily, string, FactsInit, Record<string, string[]>]>([
    ['page', 'page:render', { path: '/missing/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['static', 'static:/core/vendor/missing.js', { path: '/core/vendor/missing.js' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['page', 'page:render', { path: '/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['render', 'render:file', { path: '/index.cfm/_api/render/file/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['render', 'render:small', { path: '/index.cfm/_api/render/small/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['render', 'render:medium', { path: '/index.cfm/_api/render/medium/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['asset', 'asset:render', { path: '/index.cfm/_api/asset/image/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['feed', 'feed:v1', { path: '/index.cfm/_api/feed/v1/default/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['page', 'page:render', { path: '/missing/', probes: { orphanArchive: false } }, {}],
    ['render', 'render:file', { path: '/index.cfm/_api/render/file/', probes: { orphanArchive: false } }, {}],
    ['api', 'api:processasyncobject', { path: '/missing/' }, {}],
  ])('reports for a %s request keyed %s with %j the render-pipeline probes %j', (family, baseKey, init, expected) => {
    expect(writes.pipelineProbes({ family, baseKey }, factsOf(init))).toEqual(expected);
  });

  it.each<[RouteFamily, FactsInit, Record<string, string[]>]>([
    ['static', { cookie: REMEMBER_ME }, { cfml: RENDER_STARTUP }],
    ['static', { cookie: REMEMBER_ME, probes: { cfml: true } }, {}],
    ['static', {}, {}],
    ['page', { cookie: REMEMBER_ME }, {}],
  ])('reports for a %s request with %j the start-up probes %j', (family, init, expected) => {
    expect(writes.startupProbes(family, factsOf(init))).toEqual(expected);
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
