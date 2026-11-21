// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting repository against a throwaway `reporting` schema: job writes with their changelog rows, gates, RLS and the export-output step of migration applies. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { BucketName, ObjectHead, PutOptions, PutResult, StoragePort } from '@opt2/platform/storage';
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
  type OutputSlot,
} from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const LATER = new Date(2026, 5, 30, 10, 5, 0, 0);
const BACKFILL: WriteContext = { origin: 'backfill' };
const OUTPUT = Buffer.from('Title,Amount\r\nTravel,10.5000\r\n');
const REPLACEMENT = Buffer.from('Title,Amount\r\nTravel,99.0000\r\n');
const LATEST = Buffer.from('Title,Amount\r\nTravel,12.2500\r\n');

interface RecordedPut {
  bucket: BucketName;
  key: string;
  bytes: Buffer;
  contentType: string;
}

/** In-memory storage port recording puts and deletes; `objects` holds the bytes `head` reports, and `corrupt` makes `put` misreport their SHA-256. */
function recordingStorage(): StoragePort & {
  puts: RecordedPut[];
  deletes: { bucket: BucketName; key: string }[];
  objects: Map<string, Buffer>;
  corrupt: boolean;
} {
  const puts: RecordedPut[] = [];
  const deletes: { bucket: BucketName; key: string }[] = [];
  const objects = new Map<string, Buffer>();
  const contentTypes = new Map<string, string>();
  const unused = (): never => {
    throw new Error('not used by the repository');
  };
  const storage = {
    kind: 'local' as const,
    puts,
    deletes,
    objects,
    corrupt: false,
    put: (bucket: BucketName, key: string, body: unknown, opts: PutOptions): Promise<PutResult> => {
      const bytes = Buffer.from(body as Buffer);
      puts.push({ bucket, key, bytes, contentType: opts.contentType });
      objects.set(key, bytes);
      contentTypes.set(key, opts.contentType);
      const hashed = storage.corrupt ? Buffer.concat([bytes, Buffer.from('!')]) : bytes;
      return Promise.resolve({ size: bytes.length, sha256: sha256(hashed) });
    },
    delete: (bucket: BucketName, key: string): Promise<void> => {
      deletes.push({ bucket, key });
      objects.delete(key);
      return Promise.resolve();
    },
    head: (_bucket: BucketName, key: string): Promise<ObjectHead | null> => {
      const bytes = objects.get(key);
      return Promise.resolve(bytes === undefined ? null : { size: bytes.length, sha256: sha256(bytes), contentType: contentTypes.get(key) ?? '' });
    },
    get: unused,
    stream: unused,
    open: unused,
    signedUrl: unused,
  };
  return storage;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `storage` whose delete of `key` waits for `release()`; `reached` resolves once that delete has started. */
function pausingStorage(storage: StoragePort, key: string): { storage: StoragePort; reached: Promise<void>; release: () => void } {
  const signals: { reach?: () => void; release?: () => void } = {};
  const reached = new Promise<void>((resolve) => {
    signals.reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    signals.release = resolve;
  });
  const paused: StoragePort = {
    ...storage,
    delete: async (bucket: BucketName, deleted: string): Promise<void> => {
      if (deleted === key) {
        signals.reach?.();
        await released;
      }
      await storage.delete(bucket, deleted);
    },
  };
  return { storage: paused, reached, release: () => signals.release?.() };
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

  /** Output-slot key `slot` of csv job `jobId` in the test tenant. */
  function slotKey(jobId: string, slot: OutputSlot): string {
    return exportObjectKey(tenantId, jobId, 'csv', slot);
  }

  /** `row` carrying `output`, with the matching output_sha256. */
  function carrying(row: ExportJobApplyRow, output: Buffer | null): ExportJobApplyRow {
    return { ...row, output, output_sha256: output === null ? null : sha256(output) };
  }

  /** The committed output pointer of job `jobId`. */
  function storedJob(jobId: string): Promise<Pick<ExportJobRow, 'object_key' | 'output_sha256'>[]> {
    return select<Pick<ExportJobRow, 'object_key' | 'output_sha256'>>(
      `SELECT object_key, output_sha256 FROM <s>.export_job WHERE job_id = '${jobId}'`,
    );
  }

  /** The stored objects as [key, bytes] pairs in key order. */
  function storedObjects(): [string, Buffer][] {
    return [...storage.objects.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  /** Forgets the storage calls made so far. */
  function forgetCalls(): void {
    storage.puts.length = 0;
    storage.deletes.length = 0;
  }

  /** Commits `row`, forgets the storage calls it made and returns the key its row names. */
  async function committed(row: ExportJobApplyRow): Promise<string> {
    const stored = await inTenant((tx) => repository.upsert<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));
    forgetCalls();
    return String(stored.object_key);
  }

  /** Applies `row` with `output` in a transaction a later batch row fails, so it rolls back after the bytes were stored. */
  async function abandoned(row: ExportJobApplyRow, output: Buffer): Promise<void> {
    await expect(
      inTenant(async (tx) => {
        await repository.upsert(tx, EXPORT_JOB.table, carrying(row, output), BACKFILL);
        throw new Error('later batch row failed');
      }),
    ).rejects.toThrow('later batch row failed');
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
    it('stores verified output in output slot a, keeps the bytes out of the row and changelog, and collects slot b after commit', async () => {
      const row = applyJob();
      const key = slotKey(row.job_id, 'a');
      const stored = await inTenant((tx) => repository.upsert<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));

      expect(key).toBe(`${tenantId}/${row.job_id}.a.csv`);
      expect(stored).toMatchObject({ job_id: row.job_id, object_key: key, output_sha256: sha256(OUTPUT), row_version: '0' });
      expect(stored).not.toHaveProperty('output');
      expect(storage.puts).toEqual([{ bucket: EXPORT_BUCKET, key, bytes: OUTPUT, contentType: 'text/csv' }]);
      expect(storage.deletes).toEqual([{ bucket: EXPORT_BUCKET, key: slotKey(row.job_id, 'b') }]);
      expect(storedObjects()).toEqual([[key, OUTPUT]]);
      const logged = await select<{ table: string; origin: string; after: string }>('SELECT "table", origin, after FROM <s>.changelog');
      expect(logged.map(({ table, origin }) => ({ table, origin }))).toEqual([{ table: 'export_job', origin: 'backfill' }]);
      expect(logged[0]?.after).not.toContain(OUTPUT.toString('hex'));
    });

    it('reuses the committed object without storing it again and keeps the stored row_version when a batch is applied again', async () => {
      const row = applyJob();
      const first = await inTenant((tx) => repository.upsert<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));
      await inTenant((tx) => repository.updateJob(tx, { job_id: row.job_id }, { file_name: 'renamed.csv' }));
      const second = await inTenant((tx) => repository.upsert<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));
      expect(second).toEqual({ ...first, row_version: '1' });
      expect(first.object_key).toBe(slotKey(row.job_id, 'a'));
      expect(storage.puts.map((put) => put.key)).toEqual([first.object_key]);
      expect(storedObjects()).toEqual([[first.object_key, OUTPUT]]);
    });

    it.each<[string, (key: string, row: ExportJobApplyRow) => ExportJobApplyRow]>([
      [
        'is gone',
        (key, row) => {
          storage.objects.delete(key);
          return row;
        },
      ],
      ['holds it under another content type', (_key, row) => ({ ...row, content_type: 'text/csv;charset=utf-8' })],
    ])('stores the output again in the other slot when the committed object %s', async (_case, change) => {
      const row = applyJob();
      const key = await committed(row);
      const again = change(key, row);
      await inTenant((tx) => repository.upsert(tx, EXPORT_JOB.table, again, BACKFILL));
      expect(await storedJob(row.job_id)).toEqual([{ object_key: slotKey(row.job_id, 'b'), output_sha256: sha256(OUTPUT) }]);
      expect(storage.puts).toEqual([{ bucket: EXPORT_BUCKET, key: slotKey(row.job_id, 'b'), bytes: OUTPUT, contentType: again.content_type }]);
      expect(storedObjects()).toEqual([[slotKey(row.job_id, 'b'), OUTPUT]]);
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
      const key = await committed(row);
      const removed = await inTenant((tx) => repository.delete<ExportJobRow>(tx, EXPORT_JOB.table, row, BACKFILL));
      expect(removed).toMatchObject({ job_id: row.job_id });
      expect(await inTenant((tx) => repository.delete(tx, EXPORT_JOB.table, { job_id: row.job_id }, BACKFILL))).toBeNull();
      expect(await select('SELECT * FROM <s>.export_job')).toEqual([]);
      expect(storage.deletes).toEqual([]);
      expect(storedObjects()).toEqual([[key, OUTPUT]]);
    });

    it('keeps the objects of a job that one transaction applies and then deletes', async () => {
      const row = applyJob();
      await inTenant(async (tx) => {
        await repository.upsert(tx, EXPORT_JOB.table, row, BACKFILL);
        await repository.delete(tx, EXPORT_JOB.table, { job_id: row.job_id }, BACKFILL);
      });
      expect(await storedJob(row.job_id)).toEqual([]);
      expect(storage.deletes).toEqual([]);
      expect(storedObjects()).toEqual([[slotKey(row.job_id, 'a'), OUTPUT]]);
    });

    describe('output replacement', () => {
      it('keeps the committed row and the bytes it names when a later batch row fails after new bytes were stored', async () => {
        const row = applyJob();
        const key = await committed(row);
        await abandoned(row, REPLACEMENT);

        expect(await storedJob(row.job_id)).toEqual([{ object_key: key, output_sha256: sha256(OUTPUT) }]);
        expect(storage.objects.get(key)).toEqual(OUTPUT);
        expect(storage.puts.map((put) => put.key)).toEqual([slotKey(row.job_id, 'b')]);
        expect(storage.deletes).toEqual([]);
      });

      it.each<[string, (tx: TenantTx, row: ExportJobApplyRow) => Promise<void>]>([
        [
          'applies the job twice',
          async (tx, row) => {
            await repository.upsert(tx, EXPORT_JOB.table, carrying(row, REPLACEMENT), BACKFILL);
            await repository.upsert(tx, EXPORT_JOB.table, carrying(row, LATEST), BACKFILL);
          },
        ],
        [
          'deletes and re-inserts the job',
          async (tx, row) => {
            await repository.delete(tx, EXPORT_JOB.table, { job_id: row.job_id }, BACKFILL);
            await repository.insert(tx, EXPORT_JOB.table, carrying(row, REPLACEMENT), BACKFILL);
          },
        ],
      ])('never writes the committed object when one transaction %s and rolls back', async (_case, writes) => {
        const row = applyJob();
        const key = await committed(row);
        await expect(
          inTenant(async (tx) => {
            await writes(tx, row);
            throw new Error('later batch row failed');
          }),
        ).rejects.toThrow('later batch row failed');

        expect(await storedJob(row.job_id)).toEqual([{ object_key: key, output_sha256: sha256(OUTPUT) }]);
        expect(storage.objects.get(key)).toEqual(OUTPUT);
        expect(new Set(storage.puts.map((put) => put.key))).toEqual(new Set([slotKey(row.job_id, 'b')]));
      });

      it.each<[string, Buffer, OutputSlot, OutputSlot[]]>([
        ['a later replacement', LATEST, 'b', ['b', 'b']],
        ['a re-apply of the committed output', OUTPUT, 'a', ['b']],
      ])('collects the upload a rolled-back apply left at %s, after a repository restart', async (_case, output, slot, puts) => {
        const row = applyJob();
        await committed(row);
        await abandoned(row, REPLACEMENT);
        expect(storedObjects()).toEqual([
          [slotKey(row.job_id, 'a'), OUTPUT],
          [slotKey(row.job_id, 'b'), REPLACEMENT],
        ]);

        const restarted = createReportingRepository({ db: handle.app, storage, clock: fixedClock(NOW) });
        await inTenant((tx) => restarted.upsert(tx, EXPORT_JOB.table, carrying(row, output), BACKFILL));

        expect(await storedJob(row.job_id)).toEqual([{ object_key: slotKey(row.job_id, slot), output_sha256: sha256(output) }]);
        expect(storage.puts.map((put) => put.key)).toEqual(puts.map((put) => slotKey(row.job_id, put)));
        expect(storedObjects()).toEqual([[slotKey(row.job_id, slot), output]]);
      });

      it('alternates the slots of committed replacements and deletes each replaced object after commit', async () => {
        const row = applyJob();
        const key = await committed(row);
        await inTenant(async (tx) => {
          await repository.upsert(tx, EXPORT_JOB.table, carrying(row, REPLACEMENT), BACKFILL);
          expect(storage.deletes).toEqual([]);
        });
        expect(await storedJob(row.job_id)).toEqual([{ object_key: slotKey(row.job_id, 'b'), output_sha256: sha256(REPLACEMENT) }]);
        expect(storage.deletes).toEqual([{ bucket: EXPORT_BUCKET, key }]);
        expect(storedObjects()).toEqual([[slotKey(row.job_id, 'b'), REPLACEMENT]]);

        await inTenant((tx) => repository.upsert(tx, EXPORT_JOB.table, carrying(row, LATEST), BACKFILL));
        expect(await storedJob(row.job_id)).toEqual([{ object_key: key, output_sha256: sha256(LATEST) }]);
        expect(storedObjects()).toEqual([[key, LATEST]]);
      });

      it.each<[string, (row: ExportJobApplyRow) => Promise<string>]>([
        ['an output slot', (row) => committed(row)],
        [
          'a runner key',
          async (row) => {
            const key = exportObjectKey(tenantId, row.job_id, 'csv');
            await committed(carrying(row, null));
            await storage.put(EXPORT_BUCKET, key, OUTPUT, { contentType: 'text/csv' });
            await inTenant((tx) => repository.updateJob(tx, { job_id: row.job_id }, { object_key: key, output_sha256: sha256(OUTPUT) }));
            forgetCalls();
            return key;
          },
        ],
      ])('collects both slots and the replaced key at %s when null output replaces the output', async (_case, commit) => {
        const row = applyJob();
        const key = await commit(row);
        await abandoned(row, REPLACEMENT);
        await inTenant((tx) => repository.upsert(tx, EXPORT_JOB.table, carrying(row, null), BACKFILL));

        expect(await storedJob(row.job_id)).toEqual([{ object_key: null, output_sha256: null }]);
        expect(storage.deletes.map((deleted) => deleted.key).sort()).toEqual(
          [...new Set([key, slotKey(row.job_id, 'a'), slotKey(row.job_id, 'b')])].sort(),
        );
        expect(storedObjects()).toEqual([]);
      });

      it('never deletes the object that a row committed before the cleanup names again', async () => {
        const row = applyJob();
        const key = await committed(row);
        await inTenant(async (tx) => {
          // Registered first, so it commits the original output again before the cleanup of `key` runs.
          tx.onCommit(() => inTenant((restore) => repository.upsert(restore, EXPORT_JOB.table, row, BACKFILL)).then(() => undefined));
          await repository.upsert(tx, EXPORT_JOB.table, carrying(row, REPLACEMENT), BACKFILL);
        });

        expect(await storedJob(row.job_id)).toEqual([{ object_key: key, output_sha256: sha256(OUTPUT) }]);
        expect(storedObjects()).toEqual([[key, OUTPUT]]);
      });
    });
  });

  describe('output pointer writes', () => {
    type Pointer = Pick<ExportJobRow, 'object_key' | 'output_sha256'>;
    type PointerWriter = (repo: ReportingRepository, tx: TenantTx, job: ExportJobRow, pointer: Pointer) => Promise<unknown>;

    const WRITERS: [string, PointerWriter][] = [
      ['updateJob', (repo, tx, job, pointer) => repo.updateJob(tx, { job_id: job.job_id }, pointer)],
      ['the inherited update', (repo, tx, job, pointer) => repo.update(tx, EXPORT_JOB.table, { job_id: job.job_id }, pointer)],
      ['a pointer-only upsert', (repo, tx, job, pointer) => repo.upsert(tx, EXPORT_JOB.table, { ...job, ...pointer }, BACKFILL)],
    ];

    /** Runner key of job `jobId` holding OUTPUT. */
    async function runnerObject(jobId: string): Promise<string> {
      const key = exportObjectKey(tenantId, jobId, 'csv');
      await storage.put(EXPORT_BUCKET, key, OUTPUT, { contentType: 'text/csv' });
      return key;
    }

    const BAD_POINTERS: [string, (job: ExportJobRow) => Promise<Pointer>, RegExp][] = [
      [
        'a missing object',
        (job) => Promise.resolve({ object_key: exportObjectKey(tenantId, job.job_id, 'csv'), output_sha256: sha256(OUTPUT) }),
        /names no stored object/,
      ],
      [
        'an object with another SHA-256',
        async (job) => ({ object_key: await runnerObject(job.job_id), output_sha256: sha256(REPLACEMENT) }),
        /has SHA-256 .* but its output_sha256 is/,
      ],
      [
        'an object without an output_sha256',
        async (job) => ({ object_key: await runnerObject(job.job_id), output_sha256: null }),
        /output_sha256 is null/,
      ],
      [
        'an object of another job',
        async () => ({ object_key: await runnerObject(cfUuid()), output_sha256: sha256(OUTPUT) }),
        /is not a key of the job/,
      ],
      [
        'its stored object under a changed output_sha256',
        async (job) => {
          const key = await runnerObject(job.job_id);
          await inTenant((tx) => repository.updateJob(tx, { job_id: job.job_id }, { object_key: key, output_sha256: sha256(OUTPUT) }));
          return { object_key: key, output_sha256: sha256(REPLACEMENT) };
        },
        /has SHA-256 .* but its output_sha256 is/,
      ],
    ];

    it.each(WRITERS)(
      'lets %s point a job at a stored object of the job with its SHA-256 and collects the slots after commit',
      async (_writer, write) => {
        const job = await inTenant((tx) => repository.insertJob(tx, newJob()));
        const key = await runnerObject(job.job_id);
        await inTenant((tx) => write(repository, tx, job, { object_key: key, output_sha256: sha256(OUTPUT) }));
        expect(await storedJob(job.job_id)).toEqual([{ object_key: key, output_sha256: sha256(OUTPUT) }]);
        expect(storage.deletes.map((deleted) => deleted.key)).toEqual([slotKey(job.job_id, 'a'), slotKey(job.job_id, 'b')]);
        expect(storedObjects()).toEqual([[key, OUTPUT]]);
      },
    );

    it.each(WRITERS.flatMap(([writer, write]) => BAD_POINTERS.map(([pointer, make, error]) => [writer, pointer, write, make, error] as const)))(
      '%s refuses to point a job at %s and leaves the row unchanged',
      async (_writer, _pointer, write, make, error) => {
        const created = await inTenant((tx) => repository.insertJob(tx, newJob()));
        const pointer = await make(created);
        const [job] = await select<ExportJobRow>(`SELECT * FROM <s>.export_job WHERE job_id = '${created.job_id}'`);
        if (job === undefined) throw new Error('the job was not stored');
        const failure = await inTenant((tx) => write(repository, tx, job, pointer)).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect(failure).toBeInstanceOf(RepositoryError);
        expect((failure as Error).message).toMatch(error);
        expect(await select(`SELECT * FROM <s>.export_job WHERE job_id = '${job.job_id}'`)).toEqual([job]);
      },
    );

    it('inserts a job naming a stored object of the job and refuses one naming a missing object', async () => {
      const job = newJob();
      const pointer = { object_key: exportObjectKey(tenantId, job.job_id, 'csv'), output_sha256: sha256(OUTPUT) };
      await expect(inTenant((tx) => repository.insertJob(tx, { ...job, ...pointer }))).rejects.toThrow(/names no stored object/);
      expect(await storedJob(job.job_id)).toEqual([]);
      await runnerObject(job.job_id);
      expect(await inTenant((tx) => repository.insertJob(tx, { ...job, ...pointer }))).toMatchObject(pointer);
    });

    it('returns null from the inherited update of a missing job', async () => {
      const pointer = { object_key: exportObjectKey(tenantId, cfUuid(), 'csv'), output_sha256: sha256(OUTPUT) };
      expect(await inTenant((tx) => repository.update(tx, EXPORT_JOB.table, { job_id: cfUuid() }, pointer))).toBeNull();
    });

    it.each(WRITERS)('makes %s restoring a replaced key wait for its cleanup and then refuse the deleted object', async (_writer, write) => {
      const row = applyJob();
      const key = await committed(row);
      const paused = pausingStorage(storage, key);
      const racing = createReportingRepository({ db: handle.app, storage: paused.storage, clock: fixedClock(NOW) });
      const replacing = inTenant((tx) => racing.upsert(tx, EXPORT_JOB.table, carrying(row, REPLACEMENT), BACKFILL));
      await paused.reached;

      // The cleanup now holds the job's output lock and is about to delete `key`.
      const [job] = await select<ExportJobRow>(`SELECT * FROM <s>.export_job WHERE job_id = '${row.job_id}'`);
      if (job === undefined) throw new Error('the job was not stored');
      let backend: number | undefined;
      const restoring = inTenant(async (tx) => {
        backend = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        return write(racing, tx, job, { object_key: key, output_sha256: sha256(OUTPUT) });
      }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      try {
        await vi.waitFor(
          async () => {
            const waiting = await handle.adminPool.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [
              backend ?? null,
            ]);
            expect(waiting.rows).toHaveLength(1);
          },
          { timeout: 10_000, interval: 20 },
        );
      } finally {
        paused.release();
      }
      await replacing;

      expect(await restoring).toBeInstanceOf(RepositoryError);
      expect(await storedJob(row.job_id)).toEqual([{ object_key: slotKey(row.job_id, 'b'), output_sha256: sha256(REPLACEMENT) }]);
      expect(storedObjects()).toEqual([[slotKey(row.job_id, 'b'), REPLACEMENT]]);
    });
  });
});
