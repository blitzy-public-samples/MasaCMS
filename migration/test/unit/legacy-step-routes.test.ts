// Unit tests for the `legacyStepRun` route over a fake window service: declaration, passthrough, the legacy 400, 503 and 504, and auth.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { REDACTED, createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { LEGACY_STEP_ROUTES, registerLegacyStepRoutes } from '../../src/routes/legacy-steps.js';
import { WindowRefusedError, type LegacyStepInput, type LegacyStepResult } from '../../src/windows/index.js';
import { LegacyStepDeadlineError, LegacyStepFailedError } from '../../src/windows/legacy-steps.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const PATH = '/internal/v1/legacy-steps';
const WINDOW_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
// Free text no redaction pattern masks, so it reaches a log only if interpolated there.
const FREE_TEXT = ['Jane', 'Doe', 'salary', '91250'].join(' ');
const STEP = {
  step: 'purgeDisplayWindow',
  theTime: '2026-06-30 12:00:00.000',
  lastMonitored: '2026-06-30 11:45:00.000',
  deadlineAt: '2026-06-30T12:10:00.000Z',
} as const;
const SERVER_TIME = '2026-06-30T12:00:00.123Z';
// The body names no `method`, which legacy reports as `invalid` (jsonApiUtility.cfc:1319-1322).
const UNAVAILABLE_ENVELOPE = { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } };

const runLegacyStep = vi.fn<(input: LegacyStepInput) => Promise<LegacyStepResult>>();
const logLines: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = await createService({
    name: 'migration',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8102',
      OPT2_SERVICE_NAME: 'migration',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('migration'),
    logger: createLogger({
      service: 'migration',
      version: '1.0.0',
      env: 'local',
      destination: {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    }),
  });
  registerLegacyStepRoutes(app, { windows: { runLegacyStep } });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  runLegacyStep.mockReset();
});

/** Invocation-credential headers of `caller`, optionally with a user token. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-admin', site: 'default', roles: [Roles.s2] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}`;
  return headers;
}

/** Injects the POST and, for a declared status, checks the answer against the contract. */
async function post(payload: unknown, headers?: Record<string, string>) {
  const sent = headers ?? (await headersFor('programs-sites'));
  const res = await app.inject({ method: 'POST', url: PATH, headers: { ...sent, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  if (res.statusCode !== 500) {
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  }
  return res;
}

describe('route declaration', () => {
  it('matches the contract operation, with the site check off', () => {
    const operation = OPENAPI.paths[PATH]?.post ?? {};
    expect(LEGACY_STEP_ROUTES).toEqual([{ operationId: operation.operationId, method: 'POST', path: PATH, url: PATH }]);
    expect(collectRouteMatrix(app).routes.filter((route) => route.url === PATH)).toEqual([
      expect.objectContaining({
        method: 'POST',
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
        siteCheck: operation['x-opt2-site-check'],
      }),
    ]);
  });
});

describe('answers', () => {
  it.each([
    ['an unwindowed step', STEP, { step: STEP.step, completed: true, serverTime: SERVER_TIME }],
    [
      'a per-site step run in a window',
      { ...STEP, step: 'trackBounces', siteId: 'tenant-a' },
      { step: 'trackBounces', completed: true, serverTime: SERVER_TIME, siteId: 'tenant-a', windowId: WINDOW_ID },
    ],
  ] as const)('passes %s to the window service unchanged and answers its body', async (_label, payload, response) => {
    runLegacyStep.mockResolvedValue({ response, windowState: 'closed' });

    const res = await post(payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(response);
    expect(runLegacyStep).toHaveBeenCalledTimes(1);
    expect(runLegacyStep).toHaveBeenCalledWith(payload);
  });

  it.each<[string, unknown]>([
    ['an unknown step', { ...STEP, step: 'publishBySchedule' }],
    ['a missing deadline', { step: STEP.step, theTime: STEP.theTime, lastMonitored: STEP.lastMonitored }],
    ['a deadline that is not a date-time', { ...STEP, deadlineAt: '2026-06-30 12:10:00' }],
    ['an empty run time', { ...STEP, theTime: '' }],
    ['an empty site id', { ...STEP, siteId: '' }],
    ['a caller-supplied write set', { ...STEP, units: ['people.person'] }],
    ['a per-site step without a site', { ...STEP, step: 'feedAutoImport' }],
    ['a body that is not an object', [STEP]],
  ])('answers %s with the legacy 400 and runs nothing', async (_label, payload) => {
    const res = await post(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(runLegacyStep).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused window', () => new WindowRefusedError(WINDOW_ID, 'lease-unavailable', new Error('leased by a transition'))],
    ['a step that did not complete', () => new LegacyStepFailedError('purgeDisplayWindow', undefined, WINDOW_ID, new Error('bridge 500'))],
  ])('answers %s with the legacy 503', async (_label, failure) => {
    runLegacyStep.mockRejectedValue(failure());

    const res = await post(STEP);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(UNAVAILABLE_ENVELOPE);
  });

  it.each<[string, Record<string, unknown>, string | undefined, string | undefined, string]>([
    ['a step without a site or window', STEP, undefined, undefined, 'Legacy site-monitor step purgeDisplayWindow did not complete before its deadline'],
    [
      'a site step in a window, whose site id never reaches the log',
      { ...STEP, step: 'trackBounces', siteId: 'tenant-a' },
      `tenant-a\n    at injected (${FREE_TEXT})`,
      WINDOW_ID,
      `Legacy site-monitor step trackBounces in window ${WINDOW_ID} did not complete before its deadline`,
    ],
  ])(
    'answers a passed deadline of %s with the 504 server_error envelope and its ETag, logging a fixed line',
    async (_label, body, siteId, windowId, line) => {
      const step = body.step as LegacyStepInput['step'];
      runLegacyStep.mockRejectedValue(new LegacyStepDeadlineError(step, siteId, windowId, new Error(`bridge timed out for ${FREE_TEXT}`)));
      logLines.length = 0;

      const res = await post(body);

      expect(res.statusCode).toBe(504);
      expect(res.json()).toEqual(UNAVAILABLE_ENVELOPE);
      expect(res.headers.etag).toMatch(/^[0-9A-F]+$/);
      const records = logLines.map((text) => JSON.parse(text) as { severity: string; message: string; error?: unknown });
      expect(records.filter((record) => record.message === line)).toEqual([
        expect.objectContaining({ severity: 'WARNING', error: expect.objectContaining({ type: 'LegacyStepDeadlineError', message: REDACTED }) }),
      ]);
      expect(logLines.join('')).not.toContain(FREE_TEXT);
      expect(logLines.join('')).not.toContain('tenant-a');
    },
  );

  it('lets any other failure reach the error handler as the 500', async () => {
    runLegacyStep.mockRejectedValue(new Error('inventory records no site-monitor step'));

    const res = await post(STEP);

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('auth', () => {
  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['no credential', () => Promise.resolve({}), 401],
    ['a user token alone', () => headersFor(null, true), 401],
    ['the gateway workload', () => headersFor('gateway'), 403],
    ['the operator', () => headersFor('operator'), 403],
    ['a user token beside the gateway credential', () => headersFor('gateway', true), 403],
  ])('refuses %s before the window service runs', async (_label, credentials, status) => {
    const res = await post(STEP, await credentials());

    expect(res.statusCode).toBe(status);
    expect(runLegacyStep).not.toHaveBeenCalled();
  });
});
