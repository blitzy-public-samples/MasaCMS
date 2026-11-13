// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/reporting/exports` create through `app.inject` against a throwaway `reporting` schema: the job and the run task it schedules once identity consumes its CSRF token. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  createService,
  fixedClock,
  loadEnv,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { createLocalStorageAdapter } from '@opt2/platform/storage';
import {
  TENANT_A,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { EnqueueExportRun, ReportingDeps } from '../../src/domain/deps.js';
import { createReportingRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import { registerV1Routes } from '../../src/routes/v1.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const EXPORTS = '/v1/reporting/exports';
const USER_ID = '11111111-2222-3333-4444555566667777';
const SESSION_ID = 'v1-create-session';
const CSRF_TOKEN = 'C5F1E2D3A4B5C6D7E8F90A1B2C3D4E5F';
const CSRF_EXPIRES = '260630120000123';

/** Identity's consume verdict: valid for the token issued in SESSION_ID for the collection context alone. */
function consume(request: ServiceRequest): Promise<ServiceResponse> {
  if (request.service !== IDENTITY_SERVICE || request.method !== 'POST' || request.path !== CSRF_CONSUME_PATH) {
    return Promise.reject(new Error(`the /v1 create calls no other service: ${request.method} ${request.service} ${request.path}`));
  }
  const { sessionId, token, expires, context } = request.json as CsrfConsumeRequest;
  const valid = sessionId === SESSION_ID && token === CSRF_TOKEN && expires === CSRF_EXPIRES && context === '';
  return Promise.resolve({ status: 200, headers: { 'content-type': 'application/json' }, body: { valid } });
}

describe.skipIf(!(await pgAvailable()))('/v1/reporting routes', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let app: FastifyInstance;
  let outbound: Mock;
  const definitionId = cfUuid();
  const enqueued: Parameters<EnqueueExportRun>[0][] = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'v1-create-session-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'v1-create-session-test', state: 'open' });
    await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns)
         VALUES ($1, $2, $3, 'Sheets', 'timesheets.sheets', '["timesheet_id"]')`,
        [TENANT_A.tenantId, definitionId, TENANT_A.siteId],
      ),
    );
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-v1-'));
    const storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'v1-create-session-test-key' });
    const clock = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
    app = await createService({
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
      pool: handle.app,
    });
    const deps: ReportingDeps = {
      db: handle.app,
      repository: createReportingRepository({ db: handle.app, storage, clock }),
      storage,
      clock,
      client: app.opt2.client,
      enqueue: (run) => {
        enqueued.push(run);
        return Promise.resolve();
      },
      runScheduled: () => Promise.resolve(true),
    };
    await registerV1Routes(app, deps);
    await app.ready();
    // ReportingDeps holds this same client object, so the CSRF hook's identity call is answered here.
    outbound = vi.fn(consume);
    vi.spyOn(app.opt2.client, 'request').mockImplementation(outbound);
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  it("queues a job whose run task carries neither the requester's session nor a token", async () => {
    const [token, invocation] = await Promise.all([
      mintUserToken({ sub: USER_ID, site: TENANT_A.siteId, roles: [Roles.systemUser, Roles.reportingExporter], sid: SESSION_ID }),
      mintServiceToken({ caller: 'web', audience: 'reporting' }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: EXPORTS,
      headers: {
        authorization: `Bearer ${token}`,
        [INVOCATION_HEADER]: `Bearer ${invocation}`,
        'x-csrf_token': CSRF_TOKEN,
        'x-csrf_token_expires': CSRF_EXPIRES,
      },
      payload: { definitionId, format: 'csv', asOf: '2026-06-30' },
    });

    expect(res.statusCode).toBe(200);
    expect(outbound.mock.calls).toStrictEqual([
      [
        {
          service: IDENTITY_SERVICE,
          method: 'POST',
          path: CSRF_CONSUME_PATH,
          json: { sessionId: SESSION_ID, token: CSRF_TOKEN, expires: CSRF_EXPIRES, context: '' },
        },
      ],
    ]);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: EXPORTS, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    const job = res.json<{ data: { job_id: string } }>().data;
    expect(job).toMatchObject({ siteid: TENANT_A.siteId, definition_id: definitionId, state: 'queued', requested_by_id: USER_ID });
    expect(enqueued).toStrictEqual([
      { tenantId: TENANT_A.tenantId, jobId: job.job_id, payload: { jobId: job.job_id, asOf: '2026-06-30' } },
    ]);
  });
});
