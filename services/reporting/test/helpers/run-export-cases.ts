// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export runner and `/v1` export-run task cases, defined once and run over the memory database or a throwaway PostgreSQL schema. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import {
  GateClosedError,
  UNIT_GATE_TABLE,
  closeGates,
  ensureUnitGates,
  openGates,
  qualified,
  sha256Hex,
  withGatedTenant,
} from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, fixedClock, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter } from '@opt2/platform/storage';
import { QUEUES, taskWireBody } from '@opt2/platform/tasks';
import { tenantIdForSite, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, assertResponseMatchesOpenApi, createThrowawaySchema, mintTasksInvokerToken } from '@opt2/platform/testing';
import type { EnqueueExportRun, ExportRunPayload, ReportingDeps } from '../../src/domain/deps.js';
import { transitionJob } from '../../src/domain/job-state.js';
import { createExportJob } from '../../src/domain/jobs.js';
import { runExport, type RunExportResult } from '../../src/domain/run-export.js';
import { findJob } from '../../src/repo/queries.js';
import { createReportingRepository, type ReportingRepository } from '../../src/repo/repository.js';
import {
  EXPORT_BUCKET,
  EXPORT_FORMATS,
  EXPORT_JOB,
  OUTPUT_SLOTS,
  UNITS,
  exportAttemptKey,
  exportObjectKey,
  type ExportFormat,
  type ExportJobRow,
  type ExportSource,
} from '../../src/repo/tables.js';
import { exportRunTaskName } from '../../src/tasks/enqueue.js';
import {
  OPENAPI,
  REQUESTER,
  SERVICE,
  SOURCE_PATHS,
  buildTestApp,
  headersFor,
  type ClientReply,
  type ExportProducer,
  type TestApp,
  type TestDbMode,
} from './app.js';
import { seedDefinitions, type SeededDefinitions } from './fixtures.js';
import { createMemoryDb } from './memory-db.js';

const QUEUE = QUEUES['reporting-export-run'];
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const CREATED_AT = new Date(2026, 5, 30, 10, 0, 0, 0);
const RUN_AT = new Date(2026, 5, 30, 10, 1, 0, 0);
/** Clock time of a redelivery, after a first delivery at `RUN_AT`. */
export const RERUN_AT = new Date(2026, 5, 30, 10, 5, 0, 0);
// Long enough for a delivery's start and source read, short enough that its finish waits the budget out on a closed gate.
const FINISH_BUDGET_MS = 1500;
/** Holder id the PostgreSQL setup opens every gate under. */
const SETUP_HOLDER = 'run-export-test';

/** Collaborators of one delivery. */
export type RunnerDeps = Pick<ReportingDeps, 'db' | 'repository' | 'storage' | 'clock' | 'client'>;

/** A queued job as the create route leaves it, with the payload of its task and its site. */
export interface QueuedJob {
  job: ExportJobRow;
  payload: ExportRunPayload;
  siteId: string;
}

/** One sheet-status row of `siteId` as the timesheets producer answers it. */
export function sheetRow(timesheetId: string, siteId: string): Record<string, unknown> {
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

/** The System export read of the timesheets producer. */
const SHEET_STATUS_PATH = '/internal/v1/timesheets/sheet-status';

/**
 * Timesheets stub of the System export read: after `beforeAnswer`, answers a read carrying no user token with `status` and, when 200,
 * the one page `items`; any other read answers 403. Records every read; nothing else may be called.
 */
export function sheetsClient(
  items: readonly unknown[],
  beforeAnswer: () => Promise<void> = () => Promise.resolve(),
  status = 200,
): { client: ServiceClient; reads: ServiceRequest[] } {
  const reads: ServiceRequest[] = [];
  const client: ServiceClient = {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      if (req.service !== 'timesheets' || req.path !== SHEET_STATUS_PATH) throw new Error(`unexpected call to ${req.service} ${req.path}`);
      reads.push(req);
      await beforeAnswer();
      const answered = req.userToken === null ? status : 403;
      const response: ServiceResponse =
        answered === 200
          ? { status: 200, headers: { 'content-type': 'application/json' }, body: { items, total: items.length } }
          : { status: answered, headers: { 'content-type': 'application/json' }, body: { error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } } };
      return response as ServiceResponse<T>;
    },
    close: () => Promise.resolve(),
  };
  return { client, reads };
}

/** The query of a sheet-status page read naming `queued`'s export scope under run claim `claim`. */
function scopeQuery(queued: QueuedJob, claim: string, pageIndex = '1'): Record<string, string> {
  return { exportId: queued.job.job_id, siteId: queued.siteId, claim, asOf: '2026-06-30', pageIndex, itemsPerPage: '1000' };
}

/** `fn` run once; later calls resolve without running it. */
export function once(fn: () => Promise<unknown>): () => Promise<void> {
  let ran = false;
  return async () => {
    if (ran) return;
    ran = true;
    await fn();
  };
}

/** The runner's database with every unit gate open, and its mode's way to close and reopen a gate. */
interface RunnerDb {
  db: TenantDb;
  closeGate(unit: string, holderId: string): Promise<unknown>;
  openGate(unit: string, holderId: string): Promise<unknown>;
  drop(): Promise<void>;
}

/** Deletes the `export_definition` row of `job`'s definition id under `job`'s tenant. */
function removeDefinition(db: TenantDb, job: ExportJobRow): Promise<unknown> {
  return db.withTenant(job.tenant_id, (tx) => tx.query(`DELETE FROM ${db.schema}.export_definition WHERE definition_id = $1`, [job.definition_id]));
}

/** A throwaway schema whose gates the platform's compare-and-set opens and closes. */
async function pgRunnerDb(): Promise<RunnerDb> {
  const handle = await createThrowawaySchema({ service: SERVICE, migrationsDir: MIGRATIONS_DIR });
  try {
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: SETUP_HOLDER, allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: SETUP_HOLDER, state: 'open' });
  } catch (err) {
    await handle.drop();
    throw err;
  }
  return {
    db: handle.app,
    closeGate: (unit, holderId) => closeGates(handle.app, { units: [unit], holderId }),
    openGate: (unit, holderId) => openGates(handle.app, { units: [unit], holderId, state: 'open' }),
    drop: () => handle.drop(),
  };
}

/** A memory database seeded with every unit gate open, whose gates move by direct row writes. */
function memoryRunnerDb(): RunnerDb {
  const memory = createMemoryDb({ now: () => CREATED_AT });
  memory.seed(
    'unit_gate',
    UNITS.map((unit) => ({ unit, state: 'open', holder_id: null, phase: 'quiet', updated_at: CREATED_AT })),
  );
  const setGate = (unit: string, state: 'open' | 'closed', holderId: string | null) =>
    withMetadata(memory, (tx) =>
      tx.query(`UPDATE ${qualified(tx.schema, UNIT_GATE_TABLE)} SET state = $2, holder_id = $3 WHERE unit = $1`, [unit, state, holderId]),
    );
  return {
    db: memory,
    closeGate: (unit, holderId) => setGate(unit, 'closed', holderId),
    openGate: (unit) => setGate(unit, 'open', null),
    drop: () => Promise.resolve(),
  };
}

/** The runner cases' database, storage and helpers, for further cases of the describe that defined them once its `beforeAll` ran. */
export interface ExportRunner {
  readonly db: TenantDb;
  readonly repository: ReportingRepository;
  readonly storage: LocalStorageAdapter;
  /** A queued csv job of a new site's definition reading `source`, created as the create route creates it. */
  queuedJob(source?: string): Promise<QueuedJob>;
  /** Collaborators of a delivery reading through `client` at `at`, `RUN_AT` by default. */
  runnerDeps(client: ServiceClient, at?: Date): RunnerDeps;
  /** Delivers `queued`'s run task once. */
  deliver(deps: RunnerDeps, queued: QueuedJob): Promise<RunExportResult>;
  /** The stored row of `job`, or null. */
  read(job: ExportJobRow): Promise<ExportJobRow | null>;
  /** Op and changed columns of each `export_job` changelog row of `job`'s tenant, oldest first. */
  changelogOf(job: ExportJobRow): Promise<{ op: string; columns: string[] }[]>;
  /** The attempt key the claim leaving `job` at `rowVersion` stores to. */
  attemptKey(job: ExportJobRow, rowVersion: number): string;
  /** Asserts `job` is done with its output at `key`, stored with the SHA-256 its row records. */
  expectDoneAt(job: ExportJobRow, key: string, fields: Partial<ExportJobRow>): Promise<void>;
}

/** Registers, in the calling describe, the export runner's cases over `mode`'s database, local storage and stub sources. */
export function defineExportRunnerCases(mode: TestDbMode): ExportRunner {
  let base: RunnerDb;
  let stateDir: string;
  let storage: LocalStorageAdapter;
  let repository: ReportingRepository;
  let sites = 0;

  beforeAll(async () => {
    base = mode === 'pg' ? await pgRunnerDb() : memoryRunnerDb();
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-run-export-'));
    storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'run-export-test-key' });
    repository = createReportingRepository({ db: base.db, storage, clock: fixedClock(CREATED_AT) });
  });

  afterAll(async () => {
    await base?.drop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  async function queuedJob(source = 'timesheets.sheets'): Promise<QueuedJob> {
    sites += 1;
    const siteId = `run-export-${String(sites)}`;
    const tenantId = tenantIdForSite(siteId);
    const definitionId = cfUuid();
    const { db } = base;
    await db.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${db.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns)
         VALUES ($1, $2, $3, 'Sheets', $4, $5)`,
        [tenantId, definitionId, siteId, source, '["timesheet_id","status"]'],
      ),
    );
    const runs: Parameters<EnqueueExportRun>[0][] = [];
    const enqueue: EnqueueExportRun = (run) => {
      runs.push(run);
      return Promise.resolve();
    };
    const job = await createExportJob(
      { db, repository, storage, clock: fixedClock(CREATED_AT), enqueue, runScheduled: () => Promise.resolve(true) },
      { tenantId, siteId, definitionId, format: 'csv', requestedById: cfUuid(), params: {} },
    );
    const [run] = runs as [Parameters<EnqueueExportRun>[0]];
    return { job, payload: run.payload, siteId };
  }

  const runnerDeps = (client: ServiceClient, at: Date = RUN_AT): RunnerDeps => ({ db: base.db, repository, storage, clock: fixedClock(at), client });

  const deliver = (deps: RunnerDeps, { job, payload }: QueuedJob): Promise<RunExportResult> =>
    runExport(deps, { tenantId: job.tenant_id, jobId: job.job_id, payload });

  /** `deliver` with every gated transaction it opens sharing one `FINISH_BUDGET_MS` gate budget. */
  const deliverWithinBudget = (deps: RunnerDeps, queued: QueuedJob): Promise<RunExportResult> =>
    withGatedTenant(base.db, queued.job.tenant_id, () => deliver(deps, queued), { budgetMs: FINISH_BUDGET_MS });

  const read = (job: ExportJobRow): Promise<ExportJobRow | null> =>
    base.db.withTenant(job.tenant_id, async (tx) => {
      const { rows } = await tx.query<ExportJobRow>(`SELECT * FROM ${base.db.schema}.export_job WHERE job_id = $1`, [job.job_id]);
      return rows[0] ?? null;
    });

  const changelogOf = (job: ExportJobRow): Promise<{ op: string; columns: string[] }[]> =>
    base.db.withTenant(job.tenant_id, async (tx) => {
      const { rows } = await tx.query<{ op: string; columns: string[]; seq: string }>(
        `SELECT op, columns, seq::text AS seq FROM ${base.db.schema}.changelog WHERE "table" = $1`,
        [EXPORT_JOB.table],
      );
      // Sorted as numbers here: the memory database orders by text.
      return rows.sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq))).map(({ op, columns }) => ({ op, columns }));
    });

  const attemptKey = (job: ExportJobRow, rowVersion: number): string => exportAttemptKey(job.tenant_id, job.job_id, job.format, String(rowVersion));

  /** Both output-slot keys of `job`. */
  const slotKeys = (job: ExportJobRow): string[] => OUTPUT_SLOTS.map((slot) => exportObjectKey(job.tenant_id, job.job_id, job.format, slot));

  /** Stores a csv header at each of `keys`, as an interrupted claim or a migrated output leaves it. */
  async function leaveObjects(keys: readonly string[]): Promise<void> {
    for (const key of keys) await storage.put(EXPORT_BUCKET, key, Buffer.from('timesheet_id,status\r\n'), { contentType: 'text/csv' });
  }

  /** Moves `queued` to running as a delivery's claim does, leaving it at row version 2. */
  const claim = (queued: QueuedJob): Promise<unknown> =>
    withGatedTenant(base.db, queued.job.tenant_id, (tx) =>
      transitionJob(tx, repository, { jobId: queued.job.job_id, to: 'running', now: RUN_AT }),
    );

  async function expectDoneAt(job: ExportJobRow, key: string, fields: Partial<ExportJobRow>): Promise<void> {
    const stored = await read(job);
    expect(stored).toMatchObject({ state: 'done', error: null, object_key: key, content_type: 'text/csv', ...fields });
    const head = await storage.head(EXPORT_BUCKET, key);
    expect(head).toMatchObject({ sha256: stored?.output_sha256, contentType: 'text/csv' });
    expect(head?.size).toBeGreaterThan(0);
  }

  it("runs a queued job to done as System, reading its source under the job's export scope and claim with no user token, storing at its claim's attempt key", async () => {
    const queued = await queuedJob();
    const { client, reads } = sheetsClient([sheetRow('T1', queued.siteId)]);

    expect(await deliver(runnerDeps(client), queued)).toStrictEqual({ outcome: 'done', state: 'done' });

    expect(reads).toStrictEqual([{ service: 'timesheets', method: 'GET', path: SHEET_STATUS_PATH, query: scopeQuery(queued, '2'), userToken: null }]);
    await expectDoneAt(queued.job, attemptKey(queued.job, 2), { started_at: RUN_AT, finished_at: RUN_AT, row_version: '3' });
    expect((await changelogOf(queued.job)).map((row) => row.op)).toStrictEqual(['insert', 'update', 'update']);
  });

  it('reclaims a job an interrupted delivery left running, restarting it, and runs it to done at its own attempt key', async () => {
    const queued = await queuedJob();
    await claim(queued);
    const { client, reads } = sheetsClient([sheetRow('T1', queued.siteId)]);

    expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toStrictEqual({ outcome: 'done', state: 'done' });

    // The read names the reclaim's own claim, so a producer refuses the interrupted delivery's earlier one.
    expect(reads.map((read) => read.query)).toStrictEqual([scopeQuery(queued, '3')]);
    await expectDoneAt(queued.job, attemptKey(queued.job, 3), { started_at: RERUN_AT, finished_at: RERUN_AT, row_version: '4' });
    const reclaim = (await changelogOf(queued.job))[2];
    expect(reclaim?.op).toBe('update');
    expect(reclaim?.columns).toContain('started_at');
    expect(reclaim?.columns).not.toContain('state');
  });

  it('answers a gate closed after the start with the legacy 503, then a redelivery after it reopens runs the job to done', async () => {
    const queued = await queuedJob();
    const holderId = `window-${cfUuid()}`;
    const closeAfterStart = once(() => base.closeGate(EXPORT_JOB.unit, holderId));
    const { client } = sheetsClient([sheetRow('T1', queued.siteId)], closeAfterStart);

    const refused: unknown = await deliverWithinBudget(runnerDeps(client), queued).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(GateClosedError);
    expect(refused).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(await read(queued.job)).toMatchObject({ state: 'running', started_at: RUN_AT, finished_at: null, row_version: '2' });
    expect(await storage.head(EXPORT_BUCKET, attemptKey(queued.job, 2))).not.toBeNull();

    await base.openGate(EXPORT_JOB.unit, holderId);
    expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toStrictEqual({ outcome: 'done', state: 'done' });

    await expectDoneAt(queued.job, attemptKey(queued.job, 3), { started_at: RERUN_AT, finished_at: RERUN_AT, row_version: '4' });
    expect(await storage.head(EXPORT_BUCKET, attemptKey(queued.job, 2))).toBeNull();
  });

  it.each<[string, string, Partial<ExportJobRow>]>([
    ['done', 'timesheets.sheets', { state: 'done' }],
    ['failed', 'broken', { state: 'failed', error: 'source-unavailable' }],
  ])('skips a redelivery of a %s job without changing its row or changelog', async (state, source, fields) => {
    const queued = await queuedJob(source);
    const { client, reads } = sheetsClient([sheetRow('T1', queued.siteId)]);
    await deliver(runnerDeps(client), queued);
    const before = await read(queued.job);
    expect(before).toMatchObject(fields);
    const logged = await changelogOf(queued.job);
    const sent = reads.length;

    expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toStrictEqual({ outcome: 'skipped', state });

    expect(await read(queued.job)).toStrictEqual(before);
    expect(await changelogOf(queued.job)).toStrictEqual(logged);
    expect(reads).toHaveLength(sent);
  });

  it('skips a delivery for a job that does not exist', async () => {
    const queued = await queuedJob();
    const { client, reads } = sheetsClient([]);

    const result = await runExport(runnerDeps(client), { tenantId: queued.job.tenant_id, jobId: cfUuid(), payload: queued.payload });

    expect(result).toStrictEqual({ outcome: 'skipped', state: null });
    expect(reads).toStrictEqual([]);
  });

  it('fails a job whose definition is gone with export-failed without reading a source', async () => {
    const queued = await queuedJob();
    await removeDefinition(base.db, queued.job);
    const { client, reads } = sheetsClient([]);

    expect(await deliver(runnerDeps(client), queued)).toStrictEqual({ outcome: 'failed', state: 'failed', error: 'export-failed' });

    expect(reads).toStrictEqual([]);
    expect(await read(queued.job)).toMatchObject({ state: 'failed', error: 'export-failed', finished_at: RUN_AT, object_key: null });
  });

  it('runs a job delivered past the local token lifetime after its create to done, its task carrying no credential', async () => {
    const queued = await queuedJob();
    const late = new Date(CREATED_AT.getTime() + (LOCAL_USER_TOKEN.lifetimeSeconds + 60) * 1000);
    const { client, reads } = sheetsClient([sheetRow('T1', queued.siteId)]);

    expect(queued.payload).toStrictEqual({ jobId: queued.job.job_id, asOf: '2026-06-30' });
    expect(await deliver(runnerDeps(client, late), queued)).toStrictEqual({ outcome: 'done', state: 'done' });

    expect(reads.map((read) => [read.query, read.userToken])).toStrictEqual([[scopeQuery(queued, '2'), null]]);
    await expectDoneAt(queued.job, attemptKey(queued.job, 2), { started_at: late, finished_at: late });
  });

  it.each([
    ['refuses its export scope with 403', 403],
    ['answers 404', 404],
    ['answers 503', 503],
  ])('fails a job terminally with source-unavailable when the source %s, and a redelivery changes nothing', async (_case, status) => {
    const queued = await queuedJob();
    const { client, reads } = sheetsClient([sheetRow('T1', queued.siteId)], undefined, status);

    expect(await deliver(runnerDeps(client), queued)).toStrictEqual({ outcome: 'failed', state: 'failed', error: 'source-unavailable' });
    const failed = await read(queued.job);
    expect(await deliver(runnerDeps(client, RERUN_AT), queued)).toStrictEqual({ outcome: 'skipped', state: 'failed' });

    expect(reads).toHaveLength(1);
    expect(failed).toMatchObject({ state: 'failed', error: 'source-unavailable', finished_at: RUN_AT, object_key: null });
    expect(await read(queued.job)).toStrictEqual(failed);
  });

  it.each<[string, number, (queued: QueuedJob) => Partial<ExportJobRow>]>([
    ['done', 200, (queued) => ({ state: 'done', object_key: attemptKey(queued.job, 3) })],
    ['failed', 403, () => ({ state: 'failed', error: 'source-unavailable', object_key: null })],
  ])(
    'deletes the outputs an interrupted claim and both slots hold when the next delivery finishes the job %s',
    async (state, status, fields) => {
      const queued = await queuedJob();
      await claim(queued);
      const leftovers = [attemptKey(queued.job, 2), ...slotKeys(queued.job)];
      await leaveObjects(leftovers);
      const { client } = sheetsClient([sheetRow('T1', queued.siteId)], undefined, status);

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
      { db: base.db, repository, storage, clock: fixedClock(RUN_AT), enqueue: () => Promise.resolve(), runScheduled: () => Promise.resolve(false) },
      {
        tenantId: queued.job.tenant_id,
        siteId: queued.siteId,
        definitionId: queued.job.definition_id,
        format: 'csv',
        requestedById: cfUuid(),
        params: {},
      },
    );

    expect(await read(queued.job)).toMatchObject({ state: 'failed', error: 'export-failed', object_key: null, row_version: '3' });
    for (const key of leftovers) expect(await storage.head(EXPORT_BUCKET, key)).toBeNull();
  });

  return {
    get db() {
      return base.db;
    },
    get repository() {
      return repository;
    },
    get storage() {
      return storage;
    },
    queuedJob,
    runnerDeps,
    deliver,
    read,
    changelogOf,
    attemptKey,
    expectDoneAt,
  };
}

/** Content type each format's output is stored and served with. */
const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = Object.freeze({
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
});

/** The readable sources, each with the producer its export read goes to. */
const SOURCE_PRODUCERS: ReadonlyArray<readonly [ExportSource, ExportProducer]> = [
  ['timesheets.sheets', 'timesheets'],
  ['finance.records', 'finance'],
];

/** Every format with every readable source. */
const FORMAT_SOURCE_CASES = EXPORT_FORMATS.flatMap((format) => SOURCE_PRODUCERS.map(([source, producer]) => [format, source, producer] as const));

/** Row version a fresh job's first claim leaves it at, naming that run's attempt key. */
const FIRST_CLAIM = '2';

/** Gate budget a delivery refused by a closed gate waits out, in place of the platform's 30 s. */
const REFUSAL_BUDGET_MS = 500;

/** Registers, in the calling describe, the run task cases of a `/v1` create through the whole reporting app over `mode`'s database. */
export function defineExportRunTaskCases(mode: TestDbMode): void {
  let t: TestApp<TenantDb>;
  let definitions: SeededDefinitions;

  beforeAll(async () => {
    t = await buildTestApp({ db: mode });
    definitions = await seedDefinitions(t);
  });

  afterEach(() => {
    t?.client.reset();
  });

  afterAll(async () => {
    await t?.close();
  });

  const exporterHeaders = (): Promise<Record<string, string>> => headersFor('reporting.exporter', { site: TENANT_A.siteId });

  /** Queues a `format` export of tenant-a's `source` definition through `POST /v1/reporting/exports`, as the exporter; returns its job id. */
  async function createExport(source: ExportSource, format: ExportFormat): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/reporting/exports',
      headers: { ...(await exporterHeaders()), ...t.client.issueCsrf(REQUESTER.sid, '') },
      payload: { definitionId: definitions.A[source].definition_id, format },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ data: { job_id: string } }>().data.job_id;
  }

  /** POSTs job `jobId`'s queued run task to the URL it was created with, as the tasks-invoker, as the local adapter dispatches it. */
  async function deliver(jobId: string) {
    const task = t.tasks.live.get(`${QUEUE.name}/${exportRunTaskName(jobId)}`);
    if (task === undefined) throw new Error(`no run task is queued for export job ${jobId}`);
    return t.app.inject({
      method: 'POST',
      url: new URL(task.url).pathname,
      headers: { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` },
      payload: taskWireBody(task),
    });
  }

  /** Job `jobId` as stored under tenant-a. */
  async function storedJob(jobId: string): Promise<ExportJobRow> {
    const job = await withTenant(t.db, TENANT_A.tenantId, (tx) => findJob(tx, jobId));
    if (job === null) throw new Error(`tenant-a holds no export job ${jobId}`);
    return job;
  }

  const firstAttemptKey = (jobId: string, format: ExportFormat): string => exportAttemptKey(TENANT_A.tenantId, jobId, format, FIRST_CLAIM);

  it.each(FORMAT_SOURCE_CASES)(
    'runs a %s export of %s queued by POST /v1/reporting/exports to done through its run task, storing the bytes its job records',
    async (format, source, producer) => {
      const jobId = await createExport(source, format);
      const before = t.client.requests.length;

      const run = await deliver(jobId);

      expect({ status: run.statusCode, body: run.json<unknown>() }).toStrictEqual({ status: 200, body: { jobId, state: 'done' } });
      expect(t.client.requests.slice(before).map((read) => [read.service, read.path, read.query?.exportId, read.userToken])).toStrictEqual([
        [producer, SOURCE_PATHS[producer], jobId, null],
      ]);
      const key = firstAttemptKey(jobId, format);
      const stored = await storedJob(jobId);
      expect(stored).toMatchObject({ state: 'done', error: null, file_name: `export-${jobId}.${format}`, content_type: CONTENT_TYPES[format], object_key: key });
      const detail = await t.app.inject({ method: 'GET', url: `/v1/reporting/exports/${jobId}`, headers: await exporterHeaders() });
      expect(detail.json<{ data: unknown }>().data).toMatchObject({
        job_id: jobId,
        state: 'done',
        error: '',
        file_name: stored.file_name,
        content_type: stored.content_type,
        output_sha256: stored.output_sha256,
      });
      expect(await t.storage.head(EXPORT_BUCKET, key)).toMatchObject({ sha256: stored.output_sha256, contentType: CONTENT_TYPES[format] });
      expect(sha256Hex(await t.storage.get(EXPORT_BUCKET, key))).toBe(stored.output_sha256);
    },
  );

  it.each<[string, ClientReply]>([
    [
      'refuses the connection',
      () => {
        throw new ServiceUnavailableError('timesheets', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8118'), { code: 'ECONNREFUSED' }));
      },
    ],
    ['answers 503', () => ({ status: 503, headers: {}, body: undefined })],
  ])('fails a queued export source-unavailable through its run task, storing no object, when the producer %s', async (_case, reply) => {
    const jobId = await createExport('timesheets.sheets', 'csv');
    t.client.answer('timesheets', SOURCE_PATHS.timesheets, reply);

    const run = await deliver(jobId);

    expect({ status: run.statusCode, body: run.json<unknown>() }).toStrictEqual({ status: 200, body: { jobId, state: 'failed' } });
    expect(await storedJob(jobId)).toMatchObject({ state: 'failed', error: 'source-unavailable', object_key: null, output_sha256: null });
    expect(await t.storage.head(EXPORT_BUCKET, firstAttemptKey(jobId, 'csv'))).toBeNull();
  });

  it('answers the legacy 503 while the job unit is closed, leaving the job queued and its source unread, then runs it to done once it reopens', async () => {
    const jobId = await createExport('timesheets.sheets', 'csv');
    const before = t.client.requests.length;
    await t.setGate(EXPORT_JOB.unit, 'closed');
    let refused: Awaited<ReturnType<typeof deliver>>;
    try {
      // The delivery's gated transactions share this scope's budget, so the refusal comes without the platform's 30 s wait.
      refused = await withGatedTenant(t.db, TENANT_A.tenantId, () => deliver(jobId), { budgetMs: REFUSAL_BUDGET_MS });
    } finally {
      await t.setGate(EXPORT_JOB.unit, 'open');
    }

    expect(refused.statusCode).toBe(503);
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'POST',
      path: QUEUE.targetPath.replace('{exportId}', jobId),
      status: refused.statusCode,
      contentType: refused.headers['content-type'] as string | undefined,
      body: refused.payload,
    });
    expect(await storedJob(jobId)).toMatchObject({ state: 'queued', started_at: null, row_version: '1' });
    expect(t.client.requests.slice(before)).toStrictEqual([]);

    const retried = await deliver(jobId);

    expect({ status: retried.statusCode, body: retried.json<unknown>() }).toStrictEqual({ status: 200, body: { jobId, state: 'done' } });
    expect(await storedJob(jobId)).toMatchObject({ state: 'done', object_key: firstAttemptKey(jobId, 'csv') });
  });
}
