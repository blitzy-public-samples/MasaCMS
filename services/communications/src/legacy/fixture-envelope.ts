// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import {
  buildEnvelope,
  createApiSerializer,
  LEGACY_ERROR_MAP,
  LegacyApiError,
  LegacyServiceUnavailableError,
  paramsWithoutMethod,
  serializeResponse,
  type ApiKeyHint,
  type LegacyApiErrorType,
  type LegacyEnvelope,
  type LegacyErrorSpec,
  type LegacyJsonSerializer,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import { legacyParamsOf, sendLegacyResponse, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';

/** Merged fixture request params: URL, then form, then a JSON body object. */
export type FixtureParams = Record<string, unknown>;

/** Envelope `method` and merged params of one fixture request. */
export interface FixtureContext {
  method: string;
  params: FixtureParams;
}

/** Body of a fixture route; it sends its own success response, and throws to answer a fixture error. */
export type FixtureRouteFn<R extends FastifyRequest = FastifyRequest> = (
  request: R,
  reply: FastifyReply,
  ctx: FixtureContext,
) => FastifyReply | Promise<FastifyReply>;

/** Error types only the fixtures raise. */
export type FixtureErrorType = 'forbidden' | 'notFound' | 'conflict';

/** Status and error body of one fixture-only error type. */
export interface FixtureErrorSpec {
  readonly status: 403 | 404 | 409;
  readonly code: string;
  readonly message: string;
}

/** The fixture-only rows of the fixture error map (legacy-fixtures/cfml/lib/envelope.cfc). */
export const FIXTURE_ERROR_MAP: Readonly<Record<FixtureErrorType, FixtureErrorSpec>> = Object.freeze({
  forbidden: Object.freeze({ status: 403, code: 'invalid_request', message: 'Insufficient Account Permissions' }),
  notFound: Object.freeze({ status: 404, code: 'invalid_request', message: 'Not Found' }),
  conflict: Object.freeze({ status: 409, code: 'invalid_request', message: 'Conflict' }),
});

/** The JSON API error types the fixture error map also holds, answered with their LEGACY_ERROR_MAP rows. */
export const FIXTURE_LEGACY_ERROR_TYPES: readonly LegacyApiErrorType[] = Object.freeze([
  'authorization',
  'invalidParameters',
  'invalidMethodCall',
  'badRequest',
  'server_error',
] as const);

/** The fixture error-map row of `type`; a type the map lacks answers as server_error, as envelope.cfc fail() does. */
function fixtureErrorRow(type: string): LegacyErrorSpec {
  if (Object.hasOwn(FIXTURE_ERROR_MAP, type)) return FIXTURE_ERROR_MAP[type as FixtureErrorType];
  const reused = FIXTURE_LEGACY_ERROR_TYPES.find((t) => t === type) ?? 'server_error';
  return LEGACY_ERROR_MAP[reused];
}

/** The error message envelope.cfc fail() writes: a non-empty override, else the type's default. */
function fixtureErrorMessage(row: LegacyErrorSpec, override: string | undefined): string {
  return override !== undefined && override !== '' ? override : row.message;
}

/**
 * A fixture error, as envelope.cfc `raise(type, message)` throws it; an empty or absent message keeps the type's default.
 * It extends LegacyApiError so that, should it escape `fixtureHandler`, service-kit still answers it as a legacy error.
 */
export class FixtureApiError extends LegacyApiError {
  override readonly name: string = 'FixtureApiError';
  declare readonly type: FixtureErrorType | LegacyApiErrorType;
  readonly messageOverride: string | undefined;

  constructor(type: FixtureErrorType | LegacyApiErrorType, message?: string) {
    super(type);
    this.messageOverride = message;
    this.message = `${type}: ${fixtureErrorMessage(fixtureErrorRow(type), message)}`;
  }
}

/** Key hints envelope.cfc adds after Masa's JSON API chain, in its call order. */
export const FIXTURE_SERIALIZER_HINTS: readonly Readonly<ApiKeyHint>[] = Object.freeze([
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

/** The fixture serializer: Masa's JSON API hints, then the fixture hints. */
export function fixtureSerializer(): LegacyJsonSerializer {
  return createApiSerializer(FIXTURE_SERIALIZER_HINTS);
}

const SERIALIZER = fixtureSerializer();

/** Envelope `method` of a communications fixture route as api.cfm names it; an `{id}` path segment is never part of it. */
export function fixtureMethod(resource: string, action?: string): string {
  return ['communications', resource, action]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('.')
    .toLowerCase();
}

/** Validated paging of a fixture list: `offset` counts the rows before the page. */
export interface FixturePage {
  pageIndex: number;
  itemsPerPage: number;
  offset: number;
}

/** A list() result, or a queryPage() result whose `list` already holds only its page of `totalItems`. */
export interface FixtureListResult {
  list: readonly unknown[];
  pageIndex: number;
  itemsPerPage: number;
  totalItems?: number;
}

/** The `data` member of a fixture list response, in envelope.cfc key order. */
export interface FixtureListData {
  items: unknown[];
  startindex: number;
  endindex: number;
  itemsperpage: number;
  totalitems: number;
  totalpages: number;
  pageindex: number;
}

const INT_MAX = 2147483647;

/** The param under `name` ignoring case, as CFML struct keys resolve; undefined when absent. */
function paramNoCase(params: FixtureParams, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(params).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : params[key];
}

const ASCII_INTEGER = /^[+-]?[0-9]+$/;
const ANY_SCRIPT_INTEGER = /^[+-]?\p{Nd}+$/u;
const DECIMAL_DIGIT = /\p{Nd}/u;

/** Value of a Unicode decimal digit; such digits are assigned in contiguous runs of ten, each starting at zero. */
function digitValue(codePoint: number): number {
  let start = codePoint;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return (codePoint - start) % 10;
}

/** ACF isValid('integer', s), which parses as Java Integer.parseInt: an optional sign, digits of any script, 32-bit range. */
function parseCfInteger(s: string): number | undefined {
  if (!ANY_SCRIPT_INTEGER.test(s)) return undefined;
  let magnitude = 0;
  for (const digit of s.replace(/^[+-]/, '')) magnitude = magnitude * 10 + digitValue(digit.codePointAt(0) ?? 0);
  const n = s.startsWith('-') ? -magnitude : magnitude;
  return n >= -INT_MAX - 1 && n <= INT_MAX ? n : undefined;
}

/** A paging param in [1, maxValue], its default when absent, null or empty; throws invalidParameters otherwise. */
function pageParam(params: FixtureParams, name: string, defaultValue: number, maxValue = INT_MAX): number {
  const value = paramNoCase(params, name);
  if (value === undefined || value === null || value === '') return defaultValue;
  const text = typeof value === 'number' ? String(value) : value;
  const n = typeof text === 'string' ? parseCfInteger(text) : undefined;
  if (typeof text !== 'string' || n === undefined) throw new LegacyApiError('invalidParameters');
  if (!ASCII_INTEGER.test(text)) {
    // ACF compares non-ASCII digit text with the bounds as a string, then its int() rejects it with an Expression error.
    if (text < '1' || text > String(maxValue)) throw new LegacyApiError('invalidParameters');
    throw new Error(`The ${name} paging parameter holds non-ASCII digits`);
  }
  if (n < 1 || n > maxValue) throw new LegacyApiError('invalidParameters');
  return n;
}

/** Port of envelope.cfc page(): pageIndex defaults to 1, itemsPerPage to 50 (at most 1000). */
export function fixturePage(params: FixtureParams): FixturePage {
  const pageIndex = pageParam(params, 'pageIndex', 1);
  const itemsPerPage = pageParam(params, 'itemsPerPage', 50, 1000);
  return { pageIndex, itemsPerPage, offset: (pageIndex - 1) * itemsPerPage };
}

/** envelope.cfc listResponse() data for a list() or queryPage() result. */
function listResultData(result: FixtureListResult): FixtureListData {
  const paged = result.totalItems !== undefined;
  const totalItems = result.totalItems ?? result.list.length;
  const { pageIndex, itemsPerPage } = result;
  const startIndex = (pageIndex - 1) * itemsPerPage + 1;
  const endIndex = Math.min(startIndex + itemsPerPage - 1, totalItems);
  let items: unknown[];
  if (startIndex > totalItems) items = [];
  else if (paged) items = [...result.list];
  else items = result.list.slice(startIndex - 1, endIndex);
  return {
    items,
    startindex: startIndex,
    endindex: endIndex,
    itemsperpage: itemsPerPage,
    totalitems: totalItems,
    totalpages: Math.ceil(totalItems / itemsPerPage),
    pageindex: pageIndex,
  };
}

/** One page of in-memory `items` in Masa's paged-list shape, paged by the request's pageIndex and itemsPerPage. */
export function fixtureListData(items: readonly unknown[], params: FixtureParams): FixtureListData {
  const { pageIndex, itemsPerPage } = fixturePage(params);
  return listResultData({ list: items, pageIndex, itemsPerPage });
}

/** Serializes a fixture envelope as envelope.cfc respond() does, with status, content type and ETag. */
function serializeFixture(envelope: LegacyEnvelope, status: number, params: FixtureParams): SerializedLegacyResponse {
  return serializeResponse(envelope, {
    statusCode: status,
    useDataNamespace: paramNoCase(params, 'useDataNamespace'),
    serializer: SERIALIZER,
  });
}

/** Sends the fixture success envelope with status 200. */
export function fixtureSuccess(reply: FastifyReply, a: FixtureContext & { data?: unknown }): FastifyReply {
  const envelope = buildEnvelope({ method: a.method, params: paramsWithoutMethod(a.params), data: a.data ?? {} });
  return sendLegacyResponse(reply, serializeFixture(envelope, 200, a.params));
}

/** Input of {@link fixtureList}: in-memory `items` paged by the request, or a prepared queryPage-style `listResult`. */
export type FixtureListInput = FixtureContext &
  ({ items: readonly unknown[]; listResult?: never } | { listResult: FixtureListResult; items?: never });

/** Sends one page of a fixture list in Masa's paged-list shape. */
export function fixtureList(reply: FastifyReply, a: FixtureListInput): FastifyReply {
  const data = a.listResult !== undefined ? listResultData(a.listResult) : fixtureListData(a.items, a.params);
  return fixtureSuccess(reply, { method: a.method, params: a.params, data });
}

/**
 * The fixture error envelope response for a thrown value; anything but a fixture or JSON API error is a 500.
 * A LegacyServiceUnavailableError is rethrown, so service-kit answers it with the legacy 503.
 */
export function fixtureErrorResponse(error: unknown, ctx: FixtureContext): SerializedLegacyResponse {
  if (error instanceof LegacyServiceUnavailableError) throw error;
  const row = error instanceof LegacyApiError ? fixtureErrorRow(error.type) : LEGACY_ERROR_MAP.server_error;
  const override = error instanceof FixtureApiError ? error.messageOverride : undefined;
  const envelope = buildEnvelope({
    method: ctx.method,
    params: paramsWithoutMethod(ctx.params),
    // envelope.cfc builds an ordered struct: code before message, unlike the JSON API's {message, code}.
    error: { code: row.code, message: fixtureErrorMessage(row, override) },
  });
  return serializeFixture(envelope, row.status, ctx.params);
}

/**
 * Fastify handler running `fn` with the fixture method and params, answering its throws with the fixture error envelope.
 * Unavailability errors propagate to service-kit's legacy 503; only unhandled errors are logged, as api.cfm logs them.
 */
export function fixtureHandler<R extends FastifyRequest = FastifyRequest>(
  method: string | ((request: R) => string),
  fn: FixtureRouteFn<R>,
): (request: R, reply: FastifyReply) => Promise<FastifyReply> {
  return async (request, reply) => {
    // legacyParamsOf merges query, then the form or JSON-object body, as api.cfm merges url, form and JSON.
    const ctx: FixtureContext = {
      method: typeof method === 'string' ? method : method(request),
      params: legacyParamsOf(request),
    };
    try {
      return await fn(request, reply, ctx);
    } catch (error) {
      const response = fixtureErrorResponse(error, ctx);
      if (!(error instanceof LegacyApiError)) request.log.error({ error: serializeError(error) }, 'Unhandled fixture exception');
      return sendLegacyResponse(reply, response);
    }
  };
}
