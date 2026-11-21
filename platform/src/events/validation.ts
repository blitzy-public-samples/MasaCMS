/** Envelope and topic payload-schema validation on one shared draft 2020-12 Ajv instance. */
import { readFileSync } from 'node:fs';
import { Ajv2020, type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { EventEnvelope } from './envelope.js';

/** `$id` of `platform/contracts/event-envelope.v1.json`. */
export const ENVELOPE_SCHEMA_ID = 'urn:opt2:platform:event-envelope:v1';

const EVENT_KINDS = ['state', 'process'] as const;
const TENANT_FANOUTS = ['userPool'] as const;
const KIND_KEYWORD = 'x-opt2-kind';
const FANOUT_KEYWORD = 'x-opt2-tenant-fanout';
const SUPERSEDES_KEYWORD = 'x-opt2-supersedes';
const OPT2_KEYWORD_PREFIX = 'x-opt2-';

/** Delivery semantics a topic declares with `x-opt2-kind`. */
export type EventKind = (typeof EVENT_KINDS)[number];

/** Destination-tenant derivation a topic declares with `x-opt2-tenant-fanout`. */
export type TenantFanout = (typeof TENANT_FANOUTS)[number];

/** The `x-opt2-*` declarations at a topic schema's root. */
export interface TopicMeta {
  kind: EventKind;
  fanout?: TenantFanout;
  /** On a `process` topic: a later aggregate version replaces the effect of an earlier one. */
  supersedes?: boolean;
}

/** Validation outcome; errors are `"<instancePath> <message>"` strings, schemaPaths the distinct failing schema locations, free of instance data. */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[]; schemaPaths: string[] };

/** A compiled topic payload schema with its declarations. */
export interface TopicValidator<P = unknown> {
  meta: TopicMeta;
  schemaId?: string;
  validatePayload(payload: unknown): ValidationResult<P>;
}

/** Raised when a topic schema's `x-opt2-*` declarations are missing or inconsistent. */
export class TopicSchemaError extends Error {
  override readonly name = 'TopicSchemaError';
}

interface Instance {
  ajv: Ajv2020;
  envelope: ValidateFunction<EventEnvelope>;
}

let contract: AnySchemaObject | undefined;
let instance: Instance | undefined;

function envelopeContract(): AnySchemaObject {
  contract ??= JSON.parse(
    readFileSync(new URL('../../contracts/event-envelope.v1.json', import.meta.url), 'utf8'),
  ) as AnySchemaObject;
  return contract;
}

function contractPattern(name: string): string {
  const pattern: unknown = envelopeContract().$defs?.[name]?.pattern;
  if (typeof pattern !== 'string') {
    throw new Error(`event-envelope.v1.json has no $defs.${name}.pattern`);
  }
  return pattern;
}

// Formats for topic schemas, built from the envelope's $defs so both accept the same values (the envelope itself uses no `format`).
function shared(): Instance {
  if (instance === undefined) {
    const uuid = new RegExp(contractPattern('rfc4122Uuid'), 'iu');
    const dateTime = new RegExp(contractPattern('rfc3339DateTime'), 'u');
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: true,
      formats: {
        uuid,
        'date-time': (value: string) => dateTime.test(value) && Number.isFinite(Date.parse(value)),
      },
    });
    ajv.addKeyword({ keyword: KIND_KEYWORD, metaSchema: { enum: [...EVENT_KINDS] } });
    ajv.addKeyword({ keyword: FANOUT_KEYWORD, metaSchema: { enum: [...TENANT_FANOUTS] } });
    ajv.addKeyword({ keyword: SUPERSEDES_KEYWORD, metaSchema: { type: 'boolean' } });
    ajv.addSchema(envelopeContract());
    const envelope = ajv.getSchema<EventEnvelope>(ENVELOPE_SCHEMA_ID);
    if (envelope === undefined) {
      throw new Error(`event-envelope.v1.json does not declare $id ${ENVELOPE_SCHEMA_ID}`);
    }
    instance = { ajv, envelope };
  }
  return instance;
}

function formatError(error: ErrorObject): string {
  const text = `${error.instancePath || '/'} ${error.message ?? error.keyword}`;
  return error.keyword === 'additionalProperties'
    ? `${text} (${String(error.params.additionalProperty)})`
    : text;
}

function resultOf<T>(validate: ValidateFunction, value: unknown): ValidationResult<T> {
  if (validate(value)) {
    return { ok: true, value: value as T };
  }
  const errors = validate.errors ?? [];
  return { ok: false, errors: errors.map(formatError), schemaPaths: [...new Set(errors.map((error) => error.schemaPath))] };
}

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function schemaLabel(schema: Record<string, unknown>): string {
  const { $id, title } = schema;
  return typeof $id === 'string' ? $id : typeof title === 'string' ? title : 'topic schema';
}

// Strict mode rejects unknown keywords, so every `x-opt2-*` key at any depth becomes an annotation keyword.
function registerOpt2Keywords(ajv: Ajv2020, node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach((item) => registerOpt2Keywords(ajv, item));
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith(OPT2_KEYWORD_PREFIX) && ajv.getKeyword(key) === false) {
      ajv.addKeyword({ keyword: key });
    }
    registerOpt2Keywords(ajv, value);
  }
}

function registeredValidator(ajv: Ajv2020, schemaId: string, schema: object): ValidateFunction | undefined {
  const existing = ajv.getSchema(schemaId);
  if (existing !== undefined && JSON.stringify(existing.schema) !== JSON.stringify(schema)) {
    throw new TopicSchemaError(`Schema ${schemaId} is already registered with different content`);
  }
  return existing;
}

function compileNew(ajv: Ajv2020, schemaId: string | undefined, schema: AnySchemaObject): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (error) {
    // Ajv registers the $id before compiling; dropping it lets a corrected schema with the same $id compile later.
    if (schemaId !== undefined) {
      ajv.removeSchema(schemaId);
    }
    throw error;
  }
}

/** The parsed envelope contract (a copy). */
export function envelopeSchema(): AnySchemaObject {
  return structuredClone(envelopeContract());
}

/** Validates a decoded message against event-envelope.v1; the payload is validated separately per topic. */
export function validateEnvelope(value: unknown): ValidationResult<EventEnvelope> {
  return resultOf<EventEnvelope>(shared().envelope, value);
}

/** Reads the `x-opt2-*` declarations at a topic schema's root; throws TopicSchemaError when missing or inconsistent. */
export function topicMeta(schema: object): TopicMeta {
  const root = schema as Record<string, unknown>;
  const kind = root[KIND_KEYWORD];
  const fanout = root[FANOUT_KEYWORD];
  const supersedes = root[SUPERSEDES_KEYWORD];
  const label = schemaLabel(root);
  if (!isOneOf(EVENT_KINDS, kind)) {
    throw new TopicSchemaError(`${label}: ${KIND_KEYWORD} must be one of ${EVENT_KINDS.join(', ')}, got ${JSON.stringify(kind)}`);
  }
  if (fanout !== undefined && !isOneOf(TENANT_FANOUTS, fanout)) {
    throw new TopicSchemaError(`${label}: ${FANOUT_KEYWORD} must be one of ${TENANT_FANOUTS.join(', ')}, got ${JSON.stringify(fanout)}`);
  }
  if (supersedes !== undefined && (typeof supersedes !== 'boolean' || kind !== 'process')) {
    throw new TopicSchemaError(`${label}: ${SUPERSEDES_KEYWORD} must be a boolean on a process topic`);
  }
  return {
    kind,
    ...(fanout !== undefined ? { fanout } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
  };
}

/** Compiles a topic payload schema; a schema whose `$id` is already registered with the same content is reused. */
export function compileTopicSchema<P = unknown>(schema: object): TopicValidator<P> {
  const meta = topicMeta(schema);
  const { ajv } = shared();
  const objectSchema = schema as AnySchemaObject;
  const schemaId = typeof objectSchema.$id === 'string' ? objectSchema.$id : undefined;
  registerOpt2Keywords(ajv, schema);
  const validate =
    (schemaId === undefined ? undefined : registeredValidator(ajv, schemaId, schema)) ??
    compileNew(ajv, schemaId, objectSchema);
  return {
    meta,
    ...(schemaId !== undefined ? { schemaId } : {}),
    validatePayload: (payload: unknown) => resultOf<P>(validate, payload),
  };
}

/** Reads and parses a topic schema file (synchronous; start-up only). */
export function readTopicSchema(location: string | URL): AnySchemaObject {
  return JSON.parse(readFileSync(location, 'utf8')) as AnySchemaObject;
}
