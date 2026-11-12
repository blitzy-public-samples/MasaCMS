// Unit tests for comparing login Set-Cookie behaviour under the session-rotation known-issue mask.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Scenario } from '../../../src/golden/catalogue.js';
import {
  compareNormalised,
  createNormaliseState,
  loadRules,
  normaliseStep,
  type Difference,
  type DifferenceKind,
  type NormalisedRun,
  type NormalisedStep,
  type NormaliseRules,
} from '../../../src/golden/normalise/index.js';
import type { StepRecord } from '../../../src/golden/steps.js';
import type { HttpHop } from '../../../src/lib/http.js';

const ORIGIN = 'http://127.0.0.1:8500';
const STEPS = [
  { name: 'login-form', method: 'GET', route: '/admin/?muraAction=clogin.main', routeKey: 'admin:clogin.main' },
  { name: 'login', method: 'POST', route: '/admin/index.cfm', routeKey: 'admin:clogin.login' },
] as const;
const SCENARIO = {
  id: 'GS-ID-01',
  title: 'Admin login and logout',
  service: 'identity',
  role: 'admin',
  sessions: {},
  seedRefs: [],
  steps: STEPS.map(({ name, method, route }) => ({ name, method, route, csrf: 'none' })),
  compare: ['status', 'auth'],
  normalisationOverrides: {},
  covers: [],
  tableVersion: 'v0002',
} as unknown as Scenario;

type StepName = (typeof STEPS)[number]['name'];
/** Set-Cookie lines of each hop of one response; a single hop is a response without redirects. */
type Hops = readonly (readonly string[])[];

let rules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
});

const one = (...lines: string[]): Hops => [lines];

function hop(status: number, setCookie: readonly string[], location?: string): HttpHop {
  return {
    method: 'GET',
    url: `${ORIGIN}/admin/`,
    status,
    ...(location === undefined ? {} : { location }),
    setCookie: [...setCookie],
    requestHeaders: {},
    responseHeaders: { 'set-cookie': [...setCookie], ...(location === undefined ? {} : { location }) },
  };
}

/** The record of `STEPS[index]`; every hop before the last is a 302 redirect. */
function record(index: number, hops: Hops): StepRecord {
  const step = STEPS[index];
  if (step === undefined) throw new Error(`no step ${index}`);
  const last = hops.at(-1) ?? [];
  const redirects = hops.slice(0, -1).map((lines) => hop(302, lines, '/admin/'));
  return {
    name: step.name,
    index,
    routeKey: step.routeKey,
    request: { method: step.method, url: `${ORIGIN}${step.route}`, headers: {}, body: { kind: 'none' } },
    response: {
      status: 200,
      headers: { 'set-cookie': [...last], 'content-type': 'text/html' },
      contentType: 'text/html',
      sha256: '0'.repeat(64),
      hops: redirects.length > 0 ? [...redirects, hop(200, last)] : [],
      text: '',
    },
    extracted: {},
  };
}

/** One scenario side holding the given steps, in catalogue order. */
async function side(responses: Partial<Record<StepName, Hops>>): Promise<NormalisedRun> {
  const ctx = { state: createNormaliseState(), rules, scenario: SCENARIO };
  const steps: NormalisedStep[] = [];
  for (const [index, { name }] of STEPS.entries()) {
    const hops = responses[name];
    if (hops !== undefined) steps.push(await normaliseStep(record(index, hops), ctx));
  }
  return { steps, sideEffects: {} };
}

async function compare(
  golden: Partial<Record<StepName, Hops>>,
  replay: Partial<Record<StepName, Hops>>,
): Promise<Difference[]> {
  return compareNormalised(await side(golden), await side(replay), { rules, scenario: SCENARIO });
}

const loginDifference = (
  path: string,
  kind: DifferenceKind,
  expected: unknown,
  actual: unknown,
  maskId?: Difference['maskId'],
): Difference =>
  maskId === undefined
    ? { step: 'login', path, kind, expected, actual, classification: 'difference' }
    : { step: 'login', path, kind, expected, actual, classification: 'known-issue', maskId };

const cookieNamed = async (hops: Hops, name: string): Promise<unknown> =>
  (await side({ login: hops })).steps[0]?.auth?.cookies.find((cookie) => cookie.name === name);

const ATTRIBUTES = 'Path=/; Domain=example.test; Secure; HttpOnly; SameSite=Lax';

describe('session cookies of a login step', () => {
  it.each<[string, Hops, Hops, string, DifferenceKind, unknown, unknown]>([
    [
      'a session cookie losing Secure',
      one(`CFID=g1; ${ATTRIBUTES}`),
      one('CFID=r1; Path=/; Domain=example.test; HttpOnly; SameSite=Lax'),
      'auth.cookies[0].secure',
      'changed',
      true,
      false,
    ],
    [
      'a session cookie losing HttpOnly',
      one(`CFTOKEN=g1; ${ATTRIBUTES}`),
      one('CFTOKEN=r1; Path=/; Domain=example.test; Secure; SameSite=Lax'),
      'auth.cookies[0].httpOnly',
      'changed',
      true,
      false,
    ],
    [
      'a session cookie changing Path',
      one(`CFID=g1; ${ATTRIBUTES}`),
      one('CFID=r1; Path=/admin; Domain=example.test; Secure; HttpOnly; SameSite=Lax'),
      'auth.cookies[0].path',
      'changed',
      '/',
      '/admin',
    ],
    [
      'a session cookie changing Domain',
      one(`JSESSIONID=g1; ${ATTRIBUTES}`),
      one('JSESSIONID=r1; Path=/; Domain=other.test; Secure; HttpOnly; SameSite=Lax'),
      'auth.cookies[0].domain',
      'changed',
      'example.test',
      'other.test',
    ],
    [
      'a session cookie changing SameSite',
      one(`CFID=g1; ${ATTRIBUTES}`),
      one('CFID=r1; Path=/; Domain=example.test; Secure; HttpOnly; SameSite=Strict'),
      'auth.cookies[0].sameSite',
      'changed',
      'Lax',
      'Strict',
    ],
    [
      'a session cookie losing SameSite',
      one(`CFID=g1; ${ATTRIBUTES}`),
      one('CFID=r1; Path=/; Domain=example.test; Secure; HttpOnly'),
      'auth.cookies[0].sameSite',
      'missing',
      'Lax',
      undefined,
    ],
    [
      'a session cookie becoming persistent',
      one(`CFID=g1; ${ATTRIBUTES}`),
      one(`CFID=r1; Max-Age=3600; ${ATTRIBUTES}`),
      'auth.cookies[0].persistence',
      'changed',
      'session',
      'persistent',
    ],
    [
      'a session cookie set on a later hop',
      [[`CFID=g1; ${ATTRIBUTES}`], []],
      [[], [`CFID=r1; ${ATTRIBUTES}`]],
      'auth.cookies[0].hop',
      'changed',
      0,
      1,
    ],
    [
      'a non-session cookie losing Secure',
      one('CFID=g1; Path=/', 'theme=g2; Path=/; Secure'),
      one('CFID=r1; Path=/', 'theme=r2; Path=/'),
      'auth.cookies[1].secure',
      'changed',
      true,
      false,
    ],
  ])('compares %s as a difference', async (_label, golden, replay, path, kind, expected, actual) => {
    expect(await compare({ login: golden }, { login: replay })).toStrictEqual([
      loginDifference(path, kind, expected, actual),
    ]);
  });

  it.each<[string, Hops, Hops, string, 'missing' | 'extra', string]>([
    [
      'missing first',
      one('CFID=g1; Path=/', 'CFTOKEN=g2; Path=/', 'theme=g3; Path=/'),
      one('CFTOKEN=r2; Path=/', 'theme=r3; Path=/'),
      'auth.cookies[0]',
      'missing',
      'CFID',
    ],
    [
      'missing mid-array',
      one('CFID=g1; Path=/', 'CFTOKEN=g2; Path=/', 'theme=g3; Path=/'),
      one('CFID=r1; Path=/', 'theme=r3; Path=/'),
      'auth.cookies[1]',
      'missing',
      'CFTOKEN',
    ],
    [
      'extra on replay',
      one('CFID=g1; Path=/', 'CFTOKEN=g2; Path=/', 'theme=g3; Path=/'),
      one('CFID=r1; Path=/', 'CFTOKEN=r2; Path=/', 'JSESSIONID=r4; Path=/', 'theme=r3; Path=/'),
      'auth.cookies[2]',
      'extra',
      'JSESSIONID',
    ],
  ])('masks a session cookie %s as one known-issue difference', async (_label, golden, replay, path, kind, name) => {
    const cookie = await cookieNamed(kind === 'missing' ? golden : replay, name);
    expect(cookie).toBeDefined();
    const [expected, actual] = kind === 'missing' ? [cookie, undefined] : [undefined, cookie];
    expect(await compare({ login: golden }, { login: replay })).toStrictEqual([
      loginDifference(path, kind, expected, actual, 'session-rotation'),
    ]);
  });

  it.each<[string, Hops, Hops, 'missing' | 'extra']>([
    ['extra on replay', one('CFID=g1; Path=/'), one('APP_PREF=r9; Path=/', 'CFID=r1; Path=/'), 'extra'],
    ['missing on replay', one('APP_PREF=g9; Path=/', 'CFID=g1; Path=/'), one('CFID=r1; Path=/'), 'missing'],
  ])(
    'keeps a non-session cookie %s at an index the other side masks as a difference',
    async (_label, golden, replay, kind) => {
      const cookie = await cookieNamed(kind === 'missing' ? golden : replay, 'APP_PREF');
      expect(cookie).toBeDefined();
      const [expected, actual] = kind === 'missing' ? [cookie, undefined] : [undefined, cookie];
      expect(await compare({ login: golden }, { login: replay })).toStrictEqual([
        loginDifference('auth.cookies[0]', kind, expected, actual),
      ]);
    },
  );

  it('classifies a session cookie kept across login on one side and rotated on the other as known-issue', async () => {
    const golden = { 'login-form': one('CFID=g1; Path=/'), login: one('CFID=g1; Path=/') };
    const replay = { 'login-form': one('CFID=r1; Path=/'), login: one('CFID=r2; Path=/') };
    expect(await compare(golden, replay)).toStrictEqual([
      loginDifference('auth.cookies[0].rotation', 'changed', 'same', 'changed', 'session-rotation'),
    ]);
  });
});
