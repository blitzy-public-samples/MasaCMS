// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job state machine: the transition table, `transitionJob` against stored rows as `usp_export_job_transition` moves them, and failed jobs through the runner. */
import { Buffer } from 'node:buffer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeRow, encodeKey, qualified, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, pgAvailable } from '@opt2/platform/testing';
import type { ReportingDeps } from '../../src/domain/deps.js';
import {
  EXPORT_ERRORS,
  JOB_STATES,
  JOB_TRANSITIONS,
  isLegalTransition,
  transitionJob,
  type JobState,
  type TransitionInput,
} from '../../src/domain/job-state.js';
import { runExport } from '../../src/domain/run-export.js';
import { findJob } from '../../src/repo/queries.js';
import { createReportingRepository, type ReportingRepository } from '../../src/repo/repository.js';
import {
  EXPORT_BUCKET,
  EXPORT_JOB,
  OUTPUT_SLOTS,
  exportAttemptKey,
  exportObjectKey,
  type ExportDefinitionRow,
  type ExportJobRow,
} from '../../src/repo/tables.js';
import { TEST_AS_OF, TEST_CLOCK, buildTestApp, type SeedTable, type TestApp } from '../helpers/app.js';
import { jobFor, seedDefinitions, type SeededDefinitions } from '../helpers/fixtures.js';

/** The procedure's legal moves, in its CASE order. */
const LEGAL_EDGES: readonly (readonly [JobState, JobState])[] = [
  ['queued', 'running'],
  ['running', 'done'],
  ['running', 'failed'],
];

/** Every ordered (from, to) pair of job states, with whether the procedure applies it. */
const STATE_PAIRS = JOB_STATES.flatMap((from) =>
  JOB_STATES.map((to) => ({ from, to, legal: LEGAL_EDGES.some(([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to) })),
);

/** The 13 pairs the procedure answers illegal-state, self-moves and every move out of done or failed included. */
const ILLEGAL_PAIRS = STATE_PAIRS.filter((pair) => !pair.legal);

/** A finish time after every seeded job's start, so an unchanged `started_at` stays distinguishable. */
const FINISHED_AT = new Date(TEST_CLOCK.now().getTime() + 60_000);

/** Collaborators of one runner delivery. */
type RunnerDeps = Pick<ReportingDeps, 'db' | 'repository' | 'storage' | 'clock' | 'client'>;

/** One `export_job` changelog row. */
interface ChangelogRow {
  op: string;
  origin: string;
  after: string;
}

/** The attempt key of `job`'s first claim, which leaves it at row version 2. */
function firstClaimKey(job: ExportJobRow): string {
  return exportAttemptKey(job.tenant_id, job.job_id, job.format, '2');
}

/** The done move of `job` at `now`, naming the output at its first claim's key with SHA-256 `outputSha256`. */
function doneMove(job: ExportJobRow, now: Date, outputSha256: string): Extract<TransitionInput, { to: 'done' }> {
  return {
    jobId: job.job_id,
    to: 'done',
    now,
    fileName: `export-${job.job_id}.${job.format}`,
    contentType: 'text/csv',
    objectKey: firstClaimKey(job),
    outputSha256,
  };
}

/** A move of `job` to `to` at `now`; a done move names an output no illegal case reaches. */
function moveOf(job: ExportJobRow, to: JobState, now: Date): TransitionInput {
  switch (to) {
    case 'running':
      return { jobId: job.job_id, to, now };
    case 'done':
      return doneMove(job, now, '0'.repeat(64));
    case 'failed':
      return { jobId: job.job_id, to, now, error: 'export-failed' };
    case 'queued':
      // usp_export_job_transition takes any @to_state; queued lies outside TransitionInput yet still answers illegal-state.
      return { jobId: job.job_id, to, now } as unknown as TransitionInput;
  }
}

/** Keys of `job` holding a stored object: its export key, both output slots and the attempt key of each of its first four claims. */
async function storedKeysOf(storage: TestApp['storage'], job: ExportJobRow): Promise<string[]> {
  const keys = [
    exportObjectKey(job.tenant_id, job.job_id, job.format),
    ...OUTPUT_SLOTS.map((slot) => exportObjectKey(job.tenant_id, job.job_id, job.format, slot)),
    ...['1', '2', '3', '4'].map((claim) => exportAttemptKey(job.tenant_id, job.job_id, job.format, claim)),
  ];
  const heads = await Promise.all(keys.map((key) => storage.head(EXPORT_BUCKET, key)));
  return keys.filter((_, index) => heads[index] !== null);
}

/** The stored row of `job`, read under its tenant. */
function readJob(db: TenantDb, job: ExportJobRow): Promise<ExportJobRow | null> {
  return withTenant(db, job.tenant_id, (tx) => findJob(tx, job.job_id));
}

/** The `export_job` changelog rows of `job`, oldest first. */
function changelogOf(db: TenantDb, job: ExportJobRow): Promise<ChangelogRow[]> {
  return withTenant(db, job.tenant_id, async (tx) => {
    const { rows } = await tx.query<ChangelogRow>(
      `SELECT op, origin, after FROM ${qualified(tx.schema, 'changelog')} WHERE "table" = $1 AND key = $2 ORDER BY seq`,
      [EXPORT_JOB.table, encodeKey(EXPORT_JOB.columns, EXPORT_JOB.key, job)],
    );
    return rows;
  });
}

/** The `state` each changelog row of `job` recorded, oldest first. */
async function loggedStatesOf(db: TenantDb, job: ExportJobRow): Promise<unknown[]> {
  return (await changelogOf(db, job)).map((row) => decodeRow(EXPORT_JOB.columns, row.after).state);
}

/** Seeds a csv job of `definition` in `state` through `handle`, and returns its row. */
async function seedJobOf(handle: Pick<TestApp<TenantDb>, 'seed'>, definition: ExportDefinitionRow, state: JobState): Promise<ExportJobRow> {
  const job = jobFor(definition, { format: 'csv', state });
  // The catalogue types its table name as a plain string; it is one of the owned tables the seed accepts.
  await handle.seed(EXPORT_JOB.table as SeedTable, [job]);
  return job;
}

describe('export job transition table', () => {
  it('names the fixture states in lifecycle order and its two failure errors', () => {
    expect(JOB_STATES).toStrictEqual(['queued', 'running', 'done', 'failed']);
    expect(EXPORT_ERRORS).toStrictEqual(['source-unavailable', 'export-failed']);
  });

  it('declares exactly the three legal moves of usp_export_job_transition', () => {
    const declared = Object.entries(JOB_TRANSITIONS).flatMap(([from, targets]) => targets.map((to) => [from, to]));

    expect(declared).toStrictEqual(LEGAL_EDGES);
  });

  it.each(STATE_PAIRS)('answers $legal for $from → $to', ({ from, to, legal }) => {
    expect(isLegalTransition(from, to)).toBe(legal);
  });
});

// pgAvailable rejects when PG_HOST is unset, so the stored-row suites skip on that before probing the server.
const pgReady = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!pgReady)('export job moves against stored rows', () => {
  let handle: TestApp<TenantDb>;
  let repository: ReportingRepository;
  let definitions: SeededDefinitions;

  beforeAll(async () => {
    handle = await buildTestApp({ db: 'pg' });
    repository = createReportingRepository({ db: handle.db, storage: handle.storage, clock: handle.clock });
    definitions = await seedDefinitions(handle);
  });

  afterAll(async () => {
    await handle?.close();
  });

  /** Seeds a tenant-a csv timesheets job in `state`. */
  const seeded = (state: JobState): Promise<ExportJobRow> => seedJobOf(handle, definitions.A['timesheets.sheets'], state);

  /** Applies `input` in a gated tenant-a transaction. */
  const transition = (input: TransitionInput) => withGatedTenant(handle.db, TENANT_A.tenantId, (tx) => transitionJob(tx, repository, input));

  /** Asserts `job` has exactly one changelog row: a target update whose after image records `state`. */
  async function expectAuditedOnce(job: ExportJobRow, state: JobState): Promise<void> {
    const rows = await changelogOf(handle.db, job);
    expect(rows.map(({ op, origin }) => ({ op, origin }))).toStrictEqual([{ op: 'update', origin: 'target' }]);
    expect(await loggedStatesOf(handle.db, job)).toStrictEqual([state]);
  }

  it('moves a queued job to running, setting started_at to the clock time and leaving every other column as stored', async () => {
    const job = await seeded('queued');
    const now = TEST_CLOCK.now();

    const result = await transition({ jobId: job.job_id, to: 'running', now });

    const stored = await readJob(handle.db, job);
    expect(stored).toStrictEqual({ ...job, state: 'running', started_at: now, row_version: '2' });
    expect(stored?.finished_at).toBeNull();
    expect(result).toStrictEqual({ outcome: 'legal', state: 'running', job: stored });
    await expectAuditedOnce(job, 'running');
  });

  it('moves a running job to done, storing finished_at and the output fields exactly as passed and no error', async () => {
    const job = await seeded('running');
    const put = await handle.storage.put(EXPORT_BUCKET, firstClaimKey(job), Buffer.from('timesheet_id,status\r\n'), { contentType: 'text/csv' });
    const input = doneMove(job, FINISHED_AT, put.sha256);

    const result = await transition(input);

    const stored = await readJob(handle.db, job);
    expect(stored).toStrictEqual({
      ...job,
      state: 'done',
      finished_at: FINISHED_AT,
      error: null,
      file_name: input.fileName,
      content_type: input.contentType,
      object_key: input.objectKey,
      output_sha256: input.outputSha256,
      row_version: '3',
    });
    expect(result).toStrictEqual({ outcome: 'legal', state: 'done', job: stored });
    await expectAuditedOnce(job, 'done');
  });

  it.each(EXPORT_ERRORS)('moves a running job to failed with error %s, storing finished_at and no output fields', async (error) => {
    const job = await seeded('running');

    const result = await transition({ jobId: job.job_id, to: 'failed', now: FINISHED_AT, error });

    const stored = await readJob(handle.db, job);
    expect(stored).toStrictEqual({ ...job, state: 'failed', finished_at: FINISHED_AT, error, row_version: '3' });
    expect(stored).toMatchObject({ file_name: null, content_type: null, object_key: null, output_sha256: null });
    expect(result).toStrictEqual({ outcome: 'legal', state: 'failed', job: stored });
    await expectAuditedOnce(job, 'failed');
  });

  it.each(ILLEGAL_PAIRS)('answers illegal-state with the current state for $from → $to, changing no row and logging nothing', async ({ from, to }) => {
    const job = await seeded(from);
    const before = await readJob(handle.db, job);
    const logged = await changelogOf(handle.db, job);

    const result = await transition(moveOf(job, to, FINISHED_AT));

    expect(result).toStrictEqual({ outcome: 'illegal-state', state: from });
    expect(await readJob(handle.db, job)).toStrictEqual(before);
    expect(await changelogOf(handle.db, job)).toStrictEqual(logged);
  });

  it.each<JobState>(['running', 'done', 'failed'])('answers not-found with a null state for a move to %s of a job id no row holds', async (to) => {
    const absent = jobFor(definitions.A['timesheets.sheets'], { format: 'csv' });

    expect(await transition(moveOf(absent, to, FINISHED_AT))).toStrictEqual({ outcome: 'not-found', state: null });
    expect(await readJob(handle.db, absent)).toBeNull();
  });

  it.each<[JobState, string]>([
    ['queued', '3'],
    ['running', '4'],
  ])('fails a %s job of the broken source with source-unavailable through the runner, calling no producer and storing no object', async (from, finalVersion) => {
    const job = await seedJobOf(handle, definitions.A.broken, from);
    const deps: RunnerDeps = { db: handle.db, repository, storage: handle.storage, clock: handle.clock, client: handle.app.opt2.client };
    const calls = handle.client.requests.length;

    const result = await runExport(deps, { tenantId: job.tenant_id, jobId: job.job_id, payload: { jobId: job.job_id, asOf: TEST_AS_OF } });

    expect(result).toStrictEqual({ outcome: 'failed', state: 'failed', error: 'source-unavailable' });
    expect(handle.client.requests).toHaveLength(calls);
    expect(await readJob(handle.db, job)).toStrictEqual({
      ...job,
      state: 'failed',
      started_at: TEST_CLOCK.now(),
      finished_at: TEST_CLOCK.now(),
      error: 'source-unavailable',
      row_version: finalVersion,
    });
    // A queued job is claimed into running; a running one an interrupted delivery left is reclaimed in place.
    expect(await loggedStatesOf(handle.db, job)).toStrictEqual(['running', 'failed']);
    expect(await storedKeysOf(handle.storage, job)).toStrictEqual([]);
  });
});

describe.skipIf(!pgReady)('export runner with a rejecting writer', () => {
  afterEach(() => {
    vi.doUnmock('../../src/domain/writers/index.js');
    vi.resetModules();
  });

  it('fails a timesheets job whose writer rejects with export-failed after reading its source, storing no object', async () => {
    vi.resetModules();
    const renderExport = vi.fn().mockRejectedValue(new Error('writer'));
    vi.doMock('../../src/domain/writers/index.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/domain/writers/index.js')>()),
      renderExport,
    }));
    // Imported after the mock, so the app and runner are built against the rejecting writer.
    const helpers = await import('../helpers/app.js');
    const runner = await import('../../src/domain/run-export.js');
    const repo = await import('../../src/repo/repository.js');
    const handle = await helpers.buildTestApp({ db: 'pg' });
    try {
      const definitions = await seedDefinitions(handle);
      const job = await seedJobOf(handle, definitions.A['timesheets.sheets'], 'queued');
      const repository = repo.createReportingRepository({ db: handle.db, storage: handle.storage, clock: handle.clock });
      const deps: RunnerDeps = { db: handle.db, repository, storage: handle.storage, clock: handle.clock, client: handle.app.opt2.client };

      const result = await runner.runExport(deps, { tenantId: job.tenant_id, jobId: job.job_id, payload: { jobId: job.job_id, asOf: TEST_AS_OF } });

      expect(result).toStrictEqual({ outcome: 'failed', state: 'failed', error: 'export-failed' });
      expect(renderExport).toHaveBeenCalledOnce();
      expect(handle.client.requests.map((request) => `${request.service} ${request.path}`)).toContain(`timesheets ${helpers.SOURCE_PATHS.timesheets}`);
      expect(await readJob(handle.db, job)).toStrictEqual({
        ...job,
        state: 'failed',
        started_at: TEST_CLOCK.now(),
        finished_at: TEST_CLOCK.now(),
        error: 'export-failed',
        row_version: '3',
      });
      expect(await loggedStatesOf(handle.db, job)).toStrictEqual(['running', 'failed']);
      expect(await storedKeysOf(handle.storage, job)).toStrictEqual([]);
    } finally {
      await handle.close();
    }
  });
});
