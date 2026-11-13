/** OpenAPI request, response, event and producer/consumer contract assertions, each throwing ContractAssertionError. */
import { Ajv2020, type AnySchemaObject, type ErrorObject, type Options, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  compileTopicSchema,
  envelopeSchema,
  eventTypeOf,
  isTopicName,
  schemaVersionOf,
  topicMeta,
  validateEnvelope,
  type EventEnvelope,
  type EventKind,
  type TenantFanout,
  type ValidationResult,
} from '../events/index.js';

/** One contract finding; `keyword` is ajv's keyword, or the name of the check that failed. */
export interface ContractViolation {
  instancePath: string;
  message: string;
  keyword: string;
}

/** Thrown by every assertion here; the message is the context line, then one `<instancePath> <message>` line per finding. */
export class ContractAssertionError extends Error {
  override readonly name = 'ContractAssertionError';
  readonly errors: ContractViolation[];
  /** What was checked, for example `GET /v1/notes 200 application/json`. */
  readonly context: string;

  constructor(context: string, errors: ContractViolation[]) {
    super([context, ...errors.map(renderViolation)].join('\n'));
    this.context = context;
    this.errors = errors;
  }
}

/** An OpenAPI operation object as parsed from the contract. */
export interface OpenApiOperation {
  operationId?: string;
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The operation a request resolves to and the `paths` key it matched. */
export interface OperationMatch {
  template: string;
  operation: OpenApiOperation;
}

/** A response to check, in the shape `app.inject` returns it. */
export interface ResponseUnderTest {
  method: string;
  /** Request path; a query string is ignored. */
  path: string;
  status: number;
  /** The `content-type` header; parameters such as `charset` are ignored. */
  contentType?: string | number | string[] | undefined;
  /** Parsed JSON or raw text; text is parsed when the media type is JSON. */
  body?: unknown;
}

/** A request to check; parameters and URL-encoded or multipart fields are wire strings. */
export interface RequestUnderTest {
  method: string;
  /** Request path; a query string in it is read as query parameters too. */
  path: string;
  /** Query parameters; a repeated name holds its values in order. */
  query?: Record<string, string | string[]>;
  /** Request headers; names match ignoring case, and a repeated header's values join with `, `. */
  headers?: Record<string, string | string[] | undefined>;
  /** The `content-type` header; parameters such as `boundary` and `charset` are ignored. */
  contentType?: string;
  /** Parsed JSON or JSON text, or the field record of a URL-encoded or multipart body. */
  body?: unknown;
}

/** JSON Schema type names. */
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** What a consumer reads from a producer's payload; field paths are dotted, for example `personId`. */
export interface ConsumerExpectation {
  required: string[];
  types?: Record<string, JsonType | JsonType[]>;
  /** Element types of array fields, checked against the field's `items` schema. */
  itemTypes?: Record<string, JsonType | JsonType[]>;
  /** Payloads the consumer is tested with; each must satisfy the producer schema. */
  samples?: unknown[];
  kind?: EventKind;
  fanout?: TenantFanout;
}

type Json = Record<string, unknown>;

interface Located {
  node: unknown;
  pointer: string[];
}

interface LocatedOperation extends OperationMatch {
  pointer: string[];
}

/** The envelope contract's calendar-valid RFC 3339 date-time pattern, accepting lower-case `t` and `z`. */
function envelopeDateTime(): RegExp {
  const pattern = at(envelopeSchema(), ['$defs', 'rfc3339DateTime', 'pattern']);
  if (typeof pattern !== 'string') {
    throw new Error('event-envelope.v1.json has no $defs.rfc3339DateTime.pattern');
  }
  return new RegExp(pattern, 'iu');
}

const DATE_TIME = envelopeDateTime();
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FULL_TIME = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(?:\.\d+)?(?:z|([+-])([01]\d|2[0-3]):([0-5]\d))$/i;

/** RFC 3339 full-date on a real calendar day. */
function isFullDate(value: string): boolean {
  return FULL_DATE.test(value) && DATE_TIME.test(`${value}T00:00:00Z`);
}

/** RFC 3339 full-time; second 60 is valid only at 23:59 UTC. */
function isFullTime(value: string): boolean {
  const match = FULL_TIME.exec(value);
  if (match === null) {
    return false;
  }
  const [, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  if (second !== '60') {
    return true;
  }
  const offset = (sign === '-' ? -1 : 1) * (Number(offsetHour ?? 0) * 60 + Number(offsetMinute ?? 0));
  return (Number(hour) * 60 + Number(minute) - offset + 1440) % 1440 === 1439;
}

/** RFC 3339 date-time: a full-date, `T` or `t`, then a full-time. */
function isDateTime(value: string): boolean {
  return (value[10] === 'T' || value[10] === 't') && isFullDate(value.slice(0, 10)) && isFullTime(value.slice(11));
}

const AJV_OPTIONS: Options = {
  strict: false,
  allErrors: true,
  validateFormats: true,
  formats: {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    // Calendar dates from the envelope pattern; RFC 3339 time grammar with unbounded fractions and 23:59 UTC leap seconds.
    'date-time': isDateTime,
    date: isFullDate,
    time: isFullTime,
    email: /^[^\s@]+@[^\s@]+$/,
    uri: /^[a-z][a-z0-9+.-]*:\S*$/i,
    int32: true,
    int64: true,
    float: true,
    double: true,
    byte: true,
    binary: true,
    password: true,
  },
};

const ajv = new Ajv2020(AJV_OPTIONS);

/** One Ajv instance with the contract documents registered in it and the validators compiled from them. */
interface SchemaValidators {
  readonly ajv: Ajv2020;
  readonly documents: WeakSet<object>;
  readonly compiled: Map<string, ValidateFunction>;
}

/** Validators of JSON values, as responses and JSON bodies carry them. */
const STRICT: SchemaValidators = { ajv, documents: new WeakSet(), compiled: new Map() };
/** Validators of wire strings (parameters, URL-encoded and multipart fields), coerced as their schema types them. */
const WIRE: SchemaValidators = {
  ajv: new Ajv2020({ ...AJV_OPTIONS, coerceTypes: 'array' }),
  documents: new WeakSet(),
  compiled: new Map(),
};

const PATH_PARAMETER = /\{[^}]+\}/g;
const JSON_MEDIA_TYPE = /(?:^application\/|\+)json$/;
const FORM_MEDIA_TYPES: ReadonlySet<string> = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

const documentIds = new WeakMap<object, string>();
const envelopeValidators = new WeakMap<object, ValidateFunction>();
let documentCount = 0;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderViolation(violation: ContractViolation): string {
  return violation.instancePath === '' ? violation.message : `${violation.instancePath} ${violation.message}`;
}

function failure(context: string, message: string, keyword: string): ContractAssertionError {
  return new ContractAssertionError(context, [{ instancePath: '', message, keyword }]);
}

function fromAjv(error: ErrorObject, prefix = ''): ContractViolation {
  const message = error.message ?? error.keyword;
  return {
    instancePath: prefix === '' ? error.instancePath || '/' : `${prefix}${error.instancePath}`,
    message:
      error.keyword === 'additionalProperties' ? `${message} (${String(error.params.additionalProperty)})` : message,
    keyword: error.keyword,
  };
}

function ajvViolations(validate: ValidateFunction, value: unknown, prefix = ''): ContractViolation[] {
  return validate(value) ? [] : (validate.errors ?? []).map((error) => fromAjv(error, prefix));
}

// The events validators report "<instancePath> <message>" text, with "/" for the root.
function textViolations(prefix: string, result: ValidationResult<unknown>): ContractViolation[] {
  if (result.ok) {
    return [];
  }
  return result.errors.map((text) => {
    const space = text.indexOf(' ');
    const path = text.slice(0, space);
    return { instancePath: `${prefix}${path === '/' ? '' : path}`, message: text.slice(space + 1), keyword: 'schema' };
  });
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeSegment(segment: string): string {
  return decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
}

function localPointer(ref: string): string[] {
  return ref.slice(2).split('/').map(unescapeSegment);
}

function at(root: Json, pointer: readonly string[]): unknown {
  let node: unknown = root;
  for (const segment of pointer) {
    node = isRecord(node) ? node[segment] : undefined;
  }
  return node;
}

// OpenAPI Reference Objects on path items and responses move the schema to another part of the document.
function follow(root: Json, located: Located): Located {
  let { node, pointer } = located;
  const seen = new Set<string>();
  while (isRecord(node) && typeof node.$ref === 'string' && node.$ref.startsWith('#/') && !seen.has(node.$ref)) {
    seen.add(node.$ref);
    pointer = localPointer(node.$ref);
    node = at(root, pointer);
  }
  return { node, pointer };
}

// One capturing group per path parameter, in template order.
function templatePattern(template: string): RegExp {
  const source = template
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

function locateOperation(doc: object, method: string, path: string): LocatedOperation {
  const root = doc as Json;
  const verb = method.toLowerCase();
  const requestPath = path.replace(/\?.*$/s, '');
  const paths = isRecord(root.paths) ? root.paths : {};
  // Literal templates first, then fewer parameters; the stable sort keeps document order for ties.
  const candidates = Object.keys(paths)
    .filter((template) => templatePattern(template).test(requestPath))
    .map((template) => ({ template, parameters: (template.match(PATH_PARAMETER) ?? []).length }))
    .sort((a, b) => a.parameters - b.parameters);
  for (const { template } of candidates) {
    const item = follow(root, { node: paths[template], pointer: ['paths', template] });
    const operation = isRecord(item.node) ? item.node[verb] : undefined;
    if (isRecord(operation)) {
      return { template, operation, pointer: [...item.pointer, verb] };
    }
  }
  const request = `${method.toUpperCase()} ${requestPath}`;
  throw failure(request, `no operation for ${request}`, 'operation');
}

/** Finds the operation of `doc` that serves `method` on `path`; throws ContractAssertionError when none does. */
export function findOperation(doc: object, method: string, path: string): OperationMatch {
  const { template, operation } = locateOperation(doc, method, path);
  return { template, operation };
}

function mediaTypeOf(value: string | number | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  return header === undefined ? '' : String(header).replace(/;.*$/s, '').trim().toLowerCase();
}

function matchMediaType(declared: readonly string[], mediaType: string): string | undefined {
  if (mediaType === '') {
    return undefined;
  }
  for (const wanted of [mediaType, mediaType.replace(/\/.*$/s, '/*'), '*/*']) {
    const key = declared.find((candidate) => mediaTypeOf(candidate) === wanted);
    if (key !== undefined) {
      return key;
    }
  }
  return undefined;
}

function isEmptyBody(body: unknown): boolean {
  return body === undefined || body === null || body === '';
}

function parsedBody(body: unknown, mediaType: string, context: string): unknown {
  if (typeof body !== 'string' || !JSON_MEDIA_TYPE.test(mediaType)) {
    return body;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw failure(context, `body is not JSON: ${(error as Error).message}`, 'json');
  }
}

// The document is registered once per Ajv instance as a schema resource, so `#/components/...` refs resolve inside it.
function validatorAt(validators: SchemaValidators, doc: object, pointer: readonly string[]): ValidateFunction {
  let id = documentIds.get(doc);
  if (id === undefined) {
    documentCount += 1;
    id = `urn:opt2:testing:openapi:${documentCount}`;
    documentIds.set(doc, id);
  }
  if (!validators.documents.has(doc)) {
    validators.ajv.addSchema(doc, id);
    validators.documents.add(doc);
  }
  // URI-fragment form of the pointer (RFC 6901 section 6), so braces and spaces in keys survive URI parsing.
  const ref = `${id}#/${pointer.map((segment) => encodeURIComponent(escapeSegment(segment))).join('/')}`;
  let validate = validators.compiled.get(ref);
  if (validate === undefined) {
    validate = validators.ajv.compile({ $ref: ref });
    validators.compiled.set(ref, validate);
  }
  return validate;
}

/** Validates a response against its operation in `doc` and returns the validated (JSON-parsed) body. */
export function assertResponseMatchesOpenApi(doc: object, response: ResponseUnderTest): unknown {
  const root = doc as Json;
  const { template, operation, pointer } = locateOperation(doc, response.method, response.path);
  const status = String(response.status);
  const mediaType = mediaTypeOf(response.contentType);
  const context = [response.method.toUpperCase(), template, status, mediaType].filter(Boolean).join(' ');

  const responses = isRecord(operation.responses) ? operation.responses : {};
  const statusKey = [status, `${status.charAt(0)}XX`, 'default'].find((key) => key in responses);
  if (statusKey === undefined) {
    throw failure(context, `status ${status} is not declared`, 'status');
  }
  const declared = follow(root, { node: responses[statusKey], pointer: [...pointer, 'responses', statusKey] });
  const content = isRecord(declared.node) && isRecord(declared.node.content) ? declared.node.content : undefined;
  if (content === undefined) {
    if (isEmptyBody(response.body)) {
      return response.body;
    }
    throw failure(context, `response ${statusKey} declares no content but the body is not empty`, 'content');
  }
  const mediaKey = matchMediaType(Object.keys(content), mediaType);
  if (mediaKey === undefined) {
    const offered = Object.keys(content).join(', ');
    const message = `content type ${mediaType || '(none)'} is not declared; response ${statusKey} declares ${offered}`;
    throw failure(context, message, 'content');
  }
  const body = parsedBody(response.body, mediaType, context);
  const media = content[mediaKey];
  if (!isRecord(media) || media.schema === undefined) {
    return body;
  }
  const errors = ajvViolations(validatorAt(STRICT, doc, [...declared.pointer, 'content', mediaKey, 'schema']), body);
  if (errors.length > 0) {
    throw new ContractAssertionError(context, errors);
  }
  return body;
}

/** A parameter an operation declares, with the pointer to its schema. */
interface DeclaredParameter {
  name: string;
  in: string;
  required: boolean;
  schema?: string[];
  /** A form-style exploded object, whose properties are the query names no other parameter declares. */
  spread: boolean;
  /** A form-style unexploded array, sent as one comma-separated value. */
  commaList: boolean;
}

// Path-item parameters, then the operation's, which replace a path-item parameter of the same name and location.
function declaredParameters(root: Json, operationPointer: readonly string[]): DeclaredParameter[] {
  const byKey = new Map<string, DeclaredParameter>();
  for (const owner of [operationPointer.slice(0, -1), operationPointer]) {
    const list = at(root, [...owner, 'parameters']);
    if (!Array.isArray(list)) {
      continue;
    }
    list.forEach((entry: unknown, index) => {
      const { node, pointer } = follow(root, { node: entry, pointer: [...owner, 'parameters', String(index)] });
      if (!isRecord(node) || typeof node.name !== 'string' || typeof node.in !== 'string') {
        return;
      }
      const schemaPointer = [...pointer, 'schema'];
      const schema = follow(root, { node: node.schema, pointer: schemaPointer }).node;
      const type = isRecord(schema) ? schema.type : undefined;
      const form = node.in === 'query' && (node.style ?? 'form') === 'form';
      const exploded = node.explode !== false;
      byKey.set(`${node.in} ${node.in === 'header' ? node.name.toLowerCase() : node.name}`, {
        name: node.name,
        in: node.in,
        required: node.required === true || node.in === 'path',
        ...(node.schema === undefined ? {} : { schema: schemaPointer }),
        spread: form && exploded && type === 'object',
        commaList: form && !exploded && type === 'array',
      });
    });
  }
  return [...byKey.values()];
}

// URI-decoded path parameters of `requestPath` by template name.
function pathValues(template: string, requestPath: string): Map<string, string> {
  const names = (template.match(PATH_PARAMETER) ?? []).map((segment) => segment.slice(1, -1));
  const match = templatePattern(template).exec(requestPath) ?? [];
  return new Map(names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]));
}

// Query values by name in order, the path's query string first.
function queryValues(request: RequestUnderTest): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const add = (name: string, value: string): void => {
    values.set(name, [...(values.get(name) ?? []), value]);
  };
  const queryAt = request.path.indexOf('?');
  if (queryAt >= 0) {
    for (const [name, value] of new URLSearchParams(request.path.slice(queryAt + 1))) {
      add(name, value);
    }
  }
  for (const [name, value] of Object.entries(request.query ?? {})) {
    for (const item of [value].flat()) {
      add(name, item);
    }
  }
  return values;
}

// Header values by lower-cased name.
function headerValues(headers: RequestUnderTest['headers'] = {}): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      values.set(name.toLowerCase(), [value].flat().join(', '));
    }
  }
  return values;
}

// Query names of the API keys the operation's security requirements, else the document's, send.
function securityQueryNames(root: Json, operation: OpenApiOperation): string[] {
  const requirements: unknown[] = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(root.security)
      ? root.security
      : [];
  const components = isRecord(root.components) ? root.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  return requirements
    .flatMap((requirement) => (isRecord(requirement) ? Object.keys(requirement) : []))
    .map((scheme) => follow(root, { node: schemes[scheme], pointer: [] }).node)
    .flatMap((scheme) =>
      isRecord(scheme) && scheme.type === 'apiKey' && scheme.in === 'query' && typeof scheme.name === 'string'
        ? [scheme.name]
        : [],
    );
}

// One value as sent, repeats as an array, and an unexploded list split at its commas.
function parameterValue(parameter: DeclaredParameter, values: readonly string[]): unknown {
  if (parameter.commaList) {
    return values.flatMap((value) => value.split(','));
  }
  return values.length === 1 ? values[0] : [...values];
}

function parameterViolations(doc: object, parameter: DeclaredParameter, value: unknown): ContractViolation[] {
  const instancePath = `${parameter.in}/${parameter.name}`;
  if (value === undefined) {
    return parameter.required ? [{ instancePath, message: 'is required', keyword: 'required' }] : [];
  }
  // Coercion rewrites the value it validates, so the schema sees a copy.
  return parameter.schema === undefined
    ? []
    : ajvViolations(validatorAt(WIRE, doc, parameter.schema), structuredClone(value), instancePath);
}

function queryViolations(
  doc: object,
  operation: OpenApiOperation,
  parameters: readonly DeclaredParameter[],
  query: ReadonlyMap<string, string[]>,
): ContractViolation[] {
  const named = parameters.filter((parameter) => parameter.in === 'query' && !parameter.spread);
  const declared = new Set([...named.map(({ name }) => name), ...securityQueryNames(doc as Json, operation)]);
  const errors = named.flatMap((parameter) => {
    const values = query.get(parameter.name);
    return parameterViolations(doc, parameter, values === undefined ? undefined : parameterValue(parameter, values));
  });
  const rest = [...query].filter(([name]) => !declared.has(name));
  const spread = parameters.find((parameter) => parameter.in === 'query' && parameter.spread);
  if (spread !== undefined) {
    const fields = rest.map(([name, values]) => [name, parameterValue(spread, values)] as const);
    return [...errors, ...parameterViolations(doc, spread, fields.length === 0 ? undefined : Object.fromEntries(fields))];
  }
  const undeclared = rest.map(([name]) => ({
    instancePath: `query/${name}`,
    message: 'is not a declared query parameter',
    keyword: 'parameter',
  }));
  return [...errors, ...undeclared];
}

interface CheckedBody {
  body: unknown;
  errors: ContractViolation[];
}

// The body against the operation's request body: presence, media type, then its schema, form fields as wire strings.
function checkedRequestBody(doc: object, operationPointer: readonly string[], request: RequestUnderTest): CheckedBody {
  const root = doc as Json;
  const pointer = [...operationPointer, 'requestBody'];
  const located = follow(root, { node: at(root, pointer), pointer });
  const declared = isRecord(located.node) ? located.node : undefined;
  const mediaType = mediaTypeOf(request.contentType);
  const fail = (message: string, keyword: string): CheckedBody => ({
    body: request.body,
    errors: [{ instancePath: 'body', message, keyword }],
  });
  if (isEmptyBody(request.body)) {
    return declared?.required === true ? fail('is required', 'requestBody') : { body: request.body, errors: [] };
  }
  const content = declared !== undefined && isRecord(declared.content) ? declared.content : undefined;
  if (content === undefined) {
    return fail('is sent but the operation declares no request body', 'requestBody');
  }
  const mediaKey = matchMediaType(Object.keys(content), mediaType);
  if (mediaKey === undefined) {
    const offered = Object.keys(content).join(', ');
    return fail(`content type ${mediaType || '(none)'} is not declared; the body declares ${offered}`, 'content');
  }
  let body = request.body;
  if (typeof body === 'string' && JSON_MEDIA_TYPE.test(mediaType)) {
    try {
      body = JSON.parse(body) as unknown;
    } catch (error) {
      return fail(`is not JSON: ${(error as Error).message}`, 'json');
    }
  }
  const media = content[mediaKey];
  if (!isRecord(media) || media.schema === undefined) {
    return { body, errors: [] };
  }
  const wire = FORM_MEDIA_TYPES.has(mediaType);
  const validate = validatorAt(wire ? WIRE : STRICT, doc, [...located.pointer, 'content', mediaKey, 'schema']);
  return { body, errors: ajvViolations(validate, wire ? structuredClone(body) : body, 'body') };
}

/**
 * Validates a request against its operation in `doc` and returns the validated (JSON-parsed) body: path, query and
 * header parameters, every undeclared query name, and the request body. Cookie parameters are not checked.
 */
export function assertRequestMatchesOpenApi(doc: object, request: RequestUnderTest): unknown {
  const { template, operation, pointer } = locateOperation(doc, request.method, request.path);
  const parameters = declaredParameters(doc as Json, pointer);
  const path = pathValues(template, request.path.replace(/\?.*$/s, ''));
  const headers = headerValues(request.headers);
  const located = (where: string): DeclaredParameter[] => parameters.filter((parameter) => parameter.in === where);
  const { body, errors: bodyErrors } = checkedRequestBody(doc, pointer, request);
  const errors = [
    ...located('path').flatMap((parameter) => parameterViolations(doc, parameter, path.get(parameter.name))),
    ...queryViolations(doc, operation, parameters, queryValues(request)),
    ...located('header').flatMap((parameter) =>
      parameterViolations(doc, parameter, headers.get(parameter.name.toLowerCase())),
    ),
    ...bodyErrors,
  ];
  if (errors.length > 0) {
    const context = [request.method.toUpperCase(), template, 'request', mediaTypeOf(request.contentType)];
    throw new ContractAssertionError(context.filter(Boolean).join(' '), errors);
  }
  return body;
}

function schemaLabel(schema: object): string {
  const { $id, title } = schema as Json;
  return typeof $id === 'string' ? $id : typeof title === 'string' ? title : 'schema';
}

// Topic schemas carry `$id` `urn:opt2:<service>:event:<topic>` and a title starting with the topic.
function topicNamedBy(schema: object): string | undefined {
  const { $id, title } = schema as Json;
  return [$id, title]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(/[\s:/#]+/))
    .map((token) => token.replace(/\.json$/, ''))
    .find((token) => isTopicName(token));
}

function customEnvelopeValidator(schema: object): ValidateFunction {
  let validate = envelopeValidators.get(schema);
  if (validate === undefined) {
    const { $id } = schema as Json;
    // A fresh copy of an envelope schema (envelopeSchema() returns one per call) replaces the earlier copy's $id.
    if (typeof $id === 'string') {
      ajv.removeSchema($id);
    }
    validate = ajv.compile(schema as AnySchemaObject);
    envelopeValidators.set(schema, validate);
  }
  return validate;
}

/**
 * Validates an event: the envelope against `envelopeSchema` (the platform envelope contract when undefined),
 * the payload against the topic schema, and `eventType`/`schemaVersion` against the topic the schema names.
 */
export function assertEventMatches(
  envelopeSchema: object | undefined,
  payloadSchema: object,
  envelope: unknown,
): EventEnvelope {
  const topic = topicNamedBy(payloadSchema);
  const errors =
    envelopeSchema === undefined
      ? textViolations('envelope', validateEnvelope(envelope))
      : ajvViolations(customEnvelopeValidator(envelopeSchema), envelope, 'envelope');
  const record = isRecord(envelope) ? envelope : undefined;
  if (topic !== undefined && record !== undefined) {
    // Same expectation as the publisher: the topic fixes eventType and schemaVersion exactly.
    const expected = { eventType: eventTypeOf(topic), schemaVersion: schemaVersionOf(topic) };
    for (const [field, value] of Object.entries(expected)) {
      if (field in record && record[field] !== value) {
        errors.push({ instancePath: `envelope/${field}`, message: `must be ${value} on topic ${topic}`, keyword: 'topic' });
      }
    }
  }
  if (record !== undefined && 'payload' in record) {
    errors.push(...textViolations('payload', compileTopicSchema(payloadSchema).validatePayload(record.payload)));
  }
  if (errors.length > 0) {
    throw new ContractAssertionError(`event ${topic ?? schemaLabel(payloadSchema)}`, errors);
  }
  return envelope as EventEnvelope;
}

// A schema node with its `allOf` members and local `$ref` targets (`$defs`, `definitions`).
function branches(root: Json, node: unknown, seen: Set<unknown> = new Set()): Json[] {
  if (!isRecord(node) || seen.has(node)) {
    return [];
  }
  seen.add(node);
  const linked: unknown[] = Array.isArray(node.allOf) ? [...(node.allOf as unknown[])] : [];
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    linked.push(at(root, localPointer(node.$ref)));
  }
  return [node, ...linked.flatMap((member) => branches(root, member, seen))];
}

// Walks a dotted field path; returns the field's schema branches, or the finding that stops the walk.
function producerField(root: Json, path: string, mustBeRequired: boolean): Json[] | ContractViolation {
  const segments = path.split('.');
  let level: unknown[] = [root];
  for (const [index, name] of segments.entries()) {
    const instancePath = `/${segments.slice(0, index + 1).join('/')}`;
    const nodes = level.flatMap((node) => branches(root, node));
    const found = nodes.flatMap((node) =>
      isRecord(node.properties) && node.properties[name] !== undefined ? [node.properties[name]] : [],
    );
    if (found.length === 0) {
      return { instancePath, message: 'is not declared by the producer', keyword: 'properties' };
    }
    if (mustBeRequired && !nodes.some((node) => Array.isArray(node.required) && node.required.includes(name))) {
      return { instancePath, message: 'is optional in the producer but required by the consumer', keyword: 'required' };
    }
    level = found;
  }
  return level.flatMap((node) => branches(root, node));
}

// The types every declaring branch allows (allOf intersects); undefined when no branch declares `type`.
function producedTypes(nodes: readonly Json[]): Set<string> | undefined {
  let types: Set<string> | undefined;
  for (const node of nodes) {
    if (node.type !== undefined) {
      const own = new Set((Array.isArray(node.type) ? node.type : [node.type]) as string[]);
      types = types === undefined ? own : new Set([...types].filter((type) => own.has(type)));
    }
  }
  return types;
}

function typeViolation(path: string, nodes: readonly Json[], accepts: JsonType | JsonType[]): ContractViolation | undefined {
  const instancePath = `/${path.split('.').join('/')}`;
  const accepted = new Set<string>(Array.isArray(accepts) ? accepts : [accepts]);
  const produced = producedTypes(nodes);
  if (produced === undefined || produced.size === 0) {
    return { instancePath, message: 'declares no type the consumer can rely on', keyword: 'type' };
  }
  // An integer is a number, so an integer producer satisfies a number consumer.
  const unaccepted = [...produced].filter((type) => !accepted.has(type) && !(type === 'integer' && accepted.has('number')));
  return unaccepted.length === 0
    ? undefined
    : {
        instancePath,
        message: `is ${[...produced].join('|')} but the consumer accepts ${[...accepted].join('|')}`,
        keyword: 'type',
      };
}

// Types the `items` schemas of all the field's branches like a field; no `items` in any branch is a finding.
function itemTypeViolation(
  root: Json,
  path: string,
  nodes: readonly Json[],
  accepts: JsonType | JsonType[],
): ContractViolation | undefined {
  const items = nodes.flatMap((node) => (node.items === undefined ? [] : [node.items]));
  if (items.length === 0) {
    const instancePath = `/${path.split('.').join('/')}/items`;
    return { instancePath, message: 'declares no items schema the consumer can rely on', keyword: 'items' };
  }
  return typeViolation(`${path}.items`, items.flatMap((item) => branches(root, item)), accepts);
}

/** Checks that a producer's payload schema provides every field, type, sample and declaration a consumer relies on. */
export function assertProducerConsumerCompatible(producerSchema: object, expectation: ConsumerExpectation): void {
  const root = producerSchema as Json;
  const errors: ContractViolation[] = [];
  for (const path of expectation.required) {
    const field = producerField(root, path, true);
    if (!Array.isArray(field)) {
      errors.push(field);
    }
  }
  for (const [path, accepts] of Object.entries(expectation.types ?? {})) {
    const field = producerField(root, path, false);
    const violation = Array.isArray(field) ? typeViolation(path, field, accepts) : field;
    // A field the required walk already reported as undeclared is not reported twice.
    const reported = (error: ContractViolation): boolean =>
      error.instancePath === violation?.instancePath && error.keyword === violation.keyword;
    if (violation !== undefined && !errors.some(reported)) {
      errors.push(violation);
    }
  }
  for (const [path, accepts] of Object.entries(expectation.itemTypes ?? {})) {
    const field = producerField(root, path, false);
    const violation = Array.isArray(field) ? itemTypeViolation(root, path, field, accepts) : field;
    const reported = (error: ContractViolation): boolean =>
      error.instancePath === violation?.instancePath && error.keyword === violation.keyword;
    if (violation !== undefined && !errors.some(reported)) {
      errors.push(violation);
    }
  }
  if (expectation.samples !== undefined && expectation.samples.length > 0) {
    const validator = compileTopicSchema(producerSchema);
    expectation.samples.forEach((sample, index) => {
      errors.push(...textViolations(`samples/${index}`, validator.validatePayload(sample)));
    });
  }
  if (expectation.kind !== undefined || expectation.fanout !== undefined) {
    const meta = topicMeta(producerSchema);
    if (expectation.kind !== undefined && meta.kind !== expectation.kind) {
      errors.push({
        instancePath: '',
        message: `x-opt2-kind is ${meta.kind}; the consumer expects ${expectation.kind}`,
        keyword: 'x-opt2-kind',
      });
    }
    if (expectation.fanout !== undefined && meta.fanout !== expectation.fanout) {
      errors.push({
        instancePath: '',
        message: `x-opt2-tenant-fanout is ${meta.fanout ?? 'absent'}; the consumer expects ${expectation.fanout}`,
        keyword: 'x-opt2-tenant-fanout',
      });
    }
  }
  if (errors.length > 0) {
    throw new ContractAssertionError(`producer ${schemaLabel(producerSchema)}`, errors);
  }
}
