// Unit tests for resetting the live legacy database from a snapshot backup, with fake SQL Server and migration pools.
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '@opt2/platform/logging';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import type { ConnectionPool } from 'mssql';
import { describe, expect, it, vi } from 'vitest';

import type { MigrationEnv } from '../../src/env.js';
import { listLegacyTables, type CatalogPool } from '../../src/extract/catalog.js';
import { MASTER_DATABASE, type LegacyDb } from '../../src/legacy/legacy-db.js';
import { snapshotsDir } from '../../src/paths.js';
import { backupFileName, restoreLiveSql } from '../../src/snapshot/backup.js';
import { restoreLiveFromSnapshot } from '../../src/snapshot/restore.js';
import { SnapshotError, SnapshotNotFoundError, type SnapshotState } from '../../src/snapshot/snapshot.js';

const DATABASE = 'muradb_c26';
const STATE_DIR = path.join(os.tmpdir(), 'opt2-restore-state');
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

interface ExecutedBatch {
  sql: string | undefined;
  timeout: number | undefined;
}

interface TediousRequestLike {
  sqlTextOrProcedure: string | undefined;
  timeout: number | undefined;
  callback: (err?: Error) => void;
}

/** Tedious connection surface a batch drives; `failWith` makes every batch end with that server error. */
class FakeConnection extends EventEmitter {
  readonly batches: ExecutedBatch[] = [];
  failWith: Error | undefined;

  execSqlBatch(request: TediousRequestLike): void {
    this.batches.push({ sql: request.sqlTextOrProcedure, timeout: request.timeout });
    setImmediate(() => request.callback(this.failWith));
  }

  cancel(): void {}
}

/** Legacy port whose pools share one fake connection; `live` and `close` must stay unused. */
function fakeLegacy() {
  const connection = new FakeConnection();
  const opened: string[] = [];
  const pool = (name: string): ConnectionPool =>
    ({
      connected: true,
      config: { database: name },
      acquire(_request: unknown, callback: (err: Error | null, conn: FakeConnection) => void) {
        setImmediate(callback, null, connection);
      },
      release() {},
    }) as unknown as ConnectionPool;
  const legacy = {
    live: vi.fn(() => Promise.reject(new Error('the restore must not use the live pool'))),
    database: vi.fn((name: string) => {
      opened.push(name);
      return Promise.resolve(pool(name));
    }),
    transaction: vi.fn(() => Promise.reject(new Error('the restore runs no transaction'))),
    close: vi.fn(() => Promise.resolve()),
  } satisfies LegacyDb;
  return { legacy, connection, opened };
}

/** A stored row's state; a reservation whose backup never completed carries no LSNs. */
type StoredRow = SnapshotState | { state: SnapshotState; backupCompleted: false };

/** migration.snapshot holding one row per entry of `rows`, read through the snapshot lookup. */
function fakeMigrationDb(rows: ReadonlyMap<number, StoredRow>) {
  const queries: unknown[][] = [];
  const tx = {
    schema: 'migration',
    kind: 'metadata',
    onCommit: () => undefined,
    query: (text: unknown, values?: unknown[]) => {
      queries.push(values ?? []);
      if (!String(text).includes('FROM migration.snapshot AS s WHERE s.seq = $1')) {
        return Promise.reject(new Error(`unexpected statement: ${String(text)}`));
      }
      const seq = values?.[0] as number;
      const stored = rows.get(seq);
      const state = typeof stored === 'object' ? stored.state : stored;
      const completed = typeof stored !== 'object';
      const row =
        state === undefined
          ? []
          : [
              {
                seq,
                kind: 'checkpoint',
                state,
                database_name: `${DATABASE}_opt2_snap_${String(seq)}`,
                backup_file: path.posix.join(snapshotsDir(STATE_DIR), backupFileName(seq)),
                checkpoint_lsn: completed ? '45000000012300001' : null,
                last_lsn: completed ? '45000000013100001' : null,
                taken_at: new Date('2026-06-30T10:00:00'),
                transition_id: null,
                source_sha: '696383140578f8dea3ece26f80cd7bfb370ddf0f',
                manifest_complete: state === 'ready',
                objects: 0,
              },
            ];
      return Promise.resolve({ rows: row, rowCount: row.length });
    },
  } as unknown as MetadataTx;
  const db: TenantDb = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('snapshots are not tenant data')),
    withMetadata: <T>(fn: (metadata: MetadataTx) => Promise<T>): Promise<T> => fn(tx),
    end: () => Promise.resolve(),
  };
  return { db, queries };
}

/** Clock answering each `now()` with the next of `instants`. */
function steppingClock(...instants: string[]) {
  let index = 0;
  return {
    now: () => {
      const instant = instants[Math.min(index, instants.length - 1)];
      index += 1;
      return new Date(instant ?? 0);
    },
  };
}

function fakeContext(rows: ReadonlyMap<number, StoredRow>) {
  const legacy = fakeLegacy();
  const migration = fakeMigrationDb(rows);
  const info = vi.fn();
  const ctx = {
    env: { MURA_DATABASE: DATABASE, OPT2_STATE_DIR: STATE_DIR } as MigrationEnv,
    db: migration.db,
    legacy: legacy.legacy,
    clock: steppingClock('2026-06-30T12:00:00.000', '2026-06-30T12:00:04.250'),
    logger: { info } as unknown as Logger,
  };
  return { ctx, info, legacy, migration };
}

const backupOf = (seq: number): string => path.posix.join(snapshotsDir(STATE_DIR), backupFileName(seq));

/** A refused restore: case label, stored rows, expected error class and message. */
type RefusalCase = readonly [
  label: string,
  rows: ReadonlyMap<number, StoredRow>,
  errorType: typeof SnapshotError | typeof SnapshotNotFoundError,
  message: string,
];

describe('restoreLiveFromSnapshot', () => {
  it.each(['ready', 'failed', 'creating'] as const)(
    'runs one master batch restoring the live database from snapshot backup (%s row)',
    async (state) => {
      const { ctx, legacy } = fakeContext(new Map([[4, state]]));

      const result = await restoreLiveFromSnapshot(ctx, 4);

      const expectedSql = restoreLiveSql(DATABASE, `${STATE_DIR}/snapshots/snap-4.bak`);
      expect(legacy.connection.batches).toEqual([{ sql: expectedSql, timeout: SNAPSHOT_REQUEST_TIMEOUT_MS }]);
      expect(expectedSql).toContain(`ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`);
      expect(expectedSql).toContain('WITH REPLACE, RECOVERY');
      expect(expectedSql).toContain('SET MULTI_USER');
      expect(legacy.opened).toEqual([MASTER_DATABASE]);
      expect(result).toEqual({ seq: 4, database: DATABASE, backupPath: backupOf(4), durationMs: 4250 });
    },
  );

  it('leaves the legacy port open and logs one info line with the sequence, database and duration', async () => {
    const { ctx, info, legacy } = fakeContext(new Map([[2, 'ready']]));

    await restoreLiveFromSnapshot(ctx, 2);

    expect(legacy.legacy.close).not.toHaveBeenCalled();
    expect(legacy.legacy.live).not.toHaveBeenCalled();
    expect(legacy.legacy.transaction).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { latencyMs: 4250 },
      `restored ${DATABASE} from snapshot 2 (${backupOf(2)}) in 4250 ms`,
    );
  });

  it.each<RefusalCase>([
    ['an unknown sequence', new Map<number, SnapshotState>(), SnapshotNotFoundError, 'Snapshot 7 does not exist'],
    [
      'a dropped snapshot',
      new Map<number, SnapshotState>([[7, 'dropped']]),
      SnapshotError,
      `Snapshot 7 was dropped, so its backup ${backupOf(7)} no longer exists`,
    ],
    ...(['creating', 'failed'] as const).map((state) => [
      `a ${state} reservation whose backup never completed`,
      new Map<number, StoredRow>([[7, { state, backupCompleted: false }]]),
      SnapshotError,
      `Snapshot 7 (${state}) has no completed backup, so ${backupOf(7)} cannot be restored`,
    ] as const),
  ])('refuses %s before any SQL Server call', async (_case, rows, errorType, message) => {
    const { ctx, info, legacy, migration } = fakeContext(rows);

    const error = await restoreLiveFromSnapshot(ctx, 7).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(errorType);
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as Error).message).toBe(message);
    expect(migration.queries).toEqual([[7]]);
    expect(legacy.legacy.database).not.toHaveBeenCalled();
    expect(legacy.connection.batches).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('propagates a failed restore without logging success', async () => {
    const { ctx, info, legacy } = fakeContext(new Map([[3, 'ready']]));
    legacy.connection.failWith = new Error('Exclusive access could not be obtained because the database is in use.');

    await expect(restoreLiveFromSnapshot(ctx, 3)).rejects.toThrow('Exclusive access could not be obtained');
    expect(legacy.connection.batches).toHaveLength(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('forgets the memoised catalog of the live database once it is restored', async () => {
    const catalogQueries: string[] = [];
    const livePool: CatalogPool = {
      config: { database: DATABASE.toUpperCase() },
      request: () =>
        ({
          query: (text: string) => {
            catalogQueries.push(text);
            const recordset = text.includes('Updateability')
              ? [{ updateability: 'READ_ONLY' }]
              : [{ schema_name: 'dbo', table_name: 'tsettings' }];
            return Promise.resolve({ recordset });
          },
        }) as unknown as ReturnType<CatalogPool['request']>,
    };
    const { ctx } = fakeContext(new Map([[5, 'ready']]));

    await listLegacyTables(livePool);
    await listLegacyTables(livePool);
    expect(catalogQueries).toHaveLength(2);

    await restoreLiveFromSnapshot(ctx, 5);
    const tables = await listLegacyTables(livePool);

    expect(catalogQueries).toHaveLength(4);
    expect(tables.map((table) => table.qualified)).toEqual(['tsettings']);
  });
});
