// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * CSRF consumption of the `/v1/reporting` export queueing through app.inject over domain doubles: context, single use, refusals
 * and reads; then the outcome reason each refusal logs.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createLogger, validateLogRecord } from '@opt2/platform/logging';
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
import { TENANT_A, assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import type { ReportingDeps } from '../../src/domain/deps.js';
import { ReportingDomainError, createExportJob, listExportJobs } from '../../src/domain/jobs.js';
import { FixtureApiError } from '../../src/legacy/envelope.js';
import type { ExportJobRow } from '../../src/repo/tables.js';
import { registerV1Routes } from '../../src/routes/v1.js';

vi.mock('../../src/domain/jobs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/domain/jobs.js')>()),
  createExportJob: vi.fn(),
  listExportJobs: vi.fn(),
}));

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const USER_ID = '11111111-2222-3333-4444555566667777';
const SESSION_ID = '0F1E2D3C-4B5A-6978-8796A5B4C3D2E1F0';
const JOB_ID = '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const DEFINITION_ID = '9F8E7D6C-5B4A-3928-1706F5E4D3C2B1A0';
const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const CSRF_TOKEN = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const FOREIGN_TOKEN = 'B'.repeat(32);
const CSRF_EXPIRES = '260630120000123';
const CSRF_HEADERS: Readonly<Record<string, string>> = { 'x-csrf_token': CSRF_TOKEN, 'x-csrf_token_expires': CSRF_EXPIRES };
const INVALID_TOKENS = { code: 'invalid_request', message: 'Invalid CSRF tokens' };
const EXPORTS = `/v1/reporting/exports?siteid=${TENANT_A.siteId}`;
const CREATE_BODY = { definitionId: DEFINITION_ID, format: 'csv' };

const QUEUED: ExportJobRow = {
  tenant_id: TENANT_A.tenantId,
  job_id: JOB_ID,
  siteid: TENANT_A.siteId,
  definition_id: DEFINITION_ID,
  format: 'csv',
  state: 'queued',
  requested_by_id: USER_ID,
  created: NOW,
  started_at: null,
  finished_at: null,
  error: null,
  file_name: null,
  content_type: null,
  object_key: null,
  output_sha256: null,
  row_version: '1',
};

describe('reporting /v1 export queueing CSRF', () => {
  let app: FastifyInstance;
  let outbound: Mock;
  /** Context identity issued each token for; a token is valid for that context alone. */
  let issued: Map<string, string>;
  /** `session token context` keys identity has consumed. */
  let consumed: Set<string>;
  let identityStatus: number;
  /** Every line the service logger wrote, parsed. */
  const logLines: Array<Record<string, unknown>> = [];

  /** Identity's consume verdict: valid once per session, token and context, for the context the token was issued for. */
  function consume(request: ServiceRequest): ServiceResponse {
    if (request.service !== IDENTITY_SERVICE || request.method !== 'POST' || request.path !== CSRF_CONSUME_PATH) {
      throw new Error(`the /v1 routes call no other service: ${request.method} ${request.service} ${request.path}`);
    }
    const { sessionId, token, context } = request.json as CsrfConsumeRequest;
    const key = `${sessionId} ${token} ${context}`;
    const valid = identityStatus === 200 && issued.get(token) === context && !consumed.has(key);
    if (valid) consumed.add(key);
    return { status: identityStatus, headers: {}, body: identityStatus === 200 ? { valid } : undefined };
  }

  /** Injects one gateway call as a tenant-a exporter and checks the answer against the contract. */
  async function inject(method: 'GET' | 'POST', url: string, csrf: Readonly<Record<string, string>>, payload?: Record<string, unknown>) {
    const headers: Record<string, string> = {
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'reporting' })}`,
      authorization: `Bearer ${await mintUserToken({ site: TENANT_A.siteId, roles: [Roles.reportingExporter], sub: USER_ID, sid: SESSION_ID })}`,
      ...csrf,
    };
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  beforeAll(async () => {
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
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('reporting'),
      logger: createLogger({
        service: 'reporting',
        version: '1.0.0',
        env: 'local',
        destination: { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) },
      }),
    });
    await registerV1Routes(app, { clock: fixedClock(NOW) } as ReportingDeps);
    await app.ready();
    outbound = vi.fn((request: ServiceRequest) => Promise.resolve(consume(request)));
    vi.spyOn(app.opt2.client, 'request').mockImplementation(outbound);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    outbound.mockClear();
    issued = new Map([
      [CSRF_TOKEN, ''],
      [FOREIGN_TOKEN, JOB_ID],
    ]);
    consumed = new Set();
    identityStatus = 200;
    vi.mocked(createExportJob).mockReset().mockResolvedValue(QUEUED);
    vi.mocked(listExportJobs).mockReset().mockResolvedValue({ rows: [QUEUED], total: 1, pageIndex: 1, itemsPerPage: 50 });
  });

  it("has identity consume the pair for the empty collection context in the token's session before queueing", async () => {
    const res = await inject('POST', EXPORTS, CSRF_HEADERS, CREATE_BODY);

    expect(res.statusCode).toBe(200);
    expect(outbound.mock.calls).toEqual([
      [{ service: IDENTITY_SERVICE, method: 'POST', path: CSRF_CONSUME_PATH, json: { sessionId: SESSION_ID, token: CSRF_TOKEN, expires: CSRF_EXPIRES, context: '' } }],
    ]);
    expect(outbound.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createExportJob).mock.invocationCallOrder[0] ?? 0);
  });

  it.each([
    ['no token', {}, 0],
    ['a token without its expiry', { 'x-csrf_token': CSRF_TOKEN }, 0],
    ["a job's token", { 'x-csrf_token': FOREIGN_TOKEN, 'x-csrf_token_expires': CSRF_EXPIRES }, 1],
  ] as const)('answers %s with invalidTokens and queues nothing', async (_case, csrf, consumeCalls) => {
    const res = await inject('POST', EXPORTS, csrf, CREATE_BODY);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: INVALID_TOKENS });
    expect(outbound).toHaveBeenCalledTimes(consumeCalls);
    expect(createExportJob).not.toHaveBeenCalled();
  });

  it('accepts a token once and answers its replay with invalidTokens', async () => {
    const first = await inject('POST', EXPORTS, CSRF_HEADERS, CREATE_BODY);
    const replay = await inject('POST', EXPORTS, CSRF_HEADERS, CREATE_BODY);

    expect([first.statusCode, replay.statusCode]).toEqual([200, 400]);
    expect(replay.json()).toMatchObject({ apiversion: 'v1', error: INVALID_TOKENS });
    expect(createExportJob).toHaveBeenCalledTimes(1);
  });

  it('answers the legacy 503 and queues nothing when identity cannot consume the token', async () => {
    identityStatus = 503;

    const res = await inject('POST', EXPORTS, CSRF_HEADERS, CREATE_BODY);

    expect(res.statusCode).toBe(503);
    expect(createExportJob).not.toHaveBeenCalled();
  });

  it('refuses a siteid other than the token site before consuming the token', async () => {
    const res = await inject('POST', '/v1/reporting/exports?siteid=tenant-b', CSRF_HEADERS, CREATE_BODY);

    expect(res.statusCode).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
    expect(createExportJob).not.toHaveBeenCalled();
  });

  it('consumes no CSRF token on the job list, even one sent with it', async () => {
    const res = await inject('GET', EXPORTS, CSRF_HEADERS);

    expect(res.statusCode).toBe(200);
    expect(outbound).not.toHaveBeenCalled();
    expect(listExportJobs).toHaveBeenCalledTimes(1);
  });

  const NUL_REFUSAL = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021', severity: 'ERROR' });

  it.each<[string, 'GET' | 'POST', string, Readonly<Record<string, string>>, unknown, number, string | null]>([
    ['no token', 'POST', EXPORTS, {}, undefined, 400, 'request rejected: invalidTokens'],
    ['a siteid other than the token site', 'POST', '/v1/reporting/exports?siteid=tenant-b', CSRF_HEADERS, undefined, 403, 'request denied: site-mismatch'],
    ['a page outside the query schema', 'GET', `${EXPORTS}&page=0`, {}, undefined, 400, 'request rejected: FST_ERR_VALIDATION'],
    ['a domain validation failure', 'POST', EXPORTS, CSRF_HEADERS, new ReportingDomainError('invalidParameters'), 400, 'request rejected: invalidParameters'],
    [
      'a domain refusal whose message carries request text',
      'POST',
      EXPORTS,
      CSRF_HEADERS,
      new ReportingDomainError('invalidParameters', 'reason-probe'),
      400,
      'request rejected: invalidParameters',
    ],
    ['a fixture forbidden', 'GET', EXPORTS, {}, new FixtureApiError('forbidden'), 403, 'request denied: forbidden'],
    ['a value PostgreSQL cannot store', 'POST', EXPORTS, CSRF_HEADERS, NUL_REFUSAL, 400, 'request rejected: 22021'],
    ['an unknown definition', 'POST', EXPORTS, CSRF_HEADERS, new ReportingDomainError('notFound'), 404, null],
  ])('logs %s with its fixed reason, if any, ahead of the completion line', async (_case, method, url, csrf, rejection, status, warning) => {
    if (rejection !== undefined) {
      vi.mocked(createExportJob).mockRejectedValueOnce(rejection);
      vi.mocked(listExportJobs).mockRejectedValueOnce(rejection);
    }
    const before = logLines.length;

    const res = await inject(method, url, csrf, method === 'POST' ? CREATE_BODY : undefined);
    const lines = logLines.slice(before);

    expect(res.statusCode).toBe(status);
    expect(lines.filter(({ severity, message }) => severity === 'WARNING' || message === 'request completed').map(({ severity, message }) => [severity, message])).toStrictEqual([
      ...(warning === null ? [] : [['WARNING', warning]]),
      ['INFO', 'request completed'],
    ]);
    expect(lines.filter(({ severity }) => severity === 'ERROR')).toEqual([]);
    for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
    expect(JSON.stringify(lines)).not.toMatch(/reason-probe|invalid byte sequence|0x00/);
  });
});
