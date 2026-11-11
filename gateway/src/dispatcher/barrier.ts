// Read-after-write barrier: a session's target write positions, awaited in legacy before its legacy-bound requests.
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { formatWritePosition, type WritePositions } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import { withMetadata, type TenantDb } from '@opt2/platform/tenancy';
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

/** The gateway's read-after-write barrier over `gateway.session_barrier` and migration's projection await. */
export interface SessionBarrier {
  /** Records a target write's positions for the session, keeping the highest xid per owner. */
  record(sessionId: string, positions: WritePositions): Promise<void>;
  /** Waits until legacy holds every recorded position of the session; throws BarrierTimeoutError otherwise. */
  awaitForSession(sessionId: string): Promise<void>;
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

  return {
    async record(sessionId, positions) {
      if (positions.size === 0) return;
      const owners = [...positions.keys()];
      const xids = [...positions.values()];
      // Numeric GREATEST orders xid8 decimals as compareXid does; text ordering would not.
      await withMetadata(db, (tx) =>
        tx.query(
          `INSERT INTO ${tx.schema}.${TABLE} AS b (session_id, owner, xid, recorded_at)
           SELECT $1, p.owner, p.xid, now() FROM unnest($2::text[], $3::numeric[]) AS p(owner, xid)
           ON CONFLICT (session_id, owner) DO UPDATE SET
             xid = GREATEST(b.xid, EXCLUDED.xid),
             recorded_at = EXCLUDED.recorded_at`,
          [sessionId, owners, xids],
        ),
      );
    },

    async awaitForSession(sessionId) {
      const { rows } = await withMetadata(db, (tx) =>
        tx.query<{ owner: string; xid: string }>(
          `SELECT owner, xid::text AS xid FROM ${tx.schema}.${TABLE} WHERE session_id = $1`,
          [sessionId],
        ),
      );
      if (rows.length === 0) return;
      const positions: Record<string, string> = Object.fromEntries(rows.map((row) => [row.owner, row.xid]));
      await projectionAwait({ positions, timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS }, formatWritePosition(positions));
      // Only rows still at the applied xid go; a position recorded meanwhile stays for the next request.
      await withMetadata(db, (tx) =>
        tx.query(
          `DELETE FROM ${tx.schema}.${TABLE} AS b USING unnest($2::text[], $3::numeric[]) AS p(owner, xid)
           WHERE b.session_id = $1 AND b.owner = p.owner AND b.xid <= p.xid`,
          [sessionId, Object.keys(positions), Object.values(positions)],
        ),
      );
    },

    async awaitOwners(owners) {
      // Owner names reach the wire unchecked here; migration validates them against its OwnerName enum.
      const body = { owners: [...owners] as Schemas['OwnerName'][], timeoutMs: PROJECTION_AWAIT_TIMEOUT_MS };
      await projectionAwait(body, `owners:${owners.join(',')}`);
    },
  };
}
