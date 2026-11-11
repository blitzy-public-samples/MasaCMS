/** OpenAPI response, event and producer/consumer contract assertions; every failure throws ContractAssertionError. */
import { Ajv2020, type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
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

/** JSON Schema type names. */
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** What a consumer reads from a producer's payload; field paths are dotted, for example `personId`. */
export interface ConsumerExpectation {
  required: string[];
  types?: Record<string, JsonType | JsonType[]>;
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

const ajv = new Ajv2020({
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
});

const PATH_PARAMETER = /\{[^}]+\}/g;
const JSON_MEDIA_TYPE = /(?:^application\/|\+)json$/;

const documentIds = new WeakMap<object, string>();
const responseValidators = new Map<string, ValidateFunction>();
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

function templatePattern(template: string): RegExp {
  const source = template
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
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

// The document is registered once as a schema resource, so `#/components/...` refs resolve inside it.
function responseValidator(doc: object, pointer: readonly string[]): ValidateFunction {
  let id = documentIds.get(doc);
  if (id === undefined) {
    documentCount += 1;
    id = `urn:opt2:testing:openapi:${documentCount}`;
    ajv.addSchema(doc as AnySchemaObject, id);
    documentIds.set(doc, id);
  }
  // URI-fragment form of the pointer (RFC 6901 section 6), so braces and spaces in keys survive URI parsing.
  const ref = `${id}#/${pointer.map((segment) => encodeURIComponent(escapeSegment(segment))).join('/')}`;
  let validate = responseValidators.get(ref);
  if (validate === undefined) {
    validate = ajv.compile({ $ref: ref });
    responseValidators.set(ref, validate);
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
  const errors = ajvViolations(responseValidator(doc, [...declared.pointer, 'content', mediaKey, 'schema']), body);
  if (errors.length > 0) {
    throw new ContractAssertionError(context, errors);
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
