// Provider contract of the migration service: the document, the routes the registrars declare against it, every declared answer
// of each operation (through the real modules, or over stubbed window, gate and transition services where those need
// PostgreSQL), and the cut-over calls the package sends the gateway.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { INVOCATION_HEADER, collectRouteMatrix, transportForPath } from '@opt2/platform/auth';
import { GATE_PHASES, GATE_STATES } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  contractOperations,
  createThrowawaySchema,
  findOperation,
  injectedResponse,
  loadOpenApiDocument,
  mintServiceToken,
  operationAuthProblems,
  operationDeclaration,
  operationIdProblems,
  pgAvailable,
  routeDeclaration,
  toContractPath,
  type ContractOperation,
} from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { loadConfig } from '../../src/config.js';
import {
  createGatewayClient,
  type CutoverStatus,
  type CutoverStatusV2,
  type InflightClearRequest,
  type InflightRow,
} from '../../src/cutover/index.js';
import type { components } from '../../src/generated/openapi.js';
import { loadUnitCatalog } from '../../src/owners/index.js';
import { createBackgroundState } from '../../src/quiesce/index.js';
import {
  GATES_ROUTES,
  MIGRATION_ROUTES,
  TRANSITION_ROUTES,
  WINDOW_ROUTES,
  registerGatesRoutes,
  registerTransitionRoutes,
  registerWindowRoutes,
  type GatesRouteDeps,
  type TransitionRouteDeps,
  type WindowRouteDeps,
} from '../../src/routes/index.js';
import { SCHEDULER_KEYS, importSchedulerRequest, updateSchedulerKey } from '../../src/scheduler/index.js';
import { TransitionInProgressError, TransitionNotFoundError } from '../../src/transition/index.js';
import { LeaseUnavailableError, WindowNotFoundError, WindowRefusedError, WindowStateError } from '../../src/windows/index.js';
import { createMutableClock } from '../helpers/env.js';
import {
  ABSENT_OPERATIONS,
  REGISTERED_OPERATIONS,
  buildRouteApp,
  contractClient,
  defaultBoundaryState,
  jsonAnswer,
  memoryMigrationDb,
  postgresMigrationDb,
  producerContract,
  type ContractCall,
  type Effects,
  type MigrationDb,
  type OpenApiDoc,
  type Responder,
  type RouteApp,
} from '../helpers/route-app.js';

type Json = Record<string, unknown>;
type Schemas = components['schemas'];
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const DOC = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as unknown as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };
const GROUPS = JSON.parse(readFileSync(new URL('../../../gateway/cutover/groups.json', import.meta.url), 'utf8')) as {
  groups: { id: string; units: string[] }[];
};
const V0002 = JSON.parse(readFileSync(new URL('../../../gateway/cutover/versions/v0002.json', import.meta.url), 'utf8')) as {
  groupAuthority: Record<string, 'legacy' | 'target'>;
};
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MIGRATION_FIELDS = ['transport', 'requires', 'public', 'siteCheck'] as const;

const OPERATIONS = contractOperations(DOC, { methods: HTTP_METHODS }) as ReadonlyArray<ContractOperation & { method: Method }>;
const SERVED = OPERATIONS.filter(({ operationId }) => !(ABSENT_OPERATIONS as readonly string[]).includes(operationId));

/** The Fastify url of a contract path: a literal colon is written `::`, a `{param}` segment `:param`. */
function fastifyUrl(path: string): string {
  return path.replace(/:(?=[a-z])/g, '::').replace(/\{(\w+)\}/g, ':$1');
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

/** Injects the request of case `c` and checks the answer against the contract; returns the status and the parsed body. */
async function sendCase(app: RouteApp['app'], c: Pick<ResponseCase, 'method' | 'url' | 'as' | 'payload'>): Promise<{ status: number; body: Json }> {
  const { method, url, as, payload } = c;
  const headers = { ...(await headersOf(as)), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) };
  const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
  const body = assertResponseMatchesOpenApi(DOC, injectedResponse({ method, url }, res));
  return { status: res.statusCode, body: body as Json };
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
const ORPHAN_ARCHIVE_URL = '/internal/v1/probes/orphan-archive';
const DELAY_FAULT_URL = '/internal/v1/faults/projector-delay';
const UNKNOWN_FAULT_URL = '/internal/v1/faults/projector-stall';
const NO_EFFECTS: Effects = { transactions: 0, statements: 0, serviceCalls: 0, bridgeCalls: 0, legacyReads: 0, faultToggles: 0 };

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
    url: `${AUTHORITY_URL}?units=people.person_archive,programs_sites.site,people.person`,
    as: GATEWAY,
    outbound: ['gateway cutoverStatus'],
    verify: (body) =>
      expect(body).toEqual({
        tableVersion: 'v0002',
        units: Object.fromEntries(['people.person_archive', 'programs_sites.site', 'people.person'].map((unit) => [unit, v0002Authority(unit)])),
        allTarget: ['people.person_archive', 'programs_sites.site', 'people.person'].every((unit) => v0002Authority(unit) === 'target'),
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
    payload: { step: 'feedAutoImport', siteId: 'tenant-a', ...STEP_RUN },
    // v0001 keeps the feed import's content and identity units legacy-authoritative.
    arrange: (t) => {
      t.state.tableVersion = 'v0001';
    },
    outbound: ['gateway cutoverStatus'],
    verify: (body, t) => {
      expect(body).toEqual({ step: 'feedAutoImport', completed: true, serverTime: STEP_SERVER_TIME, siteId: 'tenant-a' });
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
    operationId: 'orphanArchiveProbe',
    status: 200,
    title: 'for a filename with an orphan archive row, matched without case',
    method: 'POST',
    url: ORPHAN_ARCHIVE_URL,
    as: GATEWAY,
    payload: { filenames: ['about', 'About/Team'] },
    arrange: (t) => {
      t.state.orphanArchives = ['about/team'];
    },
    outbound: [],
    verify: (body, t) => {
      expect(body).toEqual({ orphan: true });
      expect(t.effects().legacyReads).toBe(2);
    },
  },
  {
    operationId: 'orphanArchiveProbe',
    status: 200,
    title: 'for filenames without an orphan archive row',
    method: 'POST',
    url: ORPHAN_ARCHIVE_URL,
    as: OPERATOR,
    payload: { filenames: ['about'] },
    outbound: [],
    verify: (body) => expect(body).toEqual({ orphan: false }),
  },
  {
    operationId: 'orphanArchiveProbe',
    status: 400,
    title: 'for an empty filename list',
    method: 'POST',
    url: ORPHAN_ARCHIVE_URL,
    as: GATEWAY,
    payload: { filenames: [] },
    outbound: [],
    verify: (_body, t) => expect(t.effects().legacyReads).toBe(0),
  },
  { operationId: 'orphanArchiveProbe', status: 401, title: 'without a credential', method: 'POST', url: ORPHAN_ARCHIVE_URL, as: 'none', payload: { filenames: ['about'] } },
  { operationId: 'orphanArchiveProbe', status: 403, title: 'for programs-sites', method: 'POST', url: ORPHAN_ARCHIVE_URL, as: PROGRAMS_SITES, payload: { filenames: ['about'] } },
  {
    operationId: 'orphanArchiveProbe',
    status: 503,
    title: 'when the live legacy database cannot be read',
    method: 'POST',
    url: ORPHAN_ARCHIVE_URL,
    as: GATEWAY,
    payload: { filenames: ['about'] },
    arrange: (t) => {
      t.state.legacyDown = true;
    },
    outbound: [],
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
      expect(body).toEqual({ ping: null, nativeTaskExisted: false, siteMonitor: { state: 'none' }, tasks: [], background: { suspended: false } });
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
  {
    operationId: 'faultSet',
    status: 204,
    title: 'arming the 3 s projector delay',
    method: 'PUT',
    url: DELAY_FAULT_URL,
    as: OPERATOR,
    payload: { params: { delayMs: 3000 } },
    outbound: [],
    verify: (_body, t) => {
      expect(t.faults.active()).toEqual([{ name: 'projector-delay', params: { delayMs: 3000 }, since: expect.any(String) as unknown }]);
      expect(t.effects()).toEqual({ ...NO_EFFECTS, faultToggles: 1 });
    },
  },
  {
    operationId: 'faultSet',
    status: 400,
    title: 'for a delay that is not a number',
    method: 'PUT',
    url: DELAY_FAULT_URL,
    as: OPERATOR,
    payload: { params: { delayMs: 'soon' } },
    verify: (_body, t) => expect(t.faults.active()).toEqual([]),
  },
  { operationId: 'faultSet', status: 401, title: 'without a credential', method: 'PUT', url: DELAY_FAULT_URL, as: 'none', payload: { params: {} } },
  { operationId: 'faultSet', status: 403, title: 'for the gateway', method: 'PUT', url: DELAY_FAULT_URL, as: GATEWAY, payload: { params: {} } },
  {
    operationId: 'faultSet',
    status: 404,
    title: 'for a fault the registry does not know',
    method: 'PUT',
    url: UNKNOWN_FAULT_URL,
    as: OPERATOR,
    payload: { params: {} },
    verify: (_body, t) => expect(t.effects()).toEqual(NO_EFFECTS),
  },
  {
    operationId: 'faultClear',
    status: 204,
    title: 'disarming an armed fault',
    method: 'DELETE',
    url: DELAY_FAULT_URL,
    as: OPERATOR,
    arrange: (t) => {
      t.faults.set('projector-delay', { delayMs: 3000 });
    },
    outbound: [],
    verify: (_body, t) => {
      expect(t.faults.active()).toEqual([]);
      expect(t.effects()).toEqual({ ...NO_EFFECTS, faultToggles: 1 });
    },
  },
  { operationId: 'faultClear', status: 401, title: 'without a credential', method: 'DELETE', url: DELAY_FAULT_URL, as: 'none' },
  { operationId: 'faultClear', status: 403, title: 'for the migration workload', method: 'DELETE', url: DELAY_FAULT_URL, as: { caller: 'migration' } },
  { operationId: 'faultClear', status: 404, title: 'for a fault the registry does not know', method: 'DELETE', url: UNKNOWN_FAULT_URL, as: OPERATOR },
];

/** The declaration a contract operation requires of its route, with its operationId. */
const contractDeclaration = (op: ContractOperation) => ({ operationId: op.operationId, ...operationDeclaration(op, MIGRATION_FIELDS) });

const byId = (a: { operationId: string }, b: { operationId: string }): number => a.operationId.localeCompare(b.operationId);

/** `<operationId> <status>` of every answer the contract declares for `operations`. */
function declaredAnswers(operations: readonly ContractOperation[]): string[] {
  return operations.flatMap(({ operationId, operation }) =>
    Object.keys((operation.responses ?? {}) as Json).map((status) => `${operationId} ${status}`),
  ).sort();
}

describe('document', () => {
  it('is OpenAPI 3.1.0, version 1.0.0, at the pinned source SHA', () => {
    expect({ openapi: DOC.openapi, version: DOC.info.version, sha: DOC.info['x-source-sha'] }).toEqual({ openapi: '3.1.0', version: '1.0.0', sha: PIN.sha });
  });

  it('gives every operation a unique id, the service transport on a path outside every managed prefix and exactly one of x-opt2-requires and x-opt2-public', () => {
    expect(operationIdProblems(OPERATIONS)).toEqual({ missing: [], duplicated: [] });
    expect(operationAuthProblems(OPERATIONS, { transports: ['service'], transportForPath })).toEqual([]);
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
    const registered = collectRouteMatrix(t.app).routes.map((route) => ({
      operationId: String(findOperation(DOC, route.method, toContractPath(route.url)).operation.operationId),
      ...routeDeclaration(route, MIGRATION_FIELDS),
    }));
    expect(registered.sort(byId)).toEqual(SERVED.map(contractDeclaration).sort(byId));
  });

  it('leaves exactly the absent set unserved', () => {
    const served = new Set(collectRouteMatrix(t.app).routes.map((route) => findOperation(DOC, route.method, toContractPath(route.url)).operation.operationId));
    expect(OPERATIONS.map(({ operationId }) => operationId).filter((id) => !served.has(id)).sort()).toEqual([...ABSENT_OPERATIONS]);
  });

  it.each(OPERATIONS.filter(({ operationId }) => (ABSENT_OPERATIONS as readonly string[]).includes(operationId)))(
    'answers $method $path ($operationId) with 404 and no effect',
    async ({ method, path }) => {
      t.resetEffects();
      const url = path.replace(/\{(\w+)\}/g, (_match, name: string) => (name === 'name' ? 'projector-delay' : 'contract-probe-id'));
      const res = await t.app.inject({ method, url, headers: { ...(await invocation('operator')), 'content-type': 'application/json' }, payload: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
      expect({ status: res.statusCode, effects: t.effects() }).toEqual({ status: 404, effects: NO_EFFECTS });
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
    expect([...new Set(CASES.map(({ operationId, status }) => `${operationId} ${status}`))].sort()).toEqual(declaredAnswers(SERVED));
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
      for (const fault of t.faults.active()) t.faults.clear(fault.name);
    });

    it.each(CASES)('$operationId $status $title', async (c) => {
      const { status, outbound } = c;
      await c.arrange?.(t);
      t.resetEffects();
      const res = await sendCase(t.app, c);

      expect(res.status).toBe(status);
      if (outbound !== undefined) expect(t.calls.map(({ req, operationId }) => `${req.service} ${operationId}`)).toEqual(outbound);
      if (status === 401 || status === 403) {
        expect(t.effects()).toEqual(NO_EFFECTS);
      }
      c.verify?.(res.body, t);
    });
  });
});

const CATALOG = loadUnitCatalog(loadConfig().paths.tableOwnership);
const STUBBED_OPERATIONS = OPERATIONS.filter(({ operationId }) => (ABSENT_OPERATIONS as readonly string[]).includes(operationId));

const WINDOW_ID = '9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F';
const TRANSITION_ID = '1A2B3C4D-5E6F-4A7B-8C9D0E1F2A3B4C5D';
const ACTIVE_TRANSITION_ID = 'A1B2C3D4-E5F6-4789-ABCDEF0123456789';
const WINDOWS_URL = '/internal/v1/windows';
const WINDOW_URL = `${WINDOWS_URL}/${WINDOW_ID}`;
const GATES_URL = '/internal/v1/gates';
const TRANSITIONS_URL = '/internal/v1/transitions';
const AT = '2026-06-30T12:00:00.000Z';

const OPEN_REQUEST: Schemas['WindowOpenRequest'] = {
  routeKey: 'fixture:people/persons/{id}/archive@post',
  units: ['people.person_archive', 'programs_sites.site'],
  scope: { keys: { userid: 'A1B2C3D4-E5F6-4789-ABCDEF0123456789' } },
  requestId: 'contract-suite-request',
};
const COMPLETE_REQUEST: Schemas['WindowCompleteRequest'] = { forwarded: true, legacyStatus: 200 };
const PENDING_WINDOW: Schemas['WriteWindow'] = {
  windowId: WINDOW_ID,
  routeKey: OPEN_REQUEST.routeKey,
  units: OPEN_REQUEST.units,
  scope: OPEN_REQUEST.scope,
  state: 'import-pending',
  phase: 'import-pending',
  phases: [
    { phase: 'quiet', at: AT },
    { phase: 'executing', at: AT },
    { phase: 'importing', at: AT },
    { phase: 'import-pending', at: AT },
  ],
  rowsImported: 0,
  outcome: 'pending',
};
const RESOLVED_WINDOW: Schemas['WriteWindow'] = {
  ...PENDING_WINDOW,
  state: 'closed',
  phases: [...PENDING_WINDOW.phases, { phase: 'closed', at: AT }],
  rowsImported: 2,
  outcome: 'resolved',
};
const STARTED_TRANSITION: Schemas['Transition'] = {
  transitionId: TRANSITION_ID,
  fromVersion: 'v0001',
  toVersion: 'v0002',
  state: 'running',
  step: 1,
  units: [],
  frozenRoutes: [],
  startedAt: AT,
};
const COMPLETED_TRANSITION: Schemas['Transition'] = {
  ...STARTED_TRANSITION,
  state: 'completed',
  step: 8,
  units: OPEN_REQUEST.units,
  frozenRoutes: [OPEN_REQUEST.routeKey],
  reconciliation: { report: 'opt2/reports/reconciliation/post-cutover.json', differences: 0 },
  finishedAt: AT,
};

/** The window, lease, owner-gate and transition services the stubbed registrars call. */
const stubs = {
  open: vi.fn<WindowRouteDeps['windows']['open']>(),
  complete: vi.fn<WindowRouteDeps['windows']['complete']>(),
  get: vi.fn<WindowRouteDeps['windows']['get']>(),
  resolve: vi.fn<WindowRouteDeps['windows']['resolve']>(),
  leases: vi.fn<GatesRouteDeps['leases']>(),
  ownerGates: vi.fn<GatesRouteDeps['ownerGates']>(),
  start: vi.fn<TransitionRouteDeps['transitions']['start']>(),
  transition: vi.fn<TransitionRouteDeps['transitions']['get']>(),
};
type Stubs = typeof stubs;

const stubCalls = (): number => Object.values(stubs).reduce((sum, stub) => sum + stub.mock.calls.length, 0);

/** `extraRoutes` of the route composition: the window, gates and transition registrars over the stubs. */
function registerStubbedRoutes(app: RouteApp['app']): void {
  const { open, complete, get, resolve, leases, ownerGates, start, transition } = stubs;
  registerWindowRoutes(app, { windows: { open, complete, get, resolve } });
  registerGatesRoutes(app, { catalog: CATALOG, leases, ownerGates });
  registerTransitionRoutes(app, { transitions: { start, get: transition } });
}

/** One request against an operation served over the stubs; `status` is the declared answer it must produce. */
interface StubbedCase extends Pick<ResponseCase, 'operationId' | 'status' | 'title' | 'method' | 'url' | 'as' | 'payload'> {
  arrange?(s: Stubs): void;
  verify?(body: Json, s: Stubs): void;
}

const STUBBED_CASES: readonly StubbedCase[] = [
  {
    operationId: 'windowOpen',
    status: 201,
    title: 'opening the window for the validated request',
    method: 'POST',
    url: WINDOWS_URL,
    as: GATEWAY,
    payload: OPEN_REQUEST,
    arrange: (s) => s.open.mockResolvedValue({ windowId: WINDOW_ID, state: 'open', phase: 'executing' }),
    verify: (body, s) => {
      expect(body).toEqual({ windowId: WINDOW_ID, state: 'open', phase: 'executing' });
      expect(s.open.mock.calls).toEqual([[OPEN_REQUEST]]);
    },
  },
  {
    operationId: 'windowOpen',
    status: 400,
    title: 'for a request without a scope',
    method: 'POST',
    url: WINDOWS_URL,
    as: GATEWAY,
    payload: { routeKey: OPEN_REQUEST.routeKey, units: OPEN_REQUEST.units, requestId: OPEN_REQUEST.requestId },
  },
  { operationId: 'windowOpen', status: 401, title: 'without a credential', method: 'POST', url: WINDOWS_URL, as: 'none', payload: OPEN_REQUEST },
  { operationId: 'windowOpen', status: 403, title: 'for programs-sites', method: 'POST', url: WINDOWS_URL, as: PROGRAMS_SITES, payload: OPEN_REQUEST },
  {
    operationId: 'windowOpen',
    status: 503,
    title: 'when the open is refused after giving back what it took',
    method: 'POST',
    url: WINDOWS_URL,
    as: GATEWAY,
    payload: OPEN_REQUEST,
    arrange: (s) => s.open.mockRejectedValue(new WindowRefusedError(WINDOW_ID, 'owner-unavailable', new Error('people cannot be reached'))),
  },
  {
    operationId: 'windowOpen',
    status: 503,
    title: 'when another holder keeps the units leased',
    method: 'POST',
    url: WINDOWS_URL,
    as: OPERATOR,
    payload: OPEN_REQUEST,
    arrange: (s) => s.open.mockRejectedValue(new LeaseUnavailableError(OPEN_REQUEST.units, WINDOW_ID, [TRANSITION_ID])),
  },
  {
    operationId: 'windowGet',
    status: 200,
    title: 'with the stored window',
    method: 'GET',
    url: WINDOW_URL,
    as: OPERATOR,
    arrange: (s) => s.get.mockResolvedValue(PENDING_WINDOW),
    verify: (body, s) => {
      expect(body).toEqual(PENDING_WINDOW);
      expect(s.get.mock.calls).toEqual([[WINDOW_ID]]);
    },
  },
  { operationId: 'windowGet', status: 401, title: 'without a credential', method: 'GET', url: WINDOW_URL, as: 'none' },
  { operationId: 'windowGet', status: 403, title: 'for programs-sites', method: 'GET', url: WINDOW_URL, as: PROGRAMS_SITES },
  {
    operationId: 'windowGet',
    status: 404,
    title: 'for an id that names no window',
    method: 'GET',
    url: WINDOW_URL,
    as: GATEWAY,
    arrange: (s) => s.get.mockRejectedValue(new WindowNotFoundError(WINDOW_ID)),
  },
  {
    operationId: 'windowComplete',
    status: 200,
    title: 'closing the window once the legacy changes are imported',
    method: 'POST',
    url: `${WINDOW_URL}:complete`,
    as: GATEWAY,
    payload: COMPLETE_REQUEST,
    arrange: (s) => s.complete.mockResolvedValue({ state: 'closed' }),
    verify: (body, s) => {
      expect(body).toEqual({ state: 'closed' });
      expect(s.complete.mock.calls).toEqual([[WINDOW_ID, COMPLETE_REQUEST]]);
    },
  },
  {
    operationId: 'windowComplete',
    status: 200,
    title: 'leaving the window import-pending when the import fails',
    method: 'POST',
    url: `${WINDOW_URL}:complete`,
    as: GATEWAY,
    payload: COMPLETE_REQUEST,
    arrange: (s) => s.complete.mockResolvedValue({ state: 'import-pending' }),
    verify: (body) => expect(body).toEqual({ state: 'import-pending' }),
  },
  {
    operationId: 'windowComplete',
    status: 400,
    title: 'for a report without forwarded',
    method: 'POST',
    url: `${WINDOW_URL}:complete`,
    as: GATEWAY,
    payload: { legacyStatus: 200 },
  },
  { operationId: 'windowComplete', status: 401, title: 'without a credential', method: 'POST', url: `${WINDOW_URL}:complete`, as: 'none', payload: COMPLETE_REQUEST },
  { operationId: 'windowComplete', status: 403, title: 'for programs-sites', method: 'POST', url: `${WINDOW_URL}:complete`, as: PROGRAMS_SITES, payload: COMPLETE_REQUEST },
  {
    operationId: 'windowResolve',
    status: 200,
    title: 'resolving an import-pending window with the operator as actor',
    method: 'POST',
    url: `${WINDOW_URL}:resolve`,
    as: OPERATOR,
    arrange: (s) => s.resolve.mockResolvedValue(RESOLVED_WINDOW),
    verify: (body, s) => {
      expect(body).toEqual(RESOLVED_WINDOW);
      expect(s.resolve.mock.calls).toEqual([[WINDOW_ID, { actor: 'operator' }]]);
    },
  },
  { operationId: 'windowResolve', status: 401, title: 'without a credential', method: 'POST', url: `${WINDOW_URL}:resolve`, as: 'none' },
  { operationId: 'windowResolve', status: 403, title: 'for the gateway', method: 'POST', url: `${WINDOW_URL}:resolve`, as: GATEWAY },
  {
    operationId: 'windowResolve',
    status: 404,
    title: 'for an id that names no window',
    method: 'POST',
    url: `${WINDOW_URL}:resolve`,
    as: OPERATOR,
    arrange: (s) => s.resolve.mockRejectedValue(new WindowNotFoundError(WINDOW_ID)),
  },
  {
    operationId: 'windowResolve',
    status: 409,
    title: 'for a window that is not import-pending',
    method: 'POST',
    url: `${WINDOW_URL}:resolve`,
    as: OPERATOR,
    arrange: (s) => s.resolve.mockRejectedValue(new WindowStateError(WINDOW_ID, 'closed', 'resolve')),
  },
  {
    operationId: 'gatesList',
    status: 200,
    title: "with the lease and each owner's gate row of every named unit",
    method: 'GET',
    url: `${GATES_URL}?units=${OPEN_REQUEST.units.join(',')}`,
    as: OPERATOR,
    arrange: (s) => {
      s.leases.mockResolvedValue([{ unit: 'people.person_archive', holderId: WINDOW_ID, kind: 'window', acquiredAt: new Date(AT) }]);
      s.ownerGates.mockImplementation((_owner, units) =>
        Promise.resolve(units.map((unit) => (unit === 'people.person_archive' ? { unit, state: 'closed', holderId: WINDOW_ID, phase: 'executing' } : { unit, state: 'open', holderId: null, phase: 'quiet' }))),
      );
    },
    verify: (body, s) => {
      const [archive, site] = OPEN_REQUEST.units.map((unit) => CATALOG.unit(unit));
      expect(body).toEqual({
        units: [
          {
            unit: 'people.person_archive',
            owner: archive?.owner,
            lease: { holderId: WINDOW_ID, kind: 'window', acquiredAt: AT },
            gate: { state: 'closed', holderId: WINDOW_ID, phase: 'executing' },
          },
          { unit: 'programs_sites.site', owner: site?.owner, gate: { state: 'open', holderId: null, phase: 'quiet' } },
        ],
      });
      expect(s.leases.mock.calls).toEqual([[OPEN_REQUEST.units]]);
      expect(s.ownerGates.mock.calls.sort()).toEqual(
        [
          [archive?.owner, ['people.person_archive']],
          [site?.owner, ['programs_sites.site']],
        ].sort(),
      );
    },
  },
  {
    operationId: 'gatesList',
    status: 200,
    title: 'with the first page of the named units and the cursor of the next',
    method: 'GET',
    url: `${GATES_URL}?units=${OPEN_REQUEST.units.join(',')}&limit=1`,
    as: OPERATOR,
    arrange: (s) => {
      s.leases.mockResolvedValue([{ unit: 'people.person_archive', holderId: WINDOW_ID, kind: 'window', acquiredAt: new Date(AT) }]);
      s.ownerGates.mockImplementation((_owner, units) => Promise.resolve(units.map((unit) => ({ unit, state: 'closed', holderId: WINDOW_ID, phase: 'executing' }))));
    },
    verify: (body, s) => {
      // The follow-up request, carrying the answered cursor, is contract-valid too.
      const next = `${GATES_URL}?units=${OPEN_REQUEST.units.join(',')}&limit=1&cursor=${String(body.nextCursor)}`;
      expect(() => assertRequestMatchesOpenApi(DOC, { method: 'GET', path: next })).not.toThrow();
      const archive = CATALOG.unit('people.person_archive');
      expect(body).toEqual({
        units: [
          {
            unit: 'people.person_archive',
            owner: archive.owner,
            lease: { holderId: WINDOW_ID, kind: 'window', acquiredAt: AT },
            gate: { state: 'closed', holderId: WINDOW_ID, phase: 'executing' },
          },
        ],
        nextCursor: 'people.person_archive',
      });
      expect(s.leases.mock.calls).toEqual([[['people.person_archive']]]);
      expect(s.ownerGates.mock.calls).toEqual([[archive.owner, ['people.person_archive']]]);
    },
  },
  { operationId: 'gatesList', status: 400, title: 'for a unit the ownership file does not name', method: 'GET', url: `${GATES_URL}?units=people.unknown_table`, as: OPERATOR },
  {
    operationId: 'gatesList',
    status: 400,
    title: 'for a cursor that names no unit of the selection',
    method: 'GET',
    url: `${GATES_URL}?units=people.person_archive&cursor=programs_sites.site`,
    as: OPERATOR,
  },
  { operationId: 'gatesList', status: 401, title: 'without a credential', method: 'GET', url: GATES_URL, as: 'none' },
  { operationId: 'gatesList', status: 403, title: 'for the gateway', method: 'GET', url: GATES_URL, as: GATEWAY },
  {
    operationId: 'transitionStart',
    status: 202,
    title: 'starting the transition in the background for the operator',
    method: 'POST',
    url: TRANSITIONS_URL,
    as: OPERATOR,
    payload: { toVersion: 'v0002' },
    arrange: (s) => s.start.mockResolvedValue(STARTED_TRANSITION),
    verify: (body, s) => {
      expect(body).toEqual(STARTED_TRANSITION);
      expect(s.start.mock.calls).toEqual([[{ to: 'v0002', requestedBy: 'operator' }]]);
    },
  },
  { operationId: 'transitionStart', status: 400, title: 'for a version id outside vNNNN', method: 'POST', url: TRANSITIONS_URL, as: OPERATOR, payload: { toVersion: '2' } },
  { operationId: 'transitionStart', status: 401, title: 'without a credential', method: 'POST', url: TRANSITIONS_URL, as: 'none', payload: { toVersion: 'v0002' } },
  { operationId: 'transitionStart', status: 403, title: 'for the gateway', method: 'POST', url: TRANSITIONS_URL, as: GATEWAY, payload: { toVersion: 'v0002' } },
  {
    operationId: 'transitionStart',
    status: 409,
    title: 'while another transition is in progress',
    method: 'POST',
    url: TRANSITIONS_URL,
    as: OPERATOR,
    payload: { toVersion: 'v0002' },
    arrange: (s) => s.start.mockRejectedValue(new TransitionInProgressError(ACTIVE_TRANSITION_ID)),
  },
  {
    operationId: 'transitionGet',
    status: 200,
    title: 'with the completed transition',
    method: 'GET',
    url: `${TRANSITIONS_URL}/${TRANSITION_ID}`,
    as: OPERATOR,
    arrange: (s) => s.transition.mockResolvedValue(COMPLETED_TRANSITION),
    verify: (body, s) => {
      expect(body).toEqual(COMPLETED_TRANSITION);
      expect(s.transition.mock.calls).toEqual([[TRANSITION_ID]]);
    },
  },
  { operationId: 'transitionGet', status: 401, title: 'without a credential', method: 'GET', url: `${TRANSITIONS_URL}/${TRANSITION_ID}`, as: 'none' },
  { operationId: 'transitionGet', status: 403, title: 'for the gateway', method: 'GET', url: `${TRANSITIONS_URL}/${TRANSITION_ID}`, as: GATEWAY },
  {
    operationId: 'transitionGet',
    status: 404,
    title: 'for an id that names no transition',
    method: 'GET',
    url: `${TRANSITIONS_URL}/${TRANSITION_ID}`,
    as: OPERATOR,
    arrange: (s) => s.transition.mockRejectedValue(new TransitionNotFoundError(TRANSITION_ID)),
  },
];

describe('declared answers over stubbed window, gate and transition services', () => {
  let t: RouteApp;

  beforeAll(async () => {
    t = await buildRouteApp({ db: memoryMigrationDb().db, extraRoutes: registerStubbedRoutes });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    for (const stub of Object.values(stubs)) stub.mockReset().mockRejectedValue(new Error('the case did not arrange this stub'));
  });

  it('serves every contract operation, each with its declared transport, roles and site check, once the stubbed registrars join the composition', () => {
    const registered = collectRouteMatrix(t.app).routes.map((route) => {
      const template = toContractPath(route.url);
      const match = OPERATIONS.find(({ method, path }) => method === route.method && path === template);
      return { operationId: match?.operationId ?? `${route.method} ${template}`, ...routeDeclaration(route, MIGRATION_FIELDS) };
    });
    expect(registered.sort(byId)).toEqual(OPERATIONS.map(contractDeclaration).sort(byId));
  });

  it('registers the stubbed operations from the MIGRATION_ROUTES entries buildApp registers, at their contract method and path', () => {
    const stubbed = [...WINDOW_ROUTES, ...GATES_ROUTES, ...TRANSITION_ROUTES];
    expect(stubbed.map(({ operationId }) => operationId).sort()).toEqual([...ABSENT_OPERATIONS]);
    for (const entry of stubbed) {
      expect(MIGRATION_ROUTES).toContain(entry);
      expect({ operationId: findOperation(DOC, entry.method, entry.path).operation.operationId, template: toContractPath(entry.url) }).toEqual({
        operationId: entry.operationId,
        template: entry.path,
      });
    }
  });

  it("declares the platform's gate states and phases for each owner gate row", () => {
    type GateSchema = { properties: Record<'state' | 'phase', { enum: unknown[] }> };
    const gatesResponse = (DOC.components?.schemas as Record<string, { properties: { units: { items: { properties: { gate: GateSchema } } } } }>).GatesResponse;
    const gate = gatesResponse?.properties.units.items.properties.gate.properties;
    expect({ states: gate?.state.enum, phases: gate?.phase.enum }).toEqual({ states: [...GATE_STATES], phases: [...GATE_PHASES, null] });
  });

  it('has one answer case for every status the contract declares for a stubbed operation', () => {
    expect([...new Set(STUBBED_CASES.map(({ operationId, status }) => `${operationId} ${status}`))].sort()).toEqual(declaredAnswers(STUBBED_OPERATIONS));
  });

  it.each(STUBBED_CASES)('$operationId $status $title', async (c) => {
    c.arrange?.(stubs);
    t.resetEffects();
    const res = await sendCase(t.app, c);

    expect(res.status).toBe(c.status);
    expect(t.effects()).toEqual(NO_EFFECTS);
    if (c.arrange === undefined) expect(stubCalls()).toBe(0);
    c.verify?.(res.body, stubs);
  });
});

describe('gateway client against the gateway contract', () => {
  const ROUTE = OPEN_REQUEST.routeKey;
  const BUDGET = { timeoutMs: 1000, intervalMs: 10 };
  const ORPHAN: InflightRow = { instanceId: 'gw-0', route: ROUTE, side: 'legacy', count: 1, oldestStartedAt: AT, orphaned: true };
  const CLEAR: InflightClearRequest = { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: WINDOW_ID, at: AT }, instanceIds: ['gw-0'] };
  /** The gateway's status at `epoch`: one live instance that has seen it, and a dead one's orphaned legacy write on ROUTE. */
  const statusV2At = (epoch: number): CutoverStatusV2 => ({
    tableVersion: 'v0002',
    previous: 'v0001',
    epoch,
    groupAuthority: {},
    frozen: [ROUTE],
    instances: [
      { instanceId: 'gw-1', seenEpoch: epoch, heartbeatAt: AT, live: true },
      { instanceId: 'gw-0', seenEpoch: epoch - 1, heartbeatAt: AT, live: false },
    ],
    acknowledgedEpoch: epoch,
    inflight: [ORPHAN],
    sessionMode: 'legacy-primary',
  });
  /** `statusV2At` as `cutoverStatus` reports it, its groups without `orphaned`. */
  const statusAt = (epoch: number): CutoverStatus => {
    const status = statusV2At(epoch);
    return { ...status, inflight: status.inflight.map(({ orphaned: _orphaned, ...group }) => group) };
  };
  const respond: Responder = (req) => {
    if (req.path === '/internal/v1/cutover/activate') return jsonAnswer(200, { tableVersion: 'v0002', epoch: 8 });
    if (req.path === '/internal/v1/inflight:clear-orphans') return jsonAnswer(200, { cleared: 1 });
    if (req.path === '/internal/v2/cutover/status') return jsonAnswer(200, statusV2At(8));
    return jsonAnswer(200, statusAt(8));
  };

  it('sends each cut-over call contract-valid through the caller its operation admits, and reads each answer', async () => {
    const calls: ContractCall[] = [];
    const gateway = createGatewayClient({
      migrationClient: contractClient('migration', respond, calls),
      operatorClient: contractClient('operator', respond, calls),
      clock: createMutableClock(AT),
      sleep: () => Promise.resolve(),
    });

    const { instances } = statusV2At(8);
    expect([
      await gateway.status(),
      await gateway.activate('v0002'),
      await gateway.freeze([ROUTE]),
      await gateway.unfreeze([ROUTE]),
      await gateway.awaitEpoch(8, BUDGET),
      await gateway.inflightStatus(),
      await gateway.awaitInflightDrained([ROUTE], BUDGET),
      await gateway.clearOrphans(CLEAR),
    ]).toEqual([
      statusAt(8),
      { tableVersion: 'v0002', epoch: 8 },
      statusAt(8),
      statusAt(8),
      statusAt(8),
      { instances, inflight: [ORPHAN] },
      { orphans: [ORPHAN] },
      { cleared: 1 },
    ]);
    expect(calls.map(({ caller, operationId, status }) => [caller, operationId, status])).toEqual([
      ['migration', 'cutoverStatus', 200],
      ['operator', 'cutoverActivate', 200],
      ['operator', 'cutoverFreeze', 200],
      ['operator', 'cutoverUnfreeze', 200],
      ['migration', 'cutoverStatus', 200],
      ['migration', 'cutoverStatusV2', 200],
      ['migration', 'cutoverStatusV2', 200],
      ['migration', 'inflightClearOrphans', 200],
    ]);
    for (const { caller, req } of calls) {
      const requires = findOperation(producerContract('gateway'), req.method, req.path).operation['x-opt2-requires'];
      expect(requires).toContain(caller === 'operator' ? 'platform.operator' : 'platform.migration');
    }
  });
});
