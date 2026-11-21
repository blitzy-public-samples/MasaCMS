// Requests under v0002 whose JSON body, fixture path, API path params or admin path pairs carry text the target cannot store or bind as legacy does: halted to legacy inside a write window; NUL path ids the target answers as legacy stay on it.
import { Buffer } from 'node:buffer';
import { fixedClock } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createResponseModes } from '../../src/admin/response-modes.js';
import { inventoryFactsOf, loadInventory, loadTableOwnership } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { OwningService } from '../../src/cutover/types.js';
import { bodyParamsFrom } from '../../src/dispatcher/body.js';
import { createMatcher, type Matcher, type RoutedOutcome } from '../../src/dispatcher/match.js';
import { createRequestWrites } from '../../src/dispatcher/request-writes.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import { TEST_SERVICE_NAMES } from '../helpers/env.js';
import { committedIndex, committedVariants } from '../helpers/versions.js';

const JSON_TYPE = 'application/json';
const URLENCODED = 'application/x-www-form-urlencoded';
const FIXTURE = '/legacy-fixtures/cfml/api.cfm';
const FINANCE_CREATE = `${FIXTURE}/finance/records?siteid=tenant-a`;
const TARGETING_SAVE = '/_api/json/v1/tenant-a/variationtargeting/';
const SIGN = `${FIXTURE}/esignature/requests/A1B2C3D4-E5F6-7890-ABCDEF1234567890/sign`;
const SIGN_ROUTE = 'fixture:esignature/requests/{id}/sign@post';
const API = '/_api/json/v1/tenant-a';
const REST = '/_api/rest/v1/tenant-a';
const PATH_ID = 'A1B2C3D4-E5F6-7890-ABCDEF1234567890';

// An empty env, so the committed inventory and cut-over files are used whatever OPT2_CUTOVER_DIR the shell sets.
const PATHS = resolveGatewayPaths({});
const [inventory, ownership, v0002] = await Promise.all([loadInventory(PATHS), loadTableOwnership(PATHS), committedIndex('v0002')]);
const facts = inventoryFactsOf(inventory);

const matcher: Matcher = createMatcher({
  state: { active: () => v0002 },
  variants: committedVariants(),
  modes: createResponseModes(facts),
  // The entities' remote functions, as the gateway reads them from the inventory.
  routeKeyOptions: { entityRemoteFunctions: facts.entityRemoteFunctions },
  env: {
    OPT2_SERVICE_URLS: Object.fromEntries([...TEST_SERVICE_NAMES, 'web'].map((service) => [service, `http://${service}.opt2.test`])),
    OPT2_STORAGE_ADAPTER: 'local',
    OPT2_STATE_DIR: '/nonexistent',
  },
  clock: fixedClock('2026-06-30T12:00:00Z'),
  requestWrites: createRequestWrites(inventory, ownership),
});

/** A POST of `body` to `url`: JSON text under `contentType`, JSON by default, or url-encoded form text. */
async function outcomeOf(url: string, body: unknown, contentType = JSON_TYPE): Promise<RoutedOutcome> {
  const bytes = Buffer.from(contentType === URLENCODED ? String(body) : JSON.stringify(body));
  const outcome = await matcher.match({ url, method: 'POST', headers: { 'content-type': contentType } }, bodyParamsFrom(contentType, bytes, 'POST'));
  if (outcome.result === undefined) throw new TypeError(`${url} was relayed, not keyed`);
  return outcome;
}

/** The `target`-authoritative units of an outcome's entry, sorted, as its window gates them. */
function targetUnits(outcome: RoutedOutcome): string[] {
  return (outcome.entry?.units ?? []).filter((unit) => v0002.unitAuthority(unit) === 'target').sort();
}

describe('JSON bodies holding text the target cannot store, matched under v0002', () => {
  it.each<[string, string, (text: string) => unknown, string, OwningService]>([
    ['a fixture finance create', FINANCE_CREATE, (text) => ({ title: text, amount: '1', period: '2026-06' }), 'fixture:finance/records@post', 'finance'],
    ['a JSON API variation-targeting save', TARGETING_SAVE, (text) => ({ contentid: 'C1', initjs: text }), 'api:variationtargeting.save', 'strategies-content'],
    ['a REST variation-targeting save', '/_api/rest/v1/tenant-a/variationtargeting', (text) => ({ targetingjs: text }), 'rest:variationtargeting.save', 'strategies-content'],
    ['a fixture message filled from template variables', `${FIXTURE}/communications/messages`, (text) => ({ templateId: 'T1', to: 'a@example.org', variables: { name: text } }), 'fixture:communications/messages@post', 'communications'],
  ])('serves %s holding a NUL on legacy as a legacy-write of its entry, and without the NUL on the target', async (_label, url, body, route, service) => {
    const listed = v0002.entryFor(route);
    expect(listed).toMatchObject({ state: 'target', kind: 'write' });

    const halted = await outcomeOf(url, body('Q2\u0000travel'));
    expect(halted.result?.key).toBe(route);
    expect(halted.entry).toMatchObject({ route, state: 'legacy', kind: 'legacy-write', group: listed?.group });
    expect(halted.destination).toStrictEqual({ kind: 'legacy' });
    expect(targetUnits(halted).length).toBeGreaterThan(0);

    const carried = await outcomeOf(url, body('Q2 travel'));
    expect(carried.entry).toBe(listed);
    expect(carried.destination).toMatchObject({ kind: 'target', service });
  });

  it.each<[string, string, (text: string) => unknown, string, OwningService]>([
    ['a fixture finance create', FINANCE_CREATE, (text) => ({ title: text, amount: '1', period: '2026-06' }), 'fixture:finance/records@post', 'finance'],
    ['a fixture template create', `${FIXTURE}/communications/templates?siteid=tenant-a`, (text) => ({ name: text, subject: 'S', bodyText: 'B' }), 'fixture:communications/templates@post', 'communications'],
    ['an e-signature sign', SIGN, (text) => ({ typedName: text }), SIGN_ROUTE, 'e-signature'],
    ['a survey response', `${FIXTURE}/surveys/surveys/${PATH_ID}/responses?siteid=tenant-a`, (text) => ({ answers: text }), 'fixture:surveys/surveys/{id}/responses@post', 'surveys'],
    ['a timesheet day return', `${FIXTURE}/timesheets/days/${PATH_ID}/return?siteid=tenant-a`, (text) => ({ comment: text }), 'fixture:timesheets/days/{id}/return@post', 'timesheets'],
  ])('serves %s holding an unpaired surrogate on legacy as a legacy-write of its entry, and a surrogate pair or plain text on the target', async (_label, url, body, route, service) => {
    const listed = v0002.entryFor(route);
    expect(listed).toMatchObject({ state: 'target', kind: 'write' });

    const halted = await outcomeOf(url, body('Jane \ud800'));
    expect(halted.result?.key).toBe(route);
    expect(halted.entry).toMatchObject({ route, state: 'legacy', kind: 'legacy-write', group: listed?.group });
    expect(halted.destination).toStrictEqual({ kind: 'legacy' });
    expect(targetUnits(halted).length).toBeGreaterThan(0);

    for (const text of ['Jane \ud83d\ude00', 'Jane']) {
      const carried = await outcomeOf(url, body(text));
      expect(carried.entry).toBe(listed);
      expect(carried.destination).toMatchObject({ kind: 'target', service });
    }
  });

  it.each<[string, string, unknown, string, OwningService]>([
    ['a reporting export create, which stores no request text', `${FIXTURE}/reporting/exports?siteid=tenant-a`, { definitionId: PATH_ID, format: 'csv', note: '\ud800' }, 'fixture:reporting/exports@post', 'reporting'],
    ['a survey schedule, which stores no request text', `${FIXTURE}/surveys/surveys/${PATH_ID}/schedule?siteid=tenant-a`, { launchAt: '\ud800' }, 'fixture:surveys/surveys/{id}/schedule@post', 'surveys'],
    ['a JSON API variation-targeting save, which Masa binds as varchar and stores as `?`', TARGETING_SAVE, { contentid: 'C1', initjs: '\ud800x' }, 'api:variationtargeting.save', 'strategies-content'],
  ])('keeps %s holding an unpaired surrogate on the target', async (_label, url, body, route, service) => {
    const outcome = await outcomeOf(url, body);
    expect(outcome.entry).toBe(v0002.entryFor(route));
    expect(outcome.destination).toMatchObject({ kind: 'target', service });
  });

  const EXPORT_CREATE = `${FIXTURE}/reporting/exports?siteid=tenant-a`;
  const SCHEDULE = `${FIXTURE}/surveys/surveys/${PATH_ID}/schedule?siteid=tenant-a`;

  it.each<[string, string, unknown, string, OwningService]>([
    ['a reporting export create whose definitionId', EXPORT_CREATE, { definitionId: `${PATH_ID}\u0000`, format: 'csv' }, 'fixture:reporting/exports@post', 'reporting'],
    ['a reporting export create whose siteid, format and asOf', EXPORT_CREATE, { siteid: '\u0000', definitionId: PATH_ID, format: 'csv\u0000', asOf: '2026-06-30\u0000' }, 'fixture:reporting/exports@post', 'reporting'],
    ['a reporting export create whose unread key', EXPORT_CREATE, { definitionId: PATH_ID, format: 'csv', 'no\u0000te': 'x' }, 'fixture:reporting/exports@post', 'reporting'],
    ['a survey schedule whose launchAt', SCHEDULE, { launchAt: '2026-07-01T09:00:00\u0000' }, 'fixture:surveys/surveys/{id}/schedule@post', 'surveys'],
    ['a survey schedule whose reminders text', SCHEDULE, { launchAt: '2026-07-01T09:00:00', reminders: '[{"offsetMinutes":5,"x":"a\u0000b"}]' }, 'fixture:surveys/surveys/{id}/schedule@post', 'surveys'],
    ['a survey schedule whose path id', SCHEDULE.replace(PATH_ID, `${PATH_ID}%00`), { launchAt: '2026-07-01T09:00:00' }, 'fixture:surveys/surveys/{id}/schedule@post', 'surveys'],
  ])('keeps %s holds a NUL on the target, which answers it as legacy does, as legacy would start a thread or ACF tasks outliving the window', async (_label, url, body, route, service) => {
    const listed = v0002.entryFor(route);
    expect(listed).toMatchObject({ state: 'target', kind: 'write' });
    const outcome = await outcomeOf(url, body);
    expect(outcome.result?.key).toBe(route);
    expect(outcome.entry).toBe(listed);
    expect(outcome.destination).toMatchObject({ kind: 'target', service });
  });

  /** The outcome of `method` to `url` with `{id}` replaced by `id`, a POST carrying a url-encoded form. */
  async function idOutcome(method: string, url: string, id: string): Promise<RoutedOutcome> {
    const contentType = method === 'POST' ? URLENCODED : undefined;
    const outcome = await matcher.match(
      { url: url.replace('{id}', id), method, headers: contentType === undefined ? {} : { 'content-type': contentType } },
      bodyParamsFrom(contentType, contentType === undefined ? undefined : Buffer.from('comment=x'), method),
    );
    if (outcome.result === undefined) throw new TypeError(`${url} was relayed, not keyed`);
    return outcome;
  }

  it.each<[string, string, string, string, OwningService]>([
    ['a timesheet day return', 'POST', `${FIXTURE}/timesheets/days/{id}/return?siteid=tenant-a`, 'fixture:timesheets/days/{id}/return@post', 'timesheets'],
    ['a person archive', 'POST', `${FIXTURE}/people/persons/{id}/archive?siteid=tenant-a`, 'fixture:people/persons/{id}/archive@post', 'people'],
  ])('serves %s whose path id holds a NUL on legacy under its entry, a writer as a legacy-write, and its id without the NUL on the target', async (_label, method, url, route, service) => {
    const listed = v0002.entryFor(route);
    expect(listed).toMatchObject({ state: 'target' });

    const halted = await idOutcome(method, url, 'A1B2C3D4-E5F6-7890-ABCDEF1234567890%00');
    expect(halted.result?.key).toBe(route);
    expect(halted.entry).toMatchObject({ route, state: 'legacy', kind: listed?.kind === 'write' ? 'legacy-write' : listed?.kind });
    expect(halted.destination).toStrictEqual({ kind: 'legacy' });
    if (listed?.kind === 'write') expect(targetUnits(halted).length).toBeGreaterThan(0);
    expect((await idOutcome(method, url, 'abc%00def')).destination).toStrictEqual({ kind: 'legacy' });

    const carried = await idOutcome(method, url, 'A1B2C3D4-E5F6-7890-ABCDEF1234567890');
    expect(carried.entry).toBe(listed);
    expect(carried.destination).toMatchObject({ kind: 'target', service });
  });

  it.each<[string, string, string, string, OwningService]>([
    ['a finance record read', 'GET', `${FIXTURE}/finance/records/{id}?siteid=tenant-a`, 'fixture:finance/records/{id}@get', 'finance'],
    ['a finance submit', 'POST', `${FIXTURE}/finance/records/{id}/submit?siteid=tenant-a`, 'fixture:finance/records/{id}/submit@post', 'finance'],
    ['a survey response list', 'GET', `${FIXTURE}/surveys/surveys/{id}/responses?siteid=tenant-a`, 'fixture:surveys/surveys/{id}/responses@get', 'surveys'],
    ['a survey launch', 'POST', `${FIXTURE}/surveys/surveys/{id}/launch?siteid=tenant-a`, 'fixture:surveys/surveys/{id}/launch@post', 'surveys'],
    ['an e-signature sign', 'POST', `${SIGN.replace(PATH_ID, '{id}')}?siteid=tenant-a`, SIGN_ROUTE, 'e-signature'],
  ])('keeps %s whose path id holds a NUL on the target under its entry, as its service finds no row for it as legacy does', async (_label, method, url, route, service) => {
    const listed = v0002.entryFor(route);
    expect(listed).toMatchObject({ state: 'target' });
    for (const id of [`${PATH_ID}%00`, `${PATH_ID.slice(0, 8)}%00${PATH_ID.slice(8)}`, 'abc%00def', '%00']) {
      const outcome = await idOutcome(method, url, id);
      expect([outcome.result?.key, outcome.entry]).toStrictEqual([route, listed]);
      expect(outcome.destination).toMatchObject({ kind: 'target', service });
    }
  });

  it.each<[string, string, unknown, string]>([
    ['a url NUL, which legacy start-up strips', `${FINANCE_CREATE}&title=Q2%00travel&amount=1&period=2026-06`, 'siteid=tenant-a', URLENCODED],
    ['a form NUL, which legacy start-up strips', FINANCE_CREATE, 'title=Q2%00travel&amount=1&period=2026-06', URLENCODED],
    ['a url name holding a NUL, which legacy start-up copies to its stripped name', `${FINANCE_CREATE}&ti%00tle=Q2&amount=1&period=2026-06`, 'siteid=tenant-a', URLENCODED],
    ['a form name holding a NUL', FINANCE_CREATE, 'ti%00tle=Q2&amount=1&period=2026-06', URLENCODED],
    ['a JSON body sent as text/plain, which legacy does not read', FINANCE_CREATE, { title: 'Q2\u0000travel' }, 'text/plain'],
  ])('keeps a fixture finance create carrying %s on finance', async (_label, url, body, contentType) => {
    const outcome = await outcomeOf(url, body, contentType);
    expect(outcome.entry).toBe(v0002.entryFor('fixture:finance/records@post'));
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'finance' });
  });
});

describe('JSON API and REST paths holding a NUL, matched under v0002', () => {
  /** A request of `method` to `url`, a POST or PUT carrying an empty form. */
  async function pathOutcome(method: string, url: string): Promise<RoutedOutcome> {
    const form = method === 'POST' || method === 'PUT';
    const headers = form ? { 'content-type': URLENCODED } : {};
    const outcome = await matcher.match({ url, method, headers }, bodyParamsFrom(form ? URLENCODED : undefined, form ? Buffer.alloc(0) : undefined, method));
    if (outcome.result === undefined) throw new TypeError(`${url} was relayed, not keyed`);
    return outcome;
  }

  it.each<[string, string, string, string, string, OwningService]>([
    ['a JSON API delete on a 35-character path id', 'DELETE', `${API}/category/${PATH_ID.slice(0, 34)}%00`, `${API}/category/${PATH_ID}`, 'api:category.delete', 'strategies-content'],
    ['a REST save on a path id', 'PUT', `${REST}/variationtargeting/${PATH_ID.slice(0, 8)}%00${PATH_ID.slice(9)}`, `${REST}/variationtargeting/${PATH_ID}`, 'rest:variationtargeting.save', 'strategies-content'],
    ['a JSON API delete on a path-pair id', 'DELETE', `${API}/delete/entityname/feed/id/${PATH_ID}%00`, `${API}/delete/entityname/feed/id/${PATH_ID}`, 'api:feed.delete', 'strategies-content'],
    ['a JSON API save of a path-pair value', 'POST', `${API}/save/entityname/category/name/a%00b`, `${API}/save/entityname/category/name/ab`, 'api:category.save', 'strategies-content'],
    ['a REST login on a path-pair username', 'GET', `${REST}/login/username/admin%00/password/x`, `${REST}/login/username/admin/password/x`, 'rest:login', 'identity'],
  ])('serves %s holding a NUL on legacy as a legacy-write of its entry, and without the NUL on the target', async (_label, method, url, clean, route, service) => {
    const listed = v0002.entryFor(route);
    expect(listed).toMatchObject({ state: 'target', kind: 'write' });

    const halted = await pathOutcome(method, url);
    expect(halted.result.key).toBe(route);
    expect(halted.entry).toMatchObject({ route, state: 'legacy', kind: 'legacy-write', group: listed?.group });
    expect(halted.destination).toStrictEqual({ kind: 'legacy' });
    expect(targetUnits(halted).length).toBeGreaterThan(0);

    const carried = await pathOutcome(method, clean);
    expect(carried.entry).toBe(listed);
    expect(carried.destination).toMatchObject({ kind: 'target', service });
  });

  it.each<[string, string, string, string, OwningService]>([
    ['segments after a 35-character id, which processRequest never reads', 'DELETE', `${API}/category/${PATH_ID}/x/y%00`, 'api:category.delete', 'strategies-content'],
    ['a path-pair name, which parseParamsFromPath strips', 'POST', `${API}/save/entityname/category/na%00me/x`, 'api:category.save', 'strategies-content'],
    ['a REST OAuth endpoint segment, matched only against names', 'GET', `${REST}/oauth2/token%00`, 'rest:oauth2', 'identity'],
    ['a REST login path-pair name', 'GET', `${REST}/login/x%00`, 'rest:login', 'identity'],
    ['a url parameter name, which start-up copies to its stripped name', 'POST', `${API}/category/?na%00me=x`, 'api:category.save', 'strategies-content'],
  ])('keeps a request whose NUL sits in %s on the target, as legacy answers it as without the NUL', async (_label, method, url, route, service) => {
    const outcome = await pathOutcome(method, url);
    expect(outcome.entry).toBe(v0002.entryFor(route));
    expect(outcome.destination).toMatchObject({ kind: 'target', service });
  });

  it.each<[string, string]>([
    ['in the path id of the bean it loads', `${API}/comment/${PATH_ID.slice(0, 34)}%00/flag`],
    ['in a segment after the function', `${API}/comment/flag/x%00`],
  ])('serves a comment flag whose NUL sits %s on legacy under its legacy-write entry, halted under EX-COMMENT-REMOTE-SITE', async (_label, url) => {
    const outcome = await pathOutcome('POST', url);
    expect(outcome.result.key).toBe('api:comment.~flag');
    expect(outcome.entry).toMatchObject({ route: 'api:comment.~flag', state: 'legacy', kind: 'legacy-write' });
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
  });

  it.each<[string, string, string]>([
    ['an entity segment', 'POST', `${API}/cate%00gory/`],
    ['a method segment after a path id', 'POST', `${API}/comment/${PATH_ID}/fl%00ag`],
    ['the id of a JSON API read', 'GET', `${API}/content/${PATH_ID.slice(0, 34)}%00`],
  ])('serves a request whose NUL sits in %s on legacy, as before the halt', async (_label, method, url) => {
    const outcome = await pathOutcome(method, url);
    expect(outcome.destination).toStrictEqual({ kind: 'legacy' });
    expect(outcome.entry?.state ?? 'legacy').toBe('legacy');
  });
});

describe('admin path pairs holding a NUL, matched under v0002', () => {
  /** A url-encoded POST of `form` to `url`. */
  async function adminOutcome(url: string, form: string): Promise<RoutedOutcome> {
    const outcome = await matcher.match({ url, method: 'POST', headers: { 'content-type': URLENCODED } }, bodyParamsFrom(URLENCODED, Buffer.from(form), 'POST'));
    if (outcome.result === undefined) throw new TypeError(`${url} was relayed, not keyed`);
    return outcome;
  }

  it.each<[string, string, string, string, string]>([
    ['a group create', '/admin/index.cfm/cusers/update/groupname/g%00n?muraAction=cUsers.update', '/admin/index.cfm/cusers/update/groupname/gn?muraAction=cUsers.update', 'type=1&action=Add', 'admin:cusers.update{type=1}'],
    ['a user create', '/admin/index.cfm/cusers/update/fname/a%00b?muraAction=cUsers.update', '/admin/index.cfm/cusers/update/fname/ab?muraAction=cUsers.update', 'type=2&action=Add', 'admin:cusers.update{type=2,action=add}'],
    ['an address save', '/admin/index.cfm/cusers/updateaddress/address1/a%00b', '/admin/index.cfm/cusers/updateaddress/address1/ab', 'action=Add', 'admin:cusers.updateaddress'],
    ['a category save', '/admin/index.cfm/ccategory/update/name/a%00b', '/admin/index.cfm/ccategory/update/name/ab', 'action=add', 'admin:ccategory.update'],
    ['a feed save', '/admin/index.cfm/cfeed/update/name/a%00b', '/admin/index.cfm/cfeed/update/name/ab', 'action=add', 'admin:cfeed.update'],
    ['a change set save', '/admin/index.cfm/cchangesets/save/name/a%00b', '/admin/index.cfm/cchangesets/save/name/ab', 'action=', 'admin:cchangesets.save'],
    ['a category save naming a NUL-holding pair beside its posted name', '/admin/index.cfm/ccategory/update/na%00me/x', '/admin/index.cfm/ccategory/update/nam/x', 'name=Real', 'admin:ccategory.update'],
  ])('serves %s whose path pair holds a NUL on legacy as a legacy-write of its entry, and the pair without it on web', async (_label, url, clean, form, route) => {
    const listed = v0002.entryFor(route);
    expect(listed).toMatchObject({ state: 'target', kind: 'write' });

    const halted = await adminOutcome(url, form);
    expect(halted.result.key).toBe(route);
    expect(halted.entry).toMatchObject({ route, state: 'legacy', kind: 'legacy-write', group: listed?.group });
    expect(halted.destination).toStrictEqual({ kind: 'legacy' });
    expect(targetUnits(halted).length).toBeGreaterThan(0);

    const carried = await adminOutcome(clean, form);
    expect(carried.entry).toBe(listed);
    expect(carried.destination).toMatchObject({ kind: 'target', service: 'web', isWeb: true });
  });

  it('keeps a category save on web when its posted name replaces a NUL-holding path-pair value, as legacy stores the posted one', async () => {
    const outcome = await adminOutcome('/admin/index.cfm/ccategory/update/name/a%00b', 'action=add&name=Real');
    expect(outcome.entry).toBe(v0002.entryFor('admin:ccategory.update'));
    expect(outcome.destination).toMatchObject({ kind: 'target', service: 'web', isWeb: true });
  });
});



describe('JSON bodies holding text the target cannot store, through the gateway under v0002', () => {
  let gw: TestGateway;
  let sequence = 0;

  beforeAll(async () => {
    gw = await buildTestGateway({ version: 'v0002', services: [] });
  });

  afterAll(async () => {
    await gw.close();
  });

  it.each<[string, string, unknown, string]>([
    ['a fixture finance create', FINANCE_CREATE, { title: 'Q2\u0000travel', amount: '1', period: '2026-06' }, 'fixture:finance/records@post'],
    ['a JSON API variation-targeting save', TARGETING_SAVE, { contentid: 'C1', initjs: 'a\u0000b' }, 'api:variationtargeting.save'],
    ['a fixture timesheet day return holding an unpaired surrogate', `${FIXTURE}/timesheets/days/${PATH_ID}/return?siteid=tenant-a`, { comment: 'x\ud800' }, 'fixture:timesheets/days/{id}/return@post'],
  ])('forwards %s to legacy inside one write window over its target units', async (_label, url, body, routeKey) => {
    sequence += 1;
    const requestId = `req-unstorable-${String(sequence)}`;
    let forwarded = '';
    gw.legacy.setResponse((request) => {
      forwarded = request.body.toString('utf8');
      return { status: 200, body: '{"data":{}}' };
    });
    const res = await gw.app.inject({ method: 'POST', url, headers: { 'x-request-id': requestId, 'content-type': JSON_TYPE }, payload: JSON.stringify(body) });

    expect(res.statusCode).toBe(200);
    expect(forwarded).toBe(JSON.stringify(body));
    const units = (v0002.entryFor(routeKey)?.units ?? []).filter((unit) => v0002.unitAuthority(unit) === 'target').sort();
    const windows = gw.migration.windows.filter((window) => window.requestId === requestId).map((window) => ({ routeKey: window.routeKey, units: [...window.units].sort() }));
    expect(windows).toEqual([{ routeKey, units }]);
  });

  it('forwards a fixture write whose path id holds a NUL to legacy as sent, inside one write window over its target units', async () => {
    const requestId = 'req-unstorable-path';
    const url = `${FIXTURE}/timesheets/days/A1B2C3D4-E5F6-7890-ABCDEF1234567890%00/submit?siteid=tenant-a`;
    let forwarded = '';
    gw.legacy.setResponse((request) => {
      forwarded = request.url;
      return { status: 404, body: '{"apiversion":"v1","method":"timesheets.days.submit","error":{"code":"invalid_request","message":"Not Found"}}' };
    });
    const res = await gw.app.inject({ method: 'POST', url, headers: { 'x-request-id': requestId, 'content-type': URLENCODED }, payload: 'x=1' });

    expect(res.statusCode).toBe(404);
    expect(forwarded).toBe(url);
    const routeKey = 'fixture:timesheets/days/{id}/submit@post';
    const units = (v0002.entryFor(routeKey)?.units ?? []).filter((unit) => v0002.unitAuthority(unit) === 'target').sort();
    const windows = gw.migration.windows.filter((window) => window.requestId === requestId).map((window) => ({ routeKey: window.routeKey, units: [...window.units].sort() }));
    expect(windows).toEqual([{ routeKey, units }]);
  });

  it('forwards a JSON API delete whose path id holds a NUL to legacy as sent, inside one write window over its target units', async () => {
    const requestId = 'req-unstorable-api-path';
    const url = `${API}/category/${PATH_ID.slice(0, 34)}%00`;
    let forwarded = '';
    gw.legacy.setResponse((request) => {
      forwarded = request.url;
      return { status: 200, body: '{"apiversion":"v1","data":"","method":"delete"}' };
    });
    const res = await gw.app.inject({ method: 'DELETE', url, headers: { 'x-request-id': requestId } });

    expect(res.statusCode).toBe(200);
    expect(forwarded).toBe(url);
    const routeKey = 'api:category.delete';
    const units = (v0002.entryFor(routeKey)?.units ?? []).filter((unit) => v0002.unitAuthority(unit) === 'target').sort();
    const windows = gw.migration.windows.filter((window) => window.requestId === requestId).map((window) => ({ routeKey: window.routeKey, units: [...window.units].sort() }));
    expect(windows).toEqual([{ routeKey, units }]);
  });

  it.each<[string, string, unknown, string]>([
    ['a reporting export create', `${FIXTURE}/reporting/exports?siteid=tenant-a`, { definitionId: `${PATH_ID}\u0000`, format: 'csv' }, 'reporting'],
    ['a survey schedule', `${FIXTURE}/surveys/surveys/${PATH_ID}%00/schedule?siteid=tenant-a`, { launchAt: '2026-07-01T09:00:00', note: 'a\u0000b' }, 'surveys'],
    ['a finance submit whose path id', `${FIXTURE}/finance/records/${PATH_ID}%00/submit?siteid=tenant-a`, { note: 'x' }, 'finance'],
  ])('forwards %s holding a NUL to its service as sent, never to legacy or inside a window', async (_label, url, body, service) => {
    const targeted = await buildTestGateway({ version: 'v0002', services: ['reporting', 'surveys', 'finance'] });
    try {
      const requestId = `req-nul-answered-${service}`;
      const res = await targeted.app.inject({ method: 'POST', url, headers: { 'x-request-id': requestId, 'content-type': JSON_TYPE }, payload: JSON.stringify(body) });

      expect(res.statusCode).toBe(200);
      expect(targeted.targets[service]?.requests.map((request) => [request.url, request.body.toString('utf8')])).toEqual([[url, JSON.stringify(body)]]);
      // Only the session bridge's describe reaches the legacy origin.
      expect(targeted.legacy.requests.filter((request) => !request.path.startsWith('/gateway/legacy-bridge/'))).toEqual([]);
      expect(targeted.migration.windows.filter((window) => window.requestId === requestId)).toEqual([]);
    } finally {
      await targeted.close();
    }
  });

  it("adopts a new client's legacy session at the default site when the siteid of its export create holds a NUL, which names no site", async () => {
    const targeted = await buildTestGateway({ version: 'v0002', services: ['reporting'] });
    try {
      const url = `${FIXTURE}/reporting/exports`;
      const body = { siteid: 'tenant-a\u0000', definitionId: PATH_ID, format: 'csv' };
      const res = await targeted.app.inject({ method: 'POST', url, headers: { 'content-type': JSON_TYPE }, payload: JSON.stringify(body) });

      expect(res.statusCode).toBe(200);
      expect([...targeted.identity.sessions.values()].map((session) => session.siteId)).toEqual(['default']);
      expect(targeted.targets.reporting?.requests.map((request) => request.body.toString('utf8'))).toEqual([JSON.stringify(body)]);
    } finally {
      await targeted.close();
    }
  });

  it('forwards an admin category save whose path pair holds a NUL to legacy as sent, inside one write window over its target units', async () => {
    const requestId = 'req-unstorable-admin-path';
    const url = '/admin/index.cfm/ccategory/update/name/a%00b?muraAction=cCategory.update&siteid=tenant-a';
    gw.legacy.setResponse({ status: 302, headers: { location: './?muraAction=cCategory.list&siteid=tenant-a' }, body: '' });
    const res = await gw.app.inject({ method: 'POST', url, headers: { 'x-request-id': requestId, 'content-type': URLENCODED }, payload: 'action=add&categoryID=' });

    expect(res.statusCode).toBe(302);
    expect(gw.legacy.requests.map((request) => [request.method, request.url])).toContainEqual(['POST', url]);
    const routeKey = 'admin:ccategory.update';
    const units = (v0002.entryFor(routeKey)?.units ?? []).filter((unit) => v0002.unitAuthority(unit) === 'target').sort();
    const windows = gw.migration.windows.filter((window) => window.requestId === requestId).map((window) => ({ routeKey: window.routeKey, units: [...window.units].sort() }));
    expect(windows).toEqual([{ routeKey, units }]);
  });
});
