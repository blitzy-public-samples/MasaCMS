// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting repository against a throwaway `reporting` schema: job writes with their changelog rows, gates, RLS and the export-output step of migration applies. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RepositoryError,
  UnitNotAuthoritativeError,
  closeGates,
  ensureUnitGates,
  openGates,
  type MigrationHandlerOptions,
  type RepositoryRow,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { BucketName, PutOptions, PutResult, StoragePort } from '@opt2/platform/storage';
import { tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createReportingRepository, type NewExportJob, type ReportingRepository } from '../../src/repo/repository.js';
import {
  EXPORT_BUCKET,
  EXPORT_JOB,
  OWNED_TABLES,
  TSESSIONTRACKING,
  UNITS,
  exportObjectKey,
  type ExportJobApplyRow,
  type ExportJobRow,
} from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const LATER = new Date(2026, 5, 30, 10, 5, 0, 0);
const BACKFILL: WriteContext = { origin: 'backfill' };
const OUTPUT = Buffer.from('Title,Amount\r\nTravel,10.5000\r\n');

interface RecordedPut {
  bucket: BucketName;
  key: string;
  bytes: Buffer;
  contentType: string;
}

/** In-memory storage port recording every put; `corrupt` makes it report a different SHA-256 than it was given. */
function recordingStorage(): StoragePort & { puts: RecordedPut[]; corrupt: boolean } {
  const puts: RecordedPut[] = [];
  const unused = (): never => {
    throw new Error('not used by the repository');
  };
  const storage = {
    kind: 'local' as const,
    puts,
    corrupt: false,
    put: (bucket: BucketName, key: string, body: unknown, opts: PutOptions): Promise<PutResult> => {
      const bytes = Buffer.from(body as Buffer);
      puts.push({ bucket, key, bytes, contentType: opts.contentType });
      const hashed = storage.corrupt ? Buffer.concat([bytes, Buffer.from('!')]) : bytes;
      return Promise.resolve({ size: bytes.length, sha256: sha256(hashed) });
    },
    get: unused,
    stream: unused,
    open: unused,
    delete: unused,
    head: unused,
    signedUrl: unused,
  };
  return storage;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function newJob(overrides: Partial<NewExportJob> = {}): NewExportJob {
  return {
    job_id: cfUuid(),
    siteid: 'tenant-a',
    definition_id: cfUuid(),
    format: 'csv',
    state: 'queued',
    requested_by_id: cfUuid(),
    created: NOW,
    started_at: null,
    finished_at: null,
    error: null,
    file_name: null,
    content_type: null,
    object_key: null,
    output_sha256: null,
    ...overrides,
  };
}

/** A `done` export job as a migration apply delivers it, carrying its fixture bytes. */
function applyJob(overrides: Partial<ExportJobApplyRow> = {}): ExportJobApplyRow {
  return {
    job_id: cfUuid(),
    siteid: 'tenant-a',
    definition_id: cfUuid(),
    format: 'csv',
    state: 'done',
    requested_by_id: cfUuid(),
    created: NOW,
    started_at: NOW,
    finished_at: LATER,
    error: null,
    file_name: 'export.csv',
    content_type: 'text/csv',
    output_sha256: sha256(OUTPUT),
    output: OUTPUT,
    ...overrides,
  };
}

describe('reporting repository identity', () => {
  it('extends the platform repository of the owned tables on the database schema', () => {
    const db = { schema: 'reporting' } as TenantDb;
    const repository = createReportingRepository({ db, storage: recordingStorage(), clock: fixedClock(NOW) });
    const handlerRepository: MigrationHandlerOptions['repository'] = repository;
    expect(Object.isFrozen(repository)).toBe(true);
    expect(handlerRepository).toMatchObject({ owner: 'reporting', schema: 'reporting' });
    expect(repository.units()).toEqual([...UNITS]);
    expect(OWNED_TABLES.map((table) => repository.definition(table.table).unit)).toEqual([...UNITS]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('reporting repository writes against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let storage: ReturnType<typeof recordingStorage>;
  let repository: ReportingRepository;
  let tenants = 0;
  let tenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'reporting',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    storage = recordingStorage();
    repository = createReportingRepository({ db: handle.app, storage, clock: fixedClock(NOW) });
    tenants += 1;
    tenantId = tenantIdForSite(`reporting-repository-${tenants}`);
  });

  /** Moves every reporting gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: UNITS, holderId: 'repository-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'repository-test', state });
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  function select<T = RepositoryRow>(sql: string, tenant = tenantId): Promise<T[]> {
    return inTenant(async (tx) => (await tx.query(sql.replaceAll('<s>', handle.schema))).rows as T[], tenant);
  }

  /** `<op> <table>` of the changelog rows the open transaction wrote. */
  async function written(tx: TenantTx): Promise<string[]> {
    const { rows } = await tx.query<{ op: string; table: string }>(
      `SELECT op, "table" FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`,
    );
    return rows.map((row) => `${row.op} ${row.table}`);
  }

  it('writes each job row with its changelog row in the caller transaction and bumps row_version', async () => {
    await inTenant(async (tx) => {
      const job = await repository.insertJob(tx, newJob());
      expect(job).toMatchObject({ tenant_id: tenantId, state: 'queued', row_version: '1' });
      const running = await repository.updateJob(tx, { job_id: job.job_id }, { state: 'running', started_at: NOW });
      expect(running).toMatchObject({ state: 'running', started_at: NOW, row_version: '2' });
      const failed = await repository.updateJob(tx, { job_id: job.job_id }, { state: 'failed', finished_at: LATER, error: 'export-failed' });
      expect(failed).toEqual({ ...running, state: 'failed', finished_at: LATER, error: 'export-failed', row_version: '3' });
      expect(await written(tx)).toEqual(['insert export_job', 'update export_job', 'update export_job']);
    });
    expect(storage.puts).toEqual([]);
  });

  it('keeps a row_version the caller supplies on insert', async () => {
    const job = await inTenant((tx) => repository.insertJob(tx, { ...newJob(), row_version: '7' }));
    expect(job.row_version).toBe('7');
  });

  it('refuses to update a job that does not exist and writes nothing', async () => {
    await expect(inTenant((tx) => repository.updateJob(tx, { job_id: cfUuid() }, { state: 'running' }))).rejects.toBeInstanceOf(
      RepositoryError,
    );
    expect(await select('SELECT * FROM <s>.changelog')).toEqual([]);
  });

  it('rejects target writes while the units are legacy-authoritative and writes nothing', async () => {
    await setGates('legacy');
    await expect(inTenant((tx) => repository.insertJob(tx, newJob()))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    await expect(
      inTenant((tx) => repository.insert(tx, TSESSIONTRACKING.table, { trackingid: 1, urltoken: 'token', entered: NOW })),
    ).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    expect(await select('SELECT * FROM <s>.changelog')).toEqual([]);
  });

  it('hides another tenant job from reads and updates', async () => {
    const other = tenantIdForSite(`reporting-repository-other-${tenants}`);
    const mine = await inTenant((tx) => repository.insertJob(tx, newJob()));
    expect(await inTenant((tx) => repository.findByKey(tx, EXPORT_JOB.table, { job_id: mine.job_id }), other)).toBeNull();
    await expect(inTenant((tx) => repository.updateJob(tx, { job_id: mine.job_id }, { state: 'running' }), other)).rejects.toBeInstanceOf(
      RepositoryError,
    );
    expect(await select('SELECT * FROM <s>.changelog', other)).toEqual([]);
    expect(await select<{ state: string }>('SELECT state FROM <s>.export_job')).toEqual([{ state: 'queued' }]);
  });

  describe('migration applies', () => {
    it('stores verified output under the deterministic key and keeps the bytes out of the row and changelog', async () => {
      const row = applyJob();
      const key = exportObjectKey(tenantId, row.job_id, 'csv');
      const stored = await inTenant((tx) => repository.upsert<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));

      expect(key).toBe(`${tenantId}/${row.job_id}.csv`);
      expect(stored).toMatchObject({ job_id: row.job_id, object_key: key, output_sha256: sha256(OUTPUT), row_version: '0' });
      expect(stored).not.toHaveProperty('output');
      expect(storage.puts).toEqual([{ bucket: EXPORT_BUCKET, key, bytes: OUTPUT, contentType: 'text/csv' }]);
      const logged = await select<{ table: string; origin: string; after: string }>('SELECT "table", origin, after FROM <s>.changelog');
      expect(logged.map(({ table, origin }) => ({ table, origin }))).toEqual([{ table: 'export_job', origin: 'backfill' }]);
      expect(logged[0]?.after).not.toContain(OUTPUT.toString('hex'));
    });

    it('overwrites the same object and keeps the stored row_version when a batch is applied again', async () => {
      const row = applyJob();
      const first = await inTenant((tx) => repository.upsert<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));
      await inTenant((tx) => repository.updateJob(tx, { job_id: row.job_id }, { file_name: 'renamed.csv' }));
      const second = await inTenant((tx) => repository.upsert<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));
      expect(second).toEqual({ ...first, row_version: '1' });
      expect(storage.puts.map((put) => put.key)).toEqual([first.object_key, first.object_key]);
    });

    it('writes a null object_key for null output and stores nothing', async () => {
      const row = applyJob({ state: 'failed', error: 'source-unavailable', output: null, output_sha256: null, file_name: null, content_type: null });
      const stored = await inTenant((tx) => repository.insert<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));
      expect(stored).toMatchObject({ object_key: null, output_sha256: null });
      expect(storage.puts).toEqual([]);
    });

    it('stores output without a content type as application/octet-stream', async () => {
      await inTenant((tx) => repository.upsert(tx, EXPORT_JOB.table, applyJob({ content_type: null }), BACKFILL));
      expect(storage.puts.map((put) => put.contentType)).toEqual(['application/octet-stream']);
    });

    it.each([
      ['output that does not match output_sha256', { output_sha256: 'f'.repeat(64) }],
      ['output without an output_sha256', { output_sha256: null }],
    ] as [string, Partial<ExportJobApplyRow>][])('rejects an apply with %s and leaves nothing behind', async (_label, overrides) => {
      const row = applyJob(overrides);
      await expect(inTenant((tx) => repository.upsert(tx, EXPORT_JOB.table, row, BACKFILL))).rejects.toThrow(
        new RepositoryError(
          `export job ${row.job_id} output has SHA-256 ${sha256(OUTPUT)}, but its output_sha256 is ${String(row.output_sha256)}`,
          EXPORT_JOB.table,
        ).message,
      );
      expect(storage.puts).toEqual([]);
      expect(await select('SELECT * FROM <s>.export_job')).toEqual([]);
      expect(await select('SELECT * FROM <s>.changelog')).toEqual([]);
    });

    it('rolls the row back when the stored object reports a different SHA-256', async () => {
      storage.corrupt = true;
      await expect(inTenant((tx) => repository.upsert(tx, EXPORT_JOB.table, applyJob(), BACKFILL))).rejects.toThrow(/stored object has SHA-256/);
      expect(await select('SELECT * FROM <s>.export_job')).toEqual([]);
    });

    it('stores nothing when the platform repository rejects the write', async () => {
      const foreign = applyJob({ tenant_id: tenantIdForSite(`reporting-repository-foreign-${tenants}`) });
      await expect(inTenant((tx) => repository.upsert(tx, EXPORT_JOB.table, foreign, BACKFILL))).rejects.toBeInstanceOf(RepositoryError);
      expect(storage.puts).toEqual([]);
    });

    it('deletes an apply row carrying output and keeps its object', async () => {
      const row = applyJob();
      await inTenant((tx) => repository.upsert(tx, EXPORT_JOB.table, row, BACKFILL));
      const removed = await inTenant((tx) => repository.delete<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));
      expect(removed).toMatchObject({ job_id: row.job_id });
      expect(await inTenant((tx) => repository.delete(tx, EXPORT_JOB.table, { job_id: row.job_id }, BACKFILL))).toBeNull();
      expect(await select('SELECT * FROM <s>.export_job')).toEqual([]);
    });
  });
});
