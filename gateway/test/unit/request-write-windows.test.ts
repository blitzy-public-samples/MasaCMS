// Write windows of legacy-bound public requests under v0002: only the units a request's own facts let legacy write are gated.
import { Buffer } from 'node:buffer';
import { fixedClock } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createResponseModes } from '../../src/admin/response-modes.js';
import { inventoryFactsOf, loadInventory, loadTableOwnership } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { RoutingIndex } from '../../src/cutover/types.js';
import { bodyParamsFrom } from '../../src/dispatcher/body.js';
import { createMatcher, type Matcher, type RoutedOutcome } from '../../src/dispatcher/match.js';
import { createRequestWrites, type RequestProbes } from '../../src/dispatcher/request-writes.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import { TEST_SERVICE_NAMES } from '../helpers/env.js';
import type { InflightRowRecord } from '../helpers/memory-store.js';
import { committedIndex, committedVariants, cutoverTable, entry, indexFor } from '../helpers/versions.js';

const URLENCODED = 'application/x-www-form-urlencoded';
const REMEMBER_ME = 'userid=8B5BD4AA-AB36-4E2C-8EE1A6E1E45DB3F0; userHash=0A1B2C3D';
const IDENTITY_LOGIN = ['identity.group_account', 'identity.login_state'];
const PAGE_LOGIN = ['identity.login_state', 'identity.user_device', 'identity.user_strike'];
const FORM_UNITS = ['content.file', 'identity.redirect'];
const RATING = ['content.content_rating', 'content.content_stats'];
const ASYNC = '/index.cfm/_api/json/v1/default/?method=processAsyncObject';
const ORPHAN_ARCHIVE = ['content.filename_archive'];
const STATIC_FILE = '/core/vendor/jquery/jquery.min.js';

// An empty env, so the committed inventory and cut-over files are used whatever OPT2_CUTOVER_DIR the shell sets.
const PATHS = resolveGatewayPaths({});
const [inventory, ownership, v0002] = await Promise.all([loadInventory(PATHS), loadTableOwnership(PATHS), committedIndex('v0002')]);

/** One request as a browser sends it. */
interface Sent {
  method?: string;
  url: string;
  form?: Record<string, string>;
  cookie?: string;
  /** Probe answers the dispatcher obtained for the request. */
  probes?: RequestProbes;
}

const matcher: Matcher = createMatcher({
  state: { active: () => v0002 },
  variants: committedVariants(),
  modes: createResponseModes(inventoryFactsOf(inventory)),
  env: {
    OPT2_SERVICE_URLS: Object.fromEntries([...TEST_SERVICE_NAMES, 'web'].map((service) => [service, `http://${service}.opt2.test`])),
    OPT2_STORAGE_ADAPTER: 'local',
    OPT2_STATE_DIR: '/nonexistent',
  },
  clock: fixedClock('2026-06-30T12:00:00Z'),
  requestWrites: createRequestWrites(inventory, ownership),
});

async function outcomeOf({ method, url, form, cookie, probes }: Sent): Promise<RoutedOutcome> {
  const verb = method ?? (form === undefined ? 'GET' : 'POST');
  const bytes = form === undefined ? undefined : Buffer.from(new URLSearchParams(form).toString());
  const headers: Record<string, string> = {
    ...(bytes === undefined ? {} : { 'content-type': URLENCODED }),
    ...(cookie === undefined ? {} : { cookie }),
  };
  const contentType = bytes === undefined ? undefined : URLENCODED;
  const outcome = await matcher.match({ url, method: verb, headers }, bodyParamsFrom(contentType, bytes, verb), v0002, probes);
  if (outcome.result === undefined) throw new TypeError(`${url} was relayed, not keyed`);
  return outcome;
}

/** The `target`-authoritative units of an outcome's entry, sorted, as its window gates them. */
function targetUnits(outcome: RoutedOutcome, index: RoutingIndex = v0002): string[] {
  return (outcome.entry?.units ?? []).filter((unit) => index.unitAuthority(unit) === 'target').sort();
}

describe('legacy-bound entries under v0002 as the request shapes them', () => {
  it.each<[string, Sent, string, string[]]>([
    ['an anonymous page render', { url: '/' }, 'page:render', []],
    ['a doaction no entry lists', { url: '/?doaction=unknownaction' }, 'page:render', []],
    ['a lockdown login', { url: '/?locks=true' }, 'page:render', ['identity.login_state', 'identity.user_strike']],
    ['a magic-link login', { url: '/?returnID=R1&returnUserID=U1' }, 'page:render', IDENTITY_LOGIN],
    ['an image rendition', { url: '/a-file/?size=small' }, 'page:render', ['content.file']],
    ['a display object render', { url: `${ASYNC}&object=search` }, 'api:processasyncobject', []],
    ['a display object acting on doactions no write entry lists', { url: `${ASYNC}&object=search&doaction=logout,zzz` }, 'api:processasyncobject', []],
    ['a rating through a display object', { url: ASYNC, form: { object: 'rater', doaction: 'saveRate', rate: '5' } }, 'api:processasyncobject', RATING],
    ['an asynchronous form submission', { url: ASYNC, form: { object: 'form', saveform: 'true' } }, 'api:processasyncobject{saveform}', FORM_UNITS],
    ['a doaction no entry lists after a known one', { url: '/', form: { doaction: 'login,zzz', username: 'u', password: 'p' } }, 'page:login', PAGE_LOGIN],
    ['a form submission beside an unknown doaction', { url: '/', form: { doaction: 'zzz', saveform: 'true' } }, 'page:saveform', FORM_UNITS],
    ['a login posted to a missing template', { url: '/zz-missing.cfm', form: { doaction: 'login' } }, 'page:login', PAGE_LOGIN],
    ['a magic link on a missing static file', { url: '/core/vendor/missing.png?returnID=R1&returnUserID=U1' }, 'static:/core/vendor/**', IDENTITY_LOGIN],
    ['a magic link on a rendered feed', { url: '/_api/feed/v1/default/?feedID=F1&content=true&returnID=R1&returnUserID=U1' }, 'feed:v1', IDENTITY_LOGIN],
  ])('routes %s on legacy under %s over only its reachable target units', async (_label, sent, route, units) => {
    const outcome = await outcomeOf(sent);
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    expect(outcome.entry).toMatchObject({ route, state: 'legacy', kind: 'legacy-write' });
    expect(targetUnits(outcome)).toEqual(units);
  });

  it.each<[string, Record<string, string>]>([
    ['an asynchronous login', { object: 'login', username: 'u', password: 'p' }],
    ['an asynchronous profile update, whose doaction adds no unit the entry lacks', { object: 'editprofile', doaction: 'updateprofile' }],
  ])('keeps %s over every unit its two account-writing branches write', async (_label, form) => {
    const outcome = await outcomeOf({ url: ASYNC, form });
    expect(outcome.entry).toBe(v0002.entryFor('api:processasyncobject'));
    expect(outcome.holdRoutes).toBeUndefined();
  });

  it('holds an asynchronous request by the write entries its doactions name, table-scoped over their units', async () => {
    const outcome = await outcomeOf({ url: `${ASYNC}&doaction=forwardEmail`, form: { object: 'rater', doaction: 'SAVERATE,,setReminder' } });
    expect(outcome).toMatchObject({ entry: { route: 'api:processasyncobject', kind: 'legacy-write' }, tableScope: true });
    expect(outcome.holdRoutes).toEqual(['page:forwardemail', 'page:saverate']);
    expect(targetUnits(outcome)).toEqual(RATING);
  });

  it('composes an unmatched page key from its listed doactions, held by the others and spanning tables when several write', async () => {
    const single = await outcomeOf({ url: '/', form: { doaction: 'login,logout,zzz' } });
    expect(single.result.key).toBe('page:login,logout,zzz');
    expect(single).toMatchObject({ entry: { route: 'page:login' }, holdRoutes: ['page:logout'] });
    expect(single.tableScope).toBeUndefined();

    const several = await outcomeOf({ url: '/', form: { doaction: 'saveRate,login' } });
    expect(several).toMatchObject({ entry: { route: 'page:saverate' }, holdRoutes: ['page:login'], tableScope: true });
    expect(targetUnits(several)).toEqual(['content.content_rating', 'content.content_stats', ...PAGE_LOGIN].sort());
  });

  it('keys a missing template by its own path while routing it under the page legacy renders', async () => {
    const outcome = await outcomeOf({ url: '/zz-missing.cfm?doaction=login' });
    expect(outcome.result.key).toBe('cfm:/zz-missing.cfm');
    expect(outcome.entry?.route).toBe('page:login');
  });

  it.each<[string, string, string]>([
    ['an email-open tracking pixel', '/_api/email/trackopen/?emailid=E1', 'trackopen:open'],
    ['the widgets redirect', '/tasks/widgets/', 'widgets:redirect'],
    ['a mail return page', '/?doaction=return', 'page:return'],
    ['a subscribe page', '/?doaction=subscribe', 'page:subscribe'],
    ['a session-managed REST spelling', '/INDEX.CFM/_api/rest/v1/default/?method=processAsyncObject&object=search', 'rest:processasyncobject'],
    ['an unlisted API family', '/_api/unknown-family/', 'apiother:/_api/unknown-family/'],
  ])('adds the remember-me login units to %s, table-scoped', async (_label, url, route) => {
    const outcome = await outcomeOf({ url, cookie: REMEMBER_ME });
    expect(outcome.entry).toMatchObject({ route, state: 'legacy', kind: 'legacy-write' });
    expect(targetUnits(outcome)).toEqual(expect.arrayContaining(IDENTITY_LOGIN));
    expect(outcome.tableScope).toBe(true);
  });

  it.each([
    ['a sessionless REST call', '/_api/rest/v1/default/?method=processAsyncObject&object=search'],
    ['a static file', '/core/vendor/jquery/jquery.min.js'],
  ])('adds no remember-me units to %s', async (_label, url) => {
    const outcome = await outcomeOf({ url, cookie: REMEMBER_ME });
    expect(targetUnits(outcome)).toEqual([]);
    expect(outcome.tableScope).toBeUndefined();
  });

  it('leaves a target entry as the version lists it, whatever the request carries', async () => {
    const url = '/core/modules/v1/rater/ajax/saveRate.cfm?returnID=R1&returnUserID=U1';
    const outcome = await outcomeOf({ url, form: { contentID: 'C1', rate: '5' }, cookie: REMEMBER_ME });
    expect(outcome.destination.kind).toBe('target');
    expect(outcome.entry).toBe(v0002.entryFor('cfm:/core/modules/v1/rater/ajax/saverate.cfm'));
    expect(outcome.tableScope).toBeUndefined();
  });

  it.each<[string, Sent, Record<string, string[]> | undefined]>([
    ['an anonymous home page render', { url: '/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['a page render that may 404', { url: '/missing-page/' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['a missing template rendered as a page', { url: '/zz-missing.cfm' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['a reload in front of a page render', { url: '/missing-page/?appreload' }, { orphanArchive: ORPHAN_ARCHIVE }],
    ['a static file with remember-me cookies', { url: STATIC_FILE, cookie: REMEMBER_ME }, { orphanArchive: ORPHAN_ARCHIVE, cfml: IDENTITY_LOGIN }],
    ['a static file with both probes answered', { url: STATIC_FILE, cookie: REMEMBER_ME, probes: { orphanArchive: false, cfml: false } }, undefined],
    ['a display object render', { url: `${ASYNC}&object=search` }, undefined],
    ['a page on remember-me cookies', { url: '/?doaction=subscribe', cookie: REMEMBER_ME }, { orphanArchive: ORPHAN_ARCHIVE }],
  ])('reports for %s the pending probes %j', async (_label, sent, pending) => {
    expect((await outcomeOf(sent)).pendingProbes).toEqual(pending);
  });

  it('reports no pending probes for a target entry', async () => {
    const outcome = await outcomeOf({ url: '/core/modules/v1/rater/ajax/saveRate.cfm', form: { contentID: 'C1', rate: '5' }, cookie: REMEMBER_ME });
    expect(outcome.destination.kind).toBe('target');
    expect(outcome.pendingProbes).toBeUndefined();
  });

  it.each<[string, Sent, string, string[]]>([
    ['a 404 render reaching an orphan archive row', { url: '/missing-page/', probes: { orphanArchive: true } }, 'page:render', ORPHAN_ARCHIVE],
    ['a 404 render reaching none', { url: '/missing-page/', probes: { orphanArchive: false } }, 'page:render', []],
    [
      'a missing static file legacy renders, with remember-me cookies',
      { url: STATIC_FILE, cookie: REMEMBER_ME, probes: { orphanArchive: false, cfml: true } },
      'static:/core/vendor/**',
      IDENTITY_LOGIN,
    ],
    [
      'a missing static file reaching an orphan archive row',
      { url: '/core/vendor/missing.js', probes: { orphanArchive: true } },
      'static:/core/vendor/**',
      ORPHAN_ARCHIVE,
    ],
    ['a static file legacy serves as a file', { url: STATIC_FILE, cookie: REMEMBER_ME, probes: { orphanArchive: false, cfml: false } }, 'static:/core/vendor/**', []],
  ])('widens %s (%j) under %s by the target units %j', async (_label, sent, route, units) => {
    const [outcome, unprobed] = await Promise.all([outcomeOf(sent), outcomeOf({ ...sent, probes: undefined })]);
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    expect(outcome.entry?.route).toBe(route);
    expect(targetUnits(outcome)).toEqual([...new Set([...targetUnits(unprobed), ...units])].sort());
    expect(targetUnits(unprobed).filter((unit) => units.includes(unit))).toEqual([]);
    expect(outcome.pendingProbes).toBeUndefined();
  });

  it('shapes the page behind a reload before the reload joins its units', async () => {
    const outcome = await outcomeOf({ url: '/?appreload&returnID=R1&returnUserID=U1' });
    const reload = v0002.entryFor('reload:application');
    expect(outcome.result).toMatchObject({ key: 'reload:application', afterReload: { key: 'page:render' } });
    expect(outcome.entry?.route).toBe('page:render');
    expect(new Set(outcome.entry?.units)).toEqual(new Set([...IDENTITY_LOGIN, 'reporting.session_tracking', ...(reload?.units ?? [])]));
    expect(outcome.holdRoutes).toEqual(['reload:application']);
  });
});

describe('legacy-bound page keys over versions whose render entry does not write', () => {
  const requestWrites = createRequestWrites(inventory, ownership);
  const matcherOver = (index: RoutingIndex): Matcher =>
    createMatcher({
      state: { active: () => index },
      variants: committedVariants(),
      modes: createResponseModes(inventoryFactsOf(inventory)),
      env: { OPT2_SERVICE_URLS: {}, OPT2_STORAGE_ADAPTER: 'local', OPT2_STATE_DIR: '/nonexistent' },
      clock: fixedClock('2026-06-30T12:00:00Z'),
      requestWrites,
    });
  const READ_RENDER = entry({ route: 'page:render', owningService: 'none', kind: 'read', units: ['reporting.session_tracking'] });
  const LOGOUT = entry({ route: 'page:logout', owningService: 'identity', kind: 'read', units: ['identity.login_state'] });

  it('routes an unknown doaction under a read render entry as listed, held by the doactions it names', async () => {
    const index = indexFor(cutoverTable({ tableVersion: 'v0101', entries: [READ_RENDER, LOGOUT] }));
    const outcome = await matcherOver(index).match({ url: '/?doaction=logout,zzz', method: 'GET', headers: {} }, bodyParamsFrom(undefined, undefined, 'GET'));
    expect(outcome.entry).toStrictEqual({ ...index.entryFor(READ_RENDER.route), state: 'legacy' });
    expect(outcome).toMatchObject({ holdRoutes: ['page:logout'] });
  });

  it('leaves an unknown doaction without an entry when the version lists no page entry, unless request start-up writes', async () => {
    const index = indexFor(cutoverTable({ tableVersion: 'v0102', entries: [] }));
    const request = { url: '/?doaction=zzz', method: 'GET', headers: {} };
    expect((await matcherOver(index).match(request, bodyParamsFrom(undefined, undefined, 'GET'))).entry).toBeUndefined();

    const remembered = await matcherOver(index).match(
      { ...request, headers: { Cookie: ['userid=U1', 'userHash=H1'] } },
      bodyParamsFrom(undefined, undefined, 'GET'),
    );
    expect(remembered.entry).toMatchObject({ route: 'page:zzz', kind: 'legacy-write', units: IDENTITY_LOGIN });
  });
});

describe('legacy-bound public requests through the gateway under v0002', () => {
  let gw: TestGateway;
  let sequence = 0;

  beforeAll(async () => {
    gw = await buildTestGateway({ version: 'v0002', services: [] });
  });

  afterAll(async () => {
    await gw.close();
  });

  /** Sends `sent` and returns its status, its windows and the in-flight rows legacy saw for it. */
  async function send({ method, url, form, cookie }: Sent) {
    sequence += 1;
    const requestId = `req-public-${String(sequence)}`;
    let duringLegacy: InflightRowRecord[] = [];
    gw.legacy.setResponse(() => {
      duringLegacy = (gw.memory?.tables.inflight ?? []).filter((row) => row.request_id === requestId).map((row) => ({ ...row }));
      return { status: 200, body: 'legacy page' };
    });
    const res = await gw.app.inject({
      method: method ?? (form === undefined ? 'GET' : 'POST'),
      url,
      headers: {
        'x-request-id': requestId,
        ...(form === undefined ? {} : { 'content-type': URLENCODED }),
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(form === undefined ? {} : { payload: new URLSearchParams(form).toString() }),
    });
    const windows = gw.migration.windows
      .filter((window) => window.requestId === requestId)
      .map(({ routeKey, units, scope }) => ({ routeKey, units: [...units].sort(), scope }));
    return { status: res.statusCode, windows, duringLegacy };
  }

  it('serves an anonymous page render with no window, in flight only as the legacy write of session tracking', async () => {
    const { status, windows, duringLegacy } = await send({ url: '/' });
    expect(status).toBe(200);
    expect(windows).toEqual([]);
    expect(duringLegacy).toEqual([expect.objectContaining({ route: 'page:render', side: 'legacy', window_id: null })]);
  });

  it('serves a display object render with no window', async () => {
    const { status, windows } = await send({ url: `${ASYNC}&object=search` });
    expect(status).toBe(200);
    expect(windows).toEqual([]);
  });

  it.each<[string, Sent, string, string[]]>([
    ['a lockdown login', { url: '/?locks=true' }, 'page:render', ['identity.login_state', 'identity.user_strike']],
    ['a magic-link login', { url: '/?returnID=R1&returnUserID=U1' }, 'page:render', IDENTITY_LOGIN],
    ['an image rendition', { url: '/a-file/?size=small' }, 'page:render', ['content.file']],
    ['an asynchronous form submission', { url: ASYNC, form: { object: 'form', saveform: 'true' } }, 'api:processasyncobject{saveform}', FORM_UNITS],
    ['a composite doaction', { url: '/?display=login', form: { doaction: 'login,zzz', username: 'u', password: 'p' } }, 'page:login', PAGE_LOGIN],
    ['a form submission beside an unknown doaction', { url: '/', form: { doaction: 'zzz', saveform: 'true' } }, 'page:saveform', FORM_UNITS],
    ['a login posted to a missing template', { url: '/zz-missing.cfm', form: { doaction: 'login' } }, 'page:login', PAGE_LOGIN],
  ])('opens one window for %s under %s over only the units it can write', async (_label, sent, routeKey, units) => {
    const { status, windows, duringLegacy } = await send(sent);
    expect(status).toBe(200);
    expect(windows).toEqual([{ routeKey, units, scope: { table: true } }]);
    expect(duringLegacy).toEqual([expect.objectContaining({ route: routeKey, side: 'legacy', window_id: expect.any(String) as string })]);
  });

  it.each<[string, string, boolean, Sent]>([
    [
      'a rating posted through a display object',
      'page:saverate',
      true,
      { url: '/_api/json/v1/default/', form: { method: 'processAsyncObject', object: 'rater', doaction: 'saveRate', rate: '5' } },
    ],
    ['a rating sent in the query string', 'page:saverate', true, { url: '/_api/json/v1/default/?method=processAsyncObject&object=rater&doaction=saveRate&rate=5' }],
    [
      'an email forward through a display object',
      'page:forwardemail',
      false,
      { url: '/_api/json/v1/default/', form: { method: 'processAsyncObject', object: 'forward_email', doaction: 'forwardEmail' } },
    ],
  ])('gates %s over exactly the target units of %s (any target unit: %s)', async (_label, pageRoute, windowed, sent) => {
    const units = (v0002.entryFor(pageRoute)?.units ?? []).filter((unit) => v0002.unitAuthority(unit) === 'target').sort();
    expect(units.length > 0).toBe(windowed);
    const { status, windows } = await send(sent);
    expect(status).toBe(200);
    expect(windows).toEqual(windowed ? [{ routeKey: 'api:processasyncobject', units, scope: { table: true } }] : []);
  });

  it('opens a window over every target unit of processAsyncObject for an asynchronous login', async () => {
    const { windows } = await send({ url: ASYNC, form: { object: 'login', username: 'u', password: 'p' } });
    const units = (v0002.entryFor('api:processasyncobject')?.units ?? []).filter((unit) => v0002.unitAuthority(unit) === 'target').sort();
    expect(units).toEqual(expect.arrayContaining([...PAGE_LOGIN, 'people.person']));
    expect(windows).toEqual([{ routeKey: 'api:processasyncobject', units, scope: { table: true } }]);
  });

  it.each<[string, string, string]>([
    ['an email-open tracking pixel', '/_api/email/trackopen/?emailid=E1', 'trackopen:open'],
    ['the widgets redirect', '/tasks/widgets/', 'widgets:redirect'],
    ['a mail return page', '/?doaction=return', 'page:return'],
    ['a subscribe page', '/?doaction=subscribe', 'page:subscribe'],
  ])('opens a table-wide window over the remember-me login units for %s carrying remember-me cookies', async (_label, url, routeKey) => {
    const { windows, duringLegacy } = await send({ url, cookie: REMEMBER_ME });
    expect(windows).toEqual([{ routeKey, units: IDENTITY_LOGIN, scope: { table: true } }]);
    expect(duringLegacy).toEqual([expect.objectContaining({ route: routeKey, window_id: expect.any(String) as string })]);
  });

  it.each([
    ['a sessionless REST call', '/_api/rest/v1/default/?method=processAsyncObject&object=search'],
    ['a static file legacy serves as a file', STATIC_FILE],
  ])('opens no window for %s carrying remember-me cookies', async (_label, url) => {
    gw.legacy.staticFiles.add(STATIC_FILE);
    try {
      const { windows } = await send({ url, cookie: REMEMBER_ME });
      expect(windows).toEqual([]);
    } finally {
      gw.legacy.staticFiles.delete(STATIC_FILE);
    }
  });

  it('keeps serving anonymous page renders while migration refuses every window, as when strategies-content is down', async () => {
    gw.migration.setOpen({ status: 503 });
    try {
      const before = gw.migration.requests.length;
      const rendered = await send({ url: '/opt-2-seed-contact-page/' });
      expect(rendered.status).toBe(200);
      expect(gw.migration.requests.slice(before).filter((req) => req.path === '/internal/v1/windows')).toEqual([]);

      const login = await send({ url: '/?locks=true' });
      expect(login.status).toBe(503);
    } finally {
      gw.migration.setOpen('ok');
    }
  });
});
