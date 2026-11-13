// Web request logging (log-record.v1) and server spans through the platform logger and tracing SDK (server-only).
import { createLogger, serializeError, type CreateLoggerOptions, type LogFields, type Logger } from '@opt2/platform/logging';
import { SpanKind, startSpan, startTracing, withExtractedContext } from '@opt2/platform/tracing';
import { webEnv } from './env';

/** Version written on every web log line and span resource; matches `web/package.json`. */
export const WEB_VERSION = '1.0.0';

/** Fields of the one log line written per web request. */
export type RequestLogFields = Required<Pick<LogFields, 'route' | 'httpMethod' | 'statusCode' | 'latencyMs' | 'requestId'>> &
  Pick<LogFields, 'userId' | 'tenantId'> & {
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

/** Writes the request's log line: `info`, or `error` with the serialized error when the handler threw. */
export function logRequest(fields: RequestLogFields): void {
  const { error, ...requestFields } = fields;
  if (error === undefined) {
    webLogger().info(requestFields, 'request');
    return;
  }
  webLogger().error({ ...requestFields, error: serializeError(error) }, 'request');
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

/** Runs `fn` in a server span named `name` (`<METHOD> <route>`), parented to the inbound W3C trace context. */
export function withRequestSpan<T>(name: string, headers: HeadersInit, fn: () => Promise<T>): Promise<T> {
  const { traceparent, tracestate } = headersToRecord(headers);
  // Activating a Context from extractHttpContext needs @opentelemetry/api, which web never imports; withExtractedContext
  // performs the same W3C extraction and runs the span under it.
  return withExtractedContext({ traceparent, tracestate }, () => startSpan(name, SpanKind.SERVER, fn));
}

/** Header names lower-cased with their values, repeated headers joined by `, ` as Fetch `Headers` joins them. */
export function headersToRecord(headers: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers));
}
