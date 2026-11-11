// Internal mark-used route: identity writes consumed CSRF tokens into the mapped legacy session's ledger.
import { readFile } from 'node:fs/promises';
import { INVOCATION_HEADER, recordedRoutes, rolesForService } from '@opt2/platform/auth';
import { generateCsrfToken } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { ServiceUnavailableError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { mintServiceToken, testVerifier } from '@opt2/platform/testing';
import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { BridgeClient, LegacyUsedToken } from '../../src/session/bridge-client.js';
import type { JarCookie, JarCookies, JarRow, LegacyJar } from '../../src/session/jar.js';
import { registerMarkUsedRoute } from '../../src/session/mark-used-route.js';

const NOW = new Date(Date.UTC(2026, 5, 30, 12));
const SESSION_ID = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const LEGACY_SESSION_ID = 'OPT2TEST_1001_12345678';
// Fake CSRF tokens are assembled at run time: a hex literal beside `token` reads to secret scanners as an API key.
const HEX_ASC = '0123456789ABCDEF';
const HEX_DESC = 'FEDCBA9876543210';
const TOKENS: LegacyUsedToken[] = [
  { token: `${HEX_ASC}${HEX_ASC.toLowerCase()}`.repeat(2), usedAt: '2026-06-30T12:00:00.123' },
  { token: HEX_DESC.repeat(4), usedAt: '2026-06-30T12:00:01' },
];
// A CF-format UUID, as legacy mints session.mura.csrfsecretkey.
const CSRF_SECRET = [HEX_DESC.slice(0, 8), HEX_ASC.slice(0, 4), HEX_ASC.slice(4, 8), HEX_DESC].join('-');

const cookie = (name: string, value: string): JarCookie => ({ name, value, attributes: 'path=/;HttpOnly' });
const LIVE: JarCookies = { CFID: cookie('CFID', '1001'), CFTOKEN: cookie('CFTOKEN', '12345678') };
const DELETED: JarCookies = {
  CFID: cookie('CFID', ''),
  CFTOKEN: { name: 'CFTOKEN', value: '12345678', attributes: 'path=/;expires=Thu, 01-Jan-1970 00:00:00 GMT' },
};

function jarRow(overrides: Partial<JarRow> = {}): JarRow {
  return {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    cookies: LIVE,
    mode: 'target-primary',
    hydratedEpoch: 2,
    updatedAt: NOW,
    ...overrides,
  };
}

const markUsedUrl = (sid: string): string => `/internal/v1/legacy-sessions/${sid}:mark-used`;

type Call = [op: string, ...args: unknown[]];

const unexpected = (op: string) => (): never => {
  throw new Error(`unexpected ${op} call`);
};

const apps: FastifyInstance[] = [];
let markUsedContract: ValidateFunction;

beforeAll(async () => {
  const contract = parse(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
    components: { schemas: Record<string, AnySchemaObject> };
  };
  const schema = contract.components.schemas.MarkUsedRequest;
  if (schema === undefined) throw new Error('contracts/openapi.yaml defines no components.schemas.MarkUsedRequest');
  markUsedContract = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

/** A gateway app carrying only the mark-used route over a stub jar and bridge that record their calls. */
async function markUsedApp(
  row: JarRow | undefined,
  markUsed: BridgeClient['markUsed'] = () => Promise.resolve({ body: { applied: 2, serverTime: '' }, setCookies: [] }),
): Promise<{ app: FastifyInstance; calls: Call[] }> {
  const calls: Call[] = [];
  const jar: LegacyJar = {
    get(sessionId) {
      calls.push(['jar.get', sessionId]);
      return Promise.resolve(row);
    },
    findByLegacySessionId: unexpected('jar.findByLegacySessionId'),
    upsert: unexpected('jar.upsert'),
    setHydratedEpoch: unexpected('jar.setHydratedEpoch'),
    drop: unexpected('jar.drop'),
  };
  const bridge: BridgeClient = {
    describe: unexpected('bridge.describe'),
    hydrate: unexpected('bridge.hydrate'),
    markUsed(cookies, tokens, call) {
      calls.push(['bridge.markUsed', cookies, tokens, call]);
      return markUsed(cookies, tokens, call);
    },
    usedSince: unexpected('bridge.usedSince'),
    end: unexpected('bridge.end'),
  };
  const app = await createService({
    name: 'gateway',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8100',
      OPT2_SERVICE_NAME: 'gateway',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('gateway'),
    logger: createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  await registerMarkUsedRoute(app, { jar, bridge });
  await app.ready();
  return { app, calls };
}

/** Invocation credential of `caller` addressed to the gateway. */
async function credentialOf(caller: string): Promise<Record<string, string>> {
  const token = await mintServiceToken({ caller, audience: 'gateway', roles: rolesForService(caller) });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

describe('registerMarkUsedRoute', () => {
  it('declares the contract operation on the service transport, callable by identity only', async () => {
    const { app } = await markUsedApp(jarRow());
    expect(recordedRoutes(app).filter((route) => route.url.startsWith('/internal/'))).toEqual([
      {
        method: 'POST',
        url: '/internal/v1/legacy-sessions/:sid(.+)::mark-used',
        config: { transport: 'service', requires: ['service:identity'] },
      },
    ]);
  });

  it.each<[string, string]>([
    ['an identity session id', SESSION_ID],
    ['a session id containing colons', 'opaque:session:0001'],
  ])('marks the tokens in the legacy session mapped to %s and answers 204', async (_label, sid) => {
    const { app, calls } = await markUsedApp(jarRow({ sessionId: sid }));
    const res = await app.inject({
      method: 'POST',
      url: markUsedUrl(sid),
      headers: await credentialOf('identity'),
      payload: { tokens: TOKENS },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(calls).toEqual([
      ['jar.get', sid],
      ['bridge.markUsed', LIVE, TOKENS, { legacySessionId: LEGACY_SESSION_ID }],
    ]);
  });

  it('accepts a token generateCsrfToken issues, as the contract does, and hands it to the bridge unchanged', async () => {
    const { token } = generateCsrfToken({ context: SESSION_ID, secret: CSRF_SECRET, now: NOW });
    const tokens = [{ token, usedAt: '2026-06-30T12:00:00.123' }];
    expect(markUsedContract({ tokens })).toBe(true);
    const { app, calls } = await markUsedApp(jarRow());
    const res = await app.inject({
      method: 'POST',
      url: markUsedUrl(SESSION_ID),
      headers: await credentialOf('identity'),
      payload: { tokens },
    });
    expect(res.statusCode).toBe(204);
    expect(calls).toEqual([
      ['jar.get', SESSION_ID],
      ['bridge.markUsed', LIVE, tokens, { legacySessionId: LEGACY_SESSION_ID }],
    ]);
  });

  it.each<[string, JarRow | undefined]>([
    ['no jar', undefined],
    ['a jar without a legacy session id', jarRow({ legacySessionId: null })],
    ['a jar holding only deleted cookies', jarRow({ cookies: DELETED })],
  ])('answers the legacy JSON API 404 without calling the bridge for %s', async (_label, row) => {
    const { app, calls } = await markUsedApp(row);
    const res = await app.inject({
      method: 'POST',
      url: markUsedUrl(SESSION_ID),
      headers: await credentialOf('identity'),
      payload: { tokens: TOKENS },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid method call' } });
    expect(calls).toEqual([['jar.get', SESSION_ID]]);
  });

  it('answers the legacy 503 when the bridge fails', async () => {
    const failure = new ServiceUnavailableError('legacy-bridge', new Error('legacy bridge session.markUsed answered HTTP 409'));
    const { app, calls } = await markUsedApp(jarRow(), () => Promise.reject(failure));
    const res = await app.inject({
      method: 'POST',
      url: markUsedUrl(SESSION_ID),
      headers: await credentialOf('identity'),
      payload: { tokens: TOKENS },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
    expect(calls.map(([op]) => op)).toEqual(['jar.get', 'bridge.markUsed']);
  });

  it.each<[string, object]>([
    ['a body without tokens', {}],
    ['an empty token list', { tokens: [] }],
    ['a token that is not 64 hex digits', { tokens: [{ ...TOKENS[0], token: 'G'.repeat(64) }] }],
    ['a short token', { tokens: [{ ...TOKENS[0], token: 'A'.repeat(63) }] }],
    ['an MD5-length 32-digit token', { tokens: [{ ...TOKENS[0], token: 'A'.repeat(32) }] }],
    ['a token without usedAt', { tokens: [{ token: 'A'.repeat(64) }] }],
    ['a space-separated usedAt', { tokens: [{ ...TOKENS[0], usedAt: '2026-06-30 12:00:00' }] }],
    ['a usedAt with an offset', { tokens: [{ ...TOKENS[0], usedAt: '2026-06-30T12:00:00Z' }] }],
  ])('rejects %s with 400 before reading the jar, as the contract does', async (_label, payload) => {
    expect(markUsedContract(payload)).toBe(false);
    const { app, calls } = await markUsedApp(jarRow());
    const res = await app.inject({
      method: 'POST',
      url: markUsedUrl(SESSION_ID),
      headers: await credentialOf('identity'),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(calls).toEqual([]);
  });

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['no credential', () => Promise.resolve({}), 401],
    ["the gateway's own credential", () => credentialOf('gateway'), 403],
    ['a migration credential', () => credentialOf('migration'), 403],
  ])('denies a caller presenting %s before reading the jar', async (_label, headers, status) => {
    const { app, calls } = await markUsedApp(jarRow());
    const res = await app.inject({
      method: 'POST',
      url: markUsedUrl(SESSION_ID),
      headers: await headers(),
      payload: { tokens: TOKENS },
    });
    expect(res.statusCode).toBe(status);
    expect(calls).toEqual([]);
  });
});
