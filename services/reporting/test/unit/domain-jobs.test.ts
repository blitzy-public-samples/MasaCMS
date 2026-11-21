// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job domain: errors, state moves, signed URLs and the export-job mapping, then create, read, list, output and transitions against a throwaway `reporting` schema. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError, cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { GateClosedError, GateRaceError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { SIGNED_URL_TTL_S, type BucketName, type ObjectHead, type SignedUrlOptions, type StoragePort } from '@opt2/platform/storage';
import { tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import type { EnqueueExportRun, ExportRunScheduled, ReportingDeps } from '../../src/domain/deps.js';
import {
  EXPORT_ERRORS,
  JOB_STATES,
  isLegalTransition,
  transitionJob,
  type JobState,
  type TransitionInput,
  type TransitionOutcome,
} from '../../src/domain/job-state.js';
import {
  ReportingDomainError,
  UNSCHEDULED_RECOVERY_AGE_MS,
  createExportJob,
  getExportJob,
  listExportJobs,
  openExportOutput,
  signedExportUrl,
  type CreateExportInput,
  type ReadyExportOutput,
  type ReportingDomainErrorType,
} from '../../src/domain/jobs.js';
import { exportJobMapping } from '../../src/migration/mappings/export-job.js';
import { createReportingRepository, type ReportingRepository } from '../../src/repo/repository.js';
import { EXPORT_BUCKET, EXPORT_JOB, OUTPUT_SLOTS, UNITS, exportAttemptKey, exportObjectKey, type ExportJobRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const RUN_AT = new Date(2026, 5, 30, 10, 1, 0, 0);
const DONE_AT = new Date(2026, 5, 30, 10, 2, 30, 0);
const CLOCK = fixedClock(NOW);
const REQUESTER = '1B2C3D4E-5F60-7182-93A4B5C6D7E8F90A';
const JOB_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const DEFINITION_ID = '2C3D4E5F-6071-8293-A4B5C6D7E8F90A1B';
// A stored id holding hex letters, so its lower- and mixed-case spellings differ from it.
const FOLDED_DEFINITION_ID = '26856349-A11B-D451-4A71F7EE11B3F662';
const OUTPUT = Buffer.from('Title,Amount\r\nTravel,10.5000\r\n');
const LEGAL_MOVES = new Set(['queued>running', 'running>done', 'running>failed']);
const TARGET_STATES = ['running', 'done', 'failed'] as const;
// Long enough for a create's checks and insert, short enough that failing its job waits the budget out on a closed gate.
const FAIL_BUDGET_MS = 1000;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface SignedCall {
  bucket: BucketName;
  key: string;
  opts: SignedUrlOptions | undefined;
}

/** In-memory storage port; `signedUrl` records its calls and answers `https://storage.test/<bucket>/<key>`. */
function memoryStorage(): StoragePort & { objects: Map<string, ObjectHead>; signed: SignedCall[] } {
  const objects = new Map<string, ObjectHead>();
  const signed: SignedCall[] = [];
  const unused = (): never => {
    throw new Error('not used by the export-job domain');
  };
  return {
    kind: 'local',
    objects,
    signed,
    put: (_bucket, key, body, opts) => {
      const bytes = Buffer.from(body as Buffer);
      objects.set(key, { size: bytes.length, sha256: sha256(bytes), contentType: opts.contentType });
      return Promise.resolve({ size: bytes.length, sha256: sha256(bytes) });
    },
    head: (_bucket, key) => Promise.resolve(objects.get(key) ?? null),
    delete: (_bucket, key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    signedUrl: (bucket, key, opts) => {
      signed.push({ bucket, key, opts });
      return Promise.resolve(`https://storage.test/${bucket}/${key}`);
    },
    get: unused,
    stream: unused,
    open: unused,
  };
}

/** The transition of job `jobId` to `to` at `now`; a done move names the job's csv runner key holding OUTPUT. */
function moveTo(to: TransitionInput['to'], tenantId: string, jobId: string, now: Date): TransitionInput {
  switch (to) {
    case 'running':
      return { jobId, to, now };
    case 'done':
      return {
        jobId,
        to,
        now,
        fileName: `export-${jobId}.csv`,
        contentType: 'text/csv',
        objectKey: exportObjectKey(tenantId, jobId, 'csv'),
        outputSha256: sha256(OUTPUT),
      };
    case 'failed':
      return { jobId, to, now, error: 'export-failed' };
  }
}

describe('reporting domain errors', () => {
  it.each<[ReportingDomainErrorType, string]>([
    ['notFound', 'Not Found'],
    ['invalidParameters', 'Invalid parameters'],
    ['conflict', 'Conflict'],
  ])('raises %s with the envelope default message %j', (type, message) => {
    const error = new ReportingDomainError(type);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'ReportingDomainError', type, message });
  });

  it('keeps a message it is given', () => {
    expect(new ReportingDomainError('conflict', 'not-ready')).toMatchObject({ type: 'conflict', message: 'not-ready' });
  });
});

describe('export job state moves', () => {
  it('lists the states in lifecycle order', () => {
    expect(JOB_STATES).toEqual(['queued', 'running', 'done', 'failed']);
  });

  it.each(JOB_STATES.flatMap((from) => JOB_STATES.map((to) => [from, to, LEGAL_MOVES.has(`${from}>${to}`)] as const)))(
    'allows %s -> %s: %s',
    (from, to, legal) => {
      expect(isLegalTransition(from, to)).toBe(legal);
    },
  );
});

describe('signed export URL', () => {
  const job: ExportJobRow = {
    tenant_id: tenantIdForSite('tenant-a'),
    job_id: JOB_ID,
    siteid: 'tenant-a',
    definition_id: DEFINITION_ID,
    format: 'csv',
    state: 'done',
    requested_by_id: REQUESTER,
    created: NOW,
    started_at: RUN_AT,
    finished_at: DONE_AT,
    error: null,
    file_name: null,
    content_type: 'text/csv',
    object_key: exportObjectKey(tenantIdForSite('tenant-a'), JOB_ID, 'csv'),
    output_sha256: sha256(OUTPUT),
    row_version: '3',
  };

  it.each([
    ['export.csv', 'attachment; filename="export.csv"'],
    ['a "b" \\ c.csv', 'attachment; filename="a \\"b\\" \\\\ c.csv"'],
    ['', 'attachment; filename=""'],
  ])('signs file name %j for the signed-URL lifetime with disposition %s', async (fileName, disposition) => {
    const storage = memoryStorage();
    const ready: ReadyExportOutput = {
      outcome: 'ready',
      job,
      bucket: EXPORT_BUCKET,
      objectKey: job.object_key ?? '',
      fileName,
      contentType: 'text/csv',
      sha256: sha256(OUTPUT),
    };

    const signed = await signedExportUrl({ storage, clock: CLOCK }, ready);

    expect(signed).toEqual({
      url: `https://storage.test/${EXPORT_BUCKET}/${ready.objectKey}`,
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    });
    expect(storage.signed).toEqual([{ bucket: EXPORT_BUCKET, key: ready.objectKey, opts: { expiresS: SIGNED_URL_TTL_S, disposition } }]);
  });
});

describe('export-job mapping', () => {
  const legacyRow = {
    job_id: JOB_ID,
    siteID: 'tenant-a',
    definition_id: DEFINITION_ID,
    format: 'csv',
    state: 'done',
    requested_by_id: REQUESTER,
    created: '2026-06-30 10:00:00.000',
    started_at: '2026-06-30 10:01:00.000',
    finished_at: '2026-06-30 10:02:30.500',
    error: null,
    file_name: 'export.csv',
    content_type: 'text/csv',
    output_sha256: sha256(OUTPUT),
  };
  const targetRow = {
    job_id: JOB_ID,
    siteid: 'tenant-a',
    definition_id: DEFINITION_ID,
    format: 'csv',
    state: 'done',
    requested_by_id: REQUESTER,
    created: '2026-06-30 10:00:00.000',
    started_at: '2026-06-30 10:01:00.000',
    finished_at: '2026-06-30 10:02:30.500',
    error: null,
    file_name: 'export.csv',
    content_type: 'text/csv',
    output_sha256: sha256(OUTPUT),
  };

  it('maps synthetic.export_job onto reporting.export_job by job_id, tenant from siteID, without object_key or output columns', () => {
    expect(Object.isFrozen(exportJobMapping)).toBe(true);
    expect(exportJobMapping).toMatchObject({
      legacyTable: 'synthetic.export_job',
      targetTable: EXPORT_JOB.unit,
      unit: EXPORT_JOB.unit,
      key: ['job_id'],
      tenant: { kind: 'site', column: 'siteID' },
    });
    expect(exportJobMapping.columns.map((column) => column.target)).toEqual(
      EXPORT_JOB.columns.map((column) => column.name).filter((name) => !['tenant_id', 'object_key', 'row_version'].includes(name)),
    );
  });

  it('leaves output off a legacy row that has none', () => {
    const row = exportJobMapping.toTarget(legacyRow);
    expect(row).toEqual(targetRow);
    expect(row).not.toHaveProperty('output');
  });

  it.each<[string, Buffer | null]>([
    ['output', OUTPUT],
    ['OUTPUT', OUTPUT],
    ['Output', null],
  ])('carries legacy column %s under output as %j', (name, output) => {
    expect(exportJobMapping.toTarget({ ...legacyRow, [name]: output })).toEqual({ ...targetRow, output });
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('export jobs against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let storage: ReturnType<typeof memoryStorage>;
  let repository: ReportingRepository;
  let sites = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'reporting', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'domain-jobs-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'domain-jobs-test', state: 'open' });
    storage = memoryStorage();
    repository = createReportingRepository({ db: handle.app, storage, clock: CLOCK });
  });

  afterAll(async () => {
    await handle.drop();
  });

  /** A create request for a csv job of a new site's only definition, stored as `definitionId`. */
  async function siteWithDefinition(definitionId = cfUuid()): Promise<CreateExportInput> {
    sites += 1;
    const siteId = `domain-jobs-${String(sites)}`;
    const tenantId = tenantIdForSite(siteId);
    await handle.app.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.export_definition (tenant_id, definition_id, siteid, name, source, columns)
         VALUES ($1, $2, $3, 'Sheets', 'timesheets.sheets', '["timesheet_id","status"]')`,
        [tenantId, definitionId, siteId],
      ),
    );
    return { tenantId, siteId, definitionId, format: 'csv', requestedById: REQUESTER, params: {} };
  }

  /** Inserts a csv job of `input`'s definition past the repository, `row` overriding a queued job of `input`'s site created at NOW. */
  async function storeJob(input: CreateExportInput, row: Partial<ExportJobRow> = {}): Promise<ExportJobRow> {
    const job = {
      job_id: cfUuid(),
      siteid: input.siteId,
      state: 'queued',
      created: NOW,
      file_name: null,
      content_type: null,
      object_key: null,
      output_sha256: null,
      ...row,
    };
    return handle.app.withTenant(input.tenantId, async (tx) => {
      const { rows } = await tx.query<ExportJobRow>(
        `INSERT INTO ${handle.schema}.export_job
           (tenant_id, job_id, siteid, definition_id, format, state, requested_by_id, created, file_name, content_type, object_key, output_sha256)
         VALUES ($1, $2, $3, $4, 'csv', $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          input.tenantId,
          job.job_id,
          job.siteid,
          input.definitionId,
          job.state,
          REQUESTER,
          job.created,
          job.file_name,
          job.content_type,
          job.object_key,
          job.output_sha256,
        ],
      );
      return rows[0] as ExportJobRow;
    });
  }

  /** Create deps over the throwaway schema; the default probe reports every run task live. */
  function depsWith(
    enqueue: EnqueueExportRun,
    clock = CLOCK,
    runScheduled: ExportRunScheduled = () => Promise.resolve(true),
  ): Pick<ReportingDeps, 'db' | 'repository' | 'storage' | 'clock' | 'enqueue' | 'runScheduled'> {
    return { db: handle.app, repository, storage, clock, enqueue, runScheduled };
  }

  /** A probe reporting the run tasks of `live` jobs live, recording the jobs it is asked about in order. */
  function probeOf(live: readonly string[]): { runScheduled: ExportRunScheduled; probed: Parameters<ExportRunScheduled>[0][] } {
    const probed: Parameters<ExportRunScheduled>[0][] = [];
    return {
      probed,
      runScheduled: (input) => {
        probed.push(input);
        return Promise.resolve(live.includes(input.jobId));
      },
    };
  }

  function recordingEnqueue(): { enqueue: EnqueueExportRun; runs: Parameters<EnqueueExportRun>[0][] } {
    const runs: Parameters<EnqueueExportRun>[0][] = [];
    return {
      runs,
      enqueue: (run) => {
        runs.push(run);
        return Promise.resolve();
      },
    };
  }

  const read = (tenantId: string, jobId: string): Promise<ExportJobRow | null> => getExportJob({ db: handle.app }, { tenantId, jobId });

  const jobsOf = (input: CreateExportInput): Promise<ExportJobRow[]> =>
    listExportJobs({ db: handle.app }, { tenantId: input.tenantId, paging: { pageIndex: 1, itemsPerPage: 100 } }).then((page) => page.rows);

  const transition = (tenantId: string, input: TransitionInput): Promise<TransitionOutcome> =>
    withGatedTenant(handle.app, tenantId, (tx) => transitionJob(tx, repository, input));

  describe('createExportJob', () => {
    it('stores a queued job with every run column null and schedules its run once the row is visible to another connection', async () => {
      const input = await siteWithDefinition();
      const runs: Parameters<EnqueueExportRun>[0][] = [];
      const visible: (ExportJobRow | null)[] = [];
      const enqueue: EnqueueExportRun = async (run) => {
        runs.push(run);
        visible.push(await read(run.tenantId, run.jobId));
      };

      const job = await createExportJob(depsWith(enqueue), input);

      expect(isCfUuid(job.job_id)).toBe(true);
      expect(job).toEqual({
        tenant_id: input.tenantId,
        job_id: job.job_id,
        siteid: input.siteId,
        definition_id: input.definitionId,
        format: 'csv',
        state: 'queued',
        requested_by_id: REQUESTER,
        created: NOW,
        started_at: null,
        finished_at: null,
        error: null,
        file_name: null,
        content_type: null,
        object_key: null,
        output_sha256: null,
        row_version: '1',
      });
      expect(runs).toStrictEqual([
        { tenantId: input.tenantId, jobId: job.job_id, payload: { jobId: job.job_id, asOf: '2026-06-30' } },
      ]);
      expect(visible).toEqual([job]);
      expect(await read(input.tenantId, job.job_id)).toEqual(job);
    });

    it.each<[string, Partial<CreateExportInput>, string]>([
      ['an absent asOf', { params: {} }, '2026-06-30'],
      ['a null asOf', { params: { asOf: null } }, '2026-06-30'],
      ['a leap day', { params: { asOf: '2024-02-29' } }, '2024-02-29'],
      ['the SQL Server datetime floor', { params: { asOf: '1753-01-01' } }, '1753-01-01'],
      ['a 30-day month end', { params: { asOf: '2026-04-30' } }, '2026-04-30'],
      ['format xlsx', { format: 'xlsx' }, '2026-06-30'],
      ['format pdf', { format: 'pdf' }, '2026-06-30'],
    ])('queues a job for %s and schedules its run as of %s', async (_case, overrides, asOf) => {
      const input = { ...(await siteWithDefinition()), ...overrides };
      const { enqueue, runs } = recordingEnqueue();

      const job = await createExportJob(depsWith(enqueue), input);

      expect(job).toMatchObject({ state: 'queued', format: input.format });
      expect(runs.map((run) => run.payload)).toStrictEqual([{ jobId: job.job_id, asOf }]);
    });

    it.each<[string, string]>([
      ['in lower case', '26856349-a11b-d451-4a71f7ee11b3f662'],
      ['in mixed case', '26856349-a11B-D451-4a71F7ee11b3F662'],
      ['with trailing spaces', '26856349-A11B-D451-4A71F7EE11B3F662   '],
      ['in lower case with a trailing space', '26856349-a11b-d451-4a71f7ee11b3f662 '],
    ])('queues a job of the stored definition named %s, as SQL Server matches char(35)', async (_case, definitionId) => {
      const input = await siteWithDefinition(FOLDED_DEFINITION_ID);
      const { enqueue, runs } = recordingEnqueue();

      const job = await createExportJob(depsWith(enqueue), { ...input, definitionId });

      expect(job).toMatchObject({ state: 'queued', definition_id: FOLDED_DEFINITION_ID });
      expect(await jobsOf(input)).toEqual([job]);
      expect(runs.map((run) => run.payload)).toStrictEqual([{ jobId: job.job_id, asOf: '2026-06-30' }]);
    });

    it.each<[string, Partial<CreateExportInput>]>([
      ['format docx', { format: 'docx' }],
      ['format CSV', { format: 'CSV' }],
      ['an empty format', { format: '' }],
      ['a numeric asOf', { params: { asOf: 20260630 } }],
      ['a boolean asOf', { params: { asOf: true } }],
      ['an empty asOf', { params: { asOf: '' } }],
      ['an unpadded asOf', { params: { asOf: '2026-6-30' } }],
      ['an asOf with a time', { params: { asOf: '2026-06-30T00:00:00' } }],
      ['an asOf with a leading space', { params: { asOf: ' 2026-06-30' } }],
      ['an asOf before 1753', { params: { asOf: '1752-12-31' } }],
      ['month 00', { params: { asOf: '2026-00-10' } }],
      ['month 13', { params: { asOf: '2026-13-01' } }],
      ['day 00', { params: { asOf: '2026-01-00' } }],
      ['April 31', { params: { asOf: '2026-04-31' } }],
      ['February 29 of a common year', { params: { asOf: '2026-02-29' } }],
    ])('refuses %s with invalidParameters and stores and schedules nothing', async (_case, overrides) => {
      const input = { ...(await siteWithDefinition()), ...overrides };
      const { enqueue, runs } = recordingEnqueue();

      await expect(createExportJob(depsWith(enqueue), input)).rejects.toEqual(new ReportingDomainError('invalidParameters'));

      expect(await jobsOf(input)).toEqual([]);
      expect(runs).toEqual([]);
    });

    it.each<[string, (input: CreateExportInput, other: CreateExportInput) => CreateExportInput]>([
      ['an unknown definition', (input) => ({ ...input, definitionId: cfUuid() })],
      ['an unknown definition in lower case', (input) => ({ ...input, definitionId: cfUuid().toLowerCase() })],
      ['a definition with a leading space', (input) => ({ ...input, definitionId: ` ${input.definitionId}` })],
      ["another site's definition", (input, other) => ({ ...input, definitionId: other.definitionId })],
      ["another site's definition in lower case", (input, other) => ({ ...input, definitionId: other.definitionId.toLowerCase() })],
      ['an unknown definition before a bad format and asOf', (input) => ({ ...input, definitionId: cfUuid(), format: 'docx', params: { asOf: 'x' } })],
    ])('refuses %s with notFound and stores and schedules nothing', async (_case, request) => {
      const input = await siteWithDefinition();
      const other = await siteWithDefinition();
      const { enqueue, runs } = recordingEnqueue();

      const failure: unknown = await createExportJob(depsWith(enqueue), request(input, other)).catch((thrown: unknown) => thrown);

      expect(failure).toBeInstanceOf(ReportingDomainError);
      expect(failure).toMatchObject({ type: 'notFound', message: 'Not Found' });
      expect(await jobsOf(input)).toEqual([]);
      expect(await jobsOf(other)).toEqual([]);
      expect(runs).toEqual([]);
    });

    /** The one job of `input`, which a create whose run could not be scheduled commits failed with export-failed through running. */
    async function expectUnscheduledJob(input: CreateExportInput): Promise<ExportJobRow> {
      const jobs = await jobsOf(input);
      expect(jobs).toHaveLength(1);
      const [job] = jobs as [ExportJobRow];
      expect(job).toMatchObject({ state: 'failed', error: 'export-failed', started_at: NOW, finished_at: NOW, row_version: '3' });
      return job;
    }

    it('commits the job as failed with export-failed and raises the legacy 503 caused by the failure when its run cannot be scheduled', async () => {
      const input = await siteWithDefinition();
      const original = new Error('ECONNREFUSED');

      const failure: unknown = await createExportJob(
        depsWith(() => Promise.reject(original)),
        input,
      ).catch((thrown: unknown) => thrown);

      const job = await expectUnscheduledJob(input);
      expect(failure).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(failure).toMatchObject({
        message: `Export job ${job.job_id} run could not be scheduled`,
        surface: 'auto',
        reason: 'export-run-unscheduled',
        cause: original,
      });
    });

    it('commits the job as failed with export-failed and rethrows a legacy 503 from scheduling unchanged', async () => {
      const input = await siteWithDefinition();
      const original = new LegacyServiceUnavailableError('Unit gate closed', 'auto', 'tasks-unavailable');

      await expect(createExportJob(depsWith(() => Promise.reject(original)), input)).rejects.toBe(original);

      await expectUnscheduledJob(input);
    });

    it('raises the gate 503 when a closed gate stops failing an unscheduled job, which a later create fails past the recovery age', async () => {
      const input = await siteWithDefinition();
      const holderId = `window-${cfUuid()}`;
      const refuse: EnqueueExportRun = async () => {
        await closeGates(handle.app, { units: [EXPORT_JOB.unit], holderId });
        throw new Error('ECONNREFUSED');
      };

      const failure: unknown = await withGatedTenant(handle.app, input.tenantId, () => createExportJob(depsWith(refuse), input), {
        budgetMs: FAIL_BUDGET_MS,
      }).catch((thrown: unknown) => thrown);
      await openGates(handle.app, { units: [EXPORT_JOB.unit], holderId, state: 'open' });

      expect(failure).toBeInstanceOf(GateClosedError);
      const jobs = await jobsOf(input);
      expect(jobs).toHaveLength(1);
      const [stranded] = jobs as [ExportJobRow];
      expect(stranded).toMatchObject({ state: 'queued', created: NOW, row_version: '1' });

      const later = new Date(NOW.getTime() + UNSCHEDULED_RECOVERY_AGE_MS + 1);
      await createExportJob(depsWith(recordingEnqueue().enqueue, fixedClock(later), probeOf([]).runScheduled), input);

      expect(await read(input.tenantId, stranded.job_id)).toMatchObject({ state: 'failed', error: 'export-failed', finished_at: later });
    });

    it('re-runs an insert transaction a gate race rolled back at its end and schedules only the committed job, once', async () => {
      const input = await siteWithDefinition();
      const live = await storeJob(input, { state: 'running' });
      const { enqueue, runs } = recordingEnqueue();
      const { runScheduled, probed } = probeOf([live.job_id]);
      const inserting = new WeakSet<TenantTx>();
      let attempts = 0;
      const racing: ReportingRepository = {
        ...repository,
        insertJob: async (tx, row, ctx) => {
          attempts += 1;
          inserting.add(tx);
          return repository.insertJob(tx, row, ctx);
        },
      };
      // The first transaction that inserts a job meets a gate race once its callback has finished, as a close at that moment would.
      const db: TenantDb = {
        ...handle.app,
        withTenant: (tenantId, fn) =>
          handle.app.withTenant(tenantId, async (tx) => {
            const result = await fn(tx);
            if (attempts === 1 && inserting.has(tx)) throw new GateRaceError([EXPORT_JOB.unit]);
            return result;
          }),
      };

      const job = await createExportJob({ ...depsWith(enqueue, CLOCK, runScheduled), db, repository: racing }, input);

      expect(attempts).toBe(2);
      expect(runs).toStrictEqual([
        { tenantId: input.tenantId, jobId: job.job_id, payload: { jobId: job.job_id, asOf: '2026-06-30' } },
      ]);
      expect(probed).toStrictEqual([{ tenantId: input.tenantId, jobId: live.job_id }]);
      expect((await jobsOf(input)).map((row) => row.job_id).sort()).toEqual([live.job_id, job.job_id].sort());
      expect(await read(input.tenantId, job.job_id)).toEqual(job);
    });

    it("fails, in created then id order, only the site's running jobs whose run task is gone and its old queued ones, before queuing the new job", async () => {
      const input = await siteWithDefinition();
      const other = await siteWithDefinition();
      const at = (minute: number): Date => new Date(2026, 5, 29, 9, minute, 0, 0);
      const [laterId, earlierId] = [cfUuid(), cfUuid()].sort().reverse() as [string, string];
      const orphanRunning = await storeJob(input, { state: 'running', created: at(1) });
      const orphanLater = await storeJob(input, { job_id: laterId, created: at(2) });
      const orphanEarlier = await storeJob(input, { job_id: earlierId, created: at(2), siteid: input.siteId.toUpperCase() });
      const live = await storeJob(input, { state: 'running', created: at(0) });
      const done = await storeJob(input, { state: 'done', created: at(3) });
      const failed = await storeJob(input, { state: 'failed', created: at(3) });
      const young = await storeJob(input, { created: RUN_AT });
      const otherOrphan = await storeJob(other, { created: at(0) });
      const { runScheduled, probed } = probeOf([live.job_id]);
      const { enqueue } = recordingEnqueue();

      const job = await createExportJob(depsWith(enqueue, fixedClock(RUN_AT), runScheduled), input);

      expect(probed).toStrictEqual(
        [live, orphanRunning, orphanEarlier, orphanLater].map(({ job_id }) => ({ tenantId: input.tenantId, jobId: job_id })),
      );
      expect(await read(input.tenantId, orphanRunning.job_id)).toEqual({
        ...orphanRunning,
        state: 'failed',
        error: 'export-failed',
        finished_at: RUN_AT,
        row_version: String(BigInt(orphanRunning.row_version) + 1n),
      });
      for (const orphan of [orphanEarlier, orphanLater]) {
        expect(await read(input.tenantId, orphan.job_id)).toEqual({
          ...orphan,
          state: 'failed',
          error: 'export-failed',
          started_at: RUN_AT,
          finished_at: RUN_AT,
          row_version: String(BigInt(orphan.row_version) + 2n),
        });
      }
      for (const kept of [live, done, failed, young]) expect(await read(input.tenantId, kept.job_id)).toEqual(kept);
      expect(await read(other.tenantId, otherOrphan.job_id)).toEqual(otherOrphan);
      expect(job).toMatchObject({ state: 'queued', created: RUN_AT });
    });

    it.each<[JobState, number, JobState]>([
      ['running', 0, 'failed'],
      ['queued', UNSCHEDULED_RECOVERY_AGE_MS + 1, 'failed'],
      ['queued', UNSCHEDULED_RECOVERY_AGE_MS, 'queued'],
      ['queued', 0, 'queued'],
    ])('leaves a %s job created %i ms before a create, with no run task, %s', async (state, ageMs, after) => {
      const input = await siteWithDefinition();
      const job = await storeJob(input, { state, created: new Date(RUN_AT.getTime() - ageMs) });

      await createExportJob(depsWith(recordingEnqueue().enqueue, fixedClock(RUN_AT), probeOf([]).runScheduled), input);

      expect(await read(input.tenantId, job.job_id)).toMatchObject({ state: after });
    });

    it("deletes the output slots and claim output of a running job it fails and keeps a live one's", async () => {
      const input = await siteWithDefinition();
      const claimed = async (): Promise<ExportJobRow> => {
        const running = await transition(input.tenantId, moveTo('running', input.tenantId, (await storeJob(input)).job_id, RUN_AT));
        if (running.outcome !== 'legal') throw new Error(`claim refused as ${running.outcome}`);
        return running.job;
      };
      const [orphan, live] = [await claimed(), await claimed()];
      const outputKeys = (job: ExportJobRow): string[] => [
        ...OUTPUT_SLOTS.map((slot) => exportObjectKey(input.tenantId, job.job_id, 'csv', slot)),
        exportAttemptKey(input.tenantId, job.job_id, 'csv', job.row_version),
      ];
      for (const key of [...outputKeys(orphan), ...outputKeys(live)]) await storage.put(EXPORT_BUCKET, key, OUTPUT, { contentType: 'text/csv' });

      await createExportJob(depsWith(recordingEnqueue().enqueue, CLOCK, probeOf([live.job_id]).runScheduled), input);

      expect(await read(input.tenantId, orphan.job_id)).toMatchObject({ state: 'failed', error: 'export-failed' });
      expect(outputKeys(orphan).map((key) => storage.objects.has(key))).toEqual([false, false, false]);
      expect(outputKeys(live).map((key) => storage.objects.has(key))).toEqual([true, true, true]);
    });

    it.each<[string, ReportingDomainErrorType, (input: CreateExportInput) => CreateExportInput]>([
      ['an unknown definition', 'notFound', (input) => ({ ...input, definitionId: cfUuid() })],
      ['a bad format', 'invalidParameters', (input) => ({ ...input, format: 'docx' })],
      ['a bad asOf', 'invalidParameters', (input) => ({ ...input, params: { asOf: '2026-02-30' } })],
    ])('recovers nothing on a request refused for %s', async (_case, type, request) => {
      const input = await siteWithDefinition();
      const orphan = await storeJob(input, { state: 'running' });
      const { runScheduled, probed } = probeOf([]);

      await expect(createExportJob(depsWith(recordingEnqueue().enqueue, CLOCK, runScheduled), request(input))).rejects.toMatchObject({ type });

      expect(probed).toStrictEqual([]);
      expect(await jobsOf(input)).toEqual([orphan]);
    });

    it('raises the legacy 503 and stores nothing when a run task cannot be looked up', async () => {
      const input = await siteWithDefinition();
      const orphan = await storeJob(input, { state: 'running' });
      const original = new LegacyServiceUnavailableError('Task queue reporting-export-run unavailable', 'auto', 'tasks-unavailable');
      const { enqueue, runs } = recordingEnqueue();

      await expect(createExportJob(depsWith(enqueue, CLOCK, () => Promise.reject(original)), input)).rejects.toBe(original);

      expect(await jobsOf(input)).toEqual([orphan]);
      expect(runs).toEqual([]);
    });
  });

  describe('reads', () => {
    it("reads a job of the caller's tenant and null for another tenant's or an unknown job", async () => {
      const input = await siteWithDefinition();
      const other = await siteWithDefinition();
      const job = await createExportJob(depsWith(recordingEnqueue().enqueue), input);

      expect(await read(input.tenantId, job.job_id)).toEqual(job);
      expect(await read(other.tenantId, job.job_id)).toBeNull();
      expect(await read(input.tenantId, cfUuid())).toBeNull();
    });

    it('lists the tenant jobs by created, then id, with the total, and an empty page past the end', async () => {
      const input = await siteWithDefinition();
      const { enqueue } = recordingEnqueue();
      const created: ExportJobRow[] = [];
      for (const at of [RUN_AT, NOW, NOW]) created.push(await createExportJob(depsWith(enqueue, fixedClock(at)), input));
      const [later, ...earlier] = created as [ExportJobRow, ExportJobRow, ExportJobRow];
      const order = [...earlier.map((job) => job.job_id).sort(), later.job_id];

      const page = (pageIndex: number) => listExportJobs({ db: handle.app }, { tenantId: input.tenantId, paging: { pageIndex, itemsPerPage: 2 } });

      const [first, second, past] = await Promise.all([page(1), page(2), page(3)]);
      expect(first).toMatchObject({ pageIndex: 1, itemsPerPage: 2, total: 3 });
      expect(second).toMatchObject({ pageIndex: 2, itemsPerPage: 2, total: 3 });
      expect([...first.rows, ...second.rows].map((job) => job.job_id)).toEqual(order);
      expect(past).toEqual({ pageIndex: 3, itemsPerPage: 2, total: 3, rows: [] });
    });
  });

  describe('openExportOutput', () => {
    it("answers not-found for an unknown job and another tenant's job", async () => {
      const input = await siteWithDefinition();
      const other = await siteWithDefinition();
      const job = await storeJob(other, { state: 'done', object_key: 'k', output_sha256: sha256(OUTPUT) });

      expect(await openExportOutput({ db: handle.app }, { tenantId: input.tenantId, jobId: cfUuid() })).toEqual({ outcome: 'not-found' });
      expect(await openExportOutput({ db: handle.app }, { tenantId: input.tenantId, jobId: job.job_id })).toEqual({ outcome: 'not-found' });
    });

    it.each<JobState>(['queued', 'running', 'failed'])('answers not-ready with the state of a %s job', async (state) => {
      const input = await siteWithDefinition();
      const job = await storeJob(input, { state });

      expect(await openExportOutput({ db: handle.app }, { tenantId: input.tenantId, jobId: job.job_id })).toEqual({ outcome: 'not-ready', state });
    });

    it.each<[string, Partial<ExportJobRow>, string, string]>([
      ['its stored file name and content type', { file_name: 'export.csv', content_type: 'text/csv' }, 'export.csv', 'text/csv'],
      ['empty strings for NULL file name and content type', {}, '', ''],
    ])('answers ready for a done job with %s', async (_case, row, fileName, contentType) => {
      const input = await siteWithDefinition();
      const objectKey = exportObjectKey(input.tenantId, cfUuid(), 'csv');
      const job = await storeJob(input, { ...row, state: 'done', object_key: objectKey, output_sha256: sha256(OUTPUT) });

      expect(await openExportOutput({ db: handle.app }, { tenantId: input.tenantId, jobId: job.job_id })).toEqual({
        outcome: 'ready',
        job,
        bucket: EXPORT_BUCKET,
        objectKey,
        fileName,
        contentType,
        sha256: sha256(OUTPUT),
      });
    });

    it.each<[string, Partial<ExportJobRow>]>([
      ['no object_key', { object_key: null, output_sha256: sha256(OUTPUT) }],
      ['no output_sha256', { object_key: 'k', output_sha256: null }],
    ])('raises server_error for a done job storing %s', async (_case, row) => {
      const input = await siteWithDefinition();
      const job = await storeJob(input, { ...row, state: 'done', file_name: 'export.csv', content_type: 'text/csv' });

      const failure: unknown = await openExportOutput({ db: handle.app }, { tenantId: input.tenantId, jobId: job.job_id }).catch(
        (thrown: unknown) => thrown,
      );

      expect(failure).toBeInstanceOf(LegacyApiError);
      expect(failure).toMatchObject({ type: 'server_error' });
    });
  });

  describe('transitionJob', () => {
    it('runs, then finishes a job with its stored output, bumping row_version, and signs its download', async () => {
      const input = await siteWithDefinition();
      const queued = await createExportJob(depsWith(recordingEnqueue().enqueue), input);

      const running = await transition(input.tenantId, moveTo('running', input.tenantId, queued.job_id, RUN_AT));
      expect(running).toEqual({ outcome: 'legal', state: 'running', job: { ...queued, state: 'running', started_at: RUN_AT, row_version: '2' } });

      const done = moveTo('done', input.tenantId, queued.job_id, DONE_AT) as Extract<TransitionInput, { to: 'done' }>;
      await storage.put(EXPORT_BUCKET, done.objectKey, OUTPUT, { contentType: 'text/csv' });
      expect(await transition(input.tenantId, done)).toEqual({
        outcome: 'legal',
        state: 'done',
        job: {
          ...queued,
          state: 'done',
          started_at: RUN_AT,
          finished_at: DONE_AT,
          file_name: done.fileName,
          content_type: done.contentType,
          object_key: done.objectKey,
          output_sha256: done.outputSha256,
          row_version: '3',
        },
      });

      const output = await openExportOutput({ db: handle.app }, { tenantId: input.tenantId, jobId: queued.job_id });
      if (output.outcome !== 'ready') throw new Error(`expected a ready output, got ${output.outcome}`);
      expect(output).toMatchObject({ objectKey: done.objectKey, fileName: done.fileName, contentType: 'text/csv', sha256: sha256(OUTPUT) });
      expect(await signedExportUrl({ storage, clock: CLOCK }, output)).toEqual({
        url: `https://storage.test/${EXPORT_BUCKET}/${done.objectKey}`,
        expiresAt: new Date(NOW.getTime() + SIGNED_URL_TTL_S * 1000).toISOString(),
      });
      expect(storage.objects.has(done.objectKey)).toBe(true);
    });

    it.each(EXPORT_ERRORS)('fails a running job with error %s', async (error) => {
      const input = await siteWithDefinition();
      const job = await storeJob(input, { state: 'running' });

      const outcome = await transition(input.tenantId, { jobId: job.job_id, to: 'failed', now: DONE_AT, error });

      expect(outcome).toEqual({
        outcome: 'legal',
        state: 'failed',
        job: { ...job, state: 'failed', finished_at: DONE_AT, error, row_version: String(BigInt(job.row_version) + 1n) },
      });
    });

    it.each(JOB_STATES.flatMap((from) => TARGET_STATES.filter((to) => !LEGAL_MOVES.has(`${from}>${to}`)).map((to) => [from, to] as const)))(
      'refuses %s -> %s as illegal-state and leaves the job unchanged',
      async (from, to) => {
        const input = await siteWithDefinition();
        const job = await storeJob(input, { state: from });

        expect(await transition(input.tenantId, moveTo(to, input.tenantId, job.job_id, DONE_AT))).toEqual({ outcome: 'illegal-state', state: from });
        expect(await read(input.tenantId, job.job_id)).toEqual(job);
      },
    );

    it('answers not-found for an unknown job', async () => {
      const input = await siteWithDefinition();

      expect(await transition(input.tenantId, moveTo('running', input.tenantId, cfUuid(), RUN_AT))).toEqual({ outcome: 'not-found', state: null });
    });
  });
});
