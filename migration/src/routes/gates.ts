/** `gatesList`: the unit leases migration holds and each owner's gate rows, read side by side; nothing here changes a gate. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { UnitGate } from '@opt2/platform/migration-kit';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import type { components, operations, paths } from '../generated/openapi.js';
import { OwnerCallError, UnknownUnitError, type DataOwner, type Unit, type UnitCatalog } from '../owners/index.js';
import { leasesOfUnits, type LeaseRow } from '../windows/index.js';

type GatesResponse = components['schemas']['GatesResponse'];
type GatesEntry = GatesResponse['units'][number];
type OwnerName = components['schemas']['OwnerName'];
type GatesQuery = NonNullable<operations['gatesList']['parameters']['query']>;

/**
 * The reads the route combines. The contract's `GatesResponse` carries no window or transition detail, so holder records
 * are not read: each lease reports its holder id and kind only.
 */
export interface GatesRouteDeps {
  catalog: Pick<UnitCatalog, 'units' | 'unit'>;
  /** Leases of `units` from `migration.unit_lease`; unleased units are absent. */
  leases(units: readonly string[]): Promise<LeaseRow[]>;
  /** Gate rows `owner` holds for `units`, read through its `/internal/v1/migration/gate` status operation. */
  ownerGates(owner: DataOwner, units: readonly string[]): Promise<UnitGate[]>;
}

const GATES_PATH = '/internal/v1/gates' satisfies keyof paths;

/** Operations this module registers: contract `path` and Fastify `url`. */
export const GATES_ROUTES = Object.freeze([
  Object.freeze({ operationId: 'gatesList', method: 'GET', path: GATES_PATH, url: GATES_PATH } as const),
]);

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.platformOperator]),
});

// UnitList as the contract declares it: comma-separated `<schema>.<table>` ids.
const UNIT_LIST = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)*$/;

// PageLimit as the contract declares it: a decimal page size from 1 to 500.
const PAGE_LIMIT_MAX = 500;

const querySchema = z.object({
  units: z.string().regex(UNIT_LIST).optional(),
  limit: z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.int().min(1).max(PAGE_LIMIT_MAX)).optional(),
  cursor: z.string().optional(),
}) satisfies z.ZodType<GatesQuery>;

// Unavailable as the gateway's fail-closed rule reads it: refused or timed out, or a 502, 503 or 504 answer.
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** One page of the selected units, with the cursor of the next page when units of the selection remain after it. */
interface UnitPage {
  units: readonly Unit[];
  nextCursor?: string;
}

/** The units `ids` names, distinct and in query order; an unknown unit is the legacy 400. */
function namedUnits(ids: string, catalog: GatesRouteDeps['catalog']): readonly Unit[] {
  try {
    return [...new Set(ids.split(','))].map((id) => catalog.unit(id));
  } catch (error) {
    throw error instanceof UnknownUnitError ? new LegacyApiError('invalidParameters') : error;
  }
}

/**
 * The page the query asks for: the units it names, or every catalog unit, from after `cursor` and at most `limit` long.
 * An invalid query, or a cursor that names no unit of the selection, is the legacy 400.
 */
function requestedPage(query: unknown, catalog: GatesRouteDeps['catalog']): UnitPage {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new LegacyApiError('invalidParameters');
  const { units, limit, cursor } = parsed.data;
  const selection = units === undefined ? catalog.units() : namedUnits(units, catalog);
  const start = cursor === undefined ? 0 : selection.findIndex((unit) => unit.id === cursor) + 1;
  if (cursor !== undefined && start === 0) throw new LegacyApiError('invalidParameters');
  const page = selection.slice(start, limit === undefined ? selection.length : start + limit);
  const last = page.at(-1);
  return start + page.length < selection.length && last !== undefined ? { units: page, nextCursor: last.id } : { units: page };
}

function isUnavailable(error: unknown): boolean {
  return error instanceof LegacyServiceUnavailableError || (error instanceof OwnerCallError && UNAVAILABLE_STATUSES.has(error.status));
}

/** Gate rows of every owner of `units` by unit; an unreachable owner's units have none, as the contract allows. */
async function gatesByUnit(units: readonly Unit[], ownerGates: GatesRouteDeps['ownerGates']): Promise<Map<string, UnitGate>> {
  const byOwner = new Map<DataOwner, string[]>();
  for (const unit of units) byOwner.set(unit.owner, [...(byOwner.get(unit.owner) ?? []), unit.id]);
  const rows = await Promise.all(
    [...byOwner].map(([owner, ids]) =>
      ownerGates(owner, ids).catch((error: unknown) => {
        if (isUnavailable(error)) return [];
        throw error;
      }),
    ),
  );
  return new Map(rows.flat().map((gate) => [gate.unit, gate]));
}

function entryOf(unit: Unit, lease: LeaseRow | undefined, gate: UnitGate | undefined): GatesEntry {
  return {
    unit: unit.id,
    // Catalog units belong to config `dataOwners`, all of them contract owner names.
    owner: unit.owner as OwnerName,
    ...(lease === undefined ? {} : { lease: { holderId: lease.holderId, kind: lease.kind, acquiredAt: lease.acquiredAt.toISOString() } }),
    ...(gate === undefined ? {} : { gate: { state: gate.state, holderId: gate.holderId, phase: gate.phase } }),
  };
}

/** Binds `leases` to the lease table through the single read `leasesOfUnits`, and `ownerGates` to the owners client's gate status read. */
export function gateReadsOf(ctx: Pick<MigrationContext, 'db' | 'owners'>): Pick<GatesRouteDeps, 'leases' | 'ownerGates'> {
  return {
    leases: (units) => leasesOfUnits(ctx, units),
    async ownerGates(owner, units) {
      return (await ctx.owners.gate(owner, { op: 'status', units: [...units] })).units;
    },
  };
}

/** Registers `gatesList`, which reads leases and owner gates only for the units of the requested page, once the query is valid. */
export function registerGatesRoutes(app: FastifyInstance, deps: GatesRouteDeps): void {
  app.get<{ Querystring: unknown; Reply: GatesResponse }>(GATES_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const page = requestedPage(request.query, deps.catalog);
    if (page.units.length === 0) return { units: [] };
    const ids = page.units.map((unit) => unit.id);
    const [leases, gates] = await Promise.all([deps.leases(ids), gatesByUnit(page.units, deps.ownerGates)]);
    const leaseByUnit = new Map(leases.map((lease) => [lease.unit, lease]));
    const units = page.units.map((unit) => entryOf(unit, leaseByUnit.get(unit.id), gates.get(unit.id)));
    return page.nextCursor === undefined ? { units } : { units, nextCursor: page.nextCursor };
  });
}
