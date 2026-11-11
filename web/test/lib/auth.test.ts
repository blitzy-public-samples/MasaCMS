// Tests of web's inbound credential checks and auth runtime over the platform test keys.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  LOCAL_SECRET_FILES,
  LOCAL_USER_TOKEN,
  Roles,
  localSecretPath,
  rolesForService,
  type AuthDenialReason,
  type ManagedTransport,
} from '@opt2/platform/auth';
import { loadEnv } from '@opt2/platform/service-kit';
import {
  TENANT_A,
  mintServiceToken,
  mintUserToken,
  testJwks,
  testVerifier,
  writeTestSecrets,
} from '@opt2/platform/testing';
import {
  GATEWAY_CALLER,
  WebAuthError,
  authenticateRequest,
  isAuthenticated,
  setWebAuthRuntimeForTests,
  webAuthRuntime,
} from '@/lib/auth';
import { setWebEnvForTests, webEnvSchema, type WebEnv } from '@/lib/env';
import { SUBJECTS, userTokenFor, type WebTestSubject } from '../helpers/tokens';

const JWKS_URL = 'http://127.0.0.1:8111/.well-known/jwks.json';
const PATH = '/admin/cusers/list';
const USER_ID = 'qa-user';
const MANAGED: readonly ManagedTransport[] = ['pubsub-push', 'cloud-tasks'];

let root: string;
let stateDir: string;
let fetchSpy: MockInstance<typeof fetch>;
let restoreEnv: () => void;
let restoreRuntime: () => void;

/** Web environment whose state directory is `dir`. */
function webEnvFor(dir: string, mode: 'local' | 'cloud' = 'local'): WebEnv {
  return loadEnv(webEnvSchema, {
    NODE_ENV: 'test',
    PORT: '8101',
    OPT2_ENV: mode,
    OPT2_STATE_DIR: dir,
    OPT2_JWKS_URL: JWKS_URL,
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_GATEWAY_URL: 'http://127.0.0.1:8100',
    GOOGLE_CLOUD_PROJECT: mode === 'cloud' ? 'opt2-test' : undefined,
    TZ: 'UTC',
  });
}

/** `X-Serverless-Authorization` value of `caller` addressed to `audience`. */
async function invocation(caller: string, audience = 'web'): Promise<string> {
  return `Bearer ${await mintServiceToken({ caller, audience })}`;
}

/** Tenant-a system-user token. */
function userToken(claims: { iss?: string; aud?: string; iat?: number; exp?: number } = {}): Promise<string> {
  return mintUserToken({ sub: USER_ID, site: TENANT_A.siteId, roles: [Roles.systemUser], ...claims });
}

/** User token of a subject that has one. */
async function subjectToken(subject: WebTestSubject): Promise<string> {
  const token = await userTokenFor(subject);
  if (token === undefined) {
    throw new TypeError(`${subject.key} has no user token`);
  }
  return token;
}

/** `token` with its claims raised to `s2`, keeping the original signature. */
function tampered(token: string): string {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  const forged = Buffer.from(JSON.stringify({ ...claims, roles: [Roles.s2], s2: true })).toString('base64url');
  return [header, forged, signature].join('.');
}

/** Headers of a gateway request carrying `authorization`. */
async function gatewayWith(authorization: string): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: await invocation('gateway'), authorization };
}

const now = (): number => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-web-auth-'));
  stateDir = path.join(root, 'state');
  await writeTestSecrets(stateDir);
  // Web's runtime builds without the push key.
  await rm(localSecretPath(stateDir, LOCAL_SECRET_FILES.pubsubPushKey));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  const jwks = await testJwks();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(Response.json(jwks)));
  restoreEnv = setWebEnvForTests(webEnvFor(stateDir));
  restoreRuntime = setWebAuthRuntimeForTests(undefined);
});

afterEach(() => {
  restoreRuntime();
  restoreEnv();
  vi.restoreAllMocks();
});

describe('authenticateRequest', () => {
  it('accepts the gateway without a user', async () => {
    const auth = await authenticateRequest(
      new Headers({ 'X-Serverless-Authorization': await invocation('gateway') }),
      PATH,
    );

    expect(auth).toEqual({ caller: { name: GATEWAY_CALLER, roles: rolesForService(GATEWAY_CALLER) } });
    expect(isAuthenticated(auth)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([SUBJECTS.admin, SUBJECTS[Roles.timesheetsEmployee]])(
    'accepts the gateway with the $key user token',
    async (subject) => {
      const token = await subjectToken(subject);
      const auth = await authenticateRequest(new Headers(await gatewayWith(`Bearer ${token}`)), PATH);

      expect(auth).toMatchObject({
        caller: { name: GATEWAY_CALLER },
        user: { sub: subject.sub, site: subject.site, tid: subject.tid, roles: [...subject.roles], s2: subject.s2 },
        userToken: token,
      });
      expect(isAuthenticated(auth)).toBe(true);
      expect(isAuthenticated({ caller: auth.caller, user: auth.user })).toBe(false);
      expect(fetchSpy).toHaveBeenCalledWith(JWKS_URL, expect.anything());
    },
  );

  // authenticateRequest refuses invocation-credential failures with 403 and user-token failures with 401.
  it.each<{
    refusal: string;
    headers: () => Promise<Record<string, string>>;
    status: 401 | 403;
    reason: AuthDenialReason;
  }>([
    { refusal: 'no credential', headers: async () => ({}), status: 403, reason: 'missing-credential' },
    {
      refusal: 'a user token alone',
      headers: async () => ({ authorization: `Bearer ${await userToken()}` }),
      status: 403,
      reason: 'missing-credential',
    },
    {
      refusal: 'a user token as the invocation credential',
      headers: async () => ({ [INVOCATION_HEADER]: `Bearer ${await userToken()}` }),
      status: 403,
      reason: 'invalid-credential',
    },
    {
      refusal: 'a garbage invocation credential',
      headers: async () => ({ [INVOCATION_HEADER]: 'Bearer garbage' }),
      status: 403,
      reason: 'invalid-credential',
    },
    {
      refusal: 'a non-bearer invocation credential',
      headers: async () => ({ [INVOCATION_HEADER]: 'Basic opaque' }),
      status: 403,
      reason: 'wrong-scheme',
    },
    {
      refusal: 'an invocation credential for another audience',
      headers: async () => ({ [INVOCATION_HEADER]: await invocation('gateway', 'people') }),
      status: 403,
      reason: 'invalid-credential',
    },
    {
      refusal: 'a managed invoker',
      headers: async () => ({ [INVOCATION_HEADER]: await invocation('tasks-invoker') }),
      status: 403,
      reason: 'wrong-scheme',
    },
    {
      refusal: 'a garbage user token',
      headers: () => gatewayWith('Bearer garbage'),
      status: 401,
      reason: 'invalid-credential',
    },
    {
      refusal: 'a tampered user token',
      headers: async () => gatewayWith(`Bearer ${tampered(await userToken())}`),
      status: 401,
      reason: 'invalid-credential',
    },
    {
      refusal: 'a non-bearer user credential',
      headers: () => gatewayWith('Basic opaque'),
      status: 401,
      reason: 'wrong-scheme',
    },
    {
      refusal: 'a user token for another audience',
      headers: async () => gatewayWith(`Bearer ${await userToken({ aud: 'opt2-other' })}`),
      status: 401,
      reason: 'invalid-credential',
    },
    {
      refusal: 'a user token from another issuer',
      headers: async () => gatewayWith(`Bearer ${await userToken({ iss: 'x' })}`),
      status: 401,
      reason: 'invalid-credential',
    },
    {
      refusal: 'an expired user token',
      headers: async () => gatewayWith(`Bearer ${await userToken({ iat: now() - 600, exp: now() - 300 })}`),
      status: 401,
      reason: 'expired-credential',
    },
  ])('answers $status for $refusal', async ({ headers, status, reason }) => {
    const error = await authenticateRequest(new Headers(await headers()), PATH).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WebAuthError);
    expect(error).toMatchObject({ name: 'WebAuthError', status, reason });
    expect((error as WebAuthError).message).toBe(`Web refused the request (${status}): ${reason}`);
    expect((error as WebAuthError).cause).toBeInstanceOf(AuthDenial);
    expect((error as WebAuthError).cause).toMatchObject({ statusCode: 401, reason });
  });

  it('answers 403 for another caller without verifying its user token', async () => {
    const verify = vi.spyOn((await webAuthRuntime()).userVerifier, 'verify');
    const headers = new Headers({
      [INVOCATION_HEADER]: await invocation('people'),
      authorization: `Bearer ${await userToken()}`,
    });
    const error = await authenticateRequest(headers, PATH).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WebAuthError);
    expect(error).toMatchObject({ status: 403, reason: 'forbidden' });
    expect((error as WebAuthError).cause).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('propagates a key-source failure unchanged', async () => {
    const failure = new TypeError('fetch failed');
    fetchSpy.mockRejectedValue(failure);
    const headers = new Headers(await gatewayWith(`Bearer ${await userToken()}`));

    await expect(authenticateRequest(headers, PATH)).rejects.toBe(failure);
  });
});

describe('webAuthRuntime', () => {
  it('memoises the built runtime', async () => {
    const runtime = webAuthRuntime();

    expect(webAuthRuntime()).toBe(runtime);
    await expect(runtime).resolves.toMatchObject({ transports: { service: { transport: 'service' } } });
  });

  it.each((['local', 'cloud'] as const).flatMap((mode) => MANAGED.map((transport) => ({ mode, transport }))))(
    'refuses every $transport delivery in a $mode runtime',
    async ({ mode, transport }) => {
      setWebEnvForTests(webEnvFor(stateDir, mode));
      const authenticator = (await webAuthRuntime()).transports[transport];

      expect(authenticator.transport).toBe(transport);
      await expect(authenticator.authenticate({ headers: {}, path: PATH }, { optional: false })).rejects.toMatchObject(
        { statusCode: 401, reason: 'wrong-scheme' },
      );
    },
  );

  it('drops a failed build so the next call builds again', async () => {
    const dir = await mkdtemp(path.join(root, 'keyless-'));
    setWebEnvForTests(webEnvFor(dir));
    const failed = webAuthRuntime();
    await expect(failed).rejects.toMatchObject({ code: 'ENOENT' });

    await writeTestSecrets(dir);
    const rebuilt = webAuthRuntime();

    expect(rebuilt).not.toBe(failed);
    await expect(rebuilt).resolves.toMatchObject({ transports: { service: { transport: 'service' } } });
  });

  it('keeps a runtime installed while a failed build was pending', async () => {
    setWebEnvForTests(webEnvFor(await mkdtemp(path.join(root, 'keyless-'))));
    const failed = webAuthRuntime();
    const installed = testVerifier('web');
    setWebAuthRuntimeForTests(installed);

    await expect(failed).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(webAuthRuntime()).resolves.toBe(installed);
  });

  it('mints web invocation credentials', async () => {
    const headers = await (await webAuthRuntime()).invocationMinter.headersFor({ name: 'gateway' });

    expect(Object.keys(headers)).toEqual([INVOCATION_HEADER]);
    await expect(
      testVerifier('gateway').invocationVerifier.verify(String(headers[INVOCATION_HEADER])),
    ).resolves.toMatchObject({ name: 'web' });
  });
});

describe('setWebAuthRuntimeForTests', () => {
  it('installs a setup and restores the previous runtime', async () => {
    const built = webAuthRuntime();
    const installed = testVerifier('web');
    const restore = setWebAuthRuntimeForTests(installed);

    await expect(webAuthRuntime()).resolves.toBe(installed);
    restore();
    expect(webAuthRuntime()).toBe(built);
    await built;
  });

  it('rebuilds from the environment when given undefined', async () => {
    const installed = testVerifier('web');
    setWebAuthRuntimeForTests(installed);
    setWebAuthRuntimeForTests(undefined);

    await expect(webAuthRuntime()).resolves.not.toBe(installed);
  });
});
