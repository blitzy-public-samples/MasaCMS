// Reverse projection of a change legacy cannot take: the change, with its operation's other changes, is recorded in
// migration.projector_quarantine and left out of its batch, which commits the other changes with every part's checkpoint;
// a later change of its key replays the row and marks it repaired after its commit; the barrier refuses its position until
// then; any other failure stops the stream.
import { readFileSync } from 'node:fs';

import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { Logger } from '@opt2/platform/logging';
import {
  canonicalTypeForSqlServer,
  changedColumns,
  encodeKey,
  encodeRow,
  formatCursor,
  type CanonicalColumn,
  type ChangeRow,
  type ProjectedChangeRow,
} from '@opt2/platform/migration-kit';
import { TENANT_A, pgAvailable } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectionQuarantinedError } from '../../src/reverse/await.js';
import { createProjector, readCheckpoints, type CheckpointRow, type StartupGuardRunner } from '../../src/reverse/index.js';
import { OperationTracker } from '../../src/reverse/operations.js';
import { runProjectorCycle, type CycleResult, type ProjectorHooks } from '../../src/reverse/projector.js';
import { buildTestContext, type TestContext } from '../helpers/context.js';
import { createFakeLegacyDb, sqlError, type FakeLegacyDb, type LegacyColumnDef, type Row } from '../helpers/fake-legacy-db.js';
import { FIXTURE_GROUP_IDS, TABLES, UNITS, defineFixtureTables, fixtureVersion, imageSizeRow, siteRow } from '../helpers/fixtures.js';
import type { OwnerDoubleState, ScriptedChangesPage } from '../helpers/owner-double.js';

const OWNER = 'programs-sites';
const SIZES = TABLES.timagesizes;
const SIZE_UNIT = UNITS.imageSize;
const SYNC_SQL = readFileSync(new URL('../../sql/005_opt2_sync.sql', import.meta.url), 'utf8');
const HORIZON = 900;

/** The programs-sites units `target`-authoritative, every other group `legacy`. */
const VERSION = fixtureVersion('v0301', { [FIXTURE_GROUP_IDS.programsSites]: 'target' });

/** No batch here touches `tcontent`, so the start-up guard is never entered. */
const UNUSED_GUARD: StartupGuardRunner = { run: () => Promise.reject(new Error('no batch here touches tcontent')) };

function canonicalColumns(columns: readonly LegacyColumnDef[]): CanonicalColumn[] {
  return columns.map((column) => ({ name: column.name, ...canonicalTypeForSqlServer(column.type) }));
}

const SIZE_COLUMNS = canonicalColumns(SIZES.columns);

/** Fits `timagesizes`; WIDE's name is one past its varchar(50), which SQL Server refuses with error 2628, and WIDER's is further past. */
const GOOD = imageSizeRow({ name: 'thumbnail' });
const OTHER = imageSizeRow({ name: 'banner' });
const WIDE = imageSizeRow({ name: 'w'.repeat(51) });
const WIDE_FIXED = { ...WIDE, name: 'wide' };
const WIDER = { ...WIDE, name: 'x'.repeat(60) };

/** A keyed `timagesizes` changelog row at `<xid>:<seq>` with its legacy projection. */
function size(xid: number, seq: number, op: ChangeRow['op'], images: { before?: Row; after?: Row }, operationId: string | null = null): ProjectedChangeRow {
  const before = images.before === undefined ? null : encodeRow(SIZE_COLUMNS, images.before);
  const after = images.after === undefined ? null : encodeRow(SIZE_COLUMNS, images.after);
  const key = encodeKey(SIZE_COLUMNS, ['sizeID'], (images.after ?? images.before) as Row);
  const columns =
    images.before !== undefined && images.after !== undefined ? changedColumns(SIZE_COLUMNS, images.before, images.after) : SIZE_COLUMNS.map((c) => c.name);
  return {
    xid: String(xid),
    seq: String(seq),
    table: SIZE_UNIT.slice(SIZE_UNIT.indexOf('.') + 1),
    op,
    key,
    before,
    after,
    columns,
    origin: 'target',
    actorUserId: null,
    actorService: OWNER,
    at: '2026-06-30 12:00:00.000',
    requestId: null,
    operationId,
    legacy: [{ unit: SIZE_UNIT, legacyTable: 'timagesizes', key, before, after, columns }],
  };
}

interface QuarantineRecord {
  owner: string;
  tenant_id: string;
  xid: string;
  seq: string;
  legacy_table: string;
  op: string;
  legacy_key: string;
  reason: string;
  batch_id: string;
  repaired: boolean;
  repaired_xid: string | null;
  repaired_seq: string | null;
}

/** One tenant-a programs-sites stream over a migrated throwaway `migration` schema, projected cycle by cycle. */
interface Scenario {
  tc: TestContext;
  logger: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  owner: OwnerDoubleState;
  /** Runs one cycle over one scripted page of `rows` at `horizon`, answered to `reads` reads; a held operation's span is read again. */
  cycle(rows: readonly ProjectedChangeRow[], horizon?: number, reads?: number): Promise<CycleResult>;
  checkpoint(): Promise<CheckpointRow | undefined>;
  quarantine(): Promise<QuarantineRecord[]>;
  /** The barrier the migration service answers `projectionAwait` with, over this context, for the programs-sites write at `xid`. */
  awaitPosition(xid: string): Promise<unknown>;
  /** Live `timagesizes` rows by `sizeID`. */
  sizes(): Row[];
}

const PG = await pgAvailable();
const opened: TestContext[] = [];

/** A fresh legacy database with the tenant-a site, the checkpoint table and an empty `timagesizes`, its logs cleared. */
async function sizesLegacy(): Promise<FakeLegacyDb> {
  const legacy = createFakeLegacyDb();
  defineFixtureTables(legacy, ['tsettings', 'timagesizes']);
  legacy.seed(TABLES.tsettings.qualified, [siteRow(TENANT_A.siteId)]);
  await (await legacy.live()).request().batch(SYNC_SQL);
  legacy.clearLogs();
  return legacy;
}

/**
 * A fresh stream on a migrated throwaway `migration` schema; `tracker` lets an operation of programs-sites alone release,
 * `hooks` are the cycles' fault points, and `arrange` prepares the legacy database.
 */
async function scenario(options: { arrange?: (legacy: FakeLegacyDb) => void; hooks?: ProjectorHooks; tracker?: OperationTracker } = {}): Promise<Scenario> {
  const legacy = await sizesLegacy();
  options.arrange?.(legacy);
  const tc = await buildTestContext({ legacy, migrationDb: true, bridge: false, cutover: { versions: [VERSION] }, gateway: { active: VERSION.tableVersion } });
  opened.push(tc);
  if (tc.owners === null) throw new Error('the test context has no owner doubles');
  const owner = tc.owners.owner(OWNER);
  owner.seedRows('timagesizes', TENANT_A.tenantId, [], SIZE_COLUMNS);
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const ctx = { ...tc.ctx, logger: logger as unknown as Logger };
  const tracker = options.tracker ?? new OperationTracker();
  // Never started: its awaiter is the one the projection route serves.
  const projector = createProjector(ctx, { startupGuard: UNUSED_GUARD });
  return {
    tc,
    logger,
    owner,
    cycle(rows, horizon = HORIZON, reads = 1) {
      const last = rows.at(-1) as ProjectedChangeRow;
      const page: ScriptedChangesPage = { rows: [...rows], cursor: formatCursor({ xid: BigInt(last.xid), seq: BigInt(last.seq) }), horizon: String(horizon), complete: true };
      owner.changesScript.set(TENANT_A.tenantId, Array.from({ length: reads }, () => page));
      return runProjectorCycle(ctx, { startupGuard: UNUSED_GUARD, tracker, hooks: options.hooks ?? {} });
    },
    async checkpoint() {
      return (await readCheckpoints(await legacy.live(), { owners: [OWNER] })).find((row) => row.tenantId.toLowerCase() === TENANT_A.tenantId.toLowerCase());
    },
    quarantine: () =>
      tc.ctx.db.withMetadata(async (tx) =>
        (
          await tx.query<QuarantineRecord>(
            `SELECT owner, tenant_id::text AS tenant_id, xid::text AS xid, seq::text AS seq, legacy_table, op, legacy_key, reason, batch_id,
                    repaired_at IS NOT NULL AS repaired, repaired_xid::text AS repaired_xid, repaired_seq::text AS repaired_seq
             FROM migration.projector_quarantine ORDER BY xid, seq`,
          )
        ).rows,
      ),
    awaitPosition: (xid) => projector.awaitProjection({ positions: new Map([[OWNER, xid]]) }),
    sizes: () => legacy.rows(SIZES.qualified).map((row) => ({ ...row })).sort(bySizeId),
  };
}

function bySizeId(a: Row, b: Row): number {
  return String(a.sizeID).localeCompare(String(b.sizeID));
}

/** The quarantine record of a `timagesizes` change of tenant-a, unrepaired unless `repairedBy` names the change that repaired it. */
function record(row: ProjectedChangeRow, reason: string, batchId: string | null | undefined, repairedBy?: ProjectedChangeRow): QuarantineRecord {
  return {
    owner: OWNER,
    tenant_id: TENANT_A.tenantId,
    xid: row.xid,
    seq: row.seq,
    legacy_table: 'timagesizes',
    op: row.op,
    legacy_key: row.key,
    reason,
    batch_id: String(batchId),
    repaired: repairedBy !== undefined,
    repaired_xid: repairedBy?.xid ?? null,
    repaired_seq: repairedBy?.seq ?? null,
  };
}

/** The error line logged for a quarantined `timagesizes` change of tenant-a. */
function quarantinedLine(row: ProjectedChangeRow): string {
  return `Reverse projection of ${OWNER} for tenant ${TENANT_A.tenantId} quarantined the ${row.op} of timagesizes at cursor ${row.xid}:${row.seq}`;
}

/** The INFO lines a scenario logged about repairs. */
function repairLines(s: Scenario): string[] {
  return s.logger.info.mock.calls.map((call) => call.at(-1) as string).filter((message) => message.startsWith('Reverse projection repaired'));
}

/** The repair line of `[quarantined, repairedBy]` pairs of tenant-a. */
function repairLine(pairs: readonly (readonly [ProjectedChangeRow, ProjectedChangeRow])[]): string {
  const cursors = pairs.map(([row, by]) => `${OWNER} for tenant ${TENANT_A.tenantId} at cursor ${row.xid}:${row.seq} by ${by.xid}:${by.seq}`);
  return `Reverse projection repaired ${String(pairs.length)} quarantined change(s) of ${cursors.join(', ')}`;
}

/** Asserts the barrier refuses the programs-sites write at `xid` at once with the legacy 503 of a quarantined position. */
async function expectQuarantined(s: Scenario, xid: string): Promise<void> {
  const error: unknown = await s.awaitPosition(xid).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProjectionQuarantinedError);
  expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
  expect(error).toMatchObject({
    quarantined: [{ owner: OWNER, xid, tenantId: TENANT_A.tenantId }],
    reason: 'projection-quarantined',
    message: `Projection of ${OWNER}=${xid} is quarantined: legacy could not take the write`,
  });
}

const TRUNCATED = 'SQL Server error 2628';

describe.skipIf(!PG)(`reverse projector quarantine${PG ? '' : ' (requires PostgreSQL: PG_* unset)'}`, () => {
  afterEach(async () => {
    for (const tc of opened.splice(0)) await tc.close();
  });

  // `seq` is one changelog sequence, so a later change of a row always has the higher one.
  const INSERT_GOOD = size(801, 1, 'insert', { after: GOOD });
  const INSERT_WIDE = size(801, 2, 'insert', { after: WIDE });
  const INSERT_OTHER = size(802, 3, 'insert', { after: OTHER });
  const DELETE_WIDE = size(803, 4, 'delete', { before: WIDE });
  // The verifier's witness: a fitting insert, an over-wide insert at 802, then a correction of the latter at 803.
  const WITNESS_GOOD = size(801, 1, 'insert', { after: GOOD });
  const WITNESS_WIDE = size(802, 2, 'insert', { after: WIDE });
  const WITNESS_FIX = size(803, 3, 'update', { before: WIDE, after: WIDE_FIXED });
  const WITNESS_STILL_WIDE = size(803, 3, 'update', { before: WIDE, after: WIDER });

  it.each<{ name: string; rows: ProjectedChangeRow[]; kept: Row[]; quarantined: { row: ProjectedChangeRow; reason: string; repairedBy?: ProjectedChangeRow }[] }>([
    {
      name: 'an over-wide insert among fitting ones',
      rows: [INSERT_GOOD, INSERT_WIDE, INSERT_OTHER],
      kept: [GOOD, OTHER],
      quarantined: [{ row: INSERT_WIDE, reason: TRUNCATED }],
    },
    {
      name: 'an over-wide insert, then a delete of its key, which repairs it',
      rows: [INSERT_GOOD, INSERT_WIDE, DELETE_WIDE],
      kept: [GOOD],
      quarantined: [{ row: INSERT_WIDE, reason: TRUNCATED, repairedBy: DELETE_WIDE }],
    },
    {
      name: 'an over-wide insert, then a fitting correction of its key, which inserts the corrected row and repairs it',
      rows: [WITNESS_GOOD, WITNESS_WIDE, WITNESS_FIX],
      kept: [GOOD, WIDE_FIXED],
      quarantined: [{ row: WITNESS_WIDE, reason: TRUNCATED, repairedBy: WITNESS_FIX }],
    },
    {
      name: 'an over-wide insert, then a correction still too wide, which stays quarantined with it',
      rows: [WITNESS_GOOD, WITNESS_WIDE, WITNESS_STILL_WIDE],
      kept: [GOOD],
      quarantined: [
        { row: WITNESS_WIDE, reason: TRUNCATED },
        { row: WITNESS_STILL_WIDE, reason: TRUNCATED },
      ],
    },
  ])('$name: quarantines what legacy refuses and commits the rest with the checkpoint past every row', async ({ rows, kept, quarantined }) => {
    const s = await scenario();
    const result = await s.cycle(rows);
    const checkpoint = await s.checkpoint();
    const last = rows.at(-1) as ProjectedChangeRow;
    const repaired = quarantined.flatMap(({ row, repairedBy }) => (repairedBy === undefined ? [] : [[row, repairedBy] as const]));

    expect(result).toMatchObject({ batches: 1, rowsApplied: rows.length - quarantined.length, quarantined: quarantined.length, errors: [] });
    expect(s.sizes()).toEqual(kept.map((row) => ({ ...row })).sort(bySizeId));
    expect(checkpoint).toMatchObject({ cursorXid: last.xid, cursorSeq: last.seq, appliedHorizon: String(HORIZON), rowsApplied: rows.length - quarantined.length });
    expect(await s.quarantine()).toEqual(quarantined.map(({ row, reason, repairedBy }) => record(row, reason, checkpoint?.batchId, repairedBy)));
    expect(s.logger.error.mock.calls.map(([, message]) => message as string)).toEqual(quarantined.map(({ row }) => quarantinedLine(row)));
    expect(repairLines(s)).toEqual(repaired.length === 0 ? [] : [repairLine(repaired)]);
  });

  it.each([
    { name: 'a fitting correction', correction: WITNESS_FIX, applied: ['801', '802', '803'], quarantined: [] },
    { name: 'a correction still too wide', correction: WITNESS_STILL_WIDE, applied: ['801'], quarantined: ['802', '803'] },
  ])('after $name, the barrier reports applied every position but the unrepaired quarantined ones, which it refuses at once', async ({ correction, applied, quarantined }) => {
    const s = await scenario();
    await s.cycle([WITNESS_GOOD, WITNESS_WIDE, correction]);

    for (const xid of applied) await expect(s.awaitPosition(xid)).resolves.toMatchObject({ positions: new Map([[OWNER, xid]]) });
    for (const xid of quarantined) await expectQuarantined(s, xid);
  });

  it('replays a key quarantined by an earlier cycle when a later cycle corrects it, refusing its position only until then', async () => {
    const s = await scenario();
    const later = size(950, 3, 'update', { before: WIDE, after: WIDE_FIXED });
    await s.cycle([WITNESS_GOOD, WITNESS_WIDE]);
    const first = await s.checkpoint();
    await expectQuarantined(s, '802');

    const result = await s.cycle([later], 1000);

    expect(result).toMatchObject({ batches: 1, rowsApplied: 1, quarantined: 0, errors: [] });
    expect(s.sizes()).toEqual([GOOD, WIDE_FIXED].sort(bySizeId));
    expect(await s.quarantine()).toEqual([record(WITNESS_WIDE, TRUNCATED, first?.batchId, later)]);
    expect(repairLines(s)).toEqual([repairLine([[WITNESS_WIDE, later]])]);
    await expect(s.awaitPosition('802')).resolves.toMatchObject({ positions: new Map([[OWNER, '802']]) });
  });

  it('quarantines every change of an operation one of whose changes legacy refuses, writing none of them, and commits the rest', async () => {
    const operationId = '5b0f3c1e-7a2d-4e8f-9c6b-1d2e3f4a5b6c';
    const operationOther = size(802, 2, 'insert', { after: OTHER }, operationId);
    const operationWide = size(802, 3, 'insert', { after: WIDE }, operationId);
    const s = await scenario({ tracker: new OperationTracker({ participants: [OWNER] }) });
    s.owner.positionScript = { position: '850' };

    const result = await s.cycle([INSERT_GOOD, operationOther, operationWide], HORIZON, 4);
    const checkpoint = await s.checkpoint();

    expect(result).toMatchObject({ rowsApplied: 1, quarantined: 2, errors: [] });
    expect(s.sizes()).toEqual([GOOD]);
    expect(await s.quarantine()).toEqual([
      record(operationOther, `Operation ${operationId} has a change legacy cannot take at cursor 802:3: ${TRUNCATED}`, checkpoint?.batchId),
      record(operationWide, TRUNCATED, checkpoint?.batchId),
    ]);
    expect(s.logger.error.mock.calls.map(([, message]) => message as string)).toEqual([quarantinedLine(operationWide), quarantinedLine(operationOther)]);
    await expectQuarantined(s, '802');
  });

  it('fails the stream at its checkpoint, quarantining nothing, for an error other than legacy refusing the data', async () => {
    const deadlock = sqlError(1205);
    const s = await scenario({
      arrange: (legacy) => legacy.failNext((statement) => /^INSERT INTO \[dbo\]\.\[timagesizes\]/.test(statement.sql), deadlock),
    });

    const result = await s.cycle([INSERT_GOOD, INSERT_WIDE]);

    expect(result).toMatchObject({ batches: 0, rowsApplied: 0, quarantined: 0 });
    expect(result.errors).toEqual([{ owner: OWNER, tenantId: TENANT_A.tenantId, cursor: '0:0', error: deadlock }]);
    expect(s.sizes()).toEqual([]);
    expect(await s.checkpoint()).toBeUndefined();
    expect(await s.quarantine()).toEqual([]);
  });

  it('leaves a quarantined insert unrepaired, and its position refused, when the projector stops after the commit that corrected it', async () => {
    const killed = new Error('projector killed after the legacy commit');
    const s = await scenario({ hooks: { afterLegacyCommit: () => Promise.reject(killed) } });

    await expect(s.cycle([WITNESS_GOOD, WITNESS_WIDE, WITNESS_FIX])).rejects.toBe(killed);
    const checkpoint = await s.checkpoint();

    expect(s.sizes()).toEqual([GOOD, WIDE_FIXED].sort(bySizeId));
    expect(checkpoint).toMatchObject({ cursorXid: '803', cursorSeq: '3', appliedHorizon: String(HORIZON) });
    expect(await s.quarantine()).toEqual([record(WITNESS_WIDE, TRUNCATED, checkpoint?.batchId)]);
    expect(repairLines(s)).toEqual([]);
    await expectQuarantined(s, '802');
  });
});
