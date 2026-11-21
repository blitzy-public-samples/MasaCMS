// Write positions of @opt2/platform/migration-kit: the `X-Opt2-Write-Position` header of the read-after-write barrier.
import { currentRequestContext, recordWritePosition, type FastifyInstance } from '../service-kit/index.js';

/** Response header listing the committed write positions of a target write as `<owner>=<xid>[,<owner>=<xid>…]`. */
export const WRITE_POSITION_HEADER = 'X-Opt2-Write-Position';

/** {@link WRITE_POSITION_HEADER} as Fastify and undici header maps key it. */
export const WRITE_POSITION_HEADER_LC = 'x-opt2-write-position';

/** Owner (service name) -> `pg_current_xact_id()` of its committed transaction, as a decimal string. */
export type WritePositions = Map<string, string>;

/** Thrown when a write-position header value is malformed. */
export class InvalidWritePositionError extends Error {
  override readonly name: string = 'InvalidWritePositionError';

  constructor(readonly entry: string) {
    super(`Invalid ${WRITE_POSITION_HEADER} entry: ${JSON.stringify(entry)}`);
  }
}

const OWNER_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const XID_PATTERN = /^\d+$/;

/** Compares two xid8 values numerically; returns -1, 0 or 1. */
export function compareXid(a: string | bigint, b: string | bigint): -1 | 0 | 1 {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function keepHigher(positions: WritePositions, owner: string, xid: string): void {
  const previous = positions.get(owner);
  if (previous === undefined || compareXid(xid, previous) > 0) {
    positions.set(owner, BigInt(xid).toString());
  }
}

/** Formats positions as the header value, entries sorted by owner; `''` when there are none. */
export function formatWritePosition(positions: WritePositions | Readonly<Record<string, string>>): string {
  const entries = positions instanceof Map ? [...positions] : Object.entries(positions);
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([owner, xid]) => `${owner}=${xid}`)
    .join(',');
}

/**
 * Parses a header value, or the values of a repeated header, into positions keeping the highest xid per owner.
 * Empty list elements are ignored; an entry that is not `<owner>=<digits>` throws InvalidWritePositionError.
 */
export function parseWritePosition(value: string | string[] | undefined): WritePositions {
  const positions: WritePositions = new Map();
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  for (const raw of joined.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const separator = entry.indexOf('=');
    const owner = entry.slice(0, separator);
    const xid = entry.slice(separator + 1);
    if (separator < 0 || !OWNER_PATTERN.test(owner) || !XID_PATTERN.test(xid)) {
      throw new InvalidWritePositionError(entry);
    }
    keepHigher(positions, owner, xid);
  }
  return positions;
}

/** Union of position sets, keeping the highest xid per owner. */
export function mergeWritePosition(...sets: Array<WritePositions | undefined>): WritePositions {
  const merged: WritePositions = new Map();
  for (const set of sets) {
    for (const [owner, xid] of set ?? []) keepHigher(merged, owner, xid);
  }
  return merged;
}

/** Records every position of a downstream reply's header in the active request context; a no-op outside a request. */
export function recordWritePositionsFrom(headerValue: string | string[] | undefined): void {
  const positions = parseWritePosition(headerValue);
  // recordWritePosition throws outside a request; there is then no response to carry the positions.
  if (currentRequestContext() === undefined) return;
  for (const [owner, xid] of positions) recordWritePosition(owner, xid);
}

const registered = new WeakSet<object>();

/** Adds the `onSend` hook emitting the request's recorded write positions as the header; once per app instance. */
export function registerWritePositionHeader(app: FastifyInstance): void {
  if (registered.has(app)) return;
  registered.add(app);
  app.addHook('onSend', (_request, reply, payload, done) => {
    const positions = currentRequestContext()?.writePositions;
    if (positions !== undefined && positions.size > 0) {
      reply.header(WRITE_POSITION_HEADER, formatWritePosition(positions));
    }
    done(null, payload);
  });
}

/** True when the hook is registered on `app` or on an instance it was encapsulated from. */
export function hasWritePositionHeader(app: FastifyInstance): boolean {
  // Fastify encapsulated instances are created with Object.create(parent).
  let instance: object | null = app;
  while (instance !== null) {
    if (registered.has(instance)) return true;
    instance = Object.getPrototypeOf(instance) as object | null;
  }
  return false;
}
