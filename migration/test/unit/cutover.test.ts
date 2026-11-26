// Unit tests for the cut-over model, current authority and gateway client over the fixture versions and in-process gateway doubles.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CutoverDataError,
  GATEWAY_SERVICE,
  GatewayCallError,
  GatewayWaitTimeoutError,
  LOGIN_ROUTE_KEY,
  createGatewayClient,
  currentAuthority,
  diffVersions,
  entriesTouching,
  legacyBoundEntries,
  legacyWriteEntries,
  loadGroups,
  loadVersion,
  loginGroup,
  unitAuthority,
  type CutoverActivateRequest,
  type CutoverRoutesRequest,
  type CutoverStatus,
  type CutoverVersion,
  type GatewayClient,
  type InflightClearRequest,
} from '../../src/cutover/index.js';
import { createRoutedServiceClient, type RoutedServiceClient } from '../helpers/context.js';
import { createControlledSleep, createMutableClock, type ControlledSleep, type MutableClock } from '../helpers/env.js';
import {
  FIXTURE_GROUP_IDS,
  FIXTURE_ROUTES,
  ROLLBACK_GROUPS,
  UNITS,
  V0001,
  V0002,
  V0003,
  VA,
  VB,
  fixtureGroups,
  writeCutoverDir,
  type FixtureCutoverDir,
} from '../helpers/fixtures.js';
import {
  createGatewayDouble,
  type GatewayDouble,
  type GatewayDoubleOptions,
  type GatewayInflightRow,
} from '../helpers/gateway-double.js';

const STATUS_PATH = '/internal/v1/cutover/status';
const STATUS_V2_PATH = '/internal/v2/cutover/status';
const WAIT_BUDGET = { timeoutMs: 1000, intervalMs: 100 } as const;

const groups = fixtureGroups();
const allUnits = groups.groups.flatMap((group) => group.units);

const sorted = (values: Iterable<string>): string[] => [...values].sort();
const routesOf = (entries: readonly { route: string }[]): string[] => entries.map((entry) => entry.route);

/** Units of the given groups, sorted. */
function unitsOf(groupIds: Iterable<string>): string[] {
  const wanted = new Set(groupIds);
  return sorted(groups.groups.filter((group) => wanted.has(group.id)).flatMap((group) => group.units));
}

function groupsWith(version: CutoverVersion, authority: 'legacy' | 'target'): string[] {
  return Object.entries(version.groupAuthority)
    .filter(([, value]) => value === authority)
    .map(([id]) => id);
}

function thrownBy(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the read to throw');
}

describe('loadVersion and loadGroups', () => {
  let dir: FixtureCutoverDir;

  beforeAll(async () => {
    dir = await writeCutoverDir();
  });

  afterAll(async () => {
    await dir.cleanup();
  });

  it.each([V0001, V0002, V0003, VA, VB])('reads $tableVersion exactly as written', (version) => {
    expect(loadVersion(dir.cutoverDir, version.tableVersion)).toEqual(version);
  });

  it('reads the groups file exactly as written', () => {
    expect(loadGroups(dir.groupsFile)).toEqual(groups);
  });

  it('rejects a version whose tableVersion differs from its file name with CutoverDataError', async () => {
    await writeFile(path.join(dir.cutoverDir, 'versions', 'v0007.json'), JSON.stringify(V0002), 'utf8');

    const error = thrownBy(() => loadVersion(dir.cutoverDir, 'v0007'));
    expect(error).toBeInstanceOf(CutoverDataError);
    expect((error as Error).message).toMatch(/v0007\.json declares tableVersion "v0002", expected "v0007"/);
  });

  // Read and parse failures propagate unwrapped: the loaders raise CutoverDataError only for data that contradicts its name.
  it('propagates a missing version or groups file as ENOENT', () => {
    for (const read of [() => loadVersion(dir.cutoverDir, 'v0099'), () => loadGroups(path.join(dir.cutoverDir, 'absent.json'))]) {
      const error = thrownBy(read);
      expect(error).not.toBeInstanceOf(CutoverDataError);
      expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
  });

  it('propagates an invalid JSON version or groups file as SyntaxError', async () => {
    const brokenGroups = path.join(dir.cutoverDir, 'groups-broken.json');
    await writeFile(path.join(dir.cutoverDir, 'versions', 'v0008.json'), '{"tableVersion": "v0008",', 'utf8');
    await writeFile(brokenGroups, '{"groups": [', 'utf8');

    for (const read of [() => loadVersion(dir.cutoverDir, 'v0008'), () => loadGroups(brokenGroups)]) {
      expect(thrownBy(read)).toBeInstanceOf(SyntaxError);
    }
  });
});

describe('unitAuthority', () => {
  it('maps every unit to legacy under V0001, in groups-file order', () => {
    const authority = unitAuthority(V0001, groups);

    expect([...authority.keys()]).toEqual(allUnits);
    expect(new Set(authority.values())).toEqual(new Set(['legacy']));
  });

  it('maps the units of the target-authoritative groups of V0002 to target and the rest to legacy', () => {
    const authority = unitAuthority(V0002, groups);
    const targetUnits = unitsOf(groupsWith(V0002, 'target'));

    expect(groupsWith(V0002, 'legacy')).toEqual([FIXTURE_GROUP_IDS.enrolment, FIXTURE_GROUP_IDS.mailingLists]);
    expect([...authority.keys()]).toEqual(allUnits);
    for (const unit of allUnits) expect(authority.get(unit)).toBe(targetUnits.includes(unit) ? 'target' : 'legacy');
    expect(authority.get(UNITS.mailingList)).toBe('legacy');
    expect(authority.get(UNITS.person)).toBe('target');
  });
});

describe('diffVersions', () => {
  it('moves the units of every carry-write group to target from V0001 to V0002', () => {
    const diff = diffVersions(V0001, V0002, groups);
    const moved = unitsOf(groupsWith(V0002, 'target'));

    expect([...diff.changedUnits]).toEqual(moved);
    expect([...diff.toTarget]).toEqual(moved);
    expect(diff.toLegacy.size).toBe(0);
    expect(diff.changedUnits.has(UNITS.mailingList)).toBe(false);
  });

  it('lists the entries whose state changes from V0001 to V0002, each with the proposed entry', () => {
    const diff = diffVersions(V0001, V0002, groups);
    const targetEntries = V0002.entries.filter((entry) => entry.state === 'target');

    expect(routesOf(diff.changedEntries)).toEqual(routesOf(targetEntries));
    expect(routesOf(diff.changedEntries)).toContain(FIXTURE_ROUTES.siteMonitor);
    expect(routesOf(diff.changedEntries)).not.toContain(FIXTURE_ROUTES.mailingLists);
    for (const [index, change] of diff.changedEntries.entries()) {
      expect(change).toMatchObject({ from: 'legacy', to: 'target' });
      expect(change.entry).toBe(targetEntries[index]);
    }
  });

  it('lists the legacy-write entries whose units meet the moved units, sorted by route', () => {
    expect(routesOf(diffVersions(V0001, V0002, groups).legacyWritesMeetingT)).toEqual(
      sorted([FIXTURE_ROUTES.imageUpload, FIXTURE_ROUTES.siteDelete]),
    );
  });

  it('returns only the roster rollback groups to legacy from V0002 to V0003', () => {
    const diff = diffVersions(V0002, V0003, groups);
    const returned = sorted([UNITS.credential, UNITS.userAccount, UNITS.person, UNITS.personArchive]);

    expect(unitsOf(ROLLBACK_GROUPS)).toEqual(returned);
    expect([...diff.changedUnits]).toEqual(returned);
    expect([...diff.toLegacy]).toEqual(returned);
    expect(diff.toTarget.size).toBe(0);
    expect(routesOf(diff.changedEntries)).toEqual(
      sorted([FIXTURE_ROUTES.rosterAdd, FIXTURE_ROUTES.rosterUpdate, FIXTURE_ROUTES.archive, FIXTURE_ROUTES.archiveRead, FIXTURE_ROUTES.listUsers]),
    );
    expect(diff.changedEntries.every((change) => change.from === 'target' && change.to === 'legacy')).toBe(true);
    expect(routesOf(diff.legacyWritesMeetingT)).toEqual([FIXTURE_ROUTES.siteDelete]);
  });

  it('moves only the programs-sites group from VA to VB', () => {
    const diff = diffVersions(VA, VB, groups);

    expect([...diff.toTarget]).toEqual(sorted([UNITS.imageSize, UNITS.site]));
    expect(diff.toLegacy.size).toBe(0);
    expect(routesOf(diff.changedEntries)).toEqual(sorted([FIXTURE_ROUTES.siteEdit, FIXTURE_ROUTES.siteUpdate]));
    expect(routesOf(diff.legacyWritesMeetingT)).toEqual([FIXTURE_ROUTES.siteDelete]);
  });

  it.each([VA, V0001, V0002, V0003, VB])('finds no change between $tableVersion and itself', (version) => {
    const diff = diffVersions(version, version, groups);

    expect([diff.changedUnits.size, diff.toTarget.size, diff.toLegacy.size]).toEqual([0, 0, 0]);
    expect(diff.changedEntries).toEqual([]);
    expect(diff.legacyWritesMeetingT).toEqual([]);
  });
});

describe('entry selections', () => {
  it('selects every legacy-state entry', () => {
    expect(legacyBoundEntries(V0001)).toEqual(V0001.entries);
    expect(routesOf(legacyBoundEntries(V0002))).toEqual(
      sorted([FIXTURE_ROUTES.imageUpload, FIXTURE_ROUTES.mailingLists, FIXTURE_ROUTES.siteDelete, FIXTURE_ROUTES.adminAssets]),
    );
  });

  it.each([V0001, V0002])('selects only legacy-write entries of $tableVersion', (version) => {
    const selected = legacyWriteEntries(version);

    expect(routesOf(selected)).toEqual(sorted([FIXTURE_ROUTES.imageUpload, FIXTURE_ROUTES.siteDelete]));
    expect(selected.every((entry) => entry.kind === 'legacy-write')).toBe(true);
  });

  it.each([
    { name: 'the person archive', units: [UNITS.personArchive], routes: [FIXTURE_ROUTES.archive, FIXTURE_ROUTES.archiveRead] },
    { name: 'a set of mailing-list members', units: new Set([UNITS.mailingListMember]), routes: [FIXTURE_ROUTES.mailingLists, FIXTURE_ROUTES.siteDelete] },
    { name: 'no units', units: [], routes: [] },
  ])('selects only entries whose units intersect $name', ({ units, routes }) => {
    expect(routesOf(entriesTouching(V0002, units))).toEqual(sorted(routes));
  });

  it('finds the group holding the admin login write entry', () => {
    expect(LOGIN_ROUTE_KEY).toBe('admin:clogin.login');
    expect(loginGroup(groups)?.id).toBe(FIXTURE_GROUP_IDS.login);
    expect(loginGroup(groups)?.writeEntries).toContain(LOGIN_ROUTE_KEY);
  });

  it('finds no login group when no group writes the login action', () => {
    const withoutLogin = { ...groups, groups: groups.groups.filter((group) => group.id !== FIXTURE_GROUP_IDS.login) };

    expect(loginGroup(withoutLogin)).toBeUndefined();
  });
});

describe('currentAuthority', () => {
  let dir: FixtureCutoverDir;

  beforeAll(async () => {
    dir = await writeCutoverDir();
  });

  afterAll(async () => {
    await dir.cleanup();
  });

  const paths = (): { cutoverDir: string; groupsFile: string } => ({ cutoverDir: dir.cutoverDir, groupsFile: dir.groupsFile });

  it('makes every unit legacy while no version is active', async () => {
    const gateway = createGatewayDouble({ active: null, clock: createMutableClock() });
    const authority = await currentAuthority({ gateway, config: paths() });

    expect(authority.tableVersion).toBeNull();
    expect(authority.epoch).toBe(0);
    expect([...authority.units.keys()]).toEqual(allUnits);
    expect(new Set(authority.units.values())).toEqual(new Set(['legacy']));
    expect(authority.targetUnits.size).toBe(0);
    expect(authority.anyTarget).toBe(false);
    expect(allUnits.some((unit) => authority.isTargetAuthoritative(unit))).toBe(false);
    expect(gateway.calls.map((call) => call.op)).toEqual(['status']);
  });

  it.each([V0002, V0003])('makes the target groups of active $tableVersion target, with the gateway epoch', async (version) => {
    const gateway = createGatewayDouble({ active: version.tableVersion, epoch: 4, clock: createMutableClock() });
    const authority = await currentAuthority({ gateway, config: paths() });
    const expected = unitsOf(groupsWith(version, 'target'));

    expect(expected.length).toBeGreaterThan(0);
    expect(authority.tableVersion).toBe(version.tableVersion);
    expect(authority.epoch).toBe(4);
    expect([...authority.targetUnits]).toEqual(expected);
    expect(authority.anyTarget).toBe(true);
    for (const unit of allUnits) expect(authority.isTargetAuthoritative(unit)).toBe(expected.includes(unit));
    expect(authority.isTargetAuthoritative('people.no_such_table')).toBe(false);
  });
});

describe('gateway client', () => {
  const json = (status: number, body: unknown): ServiceResponse<unknown> => ({
    status,
    headers: { 'content-type': 'application/json' },
    body,
  });

  /** Answers the gateway's cut-over operations from the double's state. */
  async function answerFromDouble(double: GatewayDouble, req: ServiceRequest): Promise<ServiceResponse<unknown>> {
    switch (`${req.method} ${req.path}`) {
      case `GET ${STATUS_PATH}`:
        return json(200, await double.status());
      case `GET ${STATUS_V2_PATH}`:
        return json(200, double.snapshotV2());
      case 'POST /internal/v1/cutover/activate':
        return json(200, await double.activate((req.json as CutoverActivateRequest).tableVersion));
      case 'POST /internal/v1/cutover/freeze':
        return json(200, await double.freeze((req.json as CutoverRoutesRequest).routes));
      case 'POST /internal/v1/cutover/unfreeze':
        return json(200, await double.unfreeze((req.json as CutoverRoutesRequest).routes));
      case 'POST /internal/v1/inflight:clear-orphans':
        return json(200, await double.clearOrphans(req.json as InflightClearRequest));
      default:
        throw new Error(`Unexpected gateway call ${req.method} ${req.path}`);
    }
  }

  interface Harness {
    clock: MutableClock;
    timing: ControlledSleep;
    double: GatewayDouble;
    router: RoutedServiceClient;
    client: GatewayClient;
  }

  /** A client over a routed service client whose gateway handler serves the double; `onPoll` runs before each status answer. */
  function harness(options: Omit<GatewayDoubleOptions, 'clock'> = {}, onPoll?: (poll: number, double: GatewayDouble) => void): Harness {
    const clock = createMutableClock();
    const timing = createControlledSleep(clock);
    const double = createGatewayDouble({ ...options, clock });
    let polls = 0;
    const router = createRoutedServiceClient({
      [GATEWAY_SERVICE]: (req) => {
        if (req.path === STATUS_PATH || req.path === STATUS_V2_PATH) {
          polls += 1;
          onPoll?.(polls, double);
        }
        return answerFromDouble(double, req);
      },
    });
    const client = createGatewayClient({ migrationClient: router, operatorClient: router.as('operator'), clock, sleep: timing.sleep });
    return { clock, timing, double, router, client };
  }

  const recorded = (router: RoutedServiceClient): unknown[][] => router.calls.map((call) => [call.caller, call.method, call.path, call.json]);

  /** Runs a wait to its end through the controlled sleep; returns its result or error and the clock time it took. */
  async function runWait({ clock, timing }: Harness, wait: () => Promise<unknown>): Promise<{ outcome: unknown; elapsedMs: number }> {
    const started = clock.now().getTime();
    const settled = wait().catch((error: unknown) => error);
    await timing.flush();
    const outcome = await settled;
    expect(timing.pending()).toBe(0);
    return { outcome, elapsedMs: clock.now().getTime() - started };
  }

  it('reads the status as the migration caller and activates, freezes and unfreezes as the operator caller', async () => {
    const { double, router, client } = harness({ active: 'v0001', epoch: 3 });

    expect(await client.status()).toEqual(double.snapshot());
    expect(await client.activate('v0002')).toEqual({ tableVersion: 'v0002', epoch: 4 });
    expect(await client.freeze([FIXTURE_ROUTES.rosterUpdate, FIXTURE_ROUTES.rosterAdd])).toMatchObject({
      tableVersion: 'v0002',
      epoch: 5,
      frozen: sorted([FIXTURE_ROUTES.rosterAdd, FIXTURE_ROUTES.rosterUpdate]),
    });
    expect(await client.unfreeze([FIXTURE_ROUTES.rosterAdd])).toMatchObject({ epoch: 6, frozen: [FIXTURE_ROUTES.rosterUpdate] });

    expect(recorded(router)).toEqual([
      ['migration', 'GET', STATUS_PATH, undefined],
      ['operator', 'POST', '/internal/v1/cutover/activate', { tableVersion: 'v0002' }],
      ['operator', 'POST', '/internal/v1/cutover/freeze', { routes: [FIXTURE_ROUTES.rosterUpdate, FIXTURE_ROUTES.rosterAdd] }],
      ['operator', 'POST', '/internal/v1/cutover/unfreeze', { routes: [FIXTURE_ROUTES.rosterAdd] }],
    ]);
    expect(router.calls.every((call) => call.service === GATEWAY_SERVICE && call.userToken === null)).toBe(true);
  });

  it('clears orphans as the migration caller with the legacy-restart evidence of a window', async () => {
    const startedAt = createMutableClock().now().getTime() - 60_000;
    const { clock, double, router, client } = harness({
      inflight: [{ instance: 'gw-dead', requestId: 'req-orphan', route: FIXTURE_ROUTES.imageUpload, side: 'legacy', startedAt, orphan: true }],
    });
    const windowId = 'win-0001';
    // The contract carries the window that ran the legacy restart as the evidence's holder.
    const request: InflightClearRequest = { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: windowId, at: clock.now().toISOString() } };

    expect(await client.clearOrphans(request)).toEqual({ cleared: 1 });
    expect(recorded(router)).toEqual([['migration', 'POST', '/internal/v1/inflight:clear-orphans', request]]);
    expect(double.inflightRows()).toEqual([]);
  });

  const failingCalls: Array<{ name: string; status: number; operationId: string; call: (client: GatewayClient) => Promise<unknown> }> = [
    { name: 'status', status: 503, operationId: 'cutoverStatus', call: (client) => client.status() },
    { name: 'activate', status: 500, operationId: 'cutoverActivate', call: (client) => client.activate('v0002') },
    { name: 'freeze', status: 503, operationId: 'cutoverFreeze', call: (client) => client.freeze([FIXTURE_ROUTES.rosterAdd]) },
    { name: 'unfreeze', status: 500, operationId: 'cutoverUnfreeze', call: (client) => client.unfreeze([FIXTURE_ROUTES.rosterAdd]) },
    {
      name: 'clearOrphans',
      status: 503,
      operationId: 'inflightClearOrphans',
      call: (client) =>
        client.clearOrphans({ side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'win-0002', at: '2026-06-30T12:00:00.000Z' } }),
    },
  ];

  it.each(failingCalls)('surfaces a $status answer to $name as GatewayCallError with its status and body', async ({ status, operationId, call }) => {
    const body = { apiversion: 'v1', method: operationId, error: { code: 'server_error', message: 'Unhandled Exception' } };
    const router = createRoutedServiceClient({ [GATEWAY_SERVICE]: () => json(status, body) });
    const client = createGatewayClient({ migrationClient: router, operatorClient: router.as('operator') });

    const error = await call(client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GatewayCallError);
    expect(error).toMatchObject({ operation: operationId, status, body });
  });

  it('resolves awaitEpoch once every live instance reports the epoch', async () => {
    const run = harness({ active: 'v0001', epoch: 4, instances: ['gw-1', 'gw-2'], manualAck: ['gw-2'] }, (poll, double) => {
      if (poll === 3) double.ackEpoch('gw-2', 5);
    });
    run.double.setActive('v0002', 5);

    const { outcome, elapsedMs } = await runWait(run, () => run.client.awaitEpoch(5, WAIT_BUDGET));

    expect(outcome).toMatchObject({ tableVersion: 'v0002', epoch: 5 });
    expect((outcome as CutoverStatus).instances.map((instance) => instance.seenEpoch)).toEqual([5, 5]);
    expect(run.router.calls).toHaveLength(3);
    expect(elapsedMs).toBe(2 * WAIT_BUDGET.intervalMs);
  });

  it('rejects awaitEpoch with GatewayWaitTimeoutError naming the lagging instance once the budget is spent', async () => {
    const run = harness({ active: 'v0001', epoch: 4, instances: ['gw-1', 'gw-2'], manualAck: ['gw-2'] });
    run.double.setActive('v0002', 5);

    const { outcome, elapsedMs } = await runWait(run, () => run.client.awaitEpoch(5, WAIT_BUDGET));

    expect(outcome).toBeInstanceOf(GatewayWaitTimeoutError);
    expect(outcome).toMatchObject({ kind: 'epoch', epoch: 5, lagging: [{ instanceId: 'gw-2', seenEpoch: 4, live: true }] });
    expect(elapsedMs).toBe(WAIT_BUDGET.timeoutMs);
    expect(run.router.calls).toHaveLength(WAIT_BUDGET.timeoutMs / WAIT_BUDGET.intervalMs + 1);
    expect(recorded(run.router).every(([caller, method, route]) => caller === 'migration' && method === 'GET' && route === STATUS_PATH)).toBe(true);
  });

  const inflightRows = (startedAt: number): GatewayInflightRow[] => [
    { instance: 'gw-1', requestId: 'req-live', route: FIXTURE_ROUTES.rosterAdd, side: 'target', startedAt },
    { instance: 'gw-dead', requestId: 'req-dead', route: FIXTURE_ROUTES.rosterUpdate, side: 'legacy', startedAt, orphan: true },
    { instance: 'gw-1', requestId: 'req-other', route: FIXTURE_ROUTES.contentUpdate, side: 'target', startedAt },
  ];
  const awaitedRoutes = [FIXTURE_ROUTES.rosterAdd, FIXTURE_ROUTES.rosterUpdate];

  it('resolves awaitInflightDrained once live writes on the routes finish, returning the rows of dead instances as orphans', async () => {
    const startedAt = createMutableClock().now().getTime() - 5_000;
    const run = harness({ inflight: inflightRows(startedAt) }, (poll, double) => {
      if (poll === 2) double.removeInflight('req-live');
    });

    const { outcome, elapsedMs } = await runWait(run, () => run.client.awaitInflightDrained(awaitedRoutes, WAIT_BUDGET));

    expect(outcome).toEqual({
      orphans: [
        {
          instanceId: 'gw-dead',
          route: FIXTURE_ROUTES.rosterUpdate,
          side: 'legacy',
          count: 1,
          oldestStartedAt: new Date(startedAt).toISOString(),
          orphaned: true,
        },
      ],
    });
    expect(run.router.calls).toHaveLength(2);
    expect(elapsedMs).toBe(WAIT_BUDGET.intervalMs);
  });

  it("returns a live instance's abandoned target write as an orphan without waiting, and gates-closed evidence clears only it", async () => {
    const startedAt = createMutableClock().now().getTime() - 5_000;
    const units = ['identity.user_account', 'people.person'];
    const run = harness({
      inflight: [
        { instance: 'gw-1', requestId: 'req-abandoned', route: FIXTURE_ROUTES.rosterAdd, side: 'target', startedAt, abandoned: true, units },
        { instance: 'gw-1', requestId: 'req-other', route: FIXTURE_ROUTES.contentUpdate, side: 'target', startedAt, units },
      ],
    });

    const { outcome, elapsedMs } = await runWait(run, () => run.client.awaitInflightDrained(awaitedRoutes, WAIT_BUDGET));

    expect(outcome).toEqual({
      orphans: [
        {
          instanceId: 'gw-1',
          route: FIXTURE_ROUTES.rosterAdd,
          side: 'target',
          count: 1,
          oldestStartedAt: new Date(startedAt).toISOString(),
          orphaned: true,
        },
      ],
    });
    expect(run.router.calls).toHaveLength(1);
    expect(elapsedMs).toBe(0);
    const evidence = { kind: 'gates-closed', holderId: 'trn-0001', at: run.clock.now().toISOString(), units } as const;
    expect(await run.client.clearOrphans({ side: 'target', evidence, instanceIds: ['gw-1'] })).toEqual({ cleared: 1 });
    expect(run.double.inflightRows().map((row) => row.requestId)).toEqual(['req-other']);
  });

  it('rejects awaitInflightDrained with GatewayWaitTimeoutError naming the live rows left once the budget is spent', async () => {
    const startedAt = createMutableClock().now().getTime() - 5_000;
    const run = harness({ inflight: inflightRows(startedAt) });

    const { outcome, elapsedMs } = await runWait(run, () => run.client.awaitInflightDrained(awaitedRoutes, WAIT_BUDGET));

    expect(outcome).toBeInstanceOf(GatewayWaitTimeoutError);
    expect(outcome).toMatchObject({ kind: 'inflight', pending: [{ instanceId: 'gw-1', route: FIXTURE_ROUTES.rosterAdd, side: 'target', count: 1 }] });
    expect(elapsedMs).toBe(WAIT_BUDGET.timeoutMs);
    expect(run.router.calls).toHaveLength(WAIT_BUDGET.timeoutMs / WAIT_BUDGET.intervalMs + 1);
  });
});
