// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance repository against a throwaway `finance` schema: domain writes with their changelog rows, gates, RLS and the migration-apply steps. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RepositoryError,
  UnitNotAuthoritativeError,
  closeGates,
  ensureUnitGates,
  openGates,
  type RepositoryRow,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { BucketName, PutOptions, PutResult, StoragePort } from '@opt2/platform/storage';
import { tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { createFinanceRepository, type FinanceRepository, type NewFinanceRecord, type NewFinanceRollup } from '../../src/repo/repository.js';
import { ATTACHMENT_BUCKET, OWNED_TABLES, UNITS, attachmentObjectKey, type FinanceRecordRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const ACTOR = '11111111-2222-3333-4444555566667777';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const BACKFILL: WriteContext = { origin: 'backfill' };

interface RecordedPut {
  bucket: BucketName;
  key: string;
  bytes: Buffer;
  contentType: string;
}

/** In-memory storage port recording every put. */
function recordingStorage(): StoragePort & { puts: RecordedPut[] } {
  const puts: RecordedPut[] = [];
  const unused = (): never => {
    throw new Error('not used by the repository');
  };
  return {
    kind: 'local',
    puts,
    put: (bucket: BucketName, key: string, body: unknown, opts: PutOptions): Promise<PutResult> => {
      const bytes = Buffer.from(body as Buffer);
      puts.push({ bucket, key, bytes, contentType: opts.contentType });
      return Promise.resolve({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    },
    get: unused,
    stream: unused,
    open: unused,
    delete: unused,
    head: unused,
    signedUrl: unused,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function newRecord(overrides: Partial<NewFinanceRecord> = {}): NewFinanceRecord {
  return {
    siteid: 'tenant-a',
    title: 'Travel',
    amount: '10.5000',
    period: '2026-06',
    state: 'IN-PROGRESS',
    version: 1,
    created: NOW,
    createdbyid: ACTOR,
    lastupdate: null,
    lastupdatebyid: null,
    legacy_program_id: 1,
    ...overrides,
  };
}

function rollup(period: string, state: string, count: number, total: string, programId = 1): NewFinanceRollup {
  return { period, state, record_count: count, total_amount: total, computed_at: NOW, legacy_program_id: programId };
}

describe('finance repository identity', () => {
  it('extends the platform repository of the owned tables on the database schema', () => {
    const db = { schema: 'finance' } as TenantDb;
    const storage = recordingStorage();
    const repository = createFinanceRepository({ db, storage });
    expect(Object.isFrozen(repository)).toBe(true);
    expect(repository).toMatchObject({ owner: 'finance', schema: 'finance', db, storage });
    expect(repository.units()).toEqual([...UNITS]);
    expect(OWNED_TABLES.map((table) => repository.definition(table.table).unit)).toEqual([...UNITS]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('finance repository writes against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let storage: ReturnType<typeof recordingStorage>;
  let repository: FinanceRepository;
  let tenants = 0;
  let programs = 100;
  let tenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'finance',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await seedRegistry(handle.app);
    await ensureUnitGates(handle.app, UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    storage = recordingStorage();
    repository = createFinanceRepository({ db: handle.app, storage, clock: fixedClock(NOW) });
    tenants += 1;
    programs += 1;
    tenantId = tenantIdForSite(`finance-repository-${tenants}`);
  });

  /** Moves every finance gate to `state` through the holder compare-and-set. */
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

  it('writes each domain row with its changelog row in the caller transaction', async () => {
    await inTenant(async (tx) => {
      const record = await repository.insertRecord(tx, newRecord());
      expect(record).toMatchObject({ tenant_id: tenantId, row_version: '1', amount: '10.5000', state: 'IN-PROGRESS' });
      expect(record.record_id).toMatch(CF_UUID);
      const version = await repository.insertVersion(tx, {
        record_id: record.record_id,
        version: 1,
        state: 'IN-PROGRESS',
        title: 'Travel',
        amount: '10.5000',
        period: '2026-06',
        action: 'create',
        actor_user_id: ACTOR,
        created: NOW,
        legacy_program_id: 1,
      });
      expect(version.version_id).toMatch(CF_UUID);
      const updated = await repository.updateRecord(tx, record, { state: 'SUBMITTED', version: 2, lastupdate: NOW, lastupdatebyid: ACTOR });
      expect(updated).toMatchObject({ record_id: record.record_id, state: 'SUBMITTED', version: 2, row_version: '2' });
      const attachment = await repository.insertAttachment(tx, {
        record_id: record.record_id,
        file_name: 'a.pdf',
        content_type: 'application/pdf',
        size_bytes: 1,
        sha256: 'a'.repeat(64),
        object_key: `${tenantId}/k.pdf`,
        created: NOW,
        createdbyid: ACTOR,
        legacy_program_id: 1,
      });
      expect(attachment.attachment_id).toMatch(CF_UUID);
      expect(await written(tx)).toEqual(['insert record', 'insert record_version', 'update record', 'insert attachment']);
    });
    expect(storage.puts).toEqual([]);
  });

  it('rebuilds the tenant rollups by deleting every stored row before inserting the new ones', async () => {
    await inTenant((tx) => repository.replaceRollups(tx, [rollup('2026-06', 'SUBMITTED', 1, '1.0000'), rollup('2026-07', 'APPROVED', 2, '3.5000')]));
    const rebuilt = await inTenant(async (tx) => {
      const rows = await repository.replaceRollups(tx, [rollup('2026-06', 'SUBMITTED', 4, '9.2500')]);
      expect(await written(tx)).toEqual(['delete rollup', 'delete rollup', 'insert rollup']);
      return rows;
    });
    expect(rebuilt).toMatchObject([{ period: '2026-06', state: 'SUBMITTED', record_count: 4, total_amount: '9.2500' }]);
    expect(await select('SELECT period, state, record_count FROM <s>.rollup')).toEqual([{ period: '2026-06', state: 'SUBMITTED', record_count: 4 }]);
  });

  it('serialises concurrent rebuilds of one tenant', async () => {
    const rebuild = (count: number): Promise<unknown> => inTenant((tx) => repository.replaceRollups(tx, [rollup('2026-08', 'APPROVED', count, '1.0000')]));
    await expect(Promise.all([rebuild(1), rebuild(2), rebuild(3)])).resolves.toHaveLength(3);
    expect(await select('SELECT period FROM <s>.rollup')).toHaveLength(1);
  });

  it('refuses to update a record that is gone', async () => {
    await inTenant(async (tx) => {
      const record = await repository.insertRecord(tx, newRecord());
      await repository.delete(tx, 'record', { record_id: record.record_id });
      await expect(repository.updateRecord(tx, record, { title: 'Gone' })).rejects.toBeInstanceOf(RepositoryError);
    });
  });

  it('rejects target writes while the unit is legacy-authoritative and writes nothing', async () => {
    await setGates('legacy');
    await expect(inTenant((tx) => repository.insertRecord(tx, newRecord()))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    expect(await select('SELECT * FROM <s>.changelog')).toEqual([]);
  });

  it('hides another tenant rows from a tenant transaction', async () => {
    const other = tenantIdForSite(`finance-repository-other-${tenants}`);
    await inTenant((tx) => repository.insertRecord(tx, newRecord({ title: 'Mine' })));
    await inTenant((tx) => repository.insertRecord(tx, newRecord({ title: 'Theirs' })), other);
    expect(await select<{ title: string }>('SELECT title FROM <s>.record')).toEqual([{ title: 'Mine' }]);
  });

  describe('migration applies', () => {
    const bytes = Buffer.from('%PDF-1.4 finance attachment bytes');

    function applyAttachment(overrides: RepositoryRow = {}): RepositoryRow {
      return {
        attachment_id: cfUuid(),
        record_id: cfUuid(),
        file_name: 'Invoice.PDF',
        content_type: 'application/pdf',
        size_bytes: bytes.length,
        sha256: sha256(bytes),
        created: NOW,
        createdbyid: ACTOR,
        legacy_program_id: programs,
        content: bytes,
        ...overrides,
      };
    }

    it('stores verified bytes under the deterministic key, keeps them out of the row and binds the program from the registry', async () => {
      const row = applyAttachment({ size_bytes: undefined });
      const id = row.attachment_id as string;
      const key = attachmentObjectKey(TENANT_A.tenantId, id, 'Invoice.PDF');
      const stored = await inTenant((tx) => repository.upsert<RepositoryRow>(tx, 'attachment', row, BACKFILL), TENANT_A.tenantId);

      expect(stored).toMatchObject({ attachment_id: id, object_key: key, size_bytes: bytes.length, sha256: sha256(bytes) });
      expect(stored).not.toHaveProperty('content');
      expect(storage.puts).toEqual([{ bucket: ATTACHMENT_BUCKET, key, bytes, contentType: 'application/pdf' }]);
      const logged = await select<{ table: string; origin: string; after: string }>('SELECT "table", origin, after FROM <s>.changelog', TENANT_A.tenantId);
      expect(logged.map(({ table, origin }) => ({ table, origin }))).toEqual([{ table: 'attachment', origin: 'backfill' }]);
      expect(logged[0]?.after).not.toContain(bytes.toString('hex'));
      expect(await select(`SELECT tenant_id, site_id, legacy_program_id FROM <s>.program_binding`, TENANT_A.tenantId)).toEqual([
        { tenant_id: TENANT_A.tenantId, site_id: TENANT_A.siteId, legacy_program_id: programs },
      ]);
    });

    it('overwrites the same object and leaves the row unchanged when a batch is applied again', async () => {
      const row = applyAttachment({ legacy_program_id: 1 });
      const first = await inTenant((tx) => repository.upsert<RepositoryRow>(tx, 'attachment', row, BACKFILL));
      const second = await inTenant((tx) => repository.upsert<RepositoryRow>(tx, 'attachment', row, BACKFILL));
      expect(second).toEqual(first);
      expect(storage.puts.map((put) => put.key)).toEqual([first.object_key, first.object_key]);
      expect(await select('SELECT attachment_id FROM <s>.attachment')).toHaveLength(1);
    });

    it.each([
      ['bytes that do not match sha256', { sha256: 'f'.repeat(64) }],
      ['content that is not bytes', { content: bytes.toString('hex') }],
      ['no file name', { file_name: '' }],
    ] as [string, RepositoryRow][])('rejects an attachment apply with %s and leaves nothing behind', async (_label, overrides) => {
      await expect(
        inTenant(async (tx) => {
          await repository.insert(tx, 'record', { ...newRecord(), record_id: cfUuid() }, BACKFILL);
          await repository.upsert(tx, 'attachment', applyAttachment(overrides), BACKFILL);
        }),
      ).rejects.toBeInstanceOf(RepositoryError);
      expect(storage.puts).toEqual([]);
      expect(await select('SELECT * FROM <s>.record')).toEqual([]);
      expect(await select('SELECT * FROM <s>.program_binding')).toEqual([]);
    });

    it('binds one program per transaction from the row site, without a changelog row for the binding', async () => {
      await inTenant(async (tx) => {
        for (let i = 0; i < 5; i += 1) {
          await repository.upsert(tx, 'record', { ...newRecord({ siteid: 'tenant-b', legacy_program_id: programs }), record_id: cfUuid() }, { origin: 'migration-feed' });
        }
        expect(await written(tx)).toEqual(Array.from({ length: 5 }, () => 'insert record'));
      });
      expect(await select('SELECT tenant_id, site_id, legacy_program_id FROM <s>.program_binding')).toEqual([
        { tenant_id: tenantId, site_id: 'tenant-b', legacy_program_id: programs },
      ]);
    });

    it('skips the binding when neither the row nor the registry names a site', async () => {
      await inTenant((tx) => repository.insert(tx, 'rollup', { ...rollup('2026-06', 'APPROVED', 1, '1.0000', programs) }, { origin: 'legacy-window' }));
      expect(await select('SELECT * FROM <s>.rollup')).toHaveLength(1);
      expect(await select('SELECT * FROM <s>.program_binding')).toEqual([]);
    });

    it('stages bytes on an apply update and stores nothing when no row matches', async () => {
      const row = applyAttachment();
      await inTenant((tx) => repository.upsert(tx, 'attachment', row, BACKFILL));
      const replacement = Buffer.from('replacement bytes');
      const patch = { file_name: 'Invoice.PDF', content_type: 'application/pdf', sha256: sha256(replacement), content: replacement };
      const updated = await inTenant((tx) => repository.update<RepositoryRow>(tx, 'attachment', { attachment_id: row.attachment_id }, patch, BACKFILL));
      const missing = await inTenant((tx) => repository.update(tx, 'attachment', { attachment_id: cfUuid() }, patch, BACKFILL));

      expect(updated).toMatchObject({ size_bytes: replacement.length, sha256: sha256(replacement) });
      expect(missing).toBeNull();
      expect(storage.puts.map((put) => put.bytes)).toEqual([bytes, replacement]);
    });

    it('stores nothing when the platform repository rejects the write', async () => {
      await expect(
        inTenant((tx) => repository.replaceOne(tx, 'attachment', { attachment_id: cfUuid() }, applyAttachment(), BACKFILL)),
      ).rejects.toBeInstanceOf(RepositoryError);
      await expect(inTenant((tx) => repository.upsert(tx, 'attachment', applyAttachment()))).rejects.toBeInstanceOf(RepositoryError);
      expect(storage.puts).toEqual([]);
    });

    it('applies target writes without binding a program', async () => {
      const record: FinanceRecordRow = await inTenant((tx) => repository.insertRecord(tx, newRecord({ legacy_program_id: programs })));
      expect(record.legacy_program_id).toBe(programs);
      expect(await select('SELECT * FROM <s>.program_binding')).toEqual([]);
    });
  });
});
