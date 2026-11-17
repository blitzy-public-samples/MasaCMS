// Unit tests for the url-scope-query rule: legacy's `?&…` URLs compare without their per-request parameter order.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, scenarioById, type Scenario } from '../../../src/golden/catalogue.js';
import {
  compareNormalised,
  createIdOrdinals,
  createNormaliseState,
  loadRules,
  normaliseStep,
  normaliseText,
  normaliseUrl,
  normaliseValue,
  type Difference,
  type NormalisedRun,
  type NormaliseRules,
} from '../../../src/golden/normalise/index.js';
import type { RecordedResponse, StepRecord } from '../../../src/golden/steps.js';
import type { HttpHop } from '../../../src/lib/http.js';

const CAPTURE_HOST = 'localhost:8500';
const REPLAY_HOST = '127.0.0.1:8100';
const MODULE = '00000000000000000000000000000000000';
const TOP = '00000000000000000000000000000000001';
const ROUTE = `/admin/?muraAction=cArch.list&siteid=default&moduleid=${MODULE}&topid=${TOP}`;
const STEP = 'protected-after-logout';

// Three orders legacy answered for the same anonymous ROUTE, one session, back to back.
const ORDER_A = [`moduleid=${MODULE}`, 'muraAction=cArch.list', `topid=${TOP}`, 'siteid=default'];
const ORDER_B = ['siteid=default', `moduleid=${MODULE}`, 'muraAction=cArch.list', `topid=${TOP}`];
const ORDER_C = [`topid=${TOP}`, 'muraAction=cArch.list', `moduleid=${MODULE}`, 'siteid=default'];
// Legacy's Location for ORDER_A, as served on port 8080 and moved to the capture port.
const LEGACY_LOCATION_A =
  './?muraAction=cLogin.main&returnURL=http%3A%2F%2Flocalhost%3A8500%2Fadmin%2F%3F%26moduleid%3D' +
  `${MODULE}%26muraAction%3DcArch.list%26topid%3D${TOP}%26siteid%3Ddefault&compactDisplay=false`;
// Legacy's login-form hidden input for ORDER_B (esapiEncode('html_attr')), moved to the capture port.
const LEGACY_INPUT_B =
  '<input name="returnUrl" type="hidden" value="http&#x3a;&#x2f;&#x2f;localhost&#x3a;8500&#x2f;admin&#x2f;' +
  `&#x3f;&amp;siteid&#x3d;default&amp;moduleid&#x3d;${MODULE}&amp;muraAction&#x3d;cArch.list&amp;topid&#x3d;${TOP}">`;
// Hard-coded url-scope-shaped action link (admin/core/views/carch/dsp_secondary_menu.cfm:370); its order is fixed.
const ACTION_LINK = `./?&muraAction=cArch.list&siteid=default&moduleid=${MODULE}`;
const ACTION_LINK_REORDERED = `./?&siteid=default&muraAction=cArch.list&moduleid=${MODULE}`;
const SORTED_RETURN = `%3F%26moduleid%3D${MODULE}%26muraAction%3DcArch.list%26siteid%3Ddefault%26topid%3D${TOP}`;
const LOGIN_PAGE = readFileSync(
  fileURLToPath(new URL('../../fixtures/html/admin-login.html', import.meta.url)),
  'utf8',
);

let rules: NormaliseRules;
let scenario: Scenario;

beforeAll(async () => {
  rules = loadRules(undefined, { PORT: '8500' });
  scenario = scenarioById(await loadCatalogue(), 'GS-ID-01');
});

/** The URL legacy's url-scope walk builds (admin/Application.cfc:319-331, controller.cfc:87). */
const returnUrl = (host: string, order: readonly string[]): string => `http://${host}/admin/?&${order.join('&')}`;

/** The cLogin.main redirect legacy answers an anonymous ROUTE with; URLEncodedFormat equals encodeURIComponent here. */
const location = (host: string, order: readonly string[]): string =>
  `./?muraAction=cLogin.main&returnURL=${encodeURIComponent(returnUrl(host, order))}&compactDisplay=false`;

// esapiEncode('html_attr'): `&` as `&amp;`, other characters outside [A-Za-z0-9,._-] as hex references.
const htmlAttr = (s: string): string =>
  s.replace(/[^A-Za-z0-9,._-]/g, (c) => (c === '&' ? '&amp;' : `&#x${c.charCodeAt(0).toString(16)};`));

function replaced(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture lacks ${from}`);
  return text.replace(from, to);
}

/** The login page legacy serves after the redirect: both returnURL inputs carry the url-scope URL. */
function loginPage(host: string, order: readonly string[], actionLink = ACTION_LINK): string {
  const value = htmlAttr(returnUrl(host, order));
  const input = (name: string, v: string): string => `<input name="${name}" type="hidden" value="${v}">`;
  const withInputs = ['returnUrl', 'returnURL'].reduce(
    (page, name) => replaced(page, input(name, ''), input(name, value)),
    LOGIN_PAGE,
  );
  return replaced(withInputs, '</body>', `<a class="btn" href="${actionLink}">Return to Content Manager</a></body>`);
}

function hop(host: string, status: number, loc?: string): HttpHop {
  return {
    method: 'GET',
    url: `http://${host}${ROUTE}`,
    status,
    ...(loc === undefined ? {} : { location: loc }),
    setCookie: [],
    requestHeaders: {},
    responseHeaders: loc === undefined ? { 'content-type': 'text/html' } : { location: loc },
  };
}

/** The GS-ID-01 step: the redirect alone, or followed to the login page. */
function record(host: string, loc: string, page?: string): StepRecord {
  const sha256 = '0'.repeat(64);
  const response: RecordedResponse =
    page === undefined
      ? { status: 302, headers: { location: loc }, contentType: '', sha256, hops: [], text: '' }
      : {
          status: 200,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
          contentType: 'text/html; charset=UTF-8',
          sha256,
          hops: [hop(host, 302, loc), hop(host, 200)],
          text: page,
        };
  return {
    name: STEP,
    index: 4,
    routeKey: 'admin:carch.list',
    request: { method: 'GET', url: `http://${host}${ROUTE}`, headers: {}, body: { kind: 'none' } },
    response,
    extracted: {},
  };
}

async function side(step: StepRecord, under: NormaliseRules): Promise<NormalisedRun> {
  const ctx = { state: createNormaliseState(), rules: under, scenario };
  return { steps: [await normaliseStep(step, ctx)], sideEffects: {} };
}

async function compare(golden: StepRecord, replay: StepRecord, under: NormaliseRules = rules): Promise<Difference[]> {
  return compareNormalised(await side(golden, under), await side(replay, under), { rules: under, scenario });
}

const without = (id: string): NormaliseRules => {
  const apply = rules.urls.otherwise.apply.filter((rule) => rule !== id);
  return { ...rules, urls: { ...rules.urls, otherwise: { ...rules.urls.otherwise, apply } } };
};

const pathsOf = (differences: readonly Difference[]): string[] => differences.map((diff) => diff.path);

describe('legacy url-scope shapes', () => {
  it('rebuilds the Location and hidden input legacy served', () => {
    expect(location(CAPTURE_HOST, ORDER_A)).toBe(LEGACY_LOCATION_A);
    expect(loginPage(CAPTURE_HOST, ORDER_B)).toContain(LEGACY_INPUT_B);
  });
});

describe('compareNormalised on GS-ID-01 protected-after-logout', () => {
  it.each<[string, (host: string, order: readonly string[]) => StepRecord, string[]]>([
    [
      'the redirect Location header',
      (host, order) => record(host, location(host, order)),
      ['auth.redirectTargets[0].location', 'headers.location'],
    ],
    [
      'the followed redirect and its login form',
      (host, order) => record(host, location(host, order), loginPage(host, order)),
      ['auth.redirectTargets[0].location', 'domModel.controls[13].value', 'domModel.controls[4].value'],
    ],
  ])('finds no difference in %s when only the url-scope order differs', async (_label, build, unruled) => {
    expect(await compare(build(CAPTURE_HOST, ORDER_A), build(REPLAY_HOST, ORDER_B))).toStrictEqual([]);
    expect(await compare(build(CAPTURE_HOST, ORDER_C), build(REPLAY_HOST, ORDER_A))).toStrictEqual([]);
    const golden = build(CAPTURE_HOST, ORDER_A);
    const replay = build(REPLAY_HOST, ORDER_B);
    expect(pathsOf(await compare(golden, replay, without('url-scope-query')))).toStrictEqual(unruled);
  });

  it.each<[string, StepRecord, StepRecord, string[]]>([
    [
      'the redirect parameters FW/1 appends in a fixed order',
      record(CAPTURE_HOST, location(CAPTURE_HOST, ORDER_A)),
      record(
        REPLAY_HOST,
        `./?compactDisplay=false&${location(REPLAY_HOST, ORDER_A).slice(3).replace('&compactDisplay=false', '')}`,
      ),
      ['auth.redirectTargets[0].location', 'headers.location'],
    ],
    [
      'the hard-coded ./?& action link',
      record(CAPTURE_HOST, location(CAPTURE_HOST, ORDER_A), loginPage(CAPTURE_HOST, ORDER_A)),
      record(REPLAY_HOST, location(REPLAY_HOST, ORDER_B), loginPage(REPLAY_HOST, ORDER_B, ACTION_LINK_REORDERED)),
      ['domModel.links[2].href'],
    ],
  ])('still reports a reordered deterministic URL: %s', async (_label, golden, replay, paths) => {
    const differences = await compare(golden, replay);
    expect(differences.map((diff) => [diff.path, diff.classification])).toStrictEqual(
      paths.map((path) => [path, 'difference']),
    );
  });
});

describe('normaliseUrl url-scope queries', () => {
  it.each<[string, string, string]>([
    [
      'sorts a url-scope URL percent-encoded in returnURL, keeping its encoding',
      location(CAPTURE_HOST, ORDER_C),
      `./?muraAction=clogin.main&returnURL=http%3A%2F%2F<origin>%2Fadmin%2F${SORTED_RETURN}&compactDisplay=false`,
    ],
    [
      'sorts a whole url-scope URL',
      returnUrl(CAPTURE_HOST, ORDER_C),
      `<origin>/admin/?&moduleid=${MODULE}&muraAction=carch.list&siteid=default&topid=${TOP}`,
    ],
    ['sorts &amp;-separated url-scope parameters', '/admin/?&amp;b=2&amp;a=1', '/admin/?&amp;a=1&amp;b=2'],
    [
      'sorts an encoded query after an unencoded ?, keeping the fragment',
      '/x?r=/admin/?%26b%3D2%26a%3D1%23top&z=1',
      '/x?r=/admin/?%26a%3D1%26b%3D2%23top&z=1',
    ],
    [
      'keeps a query not starting with &',
      '/admin/?topid=1&muraAction=cArch.list',
      '/admin/?topid=1&muraAction=carch.list',
    ],
    [
      'keeps an encoded URL whose query does not start with &',
      './?returnURL=http%3A%2F%2Fx.test%2Fadmin%2F%3Fz%3D1%26a%3D2',
      './?returnURL=http%3A%2F%2Fx.test%2Fadmin%2F%3Fz%3D1%26a%3D2',
    ],
    ['keeps an encoded value that is no URL', '/x?q=why%3F%26z%3D1%26a%3D2', '/x?q=why%3F%26z%3D1%26a%3D2'],
    [
      'keeps an encoded value with a malformed head',
      '/x?q=%E0%A4%A%3F%26z%3D1%26a%3D2',
      '/x?q=%E0%A4%A%3F%26z%3D1%26a%3D2',
    ],
  ])('%s', (_label, url, expected) => {
    expect(normaliseUrl(url, createIdOrdinals(), rules)).toBe(expected);
  });

  it('normalises the JSON API self links legacy served in two orders alike', () => {
    // findCrumbArray links.self for one request sent twice (jsonApiUtility.cfc:318-337).
    const self = (host: string, middle: string): string =>
      `http://${host}/index.cfm/_api/json/v1/default/?&gamma=3&itemsperpage=5&${middle}&method=findCrumbArray` +
      `&id=${TOP}&siteid=default&entityname=content&beta=2&pageIndex=1`;
    const golden = normaliseUrl(self(CAPTURE_HOST, 'alpha=1&expanddepth=1'), createIdOrdinals(), rules);
    expect(normaliseUrl(self(REPLAY_HOST, 'expanddepth=1&alpha=1'), createIdOrdinals(), rules)).toBe(golden);
    expect(golden).toBe(
      '<origin>/index.cfm/_api/json/v1/default/?&alpha=1&beta=2&entityname=content&expanddepth=1&gamma=3' +
        `&id=${TOP}&itemsperpage=5&method=findCrumbArray&pageIndex=1&siteid=default`,
    );
  });

  it('sorts url-scope URLs held in JSON strings and text', () => {
    const url = returnUrl(CAPTURE_HOST, ['b=2', 'a=1']);
    expect(normaliseValue({ returnURL: url }, createIdOrdinals(), rules)).toStrictEqual({
      returnURL: '<origin>/admin/?&a=1&b=2',
    });
    expect(normaliseText(`Back to ${url} now`, createIdOrdinals(), rules)).toBe('Back to <origin>/admin/?&a=1&b=2 now');
  });

  it.each<[string, () => NormaliseRules, string, string]>([
    ['without url-scope-query in urls.otherwise.apply', () => without('url-scope-query'), '/a?&b=2&a=1', '/a?&b=2&a=1'],
    [
      'without url-scope-query, for an encoded value',
      () => without('url-scope-query'),
      '/a?r=%2Fx%2F%3F%26b%3D2%26a%3D1',
      '/a?r=%2Fx%2F%3F%26b%3D2%26a%3D1',
    ],
    [
      'with percentEncodedValues off, for an encoded value',
      () => ({ ...rules, urls: { ...rules.urls, urlScope: { ...rules.urls.urlScope, percentEncodedValues: false } } }),
      '/a?&r=%2Fx%2F%3F%26b%3D2%26a%3D1&c=1',
      '/a?&c=1&r=%2Fx%2F%3F%26b%3D2%26a%3D1',
    ],
  ])('keeps the order %s', (_label, variant, url, expected) => {
    expect(normaliseUrl(url, createIdOrdinals(), variant())).toBe(expected);
  });
});

describe('url-scope order with repeated names', () => {
  // A repeated name is no url-scope walk: its order routes (doaction=login&doaction=logout is page:login,logout).
  it.each<[string, boolean, string, string]>([
    [
      'a repeated name',
      false,
      '/index.cfm/?&doaction=login&doaction=logout',
      '/index.cfm/?&doaction=logout&doaction=login',
    ],
    ['a name repeated in another case', false, '/index.cfm/?&a=1&A=2', '/index.cfm/?&A=2&a=1'],
    ['a name repeated in another case among others', false, '/index.cfm/?&b=3&a=1&A=2', '/index.cfm/?&A=2&b=3&a=1'],
    [
      'a repeated name in an encoded returnURL',
      false,
      location(CAPTURE_HOST, ['siteid=default', 'doaction=login', 'doaction=logout']),
      location(REPLAY_HOST, ['doaction=logout', 'siteid=default', 'doaction=login']),
    ],
    [
      'distinct names',
      true,
      '/index.cfm/?&doaction=login,logout&siteid=default',
      '/index.cfm/?&siteid=default&doaction=login,logout',
    ],
    ['distinct names in an encoded returnURL', true, location(CAPTURE_HOST, ORDER_A), location(REPLAY_HOST, ORDER_B)],
  ])('compares two orders of %s as equal: %s', async (_label, equal, golden, replay) => {
    const normalise = (under: NormaliseRules): string[] =>
      [golden, replay].map((url) => normaliseUrl(url, createIdOrdinals(), under));
    const scoped = normalise(rules);
    expect(scoped[0] === scoped[1]).toBe(equal);
    expect(scoped).toStrictEqual(equal ? [scoped[0], scoped[0]] : normalise(without('url-scope-query')));
    const differences = await compare(record(CAPTURE_HOST, golden), record(REPLAY_HOST, replay));
    expect(pathsOf(differences)).toStrictEqual(equal ? [] : ['auth.redirectTargets[0].location', 'headers.location']);
  });
});
