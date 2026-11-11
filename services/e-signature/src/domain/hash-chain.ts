// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** SHA-256 audit hash chain, byte for byte as `synthetic.usp_audit_append` appends it and the fixture verify route recomputes it. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { CanonicalEncodingError, formatCanonicalTimestamp, roundToSqlServerDatetime } from '@opt2/platform/migration-kit';

/** Byte length of a chain hash. */
export const HASH_BYTES = 32;

/** `prev_hash` of a request's first entry: 32 zero bytes. Compare with `.equals`; never mutate. */
export const GENESIS_PREV_HASH: Buffer = Buffer.alloc(HASH_BYTES);

const FIRST_SEQ = 1;
const SEPARATOR = '|';
// request_id and actor_user_id are char(35): SQL Server pads a shorter value with spaces and CONCAT keeps them.
const CHAR_ID_LENGTH = 35;
// TRY_CONVERT(datetime, …) yields NULL before 1753-01-01, even for text that would round into range.
const MIN_DATETIME_YEAR = 1753;
const HEX_HASH = /^[0-9a-f]{64}$/i;

/**
 * Which fixture recomputation to reproduce. `stored`: rows ordered by `seq`, actors hashed as padded `char(35)`.
 * `supplied`: a caller's copy in array order, actors hashed as sent (`nvarchar(max)`), so a reordered or
 * renumbered copy fails where the fixture's does.
 */
export type ChainSource = 'stored' | 'supplied';

/** Values the procedure concatenates; a string `at` is wall-clock text converted as `TRY_CONVERT(datetime, at, 126)`. */
export interface AuditCanonicalInput {
  requestId: string;
  seq: number;
  action: string;
  actorUserId: string | null;
  detail: string | null;
  at: Date | string;
}

/** An audit entry as `verifyChain` reads it: `AuditEntryRow` rows pass unchanged; a supplied copy may carry its `at` text. */
export interface ChainEntry {
  entry_id: string;
  request_id: string;
  seq: number;
  action: string;
  actor_user_id: string | null;
  detail: string | null;
  at: Date | string;
  prev_hash: Buffer;
  entry_hash: Buffer;
}

/** Rounds `at` to SQL Server `datetime` precision (1/300 s, half up), as the procedure's `@at datetime` stores it. */
export function roundAt(at: Date): Date {
  const ms = at.getMilliseconds();
  const rounded = roundToSqlServerDatetime({
    year: at.getFullYear(),
    month: at.getMonth() + 1,
    day: at.getDate(),
    hour: at.getHours(),
    minute: at.getMinutes(),
    second: at.getSeconds(),
    fractionSeconds: ms / 1000,
  });
  // Applied as an epoch offset so a carry into the next second cannot land in a local DST gap.
  const carried = rounded.second !== at.getSeconds();
  return new Date(at.getTime() - ms + (carried ? 1000 : rounded.ms));
}

/** `FORMAT(at, 'yyyy-MM-ddTHH:mm:ss.fff')` from local components; empty for text SQL Server cannot convert, as CONCAT renders NULL. */
export function canonicalAt(at: Date | string): string {
  if (at instanceof Date) return formatCanonicalTimestamp(roundAt(at));
  if (Number(at.slice(0, 4)) < MIN_DATETIME_YEAR) return '';
  try {
    return formatCanonicalTimestamp(at);
  } catch (error) {
    if (error instanceof CanonicalEncodingError) return '';
    throw error;
  }
}

function canonicalActor(actorUserId: string | null, source: ChainSource): string {
  if (actorUserId === null) return '';
  return source === 'stored' ? actorUserId.padEnd(CHAR_ID_LENGTH, ' ') : actorUserId;
}

/** The procedure's `request_id|seq|action|actor|detail|at` text; NULL actor and detail render empty. */
export function canonicalString(input: AuditCanonicalInput, source: ChainSource = 'stored'): string {
  return [
    input.requestId.padEnd(CHAR_ID_LENGTH, ' '),
    String(input.seq),
    input.action,
    canonicalActor(input.actorUserId, source),
    input.detail ?? '',
    canonicalAt(input.at),
  ].join(SEPARATOR);
}

/** `HASHBYTES('SHA2_256', prev + CAST(canonical AS varbinary(max)))`; the `nvarchar` canonical hashes as UTF-16LE. */
export function entryHash(prev: Buffer, canonical: string): Buffer {
  return createHash('sha256').update(prev).update(Buffer.from(canonical, 'utf16le')).digest();
}

/** The procedure parameters a caller supplies; `seq` and both hashes are derived. */
export interface NextEntryInput {
  requestId: string;
  action: string;
  actorUserId: string | null;
  detail: string | null;
  at: Date;
}

/** The derived columns of an appended entry; store `at` as returned so a recomputation hashes the same text. */
export interface NextEntry {
  seq: number;
  at: Date;
  canonical: string;
  prev_hash: Buffer;
  entry_hash: Buffer;
}

/** The entry the procedure appends after `last`, the request's highest-`seq` entry, or as its first when `last` is null. */
export function nextEntry(last: Pick<ChainEntry, 'seq' | 'entry_hash'> | null, input: NextEntryInput): NextEntry {
  const seq = last === null ? FIRST_SEQ : last.seq + 1;
  const prevHash = Buffer.from(last === null ? GENESIS_PREV_HASH : last.entry_hash);
  const at = roundAt(input.at);
  const canonical = canonicalString({
    requestId: input.requestId,
    seq,
    action: input.action,
    actorUserId: input.actorUserId,
    detail: input.detail,
    at,
  });
  return { seq, at, canonical, prev_hash: prevHash, entry_hash: entryHash(prevHash, canonical) };
}

/** The fixture verdict: `entries` counts every entry; `brokenat` is the `seq` of the first broken one in chain order, 0 when `valid` (an empty chain is valid). */
export interface VerifyResult {
  valid: boolean;
  entries: number;
  brokenat: number;
}

/** Recomputes a chain as the fixture verify route does: an entry breaks on its position, its link to the previous `entry_hash`, or its own hash. */
export function verifyChain(entries: readonly ChainEntry[], source: ChainSource = 'stored'): VerifyResult {
  const chain = source === 'stored' ? [...entries].sort((a, b) => a.seq - b.seq) : entries;
  let previous = GENESIS_PREV_HASH;
  for (const [index, entry] of chain.entries()) {
    const canonical = canonicalString(
      {
        requestId: entry.request_id,
        seq: entry.seq,
        action: entry.action,
        actorUserId: entry.actor_user_id,
        detail: entry.detail,
        at: entry.at,
      },
      source,
    );
    if (entry.seq !== index + 1 || !entry.prev_hash.equals(previous) || !entry.entry_hash.equals(entryHash(entry.prev_hash, canonical))) {
      return { valid: false, entries: chain.length, brokenat: entry.seq };
    }
    previous = entry.entry_hash;
  }
  return { valid: true, entries: chain.length, brokenat: 0 };
}

/** Hex text of a hash; the fixture emits lowercase everywhere. */
export function hashToHex(buf: Buffer, letterCase: 'lower' | 'upper' = 'lower'): string {
  const hex = buf.toString('hex');
  return letterCase === 'upper' ? hex.toUpperCase() : hex;
}

/** Parses a supplied hash as the fixture does: exactly 64 hex digits in either case, no `0x`; null otherwise. */
export function hashFromHex(hex: string): Buffer | null {
  return HEX_HASH.test(hex) ? Buffer.from(hex, 'hex') : null;
}
