/**
 * Legacy bridge assertion signer and verifier (checked by gateway/legacy-bridge/cfml/Application.cfc).
 *
 * Wire format:
 *   json   = compact JSON, keys in this order: aud, op, sid, sub, siteId, exp, nonce
 *            aud = "legacy-bridge"; op, sid, sub, siteId are strings ("" when absent, never null);
 *            exp = integer epoch seconds; nonce = 32 lowercase hex chars (16 random bytes)
 *   p      = base64url(utf8(json)), unpadded (RFC 4648 §5)
 *   sig    = lowercase hex HMAC-SHA256(key = utf8(OPT2_BRIDGE_HMAC_KEY), message = ascii(p))
 *   header = X-Opt2-Bridge-Assertion: <p>.<sig>
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const BRIDGE_ASSERTION_HEADER = 'X-Opt2-Bridge-Assertion';
export const BRIDGE_AUDIENCE = 'legacy-bridge';
export const BRIDGE_MAX_TTL_SECONDS = 60;
export const BRIDGE_NONCE_WINDOW_SECONDS = 120;

/** Signed claims of one bridge call. */
export interface BridgeAssertionPayload {
  aud: 'legacy-bridge';
  op: string;
  sid: string;
  sub: string;
  siteId: string;
  exp: number;
  nonce: string;
}

/** Signer input; `ttlSeconds` defaults to 60 and `now` to the current time. */
export interface BridgeAssertionInput {
  op: string;
  sid?: string;
  sub?: string;
  siteId?: string;
  ttlSeconds?: number;
  now?: Date;
}

export type BridgeAssertionRejection = 'malformed' | 'signature' | 'audience' | 'expired' | 'too-far' | 'replay';

export type BridgeAssertionResult =
  | { ok: true; payload: BridgeAssertionPayload }
  | { ok: false; reason: BridgeAssertionRejection };

/** Single-use nonce ledger; `seen` is true while a remembered nonce has not reached its `untilSeconds`. */
export interface NonceStore {
  seen(nonce: string, nowSeconds: number): boolean;
  remember(nonce: string, untilSeconds: number): void;
}

/** In-process nonce ledger that evicts expired entries whenever it is queried. */
export class MemoryNonceStore implements NonceStore {
  readonly #until = new Map<string, number>();

  seen(nonce: string, nowSeconds: number): boolean {
    for (const [entry, until] of this.#until) {
      if (until <= nowSeconds) this.#until.delete(entry);
    }
    return this.#until.has(nonce);
  }

  remember(nonce: string, untilSeconds: number): void {
    this.#until.set(nonce, untilSeconds);
  }
}

/** Returns the payload part `p`: unpadded base64url of the compact JSON in wire key order. */
export function encodeBridgePayload(p: BridgeAssertionPayload): string {
  const json = JSON.stringify({
    aud: p.aud,
    op: p.op,
    sid: p.sid,
    sub: p.sub,
    siteId: p.siteId,
    exp: p.exp,
    nonce: p.nonce,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Signs one bridge call and returns the header value `<p>.<sig>`; throws RangeError for a TTL outside 1..60 or an empty key. */
export function signBridgeAssertion(a: BridgeAssertionInput, key: string): string {
  const ttl = a.ttlSeconds ?? BRIDGE_MAX_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > BRIDGE_MAX_TTL_SECONDS) {
    throw new RangeError(`ttlSeconds must be an integer in 1..${BRIDGE_MAX_TTL_SECONDS}`);
  }
  if (key === '') throw new RangeError('bridge HMAC key must not be empty');
  const p = encodeBridgePayload({
    aud: BRIDGE_AUDIENCE,
    op: a.op,
    sid: a.sid ?? '',
    sub: a.sub ?? '',
    siteId: a.siteId ?? '',
    exp: epochSeconds(a.now ?? new Date()) + ttl,
    nonce: randomBytes(16).toString('hex'),
  });
  return `${p}.${macHex(p, key)}`;
}

/** Verifies a header value: valid MAC, aud "legacy-bridge", now < exp <= now + 60, nonce unseen; remembers the nonce for 120 s on success. */
export function verifyBridgeAssertion(
  value: string,
  key: string,
  store: NonceStore,
  now: Date = new Date(),
): BridgeAssertionResult {
  const parts = value.split('.');
  const [p, sig] = parts;
  if (parts.length !== 2 || !p || !sig) return reject('malformed');
  // An empty key would make any caller able to forge assertions, so it verifies nothing.
  if (key === '' || !macMatches(p, sig, key)) return reject('signature');
  const claims = decodeBridgePayload(p);
  if (claims === undefined) return reject('malformed');
  if (claims.aud !== BRIDGE_AUDIENCE) return reject('audience');
  const nowSeconds = epochSeconds(now);
  if (claims.exp <= nowSeconds) return reject('expired');
  if (claims.exp > nowSeconds + BRIDGE_MAX_TTL_SECONDS) return reject('too-far');
  if (store.seen(claims.nonce, nowSeconds)) return reject('replay');
  store.remember(claims.nonce, nowSeconds + BRIDGE_NONCE_WINDOW_SECONDS);
  return { ok: true, payload: { ...claims, aud: BRIDGE_AUDIENCE } };
}

type DecodedClaims = Omit<BridgeAssertionPayload, 'aud'> & { aud: unknown };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Decodes `p` into claims with string fields, an integer `exp` and a non-empty nonce, or undefined. */
function decodeBridgePayload(p: string): DecodedClaims | undefined {
  if (!BASE64URL.test(p)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { aud, op, sid, sub, siteId, exp, nonce } = raw as Record<string, unknown>;
  if (typeof op !== 'string' || typeof sid !== 'string' || typeof sub !== 'string') return undefined;
  if (typeof siteId !== 'string' || typeof exp !== 'number' || !Number.isInteger(exp)) return undefined;
  // Any non-empty nonce verifies, as on the CFML side: the bridge README's test vector carries a UUID nonce.
  if (typeof nonce !== 'string' || nonce === '') return undefined;
  return { aud, op, sid, sub, siteId, exp, nonce };
}

function macHex(p: string, key: string): string {
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(p, 'utf8').digest('hex');
}

function macMatches(p: string, sig: string, key: string): boolean {
  const expected = Buffer.from(macHex(p, key), 'utf8');
  const given = Buffer.from(sig, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function epochSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function reject(reason: BridgeAssertionRejection): BridgeAssertionResult {
  return { ok: false, reason };
}
