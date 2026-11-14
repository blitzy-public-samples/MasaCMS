// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature fixture responses, shaped as legacy-fixtures/cfml/api.cfm and lib/envelope.cfc answer `/legacy-fixtures/cfml/api.cfm/esignature/**`. */
import { AuthDenial } from '@opt2/platform/auth';
import {
  LEGACY_ERROR_MAP,
  LegacyApiError,
  LegacyServiceUnavailableError,
  buildEnvelope,
  createApiSerializer,
  paramsWithoutMethod,
  serializeResponse,
  type ApiKeyHint,
  type LegacyApiErrorType,
  type LegacyEnvelope,
  type LegacyErrorSpec,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { isUnstorableTextError, legacyParamsOf, type FastifyRequest } from '@opt2/platform/service-kit';
import { EsignatureDomainError } from '../domain/signing.js';
import { PeopleReadDeniedError } from './people-client.js';

/** Module segment of every e-signature fixture route and the first part of its envelope `method`. */
export const FIXTURE_MODULE = 'esignature' as const;

/** Error types of the fixture error map: Masa's JSON API types plus the fixture-only ones. */
export type FixtureErrorType = LegacyApiErrorType | 'forbidden' | 'notFound' | 'conflict';

/** envelope.cfc `errorMap`: Masa's JSON API rows plus the fixture-only rows. */
export const FIXTURE_ERROR_MAP: Readonly<Record<FixtureErrorType, LegacyErrorSpec>> = Object.freeze({
  ...LEGACY_ERROR_MAP,
  forbidden: Object.freeze({ status: 403, code: 'invalid_request', message: 'Insufficient Account Permissions' }),
  notFound: Object.freeze({ status: 404, code: 'invalid_request', message: 'Not Found' }),
  conflict: Object.freeze({ status: 409, code: 'invalid_request', message: 'Conflict' }),
});

/** Key hints envelope.cfc registers after Masa's JSON API chain, in its call order. */
export const FIXTURE_HINTS: readonly Readonly<ApiKeyHint>[] = Object.freeze([
  { key: 'version', hint: 'integer' },
  { key: 'seq', hint: 'integer' },
  { key: 'record_count', hint: 'integer' },
  { key: 'day_count', hint: 'integer' },
  { key: 'blackout_count', hint: 'integer' },
  { key: 'approved_count', hint: 'integer' },
  { key: 'size_bytes', hint: 'integer' },
  { key: 'offset_minutes', hint: 'integer' },
  { key: 'offsetminutes', hint: 'integer' },
  { key: 'schedule_version', hint: 'integer' },
  { key: 'inserted', hint: 'integer' },
  { key: 'total', hint: 'integer' },
  { key: 'blackouts', hint: 'integer' },
  { key: 'program_id', hint: 'integer' },
  { key: 'entries', hint: 'integer' },
  { key: 'brokenat', hint: 'integer' },
  { key: 'overdue', hint: 'boolean' },
  { key: 'valid', hint: 'boolean' },
  { key: 'isblackout', hint: 'boolean' },
] as const);

const SERIALIZER = createApiSerializer(FIXTURE_HINTS);

/** The message `fail` writes: a non-empty raised message, else the type's default. */
function errorMessage(spec: LegacyErrorSpec, message: string | undefined): string {
  return message !== undefined && message !== '' ? message : spec.message;
}

/** envelope.cfc `raise(type, message)`; an empty `message` answers with the type's default message. */
export class FixtureApiError extends Error {
  override readonly name: string = 'FixtureApiError';

  constructor(
    readonly type: FixtureErrorType,
    message = '',
  ) {
    super(errorMessage(FIXTURE_ERROR_MAP[type], message));
  }
}

/** Envelope `method` and merged request params of one fixture request. */
export interface FixtureContext {
  method: string;
  params: Record<string, unknown>;
}

/** Status, headers (Content-Type and ETag) and exact body of a fixture response, for `sendLegacyResponse`. */
export type FixtureResponse = SerializedLegacyResponse;

/** One page of a list: the count of all rows and the validated page parameters. */
export interface FixturePaging {
  total: number;
  pageIndex: number;
  itemsPerPage: number;
}

/** Envelope `method` as api.cfm builds it, `esignature.<resource>[.<action>]` lower-cased; the request id never appears in it. */
export function fixtureMethod(resource: string, action?: string): string {
  const parts: string[] = [FIXTURE_MODULE, resource];
  if (action !== undefined && action !== '') parts.push(action);
  return parts.join('.').toLowerCase();
}

/** Request params merged as api.cfm merges url, form and a JSON object body: later sources win, keys ignoring case. */
export function fixtureParams(request: FastifyRequest): Record<string, unknown> {
  return legacyParamsOf(request);
}

/** Envelope `method` and merged params of an e-signature fixture request. */
export function fixtureContext(request: FastifyRequest, resource: string, action?: string): FixtureContext {
  return { method: fixtureMethod(resource, action), params: fixtureParams(request) };
}

/** The param under `name` ignoring case, as CFML struct keys resolve. */
function paramNoCase(params: Record<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

/** envelope.cfc `respond`: status, JSON content type, params suppression, `useDataNamespace` flattening and ETag. */
function respond(envelope: LegacyEnvelope, status: number, params: Record<string, unknown>): FixtureResponse {
  return serializeResponse(envelope, {
    statusCode: status,
    useDataNamespace: paramNoCase(params, 'useDataNamespace'),
    serializer: SERIALIZER,
  });
}

/** The fixture error-map type for `type`; a type the map lacks answers as `server_error`, as envelope.cfc `fail` does. */
function mappedType(type: string): FixtureErrorType {
  return Object.hasOwn(FIXTURE_ERROR_MAP, type) ? (type as FixtureErrorType) : 'server_error';
}

/** Success envelope of envelope.cfc `success`, which answers every fixture success, a create included, with 200. */
export function fixtureSuccess(ctx: FixtureContext, data: unknown = {}, status = 200): FixtureResponse {
  return respond(buildEnvelope({ method: ctx.method, params: paramsWithoutMethod(ctx.params), data }), status, ctx.params);
}

/** One page in Masa's paged-list shape, as envelope.cfc `listResponse` builds its `data`. */
export interface FixturePage<T> {
  items: T[];
  startindex: number;
  endindex: number;
  itemsperpage: number;
  totalitems: number;
  totalpages: number;
  pageindex: number;
}

/** The paged-list `data` of a `queryPage` result: `items` already holds only the page of `paging.total` rows. */
export function fixturePage<T>(items: readonly T[], paging: FixturePaging): FixturePage<T> {
  const { total, pageIndex, itemsPerPage } = paging;
  const startIndex = (pageIndex - 1) * itemsPerPage + 1;
  return {
    items: startIndex > total ? [] : [...items],
    startindex: startIndex,
    endindex: Math.min(startIndex + itemsPerPage - 1, total),
    itemsperpage: itemsPerPage,
    totalitems: total,
    totalpages: Math.ceil(total / itemsPerPage),
    pageindex: pageIndex,
  };
}

/** envelope.cfc `listResponse` of a `queryPage` result: `items` already holds only the page of `paging.total` rows. */
export function fixtureList(ctx: FixtureContext, items: readonly unknown[], paging: FixturePaging): FixtureResponse {
  return fixtureSuccess(ctx, fixturePage(items, paging));
}

/** Error envelope of envelope.cfc `fail` at the type's status; a non-empty `message` replaces the type's default. */
export function fixtureError(type: FixtureErrorType, ctx: FixtureContext, message?: string): FixtureResponse {
  const spec = FIXTURE_ERROR_MAP[type];
  // fail() reports the route's method as is (no jsonApiUtility `invalid` rule) and orders the error struct code, then message.
  const envelope = buildEnvelope({
    method: ctx.method,
    params: paramsWithoutMethod(ctx.params),
    error: { code: spec.code, message: errorMessage(spec, message) },
  });
  return respond(envelope, spec.status, ctx.params);
}

/**
 * Fixture error response for a thrown value, as api.cfm answers it; anything unrecognised is a 500 `server_error` without detail,
 * which the caller logs. Rethrows `LegacyServiceUnavailableError` for service-kit's legacy 503.
 */
export function toFixtureError(err: unknown, ctx: FixtureContext): FixtureResponse {
  if (err instanceof LegacyServiceUnavailableError) throw err;
  // SQL Server stores a NUL the fixture accepts; PostgreSQL refuses it, answered as every target service answers it.
  if (isUnstorableTextError(err)) return fixtureError('invalidParameters', ctx);
  if (err instanceof FixtureApiError || err instanceof EsignatureDomainError) return fixtureError(err.type, ctx, err.message);
  if (err instanceof AuthDenial) {
    // auth.cfc refuses a role with forbidden; the fixture never sends WWW-Authenticate, so a bearer challenge is not kept.
    return fixtureError(err.statusCode === 403 ? 'forbidden' : err.type, ctx);
  }
  if (err instanceof LegacyApiError) return fixtureError(mappedType(err.type), ctx);
  // People refused the signer read for this caller; the fixture's own refusals answer forbidden.
  if (err instanceof PeopleReadDeniedError) return fixtureError('forbidden', ctx);
  return fixtureError('server_error', ctx);
}

/** The fixed reason of `toFixtureError`'s answer to `err`, for its WARNING line: a refused value's SQLSTATE, a denial's reason, else the type. */
export function fixtureOutcomeReason(err: unknown): string {
  if (isUnstorableTextError(err)) return err.code;
  if (err instanceof AuthDenial) return err.reason;
  if (err instanceof FixtureApiError || err instanceof EsignatureDomainError || err instanceof LegacyApiError) return err.type;
  if (err instanceof PeopleReadDeniedError) return 'forbidden';
  return 'server_error';
}
