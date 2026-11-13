// Known-issue masks resolved on the saved admin fixtures and applied to the differences found there.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { routeKeyForRequest, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Step } from '../../../src/golden/catalogue.js';
import { GoldenConfigError } from '../../../src/golden/errors.js';
import {
  createSessionCookieTracker,
  normaliseSetCookies,
  type NormalisedCookie,
} from '../../../src/golden/normalise/cookies.js';
import { domModel, type DomControl, type DomModelResult } from '../../../src/golden/normalise/dom-model.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import {
  applyMasks,
  masksFor,
  pathMasks,
  type Difference,
  type DifferenceKind,
  type KnownIssueMask,
  type MaskContext,
  type MaskableStep,
} from '../../../src/golden/normalise/masks.js';
import {
  KNOWN_ISSUE_IDS,
  loadRules,
  type KnownIssueId,
  type KnownIssueRule,
  type NormaliseRules,
} from '../../../src/golden/normalise/rules.js';

const EDIT_USER_HTML = readFileSync(
  fileURLToPath(new URL('../../fixtures/html/admin-edituser.html', import.meta.url)),
  'utf8',
);
const SET_COOKIE_FILE = fileURLToPath(new URL('../../fixtures/http/set-cookie-login.txt', import.meta.url));
const SET_COOKIE_PREFIX = /^set-cookie:\s*/i;
const WILDCARD = '*';
const UNLISTED_SCENARIO = 'GS-ZZ-99';
const UNLISTED_ROUTE = 'api:content.findone';
const EDIT_STEP = 'edit-user';
const LOGIN_STEP = 'login';
const HTML = 'text/html;charset=UTF-8';

function adminRoute(method: 'GET' | 'POST', muraAction: string): RouteKeyResult {
  const params = { muraAction, siteid: 'tenant-a' };
  return routeKeyForRequest(
    method === 'GET'
      ? { method, path: '/admin/', query: params, headers: {} }
      : { method, path: '/admin/', query: {}, form: params, headers: {} },
  );
}

const EDIT_USER_ROUTE = adminRoute('GET', 'cUsers.editUser');
const LOGIN_ROUTE = adminRoute('POST', 'cLogin.login');
const HEADER_SEARCH_ROUTE = adminRoute('POST', 'cArch.list');
const SITE_SEARCH_ROUTE = adminRoute('GET', 'cNav.searchSiteData');

let rules: NormaliseRules;
let login: string[];
let relogin: string[];

/** Set-Cookie lines of each blank-line-separated fixture block, without comments or the header prefix. */
function readSetCookieBlocks(): string[][] {
  return readFileSync(SET_COOKIE_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .split(/\n[ \t]*\n/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.trim().replace(SET_COOKIE_PREFIX, ''))
        .filter((line) => line !== ''),
    )
    .filter((block) => block.length > 0);
}

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
  const blocks = readSetCookieBlocks();
  expect(blocks).toHaveLength(3);
  [login, , relogin] = blocks as [string[], string[], string[]];
});

function knownIssue(id: KnownIssueId): KnownIssueRule {
  const rule = rules.knownIssues.find((issue) => issue.id === id);
  if (rule === undefined) throw new Error(`the committed rules declare no known issue ${id}`);
  return rule;
}

/** The first explicit entry of a scope list, else `fallback`, which a wildcard list also admits. */
function firstListed(refs: readonly string[], fallback: string): string {
  return refs.find((ref) => ref !== WILDCARD) ?? fallback;
}

const scenarioOf = (id: KnownIssueId): string => firstListed(knownIssue(id).appliesTo, UNLISTED_SCENARIO);
const routeOf = (id: KnownIssueId): string => firstListed(knownIssue(id).routeKeys, UNLISTED_ROUTE);
const idsOf = (masks: readonly KnownIssueMask[]): KnownIssueId[] => masks.map((mask) => mask.id);
const capitalised = (routeKey: string): string =>
  routeKey.replace(/(^|[:.])([a-z])/g, (_match, sep: string, first: string) => `${sep}${first.toUpperCase()}`);

function change(step: string, path: string, expected: unknown, actual: unknown, kind: DifferenceKind = 'changed'): Difference {
  return { step, path, kind, expected, actual, classification: 'difference' };
}

/** Each difference's path with the mask that classified it, or `difference`. */
function verdicts(differences: readonly Difference[]): Record<string, string> {
  return Object.fromEntries(differences.map((d) => [d.path, d.maskId ?? d.classification]));
}

/** Masks of one step as a comparison reads them: both sides' paths, and each side's for missing and extra. */
function stepContext(
  step: string,
  golden: Readonly<Record<string, KnownIssueId>>,
  replay: Readonly<Record<string, KnownIssueId>> = golden,
): MaskContext {
  return {
    maskedPathsByStep: new Map([[step, { ...replay, ...golden }]]),
    maskedSidesByStep: new Map([[step, { golden, replay }]]),
  };
}

const domPath = (path: string): string => `domModel.${path}`;

function controlPath(result: DomModelResult, match: (control: DomControl) => boolean, field: string): string {
  const index = result.model.controls.findIndex(match);
  expect(index, 'fixture control').toBeGreaterThanOrEqual(0);
  return `controls[${index}].${field}`;
}

function formPath(result: DomModelResult, name: string): string {
  const index = result.model.forms.findIndex((form) => form.name === name);
  expect(index, `fixture form ${name}`).toBeGreaterThanOrEqual(0);
  return `forms[${index}].action`;
}

const named =
  (name: string, value?: string) =>
  (control: DomControl): boolean =>
    control.name === name && (value === undefined || control.value === value);
// The extended-attribute datepicker is the page's only unnamed text control.
const datepicker = (control: DomControl): boolean => control.type === 'text' && control.name === undefined;

function checkRadio($: CheerioAPI, name: string, value: string): void {
  $(`input[name="${name}"]`).removeAttr('checked');
  $(`input[name="${name}"][value="${value}"]`).attr('checked', 'checked');
}

/** A replay of the edit-user page: one edit of the saved legacy markup, and the field it changes. */
interface DomCase {
  edit: ($: CheerioAPI) => void;
  list: 'forms' | 'controls';
  field: 'action' | 'value' | 'checked';
}

const DATE_MASK: DomCase = {
  edit: ($) => {
    $('#mura-datepicker-startDate').attr('value', '2026-06-30');
    $('#fname').attr('value', 'Replayed');
  },
  list: 'controls',
  field: 'value',
};

const DEFAULT_MEMBER: DomCase = {
  edit: ($) => {
    checkRadio($, 'isPublic', '0');
    checkRadio($, 'InActive', '1');
  },
  list: 'controls',
  field: 'checked',
};

const HEADER_SEARCH: DomCase = {
  edit: ($) => {
    $('#globalSearch').attr('action', '/admin/?muraAction=cArch.search');
    $('form[name="form1"]').attr('action', '/admin/index.cfm?muraAction=cUsers.save');
  },
  list: 'forms',
  field: 'action',
};

function editUserMasks(scenarioId: string = scenarioOf('default-member')): KnownIssueMask[] {
  return masksFor(scenarioId, EDIT_USER_ROUTE, rules);
}

function model(html: string, masks: readonly KnownIssueMask[]): DomModelResult {
  return domModel(html, { state: createIdOrdinals(), rules, masks });
}

interface DomRun {
  golden: DomModelResult;
  replay: DomModelResult;
  differences: Difference[];
  ctx: MaskContext;
  result: Difference[];
}

function runDomCase(spec: DomCase, masks: readonly KnownIssueMask[] = editUserMasks()): DomRun {
  const $ = cheerio.load(EDIT_USER_HTML);
  spec.edit($);
  const golden = model(EDIT_USER_HTML, masks);
  const replay = model($.html(), masks);
  const want: readonly object[] = golden.model[spec.list];
  const got: readonly object[] = replay.model[spec.list];
  expect(got).toHaveLength(want.length);
  const differences = want.flatMap((entry, i): Difference[] => {
    const expected: unknown = Reflect.get(entry, spec.field);
    const actual: unknown = Reflect.get(got[i] ?? {}, spec.field);
    return expected === actual ? [] : [change(EDIT_STEP, domPath(`${spec.list}[${i}].${spec.field}`), expected, actual)];
  });
  const prefixed = (result: DomModelResult): Record<string, KnownIssueId> =>
    Object.fromEntries(Object.entries(result.maskedPaths).map(([path, id]) => [domPath(path), id]));
  const ctx = stepContext(EDIT_STEP, prefixed(golden), prefixed(replay));
  return { golden, replay, differences, ctx, result: applyMasks(differences, ctx) };
}

/** Cookies of the second login, normalised after the first on one side's tracker. */
function reloginCookies(): NormalisedCookie[] {
  const tracker = createSessionCookieTracker();
  normaliseSetCookies(login, { hop: 0, tracker }, rules);
  return normaliseSetCookies(relogin, { hop: 0, tracker }, rules);
}

interface LoginRun {
  cookies: NormalisedCookie[];
  masked: Record<string, KnownIssueId>;
  result: Difference[];
}

/** A replay that rotates every session cookie, drops JSESSIONID's HttpOnly and answers another content type. */
function runLoginCase(masks: readonly KnownIssueMask[]): LoginRun {
  const cookies = reloginCookies();
  const step: MaskableStep = { status: 302, headers: { 'set-cookie': relogin, 'content-type': HTML }, auth: { cookies } };
  const masked = pathMasks(step, masks);
  const jsession = cookies.findIndex((cookie) => cookie.name === 'JSESSIONID');
  const differences = [
    ...cookies.flatMap((cookie, i) =>
      cookie.rotation === 'same' ? [change(LOGIN_STEP, `auth.cookies[${i}].rotation`, 'same', 'changed')] : [],
    ),
    change(LOGIN_STEP, `auth.cookies[${jsession}].httpOnly`, true, false),
    change(LOGIN_STEP, 'headers.content-type', HTML, 'application/json'),
  ];
  return { cookies, masked, result: applyMasks(differences, stepContext(LOGIN_STEP, masked)) };
}

const loginMasks = (): KnownIssueMask[] => masksFor(scenarioOf('session-rotation'), LOGIN_ROUTE, rules);

/** Each known issue's fixture differences, classified under the masks in scope for them. */
const MASKED: Record<KnownIssueId, () => Difference[]> = {
  'date-mask': () => runDomCase(DATE_MASK).result,
  'session-rotation': () => runLoginCase(loginMasks()).result,
  'header-search-404': () => runDomCase(HEADER_SEARCH).result,
  'default-member': () => runDomCase(DEFAULT_MEMBER).result,
};

describe('masksFor scope', () => {
  it.each(KNOWN_ISSUE_IDS)('puts %s in scope on a scenario and route key it lists', (id) => {
    expect(idsOf(masksFor(scenarioOf(id), routeOf(id), rules))).toContain(id);
  });

  it.each(KNOWN_ISSUE_IDS)('matches %s on a capitalised form of the route key it lists', (id) => {
    const mixed = capitalised(routeOf(id));
    expect(mixed).not.toBe(routeOf(id));
    expect(idsOf(masksFor(scenarioOf(id), mixed, rules))).toContain(id);
  });

  it('puts default-member in scope on the route key computed from a mixed-case muraAction', () => {
    expect(knownIssue('default-member').routeKeys).toContain(EDIT_USER_ROUTE.key);
    expect(idsOf(editUserMasks())).toContain('default-member');
  });

  it('gives an unlisted scenario and route only the masks declared for every scenario and route', () => {
    const everywhere = rules.knownIssues
      .filter((rule) => rule.appliesTo.includes(WILDCARD) && rule.routeKeys.includes(WILDCARD))
      .map((rule) => rule.id);
    expect(everywhere.length).toBeLessThan(KNOWN_ISSUE_IDS.length);
    expect(idsOf(masksFor(UNLISTED_SCENARIO, UNLISTED_ROUTE, rules))).toStrictEqual(everywhere);
  });

  it('adds nothing for a step flagged with a mask that declares no step parts', () => {
    expect(knownIssue('date-mask').scope.steps).toBeUndefined();
    const step: Pick<Step, 'name' | 'knownIssue'> = { name: EDIT_STEP, knownIssue: 'date-mask' };
    const flagged = masksFor(UNLISTED_SCENARIO, UNLISTED_ROUTE, rules, step);
    expect(idsOf(flagged)).toContain('date-mask');
    expect(flagged).toStrictEqual(masksFor(UNLISTED_SCENARIO, UNLISTED_ROUTE, rules));
  });

  it('rejects a step flagged with an unknown known issue', () => {
    const step: Pick<Step, 'name' | 'knownIssue'> = { name: EDIT_STEP, knownIssue: 'no-such-issue' };
    expect(() => masksFor(UNLISTED_SCENARIO, UNLISTED_ROUTE, rules, step)).toThrow(GoldenConfigError);
  });
});

describe('DOM mask paths on the edit-user page', () => {
  it('resolves the datepicker value, the User Type radios and the header search action', () => {
    const { maskedPaths } = model(EDIT_USER_HTML, editUserMasks());
    const page = model(EDIT_USER_HTML, []);
    expect(maskedPaths).toStrictEqual({
      [controlPath(page, datepicker, 'value')]: 'date-mask',
      [controlPath(page, named('isPublic', '1'), 'checked')]: 'default-member',
      [controlPath(page, named('isPublic', '0'), 'checked')]: 'default-member',
      [formPath(page, 'globalSearch')]: 'header-search-404',
    });
  });

  it('resolves no path without masks', () => {
    expect(model(EDIT_USER_HTML, []).maskedPaths).toStrictEqual({});
  });
});

describe('date-mask', () => {
  it('masks the datepicker value and keeps the first-name change a difference', () => {
    const { golden, replay, result } = runDomCase(DATE_MASK);
    expect(Object.values(replay.maskedPaths)).not.toContain('date-mask');
    expect(verdicts(result)).toStrictEqual({
      [domPath(controlPath(golden, datepicker, 'value'))]: 'date-mask',
      [domPath(controlPath(golden, named('fname'), 'value'))]: 'difference',
    });
  });
});

describe('default-member', () => {
  it('masks the User Type selection and keeps the Active radios a difference', () => {
    const { golden, result } = runDomCase(DEFAULT_MEMBER);
    expect(verdicts(result)).toStrictEqual({
      [domPath(controlPath(golden, named('isPublic', '1'), 'checked'))]: 'default-member',
      [domPath(controlPath(golden, named('isPublic', '0'), 'checked'))]: 'default-member',
      [domPath(controlPath(golden, named('InActive', '0'), 'checked'))]: 'difference',
      [domPath(controlPath(golden, named('InActive', '1'), 'checked'))]: 'difference',
    });
  });
});

describe('header-search-404', () => {
  it('masks the header search action and keeps the edit form action a difference', () => {
    const { golden, result } = runDomCase(HEADER_SEARCH);
    expect(verdicts(result)).toStrictEqual({
      [domPath(formPath(golden, 'globalSearch'))]: 'header-search-404',
      [domPath(formPath(golden, 'form1'))]: 'difference',
    });
  });

  it('masks the status of the flagged header search step only', () => {
    const flag = knownIssue('header-search-404').scope.steps;
    if (flag === undefined) throw new Error('header-search-404 declares no step scope');
    const scenarioId = firstListed(flag.appliesTo, UNLISTED_SCENARIO);
    const search: Pick<Step, 'name' | 'knownIssue'> = { name: 'header-search', knownIssue: flag.knownIssue };
    const siteSearch: Pick<Step, 'name' | 'knownIssue'> = { name: 'site-search' };
    const notFound: MaskableStep = { status: 404, body: 'Not Found' };
    const searchPaths = pathMasks(notFound, masksFor(scenarioId, HEADER_SEARCH_ROUTE, rules, search));
    const siteSearchPaths = pathMasks(notFound, masksFor(scenarioId, SITE_SEARCH_ROUTE, rules, siteSearch));
    expect(searchPaths).toMatchObject({ status: 'header-search-404' });
    expect(siteSearchPaths).toStrictEqual({});
    const ctx: MaskContext = {
      maskedPathsByStep: new Map([
        [search.name, searchPaths],
        [siteSearch.name, siteSearchPaths],
      ]),
    };
    const [searched, siteSearched] = applyMasks(
      [change(search.name, 'status', 404, 200, 'status'), change(siteSearch.name, 'status', 404, 200, 'status')],
      ctx,
    );
    expect(searched).toMatchObject({ classification: 'known-issue', maskId: 'header-search-404' });
    expect(siteSearched).toStrictEqual(change(siteSearch.name, 'status', 404, 200, 'status'));
  });
});

describe('session-rotation', () => {
  it('normalises the second login session cookies as unrotated', () => {
    const sessionNames = knownIssue('session-rotation').scope.cookieNames ?? [];
    expect(sessionNames.length).toBeGreaterThan(0);
    const rotations = reloginCookies().flatMap((cookie) =>
      cookie.rotation === undefined ? [] : [[cookie.name, cookie.rotation]],
    );
    expect(rotations).toStrictEqual(sessionNames.map((name) => [name, 'same']));
  });

  it('masks each session cookie rotation and keeps other cookie fields and headers a difference', () => {
    const { cookies, masked, result } = runLoginCase(loginMasks());
    const sessionNames = knownIssue('session-rotation').scope.cookieNames ?? [];
    const rotationPaths = cookies.flatMap((cookie, i) =>
      sessionNames.includes(cookie.name) ? [`auth.cookies[${i}].rotation`] : [],
    );
    expect(Object.keys(masked).filter((path) => path.endsWith('.rotation'))).toStrictEqual(rotationPaths);
    const jsession = cookies.findIndex((cookie) => cookie.name === 'JSESSIONID');
    expect(verdicts(result)).toStrictEqual({
      ...Object.fromEntries(rotationPaths.map((path) => [path, 'session-rotation'])),
      [`auth.cookies[${jsession}].httpOnly`]: 'difference',
      'headers.content-type': 'difference',
    });
  });
});

describe('masks out of scope', () => {
  it('keeps a masked difference moved to another step a difference', () => {
    const { differences, ctx, result } = runDomCase(DATE_MASK);
    expect(result.some((d) => d.classification === 'known-issue')).toBe(true);
    const moved = differences.map((d) => ({ ...d, step: 'save' }));
    expect(applyMasks(moved, ctx)).toStrictEqual(moved);
  });

  it('leaves every difference a difference without masked paths', () => {
    const differences = KNOWN_ISSUE_IDS.flatMap((id) => MASKED[id]());
    const unmasked = differences.map(({ step, path, kind, expected, actual }) => change(step, path, expected, actual, kind));
    expect(applyMasks(differences, { maskedPathsByStep: new Map() })).toStrictEqual(unmasked);
  });

  it.each<[string, () => Difference[]]>([
    [
      'default-member on a scenario it does not list',
      () => runDomCase(DEFAULT_MEMBER, editUserMasks(UNLISTED_SCENARIO)).result,
    ],
    [
      'session-rotation on a route key it does not list',
      () => runLoginCase(masksFor(scenarioOf('session-rotation'), EDIT_USER_ROUTE, rules)).result,
    ],
  ])('reclassifies nothing for %s', (_label, run) => {
    const result = run();
    expect(result.length).toBeGreaterThan(0);
    expect(result.filter((d) => d.classification !== 'difference')).toStrictEqual([]);
  });
});

describe('known-issue coverage', () => {
  it.each(KNOWN_ISSUE_IDS)('reclassifies a fixture difference as %s', (id) => {
    const masked = MASKED[id]().filter((d) => d.classification === 'known-issue');
    expect(masked.map((d) => d.maskId)).toContain(id);
  });
});
