// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature fixture checks of legacy-fixtures/cfml api.cfm, lib/auth.cfc and modules/esignature.cfc that the platform auth hooks leave to handlers. */
import { Buffer } from 'node:buffer';
import { AuthDenial, type UserClaims } from '@opt2/platform/auth';
import { cfNumberString } from '@opt2/platform/legacy-compat';
import { siteForTenant, tenantForRegisteredSite, type RegistrySource } from '@opt2/platform/tenancy';
import { FIXTURE_ERROR_MAP, FixtureApiError, type FixtureErrorType } from './envelope.js';
import type { CreateRequestInput, SignInput, SuppliedAuditEntry } from '../domain/signing.js';

/** One check a fixture request passes before its handler answers. */
export type FixtureCheckStep = 'path' | 'site' | 'login' | 'role' | 'existence' | 'validation' | 'state';

/**
 * Order in which the e-signature fixture checks a request: api.cfm path and site, then esignature.cfc with auth.cfc the rest.
 * The platform auth hooks decide login and role before any handler runs; `fixtureDenialOverride` answers the site error first.
 */
export const FIXTURE_CHECK_ORDER: readonly FixtureCheckStep[] = Object.freeze([
  'path',
  'site',
  'login',
  'role',
  'existence',
  'validation',
  'state',
]);

/** A validated value, or the fixture error its input answers. */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; type: FixtureErrorType; message: string };

/** Request params as esignature.cfc reads them, keyed ignoring case. */
type FixtureParams = Readonly<Record<string, unknown>>;

/** A fixture request's site: its registered legacy id and the verified token's tenant. */
export interface FixtureSite {
  siteId: string;
  tenantId: string;
}

/** A platform auth denial's context: the verified claims, when a user token was presented, and the e-signature tenant registry. */
export interface FixtureDenialContext {
  claims?: UserClaims;
  registry: RegistrySource;
}

/** One handler check; it fails by throwing or by returning a failed `ValidationResult`. */
export interface FixtureCheck<V = unknown> {
  readonly step: FixtureCheckStep;
  readonly check: () => void | ValidationResult<V> | Promise<void | ValidationResult<V>>;
}

/** The value a passed check yields: its `ValidationResult` value, undefined for a check returning nothing. */
export type FixtureCheckValue<C> = C extends { check: () => infer R } ? ValidatedValue<Awaited<R>> : never;

type ValidatedValue<R> = [Extract<R, { ok: true }>] extends [never]
  ? undefined
  : Extract<R, { ok: true }> extends { value: infer V }
    ? V
    : undefined;

// esignature.cfc raises invalidParameters without a message for every rejected input, so it answers the type's default.
const INVALID_PARAMETERS: Extract<ValidationResult<never>, { ok: false }> = Object.freeze({
  ok: false,
  type: 'invalidParameters',
  message: FIXTURE_ERROR_MAP.invalidParameters.message,
});

const DEFAULT_SITE_ID = 'default';
const DOCUMENT_NAME_MAX_LENGTH = 255;
// The keys suppliedEntries copies from each supplied entry.
const CHAIN_KEYS = ['seq', 'action', 'actor_user_id', 'detail', 'at', 'prev_hash', 'entry_hash'] as const satisfies readonly (keyof SuppliedAuditEntry)[];
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const UNICODE_SEPARATOR = /^[\p{Zs}\p{Zl}\p{Zp}]$/u;
const NO_BREAK_SPACES: ReadonlySet<number> = new Set([0x00a0, 0x2007, 0x202f]);

/** The param `name` ignoring case, as a CFML struct key resolves; the last spelling wins, as a later merge source does. */
function param(params: FixtureParams, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).findLast((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

/** A simple value as CFML toString() renders it; undefined for a missing, null or complex one. */
function simpleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  return undefined;
}

/** esignature.cfc textParam: a simple-valued param as text, '' when it is absent, null or complex. */
function textParam(params: FixtureParams, name: string): string {
  return simpleText(param(params, name)) ?? '';
}

/** Java Character.isWhitespace: \t-\r, \u001C-\u001F and the space, line and paragraph separators other than the no-break spaces. */
function isJavaWhitespace(char: string): boolean {
  const code = char.charCodeAt(0);
  if (code <= 0x20) return (code >= 0x09 && code <= 0x0d) || code >= 0x1c;
  return code >= 0x80 && !NO_BREAK_SPACES.has(code) && UNICODE_SEPARATOR.test(char);
}

/**
 * CFML binaryDecode(text, 'base64') as coldfusion.wddx.Base64Encoder decodes: '=' and whitespace are skipped and pending bits dropped;
 * null for any other non-alphabet character, or when the text ends on a data character that does not complete a byte.
 */
function cfBase64Decode(text: string): Buffer | null {
  const out = Buffer.alloc(Math.ceil((text.length * 3) / 4));
  let length = 0;
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char === '=' || isJavaWhitespace(char)) continue;
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (i === text.length - 1 && bits !== 8) return null;
    if (bits >= 8) {
      bits -= 8;
      out[length] = (accumulator >> bits) & 0xff;
      length += 1;
    }
  }
  return out.subarray(0, length);
}

/** The request's site as auth.cfc resolveSite picks it: `siteid`, else the token's site, else `default`; throws invalidParameters for an unknown site. */
export async function resolveFixtureSite(params: FixtureParams, claims: UserClaims, registry: RegistrySource): Promise<FixtureSite> {
  const supplied = param(params, 'siteid') ?? '';
  // The token's site stands for the session site; resolveSite raises for an unknown site instead of falling back, so fallbackSiteId does not apply.
  const requested = supplied === '' ? claims.site || DEFAULT_SITE_ID : supplied;
  const tenantId = typeof requested === 'string' ? await tenantForRegisteredSite(registry, requested) : null;
  if (tenantId === null) throw new FixtureApiError('invalidParameters');
  // The tenant is only ever the verified token's, so a registered site of another tenant is not this token's site.
  if (tenantId.toLowerCase() !== claims.tid.toLowerCase()) throw AuthDenial.siteMismatch();
  const siteId = await siteForTenant(registry, tenantId);
  if (siteId === null) throw new FixtureApiError('invalidParameters');
  return { siteId, tenantId: claims.tid };
}

/**
 * The fixture's answer to a platform role denial: invalidParameters when the token's site is unregistered, as resolveSite raises before
 * requireAny; authorization for a token without a logged-in user, as requireLogin raises; else `denial`.
 */
export async function fixtureDenialOverride(denial: AuthDenial, ctx: FixtureDenialContext): Promise<AuthDenial | FixtureApiError> {
  if (denial.reason !== 'forbidden' || ctx.claims === undefined) return denial;
  if ((await tenantForRegisteredSite(ctx.registry, ctx.claims.site || DEFAULT_SITE_ID)) === null) {
    return new FixtureApiError('invalidParameters');
  }
  // Identity mints sub '' for a session without a login; the fixture answers that session 401, not 403.
  return ctx.claims.sub === '' ? new FixtureApiError('authorization') : denial;
}

/** esignature.cfc createRequest's fields: documentName (1-255 characters), the decoded non-empty documentBase64, and a non-empty signerUserId. */
export function validateCreateInput(params: FixtureParams): ValidationResult<CreateRequestInput> {
  const documentName = textParam(params, 'documentName');
  if (documentName === '' || documentName.length > DOCUMENT_NAME_MAX_LENGTH) return INVALID_PARAMETERS;
  const document = cfBase64Decode(textParam(params, 'documentBase64'));
  if (document === null || document.length === 0) return INVALID_PARAMETERS;
  const signerUserId = textParam(params, 'signerUserId');
  if (signerUserId === '') return INVALID_PARAMETERS;
  return { ok: true, value: { documentName, document, signerUserId } };
}

/**
 * The sign input: the path id and typedName as sent. esignature.cfc rejects a blank or over-long name only after notFound and its
 * signer check, so `signRequest` applies that rule; nothing here fails.
 */
export function validateSignInput(id: string, params: FixtureParams): ValidationResult<SignInput> {
  return { ok: true, value: { requestId: id, typedName: textParam(params, 'typedName') } };
}

/** `entries` as esignature.cfc suppliedEntries reads it: the value itself, or the value of JSON text (undefined when the text is not JSON). */
function entriesParam(params: FixtureParams): unknown {
  const entries = param(params, 'entries');
  if (typeof entries !== 'string') return entries;
  try {
    return JSON.parse(entries) as unknown;
  } catch {
    return undefined;
  }
}

/** A supplied entry's chain keys as text, or null when it is not a struct or a key is missing, null or complex. */
function suppliedEntry(entry: unknown): SuppliedAuditEntry | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const copied: Partial<SuppliedAuditEntry> = {};
  for (const key of CHAIN_KEYS) {
    const text = simpleText(param(entry as FixtureParams, key));
    if (text === undefined) return null;
    copied[key] = text;
  }
  return copied as SuppliedAuditEntry;
}

/**
 * The supplied chain copy (`entries`, an array or its JSON text) in array order, each entry's chain keys as text, as esignature.cfc
 * suppliedEntries reads them; `verifySupplied` then rejects a seq, at or hash in another form.
 */
export function validateSuppliedChain(params: FixtureParams): ValidationResult<SuppliedAuditEntry[]> {
  const entries = entriesParam(params);
  if (!Array.isArray(entries)) return INVALID_PARAMETERS;
  const copies: SuppliedAuditEntry[] = [];
  for (const entry of entries as unknown[]) {
    const copy = suppliedEntry(entry);
    if (copy === null) return INVALID_PARAMETERS;
    copies.push(copy);
  }
  return { ok: true, value: copies };
}

/**
 * Runs `checks` one at a time in FIXTURE_CHECK_ORDER, keeping their given order within a step, and resolves to their values in the
 * order given. A failed `ValidationResult` throws its FixtureApiError; a thrown error propagates; no later check runs.
 */
export async function runFixtureChecks<const C extends readonly FixtureCheck[]>(
  checks: C,
): Promise<{ -readonly [K in keyof C]: FixtureCheckValue<C[K]> }> {
  const values: unknown[] = new Array<unknown>(checks.length);
  const ordered = checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => FIXTURE_CHECK_ORDER.indexOf(a.check.step) - FIXTURE_CHECK_ORDER.indexOf(b.check.step));
  for (const { check, index } of ordered) {
    const outcome = (await check.check()) as ValidationResult<unknown> | undefined;
    if (outcome !== undefined && !outcome.ok) throw new FixtureApiError(outcome.type, outcome.message);
    values[index] = outcome?.value;
  }
  return values as { -readonly [K in keyof C]: FixtureCheckValue<C[K]> };
}
