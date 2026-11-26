/** Event envelope (`platform/contracts/event-envelope.v1.json`): type, builder, Pub/Sub attributes and encoding. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { v4 as uuidv4 } from 'uuid';
// The context module rather than the service-kit barrel, so events never loads the Fastify factory or forms an import cycle with it.
import { currentRequestContext } from '../service-kit/context.js';
import { assertTenantId, currentTenantTx } from '../tenancy/index.js';
import { currentTraceparent, pubsubAttributes, type TraceCarrier } from '../tracing/index.js';
import { InvalidEventNameError, eventTypeOf, parseTopic, schemaVersionOf } from './naming.js';

/** An event as published to Pub/Sub; keys follow the contract's property order. */
export interface EventEnvelope<P = unknown> {
  /** RFC 4122 uuid; the inbox idempotency key. */
  eventId: string;
  /** `<service>.<entity>.<event>`. */
  eventType: string;
  /** `<major>.<minor>.<patch>`; the major equals the topic's `v<major>`. */
  schemaVersion: string;
  /** Producer's transaction tenant. */
  tenantId: string;
  /** RFC 3339 date-time. */
  occurredAt: string;
  producer: string;
  aggregateType: string;
  /** Pub/Sub ordering key. */
  aggregateId: string;
  /** Producer's per-aggregate `row_version` (integer >= 1), incremented in the write's transaction. */
  aggregateVersion: number;
  traceparent: string;
  tracestate?: string;
  correlationId: string;
  causationId?: string | null;
  payload: P;
}

/** Input of `buildEnvelope`; omitted optional fields take their defaults from the active scopes. */
export interface BuildEnvelopeInput<P> {
  /** Full topic name, `<service>.<entity>.<event>.v<major>`. */
  topic: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  payload: P;
  /** Required outside a tenant transaction; inside one it may only repeat the transaction tenant. */
  tenantId?: string;
  /** Must equal the topic's service when given. */
  producer?: string;
  eventId?: string;
  occurredAt?: Date | string;
  correlationId?: string;
  causationId?: string;
  trace?: TraceCarrier;
}

/** Raised when an envelope's tenant is missing or differs from the active transaction tenant. */
export class EnvelopeTenantError extends Error {
  override readonly name = 'EnvelopeTenantError';
}

/** Pub/Sub attribute names mirroring envelope fields. */
export const ENVELOPE_ATTRIBUTE_KEYS = [
  'eventId',
  'eventType',
  'schemaVersion',
  'tenantId',
  'aggregateVersion',
  'traceparent',
] as const;

const consumedEnvelope = new AsyncLocalStorage<EventEnvelope>();

/** Runs `fn` with `envelope` as the event being consumed, so envelopes built inside inherit its correlation. */
export function runWithConsumedEnvelope<T>(envelope: EventEnvelope, fn: () => T): T {
  return consumedEnvelope.run(envelope, fn);
}

/** The envelope being consumed in this async context, or undefined. */
export function currentConsumedEnvelope(): EventEnvelope | undefined {
  return consumedEnvelope.getStore();
}

// The transaction tenant always wins; a caller-supplied tenant is only used when no tenant transaction is open.
function envelopeTenant(explicit: string | undefined): string {
  const tx = currentTenantTx();
  if (tx === undefined) {
    if (explicit === undefined) {
      throw new EnvelopeTenantError('An envelope built outside a tenant transaction needs an explicit tenantId');
    }
    return assertTenantId(explicit);
  }
  if (explicit !== undefined && explicit.toLowerCase() !== tx.tenantId) {
    throw new EnvelopeTenantError(
      `Envelope tenantId ${JSON.stringify(explicit)} differs from the transaction tenant ${tx.tenantId}`,
    );
  }
  return tx.tenantId;
}

/**
 * Builds an envelope for `input.topic`.
 * Defaults: `correlationId` from the consumed envelope, else the request id, else the new `eventId`;
 * `causationId` is the consumed envelope's `eventId`, omitted outside a consume scope.
 */
export function buildEnvelope<P>(input: BuildEnvelopeInput<P>): EventEnvelope<P> {
  const { service } = parseTopic(input.topic);
  if (input.producer !== undefined && input.producer !== service) {
    throw new InvalidEventNameError(input.producer, `producer "${service}" of topic ${input.topic}`);
  }
  const tenantId = envelopeTenant(input.tenantId);
  const consumed = currentConsumedEnvelope();
  const eventId = input.eventId ?? uuidv4();
  const occurredAt =
    input.occurredAt instanceof Date ? input.occurredAt.toISOString() : (input.occurredAt ?? new Date().toISOString());
  const trace = input.trace ?? currentTraceparent();
  const correlationId =
    input.correlationId ?? consumed?.correlationId ?? currentRequestContext()?.requestId ?? eventId;
  const causationId = input.causationId ?? consumed?.eventId;

  return {
    eventId,
    eventType: eventTypeOf(input.topic),
    schemaVersion: schemaVersionOf(input.topic),
    tenantId,
    occurredAt,
    producer: service,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    traceparent: trace.traceparent,
    ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
    correlationId,
    ...(causationId !== undefined ? { causationId } : {}),
    payload: input.payload,
  };
}

/** Pub/Sub attributes of an envelope: the mirrored fields, with trace keys named by the tracing module. */
export function envelopeAttributes(envelope: EventEnvelope): Record<string, string> {
  return {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    schemaVersion: envelope.schemaVersion,
    tenantId: envelope.tenantId,
    aggregateVersion: String(envelope.aggregateVersion),
    ...pubsubAttributes({ traceparent: envelope.traceparent, tracestate: envelope.tracestate }),
  };
}

/** UTF-8 JSON message data of an envelope. */
export function encodeEnvelope(envelope: EventEnvelope): Buffer {
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

/** Parses message data as UTF-8 JSON; throws SyntaxError when it is not JSON. */
export function decodeEnvelopeData(data: Buffer | Uint8Array | string): unknown {
  const text = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return JSON.parse(text);
}
