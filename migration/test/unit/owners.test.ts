// Unit tests for the owners client: each endpoint's owner, route, query and body, write positions, and failures.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CURSOR_START,
  WRITE_POSITION_HEADER,
  formatWritePosition,
  type ApplyRequest,
  type ApplyResponse,
  type ChangesResponse,
  type ExportResponse,
  type GateRequest,
  type GateResponse,
  type PositionResponse,
  type WatermarkRecord,
} from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { SITEMONITOR_QUEUE, type QueueControlOp, type QueueControlResult } from '@opt2/platform/tasks';
import { describe, expect, it } from 'vitest';

import {
  GateConflict,
  OwnerCallError,
  createOwnersClient,
  type AdoptScheduledTasksRequest,
  type FileObject,
  type OwnersClient,
  type PutObjectParams,
  type SiteMonitorState,
  type WatermarkWrite,
} from '../../src/owners/client.js';
import type { DataOwner, UnitCatalog } from '../../src/owners/units.js';

/** One answer of the fake: a response merged over a bodiless 200, or an error the request rejects with. */
type Answer = Partial<ServiceResponse> | Error;

const TENANT = '0b0c4f7e-3f7a-4c1e-9a55-1d2b3c4d5e6f';
const UNIT = 'people.person';
const FILE_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const EVENT_IDS = ['a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000b'];
const TOPICS = ['people.person.archived.v1', 'people.person.changed.v1'];

// The client needs no catalog fact, so reading any member fails the test.
const UNUSED_CATALOG = new Proxy({} as UnitCatalog, {
  get(_target, member) {
    throw new Error(`catalog.${String(member)} was read`);
  },
});

const routeOf = (req: Pick<ServiceRequest, 'service' | 'method' | 'path'>): string => `${req.service} ${req.method} ${req.path}`;

/** Owners client over a service client answering each `<service> <method> <path>` from its queue and recording every request. */
function routedClient(routes: Record<string, Answer[]>): { owners: OwnersClient; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      const answer = routes[routeOf(req)]?.shift();
      if (answer === undefined) return Promise.reject(new Error(`unrouted ${routeOf(req)}`));
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ status: 200, headers: {}, body: undefined, ...answer } as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };
  return { owners: createOwnersClient({ client, catalog: UNUSED_CATALOG }), calls };
}

const APPLY_REQUEST: ApplyRequest = {
  batchId: 'batch-1',
  origin: 'backfill',
  legacyTable: 'tusers',
  tenantId: TENANT,
  columns: [{ name: 'UserID', type: 's' }],
  rows: [{ op: 'upsert', row: '["user-1"]' }],
};
const APPLY_ANSWER: ApplyResponse = { batchId: 'batch-1', duplicate: false, applied: 1, skipped: 0 };
const GATE_REQUEST: GateRequest = { op: 'close', units: [UNIT], holderId: 'window-1', phase: 'quiet' };
const GATE_ANSWER: GateResponse = { units: [{ unit: UNIT, state: 'closed', holderId: 'window-1', phase: 'quiet' }] };
const CHANGES_ANSWER: ChangesResponse = { rows: [], cursor: CURSOR_START, horizon: '42', complete: true, operations: {} };
const POSITION_ANSWER: PositionResponse = { owner: 'people', position: '123', outbox: null, inbox: null };
const WATERMARK: WatermarkRecord = {
  legacyTable: 'tusers',
  direction: 'forward',
  snapshotSeq: 3,
  backupLsn: '41000000012300001',
  finishedAt: '2026-03-01T10:00:00.000',
};
const MONITOR_STATE: SiteMonitorState = { lastMonitored: '2026-03-01 10:15:00.000', updatedAt: '2026-03-01 10:15:02.000' };
const ADOPT_REQUEST: AdoptScheduledTasksRequest = {
  tasks: [{ name: 'survey-1', siteId: 'tenant-a', scheduleTime: '2026-03-02 09:00:00.000', scheduleVersion: 1 }],
};

function exportPage(next: string | null): ExportResponse {
  return { unit: UNIT, tenantId: TENANT, tables: [], next };
}

interface RouteCase {
  name: string;
  call: (owners: OwnersClient) => Promise<unknown>;
  request: ServiceRequest;
  answer: unknown;
}

describe('createOwnersClient', () => {
  it.each<RouteCase>([
    {
      name: 'export sends every parameter as query text',
      call: (owners) =>
        owners.export('people', { unit: UNIT, tenantId: TENANT, programId: 2, after: 'k1', match: { siteID: ['tenant-a'], Type: [2] }, limit: 500, keys: ['s2:u1', 's2:u2'] }),
      request: {
        service: 'people',
        method: 'GET',
        path: '/internal/v1/migration/export',
        query: { unit: UNIT, tenantId: TENANT, programId: '2', after: 'k1', match: '{"siteID":["tenant-a"],"Type":[2]}', limit: '500', keys: ['s2:u1', 's2:u2'] },
        userToken: null,
      },
      answer: exportPage('k2'),
    },
    {
      name: 'export leaves absent parameters out',
      call: (owners) => owners.export('identity', { unit: 'identity.account', tenantId: TENANT }),
      request: {
        service: 'identity',
        method: 'GET',
        path: '/internal/v1/migration/export',
        query: { unit: 'identity.account', tenantId: TENANT },
        userToken: null,
      },
      answer: exportPage(null),
    },
    {
      name: 'changes sends tenant, cursor and limit',
      call: (owners) => owners.changes('people', { tenantId: TENANT, after: CURSOR_START, limit: 1000 }),
      request: {
        service: 'people',
        method: 'GET',
        path: '/internal/v1/migration/changes',
        query: { tenantId: TENANT, after: CURSOR_START, limit: '1000' },
        userToken: null,
      },
      answer: CHANGES_ANSWER,
    },
    {
      name: 'changes leaves an absent limit out',
      call: (owners) => owners.changes('people', { tenantId: TENANT, after: '7:3' }),
      request: { service: 'people', method: 'GET', path: '/internal/v1/migration/changes', query: { tenantId: TENANT, after: '7:3' }, userToken: null },
      answer: CHANGES_ANSWER,
    },
    {
      name: 'position joins event ids with commas',
      call: (owners) => owners.position('people', { eventIds: EVENT_IDS }),
      request: {
        service: 'people',
        method: 'GET',
        path: '/internal/v1/migration/position',
        query: { eventIds: EVENT_IDS.join(',') },
        userToken: null,
      },
      answer: POSITION_ANSWER,
    },
    {
      name: 'position joins published topics with commas',
      call: (owners) => owners.position('people', { publishedTopics: TOPICS }),
      request: {
        service: 'people',
        method: 'GET',
        path: '/internal/v1/migration/position',
        query: { publishedTopics: TOPICS.join(',') },
        userToken: null,
      },
      answer: POSITION_ANSWER,
    },
    {
      name: 'position sends event ids and published topics together',
      call: (owners) => owners.position('people', { eventIds: EVENT_IDS, publishedTopics: TOPICS }),
      request: {
        service: 'people',
        method: 'GET',
        path: '/internal/v1/migration/position',
        query: { eventIds: EVENT_IDS.join(','), publishedTopics: TOPICS.join(',') },
        userToken: null,
      },
      answer: POSITION_ANSWER,
    },
    {
      name: 'position without event ids or topics sends none',
      call: (owners) => owners.position('people'),
      request: { service: 'people', method: 'GET', path: '/internal/v1/migration/position', query: {}, userToken: null },
      answer: POSITION_ANSWER,
    },
    {
      name: 'siteMonitorState reads programs-sites',
      call: (owners) => owners.siteMonitorState(),
      request: { service: 'programs-sites', method: 'GET', path: '/internal/v1/sitemonitor/state', userToken: null },
      answer: MONITOR_STATE,
    },
    {
      name: 'putSiteMonitorState puts the cursor to programs-sites',
      call: (owners) => owners.putSiteMonitorState({ lastMonitored: '2026-03-01 10:15:00.000' }),
      request: {
        service: 'programs-sites',
        method: 'PUT',
        path: '/internal/v1/sitemonitor/state',
        json: { lastMonitored: '2026-03-01 10:15:00.000' },
        userToken: null,
      },
      answer: MONITOR_STATE,
    },
    {
      name: 'adoptScheduledTasks posts the tasks to communications',
      call: (owners) => owners.adoptScheduledTasks(ADOPT_REQUEST),
      request: {
        service: 'communications',
        method: 'POST',
        path: '/internal/v1/migration/adopt-scheduled-tasks',
        json: ADOPT_REQUEST,
        userToken: null,
      },
      answer: { adopted: 1, existing: 0, scheduledImmediately: 0 },
    },
    {
      name: 'cancelAdoptedScheduledTasks posts the names to communications',
      call: (owners) => owners.cancelAdoptedScheduledTasks({ names: ['survey-1'] }),
      request: {
        service: 'communications',
        method: 'POST',
        path: '/internal/v1/migration/cancel-adopted-scheduled-tasks',
        json: { names: ['survey-1'] },
        userToken: null,
      },
      answer: { cancelled: 1 },
    },
  ])('$name', async ({ call, request, answer }) => {
    const { owners, calls } = routedClient({ [routeOf(request)]: [{ body: answer }] });

    await expect(call(owners)).resolves.toEqual(answer);
    expect(calls).toEqual([request]);
    expect(calls[0]?.timeoutMs).toBeUndefined();
  });

  it.each<[string, number | undefined, GateRequest, { timeoutMs?: number }?]>([
    ['close', 40_000, GATE_REQUEST],
    ['close with its own wait', 15_000, { ...GATE_REQUEST, timeoutMs: 5_000 }],
    ['close bounded by its caller', 1_250, { ...GATE_REQUEST, timeoutMs: 600 }, { timeoutMs: 1_250 }],
    ['phase', 40_000, { op: 'phase', units: [UNIT], holderId: 'window-1', phase: 'executing' }],
    ['phase bounded by its caller', 900, { op: 'phase', units: [UNIT], holderId: 'window-1', phase: 'executing' }, { timeoutMs: 900 }],
    ['open', undefined, { op: 'open', units: [UNIT], holderId: 'window-1' }],
    ['status', undefined, { op: 'status', units: [UNIT] }],
  ])('gate posts a %s request to its owner with timeoutMs %s', async (_label, timeoutMs, req, options) => {
    const { owners, calls } = routedClient({ 'people POST /internal/v1/migration/gate': [{ body: GATE_ANSWER }] });

    await expect(owners.gate('people', req, options)).resolves.toEqual(GATE_ANSWER);
    expect(calls).toEqual([{ service: 'people', method: 'POST', path: '/internal/v1/migration/gate', json: req, userToken: null, timeoutMs }]);
    expect(calls[0]?.timeoutMs).toBe(timeoutMs);
  });

  it('position bounds its call by the timeoutMs it is given', async () => {
    const { owners, calls } = routedClient({ 'people GET /internal/v1/migration/position': [{ body: POSITION_ANSWER }] });

    await expect(owners.position('people', {}, { timeoutMs: 1_250 })).resolves.toEqual(POSITION_ANSWER);
    expect(calls).toEqual([{ service: 'people', method: 'GET', path: '/internal/v1/migration/position', query: {}, userToken: null, timeoutMs: 1_250 }]);
    expect(calls[0]?.timeoutMs).toBe(1_250);
  });


  it.each<[string, ServiceResponse['headers'], Record<string, string>]>([
    ['a lower-cased header', { 'content-type': 'application/json', 'x-opt2-write-position': 'people=123,identity=120' }, { people: '123', identity: '120' }],
    ['a header named in another case', { [WRITE_POSITION_HEADER]: formatWritePosition({ people: '123', identity: '120' }) }, { people: '123', identity: '120' }],
    ['every value of a repeated header', { 'x-opt2-write-position': ['people=123', 'identity=120,people=99'] }, { people: '123', identity: '120' }],
    ['no header as no positions', {}, {}],
  ])('apply posts the batch to its owner and reads %s', async (_label, headers, positions) => {
    const { owners, calls } = routedClient({ 'people POST /internal/v1/migration/apply': [{ headers, body: APPLY_ANSWER }] });

    await expect(owners.apply('people', APPLY_REQUEST)).resolves.toEqual({ ...APPLY_ANSWER, writePositions: new Map(Object.entries(positions)) });
    expect(calls).toEqual([{ service: 'people', method: 'POST', path: '/internal/v1/migration/apply', json: APPLY_REQUEST, userToken: null }]);
  });

  it.each<[string, string | undefined]>([
    ['the first page', undefined],
    ['a given cursor', 'k0'],
  ])('exportPages reads from %s until a page has no next, one request per page consumed, each with the same keys', async (_label, after) => {
    const pages = [exportPage('k1'), exportPage('k2'), exportPage(null)];
    const { owners, calls } = routedClient({ 'people GET /internal/v1/migration/export': pages.map((body) => ({ body })) });
    const read: ExportResponse[] = [];
    const requestsAtEachPage: number[] = [];
    const keys = ['s2:u1'];

    for await (const page of owners.exportPages('people', { unit: UNIT, tenantId: TENANT, after, match: { siteID: ['tenant-a'] }, limit: 2, keys })) {
      read.push(page);
      requestsAtEachPage.push(calls.length);
    }

    expect(read).toEqual(pages);
    expect(requestsAtEachPage).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.query)).toEqual(
      [after, 'k1', 'k2'].map((cursor) => ({ unit: UNIT, tenantId: TENANT, after: cursor, match: '{"siteID":["tenant-a"]}', limit: '2', keys })),
    );
  });

  it.each<[string, WatermarkRecord[], WatermarkRecord | null]>([
    ['the stored watermark', [WATERMARK], WATERMARK],
    ['null when the owner has none', [], null],
  ])('watermark asks for one table and direction and returns %s', async (_label, answer, expected) => {
    const { owners, calls } = routedClient({ 'identity GET /internal/v1/migration/watermark': [{ body: answer }] });

    await expect(owners.watermark('identity', 'tusers', 'forward')).resolves.toEqual(expected);
    expect(calls).toEqual([
      {
        service: 'identity',
        method: 'GET',
        path: '/internal/v1/migration/watermark',
        query: { legacyTable: 'tusers', direction: 'forward' },
        userToken: null,
      },
    ]);
  });

  it.each<[string, WatermarkWrite, Record<string, unknown>]>([
    [
      "a stored record's null sequence and LSN as absent",
      { ...WATERMARK, snapshotSeq: null, backupLsn: null },
      { legacyTable: 'tusers', direction: 'forward', finishedAt: WATERMARK.finishedAt },
    ],
    ['a known sequence and LSN as given', WATERMARK, { ...WATERMARK }],
  ])('putWatermark posts %s', async (_label, record, wire) => {
    const { owners, calls } = routedClient({ 'people POST /internal/v1/migration/watermark': [{ body: WATERMARK }] });

    await expect(owners.putWatermark('people', record)).resolves.toEqual(WATERMARK);
    expect(calls.map(({ service, method, path }) => ({ service, method, path }))).toEqual([
      { service: 'people', method: 'POST', path: '/internal/v1/migration/watermark' },
    ]);
    expect(JSON.parse(JSON.stringify(calls[0]?.json))).toStrictEqual(wire);
  });

  it('putObject posts only the viewed bytes to strategies-content and reads its write position', async () => {
    const bytes = new Uint8Array([0xff, 1, 2, 3, 0xff]).subarray(1, 4);
    const params: PutObjectParams = {
      tenantId: TENANT,
      fileId: FILE_ID,
      variant: '_small',
      ext: 'jpg',
      contentType: 'image/jpeg',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const stored: FileObject = { key: `${TENANT}/${FILE_ID}_small.jpg`, size: 3, sha256: params.sha256, created: true };
    const { owners, calls } = routedClient({
      'strategies-content POST /internal/v1/migration/objects': [{ headers: { 'x-opt2-write-position': 'strategies-content=77' }, body: stored }],
    });

    await expect(owners.putObject(params, bytes)).resolves.toEqual({ ...stored, writePositions: new Map([['strategies-content', '77']]) });
    expect(calls).toEqual([
      {
        service: 'strategies-content',
        method: 'POST',
        path: '/internal/v1/migration/objects',
        query: params,
        body: Buffer.from([1, 2, 3]),
        headers: { 'content-type': 'application/octet-stream' },
        userToken: null,
      },
    ]);
  });

  it('getObject streams one object of strategies-content by key as its undecoded bytes', async () => {
    const key = `${TENANT}/${FILE_ID}.json`;
    const bytes = Buffer.from('{"stored":"as json"}');
    const served = Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]);
    const { owners, calls } = routedClient({ 'strategies-content GET /internal/v1/migration/objects': [{ body: served }] });

    const body = await owners.getObject(key);

    expect(body).toBe(served);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(calls).toEqual([
      { service: 'strategies-content', method: 'GET', path: '/internal/v1/migration/objects', query: { key }, stream: true, userToken: null },
    ]);
  });

  it.each<[string, Partial<ServiceResponse>, Map<string, string>]>([
    ['a deleted object with its write position', { headers: { 'X-Opt2-Write-Position': 'strategies-content=78' }, body: { deleted: true } }, new Map([['strategies-content', '78']])],
    ['a key the owner no longer records without one', { body: { deleted: false } }, new Map()],
  ])('deleteObject deletes one object of strategies-content by key and answers %s', async (_label, answer, writePositions) => {
    const key = `${TENANT}/${FILE_ID}_small.jpg`;
    const body = { key, ...(answer.body as { deleted: boolean }) };
    const { owners, calls } = routedClient({ 'strategies-content DELETE /internal/v1/migration/objects': [{ ...answer, body }] });

    await expect(owners.deleteObject(key)).resolves.toEqual({ ...body, writePositions });
    expect(calls).toEqual([{ service: 'strategies-content', method: 'DELETE', path: '/internal/v1/migration/objects', query: { key }, userToken: null }]);
  });

  it('getAttachmentObject streams one finance attachment by tenant and attachment id as its undecoded bytes', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const served = Readable.from([bytes]);
    const { owners, calls } = routedClient({ 'finance GET /internal/v1/migration/objects': [{ body: served }] });

    const body = await owners.getAttachmentObject({ tenantId: TENANT, attachmentId: FILE_ID });

    expect(body).toBe(served);
    expect(calls).toEqual([
      { service: 'finance', method: 'GET', path: '/internal/v1/migration/objects', query: { tenantId: TENANT, attachmentId: FILE_ID }, stream: true, userToken: null },
    ]);
  });

  it.each<QueueControlOp>(['pause', 'resume', 'ensure'])('queueControl posts %s to the queue on the given service', async (op) => {
    const answer: QueueControlResult = { queue: SITEMONITOR_QUEUE, service: 'programs-sites' };
    const path = `/internal/v1/task-queues/${SITEMONITOR_QUEUE}/${op}`;
    const { owners, calls } = routedClient({ [`programs-sites POST ${path}`]: [{ body: answer }] });

    await expect(owners.queueControl('programs-sites', SITEMONITOR_QUEUE, op)).resolves.toEqual(answer);
    expect(calls).toEqual([{ service: 'programs-sites', method: 'POST', path, json: {}, userToken: null }]);
  });

  interface FailureCase {
    name: string;
    owner: DataOwner;
    method: ServiceRequest['method'];
    path: string;
    status: number;
    body: unknown;
    call: (owners: OwnersClient) => Promise<unknown>;
  }

  it.each<FailureCase>([
    {
      name: 'apply answering 500',
      owner: 'people',
      method: 'POST',
      path: '/internal/v1/migration/apply',
      status: 500,
      body: { error: 'internal' },
      call: (owners) => owners.apply('people', APPLY_REQUEST),
    },
    {
      name: 'export answering 404',
      owner: 'identity',
      method: 'GET',
      path: '/internal/v1/migration/export',
      status: 404,
      body: { error: 'unknown-unit' },
      call: (owners) => owners.export('identity', { unit: 'identity.nothing', tenantId: TENANT }),
    },
    {
      name: 'putSiteMonitorState answering 503',
      owner: 'programs-sites',
      method: 'PUT',
      path: '/internal/v1/sitemonitor/state',
      status: 503,
      body: 'unavailable',
      call: (owners) => owners.putSiteMonitorState({ lastMonitored: '2026-03-01 10:15:00.000' }),
    },
    {
      name: 'putObject answering 302',
      owner: 'strategies-content',
      method: 'POST',
      path: '/internal/v1/migration/objects',
      status: 302,
      body: undefined,
      call: (owners) =>
        owners.putObject({ tenantId: TENANT, fileId: FILE_ID, variant: '', ext: 'pdf', contentType: 'application/pdf', sha256: 'unchecked' }, new Uint8Array()),
    },
    {
      name: 'getObject answering 404',
      owner: 'strategies-content',
      method: 'GET',
      path: '/internal/v1/migration/objects',
      status: 404,
      body: { error: 'notFound' },
      call: (owners) => owners.getObject(`${TENANT}/${FILE_ID}.pdf`),
    },
    {
      name: 'deleteObject answering 500',
      owner: 'strategies-content',
      method: 'DELETE',
      path: '/internal/v1/migration/objects',
      status: 500,
      body: { apiversion: 'v1', method: 'invalid', error: { message: 'Internal error', code: 'internal' } },
      call: (owners) => owners.deleteObject(`${TENANT}/${FILE_ID}.pdf`),
    },
    {
      name: 'getAttachmentObject answering 404',
      owner: 'finance',
      method: 'GET',
      path: '/internal/v1/migration/objects',
      status: 404,
      body: { apiversion: 'v1', method: 'invalid', error: { message: 'Invalid method call', code: 'invalid_request' } },
      call: (owners) => owners.getAttachmentObject({ tenantId: TENANT, attachmentId: FILE_ID }),
    },
    {
      name: 'gate answering 409 without a gate conflict',
      owner: 'people',
      method: 'POST',
      path: '/internal/v1/migration/gate',
      status: 409,
      body: { error: 'invalidParameters' },
      call: (owners) => owners.gate('people', GATE_REQUEST),
    },
    {
      name: 'apply answering 409 with a gate-conflict body',
      owner: 'people',
      method: 'POST',
      path: '/internal/v1/migration/apply',
      status: 409,
      body: { error: 'gate-conflict', units: [UNIT] },
      call: (owners) => owners.apply('people', APPLY_REQUEST),
    },
  ])('$name throws OwnerCallError with the owner, route, status and body', async ({ owner, method, path, status, body, call }) => {
    const { owners, calls } = routedClient({ [routeOf({ service: owner, method, path })]: [{ status, body }] });

    const error = await call(owners).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OwnerCallError);
    expect(error).not.toBeInstanceOf(GateConflict);
    expect(error).toMatchObject({ name: 'OwnerCallError', message: `Owner ${owner} answered ${method} ${path} with HTTP ${String(status)}`, owner, method, path, status, body });
    expect(calls).toHaveLength(1);
  });

  it('gate throws GateConflict naming the units the owner refused', async () => {
    const body = { error: 'gate-conflict', units: [UNIT, 'people.person_archive'] };
    const { owners, calls } = routedClient({ 'people POST /internal/v1/migration/gate': [{ status: 409, body }] });

    const error = await owners.gate('people', GATE_REQUEST).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GateConflict);
    expect(error).toBeInstanceOf(OwnerCallError);
    expect(error).toMatchObject({
      name: 'GateConflict',
      message: 'Owner people refused the gate compare-and-set for people.person, people.person_archive',
      owner: 'people',
      method: 'POST',
      path: '/internal/v1/migration/gate',
      status: 409,
      body,
      units: body.units,
    });
    expect(calls).toHaveLength(1);
  });

  it.each<[string, string, (owners: OwnersClient) => Promise<unknown>]>([
    ['apply', 'people POST /internal/v1/migration/apply', (owners) => owners.apply('people', APPLY_REQUEST)],
    ['changes', 'people GET /internal/v1/migration/changes', (owners) => owners.changes('people', { tenantId: TENANT, after: CURSOR_START })],
  ])('%s surfaces an unavailable owner unchanged after one attempt', async (_label, route, call) => {
    const unavailable = new ServiceUnavailableError('people', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const { owners, calls } = routedClient({ [route]: [unavailable] });

    await expect(call(owners)).rejects.toBe(unavailable);
    expect(calls).toHaveLength(1);
  });
});
