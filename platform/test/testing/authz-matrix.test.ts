import { fastify, type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthDenial, Roles, collectRouteMatrix, registerAuth, type RouteMatrixEntry } from '../../src/auth/index.js';
import {
  DENIAL_KINDS, MINIMUM_SUBJECTS, ROLE_SET, TENANT_A, TENANT_B, authDenialProblems, authHeadersFor, createCredentialCache, expectedAuthDenial,
  headerStrings, isErrorEnvelope, matrixCells, parsedJson, renderedDenial, renderedDenialMatching, roleSubjectNamed, routeTableCoverage, subjectQueryFor,
  testVerifier, unexpectedVerdicts, withQuery, type ExpectedDenialOptions, type ProbeOutcome, type RoleSubject,
} from '../../src/testing/index.js';

const SITE_A = TENANT_A.siteId;
const FORBIDDEN = AuthDenial.forbidden();
const INVALID = AuthDenial.invalidToken();
const QUERY = { siteid: SITE_A };
const RENDERED = renderedDenial(INVALID, QUERY);
const MISSING_HEADERS = Object.entries(RENDERED.headers).map(([name, value]) => `header ${name} is undefined, not ${value}`);
const DEPARTURES = ['answered 403, expected 401: {"x":1}', 'not the legacy error envelope: {"x":1}', `body {"x":1} is not ${RENDERED.body}`, ...MISSING_HEADERS];
const ENVELOPE = { apiversion: 'v1', method: 'm', error: { code: 'c', message: 'x' } };
const ROWS = [{ url: '/a', public: true }, { url: '/b', requires: [Roles.s2] }];
type Cell = [url: string, admits: boolean, status?: number];
const CELLS: Cell[] = [['/allowed', true, 200], ['/denied', false, 403], ['/leak', false, 200], ['/unprobed', false], ['/refused', true, 401], ['/unprobed-admit', true]];
const READER = { title: ([url]: Cell) => url, admits: ([, admits]: Cell) => admits, status: ([, , status]: Cell) => status };
const SENT_HEADERS = Object.fromEntries(Object.entries(RENDERED.headers).map(([name, value]) => [name.toLowerCase(), value]));
const outcome = (changes: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ status: RENDERED.status, body: RENDERED.body, headers: SENT_HEADERS, query: QUERY, ...changes });
// A site-admin token of tenant-a probing tenant-b's site.
const siteAdminDenial = (route: { siteCheck?: boolean }, options: ExpectedDenialOptions = {}): AuthDenial | undefined =>
  expectedAuthDenial({ requires: [Roles.siteAdmin], ...route }, roleSubjectNamed(Roles.siteAdmin), { requestSite: TENANT_B.siteId, ...options });

describe('authorisation-matrix helpers', () => {
  it.each<[string, () => unknown, unknown]>([
    ['MINIMUM_SUBJECTS names ROLE_SET subjects', () => MINIMUM_SUBJECTS.map((name) => roleSubjectNamed(name).name), ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant']],
    ['DENIAL_KINDS render distinct responses', () => new Set(DENIAL_KINDS.map((denial) => JSON.stringify(renderedDenial(denial, {})))).size, DENIAL_KINDS.length],
    ['roleSubjectNamed looks in the list given', () => roleSubjectNamed('anonymous', [ROLE_SET[0] as RoleSubject]), ROLE_SET[0]],
    ['parsedJson parses JSON and gives undefined for other text', () => [parsedJson('[1,2]'), parsedJson('not json')], [[1, 2], undefined]],
    ['isErrorEnvelope accepts the envelope with params', () => isErrorEnvelope({ ...ENVELOPE, params: { a: '1' } }), true],
    ['isErrorEnvelope rejects params that are not a record', () => isErrorEnvelope({ ...ENVELOPE, params: [] }), false],
    ['isErrorEnvelope rejects an error without a message', () => isErrorEnvelope({ ...ENVELOPE, error: { code: 'c' } }), false],
    ['isErrorEnvelope rejects null', () => isErrorEnvelope(null), false],
    ['withQuery leaves a url unchanged by an empty query', () => [withQuery('/a', {}), withQuery('/a', '')], ['/a', '/a']],
    ['withQuery appends a record or encoded text', () => [withQuery('/a?x=1', { key: 'k', b: 'x y' }), withQuery('/a', 'key=k')], ['/a?x=1&key=k&b=x+y', '/a?key=k']],
    ['headerStrings flattens each header to one string', () => headerStrings({ headers: { a: 'x', b: ['y', 'z'], c: 3 } }), { a: 'x', b: 'y, z', c: '3' }],
    ['renderedDenial reads the query of a request url', () => renderedDenial(INVALID, `/v1/x?siteid=${SITE_A}`), RENDERED],
    ['renderedDenialMatching finds the rendering whose body it is', () => renderedDenialMatching(RENDERED.body, QUERY), RENDERED],
    ['renderedDenialMatching finds none at another status or outside the kinds given', () => [renderedDenialMatching(RENDERED.body, QUERY, { status: 403 }), renderedDenialMatching(RENDERED.body, QUERY, { kinds: [FORBIDDEN] })], [undefined, undefined]],
    ['authDenialProblems accepts the denial expected or one of the kinds', () => [authDenialProblems(outcome(), INVALID), authDenialProblems(outcome(), DENIAL_KINDS)], [[], []]],
    ['authDenialProblems names each departure from the denial expected', () => authDenialProblems(outcome({ status: 403, body: '{"x":1}', headers: {} }), INVALID), DEPARTURES],
    ['authDenialProblems names each missing header of one of the kinds', () => [MISSING_HEADERS.length, authDenialProblems(outcome({ headers: {} }), DENIAL_KINDS)], [3, MISSING_HEADERS]],
    ['authDenialProblems names an admitted status', () => authDenialProblems(outcome({ status: 200, body: '{}' }), DENIAL_KINDS), ['expected 401 or 403, answered 200: {}']],
    ['authDenialProblems names a body no denial renders', () => authDenialProblems(outcome({ body: 'nope' }), DENIAL_KINDS), ['not the legacy error envelope: nope', 'body is not one renderAuthDenial builds: nope']],
    ['expectedAuthDenial applies the siteCheck of the route', () => [siteAdminDenial({}), siteAdminDenial({ siteCheck: false })], [AuthDenial.siteMismatch(), undefined]],
    ['expectedAuthDenial takes the siteCheck option over the route', () => [siteAdminDenial({}, { siteCheck: false }), siteAdminDenial({ siteCheck: false }, { siteCheck: true })], [undefined, AuthDenial.siteMismatch()]],
    ['expectedAuthDenial takes the token site from the tokenSite option', () => siteAdminDenial({}, { tokenSite: TENANT_B.siteId }), undefined],
    ['matrixCells pairs every row with every subject', () => matrixCells(ROWS).length, ROWS.length * ROLE_SET.length],
    ['matrixCells owes the expected denials', () => matrixCells(ROWS).filter(({ row, denial }) => row.url === '/b' && denial === undefined).map(({ subject }) => subject.name), ['s2']],
    ['matrixCells takes the subjects and denials given', () => matrixCells(ROWS, [ROLE_SET[0] as RoleSubject], () => FORBIDDEN).map(({ row, denial }) => [row.url, denial]), [['/a', FORBIDDEN], ['/b', FORBIDDEN]]],
    ['unexpectedVerdicts lists allows, unprobed cells included, and denies', () => unexpectedVerdicts(CELLS, READER), { unexpectedAllows: ['/leak: 200', '/unprobed: not probed'], unexpectedDenies: ['/refused: 401'] }],
    ['routeTableCoverage lists missing, extra and repeated keys', () => routeTableCoverage(['GET /a', 'GET /a', 'GET /c'], ['GET /a', 'GET /b']), { missing: ['GET /c'], extra: ['GET /b'], duplicated: ['GET /a'] }],
  ])('%s', (_label, run, expected) => {
    expect(run()).toStrictEqual(expected);
  });

  it.each<[string, () => unknown, string]>([
    ['roleSubjectNamed for ROLE_SET', () => roleSubjectNamed('nobody'), 'ROLE_SET has no subject named nobody'],
    ['roleSubjectNamed for another list', () => roleSubjectNamed('nobody', []), 'No subject named nobody'],
    ['expectedAuthDenial for a service subject without a caller', () => expectedAuthDenial({ public: true }, { name: 'service:ghost', kind: 'service', roles: [] }), 'Service subject service:ghost has no caller'],
  ])('%s throws a TypeError', (_label, run, message) => {
    expect(run).toThrow(new TypeError(message));
  });

  it('createCredentialCache reuses the credential of a key for reuseMs on its clock', async () => {
    let clock = 0;
    let minted = 0;
    const cached = createCredentialCache<number>({ reuseMs: 10, now: () => clock });
    const at = (time: number, key: string): Promise<number> => {
      clock = time;
      return cached(key, async () => ++minted);
    };
    expect([await at(0, 'a'), await at(9, 'a'), await at(9, 'b'), await at(10, 'a')]).toEqual([1, 1, 2, 3]);
  });

  let app: FastifyInstance;
  let rows: RouteMatrixEntry[];
  beforeAll(async () => {
    app = fastify();
    registerAuth(app, { transports: testVerifier('stub').transports });
    const ok = async (): Promise<{ ok: true }> => ({ ok: true });
    app.get('/edge', { config: { opt2: { public: true, edge: true } } }, ok);
    app.get('/v1/open', { config: { opt2: { public: true, invocationOptional: true } } }, ok);
    app.get('/v1/sites/admin', { config: { opt2: { requires: [Roles.siteAdmin] } } }, ok);
    app.get('/internal/v1/migration/gate', { config: { opt2: { requires: [Roles.platformMigration] } } }, ok);
    app.post('/internal/v1/events/x.y.z.v1', { config: { opt2: { transport: 'pubsub-push', requires: ['service:pubsub-invoker'] } } }, ok);
    app.post('/internal/v1/outbox/sweep', { config: { opt2: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'] } } }, ok);
    await app.ready();
    rows = collectRouteMatrix(app).routes.filter((route) => route.method !== 'HEAD');
  });
  afterAll(() => app?.close());

  it('expectedAuthDenial gives the verdict the hooks give every ROLE_SET subject on each transport and declaration kind', async () => {
    expect(rows).toHaveLength(6);
    const mismatches: string[] = [];
    for (const row of rows) {
      for (const subject of ROLE_SET) {
        const requestSite = row.url === '/v1/sites/admin' ? SITE_A.toUpperCase() : undefined;
        const query: Record<string, string> = { ...subjectQueryFor(subject), ...(requestSite === undefined ? {} : { siteid: requestSite }) };
        const res = await app.inject({ method: row.method, url: withQuery(row.url, query), headers: await authHeadersFor(subject, { site: SITE_A, audience: 'stub' }) });
        const denial = expectedAuthDenial(row, subject, { requestSite });
        const owed = denial === undefined ? { status: 200, body: '{"ok":true}' } : renderedDenial(denial, query);
        if (res.statusCode !== owed.status || res.body !== owed.body) mismatches.push(`${row.method} ${row.url} as ${subject.name}: ${res.statusCode} ${res.body}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
