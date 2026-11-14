// Scripted fault duplicate-batch: resends one applied migration batch under its batch id and asserts the owner treats the repeat as a no-op.
import type { ApplyRequest } from '@opt2/platform/migration-kit';
import { z } from '@opt2/platform/service-kit';

import { createApplyTenantResolver, createOwnerBatcher, type ApplyChange, type BatchSender } from '../../apply/index.js';
import { currentAuthority } from '../../cutover/index.js';
import {
  describeLegacyTable,
  listLegacyTables,
  migratableTables,
  streamLegacyTable,
  type CanonicalRow,
  type LegacyTableShape,
  type MigratableTable,
} from '../../extract/index.js';
import type { ApplyResult, DataOwner } from '../../owners/index.js';
import { compareRows, describeUnitTable, readTargetUnitRows, tableLookupKey, type UnitTableShape } from '../../reconcile/index.js';
import { latestSnapshot } from '../../snapshot/index.js';
import { fail, pass, type FaultAssertion, type FaultEnv, type FaultRunOutput, type FaultScript } from './types.js';

const FAULT = 'duplicate-batch';
const FIRST_APPLIED = 'first-applied';
const SECOND_IS_NOOP = 'second-is-noop';
const LEGACY_AUTHORITATIVE = 'legacy-authoritative';

const paramsSchema = z
  .object({
    owner: z.string().default('people'),
    table: z.string().optional(),
    rows: z.number().int().min(1).default(10),
  })
  .strict();

/** Parameters of {@link duplicateBatch}: the owner, an optional legacy table (else the owner's first keyed table with rows) and the rows to send. */
export type DuplicateBatchParams = z.output<typeof paramsSchema>;

type Ctx = FaultEnv['ctx'];

/** The table the fault resends rows of, with its first snapshot rows; `unit` is the owner unit that led to it. */
interface Selection {
  table: MigratableTable;
  shape: LegacyTableShape;
  unit: string;
  rows: [CanonicalRow, ...CanonicalRow[]];
}

/** The batch as sent and the owner's answer to its first send. */
interface Sent {
  request: ApplyRequest;
  result: ApplyResult;
}

/** What the owner holds of the table in the batch's tenant: its write position and each unit's export checksum. */
interface OwnerState {
  position: string;
  checksum: Record<string, string>;
}

/** Lookup key of a legacy table name, a `Program_<id>` name folded onto its ownership entry. */
function lookupKey(ctx: Ctx, name: string): string {
  return tableLookupKey(ctx.catalog.foldProgramTable(name).legacyTable);
}

/** Up to `limit` canonical rows of `table` in `database`, in extraction order; leaving the loop closes the stream. */
async function firstRows(ctx: Ctx, table: MigratableTable, database: string, limit: number): Promise<CanonicalRow[]> {
  const rows: CanonicalRow[] = [];
  for await (const row of streamLegacyTable(ctx, { table, database })) {
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * The named table, or the owner's first keyed migratable table with rows in unit and catalog order, read from `database`.
 * Keyless tables are refused: owners insert resent keyless rows as further occurrences instead of matching them.
 */
async function selectTable(ctx: Ctx, owner: DataOwner, database: string, params: DuplicateBatchParams): Promise<Selection | FaultAssertion> {
  const live = migratableTables(ctx.catalog, await listLegacyTables(await ctx.legacy.database(database)));
  const byKey = new Map(live.map((table) => [lookupKey(ctx, table.name), table]));
  const read = async (table: MigratableTable, unit: string): Promise<Selection | string> => {
    const shape = await describeLegacyTable(ctx, { table, database });
    if (!shape.keyed) return 'keyless table: owners insert resent keyless rows as extra occurrences';
    const [head, ...tail] = await firstRows(ctx, table, database, params.rows);
    return head === undefined ? 'table has no rows in the latest snapshot' : { table, shape, unit, rows: [head, ...tail] };
  };

  if (params.table !== undefined) {
    const detail = { owner, table: params.table };
    const table = byKey.get(lookupKey(ctx, params.table));
    if (table === undefined) return fail(SECOND_IS_NOOP, detail, 'not a migratable table of the latest snapshot');
    const unit = ctx.catalog.unitsForLegacyTable(table.name).find((target) => target.owner === owner)?.unit;
    if (unit === undefined) return fail(SECOND_IS_NOOP, detail, `table is not owned by ${owner}`);
    const selected = await read(table, unit);
    return typeof selected === 'string' ? fail(SECOND_IS_NOOP, detail, selected) : selected;
  }

  for (const unit of ctx.catalog.unitsOfOwner(owner)) {
    for (const name of ctx.catalog.legacyTablesOf(unit.id)) {
      const table = byKey.get(lookupKey(ctx, name));
      if (table === undefined) continue;
      const selected = await read(table, unit.id);
      if (typeof selected !== 'string') return selected;
    }
  }
  return fail(SECOND_IS_NOOP, { owner }, 'owner has no keyed migratable table with rows in the latest snapshot');
}

/** The selected rows of the first row's tenant and program, placed as backfill places them, so the batcher sends one batch. */
async function firstTenantRows(ctx: Ctx, database: string, selection: Selection): Promise<{ tenantId: string; rows: CanonicalRow[] }> {
  const resolver = await createApplyTenantResolver(ctx, { database });
  const tenantOf = (row: CanonicalRow): string => resolver.resolve(selection.table.name, row.row).tenantId;
  const [head] = selection.rows;
  const tenantId = tenantOf(head);
  const rows = selection.rows.filter((row) => row.legacyProgramId === head.legacyProgramId && tenantOf(row) === tenantId);
  return { tenantId, rows };
}

/**
 * Builds the batch with the owner batcher, as backfill and feed build theirs, and sends it once: its sender swaps in the
 * fault's batch id and performs the first send. No watermark rides on it, so the owner's feed watermark stays as it was.
 */
async function sendOnce(
  ctx: Ctx,
  input: { owner: DataOwner; selection: Selection; snapshotSeq: number; units: string[]; tenantId: string; rows: CanonicalRow[]; batchId: string },
): Promise<Sent> {
  const sends: Sent[] = [];
  const sender: BatchSender = {
    async apply(owner, built) {
      const request: ApplyRequest = { ...built, batchId: input.batchId };
      const result = await ctx.owners.apply(owner, request);
      sends.push({ request, result });
      return result;
    },
    putWatermark: () => Promise.reject(new Error(`The ${FAULT} fault sends no watermark`)),
    get acknowledged() {
      return sends.length;
    },
  };
  const batcher = createOwnerBatcher({
    owner: input.owner,
    legacyTable: input.selection.table.name,
    direction: 'feed',
    snapshotSeq: input.snapshotSeq,
    origin: 'migration-feed',
    columns: input.selection.shape.columns,
    units: input.units,
    batchSize: input.rows.length,
    sender,
    watermark: null,
  });
  for (const row of input.rows) {
    const change: ApplyChange = { op: 'upsert', row: row.encoding };
    await batcher.add(input.tenantId, change, row.legacyProgramId);
  }
  await batcher.finish();
  const [sent] = sends;
  if (sent === undefined || sends.length !== 1) throw new Error(`The ${FAULT} batcher sent ${String(sends.length)} batches, not one`);
  return sent;
}

/** Target SHA-256 of each unit's share of the table in `tenantId`, measured from the owner's export as reconciliation measures it. */
async function exportChecksum(ctx: Ctx, shapes: readonly UnitTableShape[], tenantId: string): Promise<Record<string, string>> {
  const checksum: Record<string, string> = {};
  for (const shape of shapes) {
    const target = await readTargetUnitRows(ctx, shape, tenantId, { includeObjects: false });
    try {
      const measured = await compareRows({ keyed: shape.keyed, columns: shape.columns, legacy: [], target: target.rows });
      checksum[shape.unit] = measured.targetSha256;
    } finally {
      await target.dispose();
    }
  }
  return checksum;
}

/** The owner's current write position and export checksums of `shapes` in `tenantId`. */
async function ownerState(ctx: Ctx, owner: DataOwner, shapes: readonly UnitTableShape[], tenantId: string): Promise<OwnerState> {
  return { position: (await ctx.owners.position(owner)).position, checksum: await exportChecksum(ctx, shapes, tenantId) };
}

/** The no-op verdict on the resent batch: reported duplicate, no committed write, and an unchanged export. */
function secondIsNoop(
  second: ApplyResult,
  facts: { batchId: string; owner: DataOwner; table: string; tenantId: string; rows: number; before: OwnerState; after: OwnerState },
): FaultAssertion {
  const { before, after, ...batch } = facts;
  const writePosition = second.writePositions.get(facts.owner);
  const changed = Object.keys(before.checksum).filter((unit) => before.checksum[unit] !== after.checksum[unit]);
  const problems = [
    ...(second.duplicate ? [] : ['the owner did not report the resent batch as a duplicate']),
    ...(writePosition === undefined ? [] : [`the resent batch committed a write at position ${writePosition}`]),
    ...(changed.length === 0 ? [] : [`the owner export changed for ${changed.join(', ')}`]),
  ];
  const position = { before: before.position, after: after.position };
  if (problems.length === 0) return pass(SECOND_IS_NOOP, { ...batch, checksum: after.checksum, position });
  return fail(
    SECOND_IS_NOOP,
    {
      ...batch,
      duplicate: second.duplicate,
      applied: second.applied,
      writePosition: writePosition ?? null,
      checksum: { before: before.checksum, after: after.checksum },
      position,
    },
    problems.join('; '),
  );
}

async function run(env: FaultEnv, params: DuplicateBatchParams): Promise<FaultRunOutput> {
  const { ctx } = env;
  const owner = ctx.config.dataOwners.find((name) => name === params.owner);
  if (owner === undefined) return { assertions: [fail(SECOND_IS_NOOP, { owner: params.owner }, 'unknown data owner')], details: { owner: params.owner } };
  const snapshot = await latestSnapshot(ctx);
  if (snapshot === null) return { assertions: [fail(SECOND_IS_NOOP, 'no snapshot', 'take S0 and backfill before this fault')], details: { owner } };
  const database = snapshot.databaseName;

  const selection = await selectTable(ctx, owner, database, params);
  if ('status' in selection) return { assertions: [selection], details: { owner, table: params.table, snapshotSeq: snapshot.seq } };
  const table = selection.table.name;
  const units = ctx.catalog
    .unitsForLegacyTable(table)
    .filter((target) => target.owner === owner)
    .map((target) => target.unit);
  const details: Record<string, unknown> = { owner, table, unit: selection.unit, units, snapshotSeq: snapshot.seq };

  const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
  const targetUnits = units.filter((unit) => authority.isTargetAuthoritative(unit));
  if (targetUnits.length > 0) {
    const refused = fail(
      LEGACY_AUTHORITATIVE,
      { units: targetUnits, tableVersion: authority.tableVersion },
      'applying snapshot rows to a target-authoritative unit is refused',
    );
    return { assertions: [refused], details };
  }

  const { tenantId, rows } = await firstTenantRows(ctx, database, selection);
  const batchId = `fault:${FAULT}:${env.clock.now().toISOString()}`;
  Object.assign(details, { tenantId, batchId, rows: rows.length });
  const shapes: UnitTableShape[] = [];
  for (const unit of units) shapes.push(await describeUnitTable(ctx, { unit, legacyTable: table, database }));

  const { request, result: first } = await sendOnce(ctx, { owner, selection, snapshotSeq: snapshot.seq, units, tenantId, rows, batchId });
  const before = await ownerState(ctx, owner, shapes, tenantId);
  const second = await ctx.owners.apply(owner, request);
  const after = await ownerState(ctx, owner, shapes, tenantId);

  const firstApplied = first.duplicate
    ? fail(FIRST_APPLIED, { batchId, owner, table, tenantId }, 'batch id collided')
    : pass(FIRST_APPLIED, { batchId, applied: first.applied, skipped: first.skipped });
  return {
    assertions: [firstApplied, secondIsNoop(second, { batchId, owner, table, tenantId, rows: rows.length, before, after })],
    details,
  };
}

/** Resends one applied batch with the same batch id to an owner and asserts the repeat was a no-op; nothing is left to recover. */
export const duplicateBatch: FaultScript<DuplicateBatchParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,
  run,
  resume: () => Promise.resolve({ steps: [], assertions: [] }),
};
