import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  type AuthOverrides,
  type TransportAuthenticator,
  type UserClaims,
} from '../../src/auth/index.js';
import { LEGACY_ERROR_MAP } from '../../src/legacy-compat/index.js';
import { createLogger } from '../../src/logging/index.js';
import { tenantIdForSite } from '../../src/tenancy/index.js';
import { ServiceUnavailableError } from '../../src/service-kit/client.js';
import { createService } from '../../src/service-kit/create-service.js';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  csrfPreHandler,
  csrfTokenFrom,
  type CsrfConsumeRequest,
} from '../../src/service-kit/csrf-hook.js';
import { loadEnv, type BaseEnv } from '../../src/service-kit/env.js';

const USER_TOKEN = 'user-token-a';
const NO_SESSION_TOKEN = 'user-token-no-session';
const SERVICE_CREDENTIAL = 'Bearer svc-gateway';
const EXPIRES = '260630120000123';

const CLAIMS: UserClaims = {
  iss: 'opt2-local-identity',
  aud: 'opt2-local',
  sub: 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90',
  sid: 'session-1',
  tid: tenantIdForSite('tenant-a'),
  site: 'tenant-a',
  roles: ['s2'],
  s2: true,
  epoch: 1,
  iat: 1_700_000_000,
  exp: 4_000_000_000,
};

function managedTransport(transport: 'pubsub-push' | 'cloud-tasks'): TransportAuthenticator {
  return { transport, authenticate: async () => ({ service: { name: `${transport}-invoker`, roles: [] } }) };
}

const OVERRIDES: AuthOverrides = {
  userVerifier: {
    async verify(token) {
      if (token === USER_TOKEN) return CLAIMS;
      if (token === NO_SESSION_TOKEN) return { ...CLAIMS, sid: '' };
      throw AuthDenial.invalidToken();
    },
  },
  invocationVerifier: {
    async verify(header) {
      if (header !== SERVICE_CREDENTIAL) throw AuthDenial.unauthenticated('invalid-credential');
      return { name: 'gateway', roles: ['service:gateway'] };
    },
  },
  invocationMinter: { headersFor: async (target) => ({ [INVOCATION_HEADER]: `Bearer svc-${target.name}` }) },
  transports: { 'pubsub-push': managedTransport('pubsub-push'), 'cloud-tasks': managedTransport('cloud-tasks') },
};

const AUTHENTICATED = { [INVOCATION_HEADER]: SERVICE_CREDENTIAL, authorization: `Bearer ${USER_TOKEN}` };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** One consume call as the stub identity received it. */
interface ConsumeCall {
  method?: string;
  url?: string;
  authorization?: string;
  credential?: string | string[];
  body: CsrfConsumeRequest;
}

/** Stub identity answering every call with the current `answer`. */
interface StubIdentity {
  origin: string;
  calls: ConsumeCall[];
  answer: { status: number; body: unknown };
  server: Server;
}

let identity: StubIdentity;
const apps: FastifyInstance[] = [];

async function startIdentity(): Promise<StubIdentity> {
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      stub.calls.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        credential: req.headers[INVOCATION_HEADER],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as CsrfConsumeRequest,
      });
      res.writeHead(stub.answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(stub.answer.body));
    });
  });
  const stub: StubIdentity = { origin: '', calls: [], answer: { status: 200, body: { valid: true } }, server };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

function envFor(identityOrigin: string): BaseEnv {
  return loadEnv(undefined, {
    PORT: '26011',
    OPT2_SERVICE_NAME: 'strategies-content',
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-csrf-hook-unit-unused'),
    OPT2_SERVICE_URLS: JSON.stringify({ [IDENTITY_SERVICE]: identityOrigin }),
    TZ: 'UTC',
  });
}

const handler = vi.fn(async () => 'saved');

/** An app with `/hooked` (CSRF hook, context from `?ctx`), `/rerender` (hook with onReject), `/plain` and `/tokens`. */
async function build(identityOrigin = identity.origin): Promise<FastifyInstance> {
  const logger = createLogger({
    service: 'strategies-content',
    version: '1.0.0',
    env: 'local',
    destination: { write: () => undefined },
  });
  const app = await createService({
    name: 'strategies-content',
    version: '1.0.0',
    env: envFor(identityOrigin),
    verifierOverride: OVERRIDES,
    logger,
  });
  apps.push(app);
  const contextOf = (request: FastifyRequest): string => (request.query as { ctx?: string }).ctx ?? 'route-context';
  app.post('/hooked', { config: { opt2: { requires: ['s2'] } }, preHandler: csrfPreHandler({ contextOf }) }, handler);
  app.post('/public-hooked', { config: { opt2: { public: true } }, preHandler: csrfPreHandler({ contextOf }) }, handler);
  app.post(
    '/rerender',
    {
      config: { opt2: { requires: ['s2'] } },
      preHandler: csrfPreHandler({
        contextOf,
        onReject: async (_request, reply) => reply.code(200).type('text/html').send('<form>re-rendered</form>'),
      }),
    },
    handler,
  );
  app.post('/plain', { config: { opt2: { requires: ['s2'] } } }, handler);
  app.post('/tokens', { config: { opt2: { public: true } } }, async (request) => csrfTokenFrom(request));
  return app;
}

function multipart(boundary: string, fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return `${parts.join('')}--${boundary}--\r\n`;
}

beforeEach(async () => {
  identity = await startIdentity();
  handler.mockClear();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await new Promise((resolve) => identity.server.close(resolve));
  vi.restoreAllMocks();
});

describe('csrf consume contract', () => {
  it('names the identity consume route', () => {
    expect(CSRF_CONSUME_PATH).toBe('/internal/v1/csrf/consume');
    expect(IDENTITY_SERVICE).toBe('identity');
  });
});

describe('csrfTokenFrom', () => {
  it.each([
    ['the query', '?csrf_token=Q&csrf_token_expires=QE', FORM, '', {}, { token: 'Q', expires: 'QE' }],
    ['the form over the query', '?csrf_token=Q&csrf_token_expires=QE', FORM, 'csrf_token=F', {}, { token: 'F', expires: 'QE' }],
    ['form fields ignoring case', '', FORM, 'CSRF_TOKEN=F&Csrf_Token_Expires=FE', {}, { token: 'F', expires: 'FE' }],
    [
      'the headers over the form',
      '',
      FORM,
      'csrf_token=F&csrf_token_expires=FE',
      { 'X-CSRF_TOKEN': 'H', 'x-csrf_token_expires': 'HE' },
      { token: 'H', expires: 'HE' },
    ],
    [
      'a JSON body, simple values as strings',
      '?csrf_token=Q',
      { 'content-type': 'application/json' },
      JSON.stringify({ csrf_token: 'J', csrf_token_expires: 260630120000123 }),
      {},
      { token: 'J', expires: '260630120000123' },
    ],
    [
      'nothing for a non-string JSON value',
      '?csrf_token=Q&csrf_token_expires=QE',
      { 'content-type': 'application/json' },
      JSON.stringify({ csrf_token: { nested: 'J' }, csrf_token_expires: ['E'] }),
      {},
      {},
    ],
    ['a repeated field comma-joined', '?csrf_token=A&csrf_token=B&csrf_token_expires=E', FORM, '', {}, { token: 'A,B', expires: 'E' }],
    ['nothing for empty values', '?csrf_token=&csrf_token_expires=', FORM, '', {}, {}],
    ['an empty header over a form token', '', FORM, 'csrf_token=F&csrf_token_expires=FE', { 'x-csrf_token': '' }, { expires: 'FE' }],
  ])('reads %s', async (_label, query, contentType, payload, headers, expected) => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: `/tokens${query}`, headers: { ...contentType, ...headers }, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual(expected);
  });

  it('reads multipart field values', async () => {
    const app = await build();
    const boundary = 'csrf-boundary';
    const res = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, { csrf_token: 'M', csrf_token_expires: 'ME' }),
    });
    expect(res.json()).toStrictEqual({ token: 'M', expires: 'ME' });
  });

  it('takes the first value of a repeated header', () => {
    const request = { query: {}, body: undefined, headers: { 'x-csrf_token': ['H1', 'H2'] } } as unknown as FastifyRequest;
    expect(csrfTokenFrom(request)).toStrictEqual({ token: 'H1' });
  });
});

describe('csrfPreHandler', () => {
  it('runs the handler once identity accepts, sending the session, header token and route context', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/hooked?ctx=approvalchain',
      headers: { ...AUTHENTICATED, ...FORM, 'x-csrf_token': 'HEADER-TOKEN' },
      payload: `csrf_token=FORM-TOKEN&csrf_token_expires=${EXPIRES}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('saved');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(identity.calls).toStrictEqual([
      {
        method: 'POST',
        url: CSRF_CONSUME_PATH,
        authorization: `Bearer ${USER_TOKEN}`,
        credential: 'Bearer svc-identity',
        body: { sessionId: 'session-1', token: 'HEADER-TOKEN', expires: EXPIRES, context: 'approvalchain' },
      },
    ]);
  });

  it.each([
    ['valid false', { valid: false }],
    ['an empty verdict', {}],
  ])('answers the JSON API invalidTokens 400 for %s', async (_label, verdict) => {
    identity.answer = { status: 200, body: verdict };
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/hooked',
      headers: { ...AUTHENTICATED, ...FORM },
      payload: `csrf_token=USED&csrf_token_expires=${EXPIRES}`,
    });
    const { status, code, message } = LEGACY_ERROR_MAP.invalidTokens;
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code, message: 'Invalid CSRF tokens' } });
    expect(message).toBe('Invalid CSRF tokens');
    expect(handler).not.toHaveBeenCalled();
    expect(identity.calls).toHaveLength(1);
  });

  it('answers with onReject and skips the handler when identity rejects', async () => {
    identity.answer = { status: 200, body: { valid: false } };
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/rerender',
      headers: { ...AUTHENTICATED, ...FORM },
      payload: `csrf_token=USED&csrf_token_expires=${EXPIRES}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<form>re-rendered</form>');
    expect(handler).not.toHaveBeenCalled();
    expect(identity.calls).toHaveLength(1);
  });

  it.each([
    ['no token', '/hooked', AUTHENTICATED, `csrf_token_expires=${EXPIRES}`],
    ['no expiry', '/hooked', AUTHENTICATED, 'csrf_token=T'],
    ['an empty sid claim', '/hooked', { ...AUTHENTICATED, authorization: `Bearer ${NO_SESSION_TOKEN}` }, `csrf_token=T&csrf_token_expires=${EXPIRES}`],
    ['no user token', '/public-hooked', { [INVOCATION_HEADER]: SERVICE_CREDENTIAL }, `csrf_token=T&csrf_token_expires=${EXPIRES}`],
  ])('rejects %s without calling identity', async (_label, url, headers, payload) => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: { ...headers, ...FORM }, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid CSRF tokens' } });
    expect(handler).not.toHaveBeenCalled();
    expect(identity.calls).toHaveLength(0);
  });

  it('fails closed with the legacy 503 when identity answers 500', async () => {
    identity.answer = { status: 500, body: { error: 'boom' } };
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/hooked',
      headers: { ...AUTHENTICATED, ...FORM },
      payload: `csrf_token=T&csrf_token_expires=${EXPIRES}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'server_error', message: 'Unhandled Exception' } });
    expect(handler).not.toHaveBeenCalled();
    expect(identity.calls).toHaveLength(1);
  });

  it('fails closed with the legacy 503 when identity refuses the connection', async () => {
    const closed = await startIdentity();
    await new Promise((resolve) => closed.server.close(resolve));
    const app = await build(closed.origin);
    const res = await app.inject({
      method: 'POST',
      url: '/hooked',
      headers: { ...AUTHENTICATED, ...FORM },
      payload: `csrf_token=T&csrf_token_expires=${EXPIRES}`,
    });
    expect(res.statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates a client timeout unchanged as the legacy 503, after exactly one call', async () => {
    const app = await build();
    const timeout = new ServiceUnavailableError(IDENTITY_SERVICE, new DOMException('timed out', 'TimeoutError'));
    const request = vi.spyOn(app.opt2.client, 'request').mockRejectedValue(timeout);
    const res = await app.inject({
      method: 'POST',
      url: '/hooked',
      headers: { ...AUTHENTICATED, ...FORM },
      payload: `csrf_token=T&csrf_token_expires=${EXPIRES}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('never calls identity for a route without the hook', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/plain',
      headers: { ...AUTHENTICATED, ...FORM, 'x-csrf_token': 'T' },
      payload: `csrf_token=T&csrf_token_expires=${EXPIRES}`,
    });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(identity.calls).toHaveLength(0);
  });
});
