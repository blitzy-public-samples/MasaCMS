// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/esignature` routes through `app.inject` over a throwaway `esignature` schema, every answer checked against the contract. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles, collectRouteMatrix, hasAnyRole, type RouteMatrixEntry } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { GateClosedError, closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, assertResponseMatchesOpenApi, createThrowawaySchema, pgAvailable, seedRegistry, testVerifier, type ThrowawaySchema } from '@opt2/platform/testing';
import { getAuditChain, listRequests, verifyStored, type EsignatureActor } from '../../src/domain/signing.js';
import { PeopleReadDeniedError, type PeopleClient, type PersonSummary } from '../../src/legacy/people-client.js';
import { auditRow, requestRow, verifyResult, type FixtureAuditEntry, type FixtureRequest } from '../../src/legacy/serialize.js';
import { createEsignatureRepository } from '../../src/repo/repository.js';
import { OWNER, UNITS } from '../../src/repo/tables.js';
import { V1_PREFIX, registerV1Routes, type EsignatureV1Deps } from '../../src/routes/v1.js';
import { AUDITOR_USER_ID, OTHER_USER_ID, SIGNER_USER_ID, SUBJECTS, headersFor, userHeaders } from '../helpers/tokens.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };

interface ContractOperation {
  'x-opt2-transport'?: string;
  'x-opt2-requires'?: string[];
}

const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};

const REQUESTS = `${V1_PREFIX}/requests`;
const DOCUMENT_BASE64 = Buffer.from('%PDF-1.7 v1 route contract').toString('base64');
const NOW = new Date(2026, 5, 30, 9, 15, 0, 0);
const SIGNER_ROLES = [Roles.systemUser, Roles.esignatureSigner];
const AUDITOR_ROLES = [Roles.systemUser, Roles.esignatureAuditor];
const DENIED_USER_ID = 'A1B2C3D4-0000-0000-00000000000000DD';
const B_SIGNER_ID = 'A1B2C3D4-0000-0000-00000000000000B1';

/** A Type 2 user of the tenant-a or tenant-b site, as people's pool-user read returns it. */
const person = (userId: string, siteId: string = TENANT_A.siteId): PersonSummary => ({ userId, siteId, type: 2 });

/** People answering from the fixture users, refusing the read of DENIED_USER_ID. */
const people: PeopleClient = {
  readPerson: (_siteId, userId) => {
    if (userId.toUpperCase() === DENIED_USER_ID) return Promise.reject(new PeopleReadDeniedError(401, 'authorization'));
    const known = [person(SIGNER_USER_ID), person(OTHER_USER_ID), person(B_SIGNER_ID, TENANT_B.siteId)];
    return Promise.resolve(known.find((candidate) => candidate.userId === userId.toUpperCase()) ?? null);
  },
};

/** The contract's `/v1/` operations as route-matrix entries, with Fastify `:param` patterns. */
function contractV1Routes(): RouteMatrixEntry[] {
  return Object.entries(OPENAPI.paths)
    .filter(([path]) => path.startsWith('/v1/'))
    .flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([method, op]) => ({
          method: method.toUpperCase(),
          url: path.replace(/\{(\w+)\}/g, ':$1'),
          transport: op['x-opt2-transport'] as RouteMatrixEntry['transport'],
          requires: op['x-opt2-requires'],
          siteCheck: true,
        })),
    );
}

/** An e-signature app serving only the `/v1` routes over `deps`. */
async function v1App(deps: EsignatureV1Deps): Promise<FastifyInstance> {
  const app = await createService({
    name: OWNER,
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8120',
      OPT2_SERVICE_NAME: OWNER,
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier(OWNER),
    pool: deps.db,
    logger: createLogger({ service: OWNER, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  registerWritePositionHeader(app);
  await registerV1Routes(app, deps);
  await app.ready();
  return app;
}

interface Call {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  json?: unknown;
}

/** Injects one call and asserts its answer against the contract; returns the status, headers and parsed body. */
async function call(app: FastifyInstance, { method, url, headers, json }: Call) {
  const res = await app.inject({
    method,
    url,
    headers: json === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(json === undefined ? {} : { payload: JSON.stringify(json) }),
  });
  const path = url.split('?')[0] ?? url;
  const body = assertResponseMatchesOpenApi(OPENAPI, { method, path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return { status: res.statusCode, headers: res.headers, body: body as Record<string, unknown> };
}

/** A TenantDb whose every transaction rejects with `error`, for answers that must come before or instead of any query. */
function failingDb(error: () => Error): TenantDb {
  const reject = (): Promise<never> => Promise.reject(error());
  return { schema: 'esignature', withTenant: reject, withMetadata: reject, end: async () => undefined };
}

describe('esignature v1 routes without a database', () => {
  let gateClosed: FastifyInstance;
  let broken: FastifyInstance;

  beforeAll(async () => {
    const repository = createEsignatureRepository({ db: failingDb(() => new Error('unused')) });
    const base = { repository, clock: fixedClock(NOW), peopleClient: people };
    gateClosed = await v1App({ ...base, db: failingDb(() => new GateClosedError([...UNITS])) });
    broken = await v1App({ ...base, db: failingDb(() => new Error('connection refused')) });
  });

  afterAll(async () => {
    await gateClosed?.opt2.shutdown();
    await broken?.opt2.shutdown();
  });

  it('registers exactly the contract v1 operations with their transport and required roles', () => {
    const routes = collectRouteMatrix(gateClosed).routes.filter((route) => route.url.startsWith('/v1/'));
    const byKey = (a: RouteMatrixEntry, b: RouteMatrixEntry): number => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`);
    expect(routes.sort(byKey)).toEqual(contractV1Routes().sort(byKey));
  });

  it.each([
    ['GET', `${REQUESTS}`],
    ['POST', `${REQUESTS}/${cfUuid()}/sign`],
  ] as const)('answers %s %s on a closed gate with the legacy 503', async (method, url) => {
    const res = await call(gateClosed, {
      method,
      url,
      headers: await userHeaders({ sub: SIGNER_USER_ID, roles: SIGNER_ROLES }),
      json: method === 'POST' ? { typedName: 'Jane Doe' } : undefined,
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } });
  });

  it('leaves an unknown failure to the service-kit 500', async () => {
    const res = await call(broken, { method: 'GET', url: REQUESTS, headers: await userHeaders({ sub: SIGNER_USER_ID, roles: SIGNER_ROLES }) });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: { code: 'server_error', message: 'Unhandled Exception' } });
  });

  it.each(['/not-a-uuid', '/not-a-uuid/sign', '/not-a-uuid/audit', '/not-a-uuid/verify'])(
    'answers a malformed id at %s with invalidParameters before any query',
    async (suffix) => {
      const method = suffix.endsWith('/sign') ? 'POST' : 'GET';
      const res = await call(gateClosed, {
        method,
        url: `${REQUESTS}${suffix}`,
        headers: await userHeaders({ sub: AUDITOR_USER_ID, roles: [...SIGNER_ROLES, Roles.esignatureAuditor] }),
        json: method === 'POST' ? { typedName: 'Jane Doe' } : undefined,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({ code: 'invalid_request', message: 'Invalid parameters' });
    },
  );
});

const available = await pgAvailable();

describe.skipIf(!available)('esignature v1 routes against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let deps: EsignatureV1Deps;
  let app: FastifyInstance;
  let signer: Record<string, string>;
  let creator: Record<string, string>;
  let auditor: Record<string, string>;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'e-signature',
      schemaName: 'esignature',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'v1-routes-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'v1-routes-test', state: 'open' });
    await seedRegistry(handle.app);
    const clock = fixedClock(NOW);
    deps = { repository: createEsignatureRepository({ db: handle.app, clock }), clock, peopleClient: people, db: handle.app };
    app = await v1App(deps);
    [signer, creator, auditor] = await Promise.all([
      userHeaders({ sub: SIGNER_USER_ID, roles: SIGNER_ROLES }),
      userHeaders({ sub: OTHER_USER_ID, roles: SIGNER_ROLES }),
      userHeaders({ sub: AUDITOR_USER_ID, roles: AUDITOR_ROLES }),
    ]);
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  /** Creates a PENDING request for SIGNER as the creator and returns its body. */
  async function create(): Promise<FixtureRequest> {
    const res = await call(app, {
      method: 'POST',
      url: REQUESTS,
      headers: creator,
      json: { documentName: 'contract.pdf', documentBase64: DOCUMENT_BASE64, signerUserId: SIGNER_USER_ID.toLowerCase() },
    });
    expect(res.status).toBe(200);
    return res.body as unknown as FixtureRequest;
  }

  /** The tenant-a domain actor of the auditor, for reading what the routes answer straight from the domain. */
  const auditorActor: EsignatureActor = { userId: AUDITOR_USER_ID, siteId: TENANT_A.siteId, roles: AUDITOR_ROLES };

  it('creates, signs, audits and verifies one request end to end', async () => {
    const created = await create();
    expect(created).toMatchObject({ siteid: TENANT_A.siteId, signer_user_id: SIGNER_USER_ID, createdbyid: OTHER_USER_ID, state: 'PENDING' });
    const id = created.request_id;

    const pending = await call(app, { method: 'GET', url: `${REQUESTS}/${id}`, headers: signer });
    expect(pending.body).toEqual({ ...created, signature: null });

    const signed = await call(app, { method: 'POST', url: `${REQUESTS}/${id}/sign`, headers: signer, json: { typedName: 'Jane Doe' } });
    expect(signed.status).toBe(200);
    expect(signed.headers['x-opt2-write-position']).toMatch(/^e-signature=\d+$/);
    expect(signed.body).toEqual({ ...created, state: 'SIGNED' });

    const detail = await call(app, { method: 'GET', url: `${REQUESTS}/${id}`, headers: auditor });
    expect(detail.body.signature).toMatchObject({ request_id: id, typed_name: 'Jane Doe', signer_user_id: SIGNER_USER_ID });

    const audit = await call(app, { method: 'GET', url: `${REQUESTS}/${id}/audit`, headers: auditor });
    const items = audit.body.items as FixtureAuditEntry[];
    expect(items.map((entry) => [entry.seq, entry.action, entry.detail])).toEqual([
      [1, 'created', created.document_sha256],
      [2, 'signed', 'Jane Doe'],
    ]);
    expect(audit.body).toMatchObject({ startindex: 1, endindex: 2, itemsperpage: 50, totalitems: 2, totalpages: 1, pageindex: 1 });

    const stored = await call(app, { method: 'GET', url: `${REQUESTS}/${id}/verify`, headers: auditor });
    expect(stored.body).toEqual({ valid: true, entries: 2, brokenat: 0 });
    const supplied = await call(app, { method: 'POST', url: `${REQUESTS}/${id}/verify`, headers: signer, json: { entries: items } });
    expect(supplied.body).toEqual({ valid: true, entries: 2, brokenat: 0 });
    const tampered = items.map((entry) => (entry.seq === 2 ? { ...entry, detail: 'John Roe' } : entry));
    const broken = await call(app, { method: 'POST', url: `${REQUESTS}/${id}/verify`, headers: auditor, json: { entries: JSON.stringify(tampered) } });
    expect(broken.body).toEqual({ valid: false, entries: 2, brokenat: 2 });
  });

  it('answers what the shared domain functions and fixture projections give for the same request', async () => {
    const { request_id: id } = await create();
    const paging = { pageIndex: 1, itemsPerPage: 1000 };
    const direct = await withTenant(handle.app, TENANT_A.tenantId, async (tx) => ({
      list: (await listRequests(tx, paging)).rows.map(requestRow),
      audit: (await getAuditChain(tx, id, paging, auditorActor)).rows.map(auditRow),
      verify: verifyResult(await verifyStored(tx, id, auditorActor)),
    }));
    const list = await call(app, { method: 'GET', url: `${REQUESTS}?itemsPerPage=1000`, headers: signer });
    const audit = await call(app, { method: 'GET', url: `${REQUESTS}/${id}/audit?itemsPerPage=1000`, headers: auditor });
    const verify = await call(app, { method: 'GET', url: `${REQUESTS}/${id}/verify`, headers: auditor });
    expect(list.body.items).toEqual(direct.list);
    expect(audit.body.items).toEqual(direct.audit);
    expect(verify.body).toEqual(direct.verify);
  });

  it('refuses a second signature with conflict already-signed', async () => {
    const { request_id: id } = await create();
    await call(app, { method: 'POST', url: `${REQUESTS}/${id}/sign`, headers: signer, json: { typedName: 'Jane Doe' } });
    const again = await call(app, { method: 'POST', url: `${REQUESTS}/${id}/sign`, headers: signer, json: { typedName: 'Jane Doe' } });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ apiversion: 'v1', method: 'esignature.requests.sign', error: { code: 'invalid_request', message: 'already-signed' } });
  });

  it.each([
    ['GET', ''],
    ['POST', '/sign'],
    ['GET', '/audit'],
    ['GET', '/verify'],
    ['POST', '/verify'],
  ] as const)('answers %s on a missing request%s with notFound', async (method, suffix) => {
    const json = suffix === '/sign' ? { typedName: 'Jane Doe' } : method === 'POST' ? { entries: [] } : undefined;
    const res = await call(app, { method, url: `${REQUESTS}/${cfUuid()}${suffix}`, headers: signer, json });
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'invalid_request', message: 'Not Found' });
  });

  it('refuses a signer reading or signing a request addressed to another user', async () => {
    const { request_id: id } = await create();
    const read = await call(app, { method: 'GET', url: `${REQUESTS}/${id}`, headers: creator });
    const sign = await call(app, { method: 'POST', url: `${REQUESTS}/${id}/sign`, headers: creator, json: { typedName: 'Jane Doe' } });
    for (const res of [read, sign]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toEqual({ code: 'invalid_request', message: 'Insufficient Account Permissions' });
    }
  });

  it.each([
    ['a missing document name', { documentBase64: DOCUMENT_BASE64, signerUserId: SIGNER_USER_ID }, 400],
    ['an undecodable document', { documentName: 'a.pdf', documentBase64: '***', signerUserId: SIGNER_USER_ID }, 400],
    ['a signer outside the user pools', { documentName: 'a.pdf', documentBase64: DOCUMENT_BASE64, signerUserId: cfUuid() }, 400],
    ['a signer people refuses to read', { documentName: 'a.pdf', documentBase64: DOCUMENT_BASE64, signerUserId: DENIED_USER_ID }, 403],
  ])('refuses a create with %s', async (_name, json, status) => {
    const res = await call(app, { method: 'POST', url: REQUESTS, headers: creator, json });
    expect(res.status).toBe(status);
    expect(res.body.method).toBe('esignature.requests');
  });

  it.each([
    ['entries that are not an array', { entries: { seq: 1 } }],
    ['an entry with a malformed hash', { entries: [{ seq: 1, action: 'created', actor_user_id: '', detail: '', at: '2026-06-30T09:15:00.000', prev_hash: 'x', entry_hash: 'y' }] }],
  ])('refuses a supplied chain with %s', async (_name, json) => {
    const { request_id: id } = await create();
    const res = await call(app, { method: 'POST', url: `${REQUESTS}/${id}/verify`, headers: auditor, json });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ method: 'esignature.requests.verify', error: { message: 'Invalid parameters' } });
  });

  it.each(['pageIndex=0', 'itemsPerPage=1001', 'itemsPerPage=0', 'pageIndex=first'])('refuses the paging %s', async (query) => {
    const res = await call(app, { method: 'GET', url: `${REQUESTS}?${query}`, headers: signer });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ method: 'esignature.requests', error: { code: 'invalid_request' } });
  });

  it('pages the list in creation order and answers an empty page past the end', async () => {
    await create();
    await create();
    const first = await call(app, { method: 'GET', url: `${REQUESTS}?pageIndex=1&itemsPerPage=1`, headers: signer });
    expect(first.body).toMatchObject({ startindex: 1, endindex: 1, itemsperpage: 1, pageindex: 1 });
    expect(first.body.items).toHaveLength(1);
    const total = first.body.totalitems as number;
    const past = await call(app, { method: 'GET', url: `${REQUESTS}?pageIndex=${String(total + 1)}&itemsPerPage=1`, headers: signer });
    expect(past.body).toMatchObject({ items: [], startindex: total + 1, endindex: total, totalitems: total, totalpages: total });
  });

  it('shows another tenant none of tenant-a requests', async () => {
    const { request_id: id } = await create();
    const other = await userHeaders({ sub: B_SIGNER_ID, site: TENANT_B.siteId, roles: [...SIGNER_ROLES, Roles.esignatureAuditor] });
    const list = await call(app, { method: 'GET', url: REQUESTS, headers: other });
    expect((list.body.items as FixtureRequest[]).some((row) => row.siteid === TENANT_A.siteId)).toBe(false);
    for (const suffix of ['', '/audit', '/verify']) {
      const res = await call(app, { method: 'GET', url: `${REQUESTS}/${id}${suffix}`, headers: other });
      expect(res.status).toBe(404);
    }
  });

  it('answers a siteid other than the token site with the platform 403', async () => {
    const res = await call(app, { method: 'GET', url: `${REQUESTS}?siteid=${TENANT_B.siteId}`, headers: signer });
    expect(res.status).toBe(403);
  });

  it('allows exactly the subjects holding a required role on every v1 route', async () => {
    const missing = cfUuid();
    const unexpected: string[] = [];
    for (const route of contractV1Routes()) {
      const url = route.url.replace(':id', missing);
      for (const subject of SUBJECTS) {
        const res = await call(app, { method: route.method as Call['method'], url, headers: await headersFor(subject), json: route.method === 'POST' ? {} : undefined });
        const allowed = subject.kind === 'user' && !subject.crossTenant && hasAnyRole(subject.roles, route.requires ?? []);
        const denied = res.status === 401 || res.status === 403;
        if (allowed === denied) unexpected.push(`${route.method} ${route.url} ${subject.name} -> ${String(res.status)}`);
      }
    }
    expect(unexpected).toEqual([]);
  });
});
