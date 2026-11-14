// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting fixture checks against legacy-fixtures/cfml api.cfm, lib/auth.cfc resolveSite and modules/reporting.cfc createExport, exportDetail and download. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { AuthDenial, type Opt2AuthContext, type UserClaims } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, type QueryResult, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import type { ReportingDeps } from '../../src/domain/deps.js';
import { ReportingDomainError, createExportJob, type ExportOutput } from '../../src/domain/jobs.js';
import {
  FIXTURE_CHECK_ORDER,
  createExportFields,
  fixtureDenialOverride,
  requireExportJob,
  requireReadyOutput,
  resolveFixtureSite,
  runFixtureChecks,
  type FixtureSite,
} from '../../src/legacy/checks.js';
import { FixtureApiError, toFixtureError, type FixtureContext } from '../../src/legacy/envelope.js';
import { createReportingRepository } from '../../src/repo/repository.js';
import { EXPORT_BUCKET, UNITS, type ExportJobRow } from '../../src/repo/tables.js';

const REGISTERED = [TENANT_A.siteId, TENANT_B.siteId, 'default'] as const;
const CTX: FixtureContext = { method: 'reporting.exports', params: {} };
const REQUESTER = '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90A';
const JOB_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const SESSION_ID = 'session-1';

/** Rows of a fake pg result. */
function result<R extends Record<string, unknown>>(rows: R[]): QueryResult<R> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

/** A database over the `sites` registry answering the two lookups of resolveFixtureSite, recording each transaction's tenant and statement. */
function registryDb(sites: readonly string[] = REGISTERED): { db: TenantDb; tenants: string[]; statements: string[] } {
  const tenants: string[] = [];
  const statements: string[] = [];
  const answer = (sql: string, value: unknown): QueryResult<Record<string, unknown>> => {
    if (sql.includes('lower(site_id) = lower($1)')) {
      const lower = String(value).toLowerCase();
      return result(sites.filter((site) => site.toLowerCase() === lower).map((site) => ({ tenant_id: tenantIdForSite(site) })));
    }
    if (sql.includes('WHERE tenant_id = $1')) {
      return result(sites.filter((site) => tenantIdForSite(site) === value).map((site) => ({ site_id: site })));
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  const unused = (): never => {
    throw new Error('not used by the fixture checks');
  };
  const db: TenantDb = {
    schema: 'reporting',
    withTenant: (tenantId, fn) => {
      tenants.push(tenantId);
      const query = (text: string | { text: string }, values: unknown[] = []): Promise<QueryResult<Record<string, unknown>>> => {
        const sql = typeof text === 'string' ? text : text.text;
        statements.push(sql);
        return Promise.resolve(answer(sql, values[0]));
      };
      return fn({ kind: 'tenant', tenantId, schema: 'reporting', query, onCommit: () => undefined } as unknown as TenantTx);
    },
    withMetadata: unused,
    end: unused,
  };
  return { db, tenants, statements };
}

/** Verified claims of a `site` session holding reporting.exporter; the tenant is the site's unless `tid` is given. */
function claims(site: string, tid: string = tenantIdForSite(site === '' ? 'default' : site)): UserClaims {
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: REQUESTER,
    sid: SESSION_ID,
    tid,
    site,
    roles: ['reporting.exporter'],
    s2: false,
    epoch: 1,
    iat: 1_782_820_800,
    exp: 1_782_824_400,
  };
}

/** The auth context the platform hooks attach for `user`. */
function requestFor(user: UserClaims | undefined): { opt2Auth: Opt2AuthContext } {
  return { opt2Auth: { user, roles: user?.roles ?? [], transport: 'service' } };
}

/** The fixture response `promise`'s rejection renders as. */
async function fixtureAnswer(promise: Promise<unknown>): Promise<{ status: number; error: unknown }> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
  const response = toFixtureError(error, CTX);
  return { status: response.status, error: (JSON.parse(String(response.body)) as { error: unknown }).error };
}

/** The error `fn` throws; fails the test when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const INVALID_PARAMETERS = { status: 400, error: { code: 'invalid_request', message: 'Invalid parameters' } };
const FORBIDDEN = { status: 403, error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } };
const UNAUTHORIZED = { status: 401, error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } };
const NOT_FOUND = { status: 404, error: { code: 'invalid_request', message: 'Not Found' } };

describe('FIXTURE_CHECK_ORDER', () => {
  it('orders the checks as api.cfm, then reporting.cfc with auth.cfc, and is frozen', () => {
    expect(FIXTURE_CHECK_ORDER).toStrictEqual(['path', 'site', 'login', 'role', 'csrf', 'existence', 'validation', 'state']);
    expect(Object.isFrozen(FIXTURE_CHECK_ORDER)).toBe(true);
  });
});

describe('resolveFixtureSite', () => {
  it.each([
    ['the token site as siteid', { siteid: TENANT_A.siteId }, TENANT_A.siteId, TENANT_A.siteId],
    ['a case-variant siteid, as its registered id', { SiteID: 'TENANT-A' }, TENANT_A.siteId, TENANT_A.siteId],
    ['an empty siteid, as the token site', { siteid: '' }, TENANT_B.siteId, TENANT_B.siteId],
    ['no siteid, as the token site', {}, TENANT_A.siteId, TENANT_A.siteId],
    ['no siteid and a default token site', {}, 'default', 'default'],
  ])('resolves %s with the token tenant', async (_case, params, tokenSite, siteId) => {
    const user = claims(tokenSite);
    const { db, tenants } = registryDb();

    await expect(resolveFixtureSite(params, requestFor(user), { db })).resolves.toStrictEqual({ siteId, tenantId: user.tid });
    expect(tenants).toStrictEqual([user.tid]);
  });

  it('takes the tenant from the token, never from the requested site', async () => {
    const user = claims(TENANT_A.siteId, TENANT_B.tenantId);

    await expect(resolveFixtureSite({ siteid: TENANT_A.siteId }, requestFor(user), registryDb())).resolves.toStrictEqual({
      siteId: TENANT_A.siteId,
      tenantId: TENANT_B.tenantId,
    });
  });

  it.each([
    ['an unregistered siteid', { siteid: 'nosuch' }, TENANT_A.siteId, REGISTERED],
    ['an array siteid', { siteid: [TENANT_A.siteId] }, TENANT_A.siteId, REGISTERED],
    ['a struct siteid', { siteid: { id: TENANT_A.siteId } }, TENANT_A.siteId, REGISTERED],
    ['no siteid beside an unregistered token site', {}, 'retired-site', REGISTERED],
    ['no siteid and no token site without a registered default', {}, '', [TENANT_A.siteId]],
  ])('answers invalidParameters for %s instead of falling back to default', async (_case, params, tokenSite, sites) => {
    const promise = resolveFixtureSite(params, requestFor(claims(tokenSite)), registryDb(sites));

    await expect(promise).rejects.toBeInstanceOf(FixtureApiError);
    await expect(fixtureAnswer(promise)).resolves.toStrictEqual(INVALID_PARAMETERS);
  });

  it.each([
    ['a registered siteid of another site', { siteid: TENANT_B.siteId }, TENANT_A.siteId],
    ['default without a token site', {}, ''],
  ])('answers the fixture 403 for %s, after resolving it', async (_case, params, tokenSite) => {
    const promise = resolveFixtureSite(params, requestFor(claims(tokenSite)), registryDb());

    await expect(promise).rejects.toMatchObject({ statusCode: 403, reason: 'site-mismatch' });
    await expect(fixtureAnswer(promise)).resolves.toStrictEqual(FORBIDDEN);
  });

  it('refuses a request without a verified user and reads nothing', async () => {
    const { db, tenants } = registryDb();
    const promise = resolveFixtureSite({ siteid: TENANT_A.siteId }, requestFor(undefined), { db });

    await expect(promise).rejects.toBeInstanceOf(AuthDenial);
    await expect(promise).rejects.toMatchObject({ statusCode: 401, reason: 'missing-credential' });
    expect(tenants).toStrictEqual([]);
  });
});

describe('fixtureDenialOverride', () => {
  /** Claims of an active session without a login on `site`, as identity mints them. */
  const anonymous = (site: string): UserClaims => ({ ...claims(site), sub: '', roles: [] });

  it.each([
    ['missing credential', AuthDenial.unauthenticated('missing-credential')],
    ['invalid token', AuthDenial.invalidToken()],
    ['expired token', AuthDenial.expiredToken()],
    ['site mismatch', AuthDenial.siteMismatch()],
  ])('keeps a %s denial without reading the registry, even for an anonymous token of an unregistered site', async (_case, denial) => {
    const { db, tenants } = registryDb();

    await expect(fixtureDenialOverride(denial, { claims: anonymous('retired-site'), params: { siteid: 'nosuch' } }, { db })).resolves.toBe(denial);
    expect(tenants).toStrictEqual([]);
  });

  it('keeps a role denial of a request without user claims, reading nothing', async () => {
    const denial = AuthDenial.forbidden();
    const { db, tenants } = registryDb();

    await expect(fixtureDenialOverride(denial, { claims: undefined, params: {} }, { db })).resolves.toBe(denial);
    expect(tenants).toStrictEqual([]);
  });

  it.each([
    ['the token site', {}, TENANT_A.siteId],
    ['a case variant of the token site as siteid', { siteid: 'Tenant-A' }, TENANT_A.siteId],
    ['another registered site as siteid', { siteid: TENANT_B.siteId }, TENANT_A.siteId],
    ['default without a token site', {}, ''],
  ])('keeps the role denial of a logged-in user requesting %s, read in the token tenant', async (_case, params, tokenSite) => {
    const denial = AuthDenial.forbidden();
    const user = { ...claims(tokenSite), roles: [] };
    const { db, tenants } = registryDb();

    await expect(fixtureDenialOverride(denial, { claims: user, params }, { db })).resolves.toBe(denial);
    expect(tenants).toStrictEqual([user.tid]);
  });

  it.each([
    ['a logged-in user of an unregistered token site', claims('retired-site'), {}, REGISTERED],
    ['a logged-in user naming an unregistered siteid', claims(TENANT_A.siteId), { siteid: 'nosuch' }, REGISTERED],
    ['a logged-in user naming an array siteid', claims(TENANT_A.siteId), { siteid: [TENANT_A.siteId] }, REGISTERED],
    ['an anonymous session of an unregistered token site', anonymous('retired-site'), {}, REGISTERED],
    ['an anonymous session naming an unregistered siteid', anonymous(TENANT_A.siteId), { SiteID: 'nosuch' }, REGISTERED],
    ['an anonymous session without a token site or a registered default', anonymous(''), {}, [TENANT_A.siteId]],
  ])('answers the role denial of %s with invalidParameters, as resolveSite raises before requireLogin', async (_case, user, params, sites) => {
    const answer = await fixtureDenialOverride(AuthDenial.forbidden(), { claims: user, params }, registryDb(sites));

    expect(answer).toBeInstanceOf(FixtureApiError);
    await expect(fixtureAnswer(Promise.reject(answer))).resolves.toStrictEqual(INVALID_PARAMETERS);
  });

  it.each([
    ['its token site', {}],
    ['a registered siteid', { siteid: TENANT_B.siteId }],
  ])('answers the role denial of an anonymous session requesting %s with authorization, as requireLogin raises', async (_case, params) => {
    const answer = await fixtureDenialOverride(AuthDenial.forbidden(), { claims: anonymous(TENANT_A.siteId), params }, registryDb());

    expect(answer).toBeInstanceOf(FixtureApiError);
    await expect(fixtureAnswer(Promise.reject(answer))).resolves.toStrictEqual(UNAUTHORIZED);
  });
});

describe('createExportFields', () => {
  it.each([
    ['form fields', { definitionId: 'D1', format: 'csv', asOf: '2026-06-30' }, { definitionId: 'D1', format: 'csv', params: { asOf: '2026-06-30' } }],
    ['names in any case', { DEFINITIONID: 'D1', Format: 'pdf', ASOF: '2026-01-31' }, { definitionId: 'D1', format: 'pdf', params: { asOf: '2026-01-31' } }],
    ['absent fields', {}, { definitionId: '', format: '', params: { asOf: undefined } }],
    ['complex fields as empty text', { definitionId: ['D1'], format: { f: 'csv' }, asOf: ['x'] }, { definitionId: '', format: '', params: { asOf: ['x'] } }],
    ['an unknown format, unchecked', { definitionId: 'D1', format: 'docx' }, { definitionId: 'D1', format: 'docx', params: { asOf: undefined } }],
  ])('reads %s as reporting.cfc does', (_case, params, fields) => {
    expect(createExportFields(params)).toStrictEqual(fields);
  });
});

describe('requireExportJob and requireReadyOutput', () => {
  const job = { job_id: JOB_ID, state: 'done' } as ExportJobRow;
  const ready: ExportOutput = {
    outcome: 'ready',
    job,
    bucket: EXPORT_BUCKET,
    objectKey: `${TENANT_A.tenantId}/${JOB_ID}.csv`,
    fileName: `export-${JOB_ID}.csv`,
    contentType: 'text/csv',
    sha256: 'a'.repeat(64),
  };

  it('keeps a found job and answers notFound without one', async () => {
    expect(requireExportJob(job)).toBe(job);
    await expect(fixtureAnswer(Promise.reject(thrownBy(() => requireExportJob(null))))).resolves.toStrictEqual(NOT_FOUND);
  });

  it.each([
    ['notFound without the job', { outcome: 'not-found' }, NOT_FOUND],
    ['the not-ready conflict before done', { outcome: 'not-ready', state: 'running' }, { status: 409, error: { code: 'invalid_request', message: 'not-ready' } }],
  ] as const)('answers %s', async (_case, output, answer) => {
    await expect(fixtureAnswer(Promise.reject(thrownBy(() => requireReadyOutput(output))))).resolves.toStrictEqual(answer);
  });

  it('returns a ready output', () => {
    expect(requireReadyOutput(ready)).toBe(ready);
  });
});

describe('runFixtureChecks', () => {
  it('runs the handler steps in fixture order, whatever their key order, each receiving the earlier results', async () => {
    const ran: string[] = [];
    // Keys in reverse order defeat inference, which follows key order, so the result types are given.
    const results = await runFixtureChecks<string, FixtureSite, string, string, object>({
      state: (done) => {
        ran.push('state');
        return { ...done };
      },
      validation: async ({ existence }) => {
        ran.push('validation');
        return `${existence}-valid`;
      },
      existence: ({ site }) => {
        ran.push('existence');
        return `${site.siteId}-job`;
      },
      site: async () => {
        ran.push('site');
        return { siteId: TENANT_A.siteId, tenantId: TENANT_A.tenantId };
      },
      path: () => {
        ran.push('path');
        return 'exports';
      },
    });

    expect(ran).toStrictEqual(['path', 'site', 'existence', 'validation', 'state']);
    expect(results.validation).toBe('tenant-a-job-valid');
    expect(results.state).toStrictEqual({
      path: 'exports',
      site: { siteId: TENANT_A.siteId, tenantId: TENANT_A.tenantId },
      existence: 'tenant-a-job',
      validation: 'tenant-a-job-valid',
    });
  });

  it('infers each result type from steps written in fixture order', async () => {
    const results = await runFixtureChecks({
      site: () => ({ siteId: TENANT_A.siteId, tenantId: TENANT_A.tenantId }),
      existence: async ({ site }) => site.tenantId,
    });

    expectTypeOf(results.existence).toEqualTypeOf<string>();
    expect(results.existence).toBe(TENANT_A.tenantId);
  });

  it('leaves steps not given undefined', async () => {
    await expect(runFixtureChecks({ existence: () => 1 })).resolves.toStrictEqual({
      path: undefined,
      site: undefined,
      existence: 1,
      validation: undefined,
      state: undefined,
    });
  });

  it.each([
    ['a fixture error', new FixtureApiError('invalidParameters')],
    ['a domain error', new ReportingDomainError('notFound')],
    ['an auth denial', AuthDenial.siteMismatch()],
  ])('stops at the first failing step and propagates %s unchanged', async (_case, failure) => {
    const ran: string[] = [];
    const promise = runFixtureChecks({
      site: () => {
        ran.push('site');
        throw failure;
      },
      existence: () => {
        ran.push('existence');
      },
      state: () => {
        ran.push('state');
      },
    });

    await expect(promise).rejects.toBe(failure);
    expect(ran).toStrictEqual(['site']);
  });
});

describe.skipIf(!(await pgAvailable()))('fixture create checks against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let deps: Pick<ReportingDeps, 'db' | 'repository' | 'storage' | 'clock' | 'enqueue' | 'runScheduled'>;
  const definitionId = cfUuid();
  const enqueued: Parameters<ReportingDeps['enqueue']>[0][] = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'legacy-checks-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'legacy-checks-test', state: 'open' });
    await seedRegistry(handle.app);
    await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns)
         VALUES ($1, $2, $3, 'Sheets', 'timesheets.sheets', '["timesheet_id"]')`,
        [TENANT_A.tenantId, definitionId, TENANT_A.siteId],
      ),
    );
    const clock = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
    // Every run task is live, so no create fails a job and no storage call is made.
    const storage = {} as ReportingDeps['storage'];
    deps = {
      db: handle.app,
      repository: createReportingRepository({ db: handle.app, storage, clock }),
      storage,
      clock,
      enqueue: (run) => {
        enqueued.push(run);
        return Promise.resolve();
      },
      runScheduled: () => Promise.resolve(true),
    };
  });

  afterAll(async () => {
    await handle?.drop();
  });

  /** The create chain of the fixture route: site, then the domain's definition and field checks. */
  async function create(params: Record<string, unknown>, user: UserClaims = claims(TENANT_A.siteId)): Promise<ExportJobRow> {
    const site = await resolveFixtureSite(params, requestFor(user), deps);
    return createExportJob(deps, {
      tenantId: site.tenantId,
      siteId: site.siteId,
      requestedById: user.sub,
      ...createExportFields(params),
    });
  }

  it('resolves a case-variant siteid against the seeded registry', async () => {
    await expect(resolveFixtureSite({ siteid: 'Tenant-A' }, requestFor(claims(TENANT_A.siteId)), deps)).resolves.toStrictEqual({
      siteId: TENANT_A.siteId,
      tenantId: TENANT_A.tenantId,
    });
  });

  it.each([
    ['a missing definitionid', { format: 'csv' }, NOT_FOUND],
    ['an unknown definitionid before a bad format', { definitionid: cfUuid(), format: 'docx' }, NOT_FOUND],
    ['a bad format', { definitionid: definitionId, format: 'docx' }, INVALID_PARAMETERS],
    ['a bad asOf', { definitionid: definitionId, format: 'csv', asOf: '2026-02-30' }, INVALID_PARAMETERS],
    ['an unregistered siteid before the definition', { siteid: 'nosuch', format: 'docx' }, INVALID_PARAMETERS],
    ['a mismatched siteid before the definition', { siteid: TENANT_B.siteId, definitionid: definitionId, format: 'csv' }, FORBIDDEN],
  ])('answers %s as the fixture does', async (_case, params, answer) => {
    await expect(fixtureAnswer(create(params))).resolves.toStrictEqual(answer);
  });

  it('keeps another tenant from seeing the definition', async () => {
    await expect(fixtureAnswer(create({ definitionid: definitionId, format: 'csv' }, claims(TENANT_B.siteId)))).resolves.toStrictEqual(NOT_FOUND);
  });

  it('queues a job once every check passes', async () => {
    const job = await create({ DefinitionID: definitionId, FORMAT: 'xlsx', asOf: '2026-06-30' });

    expect(job).toMatchObject({ tenant_id: TENANT_A.tenantId, siteid: TENANT_A.siteId, definition_id: definitionId, format: 'xlsx', state: 'queued' });
    expect(enqueued).toStrictEqual([
      { tenantId: TENANT_A.tenantId, jobId: job.job_id, payload: { jobId: job.job_id, asOf: '2026-06-30' } },
    ]);
  });
});
