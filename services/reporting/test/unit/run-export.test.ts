// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-run enqueuer and probe over a fake task port; the export runner against PostgreSQL, local storage and stub sources. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  QUEUES,
  UnknownTaskTargetError,
  parseTaskWireBody,
  targetUrl,
  taskWireBody,
  type CreateTaskInput,
  type CreateTaskResult,
  type TaskInfo,
  type TaskPort,
} from '@opt2/platform/tasks';
import { fixedClock, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { GateClosedError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import type { EnqueueExportRun, ExportRunPayload, ReportingDeps } from '../../src/domain/deps.js';
import { reclaimRun, transitionJob } from '../../src/domain/job-state.js';
import { createExportJob } from '../../src/domain/jobs.js';
import { runExport, type RunExportResult } from '../../src/domain/run-export.js';
import { createReportingRepository, type ReportingRepository } from '../../src/repo/repository.js';
import { EXPORT_BUCKET, EXPORT_JOB, OUTPUT_SLOTS, UNITS, exportAttemptKey, exportObjectKey, type ExportJobRow } from '../../src/repo/tables.js';
import { createExportRunEnqueuer, createExportRunProbe, exportRunTaskName } from '../../src/tasks/enqueue.js';

const QUEUE = QUEUES['reporting-export-run'];
const JOB_ID = '6F0A2C1E-5B7D-4E8A-9C3F0D1E2F3A4B5C';
const PAYLOAD = { jobId: JOB_ID, asOf: '2026-06-30', userToken: 'requester-token' };
const CLOCK = fixedClock('2026-06-30T10:00:00.000Z');
const SERVICE_URLS = { reporting: 'http://127.0.0.1:8116/' };

/** Task port recording `create` inputs and answering `get` with `get`; every other method is unused by the enqueuer and probe and throws. */
function fakeTasks(
  create: (input: CreateTaskInput) => Promise<CreateTaskResult>,
  get: TaskPort['get'] = () => {
    throw new Error('not called by the export-run enqueuer');
  },
): { port: TaskPort; calls: CreateTaskInput[] } {
  const calls: CreateTaskInput[] = [];
  const unused = (): never => {
    throw new Error('not called by the export-run enqueuer or probe');
  };
  const port: TaskPort = {
    kind: 'local',
    create: async (input) => {
      calls.push(input);
      return create(input);
    },
    delete: unused,
    list: unused,
    get,
    pauseQueue: unused,
    resumeQueue: unused,
    queueState: unused,
    close: unused,
  };
  return { port, calls };
}

const enqueueWith = (port: TaskPort, serviceUrls: Record<string, string> = SERVICE_URLS) =>
  createExportRunEnqueuer({ tasks: port, serviceUrls, clock: CLOCK });

const run = (enqueue: ReturnType<typeof enqueueWith>) => enqueue({ tenantId: TENANT_A.tenantId, jobId: JOB_ID, payload: PAYLOAD });

describe('export-run enqueuer', () => {
  it('names the task after the job, verbatim', () => {
    expect(exportRunTaskName(JOB_ID)).toBe(`reporting-export-run-${JOB_ID}`);
  });

  it.each([true, false])('creates one task due now on the export-run queue and resolves when created is %s', async (created) => {
    const { port, calls } = fakeTasks(async (input) => ({ name: input.name, created }));

    await expect(run(enqueueWith(port))).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const [call] = calls as [CreateTaskInput];
    expect(call).toMatchObject({
      queue: 'reporting-export-run',
      name: exportRunTaskName(JOB_ID),
      url: targetUrl(QUEUE, SERVICE_URLS, { exportId: JOB_ID }),
      deadlineS: QUEUE.deadlineS,
      tenantId: TENANT_A.tenantId,
    });
    expect(call.url).toBe(`http://127.0.0.1:8116/internal/v1/tasks/exports/${JOB_ID}/run`);
    expect(call.scheduleTime).toEqual(CLOCK.now());
    expect(parseTaskWireBody(taskWireBody(call))).toEqual({
      queue: 'reporting-export-run',
      name: exportRunTaskName(JOB_ID),
      tenantId: TENANT_A.tenantId,
      payload: PAYLOAD,
    });
  });

  it('gives repeated enqueues of one job the same task name', async () => {
    const { port, calls } = fakeTasks(async (input) => ({ name: input.name, created: calls.length === 1 }));
    const enqueue = enqueueWith(port);

    await run(enqueue);
    await run(enqueue);

    expect(calls.map((call) => call.name)).toEqual([exportRunTaskName(JOB_ID), exportRunTaskName(JOB_ID)]);
  });

  it('raises the legacy 503 with the original error as cause when create rejects', async () => {
    const original = new Error('ECONNREFUSED');
    const { port } = fakeTasks(() => Promise.reject(original));

    const err: unknown = await run(enqueueWith(port)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ reason: 'tasks-unavailable', cause: original });
  });

  it('rethrows a legacy 503 from create unchanged', async () => {
    const original = new LegacyServiceUnavailableError('Unit gate closed', 'auto', 'gate-closed');
    const { port } = fakeTasks(() => Promise.reject(original));

    await expect(run(enqueueWith(port))).rejects.toBe(original);
  });

  it('fails with the configuration error and creates nothing when no reporting URL is configured', async () => {
    const { port, calls } = fakeTasks(async (input) => ({ name: input.name, created: true }));

    await expect(run(enqueueWith(port, {}))).rejects.toBeInstanceOf(UnknownTaskTargetError);
    expect(calls).toHaveLength(0);
  });
});

describe('export-run probe', () => {
  const noCreate = (): Promise<CreateTaskResult> => Promise.reject(new Error('not called by the export-run probe'));
  const probe = (get: TaskPort['get']) =>
    createExportRunProbe({ tasks: fakeTasks(noCreate, get).port })({ tenantId: TENANT_A.tenantId, jobId: JOB_ID });
  const live: TaskInfo = {
    queue: QUEUE.name,
    name: exportRunTaskName(JOB_ID),
    scheduleTime: CLOCK.now(),
    tenantId: TENANT_A.tenantId,
    status: 'running',
    attempts: 2,
  };

  it.each<[string, TaskInfo | undefined, boolean]>([
    ['a live task', live, true],
    ['no live task', undefined, false],
  ])("looks up the job's task under its tenant and answers %s as %s", async (_case, task, scheduled) => {
    const gets: Parameters<TaskPort['get']>[] = [];

    await expect(
      probe((...args) => {
        gets.push(args);
        return Promise.resolve(task);
      }),
    ).resolves.toBe(scheduled);

    expect(gets).toStrictEqual([[QUEUE.name, exportRunTaskName(JOB_ID), { tenantId: TENANT_A.tenantId }]]);
  });

  it('raises the legacy 503 with the original error as cause when the lookup rejects', async () => {
    const original = new Error('ECONNREFUSED');

    const err: unknown = await probe(() => Promise.reject(original)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ message: `Task queue ${QUEUE.name} unavailable`, reason: 'tasks-unavailable', cause: original });
  });

  it('rethrows a legacy 503 from the lookup unchanged', async () => {
    const original = new LegacyServiceUnavailableError('Unit gate closed', 'auto', 'gate-closed');

    await expect(probe(() => Promise.reject(original))).rejects.toBe(original);
  });
});

const CREATED_AT = new Date(2026, 5, 30, 10, 0, 0, 0);
const RUN_AT = new Date(2026, 5, 30, 10, 1, 0, 0);
const RERUN_AT = new Date(2026, 5, 30, 10, 5, 0, 0);
// Long enough for a delivery's start and source read, short enough that its finish waits the budget out on a closed gate.
const FINISH_BUDGET_MS = 1500;

/** Collaborators of one delivery. */
type RunnerDeps = Pick<ReportingDeps, 'db' | 'repository' | 'storage' | 'clock' | 'client'>;

/** A queued job as the create route leaves it, with the payload of its task and its site. */
interface QueuedJob {
  job: ExportJobRow;
  payload: ExportRunPayload;
  siteId: string;
}

/** One sheet-status row of `siteId` as the timesheets producer answers it. */
function sheetRow(timesheetId: string, siteId: string): Record<string, unknown> {
  return {
    timesheetId,
    siteId,
    personId: '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90A',
    periodStart: '2026-06-01',
    status: 'SUBMITTED',
    overdue: false,
    dayCount: 5,
    blackoutCount: 0,
    approvedCount: 0,
  };
}

/** Timesheets stub answering each read with `items` when it carries token `accepted` and with 401 otherwise, after `beforeAnswer`; records each read's token. */
function sheetsClient(
  accepted: string,
  items: readonly unknown[],
  beforeAnswer: () => Promise<void> = () => Promise.resolve(),
): { client: ServiceClient; tokens: (string | null | undefined)[] } {
  const tokens: (string | null | undefined)[] = [];
  const client: ServiceClient = {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      if (req.service !== 'timesheets') throw new Error(`unexpected call to ${req.service} ${req.path}`);
      tokens.push(req.userToken);
      await beforeAnswer();
      const response: ServiceResponse =
        req.userToken === accepted
          ? { status: 200, headers: { 'content-type': 'application/json' }, body: { items } }
          : { status: 401, headers: { 'content-type': 'application/json' }, body: { error: 'invalid_token' } };
      return response as ServiceResponse<T>;
    },
    close: () => Promise.resolve(),
  };
  return { client, tokens };
}

/** A source read held open: `hold` signals `started`, then waits until `release` is called. */
function heldRead(): { started: Promise<void>; hold: () => Promise<void>; release: () => void } {
  let signal = (): void => undefined;
  let release = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    hold: () => {
      signal();
      return released;
    },
    release,
  };
}

/** `fn` run once; later calls resolve without running it. */
function once(fn: () => Promise<unknown>): () => Promise<void> {
  let ran = false;
  return async () => {
    if (ran) return;
    ran = true;
    await fn();
  };
}

describe.skipIf(!(await pgAvailable()))('export runner against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let storage: LocalStorageAdapter;
  let repository: ReportingRepository;
  let sites = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'run-export-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'run-export-test', state: 'open' });
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-run-export-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'run-export-test-key' });
    repository = createReportingRepository({ db: handle.app, storage, clock: fixedClock(CREATED_AT) });
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  /** A queued csv job of a new site's definition reading `source`, created as the create route creates it. */
  async function queuedJob(source = 'timesheets.sheets'): Promise<QueuedJob> {
    sites += 1;
    const siteId = `run-export-${String(sites)}`;
    const tenantId = tenantIdForSite(siteId);
    const definitionId = cfUuid();
    await handle.app.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns)
         VALUES ($1, $2, $3, 'Sheets', $4, '["timesheet_id","status"]')`,
        [tenantId, definitionId, siteId, source],
      ),
    );
    const runs: Parameters<EnqueueExportRun>[0][] = [];
    const enqueue: EnqueueExportRun = (run) => {
      runs.push(run);
      return Promise.resolve();
    };
    const job = await createExportJob(
      { db: handle.app, repository, storage, clock: fixedClock(CREATED_AT), enqueue, runScheduled: () => Promise.resolve(true) },
      { tenantId, siteId, definitionId, format: 'csv', requestedById: cfUuid(), userToken: `requester-token-${String(sites)}`, params: {} },
    );
    const [run] = runs as [Parameters<EnqueueExportRun>[0]];
    return { job, payload: run.payload, siteId };
  }

  const runnerDeps = (client: ServiceClient, at: Date = RUN_AT): RunnerDeps => ({ db: handle.app, repository, storage, clock: fixedClock(at), client });

  const deliver = (deps: RunnerDeps, { job, payload }: QueuedJob): Promise<RunExportResult> =>
    runExport(deps, { tenantId: job.tenant_id, jobId: job.job_id, payload });

  /** `deliver` with every gated transaction it opens sharing one `FINISH_BUDGET_MS` gate budget. */
  const deliverWithinBudget = (deps: RunnerDeps, queued: QueuedJob): Promise<RunExportResult> =>
    withGatedTenant(handle.app, queued.job.tenant_id, () => deliver(deps, queued), { budgetMs: FINISH_BUDGET_MS });

  const read = (job: ExportJobRow): Promise<ExportJobRow | null> =>
    handle.app.withTenant(job.tenant_id, async (tx) => {
      const { rows } = await tx.query<ExportJobRow>(`SELECT * FROM ${handle.schema}.export_job WHERE job_id = $1`, [job.job_id]);
      return rows[0] ?? null;
    });

  /** Op and changed columns of each `export_job` changelog row of `job`'s tenant, oldest first. */
  const changelogOf = (job: ExportJobRow): Promise<{ op: string; columns: string[] }[]> =>
    handle.app.withTenant(job.tenant_id, async (tx) => {
      const { rows } = await tx.query<{ op: string; columns: string[] }>(
        `SELECT op, columns FROM ${handle.schema}.changelog WHERE "table" = $1 ORDER BY seq`,
        [EXPORT_JOB.table],
      );
      return rows;
    });

  /** The attempt key the claim leaving `job` at `rowVersion` stores to. */
  const attemptKey = (job: ExportJobRow, rowVersion: number): string => exportAttemptKey(job.tenant_id, job.job_id, job.format, String(rowVersion));

  /** Both output-slot keys of `job`. */
  const slotKeys = (job: ExportJobRow): string[] => OUTPUT_SLOTS.map((slot) => exportObjectKey(job.tenant_id, job.job_id, job.format, slot));

  /** Stores a csv header at each of `keys`, as an interrupted claim or a migrated output leaves it. */
  async function leaveObjects(keys: readonly string[]): Promise<void> {
    for (const key of keys) await storage.put(EXPORT_BUCKET, key, Buffer.from('timesheet_id,status\r\n'), { contentType: 'text/csv' });
  }

  /** Moves `queued` to running as a delivery's claim does, leaving it at row version 2. */
  const claim = (queued: QueuedJob): Promise<unknown> =>
    withGatedTenant(handle.app, queued.job.tenant_id, (tx) =>
      transitionJob(tx, repository, { jobId: queued.job.job_id, to: 'running', now: RUN_AT }),
    );

  /** Asserts `job` is done with its output at `key`, stored with the SHA-256 its row records. */
  async function expectDoneAt(job: ExportJobRow, key: string, fields: Partial<ExportJobRow>): Promise<void> {
    const stored = await read(job);
    expect(stored).toMatchObject({ state: 'done', error: null, object_key: key, content_type: 'text/csv', ...fields });
    const head = await storage.head(EXPORT_BUCKET, key);
    expect(head).toMatchObject({ sha256: stored?.output_sha256, contentType: 'text/csv' });
    expect(head?.size).toBeGreaterThan(0);
  }

  it("runs a queued job to done, reading its source with the requester's token and storing at its claim's attempt key", async () => {
    const queued = await queuedJob();
    const { client, tokens } = sheetsClient(queued.payload.userToken, [sheetRow('T1', queued.siteId)]);

    expect(await deliver(runnerDeps(client), queued)).toStrictEqual({ outcome: 'done', state: 'done' });

    expect(tokens).toStrictEqual([queued.payload.userToken]);
    await expectDoneAt(queued.job, attemptKey(queued.job, 2), { started_at: RUN_AT, finished_at: RUN_AT, row_version: '3' });
    expect((await changelogOf(queued.job)).map((row) => row.op)).toStrictEqual(['insert', 'update', 'update']);
  });

  it('reclaims a job an interrupted delivery left running, restarting it, and runs it to done at its own attempt key', async () => {
    const queued = await queuedJob();
    await claim(queued);
    const { client } = sheetsClient(queued.payload.userToken, [sheetRow('T1', queued.siteId)]);

    expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toStrictEqual({ outcome: 'done', state: 'done' });

    await expectDoneAt(queued.job, attemptKey(queued.job, 3), { started_at: RERUN_AT, finished_at: RERUN_AT, row_version: '4' });
    const reclaim = (await changelogOf(queued.job))[2];
    expect(reclaim?.op).toBe('update');
    expect(reclaim?.columns).toContain('started_at');
    expect(reclaim?.columns).not.toContain('state');
  });

  it('answers a gate closed after the start with the legacy 503, then a redelivery after it reopens runs the job to done', async () => {
    const queued = await queuedJob();
    const holderId = `window-${cfUuid()}`;
    const closeAfterStart = once(() => closeGates(handle.app, { units: [EXPORT_JOB.unit], holderId }));
    const { client } = sheetsClient(queued.payload.userToken, [sheetRow('T1', queued.siteId)], closeAfterStart);

    const refused: unknown = await deliverWithinBudget(runnerDeps(client), queued).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(GateClosedError);
    expect(refused).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(await read(queued.job)).toMatchObject({ state: 'running', started_at: RUN_AT, finished_at: null, row_version: '2' });
    expect(await storage.head(EXPORT_BUCKET, attemptKey(queued.job, 2))).not.toBeNull();

    await openGates(handle.app, { units: [EXPORT_JOB.unit], holderId, state: 'open' });
    expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toStrictEqual({ outcome: 'done', state: 'done' });

    await expectDoneAt(queued.job, attemptKey(queued.job, 3), { started_at: RERUN_AT, finished_at: RERUN_AT, row_version: '4' });
    expect(await storage.head(EXPORT_BUCKET, attemptKey(queued.job, 2))).toBeNull();
  });

  it('skips without a row write the finish of a delivery whose claim a later delivery took over, deleting the object it stored', async () => {
    const queued = await queuedJob();
    const takeOver = once(() =>
      withGatedTenant(handle.app, queued.job.tenant_id, (tx) => reclaimRun(tx, repository, { jobId: queued.job.job_id, now: RERUN_AT })),
    );
    const { client } = sheetsClient(queued.payload.userToken, [sheetRow('T1', queued.siteId)], takeOver);

    const result = await deliver(runnerDeps(client), queued);

    expect(result).toStrictEqual({ outcome: 'skipped', state: 'running' });
    expect(await read(queued.job)).toMatchObject({ state: 'running', started_at: RERUN_AT, finished_at: null, object_key: null, row_version: '3' });
    expect((await changelogOf(queued.job)).map((row) => row.op)).toStrictEqual(['insert', 'update', 'update']);
    expect(await storage.head(EXPORT_BUCKET, attemptKey(queued.job, 2))).toBeNull();
  });

  it('keeps the output of the latest claim when deliveries it superseded finish after it', async () => {
    const queued = await queuedJob();
    const [first, second] = [heldRead(), heldRead()];
    const deliveryOf = (timesheetId: string, hold?: () => Promise<void>): Promise<RunExportResult> =>
      deliver(runnerDeps(sheetsClient(queued.payload.userToken, [sheetRow(timesheetId, queued.siteId)], hold).client), queued);

    const stale = deliveryOf('OLD', first.hold);
    await first.started;
    const staler = deliveryOf('MIDDLE', second.hold);
    await second.started;
    expect(await deliveryOf('NEW')).toStrictEqual({ outcome: 'done', state: 'done' });
    first.release();
    expect(await stale).toStrictEqual({ outcome: 'skipped', state: 'done' });
    second.release();
    expect(await staler).toStrictEqual({ outcome: 'skipped', state: 'done' });

    await expectDoneAt(queued.job, attemptKey(queued.job, 4), { row_version: '5' });
    expect((await storage.get(EXPORT_BUCKET, attemptKey(queued.job, 4))).toString()).toBe('timesheet_id,status\r\nNEW,SUBMITTED\r\n');
    for (const superseded of [2, 3]) expect(await storage.head(EXPORT_BUCKET, attemptKey(queued.job, superseded))).toBeNull();
  });

  it.each<[string, string, Partial<ExportJobRow>]>([
    ['done', 'timesheets.sheets', { state: 'done' }],
    ['failed', 'broken', { state: 'failed', error: 'source-unavailable' }],
  ])('skips a redelivery of a %s job without changing its row or changelog', async (state, source, fields) => {
    const queued = await queuedJob(source);
    const { client, tokens } = sheetsClient(queued.payload.userToken, [sheetRow('T1', queued.siteId)]);
    await deliver(runnerDeps(client), queued);
    const before = await read(queued.job);
    expect(before).toMatchObject(fields);
    const logged = await changelogOf(queued.job);
    const reads = tokens.length;

    expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toStrictEqual({ outcome: 'skipped', state });

    expect(await read(queued.job)).toStrictEqual(before);
    expect(await changelogOf(queued.job)).toStrictEqual(logged);
    expect(tokens).toHaveLength(reads);
  });

  it('skips a delivery for a job that does not exist', async () => {
    const queued = await queuedJob();
    const { client, tokens } = sheetsClient(queued.payload.userToken, []);

    const result = await runExport(runnerDeps(client), { tenantId: queued.job.tenant_id, jobId: cfUuid(), payload: queued.payload });

    expect(result).toStrictEqual({ outcome: 'skipped', state: null });
    expect(tokens).toStrictEqual([]);
  });

  it('fails a job whose definition is gone with export-failed without reading a source', async () => {
    const queued = await queuedJob();
    await handle.app.withTenant(queued.job.tenant_id, (tx) =>
      tx.query(`DELETE FROM ${handle.schema}.export_definition WHERE definition_id = $1`, [queued.job.definition_id]),
    );
    const { client, tokens } = sheetsClient(queued.payload.userToken, []);

    expect(await deliver(runnerDeps(client), queued)).toStrictEqual({ outcome: 'failed', state: 'failed', error: 'export-failed' });

    expect(tokens).toStrictEqual([]);
    expect(await read(queued.job)).toMatchObject({ state: 'failed', error: 'export-failed', finished_at: RUN_AT, object_key: null });
  });

  it('fails a job terminally with source-unavailable when the source refuses the expired requester token with 401', async () => {
    const queued = await queuedJob();
    const { client, tokens } = sheetsClient('a-fresh-token', [sheetRow('T1', queued.siteId)]);

    expect(await deliver(runnerDeps(client), queued)).toStrictEqual({ outcome: 'failed', state: 'failed', error: 'source-unavailable' });
    expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toStrictEqual({ outcome: 'skipped', state: 'failed' });

    expect(tokens).toStrictEqual([queued.payload.userToken]);
    expect(await read(queued.job)).toMatchObject({ state: 'failed', error: 'source-unavailable', finished_at: RUN_AT, object_key: null });
  });

  it.each<[string, (queued: QueuedJob) => string, (queued: QueuedJob) => Partial<ExportJobRow>]>([
    ['done', (queued) => queued.payload.userToken, (queued) => ({ state: 'done', object_key: attemptKey(queued.job, 3) })],
    ['failed', () => 'a-fresh-token', () => ({ state: 'failed', error: 'source-unavailable', object_key: null })],
  ])(
    'deletes the outputs an interrupted claim and both slots hold when the next delivery finishes the job %s',
    async (state, accepted, fields) => {
      const queued = await queuedJob();
      await claim(queued);
      const leftovers = [attemptKey(queued.job, 2), ...slotKeys(queued.job)];
      await leaveObjects(leftovers);
      const { client } = sheetsClient(accepted(queued), [sheetRow('T1', queued.siteId)]);

      expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toMatchObject({ outcome: state, state });

      const stored = await read(queued.job);
      expect(stored).toMatchObject({ ...fields(queued), row_version: '4' });
      const heads = await Promise.all([...leftovers, attemptKey(queued.job, 3)].map((key) => storage.head(EXPORT_BUCKET, key)));
      expect(heads.map((head) => head?.sha256 ?? null)).toStrictEqual([null, null, null, stored?.output_sha256 ?? null]);
    },
  );

  it("deletes a running job's claim output when a create's recovery fails the job, its run task gone", async () => {
    const queued = await queuedJob();
    await claim(queued);
    const leftovers = [attemptKey(queued.job, 2), ...slotKeys(queued.job)];
    await leaveObjects(leftovers);

    await createExportJob(
      { db: handle.app, repository, storage, clock: fixedClock(RUN_AT), enqueue: () => Promise.resolve(), runScheduled: () => Promise.resolve(false) },
      {
        tenantId: queued.job.tenant_id,
        siteId: queued.siteId,
        definitionId: queued.job.definition_id,
        format: 'csv',
        requestedById: cfUuid(),
        userToken: queued.payload.userToken,
        params: {},
      },
    );

    expect(await read(queued.job)).toMatchObject({ state: 'failed', error: 'export-failed', object_key: null, row_version: '3' });
    for (const key of leftovers) expect(await storage.head(EXPORT_BUCKET, key)).toBeNull();
  });
});
