// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance fixture checks of legacy-fixtures/cfml api.cfm, lib/auth.cfc and modules/finance.cfc that the platform auth hooks leave to handlers. */
import type { AuthDenial, UserClaims } from '@opt2/platform/auth';
import { cfNumberString, javaTrim } from '@opt2/platform/legacy-compat';
import { TenantMismatchError, siteForTenant, tenantForRegisteredSite, type RegistrySource, type TenantTx } from '@opt2/platform/tenancy';
import { FIXTURE_ERROR_MAP, FixtureApiError } from './envelope.js';
import { findProgramBinding } from '../repo/queries.js';
import type { ProgramBindingRow } from '../repo/tables.js';
import { parseMoney } from '../domain/money.js';
import type { RecordEdit, RecordInput } from '../domain/records.js';
import { FINANCE_ACTIONS, type FinanceAction } from '../domain/lifecycle.transitions.js';

/** One check a fixture request passes before its handler answers. */
export type FixtureCheckStep = 'path' | 'site' | 'login' | 'role' | 'existence' | 'validation' | 'state';

/**
 * Order in which the finance fixture checks a request: api.cfm path and site, then finance.cfc with auth.cfc the rest.
 * A request without a user token, or whose siteid is not its token's site, answers login and role before site instead: the platform
 * decides them before any handler runs, and the gateway always sends a token minted for the requested site.
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

/** A check the route handler runs; login and role belong to the platform auth hooks. */
export type FixtureHandlerStep = Exclude<FixtureCheckStep, 'login' | 'role'>;

const HANDLER_STEPS: readonly FixtureHandlerStep[] = FIXTURE_CHECK_ORDER.filter(
  (step): step is FixtureHandlerStep => step !== 'login' && step !== 'role',
);

/** Request params as finance.cfc reads them, keyed ignoring case. */
type FixtureParams = Readonly<Record<string, unknown>>;

/** A fixture request's site: its registered legacy id and the verified token's tenant. */
export type FixtureSite = { siteId: string; tenantId: string };

/** The verified claims of a request and the finance tenant registry. */
export type FixtureSiteContext = { claims: UserClaims; registry: RegistrySource };

/** A platform auth denial's context: the verified claims, when a user token was presented, and the finance tenant registry. */
export type FixtureDenialContext = { claims?: UserClaims; registry: RegistrySource };

/** A record field finance.cfc validates, in its check order. */
export type RecordField = 'title' | 'amount' | 'period';

/** Validated record fields, or the first invalid field with the fixture error it answers. */
export type RecordValidation<V = RecordInput | RecordEdit> =
  | { ok: true; value: V }
  | { ok: false; type: 'invalidParameters'; message: string; field: RecordField };

const DEFAULT_SITE_ID = 'default';
const TITLE_MAX_LENGTH = 255;
const PERIOD_TEXT = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** The param `name` (lower-case) ignoring case, as a CFML struct key resolves; the last spelling wins, as a later merge source does. */
function param(params: FixtureParams, name: string): unknown {
  const key = Object.keys(params).findLast((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : params[key];
}

/** A param as finance.cfc reads a text field: a simple value as CFML toString() renders it, '' for a missing or complex one. */
function simpleText(value: unknown): string {
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  return typeof value === 'string' ? value : '';
}

/** The failure for `field`; finance.cfc raises invalidParameters without a message for every field, so it answers the type's default. */
function invalidField(field: RecordField): Extract<RecordValidation, { ok: false }> {
  return { ok: false, type: 'invalidParameters', message: FIXTURE_ERROR_MAP.invalidParameters.message, field };
}

/** The request's site as auth.cfc resolveSite picks it: `siteid`, else the token's site, else `default`; throws invalidParameters for an unknown site. */
export async function resolveFixtureSite(params: FixtureParams, ctx: FixtureSiteContext): Promise<FixtureSite> {
  const supplied = param(params, 'siteid') ?? '';
  // The token's site stands for the session site; resolveSite raises for an unknown site instead of falling back, so fallbackSiteId does not apply.
  const requested = supplied === '' ? ctx.claims.site || DEFAULT_SITE_ID : supplied;
  const registered = typeof requested === 'string' ? await tenantForRegisteredSite(ctx.registry, requested) : null;
  const siteId = registered === null ? null : await siteForTenant(ctx.registry, registered);
  if (siteId === null) throw new FixtureApiError('invalidParameters');
  return { siteId, tenantId: ctx.claims.tid };
}

/**
 * The fixture's answer to a platform role denial: invalidParameters when the token's site is unregistered, as resolveSite raises before
 * requireAny; authorization for an anonymous token, as requireLogin raises; else `denial`.
 */
export async function fixtureDenialOverride(denial: AuthDenial, ctx: FixtureDenialContext): Promise<AuthDenial | FixtureApiError> {
  if (denial.reason !== 'forbidden' || ctx.claims === undefined) return denial;
  if ((await tenantForRegisteredSite(ctx.registry, ctx.claims.site)) === null) return new FixtureApiError('invalidParameters');
  // Identity mints sub '' for a session without a login; the gateway forwards it, and the fixture answers that session 401, not 403.
  return ctx.claims.sub === '' ? new FixtureApiError('authorization') : denial;
}

/** The tenant's `Program_<id>` binding, read under `tx`'s tenant, the verified `tenantId`; throws invalidParameters when it has none, as auth.cfc programFor does. */
export async function requireProgram(tx: TenantTx, tenantId: string): Promise<ProgramBindingRow> {
  if (tx.tenantId !== tenantId) throw new TenantMismatchError(tenantId, tx.tenantId);
  const binding = await findProgramBinding(tx);
  if (binding === null) throw new FixtureApiError('invalidParameters');
  return binding;
}

/**
 * Validates title, amount and period as finance.cfc recordFields does, returning the first failure in its order; never throws.
 * `input` holds the params finance.cfc reads, JSON-body values in their JSON types; `edit` requires every field, as finance.cfc does.
 */
export function validateRecordInput(input: FixtureParams, mode: 'create'): RecordValidation<RecordInput>;
export function validateRecordInput(input: FixtureParams, mode: 'edit'): RecordValidation<RecordEdit>;
export function validateRecordInput(input: FixtureParams, mode: 'create' | 'edit'): RecordValidation;
export function validateRecordInput(input: FixtureParams): RecordValidation<RecordInput> {
  const title = simpleText(param(input, 'title'));
  if (javaTrim(title) === '' || title.length > TITLE_MAX_LENGTH) return invalidField('title');
  const amount = parseMoney(param(input, 'amount'));
  if (!amount.ok) return invalidField('amount');
  const period = simpleText(param(input, 'period'));
  if (!PERIOD_TEXT.test(period)) return invalidField('period');
  return { ok: true, value: { title, amount: amount.value, period } };
}

/** The validated record fields of `input`; throws invalidParameters for the first invalid one. */
export function requireRecordInput(input: FixtureParams, mode: 'create'): RecordInput;
export function requireRecordInput(input: FixtureParams, mode: 'edit'): RecordEdit;
export function requireRecordInput(input: FixtureParams, mode: 'create' | 'edit'): RecordInput | RecordEdit {
  const result = validateRecordInput(input, mode);
  if (!result.ok) throw new FixtureApiError(result.type, result.message);
  return result.value;
}

/** Whether `segment` names a finance lifecycle action. */
function isFinanceAction(segment: string): segment is FinanceAction {
  return (FINANCE_ACTIONS as readonly string[]).includes(segment);
}

/** The lifecycle action of an `:action` segment, lower-cased as api.cfm reads it; throws notFound for any other segment. */
export function requireFinanceAction(segment: string): FinanceAction {
  const action = segment.toLowerCase();
  if (!isFinanceAction(action)) throw new FixtureApiError('notFound');
  return action;
}

/** The results of the handler steps, keyed by step; a step that was not given is undefined. */
export type FixtureCheckResults<P, S, E, V, T> = { path: P; site: S; existence: E; validation: V; state: T };

// Each parameter type names only the earlier steps' results, so TypeScript infers every result type in step order.
/** Handler steps of one fixture request; each receives the results of the steps before it and fails by throwing. */
export interface FixtureCheckSteps<P, S, E, V, T> {
  path?: () => Promise<P>;
  site?: (done: { path: P }) => Promise<S>;
  existence?: (done: { path: P; site: S }) => Promise<E>;
  validation?: (done: { path: P; site: S; existence: E }) => Promise<V>;
  state?: (done: { path: P; site: S; existence: E; validation: V }) => Promise<T>;
}

/** Runs the handler steps in FIXTURE_CHECK_ORDER, skipping the platform's login and role, and resolves to their results; the first failure propagates for toFixtureError. */
export async function runFixtureChecks<P = undefined, S = undefined, E = undefined, V = undefined, T = undefined>(
  steps: FixtureCheckSteps<P, S, E, V, T>,
): Promise<FixtureCheckResults<P, S, E, V, T>> {
  const done: Partial<Record<FixtureHandlerStep, unknown>> = {};
  for (const step of HANDLER_STEPS) {
    const run = steps[step] as ((prior: Partial<Record<FixtureHandlerStep, unknown>>) => Promise<unknown>) | undefined;
    done[step] = run === undefined ? undefined : await run({ ...done });
  }
  return done as FixtureCheckResults<P, S, E, V, T>;
}
