// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting fixture responses, shaped as legacy-fixtures/cfml/api.cfm and lib/envelope.cfc answer `/legacy-fixtures/cfml/api.cfm/reporting/**`. */
import type { Readable } from 'node:stream';
import { AuthDenial } from '@opt2/platform/auth';
import {
  LEGACY_ERROR_MAP,
  LegacyApiError,
  LegacyServiceUnavailableError,
  buildEnvelope,
  createApiSerializer,
  isCfUuid,
  paramsWithoutMethod,
  serializeResponse,
  type ApiKeyHint,
  type LegacyApiErrorType,
  type LegacyEnvelope,
  type LegacyErrorSpec,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { isUnstorableTextError, legacyParamsOf, type FastifyRequest } from '@opt2/platform/service-kit';
import { ReportingDomainError } from '../domain/jobs.js';

/** Module segment of every reporting fixture route and the first part of its envelope `method`. */
export const FIXTURE_MODULE = 'reporting';

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

/** reporting.cfc's answer to a download before `done`: `raise("conflict", "not-ready")`, a conflict whose message is `not-ready`. */
export const NOT_READY = Object.freeze({ type: 'conflict', message: 'not-ready' } as const);

// POSIX [[:cntrl:]] as ACF's reFind matches it: ASCII C0 and DEL only, not U+0080-U+009F.
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
// Per code point, as Java's String.replaceAll("[^\x00-\x7F]", "_") replaces.
const NON_ASCII = /[^\u0000-\u007F]/gu;
const QUOTED_STRING_SPECIAL = /["\\]/g;
// RFC 5987 attr-char: the bytes sendFile writes as themselves in `filename*`.
const ATTR_CHAR = /^[A-Za-z0-9!#$&+.^_`|~-]$/;

/** The fixture error-map type for `type`; a type the map lacks answers as `server_error`, as envelope.cfc `fail` does. */
function mappedType(type: string): FixtureErrorType {
  return Object.hasOwn(FIXTURE_ERROR_MAP, type) ? (type as FixtureErrorType) : 'server_error';
}

/** The message `fail` writes: a non-empty raised message, else the type's default. */
function errorMessage(spec: LegacyErrorSpec, detail: string | undefined): string {
  return detail !== undefined && detail !== '' ? detail : spec.message;
}

/**
 * envelope.cfc `raise(type, message)`; a non-empty `detail` replaces the type's default message. A `LegacyApiError`, not a bare
 * `Error`, so one escaping the fixture error handler still renders through service-kit.
 */
export class FixtureApiError extends LegacyApiError {
  override readonly name: string = 'FixtureApiError';
  declare readonly type: FixtureErrorType;
  readonly detail: string | undefined;

  constructor(type: FixtureErrorType, detail?: string) {
    super(type);
    this.detail = detail;
    this.message = `${type}: ${errorMessage(FIXTURE_ERROR_MAP[type], detail)}`;
  }
}

/** A new `FixtureApiError` of `NOT_READY`, for a download of a job that is not `done`. */
export function notReadyError(): FixtureApiError {
  return new FixtureApiError(NOT_READY.type, NOT_READY.message);
}

/** Envelope `method` and merged params of one fixture request. */
export type FixtureContext = { method: string; params: Record<string, unknown> };

/** Status, headers and body of a fixture response; JSON envelopes carry their exact serialized body. */
export type FixtureResponse = { status: number; headers: Record<string, string>; body: string | Buffer | Readable };

/** One page of a list: the count of all rows and the validated page parameters, as `JobPage` carries them. */
export type FixturePaging = { total: number; pageIndex: number; itemsPerPage: number };

/** What a file response describes: the stored name and content type, and the byte length sent when known. */
export type FixtureFileMeta = { fileName: string; contentType: string; size?: number };

/** Envelope `method` as api.cfm builds it, `reporting.<resource>[.<action>][.<tail>]` lower-cased; the id segment and a CF UUID tail are not method parts. */
export function fixtureMethod(resource: string, action?: string, tail?: string): string {
  const parts = [FIXTURE_MODULE, resource];
  if (action !== undefined && action !== '') parts.push(action);
  if (tail !== undefined && tail !== '' && !isCfUuid(tail)) parts.push(tail);
  return parts.join('.').toLowerCase();
}

/** Request params merged as api.cfm merges url, form and a JSON object body: later sources win, keys ignoring case. */
export function fixtureParams(request: FastifyRequest): Record<string, unknown> {
  // The platform's one merge; unlike ACF deserializeJSON it hands JSON numbers and booleans over as strings,
  // so a check that depends on a JSON value's type reads the raw body.
  return legacyParamsOf(request);
}

/** Envelope `method` and merged params of a reporting fixture request. */
export function fixtureContext(request: FastifyRequest, resource: string, action?: string, tail?: string): FixtureContext {
  return { method: fixtureMethod(resource, action, tail), params: fixtureParams(request) };
}

/** The param under `name` ignoring case, as CFML struct keys resolve. */
function paramNoCase(params: Record<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

/** envelope.cfc `respond`: status, JSON content type, params suppression, `useDataNamespace` flattening and ETag. */
function respond(envelope: LegacyEnvelope, status: number, params: Record<string, unknown>): SerializedLegacyResponse {
  return serializeResponse(envelope, {
    statusCode: status,
    useDataNamespace: paramNoCase(params, 'useDataNamespace'),
    serializer: SERIALIZER,
  });
}

/** Success envelope of envelope.cfc `success`, which answers every fixture success, a create included, with 200. */
export function fixtureSuccess(ctx: FixtureContext, data: unknown = {}, status = 200): SerializedLegacyResponse {
  return respond(buildEnvelope({ method: ctx.method, params: paramsWithoutMethod(ctx.params), data }), status, ctx.params);
}

/** envelope.cfc `listResponse` of a `queryPage` result: `items` already holds only the page of `paging.total` rows. */
export function fixtureList(ctx: FixtureContext, items: readonly unknown[], paging: FixturePaging): SerializedLegacyResponse {
  const { total, pageIndex, itemsPerPage } = paging;
  const startIndex = (pageIndex - 1) * itemsPerPage + 1;
  return fixtureSuccess(ctx, {
    items: startIndex > total ? [] : [...items],
    startindex: startIndex,
    endindex: Math.min(startIndex + itemsPerPage - 1, total),
    itemsperpage: itemsPerPage,
    totalitems: total,
    totalpages: Math.ceil(total / itemsPerPage),
    pageindex: pageIndex,
  });
}

/** Error envelope of envelope.cfc `fail` at the type's status; a non-empty `detail` replaces the type's default message. */
export function fixtureError(type: FixtureErrorType, ctx: FixtureContext, detail?: string): SerializedLegacyResponse {
  const spec = FIXTURE_ERROR_MAP[type];
  const envelope = buildEnvelope({
    method: ctx.method,
    params: paramsWithoutMethod(ctx.params),
    // envelope.cfc builds an ordered struct, so code precedes message, unlike the JSON API's {message, code}.
    error: { code: spec.code, message: errorMessage(spec, detail) },
  });
  return respond(envelope, spec.status, ctx.params);
}

/** `filename*` value of `fileName`: its UTF-8 bytes, each outside attr-char as uppercase `%XX`. */
function extValue(fileName: string): string {
  let encoded = '';
  for (const byte of Buffer.from(fileName, 'utf8')) {
    const char = String.fromCharCode(byte);
    encoded += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** Content-Disposition of envelope.cfc `sendFile`; throws `LegacyApiError('server_error')` when `fileName` holds a control character. */
function contentDisposition(fileName: string): string {
  if (CONTROL_CHAR.test(fileName)) throw new LegacyApiError('server_error');
  const fallback = fileName.replace(NON_ASCII, '_');
  const quoted = `attachment; filename="${fallback.replace(QUOTED_STRING_SPECIAL, '\\$&')}"`;
  return fallback === fileName ? quoted : `${quoted}; filename*=UTF-8''${extValue(fileName)}`;
}

/**
 * Status and headers of envelope.cfc `sendFile`, in the order it sets them, for output bytes the caller sends as the body;
 * no ETag. Throws `LegacyApiError('server_error')` when `meta.fileName` holds a control character.
 */
export function fixtureFile(meta: FixtureFileMeta): Omit<FixtureResponse, 'body'> {
  const headers: Record<string, string> = { 'Content-Disposition': contentDisposition(meta.fileName) };
  if (meta.size !== undefined) headers['Content-Length'] = String(meta.size);
  // Export content types are the fixture's three ASCII constants, so the type goes out as stored, with no byte remapping.
  headers['Content-Type'] = meta.contentType;
  return { status: 200, headers };
}

/**
 * Fixture error response for a thrown value, as api.cfm answers it; a value PostgreSQL cannot store is invalidParameters, and
 * anything but a fixture, domain or legacy API error is a 500 `server_error`, which the caller logs. Rethrows
 * `LegacyServiceUnavailableError` for service-kit's legacy 503.
 */
export function toFixtureError(err: unknown, ctx: FixtureContext): SerializedLegacyResponse {
  if (err instanceof LegacyServiceUnavailableError) throw err;
  if (isUnstorableTextError(err)) return fixtureError('invalidParameters', ctx);
  if (err instanceof ReportingDomainError) return fixtureError(err.type, ctx, err.message);
  if (err instanceof LegacyApiError) {
    // A 403 denial is the fixture's role refusal: auth.cfc requireAny raises forbidden, not authorization.
    const type = err instanceof AuthDenial && err.statusCode === 403 ? 'forbidden' : mappedType(err.type);
    const response = fixtureError(type, ctx, err instanceof FixtureApiError ? err.detail : undefined);
    // The bearer challenge of a token denial stays, as the platform's denial renderer sends it.
    if (err.wwwAuthenticate !== undefined) response.headers['WWW-Authenticate'] = err.wwwAuthenticate;
    return response;
  }
  return fixtureError('server_error', ctx);
}

/** The fixed reason of `toFixtureError`'s answer to `err`, for its WARNING line: a refused value's SQLSTATE, a denial's reason, else the type. */
export function fixtureOutcomeReason(err: unknown): string {
  if (isUnstorableTextError(err)) return err.code;
  if (err instanceof AuthDenial) return err.reason;
  if (err instanceof ReportingDomainError || err instanceof LegacyApiError) return err.type;
  return 'server_error';
}
