// Web request logging (log-record.v1) and request spans through the platform logger and tracing SDK (server-only).
import { createLogger, serializeError, type CreateLoggerOptions, type LogFields, type Logger } from '@opt2/platform/logging';
import {
  SpanKind,
  SpanStatusCode,
  activeSpanIds,
  startSpan,
  startTracing,
  withExtractedContext,
  type Span,
} from '@opt2/platform/tracing';
import { WEB_VERSION, claimRequestLine, currentRequestScope } from '../server/shared';
import { webEnv } from './env';
import type { StreamedCall } from './gateway-client';

export { WEB_VERSION };

/** Fields of the one log line written per web request. */
export type RequestLogFields = Required<Pick<LogFields, 'route' | 'httpMethod' | 'statusCode' | 'latencyMs' | 'requestId'>> &
  Pick<LogFields, 'userId' | 'tenantId'> & {
    /** Fixed reason of an expected refusal; the line is then `request denied: <reason>` at warning severity. */
    denial?: string;
    /** Value the handler threw; the line is then written at error severity. */
    error?: unknown;
  };

let logger: Logger | undefined;
let tracingStarted: Promise<void> | undefined;

/** Builds the web logger from the web environment, writing to stdout or `destination`. */
export function createWebLogger(destination?: CreateLoggerOptions['destination']): Logger {
  const env = webEnv();
  return createLogger({
    service: 'web',
    version: WEB_VERSION,
    env: env.OPT2_ENV,
    level: env.LOG_LEVEL,
    googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
    destination,
  });
}

/** The process-wide web logger, created on first use. */
export function webLogger(): Logger {
  logger ??= createWebLogger();
  return logger;
}

/** Installs `replacement` (`undefined` re-creates on next use) as the web logger; returns a restore function. */
export function setWebLoggerForTests(replacement: Logger | undefined): () => void {
  const previous = logger;
  logger = replacement;
  return () => {
    logger = previous;
  };
}

/** Marks the custom server's request scope as taken by the admin pipeline; a no-op outside the custom server. */
export function markPipelineRequest(): void {
  const scope = currentRequestScope();
  if (scope !== undefined) scope.pipeline = true;
}

/** Writes the request's unclaimed log line: `error` with the thrown error, else `warn` for a denial, else `info`. */
export function logRequest(fields: RequestLogFields): void {
  const { denial, error, ...requestFields } = fields;
  const scope = currentRequestScope();
  if (scope !== undefined && !claimRequestLine(scope)) return;
  if (error !== undefined) {
    webLogger().error({ ...requestFields, error: serializeError(error) }, 'request');
    return;
  }
  if (denial !== undefined) {
    webLogger().warn(requestFields, `request denied: ${denial}`);
    return;
  }
  webLogger().info(requestFields, 'request');
}

/** How a relayed stream ended before its last byte: its upstream failed, or its consumer cancelled it. */
export type TransferEnd = { readonly kind: 'failed'; readonly error: unknown } | { readonly kind: 'cancelled' };

/** Fields of a handed-over answer's transfer line; `latencyMs` runs to the end of the transfer. */
export type TransferLogFields = Omit<RequestLogFields, 'denial' | 'error'>;

/**
 * Writes the line of a handed-over answer whose streamed body ended early, naming the service call it relays:
 * `warn` `download failed` with the error when the upstream failed, else `info` `download abandoned`.
 */
export function logTransferEnd(fields: TransferLogFields, callee: StreamedCall | undefined, end: TransferEnd): void {
  const call = callee === undefined ? '' : `: ${callee.service} ${callee.operation}`;
  if (end.kind === 'failed') {
    webLogger().warn({ ...fields, error: serializeError(end.error) }, `download failed${call}`);
    return;
  }
  webLogger().info(fields, `download abandoned${call}`);
}

/** Starts the platform tracing SDK for web once per process; later calls await the same start. */
export async function ensureTracing(): Promise<void> {
  tracingStarted ??= startTracing({
    serviceName: 'web',
    version: WEB_VERSION,
    endpoint: webEnv().OTEL_EXPORTER_OTLP_ENDPOINT,
  });
  await tracingStarted;
}

/** Records the status a request was answered with on its span. */
export type RecordStatus = (statusCode: number) => void;

/**
 * Runs `fn` in the span `<METHOD> <route>`: a child of the active span (Next's, in a route handler), else a server span
 * under the inbound W3C trace context; `fn` records the answered status, a 5xx marking the span as an error.
 */
export function withRequestSpan<T>(
  method: string,
  route: string,
  headers: HeadersInit,
  fn: (recordStatus: RecordStatus) => Promise<T>,
): Promise<T> {
  const name = `${method} ${route}`;
  const attributes = { 'http.request.method': method, 'http.route': route };
  const run = (span: Span): Promise<T> =>
    fn((statusCode) => {
      span.setAttribute('http.response.status_code', statusCode);
      if (statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    });
  if (activeSpanIds() !== undefined) return startSpan(name, SpanKind.INTERNAL, run, attributes);
  const { traceparent, tracestate } = headersToRecord(headers);
  // Activating a Context from extractHttpContext needs @opentelemetry/api, which web never imports; withExtractedContext
  // performs the same W3C extraction and runs the span under it.
  return withExtractedContext({ traceparent, tracestate }, () => startSpan(name, SpanKind.SERVER, run, attributes));
}

/** Header names lower-cased with their values, repeated headers joined by `, ` as Fetch `Headers` joins them. */
export function headersToRecord(headers: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers));
}
