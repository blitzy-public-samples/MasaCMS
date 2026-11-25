// Reverse projection of keyless legacy tables: a delete or update matches exactly one legacy row on its full
// before-image, every column null-aware, so duplicate rows keep their multiplicity.
import { readFileSync } from 'node:fs';

import {
  CURSOR_START,
  canonicalTypeForSqlServer,
  changedColumns,
  decodeRow,
  encodeRow,
  formatCursor,
  isApplied,
  legacyRowHash,
  multiset,
  type CanonicalColumn,
  type ChangeOrigin,
  type ChangeRow,
  type ProjectedChangeRow,
} from '@opt2/platform/migration-kit';
import { TENANT_A, pgAvailable } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MigrationContext } from '../src/context.js';
import { readTableCatalog } from '../src/extract/catalog.js';
import { ProjectionConflictError, applyLegacyChange, decodeLegacyChange, type ApplyLegacyOptions, type LegacyChange } from '../src/reverse/apply-legacy.js';
import { CHECKPOINT_TABLE, createProjector, readCheckpoints, type CheckpointRow, type StartupGuardRunner } from '../src/reverse/index.js';

import { buildTestContext, type TestContext } from './helpers/context.js';
import { createFakeLegacyDb, type FakeLegacyDb, type LegacyColumnDef, type Row, type StatementRecord } from './helpers/fake-legacy-db.js';
import {
  FIXTURE_CATALOG,
  FIXTURE_GROUP_IDS,
  MAILINGLIST_MEMBERS_MAPPING,
  TABLES,
  UNITS,
  defineFixtureTables,
  fixtureVersion,
  mailingListMemberRow,
  mailingListRow,
  siteRow,
} from './helpers/fixtures.js';
import type { OwnerDoubleState, ScriptedChangesPage } from './helpers/owner-double.js';
import { PG_OWNER_ROWS_PATH, fetchPgOwnerRows, startPgOwner, type PgOwner } from './helpers/pg-owner.js';

const OWNER = 'programs-sites';
const MEMBERS = TABLES.tmailinglistmembers;
const LISTS = TABLES.tmailinglist;
const MEMBER_UNIT = UNITS.mailingListMember;
const LIST_UNIT = UNITS.mailingList;
const MEMBER_TARGET_TABLE = MEMBER_UNIT.slice(MEMBER_UNIT.indexOf('.') + 1);
const SYNC_SQL = readFileSync(new URL('../sql/005_opt2_sync.sql', import.meta.url), 'utf8');

/** Both mailing-list units `target`-authoritative, every other group `legacy`. */
const VERSION = fixtureVersion('v0201', { [FIXTURE_GROUP_IDS.mailingLists]: 'target' });

/** No batch here touches `tcontent`, so the start-up guard is never entered. */
const UNUSED_GUARD: StartupGuardRunner = { run: () => Promise.reject(new Error('no batch here touches tcontent')) };

/** Columns of a fake table in catalog order, typed as the fake's multiset and the owners encode them. */
function canonicalColumns(columns: readonly LegacyColumnDef[]): CanonicalColumn[] {
  return columns.map((column) => ({ name: column.name, ...canonicalTypeForSqlServer(column.type) }));
}

const MEMBER_COLUMNS = canonicalColumns(MEMBERS.columns);

/** R three times, R′ differing from R only by NULL against '' in `company`, and an unrelated row U. */
const R = mailingListMemberRow({ Email: null, company: '' });
const R_PRIME = { ...R, company: null };
const R_STAR = { ...R, fname: 'Renamed' };
const U = mailingListMemberRow({ Email: 'unrelated@example.test' });
const MISSING = { ...R, fname: 'Nobody' };
const SEEDED_MEMBERS: readonly Row[] = [R, R, R, R_PRIME, U];

/** 70 000 characters with `:` and control characters, and a value of the same length differing only in its last character. */
const DESCRIPTION_PATTERN = 'Subscribers: weekly\u0001digest\t\r\n\u001f:';
const DESCRIPTION = DESCRIPTION_PATTERN.repeat(Math.ceil(70_000 / DESCRIPTION_PATTERN.length)).slice(0, 70_000);
const OTHER_DESCRIPTION = `${DESCRIPTION.slice(0, -1)}#`;
const L = mailingListRow({ Description: DESCRIPTION });
const L_OTHER = mailingListRow({ Description: OTHER_DESCRIPTION });

const MEMBER_DELETE = /^DELETE TOP \(1\) FROM \[dbo\]\.\[tmailinglistmembers\] WHERE /;
const MEMBER_INSERT = /^INSERT INTO \[dbo\]\.\[tmailinglistmembers\] /;
const isMemberWrite = (statement: StatementRecord): boolean => /^(?:DELETE|INSERT|UPDATE)\b[^;]*\[tmailinglistmembers\]/.test(statement.sql);
const isCheckpointUpsert = (statement: StatementRecord): boolean => statement.sql.startsWith(`UPDATE ${CHECKPOINT_TABLE}`);

/** The exact multiset `FakeLegacyDb.multiset` reports for rows held with these occurrence counts. */
function expectedMultiset(columns: readonly CanonicalColumn[], counts: ReadonlyArray<readonly [Row, number]>): Map<string, number> {
  return new Map(counts.map(([row, count]) => [encodeRow(columns, row), count]));
}

/** Every committed row of a fake table as its whole-row encoding, one entry per occurrence. */
function legacyEncodings(legacy: FakeLegacyDb, table: string): string[] {
  return [...legacy.multiset(table)].flatMap(([encoding, count]) => Array.from({ length: count }, () => encoding));
}

interface ChangeSpec {
  unit: string;
  legacyTable: string;
  columns: readonly CanonicalColumn[];
  xid: number;
  seq: number;
  op: ChangeRow['op'];
  before?: Row;
  after?: Row;
  origin?: ChangeOrigin;
}

/** A changelog row of a keyless unit with its legacy projection: whole-row key, legacy-form images and changed columns. */
function changeRow(spec: ChangeSpec): ProjectedChangeRow {
  const before = spec.before === undefined ? null : encodeRow(spec.columns, spec.before);
  const after = spec.after === undefined ? null : encodeRow(spec.columns, spec.after);
  const key = before ?? after ?? '';
  const columns =
    spec.before !== undefined && spec.after !== undefined ? changedColumns(spec.columns, spec.before, spec.after) : spec.columns.map((column) => column.name);
  return {
    xid: String(spec.xid),
    seq: String(spec.seq),
    table: spec.unit.slice(spec.unit.indexOf('.') + 1),
    op: spec.op,
    key,
    before,
    after,
    columns,
    origin: spec.origin ?? 'target',
    actorUserId: null,
    actorService: OWNER,
    at: '2026-06-30 12:00:00.000',
    requestId: null,
    operationId: null,
    legacy: [{ unit: spec.unit, legacyTable: spec.legacyTable, key, before, after, columns }],
  };
}

/** A `tmailinglistmembers` change at `<xid>:<seq>`. */
function member(xid: number, seq: number, op: ChangeRow['op'], images: Pick<ChangeSpec, 'before' | 'after'>, origin?: ChangeOrigin): ProjectedChangeRow {
  return changeRow({ unit: MEMBER_UNIT, legacyTable: 'tmailinglistmembers', columns: MEMBER_COLUMNS, xid, seq, op, ...images, ...(origin === undefined ? {} : { origin }) });
}

/** A fresh legacy database holding `tmailinglistmembers` with the seeded duplicates, its logs cleared. */
function membersLegacy(): FakeLegacyDb {
  const legacy = createFakeLegacyDb();
  defineFixtureTables(legacy, ['tmailinglistmembers']);
  legacy.seed(MEMBERS.qualified, SEEDED_MEMBERS);
  legacy.clearLogs();
  return legacy;
}

/** Ownership and live-catalog options of one change, as the projector builds them. */
async function applyOptions(legacy: FakeLegacyDb, change: LegacyChange): Promise<ApplyLegacyOptions> {
  const target = FIXTURE_CATALOG.unitsForLegacyTable(change.legacyTable).find((entry) => entry.unit === change.unit);
  if (target === undefined) throw new Error(`unit ${change.unit} takes no rows of ${change.legacyTable}`);
  const siteColumn = FIXTURE_CATALOG.siteColumnOf(change.legacyTable);
  return {
    tableCatalog: await readTableCatalog(await legacy.live(), change.physicalTable),
    target,
    split: FIXTURE_CATALOG.isSplit(change.legacyTable),
    ownedColumns: target.ownedColumns,
    keyColumns: FIXTURE_CATALOG.keyColumnsOf(change.legacyTable),
    ...(siteColumn === null ? {} : { siteColumn }),
  };
}

/** Decodes `rows` for `unit` and writes them, in order, in one legacy transaction. */
async function applyBatch(legacy: FakeLegacyDb, unit: string, columns: readonly CanonicalColumn[], rows: readonly ProjectedChangeRow[]): Promise<void> {
  const planned: Array<{ change: LegacyChange; options: ApplyLegacyOptions }> = [];
  for (const row of rows) {
    const change = decodeLegacyChange(row, { owner: OWNER, tenantId: TENANT_A.tenantId, unit, columns });
    if (change === null) throw new Error(`changelog row ${row.xid}:${row.seq} has no projection for ${unit}`);
    planned.push({ change, options: await applyOptions(legacy, change) });
  }
  await legacy.transaction(async (tx) => {
    for (const { change, options } of planned) await applyLegacyChange(tx, change, options);
  });
}

/** Asserts that `statement` binds every value: its placeholders are exactly its parameters and no value appears in its text. */
function expectParameterised(statement: StatementRecord, images: readonly Row[]): void {
  const placeholders = [...new Set(statement.sql.match(/@p\d+/g) ?? [])].sort();
  expect(placeholders).toEqual(Object.keys(statement.params).map((name) => `@${name}`).sort());
  for (const value of images.flatMap((image) => Object.values(image))) {
    if (typeof value === 'string' && value !== '') expect(statement.sql).not.toContain(value.slice(0, 64));
  }
}

describe('keyless legacy writer', () => {
  const SEEDED: ReadonlyArray<readonly [Row, number]> = [
    [R, 3],
    [R_PRIME, 1],
    [U, 1],
  ];

  it.each([
    {
      name: 'a delete of R removes one of its three occurrences and leaves R′ and U',
      rows: [member(1, 1, 'delete', { before: R })],
      expected: [[R, 2], [R_PRIME, 1], [U, 1]] as const,
      deletes: 1,
      inserts: 0,
    },
    {
      name: "a delete of R′ removes R′ alone, since NULL never matches ''",
      rows: [member(1, 1, 'delete', { before: R_PRIME })],
      expected: [[R, 3], [U, 1]] as const,
      deletes: 1,
      inserts: 0,
    },
    {
      name: 'an update of R removes one occurrence and inserts the after-image once',
      rows: [member(1, 1, 'update', { before: R, after: R_STAR })],
      expected: [[R, 2], [R_PRIME, 1], [U, 1], [R_STAR, 1]] as const,
      deletes: 1,
      inserts: 1,
    },
    {
      name: 'two deletes of R in one batch remove two occurrences',
      rows: [member(1, 1, 'delete', { before: R }), member(1, 2, 'delete', { before: R })],
      expected: [[R, 1], [R_PRIME, 1], [U, 1]] as const,
      deletes: 2,
      inserts: 0,
    },
    {
      name: 'an insert identical to existing rows adds exactly one occurrence',
      rows: [member(1, 1, 'insert', { after: R })],
      expected: [[R, 4], [R_PRIME, 1], [U, 1]] as const,
      deletes: 0,
      inserts: 1,
    },
  ])('$name', async ({ rows, expected, deletes, inserts }) => {
    const legacy = membersLegacy();
    await applyBatch(legacy, MEMBER_UNIT, MEMBER_COLUMNS, rows);

    expect(legacy.multiset(MEMBERS.qualified)).toEqual(expectedMultiset(MEMBER_COLUMNS, expected));
    const writes = legacy.statements.filter(isMemberWrite);
    expect(writes.filter((statement) => MEMBER_DELETE.test(statement.sql))).toHaveLength(deletes);
    expect(writes.filter((statement) => MEMBER_INSERT.test(statement.sql))).toHaveLength(inserts);
    expect(writes).toHaveLength(deletes + inserts);
    for (const statement of writes) expectParameterised(statement, [R, R_PRIME, R_STAR, U]);
    expect(legacy.commits).toHaveLength(1);
    expect(legacy.commits[0]?.statements.filter(isMemberWrite)).toEqual(writes);
  });

  it("matches a NULL column with IS NULL and an '' column by value and byte length under a binary collation", async () => {
    const legacy = membersLegacy();
    await applyBatch(legacy, MEMBER_UNIT, MEMBER_COLUMNS, [member(1, 1, 'delete', { before: R_PRIME })]);
    await applyBatch(legacy, MEMBER_UNIT, MEMBER_COLUMNS, [member(2, 1, 'delete', { before: R })]);

    const [primeDelete, rDelete] = legacy.statements.filter((statement) => MEMBER_DELETE.test(statement.sql));
    expect(primeDelete?.sql).toContain('[Email] IS NULL');
    expect(primeDelete?.sql).toContain('[company] IS NULL');
    expect(rDelete?.sql).toContain('[Email] IS NULL');
    expect(rDelete?.sql).toMatch(/\(\[company\] COLLATE Latin1_General_BIN2 = (@p\d+) AND DATALENGTH\(\[company\]\) = DATALENGTH\(\1\)\)/);
    expect(Object.values(rDelete?.params ?? {})).toContain('');
    expect(legacy.multiset(MEMBERS.qualified)).toEqual(expectedMultiset(MEMBER_COLUMNS, [[R, 2], [U, 1]]));
  });

  it.each(['delete', 'update'] as const)(
    '%s of a before-image no row matches raises ProjectionConflictError and rolls the whole batch back',
    async (op) => {
      const legacy = membersLegacy();
      const conflicting = op === 'delete' ? member(1, 2, op, { before: MISSING }) : member(1, 2, op, { before: MISSING, after: R_STAR });
      const failure = await applyBatch(legacy, MEMBER_UNIT, MEMBER_COLUMNS, [member(1, 1, 'delete', { before: R }), conflicting]).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ProjectionConflictError);
      expect(failure).toMatchObject({ table: 'tmailinglistmembers', op, key: encodeRow(MEMBER_COLUMNS, MISSING) });
      expect(legacy.statements.filter((statement) => MEMBER_DELETE.test(statement.sql))).toHaveLength(2);
      expect(legacy.statements.filter((statement) => MEMBER_INSERT.test(statement.sql))).toEqual([]);
      expect(legacy.commits).toEqual([]);
      expect(legacy.multiset(MEMBERS.qualified)).toEqual(expectedMultiset(MEMBER_COLUMNS, SEEDED));
    },
  );

  describe.each([
    { label: 'nvarchar(max)', column: { name: 'Description', type: 'nvarchar', length: 'max' } satisfies LegacyColumnDef, cast: false },
    { label: 'ntext', column: { name: 'Description', type: 'ntext' } satisfies LegacyColumnDef, cast: true },
  ])('tmailinglist with Description as $label', ({ column, cast }) => {
    const columns = LISTS.columns.map((candidate) => (candidate.name === column.name ? column : candidate));
    const listColumns = canonicalColumns(columns);

    it('a delete with a 70 000-character Description removes exactly one of two identical rows', async () => {
      const legacy = createFakeLegacyDb();
      legacy.defineTable(LISTS.qualified, columns, LISTS.options);
      legacy.seed(LISTS.qualified, [L, L, L_OTHER]);
      legacy.clearLogs();

      await applyBatch(legacy, LIST_UNIT, listColumns, [
        changeRow({ unit: LIST_UNIT, legacyTable: 'tmailinglist', columns: listColumns, xid: 1, seq: 1, op: 'delete', before: L }),
      ]);

      expect(legacy.multiset(LISTS.qualified)).toEqual(expectedMultiset(listColumns, [[L, 1], [L_OTHER, 1]]));
      const deletes = legacy.statements.filter((statement) => /^DELETE\b/.test(statement.sql));
      expect(deletes).toHaveLength(1);
      const [deleted] = deletes as [StatementRecord];
      expect(deleted.sql).toMatch(/^DELETE TOP \(1\) FROM \[dbo\]\.\[tmailinglist\] WHERE /);
      expect(deleted.sql.includes('CAST([Description] AS nvarchar(max))')).toBe(cast);
      expect(deleted.sql.length).toBeLessThan(2_000);
      expect(Object.values(deleted.params)).toContain(DESCRIPTION);
      expectParameterised(deleted, [L, L_OTHER]);
    });
  });
});

type MigrationDb = MigrationContext['db'];
type MetadataTx = Parameters<Parameters<MigrationDb['withMetadata']>[0]>[0];

/** Migration pool answering only the projector's advisory lock, always granted, and its `projector_cursor` mirror upsert. */
function fakeMigrationDb(): { db: MigrationDb; mirror: Map<string, string> } {
  const mirror = new Map<string, string>();
  const query = (text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (text.startsWith('SELECT pg_try_advisory_xact_lock(')) return Promise.resolve({ rows: [{ ok: true }] });
    if (text.startsWith('INSERT INTO "migration"."projector_cursor"')) {
      mirror.set(String(values[0]), String(values[2]));
      return Promise.resolve({ rows: [] });
    }
    return Promise.reject(new Error(`unexpected PostgreSQL statement: ${text}`));
  };
  const tx = { schema: 'migration', kind: 'metadata', onCommit: () => undefined, query } as unknown as MetadataTx;
  const db: MigrationDb = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('the projector acts for no tenant on the migration pool')),
    withMetadata: (fn) => fn(tx),
    end: () => Promise.resolve(),
  };
  return { db, mirror };
}

/** The checkpoint of the programs-sites stream of tenant-a. */
async function tenantCheckpoint(legacy: FakeLegacyDb): Promise<CheckpointRow | undefined> {
  const rows = await readCheckpoints(await legacy.live(), { owners: [OWNER] });
  return rows.find((row) => row.tenantId.toLowerCase() === TENANT_A.tenantId.toLowerCase());
}

/** A legacy database with the tenant-a site, the given members and the checkpoint table, its logs cleared. */
async function projectedLegacy(members: readonly Row[]): Promise<FakeLegacyDb> {
  const legacy = createFakeLegacyDb();
  defineFixtureTables(legacy, ['tsettings', 'tmailinglistmembers']);
  legacy.seed(TABLES.tsettings.qualified, [siteRow(TENANT_A.siteId)]);
  legacy.seed(MEMBERS.qualified, members);
  await (await legacy.live()).request().batch(SYNC_SQL);
  legacy.clearLogs();
  return legacy;
}

describe('reverse projector batch over keyless rows', () => {
  const HORIZON = 810;
  const UPDATE_R = member(801, 1, 'update', { before: R, after: R_STAR });
  const DELETE_R = member(801, 2, 'delete', { before: R });
  const DELETE_R_PRIME = member(802, 1, 'delete', { before: R_PRIME });
  const opened = new Set<TestContext>();

  afterAll(async () => {
    for (const tc of opened) await tc.close();
  });

  it.each([
    { name: 'target rows only', rows: [UPDATE_R, DELETE_R, DELETE_R_PRIME], end: { xid: 802n, seq: 1n }, skipped: 0 },
    {
      name: 'target rows interleaved with rows of origins legacy already holds',
      rows: [
        member(800, 1, 'insert', { after: U }, 'backfill'),
        UPDATE_R,
        DELETE_R,
        member(801, 3, 'delete', { before: U }, 'legacy-window'),
        DELETE_R_PRIME,
        member(803, 1, 'insert', { after: R_PRIME }, 'migration-feed'),
      ],
      end: { xid: 803n, seq: 1n },
      skipped: 3,
    },
  ])('commits one batch of $name with its checkpoint and keeps one R, one R* and U', async ({ rows, end, skipped }) => {
    const legacy = await projectedLegacy(SEEDED_MEMBERS);
    const migration = fakeMigrationDb();
    const tc = await buildTestContext({
      legacy,
      migrationDb: migration.db,
      bridge: false,
      cutover: { versions: [VERSION] },
      gateway: { active: VERSION.tableVersion },
    });
    opened.add(tc);
    if (tc.owners === null) throw new Error('the test context has no owner doubles');
    const owner: OwnerDoubleState = tc.owners.owner(OWNER);
    owner.seedRows('tmailinglistmembers', TENANT_A.tenantId, [], MEMBER_COLUMNS);
    const page: ScriptedChangesPage = { rows, cursor: formatCursor(end), horizon: String(HORIZON), complete: true };
    owner.changesScript.set(TENANT_A.tenantId, [page]);

    const result = await createProjector(tc.ctx, { startupGuard: UNUSED_GUARD }).runOnce();

    expect(result).toMatchObject({ leader: true, ran: true, batches: 1, rowsApplied: 3, skipped, held: 0, errors: [] });
    expect(owner.changesCalls.map((call) => call.after)).toEqual([CURSOR_START]);
    expect(legacy.multiset(MEMBERS.qualified)).toEqual(expectedMultiset(MEMBER_COLUMNS, [[R, 1], [R_STAR, 1], [U, 1]]));
    expect(await tenantCheckpoint(legacy)).toMatchObject({
      cursorXid: end.xid.toString(),
      cursorSeq: end.seq.toString(),
      appliedHorizon: String(HORIZON),
      rowsApplied: 3,
    });
    expect(migration.mirror.get(OWNER)).toBe(formatCursor(end));

    const writes = legacy.statements.filter(isMemberWrite);
    expect(writes.filter((statement) => MEMBER_DELETE.test(statement.sql))).toHaveLength(3);
    expect(writes.filter((statement) => MEMBER_INSERT.test(statement.sql))).toHaveLength(1);
    expect(writes).toHaveLength(4);
    const batches = legacy.commits.filter((commit) => commit.statements.some(isCheckpointUpsert));
    expect(batches).toHaveLength(1);
    expect(legacy.commits.filter((commit) => commit.statements.some(isMemberWrite))).toEqual(batches);
    expect(batches[0]?.statements.filter(isMemberWrite)).toEqual(writes);
  });
});

const PG = await pgAvailable();

describe.skipIf(!PG)(`keyless reverse projection from a PostgreSQL owner${PG ? '' : ' (requires PostgreSQL: PG_* unset)'}`, () => {
  /** Projector cycles driven until a write is projected; other sessions on a shared cluster can hold the horizon back. */
  const MAX_CYCLES = 200;
  const CYCLE_PAUSE_MS = 50;
  let owner: PgOwner | undefined;
  let tc: TestContext | undefined;

  /** A legacy row in the owner's target column names, valued as the owner decodes a legacy encoding. */
  function targetRow(row: Row): Record<string, unknown> {
    const decoded = decodeRow(MEMBER_COLUMNS, encodeRow(MEMBER_COLUMNS, row));
    return Object.fromEntries(MAILINGLIST_MEMBERS_MAPPING.columns.map((column) => [column.target, decoded[column.legacy] ?? null]));
  }

  async function targetEncodings(started: PgOwner): Promise<string[]> {
    const encodings: string[] = [];
    for await (const page of started.ownersClient.exportPages(OWNER, { unit: MEMBER_UNIT, tenantId: TENANT_A.tenantId })) {
      for (const table of page.tables) encodings.push(...table.rows.map((row) => row.row));
    }
    return encodings;
  }

  beforeAll(async () => {
    owner = await startPgOwner({ owner: OWNER, mappings: [MAILINGLIST_MEMBERS_MAPPING], tenants: [TENANT_A] });
    await owner.openGates();
    tc = await buildTestContext({
      legacy: await projectedLegacy([R, R, R, U]),
      owners: owner.ownersClient,
      migrationDb: true,
      bridge: false,
      cutover: { versions: [VERSION] },
      gateway: { active: VERSION.tableVersion },
    });
  });

  afterAll(async () => {
    await tc?.close();
    await owner?.close();
  });

  it('projects a target deleteOne and replaceOne of backfilled duplicates so legacy and target hold one multiset', async () => {
    if (owner === undefined || tc === undefined) throw new Error('the PostgreSQL owner did not start');
    const started = owner;
    const { legacy } = tc;
    await started.ownersClient.apply(OWNER, {
      batchId: 'reverse-nokey-backfill',
      origin: 'backfill',
      legacyTable: 'tmailinglistmembers',
      tenantId: TENANT_A.tenantId,
      columns: MEMBER_COLUMNS,
      rows: [R, R, R, U].map((row) => ({ op: 'insert', row: encodeRow(MEMBER_COLUMNS, row) })),
    });
    expect(multiset(await targetEncodings(started))).toEqual(multiset(legacyEncodings(legacy, MEMBERS.qualified)));

    const deleted = await started.write((tx, repo) => repo.deleteOne(tx, MEMBER_TARGET_TABLE, targetRow(R)));
    const replaced = await started.write((tx, repo) => repo.replaceOne(tx, MEMBER_TARGET_TABLE, targetRow(R), targetRow(R_STAR)));
    expect(deleted.result).not.toBeNull();
    expect(replaced.result).not.toBeNull();

    const projector = createProjector(tc.ctx, { startupGuard: UNUSED_GUARD });
    const projected = (row: CheckpointRow | undefined): boolean => row !== undefined && isApplied(replaced.xid, row.appliedHorizon);
    let checkpoint: CheckpointRow | undefined;
    for (let cycle = 1; cycle <= MAX_CYCLES && !projected(checkpoint); cycle += 1) {
      if (cycle > 1) await new Promise((resolve) => setTimeout(resolve, CYCLE_PAUSE_MS));
      expect((await projector.runOnce()).errors).toEqual([]);
      checkpoint = await tenantCheckpoint(legacy);
    }
    await projector.stop();
    expect(projected(checkpoint)).toBe(true);

    expect(legacy.multiset(MEMBERS.qualified)).toEqual(expectedMultiset(MEMBER_COLUMNS, [[R, 1], [R_STAR, 1], [U, 1]]));
    expect(multiset(legacyEncodings(legacy, MEMBERS.qualified))).toEqual(multiset(await targetEncodings(started)));
    const stored = await fetchPgOwnerRows<{ rows: Array<{ legacy_row_hash: string }> }>(
      started.owner,
      `${started.url}${PG_OWNER_ROWS_PATH}/${MEMBER_TARGET_TABLE}?tenantId=${TENANT_A.tenantId}`,
    );
    expect(stored.status).toBe(200);
    const { rows } = stored.body;
    expect(rows.map((row) => row.legacy_row_hash).sort()).toEqual([R, R_STAR, U].map((row) => legacyRowHash(MEMBER_COLUMNS, row)).sort());
  });
});

