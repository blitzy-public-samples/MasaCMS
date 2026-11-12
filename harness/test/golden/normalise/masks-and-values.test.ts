// Unit tests for the golden normaliser's known-issue masks and value rules against the committed rules.
import type { RouteKeyResult } from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CompareKind } from '../../../src/golden/catalogue.js';
import { GoldenConfigError } from '../../../src/golden/errors.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import {
  applyMasks,
  masksFor,
  pathMasks,
  type Difference,
  type DifferenceKind,
  type KnownIssueMask,
  type MaskContext,
  type MaskLocation,
  type MaskableStep,
} from '../../../src/golden/normalise/masks.js';
import {
  loadRules,
  type KnownIssueId,
  type KnownIssueRule,
  type KnownIssueScope,
  type NormaliseRules,
} from '../../../src/golden/normalise/rules.js';
import {
  TOKEN_PLACEHOLDER,
  URL_PLACEHOLDER,
  isDateOnlyField,
  isTokenKey,
  normaliseText,
  normaliseTimestamp,
  normaliseTokens,
  normaliseUrl,
  normaliseValue,
  timestampClassOf,
} from '../../../src/golden/normalise/values.js';

const A = '2B3C4D5E-6F7A-4B8C-9D0E1F2A3B4C5D6E';
const B = '3C4D5E6F-7A8B-4C9D-8E0F1A2B3C4D5E6F';
const CAPTURE_ORIGIN = 'http://127.0.0.1:8500';
const EPOCH_MS = 1782813600000;
const WILDCARD_MASKS = ['date-mask', 'header-search-404'];
const LOGIN: RouteKeyResult = {
  key: 'admin:clogin.login',
  baseKey: 'admin:clogin.login',
  family: 'admin',
  httpMethod: 'POST',
  params: {},
};

let rules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
});

const idsOf = (masks: readonly KnownIssueMask[]): string[] => masks.map((mask) => mask.id);

function knownIssue(id: KnownIssueId): KnownIssueRule {
  const rule = rules.knownIssues.find((issue) => issue.id === id);
  if (rule === undefined) throw new Error(`the committed rules declare no known issue ${id}`);
  return rule;
}

function maskFor(id: KnownIssueId, ...args: Parameters<typeof masksFor>): KnownIssueMask | undefined {
  return masksFor(...args).find((mask) => mask.id === id);
}

function configError(fn: () => unknown): GoldenConfigError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(GoldenConfigError);
  return thrown as GoldenConfigError;
}

describe('masksFor', () => {
  it.each<[string, string, string | RouteKeyResult, string[]]>([
    ['gives any scenario and route the wildcard masks', 'GS-CO-01', 'admin:carch.list', WILDCARD_MASKS],
    [
      'adds session-rotation on an authored login route key',
      'GS-ID-01',
      'admin:clogin.login',
      ['date-mask', 'session-rotation', 'header-search-404'],
    ],
    [
      'adds session-rotation on a computed login route key',
      'GS-ID-01',
      LOGIN,
      ['date-mask', 'session-rotation', 'header-search-404'],
    ],
    [
      'leaves session-rotation off a computed key of another route',
      'GS-ID-01',
      { ...LOGIN, key: 'admin:carch.list', baseKey: 'admin:carch.list' },
      WILDCARD_MASKS,
    ],
    [
      'matches an authored route key after trimming and lower-casing it',
      'GS-ID-05',
      ' Admin:CUsers.EditGroup ',
      [...WILDCARD_MASKS, 'default-member'],
    ],
    ['leaves default-member off a scenario it does not list', 'GS-CO-01', 'admin:cusers.editgroup', WILDCARD_MASKS],
  ])('%s', (_label, scenarioId, routeKey, expected) => {
    expect(idsOf(masksFor(scenarioId, routeKey, rules))).toStrictEqual(expected);
  });

  it('scopes date-mask to DOM date text under the dom and envelope compare kinds', () => {
    const mask = maskFor('date-mask', 'GS-CO-01', 'admin:carch.list', rules);
    expect(mask?.compareKinds).toStrictEqual(['dom', 'envelope']);
    const selectors = mask?.locations.map((location) => (location.kind === 'dom' ? location.selector : location.kind));
    expect(selectors).toStrictEqual(knownIssue('date-mask').scope.selectors);
    for (const location of mask?.locations ?? []) {
      if (location.kind !== 'dom') throw new Error(`unexpected ${location.kind} location`);
      expect(location.textPattern?.test('Updated 10/302/2026')).toBe(true);
      expect(location.textPattern?.test('2026-06-30')).toBe(false);
      expect(location.attributes).toBeUndefined();
    }
  });

  it('scopes default-member to the checked attribute of the isPublic radios', () => {
    expect(maskFor('default-member', 'GS-ID-05', 'admin:cusers.edituser', rules)).toStrictEqual({
      id: 'default-member',
      scenarios: ['GS-ID-05', 'GS-ID-06', 'GS-PE-01', 'GS-PE-02', 'GS-PE-RH-01', 'GS-PE-RH-02'],
      routeKeys: ['admin:cusers.editgroup', 'admin:cusers.edituser'],
      locations: [
        { kind: 'dom', selector: 'input[name=isPublic][value=1]', attributes: ['checked'] },
        { kind: 'dom', selector: 'input[name=isPublic][value=0]', attributes: ['checked'] },
      ],
      description: 'The group and user forms default to Member',
    });
  });

  it('scopes session-rotation to the session Set-Cookie values and each session cookie presence and rotation', () => {
    expect(maskFor('session-rotation', 'GS-ID-01', LOGIN, rules)?.locations).toStrictEqual([
      { kind: 'header', name: 'Set-Cookie', cookieNames: ['CFID', 'CFTOKEN', 'JSESSIONID'] },
      { kind: 'cookie', name: 'CFID' },
      { kind: 'cookie', name: 'CFID', field: 'rotation' },
      { kind: 'cookie', name: 'CFTOKEN' },
      { kind: 'cookie', name: 'CFTOKEN', field: 'rotation' },
      { kind: 'cookie', name: 'JSESSIONID' },
      { kind: 'cookie', name: 'JSESSIONID', field: 'rotation' },
    ]);
  });

  const PRESENCE: MaskLocation = { kind: 'cookie', name: 'CFID' };
  const ROTATION: MaskLocation = { kind: 'cookie', name: 'CFID', field: 'rotation' };
  it.each<[string, KnownIssueScope['observations'], MaskLocation[]]>([
    ['only value equality as its rotation', ['value-equal-across-login'], [ROTATION]],
    ['only presence as its entry', ['presence'], [PRESENCE]],
    ['only absence as its entry', ['absence'], [PRESENCE]],
    ['presence and value equality as both', ['presence', 'value-equal-across-login'], [PRESENCE, ROTATION]],
    ['no observations as both', undefined, [PRESENCE, ROTATION]],
  ])('maps a cookie mask observing %s, masking other headers whole', (_label, observations, cookies) => {
    const issue: KnownIssueRule = {
      ...knownIssue('session-rotation'),
      scope: {
        headers: ['X-Session', 'set-cookie'],
        cookieNames: ['CFID'],
        ...(observations === undefined ? {} : { observations }),
      },
    };
    const [mask] = masksFor('GS-ID-01', LOGIN, { ...rules, knownIssues: [issue] });
    expect(mask?.locations).toStrictEqual([
      { kind: 'header', name: 'X-Session' },
      { kind: 'header', name: 'set-cookie', cookieNames: ['CFID'] },
      ...cookies,
    ]);
  });

  it('scopes header-search-404 to the search form action, adding status and body only on its flagged step', () => {
    const step = { name: 'search', knownIssue: 'header-search-404' };
    const action: KnownIssueMask['locations'] = [
      { kind: 'dom', selector: 'form#globalSearch', attributes: ['action'] },
    ];
    expect(maskFor('header-search-404', 'GS-CO-06', 'admin:carch.list', rules, step)?.locations).toStrictEqual([
      ...action,
      { kind: 'status' },
      { kind: 'body' },
    ]);
    expect(maskFor('header-search-404', 'GS-CO-06', 'admin:carch.list', rules)?.locations).toStrictEqual(action);
  });

  it.each<[string, string | RouteKeyResult]>([
    ['an authored', 'admin:cusers.edituser'],
    ['a computed', { ...LOGIN, key: 'admin:cusers.edituser', baseKey: 'admin:cusers.edituser', httpMethod: 'GET' }],
  ])('keeps a flagged default-member once on %s route key its route keys list', (_label, routeKey) => {
    const step = { name: 'save', knownIssue: 'default-member' };
    expect(idsOf(masksFor('GS-ID-05', routeKey, rules, step))).toStrictEqual([...WILDCARD_MASKS, 'default-member']);
  });

  it.each([
    [
      'an unknown known issue',
      'GS-CO-06',
      'no-such-issue',
      'is not one of date-mask, session-rotation, header-search-404, default-member',
    ],
    ['header-search-404 outside its step scenarios', 'GS-CO-01', 'header-search-404', 'is declared for GS-CO-06 only'],
    [
      'default-member outside its scenarios',
      'GS-CO-01',
      'default-member',
      'is declared for GS-ID-05, GS-ID-06, GS-PE-01, GS-PE-02, GS-PE-RH-01, GS-PE-RH-02 only',
    ],
    [
      'default-member on a route its route keys do not list',
      'GS-ID-05',
      'default-member',
      'is declared for routes admin:cusers.editgroup, admin:cusers.edituser only',
    ],
  ])('rejects a step flagged with %s', (_label, scenarioId, flag, reason) => {
    const err = configError(() => masksFor(scenarioId, 'admin:carch.list', rules, { name: 'step1', knownIssue: flag }));
    expect(err.message).toBe(`${scenarioId} step step1: knownIssue ${flag} ${reason}`);
    expect(err.path).toBe(`scenario ${scenarioId}`);
  });
});

describe('pathMasks', () => {
  const LOCATIONS: KnownIssueMask['locations'] = [
    { kind: 'dom', selector: 'td' },
    { kind: 'header', name: 'X-A' },
    { kind: 'cookie', name: 'CFID', field: 'rotation' },
    { kind: 'status' },
    { kind: 'body' },
  ];
  const STEP: MaskableStep = {
    status: 200,
    headers: { 'x-a': '1', 'X-B': '2' },
    auth: { cookies: [{ name: 'CFID' }, { name: 'CFTOKEN' }] },
    envelope: {},
    body: 'raw',
    domModel: {},
  };
  const mask = (id: KnownIssueId, locations = LOCATIONS, compareKinds?: CompareKind[]): KnownIssueMask => ({
    id,
    scenarios: ['*'],
    routeKeys: ['*'],
    locations,
    description: id,
    ...(compareKinds === undefined ? {} : { compareKinds }),
  });

  it('maps the session Set-Cookie values, cookie entries and rotations of a login step to session-rotation', () => {
    const step: MaskableStep = {
      status: 302,
      headers: { 'set-cookie': ['CFID=1;path=/', 'other=2', 'CFTOKEN=3; Path=/'], 'content-type': 'text/html' },
      auth: { cookies: [{ name: 'CFID' }, { name: 'other' }, { name: 'CFTOKEN' }] },
      domModel: {},
    };
    expect(pathMasks(step, masksFor('GS-ID-01', LOGIN, rules))).toStrictEqual({
      'headers.set-cookie[0]': 'session-rotation',
      'headers.set-cookie[2]': 'session-rotation',
      'auth.cookies[0]': 'session-rotation',
      'auth.cookies[0].rotation': 'session-rotation',
      'auth.cookies[2]': 'session-rotation',
      'auth.cookies[2].rotation': 'session-rotation',
    });
  });

  it.each([
    [
      'masks a single session Set-Cookie value whole',
      'JSESSIONID=abc; Path=/',
      { 'headers.Set-Cookie': 'session-rotation' },
    ],
    ['leaves a single Set-Cookie value of another cookie unmasked', 'foo=abc; Path=/', {}],
  ])('%s', (_label, value, expected) => {
    const step: MaskableStep = { status: 200, headers: { 'Set-Cookie': value } };
    expect(pathMasks(step, masksFor('GS-ID-01', LOGIN, rules))).toStrictEqual(expected);
  });

  it('resolves nothing for a step without headers or auth cookies', () => {
    expect(pathMasks({ status: 200 }, masksFor('GS-ID-01', LOGIN, rules))).toStrictEqual({});
  });

  it('masks the status and every body representation of a flagged header-search-404 step', () => {
    const masks = masksFor('GS-CO-06', 'admin:carch.list', rules, { name: 'search', knownIssue: 'header-search-404' });
    expect(pathMasks({ status: 404, envelope: {}, body: 'x', domModel: {}, export: {} }, masks)).toStrictEqual({
      status: 'header-search-404',
      envelope: 'header-search-404',
      body: 'header-search-404',
      domModel: 'header-search-404',
      export: 'header-search-404',
    });
  });

  it.each<[string, CompareKind[] | undefined, string[]]>([
    [
      'every non-DOM location without compare kinds',
      undefined,
      ['headers.x-a', 'auth.cookies[0].rotation', 'status', 'envelope', 'body', 'domModel'],
    ],
    ['only the envelope body under envelope', ['envelope'], ['envelope']],
    [
      'headers, the cookie field and status under their kinds',
      ['headers', 'auth', 'status'],
      ['headers.x-a', 'auth.cookies[0].rotation', 'status'],
    ],
    ['only the DOM model body under dom', ['dom'], ['domModel']],
  ])('resolves %s', (_label, compareKinds, expected) => {
    expect(Object.keys(pathMasks(STEP, [mask('date-mask', LOCATIONS, compareKinds)]))).toStrictEqual(expected);
  });

  it('keeps the first mask to claim a path', () => {
    const masks = [
      mask('header-search-404', [{ kind: 'status' }]),
      mask('date-mask', [{ kind: 'status' }, { kind: 'body' }]),
    ];
    expect(pathMasks(STEP, masks)).toStrictEqual({
      status: 'header-search-404',
      envelope: 'date-mask',
      body: 'date-mask',
      domModel: 'date-mask',
    });
  });
});

describe('applyMasks', () => {
  const ctx: MaskContext = {
    maskedPathsByStep: new Map([
      [
        'login',
        {
          status: 'header-search-404',
          envelope: 'header-search-404',
          'envelope.data.when': 'date-mask',
          'auth.cookies[0]': 'session-rotation',
          'auth.cookies[0].rotation': 'session-rotation',
        },
      ],
    ]),
  };
  const difference = (step: string, path: string, kind: DifferenceKind = 'changed'): Difference => ({
    step,
    path,
    kind,
    expected: 'a',
    actual: 'b',
    classification: 'difference',
  });
  const classified = (diff: Difference, maskId: KnownIssueId | undefined): Difference =>
    maskId === undefined ? diff : { ...diff, classification: 'known-issue', maskId };

  it.each<[string, string, DifferenceKind, KnownIssueId | undefined]>([
    ['login', 'status', 'changed', 'header-search-404'],
    ['login', 'statusText', 'changed', undefined],
    ['login', 'envelope.data.items[0]', 'changed', 'header-search-404'],
    ['login', 'envelope.data.when', 'changed', 'date-mask'],
    ['login', 'envelope.data.when.day', 'changed', 'date-mask'],
    ['login', 'auth.cookies[0]', 'missing', 'session-rotation'],
    ['login', 'auth.cookies[0]', 'extra', 'session-rotation'],
    ['login', 'auth.cookies[0]', 'changed', undefined],
    ['login', 'auth.cookies[0].rotation', 'changed', 'session-rotation'],
    ['login', 'auth.cookies[0].secure', 'changed', undefined],
    ['login', 'auth.cookies[0].value', 'changed', undefined],
    ['login', 'auth.cookies[0].sameSite', 'missing', undefined],
    ['login', 'auth.cookies[1]', 'changed', undefined],
    ['logout', 'status', 'changed', undefined],
  ])('classifies step %s path %s (%s) by its most specific covering mask (%s)', (step, path, kind, maskId) => {
    const [result] = applyMasks([difference(step, path, kind)], ctx);
    expect(result).toStrictEqual(classified(difference(step, path, kind), maskId));
  });

  it.each<[DifferenceKind, string, KnownIssueId | undefined]>([
    ['missing', 'auth.cookies[0]', 'session-rotation'],
    ['extra', 'auth.cookies[0]', undefined],
    ['extra', 'auth.cookies[1]', 'session-rotation'],
    ['missing', 'auth.cookies[1]', undefined],
    ['changed', 'auth.cookies[1].rotation', 'session-rotation'],
  ])('classifies kind %s at %s by its own side under per-side masks (%s)', (kind, path, maskId) => {
    const golden = { 'auth.cookies[0]': 'session-rotation' } as const;
    const replay = { 'auth.cookies[1]': 'session-rotation', 'auth.cookies[1].rotation': 'session-rotation' } as const;
    const sides: MaskContext = {
      maskedPathsByStep: new Map([['login', { ...golden, ...replay }]]),
      maskedSidesByStep: new Map([['login', { golden, replay }]]),
    };
    const [result] = applyMasks([difference('login', path, kind)], sides);
    expect(result).toStrictEqual(classified(difference('login', path, kind), maskId));
  });

  it('returns new objects in input order, dropping a stale classification', () => {
    const stale: Difference = {
      ...difference('login', 'auth.cookies[1]'),
      classification: 'known-issue',
      maskId: 'date-mask',
    };
    const status: Difference = { ...difference('login', 'status'), kind: 'status', expected: 200, actual: 404 };
    const result = applyMasks([stale, status], ctx);
    expect(result).toStrictEqual([
      difference('login', 'auth.cookies[1]'),
      { ...status, classification: 'known-issue', maskId: 'header-search-404' },
    ]);
    expect(result[0]).not.toBe(stale);
    expect(stale.classification).toBe('known-issue');
  });
});

describe('timestamps', () => {
  it.each<[string, string | undefined, string]>([
    ["{ts '2026-06-30 10:00:00'}", undefined, 'cf-odbc'],
    ['2026-06-30T10:00:00', undefined, 'serializer'],
    ['2026-06-30T10:00:00.123Z', undefined, 'iso-local'],
    ['2026-06-30 10:00:00.5', undefined, 'jdbc-timestamp'],
    ['June, 30 2026 10:00:00', undefined, 'cf-datetime'],
    ['Tue, 30 Jun 2026 10:00:00 GMT', undefined, 'http-date'],
    ['Tue, 30-Jun-2026 10:00:00 GMT', undefined, 'cookie-expires'],
    ['2026-06-30', undefined, 'iso-date'],
    ['260630100000123', 'csrf_token_expires', 'csrf-expires'],
    ['260630100000123', 'X-csrf_token_expires', 'csrf-expires'],
    ['10/302/2026', undefined, 'admin-date'],
    ['9:05 AM', undefined, 'admin-time'],
    [String(EPOCH_MS), 'createdAt', 'epoch-ms'],
    [String(EPOCH_MS), 'lastLoginTime', 'epoch-ms'],
  ])('classifies %s under key %s as %s', (value, key, cls) => {
    expect(timestampClassOf(value, rules, key)).toBe(cls);
    expect(normaliseTimestamp(value, rules, key)).toBe(`<ts:${cls}>`);
  });

  it.each<[string, string | undefined]>([
    ['260630100000123', undefined],
    [String(EPOCH_MS), 'title'],
    [String(EPOCH_MS), undefined],
    ['2026-06-30T10:00:00 trailing', undefined],
    ['not a date', undefined],
  ])('leaves %s under key %s unclassified and unchanged', (value, key) => {
    expect(timestampClassOf(value, rules, key)).toBeUndefined();
    expect(normaliseTimestamp(value, rules, key)).toBe(value);
  });

  it('keeps date-only fields literal, matching their names ignoring case and underscores', () => {
    expect(['asOf', 'due_date', 'AS_OF', 'title'].map((name) => isDateOnlyField(name, rules))).toStrictEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(normaliseTimestamp('2026-06-30', rules, 'due_date')).toBe('2026-06-30');
    expect(normaliseTimestamp('2026-06-30', rules)).toBe('<ts:iso-date>');
  });

  it('uses the bare placeholder when the rules do not assert format classes', () => {
    const bare = { ...rules, timestamps: { ...rules.timestamps, assertSameFormatClass: false } };
    expect(normaliseTimestamp('2026-06-30T10:00:00', bare)).toBe(rules.timestamps.placeholder);
  });
});

describe('tokens', () => {
  it('exports the placeholders the committed rules declare', () => {
    expect(TOKEN_PLACEHOLDER).toBe(rules.tokens.placeholder);
    expect(URL_PLACEHOLDER).toBe(rules.urls.placeholder);
  });

  it.each<[string, boolean]>([
    ['csrf_token', true],
    ['AuthToken', true],
    ['returnid', true],
    ['x-csrf_token', true],
    ['X-CSRF_TOKEN_EXPIRES', true],
    ['code', false],
    ['title', false],
  ])('isTokenKey(%s) is %s', (key, expected) => {
    expect(isTokenKey(key, rules)).toBe(expected);
  });

  it('masks non-empty token values at any depth, keeping empty and null tokens, other values and key order', () => {
    const at = new Date(0);
    const input = {
      z: 1,
      csrf_token: 'abc',
      nested: [{ access_token: 'x', refresh_token: '', authToken: null }, at],
      title: 'csrf_token=abc',
    };
    const before = structuredClone(input);
    const out = normaliseTokens(input, rules) as typeof input;
    expect(out).toStrictEqual({
      z: 1,
      csrf_token: '<token>',
      nested: [{ access_token: '<token>', refresh_token: '', authToken: null }, at],
      title: 'csrf_token=abc',
    });
    expect(Object.keys(out)).toStrictEqual(Object.keys(input));
    expect(out.nested[1]).toBe(at);
    expect(input).toStrictEqual(before);
  });
});

describe('normaliseUrl', () => {
  it.each([
    [
      'lower-cases muraAction, masks a token, keeps an empty token and the fragment, and numbers ids',
      `/admin/?muraAction=cArch.List&csrf_token=abc&csrf_token_expires=&userid=${A}#Top`,
      '/admin/?muraAction=carch.list&csrf_token=<token>&csrf_token_expires=&userid=<id:1>#Top',
    ],
    [
      'replaces the capture origin and lower-cases a mixed-case action parameter',
      `${CAPTURE_ORIGIN}/admin/?MuraAction=CUsers.Edit`,
      '<origin>/admin/?MuraAction=cusers.edit',
    ],
    [
      'replaces the replay origin under its localhost alias',
      'http://localhost:8100/x?fuseaction=A.B',
      '<origin>/x?fuseaction=a.b',
    ],
    ['masks a file-store path', '/opt2/files/a.png', '<url>'],
    ['masks a URL with a signed query parameter', 'https://storage.googleapis.com/b/o?X-Goog-Signature=abc', '<url>'],
    [
      'masks tokens named after an &amp; separator or percent-encoded, keeping malformed names',
      '/a?flag&amp;csrf_token=1&a%20b+c=2&%E0%A4%A=3&csrf%5Ftoken=9',
      '/a?flag&amp;csrf_token=<token>&a%20b+c=2&%E0%A4%A=3&csrf%5Ftoken=<token>',
    ],
    ['matches token parameter names exactly', '/a?CSRF_TOKEN=abc', '/a?CSRF_TOKEN=abc'],
    ['keeps an origin that is not configured', 'https://cms.example.test:8500/x', 'https://cms.example.test:8500/x'],
    ['normalises an unparseable URL as text', 'http://[bad', 'http://[bad'],
    ['normalises a URL without a host as text', 'http://', 'http://'],
  ])('%s', (_label, url, expected) => {
    expect(normaliseUrl(url, createIdOrdinals(), rules)).toBe(expected);
  });

  it('applies only the rules urls.otherwise.apply lists, and sorts the query by name when asked', () => {
    const plain = { ...rules, urls: { ...rules.urls, otherwise: { apply: [], sortQuery: true } } };
    expect(
      normaliseUrl(`${CAPTURE_ORIGIN}/a?z=2&csrf_token=abc&muraAction=X.Y&b=${A}&z=1`, createIdOrdinals(), plain),
    ).toBe(`${CAPTURE_ORIGIN}/a?b=${A}&csrf_token=abc&muraAction=x.y&z=2&z=1`);
  });

  it('masks token parameters in URLs and text by any case under case-insensitive queryParamMatch', () => {
    const folded = { ...rules, tokens: { ...rules.tokens, queryParamMatch: 'case-insensitive' as const } };
    expect(normaliseUrl('/a?CSRF_TOKEN=abc', createIdOrdinals(), folded)).toBe('/a?CSRF_TOKEN=<token>');
    expect(normaliseText('see x?CSRF_TOKEN=abc', createIdOrdinals(), folded)).toBe('see x?CSRF_TOKEN=<token>');
    expect(normaliseText('see x?CSRF_TOKEN=abc', createIdOrdinals(), rules)).toBe('see x?CSRF_TOKEN=abc');
  });
});

describe('normaliseText', () => {
  it.each([
    [
      'normalises a URL in prose without its trailing punctuation',
      `See ${CAPTURE_ORIGIN}/admin/?csrf_token=abc.`,
      'See <origin>/admin/?csrf_token=<token>.',
    ],
    [
      'replaces embedded timestamps and ids',
      `Updated 2026-06-30T10:00:00 by ${A}`,
      'Updated <ts:serializer> by <id:1>',
    ],
    [
      'replaces admin dates and times inside text',
      'on 10/302/2026 at 9:05 AM',
      'on <ts:admin-date> at <ts:admin-time>',
    ],
    ['replaces a whole-value timestamp with its class', '2026-06-30', '<ts:iso-date>'],
    [
      'keeps whole-value and key-bound classes literal inside text',
      'due 2026-06-30 at 260630100000123',
      'due 2026-06-30 at 260630100000123',
    ],
    [
      'masks token parameters after &amp; and keeps empty ones',
      'a.cfm?x=1&amp;csrf_token=abc&token=',
      'a.cfm?x=1&amp;csrf_token=<token>&token=',
    ],
    [
      'replaces percent-encoded and bare host:port origins only at host boundaries',
      'r=http%3A%2F%2F127.0.0.1%3A8500%2Fadmin host 127.0.0.1:85001 10.127.0.0.1:8500 localhost:8500.',
      'r=http%3A%2F%2F<origin>%2Fadmin host 127.0.0.1:85001 10.127.0.0.1:8500 <origin>.',
    ],
    ['keeps an unparseable URL in prose', 'go http://[bad now', 'go http://[bad now'],
    ['keeps the empty string', '', ''],
  ])('%s', (_label, text, expected) => {
    expect(normaliseText(text, createIdOrdinals(), rules)).toBe(expected);
  });

  it('numbers ids left to right across prose and the URLs in it', () => {
    expect(normaliseText(`${B} then http://x.test/?id=${A} then ${A}`, createIdOrdinals(), rules)).toBe(
      '<id:1> then http://x.test/?id=<id:2> then <id:2>',
    );
  });

  it('finds no timestamp inside text when every class is whole-value or key-bound', () => {
    const wholeOnly = {
      ...rules,
      timestamps: {
        ...rules.timestamps,
        assertSameFormatClass: false,
        classes: rules.timestamps.classes.filter((cls) => cls.scope === 'whole-value'),
      },
    };
    const text = 'at 2026-06-30T10:00:00 now';
    expect(normaliseText(text, createIdOrdinals(), wholeOnly)).toBe(text);
    expect(normaliseText('2026-06-30', createIdOrdinals(), wholeOnly)).toBe('<ts>');
  });

  it('replaces a portless origin outside the host aliases under its own host only', () => {
    const other = { ...rules, origins: { ...rules.origins, values: ['https://cms.example.test'] } };
    expect(
      normaliseText(
        'https://cms.example.test/a, cms.example.test. https://localhost/b sub.cms.example.test',
        createIdOrdinals(),
        other,
      ),
    ).toBe('<origin>/a, <origin>. https://localhost/b sub.cms.example.test');
  });
});

describe('normaliseValue', () => {
  it('normalises a JSON body with sorted keys, ids in keys, URLs, date-only literals, epoch numbers and tokens', () => {
    const at = new Date(0);
    const body = {
      url: `${CAPTURE_ORIGIN}/opt2/files/x`,
      URL: `${CAPTURE_ORIGIN}/page`,
      downloadUrl: 'anything',
      store: 'https://storage.googleapis.com/b/o',
      link: '/_api/json/v1/site/content',
      rel: '/plain/path',
      nav: '/admin/?muraAction=X',
      query: '?muraAction=X',
      up: '../x?y=1',
      bad: 'http://[bad',
      when: '2026-06-30T10:00:00',
      asOf: '2026-06-30',
      dueDate: ['2026-06-30'],
      createdAt: EPOCH_MS,
      loginTime: EPOCH_MS,
      count: EPOCH_MS,
      ratio: 1.5,
      csrf_token: 42,
      authToken: '',
      [A]: { id: A },
      flag: true,
      none: null,
      at,
      plain: 'hello',
    };
    const out = normaliseValue(body, createIdOrdinals(), rules) as Record<string, unknown>;
    expect(out).toStrictEqual({
      '<id:1>': { id: '<id:1>' },
      URL: '<origin>/page',
      asOf: '2026-06-30',
      at,
      authToken: '',
      bad: 'http://[bad',
      count: EPOCH_MS,
      createdAt: '<ts:epoch-ms>',
      csrf_token: '<token>',
      downloadUrl: '<url>',
      dueDate: ['2026-06-30'],
      flag: true,
      link: '/_api/json/v1/site/content',
      loginTime: '<ts:epoch-ms>',
      nav: '/admin/?muraAction=x',
      none: null,
      plain: 'hello',
      query: '?muraAction=x',
      ratio: 1.5,
      rel: '/plain/path',
      store: 'https://storage.googleapis.com/b/o',
      up: '../x?y=1',
      url: '<url>',
      when: '<ts:serializer>',
    });
    expect(Object.keys(out)).toStrictEqual(Object.keys(out).sort());
    expect(out.at).toBe(at);
  });

  it.each<[unknown, string | undefined, unknown]>([
    [EPOCH_MS, undefined, EPOCH_MS],
    [EPOCH_MS, 'updatedAt', '<ts:epoch-ms>'],
    ['abc', 'csrf_token', '<token>'],
    ['', 'csrf_token', ''],
    [['2026-06-30'], 'asOf', ['2026-06-30']],
    ['/opt2/files/x', undefined, '<url>'],
  ])('normalises %j under key %s to %j', (value, key, expected) => {
    expect(normaliseValue(value, createIdOrdinals(), rules, key)).toStrictEqual(expected);
  });

  it('keeps a number under a date-only key even where an epoch key glob matches', () => {
    const value = { launchAt: EPOCH_MS, launch_at: EPOCH_MS };
    const dated = {
      ...rules,
      timestamps: { ...rules.timestamps, dateOnlyFields: [...rules.timestamps.dateOnlyFields, 'launchAt'] },
    };
    expect(normaliseValue(value, createIdOrdinals(), dated)).toStrictEqual(value);
    expect(normaliseValue(value, createIdOrdinals(), rules)).toStrictEqual({
      launchAt: '<ts:epoch-ms>',
      launch_at: '<ts:epoch-ms>',
    });
  });

  it('keeps id ordinals across the values normalised with one state', () => {
    const state = createIdOrdinals();
    expect(normaliseValue({ parent: B, id: A }, state, rules)).toStrictEqual({ id: '<id:1>', parent: '<id:2>' });
    expect(normaliseValue(`/admin/?userid=${B}`, state, rules)).toBe('/admin/?userid=<id:2>');
  });
});
