// Public surface of @opt2/platform/tracing; importing it never starts the SDK.
export * from './sdk.js';
export * from './propagation.js';
export * from './continuity.js';
export { SpanKind, SpanStatusCode } from '@opentelemetry/api';
export type { Attributes, Context, Span } from '@opentelemetry/api';
