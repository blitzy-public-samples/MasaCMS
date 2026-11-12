// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The `reporting-export-run` task route built from `exportRunTaskOptions`, against PostgreSQL, local storage and a stub timesheets source. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { recordedRoutes } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import {
  createService,
  fixedClock,
  loadEnv,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import { QUEUES, registerTaskRoute } from '@opt2/platform/tasks';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintTasksInvokerToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { EnqueueExportRun, ExportRunPayload, ReportingDeps } from '../../src/domain/deps.js';
import { createExportJob } from '../../src/domain/jobs.js';
import { createReportingRepository } from '../../src/repo/repository.js';
import { UNITS, type ExportJobRow } from '../../src/repo/tables.js';
import { exportRunTaskOptions } from '../../src/tasks/handler.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const QUEUE = QUEUES['reporting-export-run'];
const ROUTE = QUEUE.targetPath.replace(/\{(\w+)\}/g, ':$1');
const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
const BAD_REQUEST = { error: { code: 'invalid_request', message: 'Bad Request' } };

/** Timesheets stub answering every sheet-status read with one row. */
const sheetsClient: ServiceClient = {
  request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (req.service !== 'timesheets') return Promise.reject(new Error(`unexpected call to ${req.service} ${req.path}`));
    const items = [
      {
        timesheetId: '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90B',
        siteId: 'tasks-test',
        personId: '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90A',
        periodStart: '2026-06-01',
        status: 'SUBMITTED',
        overdue: false,
        dayCount: 5,
        blackoutCount: 0,
        approvedCount: 0,
      },
    ];
    const response: ServiceResponse = { status: 200, headers: { 'content-type': 'application/json' }, body: { items } };
    return Promise.resolve(response as ServiceResponse<T>);
  },
  close: () => Promise.resolve(),
};

/** The wire body the task adapters POST for `payload` under `tenantId`. */
const wire = (tenantId: string | null, payload: unknown) => ({ queue: QUEUE.name, name: `${QUEUE.name}-task`, tenantId, payload });

const runUrl = (jobId: string): string => `/internal/v1/tasks/exports/${jobId}/run`;

/** Validates an injected response against `runExportTask` in the reporting contract. */
function assertContract(jobId: string, res: { statusCode: number; headers: Record<string, unknown>; payload: string }): void {
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'POST',
    path: runUrl(jobId),
    status: res.statusCode,
    contentType: res.headers['content-type'] as string | undefined,
    body: res.payload,
  });
}

describe.skipIf(!(await pgAvailable()))('export-run task route', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let storage: LocalStorageAdapter;
  let deps: ReportingDeps;
  let sites = 0;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'tasks-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'tasks-test', state: 'open' });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-tasks-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'tasks-test-key' });
    deps = {
      db: handle.app,
      repository: createReportingRepository({ db: handle.app, storage, clock: CLOCK }),
      storage,
      clock: CLOCK,
      client: sheetsClient,
      enqueue: () => Promise.resolve(),
      runScheduled: () => Promise.resolve(true),
    };
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  /** A reporting app carrying only the export-run task route at the queue's target path. */
  async function taskApp(): Promise<FastifyInstance> {
    const app = await createService({
      name: 'reporting',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8116',
        OPT2_SERVICE_NAME: 'reporting',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('reporting'),
      clock: CLOCK,
      logger: createLogger({ service: 'reporting', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    apps.push(app);
    registerTaskRoute(app, ROUTE, exportRunTaskOptions(deps));
    await app.ready();
    return app;
  }

  /** A queued csv job of a new site's definition reading `source`, with the payload its create enqueued. */
  async function queuedJob(source = 'timesheets.sheets'): Promise<{ job: ExportJobRow; payload: ExportRunPayload }> {
    sites += 1;
    const siteId = `tasks-test-${String(sites)}`;
    const tenantId = tenantIdForSite(siteId);
    const definitionId = cfUuid();
    await handle.app.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns)
         VALUES ($1, $2, $3, 'Sheets', $4, '["timesheet_id","status"]')`,
        [tenantId, definitionId, siteId, source],
      ),
    );
    const runs: Parameters<EnqueueExportRun>[0][] = [];
    const enqueue: EnqueueExportRun = (run) => {
      runs.push(run);
      return Promise.resolve();
    };
    const job = await createExportJob(
      { ...deps, enqueue },
      { tenantId, siteId, definitionId, format: 'csv', requestedById: cfUuid(), userToken: 'requester-token', params: {} },
    );
    const [run] = runs as [Parameters<EnqueueExportRun>[0]];
    return { job, payload: run.payload };
  }

  const read = (job: ExportJobRow): Promise<ExportJobRow | null> =>
    handle.app.withTenant(job.tenant_id, async (tx) => {
      const { rows } = await tx.query<ExportJobRow>(`SELECT * FROM ${handle.schema}.export_job WHERE job_id = $1`, [job.job_id]);
      return rows[0] ?? null;
    });

  /** POSTs a task as the local tasks adapter does, with a `tasks-invoker` token unless `authorization` is given. */
  async function post(app: FastifyInstance, jobId: string, body: unknown, authorization?: string) {
    const token = authorization ?? `Bearer ${await mintTasksInvokerToken({ audience: 'reporting' })}`;
    return app.inject({ method: 'POST', url: runUrl(jobId), headers: { authorization: token }, payload: body as object });
  }

  it('is a POST on the cloud-tasks transport for the tasks-invoker only', async () => {
    const app = await taskApp();
    expect(recordedRoutes(app).find((route) => route.url === ROUTE)).toEqual({
      method: 'POST',
      url: ROUTE,
      config: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'] },
    });
  });

  it('runs a queued job to done and acknowledges a redelivery without changing the job', async () => {
    const app = await taskApp();
    const { job, payload } = await queuedJob();

    const first = await post(app, job.job_id, wire(job.tenant_id, payload));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toStrictEqual({ jobId: job.job_id, state: 'done' });
    assertContract(job.job_id, first);
    const done = await read(job);
    expect(done).toMatchObject({ state: 'done', error: null });

    const again = await post(app, job.job_id, wire(job.tenant_id, payload));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toStrictEqual({ jobId: job.job_id, state: 'done' });
    expect(await read(job)).toStrictEqual(done);
  });

  it('answers a run whose source is unavailable with its failed state', async () => {
    const app = await taskApp();
    const { job, payload } = await queuedJob('broken');

    const res = await post(app, job.job_id, wire(job.tenant_id, payload));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ jobId: job.job_id, state: 'failed' });
    expect(await read(job)).toMatchObject({ state: 'failed', error: 'source-unavailable' });
  });

  it.each<[string, (job: ExportJobRow, payload: ExportRunPayload) => [string, unknown]]>([
    ["another tenant than the job's", (job, payload) => [job.job_id, wire(TENANT_B.tenantId, payload)]],
    ['no tenant', (job, payload) => [job.job_id, wire(null, payload)]],
    ['a payload without userToken', (job, payload) => [job.job_id, wire(job.tenant_id, { jobId: payload.jobId, asOf: payload.asOf })]],
    ['an asOf outside yyyy-mm-dd', (job, payload) => [job.job_id, wire(job.tenant_id, { ...payload, asOf: '30/06/2026' })]],
    ['a jobId that is no CF UUID', (job, payload) => [job.job_id, wire(job.tenant_id, { ...payload, jobId: 'job-1' })]],
    ['a null payload', (job) => [job.job_id, wire(job.tenant_id, null)]],
    ['a job the tenant does not hold', (job, payload) => [job.job_id, wire(job.tenant_id, { ...payload, jobId: cfUuid() })]],
    ['a URL naming another job than the payload', (job, payload) => [cfUuid(), wire(job.tenant_id, payload)]],
  ])('refuses %s as legacy badRequest and leaves the job queued', async (_case, build) => {
    const app = await taskApp();
    const { job, payload } = await queuedJob();
    const [urlJobId, body] = build(job, payload);

    const res = await post(app, urlJobId, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject(BAD_REQUEST);
    assertContract(urlJobId, res);
    expect((await read(job))?.state).toBe('queued');
  });

  it('refuses a user token before running anything', async () => {
    const app = await taskApp();
    const { job, payload } = await queuedJob();
    const token = await mintUserToken({ sub: 'tasks-user', site: TENANT_A.siteId, roles: ['s2'] });

    const res = await post(app, job.job_id, wire(job.tenant_id, payload), `Bearer ${token}`);

    expect(res.statusCode).toBe(401);
    expect((await read(job))?.state).toBe('queued');
  });

  it('answers the legacy 503 while the job unit is legacy-authoritative and leaves the job queued for a retry', async () => {
    const app = await taskApp();
    const { job, payload } = await queuedJob();
    const holderId = 'tasks-test-legacy';
    await closeGates(handle.app, { units: UNITS, holderId });
    await openGates(handle.app, { units: UNITS, holderId, state: 'legacy' });
    try {
      const res = await post(app, job.job_id, wire(job.tenant_id, payload));

      expect(res.statusCode).toBe(503);
      assertContract(job.job_id, res);
      expect((await read(job))?.state).toBe('queued');
    } finally {
      await closeGates(handle.app, { units: UNITS, holderId, allowLegacy: true });
      await openGates(handle.app, { units: UNITS, holderId, state: 'open' });
    }
  });
});
