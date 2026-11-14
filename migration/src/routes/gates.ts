/** `gatesList`: the unit leases migration holds and each owner's gate rows, read side by side; nothing here changes a gate. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { UnitGate } from '@opt2/platform/migration-kit';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import type { components, operations, paths } from '../generated/openapi.js';
import { OwnerCallError, UnknownUnitError, type DataOwner, type Unit, type UnitCatalog } from '../owners/index.js';
import { holdersOf, leasesOf, type LeaseRow } from '../windows/index.js';

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

const querySchema = z.object({ units: z.string().regex(UNIT_LIST).optional() }) satisfies z.ZodType<GatesQuery>;

// Unavailable as the gateway's fail-closed rule reads it: refused or timed out, or a 502, 503 or 504 answer.
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** The units the query names, distinct and in query order, or every catalog unit; anything else is the legacy 400. */
function requestedUnits(query: unknown, catalog: GatesRouteDeps['catalog']): readonly Unit[] {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new LegacyApiError('invalidParameters');
  if (parsed.data.units === undefined) return catalog.units();
  try {
    return [...new Set(parsed.data.units.split(','))].map((id) => catalog.unit(id));
  } catch (error) {
    throw error instanceof UnknownUnitError ? new LegacyApiError('invalidParameters') : error;
  }
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

/** Binds `leases` to the lease table through `holdersOf` and `leasesOf`, and `ownerGates` to the owners client's gate status read. */
export function gateReadsOf(ctx: Pick<MigrationContext, 'db' | 'owners'>): Pick<GatesRouteDeps, 'leases' | 'ownerGates'> {
  return {
    async leases(units) {
      const requested = new Set(units);
      const holders = new Set((await holdersOf(ctx, units)).values());
      const held = await Promise.all([...holders].map((holderId) => leasesOf(ctx, holderId)));
      return held.flat().filter((lease) => requested.has(lease.unit));
    },
    async ownerGates(owner, units) {
      return (await ctx.owners.gate(owner, { op: 'status', units: [...units] })).units;
    },
  };
}

/** Registers `gatesList`, which reads leases and owner gates only after the unit filter is valid. */
export function registerGatesRoutes(app: FastifyInstance, deps: GatesRouteDeps): void {
  app.get<{ Querystring: unknown; Reply: GatesResponse }>(GATES_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const units = requestedUnits(request.query, deps.catalog);
    const ids = units.map((unit) => unit.id);
    const [leases, gates] = await Promise.all([deps.leases(ids), gatesByUnit(units, deps.ownerGates)]);
    const leaseByUnit = new Map(leases.map((lease) => [lease.unit, lease]));
    return { units: units.map((unit) => entryOf(unit, leaseByUnit.get(unit.id), gates.get(unit.id))) };
  });
}
