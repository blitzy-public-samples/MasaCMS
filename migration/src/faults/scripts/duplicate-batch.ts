// Scripted fault duplicate-batch: resends one applied migration batch under its batch id and asserts the owner treats the repeat as a no-op.
import type { ApplyRequest } from '@opt2/platform/migration-kit';
import { z } from '@opt2/platform/service-kit';

import {
  createApplyTenantResolver,
  createOwnerBatcher,
  hintOf,
  type ApplyChange,
  type BatchSender,
  type TargetHint,
  type TenantResolver,
} from '../../apply/index.js';
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
import type { ApplyResult, DataOwner, LegacyTableTarget } from '../../owners/index.js';
import {
  compareRows,
  describeUnitTable,
  readLegacyUnitRows,
  readTargetUnitRows,
  tableLookupKey,
  toUnitRow,
  type UnitTableShape,
} from '../../reconcile/index.js';
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

/** Parameters of {@link duplicateBatch}: the owner, an optional legacy table (else the owner's first keyed table with rows its units take) and the rows to send. */
export type DuplicateBatchParams = z.output<typeof paramsSchema>;

type Ctx = FaultEnv['ctx'];

/** The table the fault resends rows of, with snapshot rows of one tenant and program that `unit` takes and the discriminator they need. */
interface Selection {
  table: MigratableTable;
  shape: LegacyTableShape;
  unit: string;
  tenantId: string;
  discriminator: TargetHint['discriminator'];
  rows: [CanonicalRow, ...CanonicalRow[]];
}

/** Unit-row keys a unit takes in one tenant and program of the snapshot. */
interface AcceptedKeys {
  tenantId: string;
  legacyProgramId: number | undefined;
  keys: ReadonlySet<string>;
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

/** Keys of the first `limit` rows the unit takes in its first tenant with rows and that tenant's first program; null when none. */
async function acceptedKeys(
  ctx: Ctx,
  shape: UnitTableShape,
  options: { database: string; tenants: TenantResolver; limit: number },
): Promise<AcceptedKeys | null> {
  const unitRows = await readLegacyUnitRows(ctx, shape, { database: options.database, tenants: options.tenants });
  try {
    const tenantId = unitRows.tenants.find((tenant) => (unitRows.counts.get(tenant) ?? 0) > 0);
    if (tenantId === undefined) return null;
    const keys = new Set<string>();
    let program: { id: number | undefined } | undefined;
    for await (const row of unitRows.rows(tenantId)) {
      program ??= { id: row.legacyProgramId };
      if (row.legacyProgramId !== program.id) continue;
      keys.add(row.key);
      if (keys.size >= options.limit) break;
    }
    return program === undefined ? null : { tenantId, legacyProgramId: program.id, keys };
  } finally {
    await unitRows.dispose();
  }
}

/** Full legacy rows of `table` whose unit key and program are among `accepted`, in extraction order; leaving the loop closes the stream. */
async function acceptedRows(ctx: Ctx, table: MigratableTable, database: string, shape: UnitTableShape, accepted: AcceptedKeys): Promise<CanonicalRow[]> {
  const rows: CanonicalRow[] = [];
  for await (const row of streamLegacyTable(ctx, { table, database })) {
    if (row.legacyProgramId !== accepted.legacyProgramId || !accepted.keys.has(toUnitRow(shape, row.row, row.legacyProgramId).key)) continue;
    rows.push(row);
    if (rows.length >= accepted.keys.size) break;
  }
  return rows;
}

/**
 * The named table, or the owner's first keyed migratable table in unit and catalog order whose unit takes rows, read from `database`.
 * Keyless tables are refused: owners insert resent keyless rows as further occurrences instead of matching them.
 */
async function selectTable(ctx: Ctx, owner: DataOwner, database: string, params: DuplicateBatchParams): Promise<Selection | FaultAssertion> {
  const live = migratableTables(ctx.catalog, await listLegacyTables(await ctx.legacy.database(database)));
  const byKey = new Map(live.map((table) => [lookupKey(ctx, table.name), table]));
  let tenants: Promise<TenantResolver> | undefined;
  const take = async (table: MigratableTable, shape: LegacyTableShape, target: LegacyTableTarget): Promise<Selection | null> => {
    const unitShape = await describeUnitTable(ctx, { unit: target.unit, legacyTable: table.name, database });
    tenants ??= createApplyTenantResolver(ctx, { database });
    const accepted = await acceptedKeys(ctx, unitShape, { database, tenants: await tenants, limit: params.rows });
    if (accepted === null) return null;
    const [head, ...tail] = await acceptedRows(ctx, table, database, unitShape, accepted);
    if (head === undefined) return null;
    const { discriminator } = hintOf(target, shape.columns);
    return { table, shape, unit: target.unit, tenantId: accepted.tenantId, discriminator, rows: [head, ...tail] };
  };

  if (params.table !== undefined) {
    const detail = { owner, table: params.table };
    const table = byKey.get(lookupKey(ctx, params.table));
    if (table === undefined) return fail(SECOND_IS_NOOP, detail, 'not a migratable table of the latest snapshot');
    const targets = ctx.catalog.unitsForLegacyTable(table.name).filter((target) => target.owner === owner);
    if (targets.length === 0) return fail(SECOND_IS_NOOP, detail, `table is not owned by ${owner}`);
    const shape = await describeLegacyTable(ctx, { table, database });
    if (!shape.keyed) return fail(SECOND_IS_NOOP, detail, 'keyless table: owners insert resent keyless rows as extra occurrences');
    for (const target of targets) {
      const selected = await take(table, shape, target);
      if (selected !== null) return selected;
    }
    return fail(SECOND_IS_NOOP, detail, `the owner's unit takes no row of ${table.name} in the latest snapshot`);
  }

  for (const unit of ctx.catalog.unitsOfOwner(owner)) {
    for (const name of ctx.catalog.legacyTablesOf(unit.id)) {
      const table = byKey.get(lookupKey(ctx, name));
      const target = table === undefined ? undefined : ctx.catalog.unitsForLegacyTable(table.name).find((candidate) => candidate.unit === unit.id);
      if (table === undefined || target === undefined) continue;
      const shape = await describeLegacyTable(ctx, { table, database });
      if (!shape.keyed) continue;
      const selected = await take(table, shape, target);
      if (selected !== null) return selected;
    }
  }
  return fail(SECOND_IS_NOOP, { owner }, 'owner has no keyed migratable table with rows its units take');
}

/**
 * Builds the batch with the owner batcher, as backfill and feed build theirs, and sends it once: its sender swaps in the
 * fault's batch id and performs the first send. No watermark rides on it, so the owner's feed watermark stays as it was.
 */
async function sendOnce(ctx: Ctx, input: { owner: DataOwner; selection: Selection; snapshotSeq: number; units: string[]; batchId: string }): Promise<Sent> {
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
    batchSize: input.selection.rows.length,
    sender,
    watermark: null,
  });
  const { tenantId, discriminator, rows } = input.selection;
  for (const row of rows) {
    const change: ApplyChange = { op: 'upsert', row: row.encoding, ...(discriminator === undefined ? {} : { discriminator }) };
    await batcher.add(tenantId, change, row.legacyProgramId);
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

/** The verdict on the first send: a fresh batch id of which the owner applied every selected row. */
function firstApplied(first: ApplyResult, facts: { batchId: string; owner: DataOwner; table: string; tenantId: string; rows: number }): FaultAssertion {
  const { rows, ...batch } = facts;
  if (first.duplicate) return fail(FIRST_APPLIED, batch, 'batch id collided');
  if (first.applied > 0 && first.applied === rows) return pass(FIRST_APPLIED, { batchId: facts.batchId, applied: first.applied, skipped: first.skipped });
  const reason =
    first.applied === 0
      ? `the owner applied none of the ${String(rows)} rows`
      : first.applied < rows
        ? `the owner skipped ${String(rows - first.applied)} of ${String(rows)} selected rows`
        : `the owner reported ${String(first.applied)} rows applied of ${String(rows)} sent`;
  return fail(FIRST_APPLIED, { ...facts, applied: first.applied, skipped: first.skipped }, reason);
}

/** The no-op verdict on the resent batch: a fully applied first send (`firstFailure` unset), reported duplicate, no committed write, an unchanged export. */
function secondIsNoop(
  second: ApplyResult,
  facts: { batchId: string; owner: DataOwner; table: string; tenantId: string; rows: number; before: OwnerState; after: OwnerState },
  firstFailure: string | undefined,
): FaultAssertion {
  const { before, after, ...batch } = facts;
  const writePosition = second.writePositions.get(facts.owner);
  const changed = Object.keys(before.checksum).filter((unit) => before.checksum[unit] !== after.checksum[unit]);
  const problems = [
    ...(firstFailure === undefined ? [] : [`${firstFailure}, so the repeat proves no data-write idempotency`]),
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

  const { tenantId, rows } = selection;
  const batchId = `fault:${FAULT}:${env.clock.now().toISOString()}`;
  Object.assign(details, { tenantId, batchId, rows: rows.length, discriminator: selection.discriminator ?? null });
  const shapes: UnitTableShape[] = [];
  for (const unit of units) shapes.push(await describeUnitTable(ctx, { unit, legacyTable: table, database }));

  const { request, result: first } = await sendOnce(ctx, { owner, selection, snapshotSeq: snapshot.seq, units, batchId });
  const before = await ownerState(ctx, owner, shapes, tenantId);
  const second = await ctx.owners.apply(owner, request);
  const after = await ownerState(ctx, owner, shapes, tenantId);

  const firstVerdict = firstApplied(first, { batchId, owner, table, tenantId, rows: rows.length });
  const firstFailure = firstVerdict.status === 'pass' ? undefined : firstVerdict.reason;
  return {
    assertions: [firstVerdict, secondIsNoop(second, { batchId, owner, table, tenantId, rows: rows.length, before, after }, firstFailure)],
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
