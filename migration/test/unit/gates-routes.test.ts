// Unit tests for the `gatesList` route over fake lease and owner-gate reads: declaration, answers, owner unavailability,
// the legacy 400, auth, and the bound reads of `gateReadsOf`.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import type { GateRequest, UnitGate } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { MigrationContext } from '../../src/context.js';
import { OwnerCallError, UnknownUnitError, type DataOwner, type OwnersClient, type Unit } from '../../src/owners/index.js';
import { GATES_ROUTES, gateReadsOf, registerGatesRoutes, type GatesRouteDeps } from '../../src/routes/gates.js';
import type { LeaseRow } from '../../src/windows/index.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const PATH = '/internal/v1/gates';
const WINDOW_ID = '9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F';
const TRANSITION_ID = '1A2B3C4D-5E6F-4A7B-8C9D0E1F2A3B4C5D';
const ACQUIRED = new Date('2026-06-30T12:00:00.000Z');

const CATALOG_UNITS: readonly Unit[] = [
  { id: 'identity.user_account', owner: 'identity', schema: 'identity', legacyTables: ['tusers'] },
  { id: 'people.person', owner: 'people', schema: 'people', legacyTables: ['tusers'] },
  { id: 'people.person_archive', owner: 'people', schema: 'people', legacyTables: ['person_archive'] },
  { id: 'content.content', owner: 'strategies-content', schema: 'content', legacyTables: ['tcontent'] },
];

const catalog = {
  units: vi.fn(() => CATALOG_UNITS),
  unit: vi.fn((id: string): Unit => {
    const found = CATALOG_UNITS.find((unit) => unit.id === id);
    if (found === undefined) throw new UnknownUnitError(id);
    return found;
  }),
};
const leases = vi.fn<GatesRouteDeps['leases']>();
const ownerGates = vi.fn<GatesRouteDeps['ownerGates']>();
let app: FastifyInstance;

/** Gate rows per owner: `state` for every unit, held by `holderId` with `phase` when closed. */
function gatesFrom(rows: Readonly<Record<string, Omit<UnitGate, 'unit'>>>) {
  return (_owner: DataOwner, units: readonly string[]): Promise<UnitGate[]> =>
    Promise.resolve(units.flatMap((unit) => (rows[unit] === undefined ? [] : [{ unit, ...rows[unit] }])));
}

const OPEN: Omit<UnitGate, 'unit'> = { state: 'open', holderId: null, phase: 'quiet' };
const LEGACY: Omit<UnitGate, 'unit'> = { state: 'legacy', holderId: null, phase: 'quiet' };

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
  registerGatesRoutes(app, { catalog, leases, ownerGates });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  catalog.units.mockClear();
  catalog.unit.mockClear();
  leases.mockReset().mockResolvedValue([]);
  ownerGates.mockReset().mockImplementation(gatesFrom({}));
});

/** Invocation-credential headers of `caller` (none for null), optionally with a user token. */
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

const asOperator = () => headersFor('operator');

describe('route declaration', () => {
  it('matches the contract operation', () => {
    const operation = OPENAPI.paths[PATH]?.get ?? {};
    expect(GATES_ROUTES).toEqual([{ operationId: operation.operationId, method: 'GET', path: PATH, url: PATH }]);
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url === PATH);
    expect(declared).toEqual([
      expect.objectContaining({ method: 'GET', url: PATH, transport: operation['x-opt2-transport'], requires: operation['x-opt2-requires'] }),
    ]);
  });
});

describe('answers', () => {
  it('lists every catalog unit without leases when nothing holds one, reading each owner once for its units', async () => {
    ownerGates.mockImplementation(
      gatesFrom({ 'identity.user_account': OPEN, 'people.person': OPEN, 'people.person_archive': LEGACY, 'content.content': LEGACY }),
    );

    const res = await get('', await asOperator());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      units: [
        { unit: 'identity.user_account', owner: 'identity', gate: { state: 'open', holderId: null, phase: 'quiet' } },
        { unit: 'people.person', owner: 'people', gate: { state: 'open', holderId: null, phase: 'quiet' } },
        { unit: 'people.person_archive', owner: 'people', gate: { state: 'legacy', holderId: null, phase: 'quiet' } },
        { unit: 'content.content', owner: 'strategies-content', gate: { state: 'legacy', holderId: null, phase: 'quiet' } },
      ],
    });
    expect(leases).toHaveBeenCalledWith(CATALOG_UNITS.map((unit) => unit.id));
    expect(ownerGates.mock.calls).toEqual([
      ['identity', ['identity.user_account']],
      ['people', ['people.person', 'people.person_archive']],
      ['strategies-content', ['content.content']],
    ]);
  });

  it('reports a window holder whose gates are closed in two owners', async () => {
    leases.mockResolvedValue([
      { unit: 'identity.user_account', holderId: WINDOW_ID, kind: 'window', acquiredAt: ACQUIRED },
      { unit: 'people.person', holderId: WINDOW_ID, kind: 'window', acquiredAt: ACQUIRED },
    ]);
    const closed = { state: 'closed', holderId: WINDOW_ID, phase: 'executing' } as const;
    ownerGates.mockImplementation(gatesFrom({ 'identity.user_account': closed, 'people.person': closed }));

    const res = await get('?units=people.person,identity.user_account', await asOperator());

    expect(res.statusCode).toBe(200);
    const lease = { holderId: WINDOW_ID, kind: 'window', acquiredAt: '2026-06-30T12:00:00.000Z' };
    expect(res.json()).toEqual({
      units: [
        { unit: 'people.person', owner: 'people', lease, gate: closed },
        { unit: 'identity.user_account', owner: 'identity', lease, gate: closed },
      ],
    });
  });

  it('reports a transition holder, keeping filter order and dropping repeated ids', async () => {
    leases.mockResolvedValue([{ unit: 'content.content', holderId: TRANSITION_ID, kind: 'transition', acquiredAt: ACQUIRED }]);
    ownerGates.mockImplementation(
      gatesFrom({ 'content.content': { state: 'closed', holderId: TRANSITION_ID, phase: 'quiet' }, 'people.person_archive': OPEN }),
    );

    const res = await get('?units=content.content,people.person_archive,content.content', await asOperator());

    expect(res.json()).toEqual({
      units: [
        {
          unit: 'content.content',
          owner: 'strategies-content',
          lease: { holderId: TRANSITION_ID, kind: 'transition', acquiredAt: '2026-06-30T12:00:00.000Z' },
          gate: { state: 'closed', holderId: TRANSITION_ID, phase: 'quiet' },
        },
        { unit: 'people.person_archive', owner: 'people', gate: { state: 'open', holderId: null, phase: 'quiet' } },
      ],
    });
    expect(leases).toHaveBeenCalledWith(['content.content', 'people.person_archive']);
    expect(catalog.units).not.toHaveBeenCalled();
  });

  it('reports each side as read when the holder finished between the reads', async () => {
    leases.mockResolvedValue([{ unit: 'people.person', holderId: WINDOW_ID, kind: 'window', acquiredAt: ACQUIRED }]);
    ownerGates.mockImplementation(gatesFrom({ 'people.person': OPEN }));

    const res = await get('?units=people.person', await asOperator());

    expect(res.json()).toEqual({
      units: [
        {
          unit: 'people.person',
          owner: 'people',
          lease: { holderId: WINDOW_ID, kind: 'window', acquiredAt: '2026-06-30T12:00:00.000Z' },
          gate: { state: 'open', holderId: null, phase: 'quiet' },
        },
      ],
    });
  });

  it('omits the gate of a unit whose owner holds no gate row', async () => {
    const res = await get('?units=people.person', await asOperator());

    expect(res.json()).toEqual({ units: [{ unit: 'people.person', owner: 'people' }] });
  });
});

describe('owner unavailability', () => {
  it.each([
    ['unreachable', new ServiceUnavailableError('people', new Error('ECONNREFUSED'))],
    ['answering 503', new OwnerCallError('people', 'POST', '/internal/v1/migration/gate', 503, {})],
    ['answering 504', new OwnerCallError('people', 'POST', '/internal/v1/migration/gate', 504, {})],
  ])('omits the gates of an owner %s and keeps the others', async (_label, failure) => {
    ownerGates.mockImplementation((owner, units) =>
      owner === 'people' ? Promise.reject(failure) : gatesFrom({ 'identity.user_account': OPEN })(owner, units),
    );

    const res = await get('?units=people.person,identity.user_account', await asOperator());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      units: [
        { unit: 'people.person', owner: 'people' },
        { unit: 'identity.user_account', owner: 'identity', gate: { state: 'open', holderId: null, phase: 'quiet' } },
      ],
    });
  });

  it('propagates any other owner failure as a server error', async () => {
    ownerGates.mockRejectedValue(new OwnerCallError('people', 'POST', '/internal/v1/migration/gate', 400, { error: 'invalid_request' }));

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await app.inject({ method: 'GET', url: `${PATH}?units=people.person`, headers: await asOperator() });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('invalid unit filters', () => {
  it.each([
    ['an empty list', '?units='],
    ['an upper-case id', '?units=People.person'],
    ['an id without a schema', '?units=person'],
    ['a trailing comma', '?units=people.person,'],
    ['a repeated parameter', '?units=people.person&units=content.content'],
    ['an unknown unit', '?units=people.person,people.unknown'],
  ])('answer %s with the legacy 400 without reading leases or gates', async (_label, query) => {
    const res = await get(query, await asOperator());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(leases).not.toHaveBeenCalled();
    expect(ownerGates).not.toHaveBeenCalled();
  });

  it('propagates a catalog failure other than an unknown unit as a server error', async () => {
    catalog.unit.mockImplementationOnce(() => {
      throw new Error('ownership file unreadable');
    });

    const res = await app.inject({ method: 'GET', url: `${PATH}?units=people.person`, headers: await asOperator() });
    expect(res.statusCode).toBe(500);
    expect(leases).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  it('admits the operator', async () => {
    expect((await get('', await asOperator())).statusCode).toBe(200);
  });

  it.each(['gateway', 'programs-sites', 'migration', 'people'])('refuses %s with 403', async (caller) => {
    expect((await get('', await headersFor(caller))).statusCode).toBe(403);
  });

  it('refuses anonymous calls and a user token without an invocation credential with 401', async () => {
    expect((await get('', await headersFor(null))).statusCode).toBe(401);
    expect((await get('', await headersFor(null, true))).statusCode).toBe(401);
    expect(leases).not.toHaveBeenCalled();
    expect(ownerGates).not.toHaveBeenCalled();
  });
});

describe('gateReadsOf', () => {
  const STORED: readonly LeaseRow[] = [
    { unit: 'people.person', holderId: WINDOW_ID, kind: 'window', acquiredAt: ACQUIRED },
    { unit: 'identity.user_account', holderId: WINDOW_ID, kind: 'window', acquiredAt: ACQUIRED },
    { unit: 'content.content', holderId: TRANSITION_ID, kind: 'transition', acquiredAt: ACQUIRED },
  ];

  /** `migration.unit_lease` answering the holder and per-holder lease reads of the lease module. */
  function leaseDb(): TenantDb {
    const record = (lease: LeaseRow) => ({ unit: lease.unit, holder_id: lease.holderId, kind: lease.kind, acquired_at: lease.acquiredAt });
    const query = (text: string, values: unknown[]) => {
      if (/WHERE unit = ANY/.test(text)) {
        const units = new Set(values[0] as string[]);
        return Promise.resolve({ rows: STORED.filter((lease) => units.has(lease.unit)).map(record) });
      }
      if (/WHERE holder_id = \$1$/.test(text)) return Promise.resolve({ rows: STORED.filter((lease) => lease.holderId === values[0]).map(record) });
      return Promise.reject(new Error(`unexpected statement: ${text}`));
    };
    const tx = { schema: 'migration', query } as unknown as MetadataTx;
    return { withMetadata: (fn: (t: MetadataTx) => Promise<unknown>) => fn(tx) } as unknown as TenantDb;
  }

  it('reads the requested units leases with kind and time, through each distinct holder', async () => {
    const reads = gateReadsOf({ db: leaseDb(), owners: {} as OwnersClient } as Pick<MigrationContext, 'db' | 'owners'>);

    const rows = await reads.leases(['people.person', 'content.content', 'timesheets.blackout']);

    expect(rows.sort((a, b) => a.unit.localeCompare(b.unit))).toEqual([
      { unit: 'content.content', holderId: TRANSITION_ID, kind: 'transition', acquiredAt: ACQUIRED },
      { unit: 'people.person', holderId: WINDOW_ID, kind: 'window', acquiredAt: ACQUIRED },
    ]);
  });

  it('reads an owner gate rows through the status operation, which changes no gate', async () => {
    const rows: UnitGate[] = [{ unit: 'people.person', state: 'open', holderId: null, phase: 'quiet' }];
    const gate = vi.fn((_owner: DataOwner, _req: GateRequest) => Promise.resolve({ units: rows }));
    const reads = gateReadsOf({ db: leaseDb(), owners: { gate } as unknown as OwnersClient });

    await expect(reads.ownerGates('people', ['people.person'])).resolves.toEqual(rows);
    expect(gate).toHaveBeenCalledWith('people', { op: 'status', units: ['people.person'] });
  });
});
