// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Tenant isolation of the esignature schema, its repository writes, its fixture and /v1 read routes and its site registry consumer against PostgreSQL. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { qualified } from '@opt2/platform/migration-kit';
import { SITE_CHANGED_TOPIC, createPool, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  checkCatalog,
  createCapturingPublisher,
  createThrowawaySchema,
  defineIsolationSuite,
  expectPlatformTables,
  pgAvailable,
  registryPayloads,
  testEnvelope,
  testPgConfig,
  type InjectResponse,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { nextEntry } from '../../src/domain/hash-chain.js';
import { AUDIT_ACTIONS } from '../../src/domain/signing.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FIXTURE_ERROR_MAP, fixtureMethod } from '../../src/legacy/envelope.js';
import { createEsignatureRepository, type EsignatureRepository } from '../../src/repo/repository.js';
import {
  AUDIT_ENTRY,
  EXTEND_ATTRIBUTE,
  EXTEND_DATA,
  EXTEND_RC_SET,
  EXTEND_SET,
  EXTEND_SUBTYPE,
  OWNED_TABLES,
  SIGNATURE,
  SIGNATURE_REQUEST,
  TRASH,
  type AuditEntryRow,
  type SignatureRequestRow,
  type SignatureRow,
} from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { V1_PREFIX } from '../../src/routes/v1.js';
import { TEST_CLOCK, buildDbApp, headersFor, type TestApp } from '../helpers/app.js';
import { AUDITOR_USER_ID, SIGNER_USER_ID } from '../helpers/tokens.js';

type Row = Record<string, unknown>;
type NewRequestRow = Omit<SignatureRequestRow, 'row_version'>;
type NewSignatureRow = Omit<SignatureRow, 'row_version'>;
type NewAuditRow = Omit<AuditEntryRow, 'row_version'>;

/** One page of requests as the /v1 list answers it and the fixture list carries it in `data`. */
interface RequestPageBody {
  items: Array<{ request_id: string }>;
  totalitems: number;
}

/** The requests seeded for one tenant before the route cases. */
interface SeededRequests {
  pending: string;
  signed: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const TABLES: readonly string[] = OWNED_TABLES.map(({ table }) => table);
// E-signature schedules no tasks, so its migrations create no task queue tables.
const PLATFORM_GROUPS: readonly PlatformTableGroup[] = ['tenancy', 'migrationKit', 'events', 'outbox'];
const SIGNER = 'esignature.signer';
const AUDITOR = 'esignature.auditor';
const V1_REQUESTS = `${V1_PREFIX}/requests`;
const FIXTURE_REQUESTS = `${FIXTURE_PREFIX}/requests`;
const WHOLE_PAGE = 'itemsPerPage=1000';
const DOCUMENT = Buffer.from('%PDF-1.4 e-signature isolation');
const DOCUMENT_SHA256 = createHash('sha256').update(DOCUMENT).digest('hex');
const NOT_FOUND = FIXTURE_ERROR_MAP.notFound;
const FORBIDDEN = FIXTURE_ERROR_MAP.forbidden;

const RLS_FLAGS_SQL = `
SELECT c.relname::text AS relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
 ORDER BY c.relname`;

const available = await pgAvailable();
const publisher = createCapturingPublisher();

let schema: ThrowawaySchema | undefined;
let service: TestApp<TenantDb> | undefined;
let repository: EsignatureRepository | undefined;
let legacyIdentities = 0;

/** What the outer beforeAll built; throws when building it failed. */
function built(): { schema: ThrowawaySchema; service: TestApp<TenantDb>; repository: EsignatureRepository } {
  if (schema === undefined || service === undefined || repository === undefined) {
    throw new Error('The throwaway esignature schema or app was not built; see the beforeAll failure');
  }
  return { schema, service, repository };
}

/** Document name of every request written for `tenant`, so a response body can be searched for its data. */
function documentNameOf(tenant: TenantFixture): string {
  return `isolation ${tenant.siteId}.pdf`;
}

function typedNameOf(tenant: TenantFixture): string {
  return `Signer of ${tenant.siteId}`;
}

/** A fresh request of `tenant` created at the test clock; PENDING unless `overrides` says otherwise. */
function requestRowFor(tenant: TenantFixture, overrides: Partial<NewRequestRow> = {}): NewRequestRow {
  return {
    tenant_id: tenant.tenantId,
    request_id: cfUuid(),
    siteid: tenant.siteId,
    document_name: documentNameOf(tenant),
    document_sha256: DOCUMENT_SHA256,
    document: DOCUMENT,
    signer_user_id: SIGNER_USER_ID,
    state: 'PENDING',
    created: TEST_CLOCK.now(),
    createdbyid: AUDITOR_USER_ID,
    ...overrides,
  };
}

/** The typed-name signature of `requestId` in `tenant`. */
function signatureRowFor(tenant: TenantFixture, requestId: string): NewSignatureRow {
  return {
    tenant_id: tenant.tenantId,
    signature_id: cfUuid(),
    request_id: requestId,
    typed_name: typedNameOf(tenant),
    signer_user_id: SIGNER_USER_ID,
    signed_at: TEST_CLOCK.now(),
  };
}

/** The audit entry of `requestId` appended after `last`: `created` first, then `signed`, hash-chained as the append procedure chains it. */
function auditRowAfter(tenant: TenantFixture, requestId: string, last: NewAuditRow | null): NewAuditRow {
  const [action, detail] = last === null ? [AUDIT_ACTIONS.created, DOCUMENT_SHA256] : [AUDIT_ACTIONS.signed, typedNameOf(tenant)];
  const next = nextEntry(last, { requestId, action, actorUserId: SIGNER_USER_ID, detail, at: TEST_CLOCK.now() });
  return {
    tenant_id: tenant.tenantId,
    entry_id: cfUuid(),
    request_id: requestId,
    seq: next.seq,
    action,
    actor_user_id: SIGNER_USER_ID,
    detail,
    at: next.at,
    prev_hash: next.prev_hash,
    entry_hash: next.entry_hash,
  };
}

/** The first `n` chained audit entries of `requestId` in `tenant`. */
function auditRowsFor(tenant: TenantFixture, requestId: string, n: number): NewAuditRow[] {
  const rows: NewAuditRow[] = [];
  while (rows.length < n) rows.push(auditRowAfter(tenant, requestId, rows.at(-1) ?? null));
  return rows;
}

/** A legacy integer identity (`attributeid`, `dataid`) no earlier call used, so every row meets its primary key. */
function nextIdentity(): number {
  legacyIdentities += 1;
  return legacyIdentities;
}

/** A fresh row of the unit table `table` for `tenant` that meets every constraint of the table. */
function rowFor(table: string, tenant: TenantFixture): Row {
  const siteid = tenant.siteId;
  switch (table) {
    case SIGNATURE_REQUEST.table:
      return requestRowFor(tenant);
    case SIGNATURE.table:
      return signatureRowFor(tenant, cfUuid());
    case AUDIT_ENTRY.table:
      return auditRowAfter(tenant, cfUuid(), null);
    case EXTEND_SUBTYPE.table:
      return { subtypeid: cfUuid(), siteid, basetable: 'synthetic.signature_request', type: 'SignatureRequest', subtype: 'Default', isactive: 1 };
    case EXTEND_SET.table:
      return { extendsetid: cfUuid(), subtypeid: cfUuid(), siteid, name: 'Default', orderno: 1, isactive: 1 };
    case EXTEND_ATTRIBUTE.table:
      return { attributeid: nextIdentity(), extendsetid: cfUuid(), siteid, name: 'witness', type: 'TextBox', isactive: 1 };
    case EXTEND_RC_SET.table:
      return { subtypeid: cfUuid(), siteid, name: 'Related', orderno: 1, relatedcontentsetid: cfUuid() };
    case EXTEND_DATA.table:
      return { dataid: nextIdentity(), baseid: cfUuid(), attributeid: nextIdentity(), siteid, attributevalue: 'W-1', numericvalue: 1.5 };
    case TRASH.table:
      return {
        objectid: cfUuid(),
        parentid: cfUuid(),
        siteid,
        objectlabel: 'Signature request',
        objectclass: 'extendObject',
        objecttype: 'synthetic.signature_request',
        objectsubtype: 'Default',
        objectstring: '<wddxPacket version="1.0"/>',
        deletedby: 'admin',
      };
    default:
      throw new TypeError(`e-signature has no unit table ${table}`);
  }
}

/** Writes a fresh row of `table` for `tenant` through the e-signature repository, a signature or audit entry after its parent request. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const repo = built().repository;
  const row = rowFor(table, tenant);
  if (table === SIGNATURE.table || table === AUDIT_ENTRY.table) {
    await repo.insertRequest(tx, requestRowFor(tenant, { request_id: String(row.request_id) }));
  }
  await repo.insert(tx, table, row);
}

/** Every row of `table` visible in `tx`; RLS is the only filter. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM ${qualified(tx.schema, table)}`)).rows;
}

/** A contract-valid site.changed envelope of the tenant-a site under `tenantId`. */
function siteChanged(tenantId: string) {
  const payload = registryPayloads().find(({ siteId }) => siteId === TENANT_A.siteId);
  if (payload === undefined) throw new Error('registryPayloads() has no tenant-a site');
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId, aggregateId: TENANT_A.siteId, payload });
}

/** One PENDING request with its `created` entry and one SIGNED request with its signature and two-entry chain, in `tenant`. */
async function seedRequests(tenant: TenantFixture): Promise<SeededRequests> {
  const { schema: db, repository: repo } = built();
  return withTenant(db.app, tenant.tenantId, async (tx) => {
    const pending = requestRowFor(tenant);
    const signed = requestRowFor(tenant, { state: 'SIGNED' });
    await repo.insertRequest(tx, pending);
    await repo.insertRequest(tx, signed);
    await repo.insertSignature(tx, signatureRowFor(tenant, signed.request_id));
    const entries = [...auditRowsFor(tenant, pending.request_id, 1), ...auditRowsFor(tenant, signed.request_id, 2)];
    for (const entry of entries) await repo.insertAuditEntry(tx, entry);
    return { pending: pending.request_id, signed: signed.request_id };
  });
}

/** Request ids stored under `tenant`, read under its RLS, sorted. */
async function storedRequestIds(tenant: TenantFixture): Promise<string[]> {
  const rows = await withTenant(built().schema.app, tenant.tenantId, (tx) => readAs(tx, SIGNATURE_REQUEST.table));
  return rows.map((row) => (row as SignatureRequestRow).request_id).sort();
}

/** Stored request ids and data markers of `tenants` that occur in `body`. */
async function leakedFrom(tenants: readonly TenantFixture[], body: string): Promise<string[]> {
  const leaked: string[] = [];
  for (const tenant of tenants) {
    const markers = [...(await storedRequestIds(tenant)), documentNameOf(tenant), typedNameOf(tenant)];
    leaked.push(...markers.filter((marker) => body.includes(marker)));
  }
  return leaked;
}

/** GETs `url` as the ROLE_SET subject `subject` holding a token for `tenant`'s site. */
async function get(url: string, subject: string, tenant: TenantFixture): Promise<InjectResponse> {
  const headers = await headersFor(subject, { site: tenant.siteId });
  return built().service.app.inject({ method: 'GET', url, headers });
}

/** Status and envelope of an answer, without its echoed params. */
function answerOf(res: InjectResponse): Row {
  const body = res.json<Row>();
  return { status: res.statusCode, apiversion: body.apiversion, method: body.method, error: body.error, data: body.data };
}

function listedIds(page: RequestPageBody): string[] {
  return page.items.map((item) => item.request_id).sort();
}

describe.skipIf(!available)('e-signature tenant isolation', () => {
  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'e-signature', schemaName: 'esignature', migrationsDir: MIGRATIONS_DIR });
    // buildDbApp registers the fixture sites and opens every unit gate, which the repository writes below need.
    service = await buildDbApp(schema, { publisher });
    repository = createEsignatureRepository({ db: schema.app, clock: TEST_CLOCK });
  });

  afterAll(async () => {
    try {
      await service?.app.close();
    } finally {
      await schema?.drop();
    }
    if (schema === undefined) return;
    const dropped = { schema: schema.schema, roles: Object.values(schema.roles) };
    const pg = testPgConfig();
    const probe = await createPool({
      env: { OPT2_DB_AUTH: 'password', PG_HOST: pg.host, PG_PORT: pg.port, PG_DATABASE: pg.database, PG_USER: pg.user, PG_PASSWORD: pg.password },
      schema: 'public',
      max: 1,
    });
    try {
      const left = await probe.withMetadata(async (tx) => ({
        schemas: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1', [dropped.schema])).rows[0]?.n,
        roles: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1::text[])', [dropped.roles])).rows[0]?.n,
      }));
      expect(left, `objects of ${dropped.schema} left after drop`).toEqual({ schemas: 0, roles: 0 });
    } finally {
      await probe.end();
    }
  });

  describe('catalog', () => {
    it('every e-signature unit table exists with RLS enabled and forced with USING and WITH CHECK, and no role can bypass it', async () => {
      const db = built().schema;
      expect(await checkCatalog(db)).toEqual([]);
      const { rows } = await db.adminPool.query(RLS_FLAGS_SQL, [db.schema, [...TABLES]]);
      expect(rows).toEqual([...TABLES].sort().map((relname) => ({ relname, enabled: true, forced: true })));
    });

    it('carries the tenancy, migration-kit, events and outbox platform tables with RLS forced on the tenant-owned ones', async () => {
      await expectPlatformTables(built().schema, { groups: PLATFORM_GROUPS });
    });
  });

  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => schema,
      name: 'e-signature unit tables',
      tables: TABLES,
      writeAs,
      readAs,
      rowFor,
      event: { app: () => service?.app, subscription: SITE_CHANGED_SUBSCRIPTION, envelopeFor: siteChanged, publisher },
    },
  );

  describe('read routes take the tenant from the token only', () => {
    const seeded = new Map<TenantFixture, SeededRequests>();
    const MISSING_ID = cfUuid();

    /** The requests seeded for `tenant`; throws when the seeding beforeAll failed. */
    function seededOf(tenant: TenantFixture): SeededRequests {
      const requests = seeded.get(tenant);
      if (requests === undefined) throw new Error(`No requests were seeded for tenant ${tenant.key}; see the beforeAll failure`);
      return requests;
    }

    beforeAll(async () => {
      for (const tenant of [TENANT_A, TENANT_B, TENANT_UMBRELLA]) seeded.set(tenant, await seedRequests(tenant));
    });

    it.each([
      { reader: TENANT_B, other: TENANT_A },
      { reader: TENANT_A, other: TENANT_B },
    ])('a tenant $reader.key signer lists only tenant $reader.key requests, none of tenant $other.key or umbrella, on /v1 and the fixture list', async ({ reader, other }) => {
      const others = [other, TENANT_UMBRELLA];
      const own = await storedRequestIds(reader);
      const v1 = await get(`${V1_REQUESTS}?${WHOLE_PAGE}`, SIGNER, reader);
      const fixture = await get(`${FIXTURE_REQUESTS}?siteid=${reader.siteId}&${WHOLE_PAGE}`, SIGNER, reader);
      const envelope = fixture.json<{ apiversion: string; method: string; data: RequestPageBody }>();

      expect(own).toEqual(expect.arrayContaining([seededOf(reader).pending, seededOf(reader).signed]));
      expect([v1.statusCode, fixture.statusCode]).toEqual([200, 200]);
      expect(listedIds(v1.json<RequestPageBody>())).toEqual(own);
      expect([envelope.apiversion, envelope.method, envelope.data.totalitems]).toEqual(['v1', fixtureMethod('requests'), own.length]);
      expect(listedIds(envelope.data)).toEqual(own);
      expect(await leakedFrom(others, v1.body), 'other tenants in the /v1 list').toEqual([]);
      expect(await leakedFrom(others, fixture.body), 'other tenants in the fixture list').toEqual([]);
    });

    it('a tenant A auditor reads its own request, audit chain and valid verdict on /v1 and the fixture routes', async () => {
      const { signed } = seededOf(TENANT_A);
      const site = `siteid=${TENANT_A.siteId}`;
      const detail = await get(`${V1_REQUESTS}/${signed}`, AUDITOR, TENANT_A);
      const audits = [
        await get(`${V1_REQUESTS}/${signed}/audit`, AUDITOR, TENANT_A),
        await get(`${FIXTURE_REQUESTS}/${signed}/audit?${site}`, AUDITOR, TENANT_A),
      ];
      const verdicts = [
        await get(`${V1_REQUESTS}/${signed}/verify`, AUDITOR, TENANT_A),
        await get(`${FIXTURE_REQUESTS}/${signed}/verify?${site}`, AUDITOR, TENANT_A),
      ];

      expect([detail, ...audits, ...verdicts].map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(detail.json()).toMatchObject({ request_id: signed, state: 'SIGNED', signature: { request_id: signed } });
      const [v1Audit, fixtureAudit] = audits.map((res) => res.json<{ items?: unknown[]; data?: { items: unknown[] } }>());
      expect(v1Audit?.items).toMatchObject([{ request_id: signed, seq: 1 }, { request_id: signed, seq: 2 }]);
      expect(fixtureAudit?.data?.items).toEqual(v1Audit?.items);
      const [v1Verdict, fixtureVerdict] = verdicts.map((res) => res.json<{ valid?: boolean; data?: unknown }>());
      expect(v1Verdict).toEqual({ valid: true, entries: 2, brokenat: 0 });
      expect(fixtureVerdict?.data).toEqual(v1Verdict);
    });

    it.each([
      { route: '/v1 requests/{id}', path: `${V1_REQUESTS}/:id`, method: fixtureMethod('requests') },
      { route: '/v1 requests/{id}/audit', path: `${V1_REQUESTS}/:id/audit`, method: fixtureMethod('requests', 'audit') },
      { route: '/v1 requests/{id}/verify', path: `${V1_REQUESTS}/:id/verify`, method: fixtureMethod('requests', 'verify') },
      { route: 'fixture requests/{id}/audit', path: `${FIXTURE_REQUESTS}/:id/audit?siteid=:site`, method: fixtureMethod('requests', 'audit') },
      { route: 'fixture requests/{id}/verify', path: `${FIXTURE_REQUESTS}/:id/verify?siteid=:site`, method: fixtureMethod('requests', 'verify') },
    ])('a tenant B auditor gets the never-stored notFound answer for a tenant A request on $route', async ({ path, method }) => {
      const url = (id: string, tenant: TenantFixture): string => path.replace(':id', id).replace(':site', tenant.siteId);
      const { signed } = seededOf(TENANT_A);
      const control = await get(url(signed, TENANT_A), AUDITOR, TENANT_A);
      const foreign = await get(url(signed, TENANT_B), AUDITOR, TENANT_B);
      const missing = await get(url(MISSING_ID, TENANT_B), AUDITOR, TENANT_B);

      expect(control.statusCode, 'the same subject on tenant A').toBe(200);
      expect(answerOf(foreign)).toEqual({
        status: NOT_FOUND.status,
        apiversion: 'v1',
        method,
        error: { code: NOT_FOUND.code, message: NOT_FOUND.message },
        data: undefined,
      });
      expect(answerOf(foreign)).toEqual(answerOf(missing));
      expect(await leakedFrom([TENANT_A], foreign.body)).toEqual([]);
    });

    it.each([
      { family: '/v1', url: V1_REQUESTS },
      { family: 'fixture', url: FIXTURE_REQUESTS },
    ])('refuses a tenant B signer naming siteid tenant-a on the $family list with 403 forbidden and no tenant A data', async ({ url }) => {
      const control = await get(`${url}?siteid=${TENANT_B.siteId}`, SIGNER, TENANT_B);
      const res = await get(`${url}?siteid=${TENANT_A.siteId}`, SIGNER, TENANT_B);

      expect(control.statusCode, 'the same subject naming its own site').toBe(200);
      expect(answerOf(res)).toMatchObject({
        status: FORBIDDEN.status,
        error: { code: FORBIDDEN.code, message: FORBIDDEN.message },
        data: undefined,
      });
      expect(await leakedFrom([TENANT_A], res.body)).toEqual([]);
    });
  });
});
