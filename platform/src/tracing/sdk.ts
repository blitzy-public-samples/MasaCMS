import { context, createContextKey, diag, propagation, ProxyTracerProvider, trace, type Span } from '@opentelemetry/api';
import { diagLogLevelFromString, ExportResultCode, getStringFromEnv, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { platformDiagLogger } from './diag.js';
import { RedactingSpanExporter } from './redact.js';

/** Span exporter accepted by the SDK. */
export type SpanExporter = NodeSDKConfiguration['traceExporter'];

/** Finished span as handed to an exporter. */
export type ReadableSpan = Parameters<SpanExporter['export']>[0][number];

/** Options for {@link startTracing}. */
export interface StartTracingOptions {
  serviceName: string;
  version: string;
  /** OTLP/HTTP base URL; defaults to `OTEL_EXPORTER_OTLP_ENDPOINT`, then `http://localhost:4318`. */
  endpoint?: string;
  /** Replaces the OTLP exporter, for example with a {@link MemorySpanExporter} in tests; it receives redacted spans. */
  exporter?: SpanExporter;
}

/** In-memory exporter that keeps its spans across shutdown, for tests. */
export class MemorySpanExporter implements SpanExporter {
  private spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.spans.push(...spans);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /** Returns a copy of every span exported so far. */
  getFinishedSpans(): ReadableSpan[] {
    return [...this.spans];
  }

  /** Discards the stored spans. */
  reset(): void {
    this.spans = [];
  }
}

const CALLEE = createContextKey('opt2.tracing.callee');

/** Runs `fn` so that the undici client spans it starts are named `<METHOD> <service>`. */
export function withCallee<T>(service: string, fn: () => T): T {
  return context.with(context.active().setValue(CALLEE, service), fn);
}

/** Undici request hook: names the client span after the active callee, when one is set. */
function nameAfterCallee(span: Span, request: { method: string }): void {
  const callee = context.active().getValue(CALLEE);
  if (typeof callee === 'string') span.updateName(`${request.method} ${callee}`);
}

let state: { sdk: NodeSDK; instrumentations: { disable(): void }[]; diagInstalled: boolean } | undefined;
// Reused across restarts: a module already loaded is re-patched only by the instance whose require hook saw it load.
let instrumentationSet: [HttpInstrumentation, UndiciInstrumentation, PgInstrumentation] | undefined;

/**
 * Starts the process-wide tracing SDK; later calls are no-ops until {@link shutdownTracing}.
 * Call it first in `main.ts`, then dynamically import the app: fastify and pg are CommonJS and are
 * patched through require hooks when loaded afterwards, and undici is traced through
 * `diagnostics_channel`, so no ESM loader hook is needed.
 */
export async function startTracing(options: StartTracingOptions): Promise<void> {
  if (state) return;
  // An empty OTEL_EXPORTER_OTLP_ENDPOINT counts as unset, as the OTel exporters themselves treat it.
  const base = (options.endpoint ?? getStringFromEnv('OTEL_EXPORTER_OTLP_ENDPOINT') ?? 'http://localhost:4318').replace(
    /\/+$/,
    '',
  );
  instrumentationSet ??= [
    new HttpInstrumentation(),
    new UndiciInstrumentation({ requestHook: nameAfterCallee }),
    new PgInstrumentation(),
  ];
  const instrumentations = instrumentationSet;
  for (const instrumentation of instrumentations) instrumentation.enable();
  const diagLevel = getStringFromEnv('OTEL_LOG_LEVEL');
  // Withheld while NodeSDK is built: for OTEL_LOG_LEVEL it installs a console diag logger, whose lines are not log-record.v1.
  const rawDiagLevel = process.env.OTEL_LOG_LEVEL;
  delete process.env.OTEL_LOG_LEVEL;
  let sdk: NodeSDK;
  try {
    sdk = new NodeSDK({
      resource: defaultResource().merge(
        resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName, [ATTR_SERVICE_VERSION]: options.version }),
      ),
      autoDetectResources: false,
      textMapPropagator: new W3CTraceContextPropagator(),
      traceExporter: new RedactingSpanExporter(options.exporter ?? new OTLPTraceExporter({ url: `${base}/v1/traces` })),
      metricReaders: [],
      logRecordProcessors: [],
      instrumentations,
    });
  } finally {
    if (rawDiagLevel !== undefined) process.env.OTEL_LOG_LEVEL = rawDiagLevel;
  }
  const diagInstalled =
    diagLevel !== undefined &&
    diag.setLogger(platformDiagLogger, { logLevel: diagLogLevelFromString(diagLevel), suppressOverrideMessage: true });
  sdk.start();
  state = { sdk, instrumentations, diagInstalled };
}

/** Exports every span the batch processor still holds; a no-op before {@link startTracing}. */
export async function flushTracing(): Promise<void> {
  const global = trace.getTracerProvider();
  const provider: object = global instanceof ProxyTracerProvider ? global.getDelegate() : global;
  if ('forceFlush' in provider && typeof provider.forceFlush === 'function') {
    await (provider as { forceFlush(): Promise<void> }).forceFlush();
  }
}

/** Flushes and stops the SDK, then unpatches and unregisters everything so tracing can start again. */
export async function shutdownTracing(): Promise<void> {
  if (!state) return;
  const { sdk, instrumentations, diagInstalled } = state;
  state = undefined;
  try {
    await sdk.shutdown();
  } finally {
    // A failed final export must not leave the instrumentations patched or the globals registered.
    for (const instrumentation of instrumentations) instrumentation.disable();
    trace.disable();
    context.disable();
    propagation.disable();
    if (diagInstalled) diag.disable();
  }
}
