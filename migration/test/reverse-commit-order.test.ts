// Reverse projection in commit order: a lower-xid write of a row that commits after a higher-xid one reaches legacy last,
// while an unrelated open transaction holds the horizon between them, across a projector restart and one-row pages.
import { readFileSync } from 'node:fs';

import {
  canonicalTypeForSqlServer,
  decodeRow,
  encodeRow,
  isApplied,
  multiset,
  type CanonicalColumn,
  type RepositoryRow,
} from '@opt2/platform/migration-kit';
import { TENANT_A } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MigrationContext } from '../src/context.js';
import { createProjector, readCheckpoints, type CheckpointRow, type Projector, type StartupGuardRunner } from '../src/reverse/index.js';

import { buildTestContext, type TestContext } from './helpers/context.js';
import { createFakeLegacyDb, type FakeLegacyDb, type Row } from './helpers/fake-legacy-db.js';
import {
  FIXTURE_GROUP_IDS,
  MAILINGLIST_MEMBERS_MAPPING,
  TABLES,
  TIMAGESIZES_MAPPING,
  UNITS,
  V0001,
  defineFixtureTables,
  fixtureVersion,
  imageSizeRow,
  mailingListMemberRow,
  siteRow,
  type FixtureTableName,
} from './helpers/fixtures.js';
import { PG_AVAILABLE, PG_OWNER_ROWS_PATH, PG_SKIP_REASON, fetchPgOwnerRows, startPgOwner, type HeldTransaction, type PgOwner } from './helpers/pg-owner.js';

const SYNC_SQL = readFileSync(new URL('../sql/005_opt2_sync.sql', import.meta.url), 'utf8');

/** No batch here touches `tcontent`, so the guard is never entered; were it, it would commit directly. */
const DIRECT_COMMIT: StartupGuardRunner = { run: (commit) => commit() };

/** Cycles driven until a write is projected; other sessions on a shared cluster can hold the horizon back. */
const MAX_CYCLES = 200;
const CYCLE_PAUSE_MS = 50;
/** Cycles run while the unrelated transaction holds the horizon. */
const HELD_CYCLES = 3;

/** One-row pages, so the owner must extend a page through a later same-row predecessor. */
function onePerPage(ctx: MigrationContext): MigrationContext {
  return { ...ctx, config: { ...ctx.config, projection: { ...ctx.config.projection, batchRows: 1 } } };
}

/** A legacy database holding `tables`, the `tenant-a` site, `seeded` rows and the checkpoint table, its logs cleared. */
async function legacyDb(tables: readonly FixtureTableName[], seeded: Readonly<Record<string, readonly Row[]>> = {}): Promise<FakeLegacyDb> {
  const legacy = createFakeLegacyDb();
  defineFixtureTables(legacy, tables);
  legacy.seed(TABLES.tsettings.qualified, [siteRow(TENANT_A.siteId)]);
  for (const [table, rows] of Object.entries(seeded)) legacy.seed(table, rows);
  await (await legacy.live()).request().batch(SYNC_SQL);
  legacy.clearLogs();
  return legacy;
}

async function tenantCheckpoint(legacy: FakeLegacyDb, owner: string): Promise<CheckpointRow | undefined> {
  const rows = await readCheckpoints(await legacy.live(), { owners: [owner] });
  return rows.find((row) => row.tenantId.toLowerCase() === TENANT_A.tenantId);
}

/** Every committed row of a fake table as its whole-row encoding, one entry per occurrence. */
function legacyEncodings(legacy: FakeLegacyDb, table: string): string[] {
  return [...legacy.multiset(table)].flatMap(([encoding, count]) => Array.from({ length: count }, () => encoding));
}

/** The owner's export of `unit` for tenant-a, as legacy encodings. */
async function targetEncodings(owner: PgOwner, unit: string): Promise<string[]> {
  const encodings: string[] = [];
  for await (const page of owner.ownersClient.exportPages(owner.owner, { unit, tenantId: TENANT_A.tenantId })) {
    for (const table of page.tables) encodings.push(...table.rows.map((row) => row.row));
  }
  return encodings;
}

/** Target rows of `table` for tenant-a, read back through the owner. */
async function storedRows(owner: PgOwner, table: string): Promise<RepositoryRow[]> {
  const response = await fetchPgOwnerRows<{ rows: RepositoryRow[] }>(owner.owner, `${owner.url}${PG_OWNER_ROWS_PATH}/${table}?tenantId=${TENANT_A.tenantId}`);
  expect(response.status).toBe(200);
  return response.body.rows;
}

/** `(xid, seq)` of the table's target changelog rows in seq order. */
async function targetChanges(owner: PgOwner, table: string): Promise<Array<{ xid: string; seq: string }>> {
  return owner.db.withTenant(TENANT_A.tenantId, async (tx) => {
    const sql = `SELECT xid::text AS xid, seq::text AS seq FROM ${owner.schema}.changelog WHERE "table" = $1 AND origin = 'target' ORDER BY seq`;
    return (await tx.query<{ xid: string; seq: string }>(sql, [table])).rows;
  });
}

/** Drives one projection scenario over a PostgreSQL owner and a fake legacy database. */
interface Scenario {
  owner: PgOwner;
  tc: TestContext;
  projector: Projector;
}

/** Runs cycles until the tenant checkpoint has passed every xid in `xids`; each cycle must report no error. */
async function cycleUntilProjected(scenario: Scenario, xids: readonly string[]): Promise<CheckpointRow> {
  let checkpoint: CheckpointRow | undefined;
  const projected = (row: CheckpointRow | undefined): row is CheckpointRow =>
    row !== undefined && xids.every((xid) => isApplied(xid, row.appliedHorizon));
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle += 1) {
    if (cycle > 1) await new Promise((resolve) => setTimeout(resolve, CYCLE_PAUSE_MS));
    expect((await scenario.projector.runOnce()).errors).toEqual([]);
    checkpoint = await tenantCheckpoint(scenario.tc.legacy, scenario.owner.owner);
    if (projected(checkpoint)) return checkpoint;
  }
  throw new Error(`Positions ${xids.join(', ')} not projected after ${String(MAX_CYCLES)} cycles; applied horizon ${checkpoint?.appliedHorizon ?? 'none'}`);
}

/**
 * Opens `older`, then the unrelated `blocker`, commits `newer` on the row, then writes the row in `older` and commits it,
 * so the row's last commit carries the lowest xid; returns the open blocker and both writers' xids.
 */
async function commitOutOfOrder(
  owner: PgOwner,
  newer: (owner: PgOwner) => Promise<string>,
  older: (held: HeldTransaction) => Promise<void>,
): Promise<{ blocker: HeldTransaction; olderXid: string; newerXid: string }> {
  const olderTx = await owner.openTransaction();
  const blocker = await owner.openTransaction();
  const newerXid = await newer(owner);
  await older(olderTx);
  await olderTx.commit();
  expect(BigInt(olderTx.xid)).toBeLessThan(BigInt(blocker.xid));
  expect(BigInt(blocker.xid)).toBeLessThan(BigInt(newerXid));
  return { blocker, olderXid: olderTx.xid, newerXid };
}

/** Runs cycles while the blocker holds the horizon: legacy keeps `unchanged` and the checkpoint claims neither write. */
async function expectWithheld(scenario: Scenario, xids: readonly string[], unchanged: () => void): Promise<void> {
  for (let cycle = 1; cycle <= HELD_CYCLES; cycle += 1) {
    expect((await scenario.projector.runOnce()).errors).toEqual([]);
    unchanged();
    const checkpoint = await tenantCheckpoint(scenario.tc.legacy, scenario.owner.owner);
    for (const xid of xids) expect(checkpoint !== undefined && isApplied(xid, checkpoint.appliedHorizon)).toBe(false);
  }
}

describe.skipIf(!PG_AVAILABLE)(`reverse projection in per-row commit order${PG_AVAILABLE ? '' : ` (${PG_SKIP_REASON})`}`, () => {
  const scenarios: Scenario[] = [];

  async function start(owner: PgOwner, tables: readonly FixtureTableName[], seeded: Readonly<Record<string, readonly Row[]>>, groupId: string): Promise<Scenario> {
    await owner.openGates();
    const version = fixtureVersion('v0201', { [groupId]: 'target' });
    const tc = await buildTestContext({
      legacy: await legacyDb(tables, seeded),
      owners: owner.ownersClient,
      gateway: { active: version.tableVersion },
      cutover: { versions: [V0001, version] },
      migrationDb: true,
      bridge: false,
    });
    const scenario = { owner, tc, projector: createProjector(onePerPage(tc.ctx), { startupGuard: DIRECT_COMMIT }) };
    scenarios.push(scenario);
    return scenario;
  }

  /** Stops the projector and starts a fresh one over the same legacy checkpoints. */
  async function restart(scenario: Scenario): Promise<void> {
    await scenario.projector.stop();
    scenario.projector = createProjector(onePerPage(scenario.tc.ctx), { startupGuard: DIRECT_COMMIT });
  }

  afterAll(async () => {
    for (const { projector, tc, owner } of scenarios) {
      await projector.stop();
      await tc.close();
      await owner.close();
    }
  });

  describe('a keyed row', () => {
    const TABLE = 'image_size';
    const SEEDED = imageSizeRow({ name: 'commit-order' });
    const NEWER = { ...SEEDED, height: '200' };
    const OLDER = { ...SEEDED, height: '300' };
    let scenario: Scenario;

    const targetRow = (row: Row): RepositoryRow => Object.fromEntries(Object.entries(row).map(([column, value]) => [column.toLowerCase(), value]));
    const legacyHeights = (): unknown[] => scenario.tc.legacy.rows(TABLES.timagesizes.qualified).map((row) => row.height);

    beforeAll(async () => {
      const owner = await startPgOwner({ owner: 'programs-sites', mappings: [TIMAGESIZES_MAPPING], tenants: [TENANT_A] });
      scenario = await start(owner, ['tsettings', 'timagesizes'], {}, FIXTURE_GROUP_IDS.programsSites);
    });

    it('ends legacy at the last committed write although its xid is the lower one', async () => {
      const { owner } = scenario;
      const seeded = await owner.write((tx, repo) => repo.upsert(tx, TABLE, targetRow(SEEDED)));
      await cycleUntilProjected(scenario, [seeded.xid]);
      expect(legacyHeights()).toEqual(['100']);

      const { blocker, olderXid, newerXid } = await commitOutOfOrder(
        owner,
        async (started) => (await started.write((tx, repo) => repo.upsert(tx, TABLE, targetRow(NEWER)))).xid,
        async (held) => {
          await held.write(TABLE, targetRow(OLDER));
        },
      );
      // seq follows the row's commit order: the newer xid took the row first.
      expect((await targetChanges(owner, TABLE)).slice(-2).map((change) => change.xid)).toEqual([newerXid, olderXid]);

      await expectWithheld(scenario, [olderXid, newerXid], () => expect(legacyHeights()).toEqual(['100']));
      await restart(scenario);
      await blocker.rollback();
      await cycleUntilProjected(scenario, [olderXid, newerXid]);

      expect(legacyHeights()).toEqual(['300']);
      expect((await storedRows(owner, TABLE)).map((row) => row.height)).toEqual(['300']);
      expect(multiset(legacyEncodings(scenario.tc.legacy, TABLES.timagesizes.qualified))).toEqual(multiset(await targetEncodings(owner, UNITS.imageSize)));
    });
  });

  describe('a keyless row', () => {
    const MEMBERS = TABLES.tmailinglistmembers;
    const TABLE = UNITS.mailingListMember.slice(UNITS.mailingListMember.indexOf('.') + 1);
    const COLUMNS: CanonicalColumn[] = MEMBERS.columns.map((column) => ({ name: column.name, ...canonicalTypeForSqlServer(column.type) }));
    const R = mailingListMemberRow({ Email: 'commit-order@example.test' });
    const X = { ...R, fname: 'Xavier' };
    const Y = { ...R, fname: 'Yara' };
    let scenario: Scenario;

    /** A legacy row in the owner's target column names, valued as the owner decodes a legacy encoding. */
    const targetRow = (row: Row): RepositoryRow => {
      const decoded = decodeRow(COLUMNS, encodeRow(COLUMNS, row));
      return Object.fromEntries(MAILINGLIST_MEMBERS_MAPPING.columns.map((column) => [column.target, decoded[column.legacy] ?? null]));
    };
    const legacyMembers = (): Map<string, number> => scenario.tc.legacy.multiset(MEMBERS.qualified);
    const only = (row: Row): Map<string, number> => new Map([[encodeRow(COLUMNS, row), 1]]);

    beforeAll(async () => {
      const owner = await startPgOwner({ owner: 'communications', mappings: [MAILINGLIST_MEMBERS_MAPPING], tenants: [TENANT_A] });
      scenario = await start(owner, ['tsettings', 'tmailinglistmembers'], { [MEMBERS.qualified]: [R] }, FIXTURE_GROUP_IDS.communications);
      await owner.ownersClient.apply(owner.owner, {
        batchId: 'reverse-commit-order-backfill',
        origin: 'backfill',
        legacyTable: 'tmailinglistmembers',
        tenantId: TENANT_A.tenantId,
        columns: COLUMNS,
        rows: [{ op: 'insert', row: encodeRow(COLUMNS, R) }],
      });
    });

    it('applies a replacement of the after-image an earlier-committed replacement left only after that one', async () => {
      const { owner } = scenario;
      const { blocker, olderXid, newerXid } = await commitOutOfOrder(
        owner,
        async (started) => {
          const replaced = await started.write((tx, repo) => repo.replaceOne(tx, TABLE, targetRow(R), targetRow(X)));
          expect(replaced.result).not.toBeNull();
          return replaced.xid;
        },
        async (held) => {
          expect(await held.run((tx, repo) => repo.replaceOne(tx, TABLE, targetRow(X), targetRow(Y)))).not.toBeNull();
        },
      );
      expect((await targetChanges(owner, TABLE)).map((change) => change.xid)).toEqual([newerXid, olderXid]);

      await expectWithheld(scenario, [olderXid, newerXid], () => expect(legacyMembers()).toEqual(only(R)));
      await restart(scenario);
      await blocker.commit();
      await cycleUntilProjected(scenario, [olderXid, newerXid]);

      expect(legacyMembers()).toEqual(only(Y));
      expect(multiset(legacyEncodings(scenario.tc.legacy, MEMBERS.qualified))).toEqual(multiset(await targetEncodings(owner, UNITS.mailingListMember)));
    });
  });
});
