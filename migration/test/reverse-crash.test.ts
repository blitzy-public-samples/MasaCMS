// Reverse projector crash recovery: a batch's legacy rows and its opt2_sync checkpoint commit in one SQL Server
// transaction, `migration.projector_cursor` only mirrors it, and a restarted projector resumes from the checkpoint.
import { readFileSync } from 'node:fs';

import {
  CURSOR_START,
  canonicalTypeForSqlServer,
  encodeRow,
  formatCursor,
  type CanonicalColumn,
  type ChangeRow,
} from '@opt2/platform/migration-kit';
import { TENANT_A, pgAvailable } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { upsertCheckpoint } from '../src/reverse/apply-legacy.js';
import { CHECKPOINT_TABLE, createProjector, readCheckpoints, type CheckpointRow, type Projector } from '../src/reverse/index.js';
import type { ProjectorHooks, StartupGuardRunner } from '../src/reverse/projector.js';

import { MIGRATION_SCHEMA_SKIP_REASON, buildTestContext, withMigrationSchema, type MigrationSchemaHandle, type TestContext } from './helpers/context.js';
import { CrashInjectedError, createFakeLegacyDb, type FakeLegacyDb, type Row, type StatementRecord } from './helpers/fake-legacy-db.js';
import { FIXTURE_GROUP_IDS, TABLES, UNITS, defineFixtureTables, fixtureVersion, mailingListMemberRow, siteRow } from './helpers/fixtures.js';
import type { OwnerDoubleState, ScriptedChangesPage } from './helpers/owner-double.js';

const OWNER = 'programs-sites';
const MEMBERS = TABLES.tmailinglistmembers;
const UNIT = UNITS.mailingListMember;
const TARGET_TABLE = UNIT.slice(UNIT.indexOf('.') + 1);

/** Every live column of `tmailinglistmembers`, typed as the fake's multiset encodes them. */
const COLUMNS: CanonicalColumn[] = MEMBERS.columns.map((column) => ({ name: column.name, ...canonicalTypeForSqlServer(column.type) }));

/** The mailing lists `target`-authoritative, every other group `legacy`. */
const VERSION = fixtureVersion('v0201', { [FIXTURE_GROUP_IDS.mailingLists]: 'target' });

/** Two identical rows a delete removes one occurrence of, and three identical rows an update rewrites one of. */
const D = mailingListMemberRow({ Email: 'duplicate.delete@example.test' });
const E = mailingListMemberRow({ Email: 'duplicate.update@example.test' });
const E_PRIME = { ...E, fname: 'Updated' };

/** The shipped batch that creates `opt2_sync.projector_checkpoint`. */
const SYNC_SQL = readFileSync(new URL('../sql/005_opt2_sync.sql', import.meta.url), 'utf8');

const encoded = (row: Row): string => encodeRow(COLUMNS, row);
const cursorAt = (xid: number): string => formatCursor({ xid: BigInt(xid), seq: 1n });

const MEMBER_DELETE = /^DELETE TOP \(1\) FROM \S*tmailinglistmembers/i;
const MEMBER_INSERT = /^INSERT INTO \S*tmailinglistmembers/i;
const isCheckpointUpsert = (statement: Pick<StatementRecord, 'sql'>): boolean => statement.sql.startsWith(`UPDATE ${CHECKPOINT_TABLE}`);

/** Stands in for the `projector-crash` fault, which exits the process after a batch's legacy commit. */
class ProjectorCrashed extends Error {
  override readonly name = 'ProjectorCrashed';
}

/** Hooks whose first `afterLegacyCommit` ends the projector; later calls pass. */
function crashAfterFirstLegacyCommit(): ProjectorHooks {
  let crashed = false;
  return {
    afterLegacyCommit: () => {
      if (crashed) return Promise.resolve();
      crashed = true;
      return Promise.reject(new ProjectorCrashed('projector ended after the SQL Server commit, before its checkpoint mirror'));
    },
  };
}

const refuseGuard: StartupGuardRunner = { run: () => Promise.reject(new Error('no batch here touches tcontent')) };

/** A programs-sites changelog row of `tmailinglistmembers` at `<xid>:1`, projected for its unit. */
function memberChange(xid: number, op: ChangeRow['op'], images: { before?: Row; after?: Row }, changed: string[] = []): ScriptedChangesPage['rows'][number] {
  const before = images.before === undefined ? null : encoded(images.before);
  const after = images.after === undefined ? null : encoded(images.after);
  const key = before ?? after ?? '';
  const row: ChangeRow = {
    xid: String(xid),
    seq: '1',
    table: TARGET_TABLE,
    op,
    key,
    before,
    after,
    columns: changed,
    origin: 'target',
    actorUserId: null,
    actorService: null,
    at: '2026-06-30 12:00:00.000',
    requestId: null,
    operationId: null,
  };
  return { ...row, legacy: [{ unit: UNIT, legacyTable: 'tmailinglistmembers', key, before, after, columns: changed }] };
}

/** A complete page holding `rows`, ending at the cursor of `xid` with read horizon `horizon`. */
function page(xid: number, horizon: number, rows: ScriptedChangesPage['rows']): ScriptedChangesPage {
  return { rows, cursor: cursorAt(xid), horizon: String(horizon), complete: true };
}

const PAGE_1 = page(501, 502, [memberChange(501, 'delete', { before: D })]);
const PAGE_2 = page(601, 602, [memberChange(601, 'update', { before: E, after: E_PRIME }, ['fname'])]);
const PAGE_3 = page(701, 702, [memberChange(701, 'delete', { before: E })]);
const PAGE_LOW_HORIZON = page(701, 650, []);

interface MirrorRow {
  owner: string;
  tenant_id: string;
  cursor: string;
  applied_horizon: string;
}

/** One projector process: a fresh context, owner doubles and operation tracker over the case's legacy fake and the shared schema. */
interface ProjectorProcess {
  tc: TestContext;
  projector: Projector;
  owner: OwnerDoubleState;
}

/** A case's starting state: its `tmailinglistmembers` rows and, when set, the checkpoint and mirror an earlier batch committed. */
interface Arrangement {
  rows: readonly Row[];
  prior?: { xid: number; horizon: number };
}

const PG_AVAILABLE = await pgAvailable();
const SUITE = PG_AVAILABLE ? 'reverse projector crash recovery' : `reverse projector crash recovery (${MIGRATION_SCHEMA_SKIP_REASON})`;

describe.skipIf(!PG_AVAILABLE)(SUITE, () => {
  let schema: MigrationSchemaHandle | null = null;
  let legacy: FakeLegacyDb;
  const open = new Set<TestContext>();

  /** The throwaway `migration` schema every process shares, as a restarted process would find it. */
  function migrationSchema(): MigrationSchemaHandle {
    if (schema === null) throw new Error(MIGRATION_SCHEMA_SKIP_REASON);
    return schema;
  }

  beforeAll(async () => {
    schema = await withMigrationSchema();
    if (schema === null) throw new Error(MIGRATION_SCHEMA_SKIP_REASON);
  });

  afterEach(async () => {
    for (const tc of open) await tc.close();
    open.clear();
  });

  afterAll(async () => {
    await schema?.drop();
    schema = null;
  });

  /** A fresh legacy fake holding `rows`, the `tenant-a` site and the checkpoint table, an emptied mirror, then any prior checkpoint and mirror. */
  async function arrange({ rows, prior }: Arrangement): Promise<void> {
    legacy = createFakeLegacyDb();
    defineFixtureTables(legacy, ['tsettings', 'tmailinglistmembers']);
    legacy.seed(TABLES.tsettings.qualified, [siteRow(TENANT_A.siteId)]);
    legacy.seed(MEMBERS.qualified, rows);
    await (await legacy.live()).request().batch(SYNC_SQL);
    await migrationSchema().db.withMetadata(async (tx) => {
      await tx.query(`DELETE FROM ${tx.schema}.projector_cursor`);
      if (prior === undefined) return;
      await tx.query(
        `INSERT INTO ${tx.schema}.projector_cursor (owner, tenant_id, cursor, applied_horizon, batches, updated_at)
         VALUES ($1, $2::uuid, $3, $4::numeric, 1, $5::timestamp(3))`,
        [OWNER, TENANT_A.tenantId, cursorAt(prior.xid), String(prior.horizon), new Date()],
      );
    });
    if (prior !== undefined) {
      await upsertCheckpoint(await legacy.live(), {
        owner: OWNER,
        tenantId: TENANT_A.tenantId,
        cursorXid: String(prior.xid),
        cursorSeq: '1',
        appliedHorizon: String(prior.horizon),
        batchId: `arranged-${String(prior.xid)}`,
        rowsApplied: 1,
        pendingEffects: [],
      });
    }
    legacy.clearLogs();
  }

  /** Starts a process whose programs-sites double answers `pages` in order, one per changes call. */
  async function startProcess(pages: readonly ScriptedChangesPage[], hooks: ProjectorHooks = {}): Promise<ProjectorProcess> {
    const tc = await buildTestContext({
      legacy,
      migrationDb: migrationSchema().db,
      bridge: false,
      cutover: { versions: [VERSION] },
      gateway: { active: VERSION.tableVersion },
    });
    open.add(tc);
    if (tc.owners === null) throw new Error('the test context has no owner doubles');
    const owner = tc.owners.owner(OWNER);
    owner.seedRows('tmailinglistmembers', TENANT_A.tenantId, [], COLUMNS);
    owner.changesScript.set(TENANT_A.tenantId, pages.map((scripted) => structuredClone(scripted)));
    return { tc, projector: createProjector(tc.ctx, { hooks, startupGuard: refuseGuard }), owner };
  }

  async function stopProcess(stopped: ProjectorProcess): Promise<void> {
    await stopped.projector.stop();
    await stopped.tc.close();
    open.delete(stopped.tc);
  }

  async function checkpoint(): Promise<CheckpointRow | undefined> {
    const rows = await readCheckpoints(await legacy.live(), { owners: [OWNER] });
    return rows.find((row) => row.tenantId.toLowerCase() === TENANT_A.tenantId.toLowerCase());
  }

  async function mirror(): Promise<MirrorRow[]> {
    return migrationSchema().db.withMetadata(async (tx) => {
      const result = await tx.query<MirrorRow>(
        'SELECT owner, tenant_id::text AS tenant_id, cursor, applied_horizon::text AS applied_horizon FROM migration.projector_cursor ORDER BY owner, tenant_id',
      );
      return result.rows;
    });
  }

  function occurrences(): Record<'D' | 'E' | 'E_PRIME', number> {
    const counts = legacy.multiset(MEMBERS.qualified);
    return { D: counts.get(encoded(D)) ?? 0, E: counts.get(encoded(E)) ?? 0, E_PRIME: counts.get(encoded(E_PRIME)) ?? 0 };
  }

  const checkpointAt = (xid: number, horizon: number) => ({ cursorXid: String(xid), cursorSeq: '1', appliedHorizon: String(horizon) });
  const mirrorAt = (xid: number, horizon: number): MirrorRow[] => [
    { owner: OWNER, tenant_id: TENANT_A.tenantId.toLowerCase(), cursor: cursorAt(xid), applied_horizon: String(horizon) },
  ];
  const requestedAfter = (owner: OwnerDoubleState): string[] => owner.changesCalls.map((call) => call.after);

  it('starts with the duplicated keyless rows and no checkpoint or mirror', async () => {
    await arrange({ rows: [D, D, E, E, E] });
    expect(occurrences()).toEqual({ D: 2, E: 3, E_PRIME: 0 });
    expect(legacy.rows(MEMBERS.qualified)).toHaveLength(5);
    expect(await checkpoint()).toBeUndefined();
    expect(await mirror()).toEqual([]);
  });

  it('commits a keyless delete and its checkpoint together before a crash, and never repeats the delete on restart', async () => {
    await arrange({ rows: [D, D, E, E, E] });
    const crashing = await startProcess([PAGE_1], crashAfterFirstLegacyCommit());
    await expect(crashing.projector.runOnce()).rejects.toBeInstanceOf(ProjectorCrashed);
    expect(occurrences()).toEqual({ D: 1, E: 3, E_PRIME: 0 });
    expect(await checkpoint()).toMatchObject(checkpointAt(501, 502));
    const batchCommits = legacy.commits.filter((commit) => commit.statements.some(isCheckpointUpsert));
    expect(batchCommits).toHaveLength(1);
    expect(batchCommits[0]?.statements.filter((statement) => MEMBER_DELETE.test(statement.sql))).toHaveLength(1);
    expect(await mirror()).toEqual([]);
    await stopProcess(crashing);

    const restarted = await startProcess([PAGE_1]);
    const result = await restarted.projector.runOnce();
    expect(result).toMatchObject({ leader: true, ran: true, rowsApplied: 0, errors: [] });
    expect(requestedAfter(restarted.owner)).toEqual([cursorAt(501)]);
    expect(requestedAfter(restarted.owner)).not.toContain(CURSOR_START);
    expect(occurrences()).toEqual({ D: 1, E: 3, E_PRIME: 0 });
    expect(legacy.statements.filter((statement) => MEMBER_DELETE.test(statement.sql))).toHaveLength(1);
    expect(await checkpoint()).toMatchObject(checkpointAt(501, 502));
    expect(await mirror()).toEqual(mirrorAt(501, 502));
    await stopProcess(restarted);
  });

  it('commits a keyless update as one delete and one insert before a crash, and inserts its after-image once over both runs', async () => {
    await arrange({ rows: [D, E, E, E], prior: { xid: 501, horizon: 502 } });
    const crashing = await startProcess([PAGE_2], crashAfterFirstLegacyCommit());
    await expect(crashing.projector.runOnce()).rejects.toBeInstanceOf(ProjectorCrashed);
    expect(requestedAfter(crashing.owner)).toEqual([cursorAt(501)]);
    expect(occurrences()).toEqual({ D: 1, E: 2, E_PRIME: 1 });
    expect(await checkpoint()).toMatchObject(checkpointAt(601, 602));
    expect(await mirror()).toEqual(mirrorAt(501, 502));
    await stopProcess(crashing);

    const restarted = await startProcess([PAGE_2]);
    expect(await restarted.projector.runOnce()).toMatchObject({ rowsApplied: 0, errors: [] });
    expect(requestedAfter(restarted.owner)).toEqual([cursorAt(601)]);
    expect(occurrences()).toEqual({ D: 1, E: 2, E_PRIME: 1 });
    expect(legacy.rows(MEMBERS.qualified)).toHaveLength(4);
    expect(legacy.statements.filter((statement) => MEMBER_INSERT.test(statement.sql))).toHaveLength(1);
    expect(legacy.statements.filter((statement) => MEMBER_DELETE.test(statement.sql))).toHaveLength(1);
    expect(await mirror()).toEqual(mirrorAt(601, 602));
    await stopProcess(restarted);
  });

  it('rolls a batch back when the process dies before the SQL Server commit, then applies it exactly once', async () => {
    await arrange({ rows: [D, E, E, E_PRIME], prior: { xid: 601, horizon: 602 } });
    legacy.crashAt((statement) => statement.txId !== null && isCheckpointUpsert(statement));
    const crashing = await startProcess([PAGE_3]);
    const failed = await crashing.projector.runOnce();
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]).toMatchObject({ owner: OWNER, cursor: cursorAt(601) });
    expect(failed.errors[0]?.error).toBeInstanceOf(CrashInjectedError);
    const sentDelete = legacy.statements.find((statement) => MEMBER_DELETE.test(statement.sql));
    expect(sentDelete?.txId).not.toBeNull();
    expect(legacy.commits.some((commit) => commit.txId === sentDelete?.txId)).toBe(false);
    expect(occurrences()).toEqual({ D: 1, E: 2, E_PRIME: 1 });
    expect(await checkpoint()).toMatchObject(checkpointAt(601, 602));
    expect(await mirror()).toEqual(mirrorAt(601, 602));
    await stopProcess(crashing);

    const restarted = await startProcess([PAGE_3]);
    expect(await restarted.projector.runOnce()).toMatchObject({ rowsApplied: 1, errors: [] });
    expect(requestedAfter(restarted.owner)).toEqual([cursorAt(601)]);
    expect(occurrences()).toEqual({ D: 1, E: 1, E_PRIME: 1 });
    expect(await checkpoint()).toMatchObject(checkpointAt(701, 702));
    expect(await mirror()).toEqual(mirrorAt(701, 702));
    await stopProcess(restarted);
  });

  it('never lowers the stored applied horizon for a page read below it', async () => {
    await arrange({ rows: [D, E, E_PRIME], prior: { xid: 701, horizon: 702 } });
    const lowHorizon = await startProcess([PAGE_LOW_HORIZON]);
    expect(await lowHorizon.projector.runOnce()).toMatchObject({ rowsApplied: 0, errors: [] });
    expect(requestedAfter(lowHorizon.owner)).toEqual([cursorAt(701)]);
    expect(await checkpoint()).toMatchObject(checkpointAt(701, 702));
    expect(await mirror()).toEqual(mirrorAt(701, 702));
    expect(occurrences()).toEqual({ D: 1, E: 1, E_PRIME: 1 });
    await stopProcess(lowHorizon);
  });
});
