/** Keyless content tables: one-occurrence writes keep legacy row multiplicity, and each write logs one whole-row changelog row in its own transaction. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changedColumns,
  encodeRow,
  legacyRowHash,
  type ChangeOrigin,
  type RepositoryRow,
  type TableDefinition,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, type ThrowawaySchema } from '@opt2/platform/testing';
import { actorFromClaims, writeContextFor } from '../../src/domain/context.js';
import { OWNER, createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { DISPLAY_TITLE_APPROVAL, PUBLIC_SUBMISSION_APPROVAL } from '../../src/repo/tables.js';
import { TEST_CLOCK, openContentGates, pgAvailable, withPgSchema } from '../helpers/app.js';
import { IDS, displayTitleApprovalRow, publicSubmissionApprovalRow, seedRows, type DisplayTitleApprovalSeedRow } from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, subjectSessionId } from '../helpers/tokens.js';

/** Columns the platform repository manages on keyless rows; every other column is legacy row content. */
const KEYLESS_MANAGED: ReadonlySet<string> = new Set(['tenant_id', 'legacy_row_hash', 'occurrence']);

const ORIGINS = ['target', 'legacy-window'] as const satisfies readonly ChangeOrigin[];

const SITE_ADMIN = SUBJECT_CLAIMS['site-admin'];

const ACTOR = actorFromClaims(
  {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: SUBJECT_USER_IDS['site-admin'],
    sid: subjectSessionId('site-admin'),
    tid: SITE_ADMIN.tid,
    site: SITE_ADMIN.site,
    roles: [...SITE_ADMIN.roles],
    s2: SITE_ADMIN.s2,
    epoch: 1,
    iat: 0,
    exp: 0,
  },
  'Test Admin',
);

type ApprovalRowBuilder = (overrides?: Partial<DisplayTitleApprovalSeedRow>) => RepositoryRow;

const TABLES: ReadonlyArray<{ name: string; table: TableDefinition; build: ApprovalRowBuilder }> = [
  { name: DISPLAY_TITLE_APPROVAL.table, table: DISPLAY_TITLE_APPROVAL, build: displayTitleApprovalRow },
  { name: PUBLIC_SUBMISSION_APPROVAL.table, table: PUBLIC_SUBMISSION_APPROVAL, build: publicSubmissionApprovalRow },
];

/** A `changelog` row as stored, `xid` as decimal text. */
interface ChangelogRow {
  xid: string;
  op: string;
  key: string;
  before: string | null;
  after: string | null;
  columns: string[];
  origin: string;
  actor_user_id: string | null;
  actor_service: string | null;
}

/** Two identical seeded rows (occurrences 1 and 2) and a distinct control row, as content rows and as stored. */
interface Duplicates {
  duplicate: RepositoryRow;
  control: RepositoryRow;
  low: RepositoryRow;
  high: RepositoryRow;
  storedControl: RepositoryRow;
}

const writeContext = (origin: ChangeOrigin): WriteContext => ({ ...writeContextFor(ACTOR), origin });

describe.skipIf(!(await pgAvailable()))('keyless content tables: multiplicity and changelog', () => {
  let handle: ThrowawaySchema;
  let repository: ContentRepository;
  let fixtureSeq = 0;

  const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

  /** The id of `tx`'s transaction, assigned now so every later write of `tx` carries it. */
  async function xidOf(tx: TenantTx): Promise<string> {
    const { rows } = await tx.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid');
    return (rows[0] as { xid: string }).xid;
  }

  beforeAll(async () => {
    handle = await withPgSchema();
    await openContentGates(handle);
    repository = createContentRepository({ clock: TEST_CLOCK, schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  describe.each(TABLES)('$name', ({ table, build }) => {
    const data = table.columns.filter((column) => !KEYLESS_MANAGED.has(column.name));
    const dataNames = data.map((column) => column.name);

    /** Seeds the duplicates and the control row under emails no other test uses. */
    async function seedDuplicates(): Promise<Duplicates> {
      fixtureSeq += 1;
      const duplicate = build({ contentid: IDS.content.pageOne, isapproved: 0, email: `duplicate-${fixtureSeq}@example.org`, siteid: TENANT_A.siteId });
      const control = build({ contentid: IDS.content.pageTwo, isapproved: 0, email: `control-${fixtureSeq}@example.org`, siteid: TENANT_A.siteId });
      const stored = await seedRows(handle, TENANT_A, [duplicate, duplicate, control].map((row) => ({ table, row })));
      const [low, high, storedControl] = stored as [RepositoryRow, RepositoryRow, RepositoryRow];
      return { duplicate, control, low, high, storedControl };
    }

    /** The fixture's stored rows, by hash then occurrence. */
    function rowsOf(f: Duplicates): Promise<RepositoryRow[]> {
      return inA(async (tx) => {
        const sql = `SELECT * FROM ${handle.schema}.${table.table} WHERE email = ANY($1::text[]) ORDER BY legacy_row_hash, occurrence`;
        return (await tx.query(sql, [[f.duplicate.email, f.control.email]])).rows;
      });
    }

    /** Rows of `rows` whose legacy content encodes as `content` does. */
    function matching(rows: readonly RepositoryRow[], content: RepositoryRow): RepositoryRow[] {
      return rows.filter((row) => encodeRow(data, row) === encodeRow(data, content));
    }

    /** This table's changelog rows written by transaction `xid`, in order; read directly, as readChanges' cluster-wide horizon can lag behind other sessions. */
    async function changesIn(tx: TenantTx, xid: string): Promise<ChangelogRow[]> {
      const sql =
        'SELECT xid::text AS xid, op, key, before, after, columns, origin, actor_user_id, actor_service' +
        ` FROM ${handle.schema}.changelog WHERE xid = $1::xid8 AND "table" = $2 ORDER BY seq`;
      return (await tx.query<ChangelogRow>(sql, [xid, table.table])).rows;
    }

    /** Runs `fn` in one tenant-a transaction; returns its result, the transaction id and, after commit, the changes it logged. */
    async function logged<T>(fn: (tx: TenantTx) => Promise<T>): Promise<{ result: T; xid: string; changes: ChangelogRow[] }> {
      const { result, xid } = await inA(async (tx) => ({ xid: await xidOf(tx), result: await fn(tx) }));
      return { result, xid, changes: await inA((tx) => changesIn(tx, xid)) };
    }

    /** Count of this table's committed changelog rows. */
    async function changeCount(): Promise<number> {
      return inA(async (tx) => {
        const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.changelog WHERE "table" = $1`, [table.table]);
        return (rows[0] as { n: number }).n;
      });
    }

    it('replaceOne changes one of two identical rows, keeps the other occurrence and leaves the control row', async () => {
      const f = await seedDuplicates();
      const after = { ...f.duplicate, isapproved: 1 };
      const replaced = await inA((tx) => repository.platform.replaceOne(tx, table.table, f.duplicate, after, writeContext('target')));
      const rows = await rowsOf(f);
      expect(rows).toHaveLength(3);
      expect(matching(rows, f.duplicate)).toEqual([f.low]);
      expect(matching(rows, after)).toEqual([replaced]);
      expect(matching(rows, f.control)).toEqual([f.storedControl]);
      expect(new Set(rows.map((row) => `${String(row.legacy_row_hash)}/${String(row.occurrence)}`)).size).toBe(3);
      for (const row of rows) {
        expect(row.legacy_row_hash).toBe(legacyRowHash(data, row));
      }
    });

    it('deleteOne removes one occurrence at a time, highest first, until none is left, and leaves the control row', async () => {
      const f = await seedDuplicates();
      const ctx = writeContext('target');
      expect(await inA((tx) => repository.platform.deleteOne(tx, table.table, f.duplicate, ctx))).toEqual(f.high);
      expect(matching(await rowsOf(f), f.duplicate)).toEqual([f.low]);
      expect(await inA((tx) => repository.platform.deleteOne(tx, table.table, f.duplicate, ctx))).toEqual(f.low);
      expect(matching(await rowsOf(f), f.duplicate)).toEqual([]);
      expect(await inA((tx) => repository.platform.deleteOne(tx, table.table, f.duplicate, ctx))).toBeNull();
      expect(await rowsOf(f)).toEqual([f.storedControl]);
    });

    it('insert of a third identical row adds occurrence 3 under the same legacy_row_hash', async () => {
      const f = await seedDuplicates();
      const inserted = await inA((tx) => repository.platform.insert(tx, table.table, f.duplicate, writeContext('target')));
      const duplicates = matching(await rowsOf(f), f.duplicate);
      expect(duplicates.map((row) => row.occurrence)).toEqual([1, 2, 3]);
      expect(new Set(duplicates.map((row) => row.legacy_row_hash))).toEqual(new Set([legacyRowHash(data, f.duplicate)]));
      expect(duplicates[2]).toEqual(inserted);
    });

    it.each(ORIGINS)('replaceOne logs one update with the whole-row key, both stored images and the changed column (origin %s)', async (origin) => {
      const f = await seedDuplicates();
      const after = { ...f.duplicate, isapproved: 1 };
      const { result, xid, changes } = await logged((tx) => repository.platform.replaceOne(tx, table.table, f.duplicate, after, writeContext(origin)));
      expect(result).not.toBeNull();
      expect(changedColumns(data, f.duplicate, after)).toEqual(['isapproved']);
      expect(changes).toEqual([
        {
          xid,
          op: 'update',
          key: encodeRow(data, f.duplicate),
          before: encodeRow(table.columns, f.high),
          after: encodeRow(table.columns, result as RepositoryRow),
          columns: changedColumns(data, f.duplicate, after),
          origin,
          actor_user_id: ACTOR.userId,
          actor_service: OWNER,
        },
      ]);
    });

    it.each(ORIGINS)('deleteOne logs one delete with the whole-row key and the removed occurrence as before image (origin %s)', async (origin) => {
      const f = await seedDuplicates();
      const { xid, changes } = await logged((tx) => repository.platform.deleteOne(tx, table.table, f.duplicate, writeContext(origin)));
      expect(changes).toEqual([
        {
          xid,
          op: 'delete',
          key: encodeRow(data, f.duplicate),
          before: encodeRow(table.columns, f.high),
          after: null,
          columns: dataNames,
          origin,
          actor_user_id: ACTOR.userId,
          actor_service: OWNER,
        },
      ]);
    });

    it.each(ORIGINS)('insert logs one insert with the whole-row key and the new occurrence as after image (origin %s)', async (origin) => {
      const f = await seedDuplicates();
      const { result, xid, changes } = await logged((tx) => repository.platform.insert(tx, table.table, f.duplicate, writeContext(origin)));
      expect(result.occurrence).toBe(3);
      expect(changes).toEqual([
        {
          xid,
          op: 'insert',
          key: encodeRow(data, f.duplicate),
          before: null,
          after: encodeRow(table.columns, result),
          columns: dataNames,
          origin,
          actor_user_id: ACTOR.userId,
          actor_service: OWNER,
        },
      ]);
    });

    it('a rolled-back replaceOne and insert leave the rows and the changelog unchanged', async () => {
      const f = await seedDuplicates();
      const rowsBefore = await rowsOf(f);
      const countBefore = await changeCount();
      const failure = new Error('abort after the writes');
      const ctx = writeContext('target');
      let changesInTransaction: ChangelogRow[] = [];
      await expect(
        inA(async (tx) => {
          const xid = await xidOf(tx);
          await repository.platform.replaceOne(tx, table.table, f.duplicate, { ...f.duplicate, isapproved: 1 }, ctx);
          await repository.platform.insert(tx, table.table, f.duplicate, ctx);
          changesInTransaction = await changesIn(tx, xid);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(changesInTransaction.map((change) => change.op)).toEqual(['update', 'insert']);
      expect(matching(rowsBefore, f.duplicate)).toHaveLength(2);
      expect(await rowsOf(f)).toEqual(rowsBefore);
      expect(await changeCount()).toBe(countBefore);
    });
  });
});
