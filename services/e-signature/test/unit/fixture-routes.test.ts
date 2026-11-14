// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature fixture routes through `app.inject` against a throwaway `esignature` schema, held to legacy-fixtures/cfml/modules/esignature.cfc. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ANONYMOUS_PRINCIPAL_UID, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { cfHash } from '@opt2/platform/legacy-compat';
import { createLogger, validateLogRecord } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { PeopleReadDeniedError, type PeopleClient, type PersonSummary } from '../../src/legacy/people-client.js';
import { createEsignatureRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import { FIXTURE_OPERATIONS, FIXTURE_PREFIX, registerFixtureRoutes } from '../../src/routes/fixture.js';
import { AUDITOR_USER_ID, OTHER_USER_ID, SIGNER_USER_ID, userHeaders } from '../helpers/tokens.js';

const P = `${FIXTURE_PREFIX}/requests`;
const NOW = new Date(2026, 5, 30, 14, 5, 9, 124);
const SIGNER = [Roles.systemUser, Roles.esignatureSigner];
const AUDITOR = [Roles.systemUser, Roles.esignatureAuditor];
const READERS = [Roles.esignatureSigner, Roles.esignatureAuditor];
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const GOOD_TOKEN = 'VALIDCSRFTOKEN';
const CSRF = { 'x-csrf_token': GOOD_TOKEN, 'x-csrf_token_expires': '991231235959000' };
const DOCUMENT = Buffer.from('%PDF-1.7 synthetic fixture contract');
const CREATE = { documentName: 'contract.pdf', documentBase64: DOCUMENT.toString('base64'), signerUserId: SIGNER_USER_ID };
// An unknown site in each body type a fixture request may carry.
const FORM_SITE = { type: 'application/x-www-form-urlencoded', text: 'siteid=nosuch' };
const MULTIPART_SITE = { type: 'multipart/form-data; boundary=opt2', text: '--opt2\r\nContent-Disposition: form-data; name="siteid"\r\n\r\nnosuch\r\n--opt2--\r\n' };
const JSON_SITE = { type: 'application/json', text: '{"siteid":"nosuch"}' };
// Identity's session without a login, which the verifier hands on as `sub` ''.
const ANONYMOUS_SESSION = { sub: ANONYMOUS_PRINCIPAL_UID, roles: [] };

/** People's answer to every read: a person, an outage or a denial. */
type PeopleMode = 'answer' | 'unavailable' | 'denied';

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

/** Status, headers and body of an answer, from `app.inject` or a socket. */
type Answer = Pick<Injected, 'statusCode' | 'headers' | 'body'>;

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const { load } = createRequire(createRequire(import.meta.url).resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const CONTRACT = load(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

/** Asserts that `res`, the answer to `method` on `url`, is a response the contract declares for that operation; returns `res`. */
function conforms<T extends Answer>(res: T, method: string, url: string): T {
  const { pathname } = new URL(url, 'http://e-signature.test');
  assertResponseMatchesOpenApi(CONTRACT, { method, path: pathname, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** A Type 2 people pool user of `siteId`. */
const person = (userId: string, siteId: string = TENANT_A.siteId): PersonSummary => ({ userId, siteId, type: 2 });

/** The fixture error envelope of `method` with `code` and `message`. */
const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

const available = await pgAvailable();

describe.skipIf(!available)('e-signature fixture routes', () => {
  let handle: ThrowawaySchema;
  let identity: http.Server;
  let stateDir: string;
  let app: FastifyInstance;
  let origin: string;
  let peopleMode: PeopleMode = 'answer';
  const persons = [person(SIGNER_USER_ID), person(OTHER_USER_ID)];
  const consumed: Array<{ token: string; context: string }> = [];
  const logLines: string[] = [];

  const people: PeopleClient = {
    readPerson: (_siteId, userId) => {
      if (peopleMode === 'unavailable') return Promise.reject(new ServiceUnavailableError('people', new Error('connect ECONNREFUSED')));
      if (peopleMode === 'denied') return Promise.reject(new PeopleReadDeniedError(401, 'authorization'));
      return Promise.resolve(persons.find((candidate) => candidate.userId.toUpperCase() === userId.toUpperCase()) ?? null);
    },
  };

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'e-signature',
      schemaName: 'esignature',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await seedRegistry(handle.app);
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-esignature-fixture-'));
    identity = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const consume = JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof consumed)[number];
        consumed.push({ token: consume.token, context: consume.context });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ valid: consume.token === GOOD_TOKEN }));
      });
    });
    await new Promise<void>((resolve) => identity.listen(0, '127.0.0.1', resolve));
    app = await createService({
      name: 'e-signature',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8120',
        OPT2_SERVICE_NAME: 'e-signature',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        OPT2_SERVICE_URLS: JSON.stringify({ identity: `http://127.0.0.1:${(identity.address() as AddressInfo).port}` }),
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('e-signature'),
      pool: handle.app,
      legacyFixturePaths: true,
      logger: createLogger({ service: 'e-signature', version: '1.0.0', env: 'local', destination: { write: (line: string) => void logLines.push(line) } }),
    });
    registerWritePositionHeader(app);
    const clock = fixedClock(NOW);
    await registerFixtureRoutes(app, { db: handle.app, repository: createEsignatureRepository({ db: handle.app, clock }), clock, peopleClient: people });
    origin = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await new Promise((resolve) => identity?.close(resolve));
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  /** Moves every e-signature gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: UNITS, holderId: 'fixture-routes-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'fixture-routes-test', state });
  }

  beforeEach(async () => {
    consumed.length = 0;
    peopleMode = 'answer';
    await setGates('open');
  });

  /**
   * Sends `method` to `url` as user `sub` holding `roles` on `site`, `override` as X-HTTP-Method-Override when given, with a valid
   * CSRF token on a POST or a POST override unless `csrf` is false.
   */
  async function send(
    method: 'GET' | 'POST',
    url: string,
    {
      sub = SIGNER_USER_ID,
      roles = SIGNER,
      site = TENANT_A.siteId,
      payload,
      csrf = true,
      contract = true,
      override,
    }: {
      sub?: string;
      roles?: readonly string[];
      site?: string;
      payload?: Record<string, unknown>;
      csrf?: boolean;
      contract?: boolean;
      override?: string;
    } = {},
  ): Promise<Injected> {
    const headers = {
      ...(await userHeaders({ sub, site, roles })),
      ...((method === 'POST' || override === 'POST') && csrf ? CSRF : {}),
      ...(override === undefined ? {} : { 'x-http-method-override': override }),
    };
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    return contract ? conforms(res, method, url) : res;
  }

  /** Sends `method` to `url` without any credential, as a request outside a Masa session reaches the fixture. */
  async function sendAnonymous(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>): Promise<Injected> {
    return conforms(await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }), method, url);
  }

  /**
   * Sends `method` to `url` over a socket as SIGNER, or without credentials when `anonymous`, `override` as X-HTTP-Method-Override
   * when given, with a valid CSRF token on a POST override; a socket, because `app.inject` keeps the HEAD body Node never sends.
   */
  async function sendOverSocket(
    method: string,
    url: string,
    { override, body, anonymous = false }: { override?: string; body?: { type: string; text: string }; anonymous?: boolean } = {},
  ): Promise<Answer> {
    const headers = {
      ...(anonymous ? {} : await userHeaders({ sub: SIGNER_USER_ID, roles: SIGNER })),
      ...(override === 'POST' ? CSRF : {}),
      ...(override === undefined ? {} : { 'x-http-method-override': override }),
      ...(body === undefined ? {} : { 'content-type': body.type }),
    };
    const res = await fetch(new URL(url, origin), { method, headers, ...(body === undefined ? {} : { body: body.text }) });
    return conforms({ statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }, method, url);
  }

  /** A request of DOCUMENT for SIGNER, created by SIGNER; returns its fixture row. */
  async function createRequest(): Promise<{ request_id: string; state: string }> {
    const res = await send('POST', P, { payload: CREATE });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  }

  /** The audit items of request `id`, read by an auditor. */
  async function auditItems(id: string): Promise<Array<Record<string, unknown>>> {
    return (await send('GET', `${P}/${id}/audit`, { sub: AUDITOR_USER_ID, roles: AUDITOR })).json().data.items;
  }

  /** The audit items as a caller posts them back: every chain key as text. */
  function suppliedCopy(items: ReadonlyArray<Record<string, unknown>>): Array<Record<string, string>> {
    return items.map((item) => Object.fromEntries(['seq', 'action', 'actor_user_id', 'detail', 'at', 'prev_hash', 'entry_hash'].map((key) => [key, String(item[key])])));
  }

  it('registers the four contract paths for every request method, public with the handler checking site and roles, and six effective-method operations', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith(FIXTURE_PREFIX));
    expect(routes.map(({ method, url, requires, transport, siteCheck, ...rest }) => [method, url.slice(FIXTURE_PREFIX.length), requires, rest.public, transport, siteCheck])).toEqual(
      ['/requests', '/requests/:id/audit', '/requests/:id/sign', '/requests/:id/verify'].flatMap((url) =>
        ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].map((method) => [method, url, undefined, true, 'service', false]),
      ),
    );
    expect(FIXTURE_OPERATIONS.map(({ operationId, method, url, requires }) => [operationId, method, url.slice(FIXTURE_PREFIX.length), requires])).toEqual([
      ['fixtureListRequests', 'GET', '/requests', [Roles.esignatureSigner]],
      ['fixtureCreateRequest', 'POST', '/requests', [Roles.esignatureSigner]],
      ['fixtureSignRequest', 'POST', '/requests/:id/sign', [Roles.esignatureSigner]],
      ['fixtureGetAudit', 'GET', '/requests/:id/audit', READERS],
      ['fixtureVerifyStored', 'GET', '/requests/:id/verify', READERS],
      ['fixtureVerifySupplied', 'POST', '/requests/:id/verify', READERS],
    ]);
  });

  it('creates, lists, signs, audits and verifies a request as esignature.cfc does', async () => {
    const created = await send('POST', P, { payload: CREATE });
    expect([created.statusCode, created.json().method]).toEqual([200, 'esignature.requests']);
    expect(created.json().data).toMatchObject({
      siteid: TENANT_A.siteId,
      document_name: 'contract.pdf',
      document_sha256: createHash('sha256').update(DOCUMENT).digest('hex'),
      signer_user_id: SIGNER_USER_ID,
      state: 'PENDING',
      created: '2026-06-30T14:05:09',
      createdbyid: SIGNER_USER_ID,
    });
    expect(created.json().data).not.toHaveProperty('document');
    expect(created.headers['x-opt2-write-position']).toMatch(/^e-signature=\d+$/);
    expect(created.headers.etag).toBe(cfHash(created.body));
    const id: string = created.json().data.request_id;

    const listed = await send('GET', `${P}?itemsPerPage=1000`);
    expect(listed.json().method).toBe('esignature.requests');
    expect(listed.json().data.items).toContainEqual(created.json().data);

    const signed = await send('POST', `${P}/${id.toLowerCase()}/SIGN`, { payload: { typedName: 'Jane Doe' }, contract: false });
    expect([signed.statusCode, signed.json().method, signed.json().data]).toEqual([200, 'esignature.requests.sign', { ...created.json().data, state: 'SIGNED' }]);
    expect(consumed).toEqual([
      { token: GOOD_TOKEN, context: '' },
      { token: GOOD_TOKEN, context: id.toLowerCase() },
    ]);

    const audit = await send('GET', `${P}/${id}/audit?pageIndex=2&itemsPerPage=1`, { sub: AUDITOR_USER_ID, roles: AUDITOR });
    expect(audit.json()).toMatchObject({
      method: 'esignature.requests.audit',
      data: { startindex: 2, endindex: 2, itemsperpage: 1, totalitems: 2, totalpages: 2, pageindex: 2 },
    });
    expect(audit.json().data.items).toEqual([expect.objectContaining({ request_id: id, seq: 2, action: 'signed', actor_user_id: SIGNER_USER_ID, detail: 'Jane Doe' })]);

    const stored = await send('GET', `${P}/${id}/verify`);
    expect([stored.json().method, stored.json().data]).toEqual(['esignature.requests.verify', { valid: true, entries: 2, brokenat: 0 }]);

    const copy = suppliedCopy(await auditItems(id));
    const intact = await send('POST', `${P}/${id}/verify`, { sub: AUDITOR_USER_ID, roles: AUDITOR, payload: { entries: copy } });
    expect([intact.statusCode, intact.json().data]).toEqual([200, { valid: true, entries: 2, brokenat: 0 }]);
    const asText = await send('POST', `${P}/${id}/verify`, { payload: { entries: JSON.stringify(copy) } });
    expect(asText.json().data).toEqual({ valid: true, entries: 2, brokenat: 0 });
    const tampered = await send('POST', `${P}/${id}/verify`, { payload: { entries: [copy[0], { ...copy[1], detail: 'John Doe' }] } });
    expect([tampered.statusCode, tampered.json().data]).toEqual([200, { valid: false, entries: 2, brokenat: 2 }]);

    const again = await send('POST', `${P}/${id}/sign`, { payload: { typedName: 'Jane Doe' } });
    expect([again.statusCode, again.body]).toEqual([409, errorBody('esignature.requests.sign', 'invalid_request', 'already-signed')]);
  });

  it.each<[string, (id: string) => Promise<Injected>, string, (id: string) => unknown, (id: string) => Array<{ token: string; context: string }>]>([
    [
      'a POST overridden to GET lists without consuming its token',
      () => send('POST', `${P}?itemsPerPage=1000`, { override: 'GET' }),
      'esignature.requests',
      (id) => expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ request_id: id })]) }),
      () => [],
    ],
    [
      'a lower-case override naming GET lists',
      () => send('POST', `${P}?itemsPerPage=1000`, { override: 'get' }),
      'esignature.requests',
      () => expect.objectContaining({ items: expect.any(Array) }),
      () => [],
    ],
    [
      'a GET overridden to POST creates, consuming the collection token',
      () => send('GET', `${P}?${new URLSearchParams(CREATE).toString()}`, { override: 'POST' }),
      'esignature.requests',
      () => expect.objectContaining({ document_name: 'contract.pdf', state: 'PENDING' }),
      () => [{ token: GOOD_TOKEN, context: '' }],
    ],
    [
      'an empty override keeps the GET',
      () => send('GET', `${P}?itemsPerPage=1000`, { override: '' }),
      'esignature.requests',
      () => expect.objectContaining({ items: expect.any(Array) }),
      () => [],
    ],
    [
      'an empty override keeps the POST',
      () => send('POST', P, { override: '', payload: CREATE }),
      'esignature.requests',
      () => expect.objectContaining({ document_name: 'contract.pdf', state: 'PENDING' }),
      () => [{ token: GOOD_TOKEN, context: '' }],
    ],
    [
      'a GET of sign overridden to POST signs, consuming the request token',
      (id) => send('GET', `${P}/${id}/sign?typedName=Jane%20Doe`, { override: 'POST' }),
      'esignature.requests.sign',
      (id) => expect.objectContaining({ request_id: id, state: 'SIGNED' }),
      (id) => [{ token: GOOD_TOKEN, context: id }],
    ],
    [
      'a POST of audit overridden to GET reads the chain without consuming its token',
      (id) => send('POST', `${P}/${id}/audit`, { override: 'GET', sub: AUDITOR_USER_ID, roles: AUDITOR }),
      'esignature.requests.audit',
      (id) => expect.objectContaining({ items: [expect.objectContaining({ request_id: id, seq: 1, action: 'created' })] }),
      () => [],
    ],
    [
      'a POST of verify overridden to GET verifies the stored chain without consuming its token',
      (id) => send('POST', `${P}/${id}/verify`, { override: 'GET' }),
      'esignature.requests.verify',
      () => ({ valid: true, entries: 1, brokenat: 0 }),
      () => [],
    ],
    [
      'a GET of verify overridden to POST verifies a supplied chain, consuming the request token',
      async (id) => {
        const entries = JSON.stringify(suppliedCopy(await auditItems(id)));
        return send('GET', `${P}/${id}/verify?${new URLSearchParams({ entries }).toString()}`, { override: 'POST' });
      },
      'esignature.requests.verify',
      () => ({ valid: true, entries: 1, brokenat: 0 }),
      (id) => [{ token: GOOD_TOKEN, context: id }],
    ],
  ])('answers %s, as api.cfm dispatches on the effective method', async (_case, request, method, data, tokens) => {
    const { request_id: id } = await createRequest();
    consumed.length = 0;
    const res = await request(id);
    expect([res.statusCode, res.json().method, res.json().data]).toEqual([200, method, data(id)]);
    expect(consumed).toEqual(tokens(id));
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('answers a raw %s as api.cfm does: the site, then the operation its override selects, else notFound', async (method) => {
    const { request_id: id } = await createRequest();
    consumed.length = 0;
    /** What `method` answers with: HEAD sends no body. */
    const sent = <T>(answer: T): T | '' => (method === 'HEAD' ? '' : answer);
    const dataOf = (answer: Answer): unknown => (answer.body === '' ? '' : JSON.parse(answer.body).data);

    const unknownSite = await sendOverSocket(method, `${P}?siteid=nosuch`);
    expect([unknownSite.statusCode, unknownSite.body]).toEqual([400, sent(errorBody('esignature.requests', 'invalid_request', 'Invalid parameters'))]);
    const unselected = await sendOverSocket(method, P);
    expect([unselected.statusCode, unselected.body]).toEqual([404, sent(errorBody('esignature.requests', 'invalid_request', 'Not Found'))]);
    const undispatched = await sendOverSocket(method, P, { override: 'PUT' });
    expect([undispatched.statusCode, undispatched.body]).toEqual([404, sent(errorBody('esignature.requests', 'invalid_request', 'Not Found'))]);
    const anonymous = await sendOverSocket(method, `${P}/${id}/sign?siteid=${TENANT_A.siteId}`, { override: 'post', anonymous: true });
    expect([anonymous.statusCode, anonymous.body]).toEqual([401, sent(errorBody('esignature.requests.sign', 'invalid_request', 'Insufficient Account Permissions'))]);

    const before = await send('GET', `${P}?itemsPerPage=1000`);
    const listed = await sendOverSocket(method, `${P}?itemsPerPage=1000`, { override: 'GET' });
    expect([listed.statusCode, listed.body, listed.headers.etag]).toEqual([200, sent(before.body), before.headers.etag]);
    expect(consumed).toEqual([]);

    const created = await sendOverSocket(method, `${P}?${new URLSearchParams(CREATE).toString()}`, { override: 'POST' });
    const signed = await sendOverSocket(method, `${P}/${id}/sign?typedName=Jane%20Doe`, { override: 'POST' });
    expect(consumed).toEqual([
      { token: GOOD_TOKEN, context: '' },
      { token: GOOD_TOKEN, context: id },
    ]);
    const known = new Set((before.json().data.items as Array<{ request_id: string }>).map((row) => row.request_id));
    const after = (await send('GET', `${P}?itemsPerPage=1000`)).json().data.items as Array<{ request_id: string; state: string; document_name: string }>;
    const added = after.filter((row) => !known.has(row.request_id));
    expect(added).toEqual([expect.objectContaining({ document_name: 'contract.pdf', state: 'PENDING' })]);
    expect([created.statusCode, dataOf(created)]).toEqual([200, sent(added[0])]);
    expect([signed.statusCode, dataOf(signed)]).toEqual([200, sent(after.find((row) => row.request_id === id))]);
    expect(after.find((row) => row.request_id === id)?.state).toBe('SIGNED');
  });

  it.each<[string, string, number, string, { type: string; text: string }]>([
    ['PUT', 'form', 404, 'Not Found', FORM_SITE],
    ['PATCH', 'form', 404, 'Not Found', FORM_SITE],
    ['DELETE', 'form', 404, 'Not Found', FORM_SITE],
    ['OPTIONS', 'form', 404, 'Not Found', FORM_SITE],
    ['PUT', 'multipart', 404, 'Not Found', MULTIPART_SITE],
    ['POST', 'form', 400, 'Invalid parameters', FORM_SITE],
    ['POST', 'multipart', 400, 'Invalid parameters', MULTIPART_SITE],
    ['PUT', 'JSON', 400, 'Invalid parameters', JSON_SITE],
    ['PATCH', 'JSON', 400, 'Invalid parameters', JSON_SITE],
    ['DELETE', 'JSON', 400, 'Invalid parameters', JSON_SITE],
    ['OPTIONS', 'JSON', 400, 'Invalid parameters', JSON_SITE],
  ])('reads the unknown site of a raw %s %s body only where ColdFusion scopes it, answering %i %s', async (method, _kind, status, message, body) => {
    const res = await sendOverSocket(method, P, { body });
    expect([res.statusCode, res.body]).toEqual([status, errorBody('esignature.requests', 'invalid_request', message)]);
  });

  it.each<[string, () => Promise<Injected>, number, string, string, string]>([
    ['no credential', () => sendAnonymous('GET', `${P}?siteid=${TENANT_A.siteId}`), 401, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
    ['site: no credential and no site, so the default this registry lacks', () => sendAnonymous('GET', P), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: no credential and an unknown query site', () => sendAnonymous('GET', `${P}?siteid=nosuch`), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: no credential and an unknown JSON body site', () => sendAnonymous('POST', P, { siteid: 'nosuch' }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: no credential and a non-simple JSON body site', () => sendAnonymous('POST', P, { siteid: { id: TENANT_A.siteId } }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['an anonymous session with its own site', () => send('GET', P, ANONYMOUS_SESSION), 401, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
    ['an anonymous session with another registered site', () => send('GET', `${P}?siteid=${TENANT_B.siteId}`, ANONYMOUS_SESSION), 401, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
    ['site: an anonymous session with an unknown query site', () => send('GET', `${P}?siteid=nosuch`, ANONYMOUS_SESSION), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: an anonymous session with an unknown JSON body site', () => send('POST', P, { ...ANONYMOUS_SESSION, payload: { siteid: 'nosuch' } }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: an anonymous session with a non-simple JSON body site', () => send('POST', P, { ...ANONYMOUS_SESSION, payload: { siteid: [TENANT_A.siteId] } }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: a member with an unknown query site', () => send('GET', `${P}?siteid=nosuch`, { roles: [Roles.member] }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: a member with an unknown JSON body site', () => send('POST', P, { roles: [Roles.member], payload: { siteid: 'nosuch' } }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: a member with a non-simple JSON body site', () => send('POST', P, { roles: [Roles.member], payload: { siteid: { id: TENANT_A.siteId } } }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: a signer with an unknown query site', () => send('GET', `${P}?siteid=nosuch`), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: a signer with an unknown JSON body site', () => send('POST', P, { payload: { ...CREATE, siteid: 'nosuch' } }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['a JSON body site of another registered tenant', () => send('POST', P, { payload: { ...CREATE, siteid: TENANT_B.siteId } }), 403, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
    ['site: an unknown site before an unknown override', () => send('POST', `${P}?siteid=nosuch`, { override: 'PUT' }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['path: an override naming PUT', () => send('POST', P, { override: 'PUT', payload: CREATE }), 404, 'esignature.requests', 'invalid_request', 'Not Found'],
    ['path: an override naming DELETE', () => send('GET', P, { override: 'DELETE' }), 404, 'esignature.requests', 'invalid_request', 'Not Found'],
    ['path: an anonymous GET of sign, before login', () => sendAnonymous('GET', `${P}/${MISSING_ID}/sign?siteid=${TENANT_A.siteId}`), 404, 'esignature.requests.sign', 'invalid_request', 'Not Found'],
    ['path: an anonymous POST of audit, before login', () => sendAnonymous('POST', `${P}/${MISSING_ID}/audit?siteid=${TENANT_A.siteId}`), 404, 'esignature.requests.audit', 'invalid_request', 'Not Found'],
    ['path: a member\'s override naming PUT, before the role', () => send('POST', `${P}/${MISSING_ID}/verify`, { roles: [Roles.member], override: 'PUT' }), 404, 'esignature.requests.verify', 'invalid_request', 'Not Found'],
    ['csrf: a GET overridden to POST without a token', () => send('GET', P, { override: 'POST', csrf: false }), 400, 'esignature.requests', 'invalid_request', 'Invalid CSRF tokens'],
    ['a member\'s GET overridden to POST, before the token', () => send('GET', P, { roles: [Roles.member], override: 'POST', csrf: false }), 403, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
    [
      'a rejected user token',
      async () => conforms(await app.inject({ url: P, headers: { ...(await userHeaders({ sub: SIGNER_USER_ID, roles: SIGNER })), authorization: 'Bearer not-a-token' } }), 'GET', P),
      401,
      'esignature.requests',
      'invalid_token',
      'Invalid Access Token',
    ],
    ['a member listing', () => send('GET', P, { roles: [Roles.member] }), 403, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
    ['an auditor creating', () => send('POST', P, { roles: AUDITOR, payload: CREATE }), 403, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
    ['a siteid other than the token site', () => send('GET', `${P}?siteid=${TENANT_B.siteId}`), 403, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
    ['a role-less user of an unregistered site', () => send('GET', P, { roles: [Roles.member], site: 'retired-site' }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['site: an unregistered token site', () => send('GET', P, { site: 'retired-site' }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['csrf: a create without a token', () => send('POST', P, { payload: CREATE, csrf: false }), 400, 'esignature.requests', 'invalid_request', 'Invalid CSRF tokens'],
    ['csrf: before validation', () => send('POST', P, { payload: {}, csrf: false }), 400, 'esignature.requests', 'invalid_request', 'Invalid CSRF tokens'],
    ['validation: an empty document name', () => send('POST', P, { payload: { ...CREATE, documentName: '' } }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['validation: an unknown signer', () => send('POST', P, { payload: { ...CREATE, signerUserId: MISSING_ID } }), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['validation: a zero page size', () => send('GET', `${P}?itemsPerPage=0`), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['validation: non-ASCII digits outside the bounds', () => send('GET', `${P}?itemsPerPage=%D9%A1`), 400, 'esignature.requests', 'invalid_request', 'Invalid parameters'],
    ['an unhandled exception', () => send('GET', `${P}?pageIndex=1%D9%A1`), 500, 'esignature.requests', 'server_error', 'Unhandled Exception'],
    ['existence: signing an unknown request', () => send('POST', `${P}/${MISSING_ID}/sign`, { payload: { typedName: '' } }), 404, 'esignature.requests.sign', 'invalid_request', 'Not Found'],
    ['existence: before paging', () => send('GET', `${P}/${MISSING_ID}/audit?pageIndex=0`), 404, 'esignature.requests.audit', 'invalid_request', 'Not Found'],
    ['existence: verifying an unknown request', () => send('GET', `${P}/${MISSING_ID}/verify`), 404, 'esignature.requests.verify', 'invalid_request', 'Not Found'],
    ['existence: before the supplied chain', () => send('POST', `${P}/${MISSING_ID}/verify`, { payload: { entries: 'x' } }), 404, 'esignature.requests.verify', 'invalid_request', 'Not Found'],
    ['csrf: a supplied chain without a token', () => send('POST', `${P}/${MISSING_ID}/verify`, { csrf: false }), 400, 'esignature.requests.verify', 'invalid_request', 'Invalid CSRF tokens'],
  ])('answers %s in the fixture error envelope', async (_case, request, status, method, code, message) => {
    const res = await request();
    expect([res.statusCode, res.body]).toEqual([status, errorBody(method, code, message)]);
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
  });

  it.each<[string, (id: string) => Promise<Injected>, number, string, string]>([
    ['a signer who is not the request signer', (id) => send('POST', `${P}/${id}/sign`, { sub: OTHER_USER_ID, payload: { typedName: 'Jane Doe' } }), 403, 'esignature.requests.sign', 'Insufficient Account Permissions'],
    ['a blank typed name', (id) => send('POST', `${P}/${id}/sign`, { payload: { typedName: ' \u200b' } }), 400, 'esignature.requests.sign', 'Invalid parameters'],
    ['another signer reading the audit', (id) => send('GET', `${P}/${id}/audit`, { sub: OTHER_USER_ID }), 403, 'esignature.requests.audit', 'Insufficient Account Permissions'],
    ['invalid paging of a readable audit', (id) => send('GET', `${P}/${id}/audit?itemsPerPage=1001`), 400, 'esignature.requests.audit', 'Invalid parameters'],
    ['another signer verifying', (id) => send('GET', `${P}/${id}/verify`, { sub: OTHER_USER_ID }), 403, 'esignature.requests.verify', 'Insufficient Account Permissions'],
    ['a supplied chain that is not an array', (id) => send('POST', `${P}/${id}/verify`, { payload: { entries: '{}' } }), 400, 'esignature.requests.verify', 'Invalid parameters'],
    ['a supplied entry with a malformed hash', (id) => send('POST', `${P}/${id}/verify`, { payload: { entries: [{ seq: '1', action: 'created', actor_user_id: '', detail: '', at: '2026-06-30T14:05:09.123', prev_hash: 'zz', entry_hash: 'zz' }] } }), 400, 'esignature.requests.verify', 'Invalid parameters'],
    ['another tenant reading the request', (id) => send('GET', `${P}/${id}/verify`, { site: TENANT_B.siteId }), 404, 'esignature.requests.verify', 'Not Found'],
    ['a GET of sign without an override', (id) => send('GET', `${P}/${id}/sign?typedName=Jane%20Doe`), 404, 'esignature.requests.sign', 'Not Found'],
    ['a sign overridden to GET', (id) => send('POST', `${P}/${id}/sign`, { override: 'GET', payload: { typedName: 'Jane Doe' } }), 404, 'esignature.requests.sign', 'Not Found'],
    ['a sign overridden to PUT', (id) => send('POST', `${P}/${id}/sign`, { override: 'PUT', payload: { typedName: 'Jane Doe' } }), 404, 'esignature.requests.sign', 'Not Found'],
    ['a sign overridden to DELETE', (id) => send('GET', `${P}/${id}/sign?typedName=Jane%20Doe`, { override: 'DELETE' }), 404, 'esignature.requests.sign', 'Not Found'],
  ])('answers %s, leaving the request PENDING', async (_case, request, status, method, message) => {
    const { request_id: id } = await createRequest();
    const res = await request(id);
    expect([res.statusCode, res.body]).toEqual([status, errorBody(method, status === 500 ? 'server_error' : 'invalid_request', message)]);
    const listed = (await send('GET', `${P}?itemsPerPage=1000`)).json().data.items as Array<{ request_id: string; state: string }>;
    expect(listed.find((row) => row.request_id === id)?.state).toBe('PENDING');
  });

  it('logs an unhandled exception once as a valid log record, and denials with their reason', async () => {
    const before = logLines.length;
    expect((await send('GET', `${P}?pageIndex=1%D9%A1`)).statusCode).toBe(500);
    expect((await sendAnonymous('GET', `${P}?siteid=${TENANT_A.siteId}`)).statusCode).toBe(401);
    expect((await app.inject({ url: P, headers: { authorization: 'Bearer not-a-token' } })).statusCode).toBe(401);
    expect((await send('GET', `${P}?siteid=${TENANT_B.siteId}`)).statusCode).toBe(403);
    const lines = logLines.slice(before).map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(lines.filter(({ message }) => message === 'unhandled fixture exception')).toHaveLength(1);
    expect(lines.filter(({ severity }) => severity === 'WARNING').map(({ message }) => message)).toEqual([
      'request denied: authorization',
      'request denied: invalid-credential',
      'request denied: site-mismatch',
    ]);
    for (const line of lines) expect(validateLogRecord(line).errors).toEqual([]);
  });

  it('answers the legacy 503 when people is unavailable, and forbidden when people denies the read', async () => {
    peopleMode = 'unavailable';
    const unavailable = await send('POST', P, { payload: CREATE });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().method).not.toBe('esignature.requests');
    peopleMode = 'denied';
    const denied = await send('POST', P, { payload: CREATE });
    expect([denied.statusCode, denied.body]).toEqual([403, errorBody('esignature.requests', 'invalid_request', 'Insufficient Account Permissions')]);
  });

  it('fails a write closed with the legacy 503 while the e-signature units are legacy-authoritative', async () => {
    const { request_id: id } = await createRequest();
    await setGates('legacy');
    const res = await send('POST', `${P}/${id}/sign`, { payload: { typedName: 'Jane Doe' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().method).not.toBe('esignature.requests.sign');
    await setGates('open');
    expect((await send('GET', `${P}/${id}/verify`)).json().data).toEqual({ valid: true, entries: 1, brokenat: 0 });
  });

  it('lists none of tenant-a\'s requests to an umbrella signer', async () => {
    const res = await send('GET', P, { site: TENANT_UMBRELLA.siteId });
    expect([res.statusCode, res.json().data.totalitems]).toEqual([200, 0]);
  });
});
