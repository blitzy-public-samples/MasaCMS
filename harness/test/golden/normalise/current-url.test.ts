// Unit tests for the current-url-query rule: legacy's 301 to its 404 page compares without its per-request order.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Scenario } from '../../../src/golden/catalogue.js';
import {
  compareNormalised,
  createIdOrdinals,
  createNormaliseState,
  loadRules,
  normaliseStep,
  normaliseText,
  normaliseUrl,
  type Difference,
  type NormalisedRun,
  type NormaliseRules,
} from '../../../src/golden/normalise/index.js';
import type { RecordedResponse, StepRecord } from '../../../src/golden/steps.js';
import type { HttpHop } from '../../../src/lib/http.js';

const CAPTURE_HOST = 'localhost:8500';
const REPLAY_HOST = 'localhost:8100';
const USER = '54997BC5-1622-92A6-85D91337F7198874';
const PAGE = 'AEAEFD1B-B638-0F03-01B3D64831264009';
const PARAMS: Record<string, string> = {
  U: `userID=${USER}`,
  L: `favoriteLocation=${PAGE}`,
  N: 'favoriteName=GS-PE-77-case',
  T: 'favoriteType=internal_content',
};
const ROUTE =
  `/core/modules/v1/favorites/ajax/savefavorite.cfm?userID=${USER}&siteid=tenant-a&favoriteName=GS-PE-77-case` +
  `&favoriteLocation=${PAGE}&favoriteType=internal_content`;
const SORTED =
  '<origin>/404/?favoriteLocation=<id:1>&favoriteName=GS-PE-77-case&favoriteType=internal_content&userID=<id:2>';
const PAGE_404 = '<!DOCTYPE html><html><head><title>404 - Default</title></head><body><h1>404</h1></body></html>';

/** A front-end favourites scenario comparing status, headers, auth, DOM and rows, with no overrides. */
const scenario: Scenario = {
  id: 'GS-PE-77',
  title: 'Front-end favourite saves',
  service: 'people',
  role: 'anonymous',
  sessions: { anon: { login: 'none', via: 'public' } },
  seedRefs: [],
  steps: [{ name: 'save-case-variant', method: 'GET', route: ROUTE, csrf: 'none' }],
  compare: ['status', 'headers', 'auth', 'dom', 'rows'],
  normalisationOverrides: {},
  covers: ['cfm:/core/modules/v1/favorites/ajax/savefavorite.cfm'],
  tableVersion: 'v0002',
};

let rules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
});

/** getCurrentURL's 301 target for the case-variant save, its url scope walked in `order` (letters of PARAMS). */
const location = (host: string, order: string): string =>
  `http://${host}/404/?${[...order].map((key) => PARAMS[key]).join('&')}`;

const without = (id: string): NormaliseRules => {
  const apply = rules.urls.otherwise.apply.filter((rule) => rule !== id);
  return { ...rules, urls: { ...rules.urls, otherwise: { ...rules.urls.otherwise, apply } } };
};

function hop(url: string, status: number, loc?: string): HttpHop {
  return {
    method: 'GET',
    url,
    status,
    ...(loc === undefined ? {} : { location: loc }),
    setCookie: [],
    requestHeaders: {},
    responseHeaders: loc === undefined ? { 'content-type': 'text/html;charset=UTF-8' } : { location: loc },
  };
}

/** The favourite save-case-variant step: the 301 alone, or followed to the 404 page. */
function record(host: string, order: string, followed: boolean, loc = location(host, order)): StepRecord {
  const sha256 = '0'.repeat(64);
  const response: RecordedResponse = followed
    ? {
        status: 404,
        headers: { 'content-type': 'text/html;charset=UTF-8' },
        contentType: 'text/html;charset=UTF-8',
        sha256,
        hops: [hop(`http://${host}${ROUTE}`, 301, loc), hop(loc, 404)],
        text: PAGE_404,
      }
    : { status: 301, headers: { location: loc }, contentType: '', sha256, hops: [], text: '' };
  return {
    name: 'save-case-variant',
    index: 11,
    routeKey: 'cfm:/core/modules/v1/favorites/ajax/savefavorite.cfm',
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

describe('normaliseUrl on the 404 redirect', () => {
  // Six orders the oracle answered one request with back to back, then a golden and a replay order.
  it.each(['NLUT', 'LNUT', 'TNUL', 'LUNT', 'TUNL', 'LTNU', 'ULNT', 'LTUN'])(
    'sorts the url-scope order %s by name before numbering ids',
    (order) => {
      const ids = createIdOrdinals();
      expect(normaliseUrl(location(CAPTURE_HOST, order), ids, rules)).toBe(SORTED);
      // A row read later in the scenario numbers its ids as the sorted Location did.
      expect(normaliseText(`${USER} ${PAGE}`, ids, rules)).toBe('<id:2> <id:1>');
    },
  );

  it.each<[string, string, string]>([
    ['the render-file 404 of a file read', 'http://localhost:8500/404/?size=file&fileid=', '<origin>/404/?fileid=&size=file'],
    ['a root-relative URL, keeping the fragment', '/404/?b=2&A=1#top', '/404/?A=1&b=2#top'],
    ['token parameters, still masked', '/404/?csrf_token=abc&b=1', '/404/?b=1&csrf_token=<token>'],
  ])('sorts %s', (_label, url, expected) => {
    expect(normaliseUrl(url, createIdOrdinals(), rules)).toBe(expected);
  });

  it.each<[string, string, () => NormaliseRules]>([
    ['a path without the trailing slash', '/404?b=2&a=1', () => rules],
    ['a 404 page under another path', '/tenant-a/404/?b=2&a=1', () => rules],
    ['a relative path', './404/?b=2&a=1', () => rules],
    ['a legacy 302 to another path', '/index.cfm/_api/render/file/?method=attachment&fileid=', () => rules],
    ['the 404 path as a query value', '/x/?r=/404/&b=2&a=1', () => rules],
    ['a repeated name', '/404/?a=1&b=2&a=3', () => rules],
    ['the rule missing from urls.otherwise.apply', '/404/?b=2&a=1', () => without('current-url-query')],
  ])('keeps the order of %s', (_label, url, variant) => {
    expect(normaliseUrl(url, createIdOrdinals(), variant())).toBe(url);
  });
});

describe('compareNormalised on the favourite save-case-variant', () => {
  it.each<[string, boolean, string[]]>([
    ['the 301 Location header', false, ['auth.redirectTargets[0].location', 'headers.location']],
    ['the 301 followed to the 404 page', true, ['auth.redirectTargets[0].location']],
  ])('finds no difference in %s when only the url-scope order differs', async (_label, followed, unruled) => {
    const golden = record(CAPTURE_HOST, 'ULNT', followed);
    const replay = record(REPLAY_HOST, 'LTUN', followed);
    expect(await compare(golden, replay)).toStrictEqual([]);
    const differences = await compare(golden, replay, without('current-url-query'));
    expect(differences.map((diff) => [diff.path, diff.classification])).toStrictEqual(
      unruled.map((path) => [path, 'difference']),
    );
  });

  it('still reports a different value on the 404 redirect', async () => {
    const changed = location(REPLAY_HOST, 'LTUN').replace('GS-PE-77-case', 'GS-PE-77-other');
    const differences = await compare(record(CAPTURE_HOST, 'ULNT', true), record(REPLAY_HOST, '', true, changed));
    expect(differences.map((diff) => diff.path)).toStrictEqual(['auth.redirectTargets[0].location']);
  });
});
