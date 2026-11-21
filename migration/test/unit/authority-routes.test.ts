// Unit tests for the `unitAuthority` route over a fake authority read and catalog: answers, contract shape, the legacy 400 and 503, and auth denials.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { CurrentAuthority } from '../../src/cutover/index.js';
import { UnknownUnitError, type Unit } from '../../src/owners/index.js';
import { AUTHORITY_ROUTES, registerAuthorityRoutes, type AuthorityRouteDeps } from '../../src/routes/authority.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const PATH = '/internal/v1/authority';
const CATALOG_UNITS: readonly Unit[] = [
  { id: 'people.person', owner: 'people', schema: 'people', legacyTables: ['tusers'] },
  { id: 'identity.user_account', owner: 'identity', schema: 'identity', legacyTables: ['tusers'] },
  { id: 'content.content', owner: 'strategies-content', schema: 'content', legacyTables: ['tcontent'] },
  { id: 'timesheets.blackout', owner: 'timesheets', schema: 'timesheets', legacyTables: ['blackout'] },
];
const KNOWN_UNITS = CATALOG_UNITS.map((unit) => unit.id);

/** Authority as `currentAuthority` builds it: units not in the map are legacy. */
function authorityOf(tableVersion: string | null, target: readonly string[], legacy: readonly string[] = []): CurrentAuthority {
  const units = new Map<string, 'legacy' | 'target'>([
    ...legacy.map((unit) => [unit, 'legacy'] as const),
    ...target.map((unit) => [unit, 'target'] as const),
  ]);
  const targetUnits = new Set([...target].sort());
  return {
    tableVersion,
    epoch: 7,
    units,
    targetUnits,
    isTargetAuthoritative: (unit) => targetUnits.has(unit),
    anyTarget: targetUnits.size > 0,
  };
}

const authority = vi.fn<AuthorityRouteDeps['authority']>();
const catalog = {
  unit: vi.fn((id: string): Unit => {
    const found = CATALOG_UNITS.find((unit) => unit.id === id);
    if (found === undefined) throw new UnknownUnitError(id);
    return found;
  }),
};
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
    logger: createLogger({ service: 'migration', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  registerAuthorityRoutes(app, { authority, catalog });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  authority.mockReset();
  catalog.unit.mockClear();
});

/** Invocation-credential headers of `caller`, optionally with a user token. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-admin', site: 'default', roles: [Roles.s2] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}`;
  return headers;
}

/** Injects a GET and checks the answer against the contract. */
async function get(query: string, headers: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url: `${PATH}${query}`, headers });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

describe('route declaration', () => {
  it('matches the contract operation', () => {
    const operation = OPENAPI.paths[PATH]?.get ?? {};
    expect(AUTHORITY_ROUTES).toEqual([{ operationId: operation.operationId, method: 'GET', path: PATH, url: PATH }]);
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url === PATH);
    expect(declared).toEqual([
      expect.objectContaining({ method: 'GET', url: PATH, transport: operation['x-opt2-transport'], requires: operation['x-opt2-requires'] }),
    ]);
  });
});

describe('answers', () => {
  it('reports mixed authority, legacy for units no group names, and allTarget only when every unit is target', async () => {
    authority.mockResolvedValue(authorityOf('v0002', ['people.person', 'identity.user_account'], ['content.content']));
    const headers = await headersFor('programs-sites');

    const mixed = await get('?units=people.person,content.content,timesheets.blackout,people.person', headers);
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json()).toEqual({
      tableVersion: 'v0002',
      units: { 'people.person': 'target', 'content.content': 'legacy', 'timesheets.blackout': 'legacy' },
      allTarget: false,
    });

    const target = await get('?units=people.person,identity.user_account', headers);
    expect(target.json()).toEqual({
      tableVersion: 'v0002',
      units: { 'people.person': 'target', 'identity.user_account': 'target' },
      allTarget: true,
    });
  });

  it('reports every unit legacy before any version is active', async () => {
    authority.mockResolvedValue(authorityOf(null, [], KNOWN_UNITS));

    const res = await get('?units=people.person,content.content', await headersFor('gateway'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tableVersion: null, units: { 'people.person': 'legacy', 'content.content': 'legacy' }, allTarget: false });
  });

  it('answers the legacy 503 when the gateway status is unavailable', async () => {
    authority.mockRejectedValue(new LegacyServiceUnavailableError('Gateway cutoverStatus unavailable'));

    const res = await get('?units=people.person', await headersFor('operator'));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('invalid unit lists', () => {
  it.each([
    ['no units', ''],
    ['an empty list', '?units='],
    ['an upper-case id', '?units=People.person'],
    ['an id without a schema', '?units=person'],
    ['a trailing comma', '?units=people.person,'],
    ['a repeated parameter', '?units=people.person&units=content.content'],
    ['an unknown unit', '?units=people.person,people.unknown'],
  ])('answer %s with the legacy 400 without reading authority', async (_label, query) => {
    const res = await get(query, await headersFor('programs-sites'));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(authority).not.toHaveBeenCalled();
  });

  it('propagates a catalog failure other than an unknown unit as a server error', async () => {
    catalog.unit.mockImplementationOnce(() => {
      throw new Error('ownership file unreadable');
    });

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await app.inject({ method: 'GET', url: `${PATH}?units=people.person`, headers: await headersFor('programs-sites') });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
    expect(authority).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  it.each(['programs-sites', 'gateway', 'operator'])('admits %s', async (caller) => {
    authority.mockResolvedValue(authorityOf('v0001', []));
    expect((await get('?units=people.person', await headersFor(caller))).statusCode).toBe(200);
  });

  it.each(['migration', 'people', 'identity', 'strategies-content'])('refuses %s with 403', async (caller) => {
    expect((await get('?units=people.person', await headersFor(caller))).statusCode).toBe(403);
  });

  it('refuses anonymous calls and a user token without an invocation credential with 401', async () => {
    expect((await get('?units=people.person', await headersFor(null))).statusCode).toBe(401);
    expect((await get('?units=people.person', await headersFor(null, true))).statusCode).toBe(401);
    expect(authority).not.toHaveBeenCalled();
  });
});
