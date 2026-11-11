// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance repository against a throwaway `finance` schema: domain writes with their changelog rows, gates, RLS and the migration-apply steps. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RepositoryError,
  UnitNotAuthoritativeError,
  closeGates,
  encodeKey,
  ensureUnitGates,
  openGates,
  type RepositoryRow,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  createLocalStorageAdapter,
  type BucketName,
  type LocalStorageAdapter,
  type PutOptions,
  type PutResult,
  type StoragePort,
} from '@opt2/platform/storage';
import { tenantDbFromPool, tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  collectStagedObjects,
  createFinanceRepository,
  type FinanceRepository,
  type NewFinanceRecord,
  type NewFinanceRollup,
} from '../../src/repo/repository.js';
import {
  ATTACHMENT_BUCKET,
  OWNED_TABLES,
  PROGRAM_BINDING,
  STAGED_OBJECT,
  UNITS,
  attachmentObjectKey,
  type FinanceRecordRow,
} from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const ACTOR = '11111111-2222-3333-4444555566667777';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const HMAC_KEY = 'finance-repository-test-hmac-key';
const BACKFILL: WriteContext = { origin: 'backfill' };
const FEED: WriteContext = { origin: 'migration-feed' };

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

/** `port` recording every put, which first awaits `beforePut` when one is set. */
function recording(port: StoragePort): StoragePort & { puts: RecordedPut[]; beforePut?: () => Promise<void> } {
  const recorder: StoragePort & { puts: RecordedPut[]; beforePut?: () => Promise<void> } = {
    ...port,
    puts: [],
    put: async (bucket: BucketName, key: string, body: unknown, opts: PutOptions): Promise<PutResult> => {
      const bytes = Buffer.from(body as Buffer);
      recorder.puts.push({ bucket, key, bytes, contentType: opts.contentType });
      await recorder.beforePut?.();
      return port.put(bucket, key, bytes, opts);
    },
  };
  return recorder;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A promise with its resolver, for stepping concurrent transactions. */
function signal<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function backendPid(tx: TenantTx): Promise<number> {
  const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return (rows[0] as { pid: number }).pid;
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
    const repository = createFinanceRepository({ db, stagingDb: { schema: 'finance' } as TenantDb, storage });
    expect(Object.isFrozen(repository)).toBe(true);
    expect(repository).toMatchObject({ owner: 'finance', schema: 'finance', db, storage });
    expect(repository.units()).toEqual([...UNITS]);
    expect(OWNED_TABLES.map((table) => repository.definition(table.table).unit)).toEqual([...UNITS]);
  });

  it.each([
    ['the handle of db', (db: TenantDb) => db, 'stagingDb must use a pool of its own, not the handle of db'],
    ['a handle on another schema', () => ({ schema: 'finance_other' }) as TenantDb, 'stagingDb schema finance_other differs from db schema finance'],
  ] as [string, (db: TenantDb) => TenantDb, string][])('refuses %s as stagingDb', (_label, stagingDb, message) => {
    const db = { schema: 'finance' } as TenantDb;
    const build = (): unknown => createFinanceRepository({ db, stagingDb: stagingDb(db), storage: recordingStorage() });
    expect(build).toThrow(TypeError);
    expect(build).toThrow(message);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('finance repository writes against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let stagingDb: TenantDb;
  let stateDir: string;
  let local: LocalStorageAdapter;
  let storage: ReturnType<typeof recording>;
  let repository: FinanceRepository;
  let tenants = 0;
  let programs = 100;
  let tenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'finance',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    stagingDb = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    await seedRegistry(handle.app);
    await ensureUnitGates(handle.app, UNITS);
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-finance-repository-'));
    local = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY, now: () => NOW.getTime() });
  });

  afterAll(async () => {
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await setGates('open');
    storage = recording(local);
    repository = createFinanceRepository({ db: handle.app, stagingDb, storage, clock: fixedClock(NOW) });
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

  /** Resolves once backend `pid` waits for a lock another transaction holds. */
  async function lockWaiting(pid: number): Promise<void> {
    while ((await handle.adminPool.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [pid])).rows.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** `<op> <table>` of the changelog rows the open transaction wrote. */
  async function written(tx: TenantTx): Promise<string[]> {
    const { rows } = await tx.query<{ op: string; table: string }>(
      `SELECT op, "table" FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`,
    );
    return rows.map((row) => `${row.op} ${row.table}`);
  }

  /** Op, origin and key of every changelog row of `table` in the tenant, in write order. */
  function changes(table: string, tenant = tenantId): Promise<{ op: string; origin: string; key: string }[]> {
    return select(`SELECT op, origin, key FROM <s>.changelog WHERE "table" = '${table}' ORDER BY seq`, tenant);
  }

  /** Key and state of every ledger entry of the tenant. */
  function ledger(tenant = tenantId): Promise<{ object_key: string; state: string }[]> {
    return select('SELECT object_key, state FROM <s>.staged_object ORDER BY object_key', tenant);
  }

  /** Distinct keys put so far whose object is still stored, in put order. */
  async function storedObjects(): Promise<string[]> {
    const keys = [...new Set(storage.puts.map((put) => put.key))];
    const heads = await Promise.all(keys.map((key) => local.head(ATTACHMENT_BUCKET, key)));
    return keys.filter((_key, i) => heads[i] !== null);
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

  it('makes a rebuild of the same tenant, and of no other, wait for a holder of the tenant write lock', async () => {
    const order: string[] = [];
    let locked = (): void => undefined;
    let release = (): void => undefined;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = inTenant(async (tx) => {
      await repository.lockWrites(tx);
      locked();
      await released;
      order.push('holder');
    });
    await isLocked;
    const same = inTenant(async (tx) => {
      await repository.replaceRollups(tx, []);
      order.push('same tenant');
    });
    await inTenant(async (tx) => {
      await repository.replaceRollups(tx, []);
      order.push('other tenant');
    }, tenantIdForSite(`finance-repository-other-${tenants}`));
    order.push('release');
    release();
    await Promise.all([holder, same]);
    expect(order).toEqual(['other tenant', 'release', 'holder', 'same tenant']);
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

    const v2 = Buffer.from('%PDF-1.4 finance attachment bytes, second version');

    /** `row` carrying the second version's bytes. */
    function secondVersion(row: RepositoryRow): RepositoryRow {
      return { ...row, size_bytes: v2.length, sha256: sha256(v2), content: v2 };
    }

    function commitAttachment(row: RepositoryRow): Promise<RepositoryRow> {
      return inTenant((tx) => repository.upsert<RepositoryRow>(tx, 'attachment', row, BACKFILL));
    }

    const ledgerKey = (objectKey: string): string => encodeKey(STAGED_OBJECT.columns, STAGED_OBJECT.key, { object_key: objectKey });

    it('stores verified bytes under a new version key, keeps them out of the row and binds the program from the registry', async () => {
      const row = applyAttachment({ size_bytes: undefined });
      const id = row.attachment_id as string;
      const stored = await inTenant((tx) => repository.upsert<RepositoryRow>(tx, 'attachment', row, BACKFILL), TENANT_A.tenantId);
      const key = stored.object_key as string;

      expect(stored).toMatchObject({ attachment_id: id, size_bytes: bytes.length, sha256: sha256(bytes) });
      expect(key).toMatch(new RegExp(`^${TENANT_A.tenantId}/${CF_UUID.source.slice(1, -1)}\\.pdf$`));
      expect(key).not.toBe(attachmentObjectKey(TENANT_A.tenantId, id, 'Invoice.PDF'));
      expect(stored).not.toHaveProperty('content');
      expect(storage.puts).toEqual([{ bucket: ATTACHMENT_BUCKET, key, bytes, contentType: 'application/pdf' }]);
      expect(await local.get(ATTACHMENT_BUCKET, key)).toEqual(bytes);
      expect(await ledger(TENANT_A.tenantId)).toEqual([]);
      const logged = await select<{ table: string; origin: string; after: string }>(
        `SELECT "table", origin, after FROM <s>.changelog WHERE "table" IN ('attachment', 'program_binding') ORDER BY seq`,
        TENANT_A.tenantId,
      );
      expect(logged.map(({ table, origin }) => ({ table, origin }))).toEqual([
        { table: 'attachment', origin: 'backfill' },
        { table: 'program_binding', origin: 'backfill' },
      ]);
      expect(logged[0]?.after).not.toContain(bytes.toString('hex'));
      expect(await select(`SELECT tenant_id, site_id, legacy_program_id FROM <s>.program_binding`, TENANT_A.tenantId)).toEqual([
        { tenant_id: TENANT_A.tenantId, site_id: TENANT_A.siteId, legacy_program_id: programs },
      ]);
    });

    it('keeps the key and adds no object or ledger row when an unchanged batch is applied again', async () => {
      const row = applyAttachment({ legacy_program_id: 1 });
      const first = await commitAttachment(row);
      const ledgerWrites = (await changes(STAGED_OBJECT.table)).length;
      const second = await commitAttachment(row);
      expect(second).toEqual(first);
      expect(storage.puts.map((put) => put.key)).toEqual([first.object_key, first.object_key]);
      expect(await storedObjects()).toEqual([first.object_key]);
      expect(await local.get(ATTACHMENT_BUCKET, first.object_key as string)).toEqual(bytes);
      expect(await changes(STAGED_OBJECT.table)).toHaveLength(ledgerWrites);
      expect(await ledger()).toEqual([]);
      expect(await select('SELECT attachment_id FROM <s>.attachment')).toHaveLength(1);
    });

    it.each([
      ['an upsert of new bytes', (row: RepositoryRow) => secondVersion(row), v2],
      ['an upsert of the same bytes under a new content type', (row: RepositoryRow) => ({ ...row, content_type: 'application/octet-stream' }), bytes],
    ] as [string, (row: RepositoryRow) => RepositoryRow, Buffer][])(
      'switches the row to a new key on %s and removes the replaced object after commit',
      async (_label, change, expected) => {
        const row = applyAttachment();
        const v1Key = (await commitAttachment(row)).object_key as string;
        const switched = await commitAttachment(change(row));
        const v2Key = switched.object_key as string;

        expect(switched).toMatchObject({ sha256: sha256(expected), size_bytes: expected.length });
        expect(v2Key).not.toBe(v1Key);
        expect(await local.get(ATTACHMENT_BUCKET, v2Key)).toEqual(expected);
        expect(await storedObjects()).toEqual([v2Key]);
        expect(await ledger()).toEqual([]);
        expect(await changes(STAGED_OBJECT.table)).toEqual(
          [
            ['insert', v1Key],
            ['delete', v1Key],
            ['insert', v2Key],
            ['delete', v2Key],
            ['insert', v1Key],
            ['delete', v1Key],
          ].map(([op, key]) => ({ op, origin: 'backfill', key: ledgerKey(key as string) })),
        );
      },
    );

    it.each([
      ['a direct collection', (): Promise<unknown> => collectStagedObjects(repository, tenantId)],
      [
        'the next committed apply of the tenant',
        (): Promise<unknown> => inTenant((tx) => repository.upsert(tx, 'record', { ...newRecord({ legacy_program_id: programs }), record_id: cfUuid() }, BACKFILL)),
      ],
    ] as [string, () => Promise<unknown>][])(
      'keeps the v1 row and bytes when a batch changing them rolls back, and %s removes the staged v2 object',
      async (_label, collect) => {
        const row = applyAttachment();
        const v1Key = (await commitAttachment(row)).object_key as string;
        await expect(
          inTenant(async (tx) => {
            await repository.upsert(tx, 'attachment', secondVersion(row), BACKFILL);
            await repository.upsert(tx, 'attachment', applyAttachment({ sha256: 'f'.repeat(64) }), BACKFILL);
          }),
        ).rejects.toBeInstanceOf(RepositoryError);
        const v2Key = storage.puts[1]?.key as string;

        expect(await select('SELECT object_key, sha256 FROM <s>.attachment')).toEqual([{ object_key: v1Key, sha256: sha256(bytes) }]);
        expect(await local.get(ATTACHMENT_BUCKET, v1Key)).toEqual(bytes);
        expect(await local.get(ATTACHMENT_BUCKET, v2Key)).toEqual(v2);
        expect(await ledger()).toEqual([{ object_key: v2Key, state: 'staged' }]);

        await collect();
        expect(await storedObjects()).toEqual([v1Key]);
        expect(await local.get(ATTACHMENT_BUCKET, v1Key)).toEqual(bytes);
        expect(await ledger()).toEqual([]);
      },
    );

    it.each([
      ['while it stores the bytes', 'put'],
      ['after it wrote the row', 'row'],
    ] as const)('skips the ledger entry of an open apply %s, and collects once it commits', async (_label, pauseAt) => {
      const row = applyAttachment();
      const v1Key = (await commitAttachment(row)).object_key as string;
      const paused = signal();
      const resume = signal();
      const pause = async (): Promise<void> => {
        paused.resolve();
        await resume.promise;
      };
      if (pauseAt === 'put') storage.beforePut = pause;
      const open = inTenant(async (tx) => {
        await repository.upsert(tx, 'attachment', secondVersion(row), BACKFILL);
        if (pauseAt === 'row') await pause();
      });
      await paused.promise;
      const v2Key = storage.puts[1]?.key as string;

      expect(await ledger()).toEqual([{ object_key: v2Key, state: 'staged' }]);
      await expect(collectStagedObjects(repository, tenantId)).resolves.toBe(0);
      expect(await ledger()).toEqual([{ object_key: v2Key, state: 'staged' }]);
      expect(await local.get(ATTACHMENT_BUCKET, v1Key)).toEqual(bytes);
      resume.resolve();
      await open;
      expect(await local.get(ATTACHMENT_BUCKET, v2Key)).toEqual(v2);
      expect(await storedObjects()).toEqual([v2Key]);
      expect(await ledger()).toEqual([]);
    });

    it('commits concurrent attachment applies that hold every apply connection while they stage', async () => {
      const connections = 2;
      const applyPool = handle.connect('app', { max: connections });
      const applyDb = tenantDbFromPool(applyPool, { schema: handle.schema });
      const applying = createFinanceRepository({ db: applyDb, stagingDb, storage, clock: fixedClock(NOW) });
      const applies = Array.from({ length: connections }, (_unused, i) => ({
        tenant: tenantIdForSite(`finance-repository-pool-${tenants}-${i}`),
        row: applyAttachment(),
        held: signal(),
      }));
      const allHeld = Promise.all(applies.map(({ held }) => held.promise));
      const stored = await Promise.all(
        applies.map(({ tenant, row, held }) =>
          applyDb.withTenant(tenant, async (tx) => {
            held.resolve();
            await allHeld;
            expect({ total: applyPool.totalCount, idle: applyPool.idleCount }).toEqual({ total: connections, idle: 0 });
            return applying.upsert<RepositoryRow>(tx, 'attachment', row, BACKFILL);
          }),
        ),
      );

      for (const [i, { tenant, row }] of applies.entries()) {
        const key = stored[i]?.object_key as string;
        expect(await select('SELECT attachment_id, object_key, sha256 FROM <s>.attachment', tenant)).toEqual([
          { attachment_id: row.attachment_id, object_key: key, sha256: sha256(bytes) },
        ]);
        expect(await local.get(ATTACHMENT_BUCKET, key)).toEqual(bytes);
        expect((await changes(STAGED_OBJECT.table, tenant)).map(({ op, origin }) => `${op} ${origin}`)).toEqual(['insert backfill', 'delete backfill']);
        expect(await ledger(tenant)).toEqual([]);
      }
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
      expect(await ledger()).toEqual([]);
    });

    /** Applies a record of `programId` from site `tenant-b` in `tx` as the change feed does. */
    function applyRecord(tx: TenantTx, programId: number): Promise<RepositoryRow> {
      return repository.upsert(tx, 'record', { ...newRecord({ siteid: 'tenant-b', legacy_program_id: programId }), record_id: cfUuid() }, FEED);
    }

    it('binds one program per transaction from the row site with one changelog row in the apply origin', async () => {
      await inTenant(async (tx) => {
        for (let i = 0; i < 5; i += 1) {
          await applyRecord(tx, programs);
        }
        expect(await written(tx)).toEqual(['insert record', 'insert program_binding', ...Array.from({ length: 4 }, () => 'insert record')]);
      });
      expect(await select('SELECT tenant_id, site_id, legacy_program_id FROM <s>.program_binding')).toEqual([
        { tenant_id: tenantId, site_id: 'tenant-b', legacy_program_id: programs },
      ]);
      expect(await changes(PROGRAM_BINDING.table)).toEqual([{ op: 'insert', origin: 'migration-feed', key: encodeKey(PROGRAM_BINDING.columns, PROGRAM_BINDING.key, { legacy_program_id: programs }) }]);
    });

    it.each([
      ['the same transaction', true],
      ['a later transaction', false],
    ])('keeps the first program bound to a tenant when another program is applied in %s', async (_label, together) => {
      const later = programs + 1000;
      if (together) {
        await inTenant(async (tx) => {
          await applyRecord(tx, programs);
          await applyRecord(tx, later);
        });
      } else {
        await inTenant((tx) => applyRecord(tx, programs));
        await inTenant((tx) => applyRecord(tx, later));
      }
      expect(await select('SELECT legacy_program_id FROM <s>.program_binding')).toEqual([{ legacy_program_id: programs }]);
      expect(await changes(PROGRAM_BINDING.table)).toHaveLength(1);
    });

    it('serialises the binding of concurrent applies of one tenant, which both commit', async () => {
      const commitFirst = signal();
      const firstBound = signal();
      const secondStarted = signal<number>();
      const first = inTenant(async (tx) => {
        await applyRecord(tx, programs);
        firstBound.resolve();
        await commitFirst.promise;
      });
      await firstBound.promise;
      const second = inTenant(async (tx) => {
        secondStarted.resolve(await backendPid(tx));
        await applyRecord(tx, programs + 1000);
      });
      await lockWaiting(await secondStarted.promise);
      commitFirst.resolve();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(await select('SELECT legacy_program_id FROM <s>.program_binding')).toEqual([{ legacy_program_id: programs }]);
      expect(await changes(PROGRAM_BINDING.table)).toHaveLength(1);
    });

    it('skips the binding when neither the row nor the registry names a site', async () => {
      await inTenant((tx) => repository.insert(tx, 'rollup', { ...rollup('2026-06', 'APPROVED', 1, '1.0000', programs) }, { origin: 'legacy-window' }));
      expect(await select('SELECT * FROM <s>.rollup')).toHaveLength(1);
      expect(await select('SELECT * FROM <s>.program_binding')).toEqual([]);
      expect(await changes(PROGRAM_BINDING.table)).toEqual([]);
    });

    it('stages bytes on an apply update under a new key and stores nothing when no row matches', async () => {
      const row = applyAttachment();
      const v1Key = (await commitAttachment(row)).object_key as string;
      const replacement = Buffer.from('replacement bytes');
      const patch = { file_name: 'Invoice.PDF', content_type: 'application/pdf', sha256: sha256(replacement), content: replacement };
      const updated = await inTenant((tx) => repository.update<RepositoryRow>(tx, 'attachment', { attachment_id: row.attachment_id }, patch, BACKFILL));
      const missing = await inTenant((tx) => repository.update(tx, 'attachment', { attachment_id: cfUuid() }, patch, BACKFILL));

      expect(updated).toMatchObject({ size_bytes: replacement.length, sha256: sha256(replacement) });
      expect(missing).toBeNull();
      expect(storage.puts.map((put) => put.bytes)).toEqual([bytes, replacement]);
      expect(await storedObjects()).toEqual([updated?.object_key]);
      expect(updated?.object_key).not.toBe(v1Key);
      expect(await ledger()).toEqual([]);
    });

    it('stores and stages nothing when the platform repository rejects the write', async () => {
      await expect(
        inTenant((tx) => repository.replaceOne(tx, 'attachment', { attachment_id: cfUuid() }, applyAttachment(), BACKFILL)),
      ).rejects.toBeInstanceOf(RepositoryError);
      await expect(inTenant((tx) => repository.upsert(tx, 'attachment', applyAttachment()))).rejects.toBeInstanceOf(RepositoryError);
      expect(storage.puts).toEqual([]);
      expect(await ledger()).toEqual([]);
    });

    it('applies target writes without binding a program', async () => {
      const record: FinanceRecordRow = await inTenant((tx) => repository.insertRecord(tx, newRecord({ legacy_program_id: programs })));
      expect(record.legacy_program_id).toBe(programs);
      expect(await select('SELECT * FROM <s>.program_binding')).toEqual([]);
    });
  });
});
