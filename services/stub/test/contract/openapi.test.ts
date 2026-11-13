/** Provider contract of the stub: the registered routes against contracts/openapi.yaml, and every operation's response shape. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { pushPath } from '@opt2/platform/events';
import {
  CURSOR_START,
  type ApplyRequest,
  type GateRequest,
  type WatermarkInput,
  type WatermarkRecord,
} from '@opt2/platform/migration-kit';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_INTERVAL_S,
  OUTBOX_SWEEP_PATH,
  outboxSweepQueue,
  slotName,
  slotStartS,
  taskWireBody,
} from '@opt2/platform/tasks';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  findOperation,
  mintServiceToken,
  mintTasksInvokerToken,
  pushTo,
  registryPayloads,
  testEnvelope,
  type InjectResponse,
} from '@opt2/platform/testing';
import { newNote, noteCreatedPayload, noteToRow, type NoteProjectionRow } from '../../src/domain/note.js';
import {
  NOTE_CREATED_SUBSCRIPTION,
  NOTE_CREATED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
} from '../../src/events/topics.js';
import { NOTE_TABLE } from '../../src/repo/tables.js';
import { FIXED_XID, TEST_CLOCK, buildTestApp, createRecordingDb, headersFor, type TestApp } from '../helpers/app.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Headers = Record<string, string>;

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
}

interface OperationObject {
  operationId?: string;
  'x-opt2-requires'?: string[];
  'x-opt2-public'?: boolean;
  'x-opt2-transport'?: string;
}

/** One contract operation with its auth declaration. */
interface ContractOperation {
  method: string;
  path: string;
  operationId: string | undefined;
  requires: string[] | undefined;
  public: boolean;
  transport: string | undefined;
}

/** One request against an operation; `path` has no query, and `status` names a declared error status expected instead of the 2xx. */
interface Case {
  method: HttpMethod;
  path: string;
  status?: number;
  run(ctx: TestApp): Promise<InjectResponse>;
  verify?(body: unknown, ctx: TestApp): void;
}

/** Request options of {@link request}; `as` produces the credentials, none when omitted. */
interface RequestSpec {
  query?: string;
  as?: () => Promise<Headers>;
  payload?: object;
  status?: number;
  verify?: Case['verify'];
}

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const SERVICE = 'stub';
const STUB_URL = 'http://127.0.0.1:8199';
const NOTES_PATH = '/opt2/stub/notes';
const MIGRATION_PATH = '/internal/v1/migration';
const GATE_PATH = `${MIGRATION_PATH}/gate`;
const SWEEP_QUEUE = outboxSweepQueue(SERVICE);
const QUEUE_PATH = `/internal/v1/task-queues/${SWEEP_QUEUE}`;
const UNMAPPED_LEGACY_TABLE = 'tcontent';
const GATE_HOLDER = 'contract-gate-holder';
const WATERMARK_FINISHED_AT = '2026-06-30T12:00:00.000';
const PROJECTED_EVENT_ID = '5a8b6c1e-2f3d-4e5a-9b6c-7d8e9f0a1b2c';
const CREATED = { title: 'Created note', body: 'Created body' };

const READ_NOTE = newNote({ title: 'Read note', body: 'Read body' }, TEST_CLOCK);
const DELETED_NOTE = newNote({ title: 'Deleted note', body: '' }, TEST_CLOCK);
const PUSHED_NOTE = newNote({ title: 'Pushed note', body: 'Pushed body' }, TEST_CLOCK);
const READ_PATH = `${NOTES_PATH}/${READ_NOTE.noteId}`;

const READ_PROJECTION: NoteProjectionRow = {
  note_id: READ_NOTE.noteId,
  title: READ_NOTE.title,
  body: READ_NOTE.body,
  created: READ_NOTE.created,
  aggregate_version: READ_NOTE.rowVersion,
  apply_count: 1,
  last_event_id: PROJECTED_EVENT_ID,
  projected_at: READ_NOTE.created,
};

const APPLY_BATCH: ApplyRequest = {
  batchId: 'contract-batch-1',
  origin: 'backfill',
  legacyTable: UNMAPPED_LEGACY_TABLE,
  tenantId: TENANT_A.tenantId,
  columns: [{ name: 'ContentID', type: 's' }],
  rows: [],
};

const WATERMARK: WatermarkInput = {
  legacyTable: UNMAPPED_LEGACY_TABLE,
  direction: 'forward',
  snapshotSeq: 1,
  backupLsn: '42',
  finishedAt: WATERMARK_FINISHED_AT,
};

const STORED_WATERMARK: WatermarkRecord = {
  legacyTable: UNMAPPED_LEGACY_TABLE,
  direction: 'forward',
  snapshotSeq: 1,
  backupLsn: '42',
  finishedAt: WATERMARK_FINISHED_AT,
};

const SWEEP_SLOT_S = slotStartS(epochSecondsOf(TEST_CLOCK.now()), OUTBOX_SWEEP_INTERVAL_S);
const SWEEP_TASK = slotName(SWEEP_QUEUE, SWEEP_SLOT_S);
const SWEEP_SUCCESSOR = slotName(SWEEP_QUEUE, SWEEP_SLOT_S + OUTBOX_SWEEP_INTERVAL_S);

/** Whole seconds since the epoch of `date`. */
function epochSecondsOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** One entry per operation of `doc`, its method upper-cased. */
function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const op = item[method] as OperationObject | undefined;
      if (op === undefined) return [];
      return [
        {
          method: method.toUpperCase(),
          path,
          operationId: op.operationId,
          requires: op['x-opt2-requires'],
          public: op['x-opt2-public'] === true,
          transport: op['x-opt2-transport'],
        },
      ];
    }),
  );
}

const CONTRACT_OPS = contractOperations(DOC);

/** `METHOD path` key of a registered route, its `:name` parameters in contract `{name}` form. */
function routeKey({ method, url }: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${method} ${url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;
}

/** The routes without Fastify's implicit HEAD twins of GET routes. */
function withoutHeadTwins(routes: readonly RouteMatrixEntry[]): RouteMatrixEntry[] {
  const gets = new Set(routes.filter((route) => route.method === 'GET').map((route) => route.url));
  return routes.filter((route) => !(route.method === 'HEAD' && gets.has(route.url)));
}

/** Invocation credential of the `caller` workload carrying `roles`. */
async function serviceHeaders(caller: string, roles: string[]): Promise<Headers> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: SERVICE, roles })}` };
}

const asMigration = (): Promise<Headers> => serviceHeaders('migration', [Roles.platformMigration]);
const asOperator = (): Promise<Headers> => serviceHeaders('operator', [Roles.platformOperator]);
const asUser = (subject: string) => (): Promise<Headers> => headersFor(subject);

/** A case injecting `method` on `path` with the spec's query, credentials and JSON payload. */
function request(method: HttpMethod, path: string, spec: RequestSpec = {}): Case {
  return {
    method,
    path,
    status: spec.status,
    verify: spec.verify,
    run: async ({ app }) =>
      app.inject({
        method,
        url: spec.query === undefined ? path : `${path}?${spec.query}`,
        headers: (await spec.as?.()) ?? {},
        ...(spec.payload === undefined ? {} : { payload: spec.payload }),
      }),
  };
}

/** The `programs-sites.site.changed.v1` payload of a fixture site. */
function sitePayload(siteId: string) {
  const payload = registryPayloads().find((entry) => entry.siteId === siteId);
  if (payload === undefined) throw new TypeError(`registryPayloads() has no site ${siteId}`);
  return payload;
}

/** The response body: parsed JSON for JSON media types, raw text otherwise, undefined when empty. */
function bodyOf(res: InjectResponse): unknown {
  if (res.body === '') return undefined;
  const contentType = res.headers['content-type'];
  return typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType) ? res.json() : res.body;
}

/** Asserts `res` answers `operationId` with its declared 2xx, or `expected.status`, and a contracted body; returns the body. */
function expectContracted(operationId: string, expected: Pick<Case, 'method' | 'path' | 'status'>, res: InjectResponse): unknown {
  const { method, path, status } = expected;
  const { operation } = findOperation(DOC, method, path);
  expect(operation.operationId).toBe(operationId);
  if (status === undefined) {
    const success = Object.keys(operation.responses ?? {}).filter((code) => /^2\d\d$/.test(code));
    expect(success, res.body).toContain(String(res.statusCode));
  } else {
    expect(res.statusCode, res.body).toBe(status);
  }
  const body = bodyOf(res);
  assertResponseMatchesOpenApi(DOC, { method, path, status: res.statusCode, contentType: res.headers['content-type'], body });
  return body;
}

const cases = {
  healthz: request('GET', '/healthz', { verify: (body) => expect(body).toEqual({ status: 'ok' }) }),
  createNote: request('POST', NOTES_PATH, {
    as: asUser(Roles.systemUser),
    payload: CREATED,
    verify: (body, { publisher }) => {
      expect(body).toMatchObject({ method: 'save', data: CREATED });
      expect(publisher.published.map(({ topic }) => topic)).toContain(NOTE_CREATED_TOPIC);
    },
  }),
  listNotes: request('GET', NOTES_PATH, {
    as: asUser(Roles.member),
    verify: (body) => {
      expect(body).toMatchObject({ method: 'findMany', data: { items: expect.arrayContaining([expect.objectContaining({ noteid: READ_NOTE.noteId })]) } });
    },
  }),
  getNote: request('GET', READ_PATH, {
    as: asUser(Roles.member),
    verify: (body) => expect(body).toMatchObject({ method: 'findOne', data: { noteid: READ_NOTE.noteId, title: READ_NOTE.title } }),
  }),
  getNoteProjection: request('GET', `${READ_PATH}/projection`, {
    as: asUser(Roles.member),
    verify: (body) => expect(body).toMatchObject({ data: { noteid: READ_NOTE.noteId, lasteventid: PROJECTED_EVENT_ID } }),
  }),
  deleteNote: request('DELETE', `${NOTES_PATH}/${DELETED_NOTE.noteId}`, {
    as: asUser(Roles.s2),
    verify: (body, { db }) => {
      expect(body).toMatchObject({ method: 'delete', data: { deleted: true } });
      expect(db.rows('note', TENANT_A.tenantId).map((row) => row.note_id)).not.toContain(DELETED_NOTE.noteId);
    },
  }),
  // The stub maps no legacy table, so every batch answers the declared legacy 400.
  migrationApply: request('POST', `${MIGRATION_PATH}/apply`, {
    as: asMigration,
    payload: APPLY_BATCH,
    status: 400,
    verify: (body) => expect(body).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } }),
  }),
  migrationExport: request('GET', `${MIGRATION_PATH}/export`, {
    as: asMigration,
    query: `unit=${NOTE_TABLE.unit}&tenantId=${TENANT_A.tenantId}`,
    verify: (body) => expect(body).toEqual({ unit: NOTE_TABLE.unit, tenantId: TENANT_A.tenantId, tables: [], next: null }),
  }),
  migrationChanges: request('GET', `${MIGRATION_PATH}/changes`, {
    as: asMigration,
    query: `after=${encodeURIComponent(CURSOR_START)}&tenantId=${TENANT_A.tenantId}`,
    verify: (body) => expect(body).toMatchObject({ rows: [], cursor: CURSOR_START, complete: true, operations: {} }),
  }),
  migrationPosition: request('GET', `${MIGRATION_PATH}/position`, {
    as: asMigration,
    verify: (body) => expect(body).toMatchObject({ owner: SERVICE, position: FIXED_XID }),
  }),
  migrationWatermarkGet: request('GET', `${MIGRATION_PATH}/watermark`, {
    as: asMigration,
    query: 'direction=forward',
    verify: (body) => expect(body).toEqual([]),
  }),
  migrationWatermarkPost: request('POST', `${MIGRATION_PATH}/watermark`, {
    as: asMigration,
    payload: WATERMARK,
    verify: (body) => expect(body).toEqual(STORED_WATERMARK),
  }),
  migrationGate: {
    method: 'POST',
    path: GATE_PATH,
    async run({ app }) {
      const headers = await asMigration();
      const close: GateRequest = { op: 'close', units: [NOTE_TABLE.unit], holderId: GATE_HOLDER };
      const closed = await app.inject({ method: 'POST', url: GATE_PATH, headers, payload: close });
      expect(expectContracted('migrationGate', { method: 'POST', path: GATE_PATH }, closed)).toEqual({
        units: [{ unit: NOTE_TABLE.unit, state: 'closed', holderId: GATE_HOLDER, phase: 'quiet' }],
      });
      const open: GateRequest = { op: 'open', units: [NOTE_TABLE.unit], holderId: GATE_HOLDER };
      return app.inject({ method: 'POST', url: GATE_PATH, headers, payload: open });
    },
    verify: (body) => expect(body).toEqual({ units: [{ unit: NOTE_TABLE.unit, state: 'open', holderId: null, phase: 'quiet' }] }),
  },
  pushNoteCreated: {
    method: 'POST',
    path: pushPath(NOTE_CREATED_SUBSCRIPTION),
    run: ({ app }) =>
      pushTo(
        app,
        NOTE_CREATED_SUBSCRIPTION,
        testEnvelope({
          topic: NOTE_CREATED_TOPIC,
          tenantId: TENANT_A.tenantId,
          aggregateId: PUSHED_NOTE.noteId,
          aggregateVersion: 1,
          payload: noteCreatedPayload(PUSHED_NOTE),
        }),
      ),
    verify: (_body, { db, publisher }) => {
      expect(db.rows('note_projection', TENANT_A.tenantId).map((row) => row.note_id)).toContain(PUSHED_NOTE.noteId);
      expect(publisher.deadLetters(NOTE_CREATED_SUBSCRIPTION)).toEqual([]);
    },
  },
  pushSiteChanged: {
    method: 'POST',
    path: pushPath(SITE_CHANGED_SUBSCRIPTION),
    run: ({ app }) =>
      pushTo(
        app,
        SITE_CHANGED_SUBSCRIPTION,
        testEnvelope({
          topic: SITE_CHANGED_TOPIC,
          tenantId: TENANT_B.tenantId,
          aggregateId: TENANT_B.siteId,
          aggregateVersion: 2,
          payload: sitePayload(TENANT_B.siteId),
        }),
      ),
    verify: (_body, { publisher }) => expect(publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toEqual([]),
  },
  outboxSweep: {
    method: 'POST',
    path: OUTBOX_SWEEP_PATH,
    run: async ({ app }) => {
      const task = taskWireBody({
        queue: SWEEP_QUEUE,
        name: SWEEP_TASK,
        scheduleTime: new Date(SWEEP_SLOT_S * 1000),
        url: `${STUB_URL}${OUTBOX_SWEEP_PATH}`,
        deadlineS: 60,
        body: {},
      });
      return app.inject({
        method: 'POST',
        url: OUTBOX_SWEEP_PATH,
        headers: {
          authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`,
          [CLOUD_TASKS_HEADERS.queueName]: SWEEP_QUEUE,
          [CLOUD_TASKS_HEADERS.taskName]: SWEEP_TASK,
        },
        payload: task,
      });
    },
    verify: (body, { taskPort }) => {
      expect(body).toMatchObject({ failed: 0, tenants: registryPayloads().length });
      expect(taskPort.tasks.map(({ name }) => name)).toContain(SWEEP_SUCCESSOR);
    },
  },
  queuePause: request('POST', `${QUEUE_PATH}/pause`, {
    as: asOperator,
    verify: (body) => expect(body).toEqual({ queue: SWEEP_QUEUE, service: SERVICE, paused: true }),
  }),
  queueResume: request('POST', `${QUEUE_PATH}/resume`, {
    as: asOperator,
    verify: (body) => expect(body).toEqual({ queue: SWEEP_QUEUE, service: SERVICE, paused: false }),
  }),
  queueEnsure: request('POST', `${QUEUE_PATH}/ensure`, {
    as: asOperator,
    verify: (body) => expect(body).toMatchObject({ queue: SWEEP_QUEUE, service: SERVICE, ensured: { created: false, reason: 'live' } }),
  }),
} satisfies Record<string, Case>;

const CASES: Array<[string, Case]> = Object.entries(cases);

const DENIALS: Array<[string, string, Case]> = [
  ['refuses deleteNote to a member with the legacy 403', 'deleteNote', request('DELETE', READ_PATH, { as: asUser(Roles.member), status: 403 })],
  ['refuses an anonymous createNote with the legacy 401', 'createNote', request('POST', NOTES_PATH, { payload: CREATED, status: 401 })],
];

describe('openapi document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect(DOC.openapi).toBe('3.1.0');
    expect(DOC.info.version).toBe('1.0.0');
    expect(DOC.info['x-source-sha']).toBe(PIN.sha);
  });

  it('gives every operation a unique operationId', () => {
    const ids = CONTRACT_OPS.map(({ operationId }) => operationId);
    expect(ids.filter((id) => typeof id !== 'string' || id === '')).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('route matrix', () => {
  let ctx: TestApp;
  let routes: RouteMatrixEntry[];

  beforeAll(async () => {
    ctx = await buildTestApp();
    routes = withoutHeadTwins(collectRouteMatrix(ctx.app).routes);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('registers exactly the contract operations', () => {
    expect(routes.map(routeKey).sort()).toEqual(CONTRACT_OPS.map(({ method, path }) => `${method} ${path}`).sort());
  });

  it('declares each route with the contract roles, public flag and transport', () => {
    const byKey = new Map(CONTRACT_OPS.map((op) => [`${op.method} ${op.path}`, op]));
    const declared = routes.map((route) => ({
      route: routeKey(route),
      requires: [...(route.requires ?? [])].sort(),
      public: route.public === true,
      transport: route.transport,
    }));
    const contracted = routes.map((route) => {
      const op = byKey.get(routeKey(route));
      return { route: routeKey(route), requires: [...(op?.requires ?? [])].sort(), public: op?.public === true, transport: op?.transport };
    });
    expect(declared).toEqual(contracted);
  });
});

describe('operations', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    const db = createRecordingDb({
      notes: [READ_NOTE, DELETED_NOTE].map((note) => ({ tenantId: TENANT_A.tenantId, row: noteToRow(note) })),
      projections: [{ tenantId: TENANT_A.tenantId, row: READ_PROJECTION }],
    });
    // PostgreSQL formats the stored watermark's finished_at; the bound text already has that form.
    db.respond('insert into stub.migration_watermark', ({ params }) => [
      { legacy_table: params[0], direction: params[1], snapshot_seq: String(params[2]), backup_lsn: params[3], finished_at: params[4] },
    ]);
    ctx = await buildTestApp({ db });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('cover exactly the contract operations', () => {
    expect(Object.keys(cases).sort()).toEqual(CONTRACT_OPS.map(({ operationId }) => operationId).sort());
  });

  it.each(CASES)('%s answers as its contract declares', async (operationId, c) => {
    const res = await c.run(ctx);
    c.verify?.(expectContracted(operationId, c, res), ctx);
  });

  it.each(DENIALS)('%s', async (_title, operationId, c) => {
    const res = await c.run(ctx);
    expect(expectContracted(operationId, c, res)).toMatchObject({ apiversion: 'v1', error: { code: expect.any(String) } });
  });
});
