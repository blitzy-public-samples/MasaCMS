// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The `reporting-export-run` task route built from `exportRunTaskOptions`, against PostgreSQL, local storage and a stub timesheets source of the System export read. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, LOCAL_USER_TOKEN, Roles, recordedRoutes, serviceRole } from '@opt2/platform/auth';
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

/** Path of the timesheets System export read. */
const SHEET_STATUS_PATH = '/internal/v1/timesheets/sheet-status';

/** Timesheets stub answering every System sheet-status read, which carries no user token, with one row; any other call rejects. */
const sheetsClient: ServiceClient = {
  request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (req.service !== 'timesheets' || req.path.split('?')[0] !== SHEET_STATUS_PATH || req.userToken !== null) {
      return Promise.reject(new Error(`unexpected call to ${req.service} ${req.path}`));
    }
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
    const response: ServiceResponse = { status: 200, headers: { 'content-type': 'application/json' }, body: { items, total: items.length } };
    return Promise.resolve(response as ServiceResponse<T>);
  },
  close: () => Promise.resolve(),
};

/** A timesheets stub refusing every read with `status`, as a producer refuses an export scope reporting does not confirm. */
const refusingClient = (status: number): ServiceClient => ({
  request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (req.service !== 'timesheets') return Promise.reject(new Error(`unexpected call to ${req.service} ${req.path}`));
    const response: ServiceResponse = { status, headers: { 'content-type': 'application/json' }, body: { error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } } };
    return Promise.resolve(response as ServiceResponse<T>);
  },
  close: () => Promise.resolve(),
});

/** One request a stub HTTP server received. */
interface ReceivedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** The claims of a JWT, read without verifying it. */
const jwtClaims = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

/** `payload` as an earlier release queued it, with the requester's `userToken` beside it. */
const priorPayload = (payload: ExportRunPayload, userToken: string) => ({ jobId: payload.jobId, asOf: payload.asOf, userToken });

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
  const servers: http.Server[] = [];

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
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  /** A reporting app carrying only the export-run task route at the queue's target path, reading sources through `clientOf(app)`. */
  async function taskApp(
    clientOf: (app: FastifyInstance) => ServiceClient = () => sheetsClient,
    serviceUrls: Record<string, string> = {},
  ): Promise<FastifyInstance> {
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
        OPT2_SERVICE_URLS: JSON.stringify(serviceUrls),
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('reporting'),
      clock: CLOCK,
      logger: createLogger({ service: 'reporting', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    apps.push(app);
    registerTaskRoute(app, ROUTE, exportRunTaskOptions({ ...deps, client: clientOf(app) }));
    await app.ready();
    return app;
  }

  /**
   * One HTTP server standing in for every service reporting may call, answering as timesheets' System export read; records every
   * request with the job row as stored when it arrived.
   */
  async function sheetsServer(job: ExportJobRow): Promise<{ url: string; received: (ReceivedRequest & { stored: ExportJobRow | null })[] }> {
    const received: (ReceivedRequest & { stored: ExportJobRow | null })[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'application/json');
        read(job)
          .then((stored) => {
            received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, stored });
            return sheetsClient.request<unknown>({ service: 'timesheets', method: 'GET', path: req.url ?? '', userToken: null });
          })
          .then((answer) => res.end(JSON.stringify(answer.body)), (err: unknown) => res.destroy(err as Error));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, received };
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
    const job = await createExportJob({ ...deps, enqueue }, { tenantId, siteId, definitionId, format: 'csv', requestedById: cfUuid(), params: {} });
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
    const { job, payload } = await queuedJob();
    const app = await taskApp();

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

  it("reads the source over HTTP as System: reporting's own invocation credential, the job's export scope and run claim, no user token", async () => {
    const { job, payload } = await queuedJob();
    const { url, received } = await sheetsServer(job);
    const app = await taskApp((created) => created.opt2.client, { identity: url, timesheets: url, finance: url });

    const res = await post(app, job.job_id, wire(job.tenant_id, payload));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ jobId: job.job_id, state: 'done' });
    assertContract(job.job_id, res);
    expect(received).toHaveLength(1);
    const [sourceRead] = received as [ReceivedRequest & { stored: ExportJobRow | null }];
    const target = new URL(sourceRead.url, url);
    expect([sourceRead.method, target.pathname]).toStrictEqual(['GET', SHEET_STATUS_PATH]);
    expect(sourceRead.headers.authorization).toBeUndefined();
    expect(jwtClaims(String(sourceRead.headers[INVOCATION_HEADER]).replace(/^Bearer /, ''))).toMatchObject({ sub: serviceRole('reporting'), aud: 'timesheets' });
    // The claim the read names is the running job's current row version, so the producer can confirm it with reporting.
    expect(sourceRead.stored).toMatchObject({ state: 'running' });
    expect(Object.fromEntries(target.searchParams)).toStrictEqual({
      exportId: job.job_id,
      siteId: job.siteid,
      claim: sourceRead.stored?.row_version,
      asOf: payload.asOf,
      pageIndex: '1',
      itemsPerPage: '1000',
    });
  });

  it.each<[string, (payload: ExportRunPayload, userToken: string) => object]>([
    ['a payload of an earlier release carrying the requester token, expired an hour ago', priorPayload],
    ['a payload of an earlier release naming the creating session', (payload) => ({ ...payload, sessionId: 'earlier-release-session' })],
    ['a payload carrying both the session and the expired token', (payload, userToken) => ({ ...payload, sessionId: 'earlier-release-session', userToken })],
    ['a payload whose token is no JWT', (payload) => priorPayload(payload, 'not-a-jwt')],
  ])('runs %s to done as System, calling no identity and never sending the queued credential', async (_case, build) => {
    const { job, payload } = await queuedJob();
    const { url, received } = await sheetsServer(job);
    const app = await taskApp((created) => created.opt2.client, { identity: url, timesheets: url, finance: url });
    const iat = Math.floor(CLOCK.now().getTime() / 1000) - 3600;
    const queuedToken = await mintUserToken({
      sub: job.requested_by_id.trimEnd(),
      tid: job.tenant_id,
      site: job.siteid,
      roles: [Roles.reportingExporter],
      sid: 'earlier-release-session',
      iat,
      exp: iat + LOCAL_USER_TOKEN.lifetimeSeconds,
    });

    const res = await post(app, job.job_id, wire(job.tenant_id, build(payload, queuedToken)));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ jobId: job.job_id, state: 'done' });
    assertContract(job.job_id, res);
    expect(await read(job)).toMatchObject({ state: 'done', error: null });
    expect(received.map((request) => new URL(request.url, url).pathname)).toStrictEqual([SHEET_STATUS_PATH]);
    for (const request of received) {
      expect(request.headers.authorization).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain(queuedToken);
      expect(JSON.stringify(request)).not.toContain('earlier-release-session');
    }
  });

  it.each([
    ['refuses its export scope', 403],
    ['answers 503', 503],
  ])('answers a run with its failed state, and acknowledges a redelivery unchanged, when the source %s', async (_case, status) => {
    const { job, payload } = await queuedJob();
    const app = await taskApp(() => refusingClient(status));

    const res = await post(app, job.job_id, wire(job.tenant_id, payload));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ jobId: job.job_id, state: 'failed' });
    assertContract(job.job_id, res);
    const failed = await read(job);
    expect(failed).toMatchObject({ state: 'failed', error: 'source-unavailable' });
    const again = await post(app, job.job_id, wire(job.tenant_id, payload));
    expect(again.json()).toStrictEqual({ jobId: job.job_id, state: 'failed' });
    expect(await read(job)).toStrictEqual(failed);
  });

  it.each<[string, (job: ExportJobRow, payload: ExportRunPayload) => [string, unknown]]>([
    ["another tenant than the job's", (job, payload) => [job.job_id, wire(TENANT_B.tenantId, payload)]],
    ['no tenant', (job, payload) => [job.job_id, wire(null, payload)]],
    ['a payload without asOf', (job, payload) => [job.job_id, wire(job.tenant_id, { jobId: payload.jobId })]],
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
