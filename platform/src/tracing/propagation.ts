// W3C trace-context propagation for HTTP hops, event envelopes, Pub/Sub attributes and Cloud Tasks.
import { randomBytes } from 'node:crypto';
import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Context,
  type Span,
  type SpanKind,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { redactException } from './redact.js';

const TRACER_NAME = '@opt2/platform';
const TRACEPARENT = 'traceparent';
const TRACESTATE = 'tracestate';

// A dedicated W3C propagator keeps behaviour independent of the global propagator and never emits baggage or B3.
const w3c = new W3CTraceContextPropagator();

/** W3C trace context as carried by event envelopes and message attributes. */
export interface TraceCarrier {
  traceparent: string;
  tracestate?: string;
}

/** Inbound header carrier: Node/Fastify header records, plain records or Fetch/undici `Headers`. */
export type HeaderBag =
  | Record<string, string | string[] | number | undefined>
  | { get(name: string): string | null };

type HeadersLike = { get(name: string): string | null };

function isHeadersLike(carrier: HeaderBag): carrier is HeadersLike {
  return typeof (carrier as { get?: unknown }).get === 'function';
}

const getter: TextMapGetter<HeaderBag> = {
  keys(carrier) {
    return isHeadersLike(carrier) ? [] : Object.keys(carrier);
  },
  get(carrier, key) {
    if (isHeadersLike(carrier)) {
      return carrier.get(key) ?? undefined;
    }
    const lower = key.toLowerCase();
    const name = Object.keys(carrier).find((k) => k.toLowerCase() === lower && carrier[k] !== undefined);
    const value = name === undefined ? undefined : carrier[name];
    return typeof value === 'number' ? String(value) : value;
  },
};

const setter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

function injected(ctx: Context): TraceCarrier | undefined {
  const scratch: Record<string, string> = {};
  w3c.inject(ctx, scratch, setter);
  const traceparent = scratch[TRACEPARENT];
  if (traceparent === undefined) {
    return undefined;
  }
  const tracestate = scratch[TRACESTATE];
  return tracestate ? { traceparent, tracestate } : { traceparent };
}

/** Writes `traceparent`/`tracestate` for `ctx` into outbound `headers`, replacing any existing casing; returns `headers`. */
export function injectHttpHeaders<T extends Record<string, unknown>>(
  headers: T,
  ctx: Context = context.active(),
): T & { traceparent?: string; tracestate?: string } {
  const carrier = injected(ctx);
  if (carrier) {
    const target: Record<string, unknown> = headers;
    for (const name of Object.keys(target)) {
      const lower = name.toLowerCase();
      if (lower === TRACEPARENT || lower === TRACESTATE) {
        delete target[name];
      }
    }
    Object.assign(target, carrier);
  }
  return headers;
}

/** Returns `base` with the remote span context read from inbound `headers`, or `base` itself when none is valid. */
export function extractHttpContext(headers: HeaderBag, base: Context = context.active()): Context {
  return w3c.extract(base, headers, getter);
}

/** Trace context for a new event envelope; mints a fresh sampled root when no span is active. */
export function currentTraceparent(): TraceCarrier {
  return (
    injected(context.active()) ?? {
      traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
    }
  );
}

/** Active context with the remote parent from an envelope or message attributes; unchanged when `traceparent` is invalid. */
export function contextFromEnvelope(carrier: Partial<TraceCarrier>): Context {
  const record: Record<string, string> = {};
  if (carrier.traceparent !== undefined) {
    record[TRACEPARENT] = carrier.traceparent;
  }
  if (carrier.tracestate !== undefined) {
    record[TRACESTATE] = carrier.tracestate;
  }
  return w3c.extract(context.active(), record, getter);
}

/** Runs `fn` under the context extracted from `carrier`, so spans it starts join the producer's trace. */
export function withExtractedContext<T>(carrier: Partial<TraceCarrier>, fn: () => T): T {
  return context.with(contextFromEnvelope(carrier), fn);
}

/** Pub/Sub message attributes mirroring the carrier's `traceparent` and, when present, `tracestate`. */
export function pubsubAttributes(carrier: TraceCarrier = currentTraceparent()): Record<string, string> {
  const attributes: Record<string, string> = { [TRACEPARENT]: carrier.traceparent };
  if (carrier.tracestate) {
    attributes[TRACESTATE] = carrier.tracestate;
  }
  return attributes;
}

/** Trace headers for a Cloud Tasks HTTP request; `{}` when no span is active, so the handler starts its own trace. */
export function taskHeaders(ctx: Context = context.active()): Partial<TraceCarrier> {
  return injected(ctx) ?? {};
}

/** Ids and sampling flag of the active span, or `undefined` when no valid span is active. */
export function activeSpanIds(): { traceId: string; spanId: string; traceSampled: boolean } | undefined {
  const spanContext = trace.getSpanContext(context.active());
  if (!spanContext || !isSpanContextValid(spanContext)) {
    return undefined;
  }
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceSampled: (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0,
  };
}

/** Runs `fn` with `span`, records a redacted exception and error status on throw, and always ends the span. */
async function runInSpan<T>(span: Span, fn: (span: Span) => T | Promise<T>): Promise<T> {
  try {
    return await fn(span);
  } catch (err) {
    span.recordException(redactException(err));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

/** Runs `fn` inside a new active span, records an error status on throw, and always ends the span. */
export async function startSpan<T>(
  name: string,
  kind: SpanKind,
  fn: (span: Span) => T | Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(name, { kind, attributes }, (span: Span) => runInSpan(span, fn));
}

/** Like `startSpan`, but the span roots a new trace and links to the active span, so work scheduled inside starts its own trace. */
export async function startLinkedRootSpan<T>(
  name: string,
  kind: SpanKind,
  fn: (span: Span) => T | Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  const active = trace.getSpanContext(context.active());
  const links = active && isSpanContextValid(active) ? [{ context: active }] : [];
  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(name, { kind, attributes, root: true, links }, ROOT_CONTEXT, (span: Span) => runInSpan(span, fn));
}
