// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** CSRF consumption of the `/v1/surveys` writes through app.inject over domain doubles: context, single use, refusals and reads. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
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
import type { TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { applyBulkTarget } from '../../src/domain/bulk-target.js';
import { scheduleSurvey } from '../../src/domain/schedule.js';
import { getSurvey } from '../../src/domain/surveys.js';
import type { SurveyDetail } from '../../src/repo/queries.js';
import type { SurveysRepository } from '../../src/repo/repository.js';
import { registerV1Routes } from '../../src/routes/v1.js';

vi.mock('../../src/domain/schedule.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/domain/schedule.js')>()),
  scheduleSurvey: vi.fn(),
}));

vi.mock('../../src/domain/bulk-target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/domain/bulk-target.js')>()),
  applyBulkTarget: vi.fn(),
}));

vi.mock('../../src/domain/surveys.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/domain/surveys.js')>()),
  getSurvey: vi.fn(),
}));

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const USER_ID = '11111111-2222-3333-4444555566667777';
const SESSION_ID = '0F1E2D3C-4B5A-6978-8796A5B4C3D2E1F0';
const SURVEY_ID = '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const OTHER_SURVEY_ID = '9F8E7D6C-5B4A-3928-1706F5E4D3C2B1A0';
const T0 = new Date(2026, 5, 30, 9, 0, 0, 0);
const CSRF_TOKEN = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const OTHER_TOKEN = 'B'.repeat(32);
const CSRF_EXPIRES = '260630120000123';
const CSRF_HEADERS: Readonly<Record<string, string>> = { 'x-csrf_token': CSRF_TOKEN, 'x-csrf_token_expires': CSRF_EXPIRES };
const INVALID_TOKENS = { code: 'invalid_request', message: 'Invalid CSRF tokens' };
const SITE_QUERY = `?siteid=${TENANT_A.siteId}`;

const DETAIL: SurveyDetail = {
  survey: {
    tenant_id: TENANT_A.tenantId,
    survey_id: SURVEY_ID,
    siteid: TENANT_A.siteId,
    title: 'Survey',
    status: 'SCHEDULED',
    created: T0,
    createdbyid: USER_ID,
    lastupdate: T0,
    lastupdatebyid: USER_ID,
    launched_at: null,
  },
  schedule: {
    schedule_id: OTHER_SURVEY_ID,
    survey_id: SURVEY_ID,
    launch_at: new Date(2026, 6, 1, 9, 0, 0, 0),
    schedule_version: 1,
    task_name: `opt2-survey-${SURVEY_ID}-launch`,
    created: T0,
  },
  reminders: [],
  targets: [],
};

type Write = 'scheduleSurvey' | 'applyBulkTarget';

/** Each write with its path tail, body and the domain function it calls. */
const WRITES: ReadonlyArray<readonly [string, string, Record<string, unknown>, Write]> = [
  ['POST', '/schedule', { launchAt: '2026-07-01T09:00:00' }, 'scheduleSurvey'],
  ['POST', '/targets/bulk', { targets: [{ siteId: 'tenant-b' }] }, 'applyBulkTarget'],
];

const DOMAIN: Readonly<Record<Write, () => Mock>> = {
  scheduleSurvey: () => vi.mocked(scheduleSurvey) as Mock,
  applyBulkTarget: () => vi.mocked(applyBulkTarget) as Mock,
};

describe('surveys /v1 write CSRF', () => {
  const db = {} as TenantDb;
  let app: FastifyInstance;
  let outbound: Mock;
  /** Context identity issued each token for; a token is valid for that context alone. */
  let issued: Map<string, string>;
  /** `session token context` keys identity has consumed. */
  let consumed: Set<string>;
  let identityStatus: number;

  /** Identity's consume verdict: valid once per session, token and context, for the context the token was issued for. */
  function consume(request: ServiceRequest): ServiceResponse {
    if (request.service !== IDENTITY_SERVICE || request.method !== 'POST' || request.path !== CSRF_CONSUME_PATH) {
      throw new Error(`the /v1 writes call no other service: ${request.method} ${request.service} ${request.path}`);
    }
    const { sessionId, token, context } = request.json as CsrfConsumeRequest;
    const key = `${sessionId} ${token} ${context}`;
    const valid = identityStatus === 200 && issued.get(token) === context && !consumed.has(key);
    if (valid) consumed.add(key);
    return { status: identityStatus, headers: {}, body: identityStatus === 200 ? { valid } : undefined };
  }

  /** Injects one gateway call as a tenant-a surveys manager and checks the answer against the contract. */
  async function inject(method: string, url: string, csrf: Readonly<Record<string, string>>, payload?: Record<string, unknown>) {
    const headers: Record<string, string> = {
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'surveys' })}`,
      authorization: `Bearer ${await mintUserToken({ site: TENANT_A.siteId, roles: [Roles.surveysManager], sub: USER_ID, sid: SESSION_ID })}`,
      ...csrf,
    };
    const res = await app.inject({ method: method as 'GET' | 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  const writeUrl = (tail: string, surveyId = SURVEY_ID): string => `/v1/surveys/${surveyId}${tail}${SITE_QUERY}`;

  beforeAll(async () => {
    const clock = fixedClock(T0);
    app = await createService({
      name: 'surveys',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8117',
        OPT2_SERVICE_NAME: 'surveys',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      clock,
      verifierOverride: testVerifier('surveys'),
      logger: createLogger({ service: 'surveys', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    await registerV1Routes(app, { db, repository: {} as SurveysRepository, clock });
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
      [CSRF_TOKEN, SURVEY_ID],
      [OTHER_TOKEN, OTHER_SURVEY_ID],
    ]);
    consumed = new Set();
    identityStatus = 200;
    for (const name of Object.keys(DOMAIN) as Write[]) DOMAIN[name]().mockReset();
    vi.mocked(scheduleSurvey).mockResolvedValue(DETAIL);
    vi.mocked(applyBulkTarget).mockResolvedValue({ inserted: 1, total: 1 });
    vi.mocked(getSurvey).mockReset().mockResolvedValue(DETAIL);
  });

  it.each(WRITES)("%s %s has identity consume the pair for the survey id as sent, in the token's session, first", async (method, tail, body, name) => {
    const res = await inject(method, writeUrl(tail), CSRF_HEADERS, body);

    expect(res.statusCode).toBe(200);
    expect(outbound.mock.calls).toEqual([
      [{ service: IDENTITY_SERVICE, method: 'POST', path: CSRF_CONSUME_PATH, json: { sessionId: SESSION_ID, token: CSRF_TOKEN, expires: CSRF_EXPIRES, context: SURVEY_ID } }],
    ]);
    expect(outbound.mock.invocationCallOrder[0]).toBeLessThan(DOMAIN[name]().mock.invocationCallOrder[0] ?? 0);
  });

  it.each(
    WRITES.flatMap(([method, tail, body, name]) =>
      (
        [
          ['no token', {}, 0],
          ['a token without its expiry', { 'x-csrf_token': CSRF_TOKEN }, 0],
          ["another survey's token", { 'x-csrf_token': OTHER_TOKEN, 'x-csrf_token_expires': CSRF_EXPIRES }, 1],
        ] as const
      ).map((c) => [method, tail, body, name, ...c] as const),
    ),
  )('%s %s answers %s with invalidTokens and writes nothing', async (method, tail, body, name, _case, csrf, consumeCalls) => {
    const res = await inject(method, writeUrl(tail), csrf, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: INVALID_TOKENS });
    expect(outbound).toHaveBeenCalledTimes(consumeCalls);
    expect(DOMAIN[name]()).not.toHaveBeenCalled();
  });

  it.each(WRITES)('%s %s accepts a token once and answers its replay with invalidTokens', async (method, tail, body, name) => {
    const first = await inject(method, writeUrl(tail), CSRF_HEADERS, body);
    const replay = await inject(method, writeUrl(tail), CSRF_HEADERS, body);

    expect([first.statusCode, replay.statusCode]).toEqual([200, 400]);
    expect(replay.json()).toMatchObject({ apiversion: 'v1', error: INVALID_TOKENS });
    expect(DOMAIN[name]()).toHaveBeenCalledTimes(1);
  });

  it.each(WRITES)('%s %s answers the legacy 503 and writes nothing when identity cannot consume the token', async (method, tail, body, name) => {
    identityStatus = 503;

    const res = await inject(method, writeUrl(tail), CSRF_HEADERS, body);

    expect(res.statusCode).toBe(503);
    expect(DOMAIN[name]()).not.toHaveBeenCalled();
  });

  it.each(WRITES)('%s %s refuses a siteid other than the token site before consuming the token', async (method, tail, body, name) => {
    const res = await inject(method, `/v1/surveys/${SURVEY_ID}${tail}?siteid=tenant-b`, CSRF_HEADERS, body);

    expect(res.statusCode).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
    expect(DOMAIN[name]()).not.toHaveBeenCalled();
  });

  it.each(['', '/targets'])('GET /v1/surveys/{surveyId}%s consumes no CSRF token, even one sent with it', async (tail) => {
    const res = await inject('GET', writeUrl(tail), CSRF_HEADERS);

    expect(res.statusCode).toBe(200);
    expect(outbound).not.toHaveBeenCalled();
    expect(getSurvey).toHaveBeenCalledTimes(1);
  });
});
