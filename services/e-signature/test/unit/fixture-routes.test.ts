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
import { Roles, collectRouteMatrix } from '@opt2/platform/auth';
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

/** People's answer to every read: a person, an outage or a denial. */
type PeopleMode = 'answer' | 'unavailable' | 'denied';

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const { load } = createRequire(createRequire(import.meta.url).resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const CONTRACT = load(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

/** Asserts that `res`, the answer to `method` on `url`, is a response the contract declares for that operation; returns `res`. */
function conforms(res: Injected, method: string, url: string): Injected {
  const { pathname } = new URL(url, 'http://e-signature.test');
  assertResponseMatchesOpenApi(CONTRACT, { method, path: pathname, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** A Type 2 people `user` of `siteId`. */
const person = (userId: string, siteId: string = TENANT_A.siteId): PersonSummary => ({
  userId,
  siteId,
  type: 2,
  fname: 'Synthetic',
  lname: 'Signer',
  email: 'signer@example.test',
  inactive: 0,
});

/** The fixture error envelope of `method` with `code` and `message`. */
const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

const available = await pgAvailable();

describe.skipIf(!available)('e-signature fixture routes', () => {
  let handle: ThrowawaySchema;
  let identity: http.Server;
  let stateDir: string;
  let app: FastifyInstance;
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
    await app.ready();
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

  /** Sends `method` to `url` as user `sub` holding `roles` on `site`, with a valid CSRF token on a POST unless `csrf` is false. */
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
    }: { sub?: string; roles?: readonly string[]; site?: string; payload?: Record<string, unknown>; csrf?: boolean; contract?: boolean } = {},
  ): Promise<Injected> {
    const headers = { ...(await userHeaders({ sub, site, roles })), ...(method === 'POST' && csrf ? CSRF : {}) };
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    return contract ? conforms(res, method, url) : res;
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

  it('declares the six contract routes with the fixture role sets on the service transport, site-checked', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith(FIXTURE_PREFIX));
    expect(routes.map(({ method, url, requires, transport, siteCheck }) => [method, url.slice(FIXTURE_PREFIX.length), requires, transport, siteCheck])).toEqual([
      ['GET', '/requests', [Roles.esignatureSigner], 'service', true],
      ['POST', '/requests', [Roles.esignatureSigner], 'service', true],
      ['GET', '/requests/:id/audit', READERS, 'service', true],
      ['POST', '/requests/:id/sign', [Roles.esignatureSigner], 'service', true],
      ['GET', '/requests/:id/verify', READERS, 'service', true],
      ['POST', '/requests/:id/verify', READERS, 'service', true],
    ]);
    expect(FIXTURE_OPERATIONS.map(({ operationId }) => operationId)).toEqual([
      'fixtureListRequests',
      'fixtureCreateRequest',
      'fixtureSignRequest',
      'fixtureGetAudit',
      'fixtureVerifyStored',
      'fixtureVerifySupplied',
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

  it.each<[string, () => Promise<Injected>, number, string, string, string]>([
    ['no credential', async () => conforms(await app.inject({ url: P }), 'GET', P), 401, 'esignature.requests', 'invalid_request', 'Insufficient Account Permissions'],
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
    expect((await app.inject({ url: P })).statusCode).toBe(401);
    const lines = logLines.slice(before).map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(lines.filter(({ message }) => message === 'unhandled fixture exception')).toHaveLength(1);
    expect(lines.filter(({ severity }) => severity === 'WARNING').map(({ message }) => message)).toEqual(['request denied: missing-credential']);
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
