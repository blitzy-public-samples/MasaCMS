// Consumer contracts of the package's service clients: each owners-client operation against every owner contract serving it,
// the remote background and fault clients against the real routes, and the window and transition clients against the migration contract.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { CURSOR_START, formatWritePosition, type ApplyRequest, type GateRequest, type WatermarkRecord } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import type { QueueControlOp } from '@opt2/platform/tasks';
import { TENANT_A, mintServiceToken } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { remoteFaults } from '../../src/faults/index.js';
import { createOwnersClient, type OwnersClient } from '../../src/owners/client.js';
import { loadUnitCatalog, type DataOwner } from '../../src/owners/units.js';
import { queueControlTargets, remoteBackgroundState, type BackgroundRecord } from '../../src/quiesce/index.js';
import { requestTransition } from '../../src/transition/request.js';
import { completeWindowViaService, openWindowViaService, resolveWindowViaService } from '../../src/windows/via-service.js';
import {
  ABSENT_OPERATIONS,
  SERVICE,
  assertAnswerMatchesContract,
  assertCallMatchesContract,
  buildRouteApp,
  contractClient,
  jsonAnswer,
  memoryMigrationDb,
  unreachable,
  type ContractCall,
  type RouteApp,
} from '../helpers/route-app.js';

const CONFIG = loadConfig();
const CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
const DATA_OWNERS: readonly DataOwner[] = CONFIG.dataOwners;
const TENANT = TENANT_A.tenantId;
const FILE_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const WINDOW_ID = '7B2C3D4E-5F60-4172-8394A50516273849';
const EVENT_ID = 'a0000000-0000-4000-8000-00000000000a';
const WALL_CLOCK = '2026-06-30T12:00:00.000';
const BYTES = Buffer.from('route-suites object bytes');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');

/** A first unit of `owner` and one legacy table it maps, from the ownership file. */
function unitOf(owner: DataOwner): { unit: string; legacyTable: string } {
  const unit = CATALOG.unitsOfOwner(owner)[0];
  const legacyTable = unit?.legacyTables[0];
  if (unit === undefined || legacyTable === undefined) throw new TypeError(`The ownership file gives ${owner} no unit with a legacy table`);
  return { unit: unit.id, legacyTable };
}

/** One owners-client call: what it sends, the producer-valid answer it receives and what it must return. */
interface ClientCase {
  name: string;
  run(owners: OwnersClient): Promise<unknown>;
  answer(req: ServiceRequest): ServiceResponse;
  /** `<service> <METHOD> <path>` of each call, in order. */
  operations: readonly string[];
  check(result: unknown): void | Promise<void>;
}

/** The migration-kit endpoints every data owner serves. */
function migrationKitCases(owner: DataOwner): ClientCase[] {
  const { unit, legacyTable } = unitOf(owner);
  const position = formatWritePosition(new Map([[owner, '41']]));
  const watermark: WatermarkRecord = { legacyTable, direction: 'forward', snapshotSeq: 3, backupLsn: '41000000012300001', finishedAt: WALL_CLOCK };
  const apply: ApplyRequest = {
    batchId: `route-suites-${owner}`,
    origin: 'backfill',
    legacyTable,
    tenantId: TENANT,
    columns: [{ name: 'ID', type: 's' }],
    rows: [{ op: 'upsert', row: '["route-suites"]' }],
  };
  const gate = (req: GateRequest): ClientCase => ({
    name: `gate ${req.op}`,
    run: (owners) => owners.gate(owner, req),
    answer: () => jsonAnswer(200, { units: [{ unit, state: req.op === 'close' ? 'closed' : 'open', holderId: req.op === 'close' ? 'window-1' : null, phase: 'quiet' }] }),
    operations: [`${owner} POST /internal/v1/migration/gate`],
    check: (result) => expect(result).toMatchObject({ units: [{ unit }] }),
  });
  const page = (next: string | null) => ({ unit, tenantId: TENANT, tables: [], next });
  return [
    {
      name: 'apply',
      run: (owners) => owners.apply(owner, apply),
      answer: () => jsonAnswer(200, { batchId: apply.batchId, duplicate: false, applied: 1, skipped: 0 }, { 'x-opt2-write-position': position }),
      operations: [`${owner} POST /internal/v1/migration/apply`],
      check: (result) => expect(result).toEqual({ batchId: apply.batchId, duplicate: false, applied: 1, skipped: 0, writePositions: new Map([[owner, '41']]) }),
    },
    {
      name: 'export with every parameter',
      run: (owners) => owners.export(owner, { unit, tenantId: TENANT, programId: 2, after: 'k1', match: { siteID: ['tenant-a'] }, limit: 500, keys: ['s:k1', 's:k2'] }),
      answer: () => jsonAnswer(200, page(null)),
      operations: [`${owner} GET /internal/v1/migration/export`],
      check: (result) => expect(result).toEqual(page(null)),
    },
    {
      name: 'exportPages across two pages',
      run: async (owners) => {
        const pages: unknown[] = [];
        for await (const exported of owners.exportPages(owner, { unit, tenantId: TENANT })) pages.push(exported);
        return pages;
      },
      answer: (req) => jsonAnswer(200, page(req.query?.after === undefined ? 'k1' : null)),
      operations: [`${owner} GET /internal/v1/migration/export`, `${owner} GET /internal/v1/migration/export`],
      check: (result) => expect(result).toEqual([page('k1'), page(null)]),
    },
    {
      name: 'changes',
      run: (owners) => owners.changes(owner, { tenantId: TENANT, after: CURSOR_START, limit: 1000 }),
      answer: () => jsonAnswer(200, { rows: [], cursor: CURSOR_START, horizon: '42', complete: true, operations: {} }),
      operations: [`${owner} GET /internal/v1/migration/changes`],
      check: (result) => expect(result).toMatchObject({ horizon: '42', complete: true }),
    },
    {
      name: 'position with receipts and published topics',
      run: (owners) => owners.position(owner, { eventIds: [EVENT_ID], publishedTopics: ['people.person.archived.v1'] }),
      answer: () => jsonAnswer(200, { owner, position: '42', outbox: null, inbox: null, published: [] }),
      operations: [`${owner} GET /internal/v1/migration/position`],
      check: (result) => expect(result).toMatchObject({ owner, position: '42' }),
    },
    {
      name: 'watermark',
      run: (owners) => owners.watermark(owner, legacyTable, 'forward'),
      answer: () => jsonAnswer(200, [watermark]),
      operations: [`${owner} GET /internal/v1/migration/watermark`],
      check: (result) => expect(result).toEqual(watermark),
    },
    {
      name: 'putWatermark without a sequence or LSN',
      run: (owners) => owners.putWatermark(owner, { ...watermark, snapshotSeq: null, backupLsn: null }),
      answer: () => jsonAnswer(200, { ...watermark, snapshotSeq: null, backupLsn: null }),
      operations: [`${owner} POST /internal/v1/migration/watermark`],
      check: (result) => expect(result).toEqual({ ...watermark, snapshotSeq: null, backupLsn: null }),
    },
    gate({ op: 'close', units: [unit], holderId: 'window-1', phase: 'quiet' }),
    gate({ op: 'phase', units: [unit], holderId: 'window-1', phase: 'importing' }),
    gate({ op: 'open', units: [unit], holderId: 'window-1' }),
    gate({ op: 'status', units: [unit] }),
  ];
}

const OWNER_CASES = DATA_OWNERS.flatMap((owner) => migrationKitCases(owner).map((c) => ({ owner, ...c })));

const QUEUE_CASES = queueControlTargets(Object.fromEntries(DATA_OWNERS.map((owner) => [owner, 'http://127.0.0.1:9']))).flatMap(({ service, queue }) =>
  (['pause', 'resume', 'ensure'] as const satisfies readonly QueueControlOp[]).map((op) => ({ service: service as DataOwner, queue, op })),
);

/** A streamed answer of `bytes`. */
function streamAnswer(bytes: Buffer): ServiceResponse {
  return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: Readable.from([bytes]) };
}

const OWNER_SPECIFIC: readonly ClientCase[] = [
  {
    name: 'putObject to strategies-content',
    run: (owners) => owners.putObject({ tenantId: TENANT, fileId: FILE_ID, variant: '_small', ext: 'jpg', contentType: 'image/jpeg', sha256: SHA256 }, BYTES),
    answer: () =>
      jsonAnswer(200, { key: `${TENANT}/${FILE_ID}_small.jpg`, size: BYTES.length, sha256: SHA256, created: true }, { 'x-opt2-write-position': 'strategies-content=77' }),
    operations: ['strategies-content POST /internal/v1/migration/objects'],
    check: (result) => expect(result).toMatchObject({ created: true, writePositions: new Map([['strategies-content', '77']]) }),
  },
  {
    name: 'getObject from strategies-content',
    run: (owners) => owners.getObject(`${TENANT}/${FILE_ID}_small.jpg`),
    answer: () => streamAnswer(BYTES),
    operations: ['strategies-content GET /internal/v1/migration/objects'],
    check: async (result) => expect(await text(result as Readable)).toBe(BYTES.toString()),
  },
  {
    name: 'deleteObject from strategies-content',
    run: (owners) => owners.deleteObject(`${TENANT}/${FILE_ID}_small.jpg`),
    answer: () => jsonAnswer(200, { key: `${TENANT}/${FILE_ID}_small.jpg`, deleted: true }, { 'x-opt2-write-position': 'strategies-content=78' }),
    operations: ['strategies-content DELETE /internal/v1/migration/objects'],
    check: (result) => expect(result).toEqual({ key: `${TENANT}/${FILE_ID}_small.jpg`, deleted: true, writePositions: new Map([['strategies-content', '78']]) }),
  },
  {
    name: 'deleteObject of a key strategies-content no longer records',
    run: (owners) => owners.deleteObject(`${TENANT}/${FILE_ID}_small.jpg`),
    answer: () => jsonAnswer(200, { key: `${TENANT}/${FILE_ID}_small.jpg`, deleted: false }),
    operations: ['strategies-content DELETE /internal/v1/migration/objects'],
    check: (result) => expect(result).toEqual({ key: `${TENANT}/${FILE_ID}_small.jpg`, deleted: false, writePositions: new Map() }),
  },
  {
    name: 'getAttachmentObject from finance',
    run: (owners) => owners.getAttachmentObject({ tenantId: TENANT, attachmentId: FILE_ID }),
    answer: () => streamAnswer(BYTES),
    operations: ['finance GET /internal/v1/migration/objects'],
    check: async (result) => expect(await text(result as Readable)).toBe(BYTES.toString()),
  },
  {
    name: 'siteMonitorState of programs-sites',
    run: (owners) => owners.siteMonitorState(),
    answer: () => jsonAnswer(200, { lastMonitored: WALL_CLOCK, updatedAt: WALL_CLOCK }),
    operations: ['programs-sites GET /internal/v1/sitemonitor/state'],
    check: (result) => expect(result).toEqual({ lastMonitored: WALL_CLOCK, updatedAt: WALL_CLOCK }),
  },
  {
    name: 'putSiteMonitorState to programs-sites with the bridge cursor',
    run: (owners) => owners.putSiteMonitorState({ lastMonitored: WALL_CLOCK }),
    answer: () => jsonAnswer(200, { lastMonitored: WALL_CLOCK, updatedAt: WALL_CLOCK }),
    operations: ['programs-sites PUT /internal/v1/sitemonitor/state'],
    check: (result) => expect(result).toEqual({ lastMonitored: WALL_CLOCK, updatedAt: WALL_CLOCK }),
  },
  {
    name: 'adoptScheduledTasks to communications',
    run: (owners) =>
      owners.adoptScheduledTasks({
        tasks: [{ name: 'opt2-survey-9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F-launch', siteId: 'tenant-a', scheduleTime: WALL_CLOCK, scheduleVersion: 1 }],
      }),
    answer: () => jsonAnswer(200, { adopted: 1, existing: 0, scheduledImmediately: 0 }),
    operations: ['communications POST /internal/v1/migration/adopt-scheduled-tasks'],
    check: (result) => expect(result).toEqual({ adopted: 1, existing: 0, scheduledImmediately: 0 }),
  },
  {
    name: 'cancelAdoptedScheduledTasks to communications',
    run: (owners) => owners.cancelAdoptedScheduledTasks({ names: ['opt2-survey-9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F-launch'] }),
    answer: () => jsonAnswer(200, { cancelled: 1 }),
    operations: ['communications POST /internal/v1/migration/cancel-adopted-scheduled-tasks'],
    check: (result) => expect(result).toEqual({ cancelled: 1 }),
  },
];

/** Runs one owners-client case over a contract-checked migration client and returns the calls it made. */
async function runCase(c: Pick<ClientCase, 'run' | 'answer' | 'check'>): Promise<ContractCall[]> {
  const calls: ContractCall[] = [];
  const owners = createOwnersClient({ client: contractClient(SERVICE, c.answer, calls), catalog: CATALOG });
  await c.check(await c.run(owners));
  return calls;
}

const operationsOf = (calls: readonly ContractCall[]): string[] => calls.map(({ req }) => `${req.service} ${req.method} ${req.path}`);

describe('owners client against the owner contracts', () => {
  it.each(OWNER_CASES)('$owner $name', async (c) => {
    expect(operationsOf(await runCase(c))).toEqual(c.operations);
  });

  it.each(OWNER_SPECIFIC)('$name', async (c) => {
    expect(operationsOf(await runCase(c))).toEqual(c.operations);
  });

  it('covers queue control on every queue a data owner creates', () => {
    expect(QUEUE_CASES.length).toBeGreaterThan(0);
  });

  it.each(QUEUE_CASES)('queueControl $op of $queue on $service', async ({ service, queue, op }) => {
    const answer = (): ServiceResponse =>
      jsonAnswer(200, op === 'ensure' ? { queue, service, ensured: { queue, name: `${queue}-1782820800`, created: false, reason: 'live' } } : { queue, service, paused: op === 'pause' });
    const calls = await runCase({ run: (owners) => owners.queueControl(service, queue, op), answer, check: (result) => expect(result).toMatchObject({ queue, service }) });
    expect(calls.map(({ req, caller }) => [caller, req.service, req.method, req.path])).toEqual([[SERVICE, service, 'POST', `/internal/v1/task-queues/${queue}/${op}`]]);
  });
});

/** A service client of `caller` that serves each call through `app.inject`, both sides checked against the migration contract. */
function injectingClient(app: RouteApp['app'], caller: string, calls: ContractCall[]): ServiceClient {
  return {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push({ caller, req, operationId: assertCallMatchesContract(caller, req) });
      const token = await mintServiceToken({ caller, audience: SERVICE });
      const res = await app.inject({
        method: req.method,
        url: req.path,
        headers: { [INVOCATION_HEADER]: `Bearer ${token}`, ...(req.json === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(req.json === undefined ? {} : { payload: JSON.stringify(req.json) }),
      });
      // A 204 carries neither a body nor a content type.
      const answer: ServiceResponse =
        res.body === ''
          ? { status: res.statusCode, headers: {}, body: undefined }
          : { status: res.statusCode, headers: { 'content-type': String(res.headers['content-type']) }, body: res.json<unknown>() };
      assertAnswerMatchesContract(req, answer);
      return answer as ServiceResponse<T>;
    },
    close: () => Promise.resolve(),
  };
}

describe('remote background client against the real background routes', () => {
  const RECORD: BackgroundRecord = {
    suspended: true,
    since: '2026-06-30T11:30:00.000Z',
    reason: 'golden capture',
    pushConfigs: { 'timesheets.people.person.archived.v1': { pushEndpoint: 'http://127.0.0.1:20118/internal/v1/events/x', attributes: {} } },
    pausedQueues: [{ service: 'people', queue: 'people-outbox-sweep' }],
    pausedTasks: ['opt2-survey-9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F-launch'],
  };
  let t: RouteApp;
  const calls: ContractCall[] = [];

  beforeAll(async () => {
    t = await buildRouteApp({ db: memoryMigrationDb().db });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  const remote = () => remoteBackgroundState({ db: t.ctx.db, clock: t.ctx.clock, clientAs: (caller) => injectingClient(t.app, caller, calls) });

  it('suspends through backgroundSuspend as the operator and reads back the record the route stored', async () => {
    await expect(remote().suspend(RECORD)).resolves.toEqual(RECORD);
    await expect(remote().isSuspended()).resolves.toBe(true);
    expect(calls.map(({ caller, operationId }) => [caller, operationId])).toEqual([['operator', 'backgroundSuspend']]);
  });

  it('resumes through backgroundResume as the operator and reads back the cleared record', async () => {
    await remote().suspend(RECORD);
    const resumed = await remote().resume();
    expect(resumed).toMatchObject({ suspended: false, since: null, pushConfigs: {}, pausedQueues: [], pausedTasks: [], resumedAt: expect.any(String) as unknown });
    expect(calls.map(({ caller, operationId }) => [caller, operationId])).toEqual([
      ['operator', 'backgroundSuspend'],
      ['operator', 'backgroundResume'],
    ]);
  });
});

describe('remote fault client against the real fault routes', () => {
  let t: RouteApp;
  const calls: ContractCall[] = [];

  beforeAll(async () => {
    t = await buildRouteApp({ db: memoryMigrationDb().db });
  });

  afterAll(async () => {
    await t?.close();
  });

  const remote = () => remoteFaults({ env: t.ctx.env, clientAs: (caller) => injectingClient(t.app, caller, calls) });

  it('arms and disarms the projector delay through faultSet and faultClear as the operator', async () => {
    await remote().set('projector-delay', { delayMs: 3000 });
    expect(t.faults.active()).toEqual([{ name: 'projector-delay', params: { delayMs: 3000 }, since: expect.any(String) as unknown }]);

    await remote().clear('projector-delay');
    expect(t.faults.active()).toEqual([]);
    expect(calls.map(({ caller, operationId }) => [caller, operationId])).toEqual([
      ['operator', 'faultSet'],
      ['operator', 'faultClear'],
    ]);
  });
});

describe('window and transition clients against the migration contract', () => {
  const calls: ContractCall[] = [];
  // No registrar serves these operations yet, so the service is unreachable for them, as it is at run time.
  const ctx = { clientAs: (caller: string) => contractClient(caller, (req) => Promise.reject(unreachable(req.service)), calls), config: CONFIG };

  beforeEach(() => {
    calls.length = 0;
  });

  it.each<{ name: string; run: () => Promise<unknown>; operationId: string }>([
    { name: 'openWindowViaService', run: () => openWindowViaService(ctx, { units: ['people.person_archive', 'timesheets.blackout'] }), operationId: 'windowOpen' },
    { name: 'completeWindowViaService', run: () => completeWindowViaService(ctx, WINDOW_ID, { forwarded: true }), operationId: 'windowComplete' },
    { name: 'resolveWindowViaService', run: () => resolveWindowViaService(ctx, WINDOW_ID), operationId: 'windowResolve' },
    { name: 'requestTransition', run: () => requestTransition(ctx, { to: 'v0002', pollMs: 1 }), operationId: 'transitionStart' },
  ])('$name sends a contract-valid $operationId call as the operator', async ({ run, operationId }) => {
    await expect(run()).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(calls.map(({ caller, req, operationId: reached }) => [caller, req.service, reached])).toEqual([['operator', SERVICE, operationId]]);
    expect(ABSENT_OPERATIONS).toContain(operationId);
  });
});
