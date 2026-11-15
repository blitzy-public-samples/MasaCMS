// Tests web's service relay: web-only admission, transparent forwarding under the gateway's credential, write positions and fail-closed 503s.
import { Buffer } from 'node:buffer';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER_LC, formatWritePosition } from '@opt2/platform/migration-kit';
import { mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_SERVICES } from '../../src/dispatcher/relay.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import type { TargetDouble, TargetEcho, TargetMode } from '../helpers/target-double.js';

const SESSION_ID = 's-1';
const USER_ID = 'relay-user-1';
const SERVICE_PATH = '/v1/persons';
const QUERY = '?siteid=tenant-a&q=a%20b&q=c';

/** The two spellings web reaches the relay by: the canonical operation and the alias of the gateway ↔ web contract. */
const FORMS = [
  { form: 'canonical', base: '/internal/v1/relay' },
  { form: 'alias', base: '/opt2/svc' },
] as const;
const [CANONICAL, ALIAS] = FORMS;

let gateway: TestGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function start(version: 'v0001' | 'v0002' = 'v0001'): Promise<TestGateway> {
  gateway = await buildTestGateway({ version });
  return gateway;
}

function people(g: TestGateway): TargetDouble {
  const double = g.targets.people;
  if (double === undefined) throw new Error('the test gateway started no people double');
  return double;
}

/** Headers of a web call: the user token of session `s-1` and, unless `caller` is null, `caller`'s invocation credential. */
async function callHeaders(caller: string | null = 'web'): Promise<Record<string, string>> {
  const userToken = await mintUserToken({ sub: USER_ID, sid: SESSION_ID, site: 'tenant-a', roles: ['site-admin'] });
  const headers: Record<string, string> = { authorization: `Bearer ${userToken}` };
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'gateway' })}`;
  return headers;
}

/** Requests received so far by every upstream the gateway can reach. */
function upstreamCounts(g: TestGateway): Record<string, number> {
  const doubles = { legacy: g.legacy, identity: g.identity, migration: g.migration, ...g.targets };
  return Object.fromEntries(Object.entries(doubles).map(([name, double]) => [name, double.requests.length]));
}

function barrierRows(g: TestGateway): Array<{ session_id: string; owner: string; xid: string | null; pending: number }> {
  if (g.memory === undefined) throw new Error('the test gateway runs over no memory store');
  return g.memory.tables.session_barrier.map(({ session_id, owner, xid, pending }) => ({ session_id, owner, xid, pending }));
}

describe('relay admission', () => {
  it.each(FORMS)('the $form relay forwards a web call with a user token to the named service', async ({ base }) => {
    const g = await start();
    const res = await g.app.inject({ method: 'GET', url: `${base}/people${SERVICE_PATH}`, headers: await callHeaders() });
    expect(res.statusCode).toBe(200);
    expect(people(g).requests).toHaveLength(1);
  });

  it.each([
    { form: 'canonical', base: CANONICAL.base, caller: null, presenting: 'no invocation credential', status: 401 },
    { form: 'canonical', base: CANONICAL.base, caller: 'identity', presenting: "identity's credential", status: 403 },
    { form: 'alias', base: ALIAS.base, caller: null, presenting: 'no invocation credential', status: 403 },
    { form: 'alias', base: ALIAS.base, caller: 'identity', presenting: "identity's credential", status: 403 },
  ])('the $form relay answers $status to a call presenting $presenting and reaches no upstream', async ({ base, caller, status }) => {
    const g = await start();
    const before = upstreamCounts(g);
    const res = await g.app.inject({ method: 'GET', url: `${base}/people${SERVICE_PATH}`, headers: await callHeaders(caller) });
    expect(res.statusCode).toBe(status);
    expect(upstreamCounts(g)).toEqual(before);
  });

  it.each(FORMS.flatMap(({ form, base }) => ['stub', 'web', 'migration', 'gateway'].map((service) => ({ form, base, service }))))(
    'the $form relay answers the legacy 404 for $service, which is no relay target, and reaches no upstream',
    async ({ base, service }) => {
      expect(RELAY_SERVICES).not.toContain(service);
      const g = await start();
      const before = upstreamCounts(g);
      const res = await g.app.inject({ method: 'GET', url: `${base}/${service}${SERVICE_PATH}`, headers: await callHeaders() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
      expect(upstreamCounts(g)).toEqual(before);
    },
  );
});

describe('relay forwarding', () => {
  it.each(FORMS)(
    "the $form relay forwards the user token unchanged with the gateway's invocation credential and the query as sent",
    async ({ base }) => {
      const g = await start();
      const headers = await callHeaders();
      const res = await g.app.inject({
        method: 'GET',
        url: `${base}/people${SERVICE_PATH}${QUERY}`,
        headers: { ...headers, 'x-opt2-anything': 'x' },
      });
      expect(res.statusCode).toBe(200);
      const [received] = people(g).requests;
      const [echo] = people(g).echoes();
      expect(res.json<TargetEcho>()).toEqual(echo);
      expect(echo?.method).toBe('GET');
      expect(echo?.path).toBe(SERVICE_PATH);
      expect(echo?.url).toBe(`${SERVICE_PATH}${QUERY}`);
      expect(echo?.authorization).toBe(headers.authorization);
      expect(echo?.serverlessAuthorization).toBeDefined();
      expect(echo?.serverlessAuthorization).not.toBe(headers[INVOCATION_HEADER]);
      const caller = await testVerifier('people').invocationVerifier.verify(String(echo?.serverlessAuthorization));
      expect(caller.name).toBe('gateway');
      expect(received?.headers['x-opt2-anything']).toBeUndefined();
    },
  );

  it.each([
    { method: 'POST', contentType: 'application/json', body: '{"fname":  "Zoë",\n"tags":["a","b"]}' },
    { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'fname=Zo%C3%AB&tags=a&tags=b&note=a+b%26c' },
    { method: 'PUT', contentType: 'application/json', body: '{"active":true,"note":"\\u00e9 \\"q\\""}' },
    { method: 'PATCH', contentType: 'application/x-www-form-urlencoded', body: 'active=0&active=1' },
    { method: 'DELETE', contentType: 'application/json', body: '{"reason":"duplicate"}' },
  ] as const)('relays a $method $contentType body byte for byte', async ({ method, contentType, body }) => {
    const g = await start();
    const res = await g.app.inject({
      method,
      url: `${CANONICAL.base}/people${SERVICE_PATH}`,
      headers: { ...(await callHeaders()), 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const [echo] = people(g).echoes();
    expect(echo?.method).toBe(method);
    expect(echo?.path).toBe(SERVICE_PATH);
    expect(echo?.contentType).toBe(contentType);
    expect(Buffer.from(echo?.bodyBase64 ?? '', 'base64').equals(Buffer.from(body, 'utf8'))).toBe(true);
  });
});

describe('relay write positions', () => {
  // v0002 makes people.person_archive target-authoritative, so people is an owner the barrier records.
  it.each(FORMS)("the $form relay records the callee's write position for the token's session and strips it", async ({ base }) => {
    const g = await start('v0002');
    people(g).setWritePosition(formatWritePosition(new Map([['people', '42']])));
    const res = await g.app.inject({
      method: 'POST',
      url: `${base}/people${SERVICE_PATH}/${USER_ID}/archive`,
      headers: { ...(await callHeaders()), 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
    expect(barrierRows(g)).toEqual([{ session_id: SESSION_ID, owner: 'people', xid: '42', pending: 0 }]);
  });

  it('strips the write position and stores none under v0001, which projects no owner', async () => {
    const g = await start();
    people(g).setWritePosition(formatWritePosition(new Map([['people', '42']])));
    const res = await g.app.inject({ method: 'GET', url: `${CANONICAL.base}/people${SERVICE_PATH}`, headers: await callHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
    expect(barrierRows(g)).toEqual([]);
  });
});

describe('relay fail closed', () => {
  it.each(
    FORMS.flatMap(({ form, base }) =>
      (['503', 'refuse'] as const satisfies readonly TargetMode[]).map((mode) => ({ form, base, mode, reached: mode === '503' ? 1 : 0 })),
    ),
  )('the $form relay answers the API 503 envelope when people is $mode, without reaching legacy', async ({ base, mode, reached }) => {
    const g = await start();
    await people(g).setMode(mode);
    const legacyBefore = g.legacy.requests.length;
    const res = await g.app.inject({ method: 'GET', url: `${base}/people${SERVICE_PATH}`, headers: await callHeaders() });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(JSON.parse(apiUnavailableResponse().body));
    expect(people(g).requests).toHaveLength(reached);
    expect(g.legacy.requests).toHaveLength(legacyBefore);
  });
});
