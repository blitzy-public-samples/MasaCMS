// Provider contract of the migration service: the document, the routes the registrars declare against it, the operations no
// registrar serves, and every declared answer of each served operation through the real modules, with their outbound calls.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { INVOCATION_HEADER, collectRouteMatrix } from '@opt2/platform/auth';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { assertResponseMatchesOpenApi, createThrowawaySchema, findOperation, mintServiceToken, pgAvailable } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { createBackgroundState } from '../../src/quiesce/index.js';
import { SCHEDULER_KEYS, importSchedulerRequest, updateSchedulerKey } from '../../src/scheduler/index.js';
import {
  ABSENT_OPERATIONS,
  REGISTERED_OPERATIONS,
  buildRouteApp,
  defaultBoundaryState,
  memoryMigrationDb,
  postgresMigrationDb,
  type MigrationDb,
  type OpenApiDoc,
  type RouteApp,
} from '../helpers/route-app.js';

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };
const GROUPS = JSON.parse(readFileSync(new URL('../../../gateway/cutover/groups.json', import.meta.url), 'utf8')) as {
  groups: { id: string; units: string[] }[];
};
const V0002 = JSON.parse(readFileSync(new URL('../../../gateway/cutover/versions/v0002.json', import.meta.url), 'utf8')) as {
  groupAuthority: Record<string, 'legacy' | 'target'>;
};
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** One contract operation with its auth declaration. */
interface ContractOperation {
  operationId: string;
  method: Method;
  path: string;
  operation: Json;
}

const OPERATIONS: readonly ContractOperation[] = Object.entries(DOC.paths).flatMap(([path, item]) =>
  HTTP_METHODS.flatMap((verb) => {
    const operation = item[verb];
    if (typeof operation !== 'object' || operation === null) return [];
    const op = operation as Json;
    return [{ operationId: String(op.operationId), method: verb.toUpperCase() as Method, path, operation: op }];
  }),
);
const SERVED = OPERATIONS.filter(({ operationId }) => !(ABSENT_OPERATIONS as readonly string[]).includes(operationId));

/** The Fastify url of a contract path: a literal colon is written `::`, a `{param}` segment `:param`. */
function fastifyUrl(path: string): string {
  return path.replace(/:(?=[a-z])/g, '::').replace(/\{(\w+)\}/g, ':$1');
}

/** The contract path of a registered url without path parameters: `::` is a literal colon. */
function contractPathOf(url: string): string {
  return url.replace(/::/g, ':');
}

/** Authority of `unit` under v0002, read from the committed groups and version files. */
function v0002Authority(unit: string): 'legacy' | 'target' {
  const group = GROUPS.groups.find((candidate) => candidate.units.includes(unit));
  return group === undefined ? 'legacy' : (V0002.groupAuthority[group.id] ?? 'legacy');
}

async function invocation(caller: string): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}` };
}

/** Credentials of one case: none, a malformed invocation credential, or a workload's local service token. */
type Presenter = 'none' | 'malformed' | { caller: string };

async function headersOf(as: Presenter): Promise<Record<string, string>> {
  if (as === 'none') return {};
  if (as === 'malformed') return { [INVOCATION_HEADER]: 'Bearer not-a-token' };
  return invocation(as.caller);
}

const OPERATOR: Presenter = { caller: 'operator' };
const GATEWAY: Presenter = { caller: 'gateway' };

const MONITOR_EXPORT = {
  task: '/srv/www/index.cfm/_api/sitemonitor/',
  group: 'DEFAULT',
  URL: 'http://localhost:8080/index.cfm/_api/sitemonitor/',
  httpPort: 8080,
  interval: '900',
  startDate: '06/30/2026',
  startTime: '00:15:00',
  requestTimeOut: 600,
  status: 'Running',
};
const CAPTURE = { ping: true, nativeTasks: [MONITOR_EXPORT] };
const OTHER_CAPTURE = { ping: true, nativeTasks: [{ ...MONITOR_EXPORT, interval: '1800' }] };
const SUSPENSION = { suspended: true, since: null, reason: 'contract suite', pushConfigs: {}, pausedQueues: [], pausedTasks: [] };

/** One request against a served operation; `status` is the declared answer it must produce. */
interface ResponseCase {
  operationId: string;
  status: number;
  title: string;
  method: Method;
  url: string;
  as: Presenter;
  payload?: unknown;
  arrange?(t: RouteApp): Promise<void> | void;
  /** `<service> <operationId>` of each outbound call, in order. */
  outbound?: readonly string[];
  verify?(body: Json, t: RouteApp): void;
}

/** Live checkpoints of `owner` at `horizon` for every live site's tenant. */
function checkpointsAt(t: RouteApp, owner: string, horizon: string): void {
  t.state.checkpoints = t.state.sites.map((site) => ({ owner, tenantId: tenantIdForSite(site), appliedHorizon: horizon }));
}

const AUTHORITY_URL = '/internal/v1/authority';
const AWAIT_URL = '/internal/v1/projection/await';
const STATE_URL = '/internal/v1/scheduler/state';
const IMPORT_URL = '/internal/v1/scheduler/state:import';
const SUSPEND_URL = '/internal/v1/background:suspend';
const RESUME_URL = '/internal/v1/background:resume';
const LEGACY_STEPS_URL = '/internal/v1/legacy-steps';

const PROGRAMS_SITES: Presenter = { caller: 'programs-sites' };
// The cursor in the legacy time mask; the deadline is wall-clock time, so it lies ahead of every case of the run.
const STEP_RUN = {
  theTime: '2026-06-30 12:00:00.000',
  lastMonitored: '2026-06-30 11:45:00.000',
  deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
};
/** `serverTime` of a step the bridge double completed, with the offset its offset-free wire time lacks. */
const STEP_SERVER_TIME = new Date('2026-06-30T12:00:00.123').toISOString();

const CASES: readonly ResponseCase[] = [
  { operationId: 'healthz', status: 200, title: 'without a credential', method: 'GET', url: '/healthz', as: 'none', verify: (body) => expect(body).toEqual({ status: 'ok' }) },
  { operationId: 'healthz', status: 401, title: 'with a malformed credential', method: 'GET', url: '/healthz', as: 'malformed' },
  {
    operationId: 'unitAuthority',
    status: 200,
    title: 'with the committed v0002 authority of each unit',
    method: 'GET',
    url: `${AUTHORITY_URL}?units=people.person_archive,timesheets.blackout,people.person`,
    as: GATEWAY,
    outbound: ['gateway cutoverStatus'],
    verify: (body) =>
      expect(body).toEqual({
        tableVersion: 'v0002',
        units: Object.fromEntries(['people.person_archive', 'timesheets.blackout', 'people.person'].map((unit) => [unit, v0002Authority(unit)])),
        allTarget: ['people.person_archive', 'timesheets.blackout', 'people.person'].every((unit) => v0002Authority(unit) === 'target'),
      }),
  },
  {
    operationId: 'unitAuthority',
    status: 400,
    title: 'for a unit the ownership file does not name',
    method: 'GET',
    url: `${AUTHORITY_URL}?units=people.unknown_table`,
    as: GATEWAY,
    outbound: [],
  },
  { operationId: 'unitAuthority', status: 401, title: 'without a credential', method: 'GET', url: `${AUTHORITY_URL}?units=people.person`, as: 'none' },
  { operationId: 'unitAuthority', status: 403, title: 'for the migration workload', method: 'GET', url: `${AUTHORITY_URL}?units=people.person`, as: { caller: 'migration' } },
  {
    operationId: 'unitAuthority',
    status: 503,
    title: 'when the gateway cannot be reached',
    method: 'GET',
    url: `${AUTHORITY_URL}?units=people.person`,
    as: { caller: 'programs-sites' },
    arrange: (t) => {
      t.state.gatewayDown = true;
    },
    outbound: ['gateway cutoverStatus'],
  },
  {
    operationId: 'legacyStepRun',
    status: 200,
    title: 'for a step with no migration unit, without an authority read or a window',
    method: 'POST',
    url: LEGACY_STEPS_URL,
    as: PROGRAMS_SITES,
    payload: { step: 'purgeDisplayWindow', ...STEP_RUN },
    outbound: [],
    verify: (body, t) => {
      expect(body).toEqual({ step: 'purgeDisplayWindow', completed: true, serverTime: STEP_SERVER_TIME });
      expect(t.effects().bridgeCalls).toBe(1);
    },
  },
  {
    operationId: 'legacyStepRun',
    status: 200,
    title: 'for a per-site step whose units are legacy-authoritative, without a window',
    method: 'POST',
    url: LEGACY_STEPS_URL,
    as: PROGRAMS_SITES,
    payload: { step: 'trackBounces', siteId: 'tenant-a', ...STEP_RUN },
    outbound: ['gateway cutoverStatus'],
    verify: (body, t) => {
      expect(body).toEqual({ step: 'trackBounces', completed: true, serverTime: STEP_SERVER_TIME, siteId: 'tenant-a' });
      expect(t.effects().bridgeCalls).toBe(1);
    },
  },
  {
    operationId: 'legacyStepRun',
    status: 400,
    title: 'for a per-site step without a site',
    method: 'POST',
    url: LEGACY_STEPS_URL,
    as: PROGRAMS_SITES,
    payload: { step: 'feedAutoImport', ...STEP_RUN },
    outbound: [],
    verify: (_body, t) => expect(t.effects().bridgeCalls).toBe(0),
  },
  { operationId: 'legacyStepRun', status: 401, title: 'without a credential', method: 'POST', url: LEGACY_STEPS_URL, as: 'none', payload: { step: 'setCursor', ...STEP_RUN } },
  { operationId: 'legacyStepRun', status: 403, title: 'for the gateway', method: 'POST', url: LEGACY_STEPS_URL, as: GATEWAY, payload: { step: 'setCursor', ...STEP_RUN } },
  {
    operationId: 'legacyStepRun',
    status: 503,
    title: 'when jobs.cfm does not complete the step',
    method: 'POST',
    url: LEGACY_STEPS_URL,
    as: PROGRAMS_SITES,
    payload: { step: 'clearOldCommands', ...STEP_RUN },
    arrange: (t) => {
      t.state.jobsFailing = true;
    },
    outbound: [],
  },
  {
    operationId: 'legacyStepRun',
    status: 504,
    title: 'for a deadline that passed before the step ran',
    method: 'POST',
    url: LEGACY_STEPS_URL,
    as: PROGRAMS_SITES,
    payload: { step: 'setCursor', ...STEP_RUN, deadlineAt: '2000-01-01T00:00:00.000Z' },
    outbound: [],
    verify: (_body, t) => expect(t.effects().bridgeCalls).toBe(0),
  },
  {
    operationId: 'projectionAwait',
    status: 200,
    title: 'once every legacy checkpoint passed the position',
    method: 'POST',
    url: AWAIT_URL,
    as: GATEWAY,
    payload: { positions: { people: '100' }, timeoutMs: 2000 },
    arrange: (t) => checkpointsAt(t, 'people', '200'),
    outbound: ['gateway cutoverStatus'],
    verify: (body) => expect(body).toEqual({ applied: true, positions: { people: '100' } }),
  },
  {
    operationId: 'projectionAwait',
    status: 200,
    title: "after reading each named owner's current position",
    method: 'POST',
    url: AWAIT_URL,
    as: GATEWAY,
    payload: { owners: ['people'], timeoutMs: 2000 },
    arrange: (t) => {
      t.state.positions.set('people', '150');
      checkpointsAt(t, 'people', '200');
    },
    outbound: ['people migrationPosition', 'gateway cutoverStatus'],
    verify: (body) => expect(body).toEqual({ applied: true, positions: { people: '150' } }),
  },
  { operationId: 'projectionAwait', status: 400, title: 'for an empty positions map', method: 'POST', url: AWAIT_URL, as: GATEWAY, payload: { positions: {} }, outbound: [] },
  { operationId: 'projectionAwait', status: 401, title: 'without a credential', method: 'POST', url: AWAIT_URL, as: 'none', payload: { owners: ['people'] } },
  { operationId: 'projectionAwait', status: 403, title: 'for the operator', method: 'POST', url: AWAIT_URL, as: OPERATOR, payload: { owners: ['people'] } },
  {
    operationId: 'projectionAwait',
    status: 503,
    title: 'when the budget passes before the projector applies the position',
    method: 'POST',
    url: AWAIT_URL,
    as: GATEWAY,
    payload: { positions: { people: '300' }, timeoutMs: 50 },
    arrange: (t) => checkpointsAt(t, 'people', '200'),
    outbound: ['gateway cutoverStatus'],
  },
  {
    operationId: 'schedulerStateGet',
    status: 200,
    title: 'before any capture',
    method: 'GET',
    url: STATE_URL,
    as: OPERATOR,
    outbound: [],
    verify: (body, t) => {
      expect(body).toEqual({ ping: null, nativeTaskExisted: false, siteMonitor: { state: 'none' }, tasks: [], fixtureTasks: [], background: { suspended: false } });
      expect(t.effects().bridgeCalls).toBe(1);
    },
  },
  { operationId: 'schedulerStateGet', status: 401, title: 'without a credential', method: 'GET', url: STATE_URL, as: 'none' },
  { operationId: 'schedulerStateGet', status: 403, title: 'for the gateway', method: 'GET', url: STATE_URL, as: GATEWAY },
  {
    operationId: 'schedulerStateImport',
    status: 200,
    title: 'for a capture holding the native site monitor',
    method: 'POST',
    url: IMPORT_URL,
    as: OPERATOR,
    payload: CAPTURE,
    outbound: [],
    verify: (body, t) => {
      expect(body).toMatchObject({ ping: true, nativeTaskExisted: true, siteMonitor: { state: 'captured' }, tasks: [{ name: MONITOR_EXPORT.task, status: 'captured' }] });
      expect(t.effects().bridgeCalls).toBe(1);
    },
  },
  { operationId: 'schedulerStateImport', status: 400, title: 'for task entries that are not a list', method: 'POST', url: IMPORT_URL, as: OPERATOR, payload: { nativeTasks: 'none', ping: false } },
  { operationId: 'schedulerStateImport', status: 401, title: 'without a credential', method: 'POST', url: IMPORT_URL, as: 'none', payload: CAPTURE },
  { operationId: 'schedulerStateImport', status: 403, title: 'for the migration workload', method: 'POST', url: IMPORT_URL, as: { caller: 'migration' }, payload: CAPTURE },
  {
    operationId: 'schedulerStateImport',
    status: 409,
    title: 'for a different capture after the site monitor was handed off',
    method: 'POST',
    url: IMPORT_URL,
    as: OPERATOR,
    payload: OTHER_CAPTURE,
    arrange: async (t) => {
      const now = t.ctx.clock.now();
      await importSchedulerRequest({ db: t.ctx.db, clock: t.ctx.clock }, CAPTURE);
      await updateSchedulerKey(t.ctx.db, SCHEDULER_KEYS.siteMonitor, (current) => ({ ...current, state: 'target', handedOffAt: now.toISOString() }), now);
    },
  },
  {
    operationId: 'backgroundSuspend',
    status: 200,
    title: 'storing the record',
    method: 'POST',
    url: SUSPEND_URL,
    as: OPERATOR,
    payload: SUSPENSION,
    verify: (body) => expect(body).toMatchObject({ suspended: true, since: expect.any(String) as unknown }),
  },
  { operationId: 'backgroundSuspend', status: 400, title: 'for a partial record', method: 'POST', url: SUSPEND_URL, as: OPERATOR, payload: { suspended: true } },
  { operationId: 'backgroundSuspend', status: 401, title: 'without a credential', method: 'POST', url: SUSPEND_URL, as: 'none', payload: SUSPENSION },
  { operationId: 'backgroundSuspend', status: 403, title: 'for the gateway', method: 'POST', url: SUSPEND_URL, as: GATEWAY, payload: SUSPENSION },
  {
    operationId: 'backgroundResume',
    status: 200,
    title: 'after a suspension',
    method: 'POST',
    url: RESUME_URL,
    as: OPERATOR,
    arrange: async (t) => {
      await createBackgroundState(t.ctx).suspend({ ...SUSPENSION, since: '2026-06-30T11:30:00.000Z' });
    },
    verify: (body) => expect(body).toEqual({ suspended: false }),
  },
  { operationId: 'backgroundResume', status: 401, title: 'without a credential', method: 'POST', url: RESUME_URL, as: 'none' },
  { operationId: 'backgroundResume', status: 403, title: 'for programs-sites', method: 'POST', url: RESUME_URL, as: { caller: 'programs-sites' } },
];

/** `<operationId> <status>` of every answer the contract declares for a served operation. */
function declaredAnswers(): string[] {
  return SERVED.flatMap(({ operationId, operation }) =>
    Object.keys((operation.responses ?? {}) as Json).map((status) => `${operationId} ${status}`),
  ).sort();
}

describe('document', () => {
  it('is OpenAPI 3.1.0, version 1.0.0, at the pinned source SHA', () => {
    expect({ openapi: DOC.openapi, version: DOC.info.version, sha: DOC.info['x-source-sha'] }).toEqual({ openapi: '3.1.0', version: '1.0.0', sha: PIN.sha });
  });

  it('gives every operation a unique id, the service transport and exactly one of x-opt2-requires and x-opt2-public', () => {
    const ids = OPERATIONS.map(({ operationId }) => operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { operationId, operation } of OPERATIONS) {
      const requires = operation['x-opt2-requires'];
      const declaresRoles = Array.isArray(requires) && requires.length > 0;
      expect({ operationId, transport: operation['x-opt2-transport'], declaresOne: declaresRoles !== (operation['x-opt2-public'] === true) }).toEqual({
        operationId,
        transport: 'service',
        declaresOne: true,
      });
    }
  });
});

describe('served operations', () => {
  let t: RouteApp;

  beforeAll(async () => {
    t = await buildRouteApp({ db: memoryMigrationDb().db });
  });

  afterAll(async () => {
    await t?.close();
  });

  it('registers exactly the contract operations outside the absent set, each with its declared transport, roles and site check', () => {
    /** One declaration in comparable form, `requires` sorted. */
    const declaration = (operationId: unknown, transport: unknown, requires: unknown, isPublic: boolean, siteCheck: boolean) => ({
      operationId: String(operationId),
      transport,
      requires: Array.isArray(requires) ? [...(requires as string[])].sort() : requires,
      public: isPublic,
      siteCheck,
    });
    const byId = (a: { operationId: string }, b: { operationId: string }) => a.operationId.localeCompare(b.operationId);
    const registered = collectRouteMatrix(t.app).routes.map((route) =>
      declaration(findOperation(DOC, route.method, contractPathOf(route.url)).operation.operationId, route.transport, route.requires, route.public === true, route.siteCheck),
    );
    const expected = SERVED.map(({ operationId, operation }) =>
      declaration(operationId, operation['x-opt2-transport'], operation['x-opt2-requires'], operation['x-opt2-public'] === true, operation['x-opt2-site-check'] !== false),
    );
    expect(registered.sort(byId)).toEqual(expected.sort(byId));
  });

  it('leaves exactly the absent set unserved', () => {
    const served = new Set(collectRouteMatrix(t.app).routes.map((route) => findOperation(DOC, route.method, contractPathOf(route.url)).operation.operationId));
    expect(OPERATIONS.map(({ operationId }) => operationId).filter((id) => !served.has(id)).sort()).toEqual([...ABSENT_OPERATIONS]);
  });

  it.each(OPERATIONS.filter(({ operationId }) => (ABSENT_OPERATIONS as readonly string[]).includes(operationId)))(
    'answers $method $path ($operationId) with 404 and no effect',
    async ({ method, path }) => {
      t.resetEffects();
      const url = path.replace(/\{(\w+)\}/g, (_match, name: string) => (name === 'name' ? 'projector-delay' : 'contract-probe-id'));
      const res = await t.app.inject({ method, url, headers: { ...(await invocation('operator')), 'content-type': 'application/json' }, payload: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
      expect({ status: res.statusCode, effects: t.effects() }).toEqual({
        status: 404,
        effects: { transactions: 0, statements: 0, serviceCalls: 0, bridgeCalls: 0, legacyReads: 0 },
      });
    },
  );

  it("exports each registrar's operations with the contract's operation id, method and path", () => {
    for (const { operationId, method, path, url } of REGISTERED_OPERATIONS) {
      expect({ operationId: findOperation(DOC, method, path).operation.operationId, url }).toEqual({ operationId, url: fastifyUrl(path) });
    }
    expect(REGISTERED_OPERATIONS.map(({ operationId }) => operationId).sort()).toEqual(
      SERVED.map(({ operationId }) => operationId).filter((id) => id !== 'healthz').sort(),
    );
  });

  it('has one answer case for every status the contract declares for a served operation', () => {
    expect([...new Set(CASES.map(({ operationId, status }) => `${operationId} ${status}`))].sort()).toEqual(declaredAnswers());
  });
});

const pg = await pgAvailable();

const BACKENDS: ReadonlyArray<{ name: string; available: boolean; open: () => Promise<MigrationDb> }> = [
  { name: 'the in-memory migration schema', available: true, open: () => Promise.resolve(memoryMigrationDb()) },
  {
    name: 'a PostgreSQL throwaway migration schema',
    available: pg,
    open: async () => postgresMigrationDb(await createThrowawaySchema({ service: 'migration', migrationsDir: MIGRATIONS_DIR })),
  },
];

describe.each(BACKENDS)('declared answers over $name', ({ available, open }) => {
  describe.skipIf(!available)('each case', () => {
    let store: MigrationDb;
    let t: RouteApp;

    beforeAll(async () => {
      store = await open();
      t = await buildRouteApp({ db: store.db });
    });

    afterAll(async () => {
      await t?.close();
      await store?.close();
    });

    beforeEach(async () => {
      await store.clear();
      Object.assign(t.state, defaultBoundaryState());
    });

    it.each(CASES)('$operationId $status $title', async (c) => {
      const { status, method, url, as, payload, outbound } = c;
      await c.arrange?.(t);
      t.resetEffects();
      const headers = { ...(await headersOf(as)), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) };
      const res = await t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
      const path = url.split('?')[0] ?? url;
      const body = assertResponseMatchesOpenApi(DOC, { method, path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });

      expect(res.statusCode).toBe(status);
      if (outbound !== undefined) expect(t.calls.map(({ req, operationId }) => `${req.service} ${operationId}`)).toEqual(outbound);
      if (status === 401 || status === 403) {
        expect(t.effects()).toEqual({ transactions: 0, statements: 0, serviceCalls: 0, bridgeCalls: 0, legacyReads: 0 });
      }
      c.verify?.(body as Json, t);
    });
  });
});
