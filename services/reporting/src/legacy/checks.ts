// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting fixture checks of legacy-fixtures/cfml api.cfm, lib/auth.cfc and modules/reporting.cfc that the platform hooks leave to handlers. */
import { AuthDenial, assertSiteMatches } from '@opt2/platform/auth';
import type { FastifyRequest } from '@opt2/platform/service-kit';
import { siteForTenant, tenantForRegisteredSite, withTenant } from '@opt2/platform/tenancy';
import type { ReportingDeps } from '../domain/deps.js';
import type { CreateExportInput, ExportOutput, ReadyExportOutput } from '../domain/jobs.js';
import type { ExportJobRow } from '../repo/tables.js';
import { FixtureApiError, notReadyError } from './envelope.js';

/** One check a fixture request passes before its handler answers. */
export type FixtureCheckStep = 'path' | 'site' | 'login' | 'role' | 'csrf' | 'existence' | 'validation' | 'state';

/**
 * The reporting fixture's check order: api.cfm path and site, then reporting.cfc with auth.cfc, a create's definition before
 * its fields. Login and role run in the platform `onRequest` hook (`config.opt2.requires`) and csrf in the route's
 * `csrfPreHandler`, so those three answer before site.
 */
export const FIXTURE_CHECK_ORDER: readonly FixtureCheckStep[] = Object.freeze([
  'path',
  'site',
  'login',
  'role',
  'csrf',
  'existence',
  'validation',
  'state',
]);

/** A check the route handler runs; login, role and csrf belong to the platform hooks. */
export type FixtureHandlerStep = Exclude<FixtureCheckStep, 'login' | 'role' | 'csrf'>;

const PLATFORM_STEPS: ReadonlySet<FixtureCheckStep> = new Set<FixtureCheckStep>(['login', 'role', 'csrf']);

const HANDLER_STEPS: readonly FixtureHandlerStep[] = FIXTURE_CHECK_ORDER.filter(
  (step): step is FixtureHandlerStep => !PLATFORM_STEPS.has(step),
);

/** Merged request params as `fixtureParams` returns them, keyed ignoring case. */
type FixtureParams = Readonly<Record<string, unknown>>;

/** A fixture request's site: its registered legacy id and the verified token's tenant. */
export type FixtureSite = { siteId: string; tenantId: string };

/** The create fields `createExportJob` receives, read from the request as reporting.cfc reads them. */
export type CreateExportFields = Pick<CreateExportInput, 'definitionId' | 'format' | 'params'>;

const DEFAULT_SITE_ID = 'default';

/** The param `name` (lower-case) ignoring case, as a CFML struct key resolves; the last spelling wins, as a later merge source does. */
function param(params: FixtureParams, name: string): unknown {
  const key = Object.keys(params).findLast((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : params[key];
}

/** reporting.cfc `textParam`: a simple value as text, '' when absent or complex; merged params hold simple values as strings. */
function textParam(params: FixtureParams, name: string): string {
  const value = param(params, name);
  return typeof value === 'string' ? value : '';
}

/** The registered id of `siteId`, matched ignoring case, read in a transaction of the verified tenant; null when unregistered. */
function registeredSite(deps: Pick<ReportingDeps, 'db'>, tenantId: string, siteId: string): Promise<string | null> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const tenant = await tenantForRegisteredSite(tx, siteId);
    return tenant === null ? null : siteForTenant(tx, tenant);
  });
}

/**
 * The request's site as auth.cfc resolveSite picks it: `siteid`, else the token's site, else `default`, as its registered id.
 * Throws invalidParameters for an unknown or complex site, then a 403 `AuthDenial` when it is not the token's site; the
 * tenant is always the verified token's `tid`.
 */
export async function resolveFixtureSite(
  params: FixtureParams,
  request: Pick<FastifyRequest, 'opt2Auth'>,
  deps: Pick<ReportingDeps, 'db'>,
): Promise<FixtureSite> {
  const claims = request.opt2Auth.user;
  if (claims === undefined) throw AuthDenial.unauthenticated('missing-credential');
  const supplied = param(params, 'siteid') ?? '';
  // The token's site stands for the session site. resolveSite raises for an unknown site instead of falling back to
  // `default` as contentServer.cfc does for the JSON API, so fallbackSiteId does not apply.
  const requested = supplied === '' ? claims.site || DEFAULT_SITE_ID : supplied;
  const siteId = typeof requested === 'string' ? await registeredSite(deps, claims.tid, requested) : null;
  if (siteId === null) throw new FixtureApiError('invalidParameters');
  assertSiteMatches(siteId, claims);
  return { siteId, tenantId: claims.tid };
}

/**
 * The definition, format and `asOf` of a create request as reporting.cfc reads them, unchecked: `createExportJob` checks the
 * definition and then the fields in reporting.cfc's order, so checking a field here would answer before the definition does.
 */
export function createExportFields(params: FixtureParams): CreateExportFields {
  return {
    definitionId: textParam(params, 'definitionid'),
    format: textParam(params, 'format'),
    params: { asOf: param(params, 'asof') },
  };
}

/** The existence check of a job read: the tenant's job, or notFound, as reporting.cfc raises for a job outside the site. */
export function requireExportJob(job: ExportJobRow | null): ExportJobRow {
  if (job === null) throw new FixtureApiError('notFound');
  return job;
}

/** The existence and state checks of a download: the ready output, notFound without the job, the not-ready conflict before `done`. */
export function requireReadyOutput(output: ExportOutput): ReadyExportOutput {
  if (output.outcome === 'not-found') throw new FixtureApiError('notFound');
  if (output.outcome === 'not-ready') throw notReadyError();
  return output;
}

/** The results of the handler steps, keyed by step; a step that was not given is undefined. */
export type FixtureCheckResults<P, S, E, V, T> = { path: P; site: S; existence: E; validation: V; state: T };

// Each parameter type names only the earlier steps' results, so TypeScript infers every result type in step order.
/** Handler steps of one fixture request; each receives the results of the steps before it and fails by throwing. */
export interface FixtureCheckSteps<P, S, E, V, T> {
  path?: () => P | Promise<P>;
  site?: (done: { path: P }) => S | Promise<S>;
  existence?: (done: { path: P; site: S }) => E | Promise<E>;
  validation?: (done: { path: P; site: S; existence: E }) => V | Promise<V>;
  state?: (done: { path: P; site: S; existence: E; validation: V }) => T | Promise<T>;
}

/**
 * Runs the given handler steps in FIXTURE_CHECK_ORDER, skipping the platform's, and resolves to their results; the first
 * failure, a `FixtureApiError`, `ReportingDomainError` or `AuthDenial`, propagates unchanged for `toFixtureError`.
 */
export async function runFixtureChecks<P = undefined, S = undefined, E = undefined, V = undefined, T = undefined>(
  steps: FixtureCheckSteps<P, S, E, V, T>,
): Promise<FixtureCheckResults<P, S, E, V, T>> {
  const done: Partial<Record<FixtureHandlerStep, unknown>> = {};
  for (const step of HANDLER_STEPS) {
    const run = steps[step] as ((prior: Partial<Record<FixtureHandlerStep, unknown>>) => unknown) | undefined;
    done[step] = run === undefined ? undefined : await run({ ...done });
  }
  return done as FixtureCheckResults<P, S, E, V, T>;
}
