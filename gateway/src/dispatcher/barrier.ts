// Read-after-write barrier: a session's target write positions, awaited in legacy before its legacy-bound requests.
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { formatWritePosition, type WritePositions } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import { withMetadata, type MetadataTx, type QueryResult, type TenantDb } from '@opt2/platform/tenancy';
import type { components, paths } from '../generated/clients/migration.js';

type Schemas = components['schemas'];

/** Bound migration applies to one projection await. */
export const PROJECTION_AWAIT_TIMEOUT_MS = 5000;

/** Callee name of the migration service in the service client's URL map; local so this file depends only on platform and contracts. */
const MIGRATION_SERVICE = 'migration';

/** Contract path of `projectionAwait`. */
const PROJECTION_AWAIT_PATH = '/internal/v1/projection/await' satisfies keyof paths;

const TABLE = 'session_barrier';

/** Legacy did not confirm the awaited positions within the bound, or migration could not be asked; renders as the legacy 503. */
export class BarrierTimeoutError extends LegacyServiceUnavailableError {
  override readonly name: string = 'BarrierTimeoutError';

  /** @param awaited The awaited positions as a write-position header value, or `owners:<owner>,…`. */
  constructor(
    readonly awaited: string,
    override readonly cause: unknown,
  ) {
    super(`Projection await for ${awaited} did not complete`, 'auto', 'barrier-timeout');
  }
}

/** Read-after-write barrier over `gateway.session_barrier` and migration's projection await; only its exchange ends a declaration. */
export interface SessionBarrier {
  /** Declares a target write of `owner` for the session before it is forwarded; until it ends, legacy reads await `owner`. */
  declare(sessionId: string, owner: string): Promise<void>;
  /** Records a target write's positions for the session, keeping the highest xid per owner, and ends one `declared` declaration. */
  record(sessionId: string, positions: WritePositions, declared?: string): Promise<void>;
  /** Ends one declaration of `owner` for an exchange that committed nothing, or whose write legacy already confirmed. */
  release(sessionId: string, owner: string): Promise<void>;
  /** Waits until legacy holds every recorded position and declared owner's current one, then drops confirmed positions only; else BarrierTimeoutError. */
  awaitForSession(sessionId: string): Promise<void>;
  /** Waits until legacy holds `positions`, without recording them; throws BarrierTimeoutError otherwise. */
  awaitPositions(positions: WritePositions): Promise<void>;
  /** Waits until legacy holds the owners' current write positions; throws BarrierTimeoutError otherwise. */
  awaitOwners(owners: readonly string[]): Promise<void>;
}

/** Dependencies of {@link createSessionBarrier}: the gateway schema handle and the gateway's service client. */
export interface SessionBarrierOptions {
  db: TenantDb;
  client: ServiceClient;
}

/** Creates the session barrier; SQL is qualified by the handle's schema (`gateway`). */
export function createSessionBarrier({ db, client }: SessionBarrierOptions): SessionBarrier {
  /** Sends one projection await; any answer other than 2xx leaves the positions unconfirmed, so the request fails closed. */
  async function projectionAwait(body: Schemas['ProjectionAwaitRequest'], awaited: string): Promise<void> {
    let status: number;
    try {
      // Migration sees only the gateway's invocation credential, never the browser's user token.
      ({ status } = await client.request({
        service: MIGRATION_SERVICE,
        method: 'POST',
        path: PROJECTION_AWAIT_PATH,
        json: body,
        userToken: null,
      }));
    } catch (err) {
      if (err instanceof ServiceUnavailableError) throw new BarrierTimeoutError(awaited, err);
      throw err;
    }
    if (status < 200 || status > 299) {
      throw new BarrierTimeoutError(
        awaited,
        Object.assign(new Error(`${MIGRATION_SERVICE} answered HTTP ${String(status)}`), { code: `HTTP_${String(status)}` }),
      );
    }
  }

  /** Waits until legacy holds the owners' current write positions. */
  async function ownersAwait(owners: readonly string[]): Promise<void> {
    // Owner names reach the wire unchecked here; migration validates them against its OwnerName enum.
    const body = { owners: [...owners] as Schemas['OwnerName'][], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS };
    await projectionAwait(body, `owners:${owners.join(',')}`);
  }

  /** Ends one declaration of `owner`; a row left with neither a declaration nor a position goes. */
  function endDeclaration(tx: MetadataTx, sessionId: string, owner: string): Promise<QueryResult> {
    return tx.query(
      `WITH gone AS (
         DELETE FROM ${tx.schema}.${TABLE} WHERE session_id = $1 AND owner = $2 AND pending = 1 AND xid IS NULL RETURNING owner
       )
       UPDATE ${tx.schema}.${TABLE} SET pending = pending - 1
       WHERE session_id = $1 AND owner = $2 AND pending > 0 AND NOT EXISTS (SELECT 1 FROM gone)`,
      [sessionId, owner],
    );
  }

  return {
    async declare(sessionId, owner) {
      await withMetadata(db, (tx) =>
        tx.query(
          `INSERT INTO ${tx.schema}.${TABLE} AS b (session_id, owner, pending, recorded_at) VALUES ($1, $2, 1, now())
           ON CONFLICT (session_id, owner) DO UPDATE SET pending = b.pending + 1`,
          [sessionId, owner],
        ),
      );
    },

    async record(sessionId, positions, declared) {
      if (positions.size === 0 && declared === undefined) return;
      const owners = [...positions.keys()];
      const xids = [...positions.values()];
      await withMetadata(db, async (tx) => {
        if (positions.size > 0) {
          // Numeric GREATEST orders xid8 decimals as compareXid does; text ordering would not. It ignores a NULL xid.
          await tx.query(
            `INSERT INTO ${tx.schema}.${TABLE} AS b (session_id, owner, xid, recorded_at)
             SELECT $1, p.owner, p.xid, now() FROM unnest($2::text[], $3::numeric[]) AS p(owner, xid)
             ON CONFLICT (session_id, owner) DO UPDATE SET
               xid = GREATEST(b.xid, EXCLUDED.xid),
               recorded_at = EXCLUDED.recorded_at`,
            [sessionId, owners, xids],
          );
        }
        if (declared !== undefined) await endDeclaration(tx, sessionId, declared);
      });
    },

    async release(sessionId, owner) {
      await withMetadata(db, (tx) => endDeclaration(tx, sessionId, owner));
    },

    async awaitForSession(sessionId) {
      const { rows } = await withMetadata(db, (tx) =>
        tx.query<{ owner: string; xid: string | null; pending: number }>(
          `SELECT owner, xid::text AS xid, pending FROM ${tx.schema}.${TABLE} WHERE session_id = $1`,
          [sessionId],
        ),
      );
      if (rows.length === 0) return;
      // A declared owner's current position covers every write of it, recorded or not.
      const declared = rows.filter((row) => row.pending > 0);
      const positions: Record<string, string> = Object.fromEntries(
        rows.flatMap((row) => (row.pending === 0 && row.xid !== null ? [[row.owner, row.xid]] : [])),
      );
      const awaits: Array<Promise<void>> = [];
      if (Object.keys(positions).length > 0) {
        awaits.push(projectionAwait({ positions, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS }, formatWritePosition(positions)));
      }
      if (declared.length > 0) awaits.push(ownersAwait(declared.map((row) => row.owner)));
      await Promise.all(awaits);
      // Only confirmed positions go; a declaration stays for its own exchange, and a higher position for the next request.
      await withMetadata(db, (tx) =>
        tx.query(
          `DELETE FROM ${tx.schema}.${TABLE} AS b USING unnest($2::text[], $3::numeric[]) AS p(owner, xid)
           WHERE b.session_id = $1 AND b.owner = p.owner AND b.pending = 0 AND (b.xid IS NULL OR b.xid <= p.xid)`,
          [sessionId, rows.map((row) => row.owner), rows.map((row) => row.xid)],
        ),
      );
    },

    async awaitPositions(positions) {
      if (positions.size === 0) return;
      const awaited: Record<string, string> = Object.fromEntries(positions);
      await projectionAwait({ positions: awaited, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS }, formatWritePosition(positions));
    },

    awaitOwners: ownersAwait,
  };
}
