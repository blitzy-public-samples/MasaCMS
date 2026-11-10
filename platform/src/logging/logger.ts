import { isSpanContextValid, trace, TraceFlags } from '@opentelemetry/api';
import pino from 'pino';
import type {
  Bindings,
  ChildLoggerOptions,
  DestinationStream,
  LoggerOptions,
  Logger as PinoLogger,
} from 'pino';
import { fastifySerializers } from './fastify.js';
import {
  BASE_FIELD_KEYS,
  LOG_FIELD_KEYS,
  TRACE_FIELD_KEYS,
  type LogEnv,
  type LogErrorRecord,
  type LogFields,
  type TraceFields,
} from './fields.js';

/** Cloud Logging severity written for each pino level. */
export const SEVERITY_BY_LEVEL = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
} as const;

/** One log method: contract fields, an error or a message, with optional `util.format` arguments. */
export interface LogFn {
  (fields: LogFields, message?: string, ...args: unknown[]): void;
  (error: Error, message?: string, ...args: unknown[]): void;
  (message: string, ...args: unknown[]): void;
}

/** Structured logger whose every line is a log-record.v1 record. */
export interface Logger {
  level: string;
  fatal: LogFn;
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
  trace: LogFn;
  /** Returns a logger that writes `bindings` on every line. */
  child(bindings: LogFields): Logger;
  isLevelEnabled(level: string): boolean;
  /** Writes out lines still buffered by the asynchronous destination. */
  flush(cb?: (err?: Error) => void): void;
}

export interface CreateLoggerOptions {
  service: string;
  version: string;
  env: LogEnv;
  /** Minimum level; defaults to `info`. */
  level?: string;
  /** Project of the Cloud Logging trace key; required when `env` is `cloud`. */
  googleCloudProject?: string;
  /** Output stream; defaults to asynchronous stdout. */
  destination?: DestinationStream;
}

type ChildFn = (
  this: PinoLogger<never>,
  bindings: Bindings,
  options?: ChildLoggerOptions<never>,
) => PinoLogger<never>;

const MERGE_KEYS: ReadonlySet<string> = new Set<string>([...LOG_FIELD_KEYS, ...TRACE_FIELD_KEYS]);
const BINDING_KEYS: ReadonlySet<string> = new Set<string>([...BASE_FIELD_KEYS, ...LOG_FIELD_KEYS]);

/** Copies the own keys of `source` that are in `keys` and not `undefined`. */
function pick(source: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (keys.has(key) && source[key] !== undefined) {
      picked[key] = source[key];
    }
  }
  return picked;
}

/** Keeps only contract keys of a merged log object, taking Fastify's `err` as `error`. */
function logFields(object: Record<string, unknown>): Record<string, unknown> {
  const fields = pick(object, MERGE_KEYS);
  if (fields.error === undefined && object.err !== undefined) {
    fields.error = object.err;
  }
  return fields;
}

function messageOf(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'
    ? value.message
    : undefined;
}

function errorRecord(type: string, message: string, stack: unknown): LogErrorRecord {
  return typeof stack === 'string' ? { type, message, stack } : { type, message };
}

/** Serializes any logged error value to exactly `{ type, message, stack? }`. */
export function serializeError(value: unknown): LogErrorRecord {
  if (value instanceof Error) {
    const type = value.name !== 'Error' ? value.name : (value.constructor?.name ?? 'Error');
    return errorRecord(type, value.message, value.stack);
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  ) {
    return errorRecord(value.type, value.message, 'stack' in value ? value.stack : undefined);
  }
  return { type: typeof value, message: String(value) };
}

/** Message for a call without one: the logged error's message, otherwise empty. */
function defaultMessage(object: object): string {
  if (object instanceof Error) {
    return object.message;
  }
  const { error, err } = object as { error?: unknown; err?: unknown };
  return messageOf(error ?? err) ?? '';
}

/** Builds the mixin that adds the active span's trace fields; `cloudProject` adds the Cloud Logging keys. */
function traceMixin(cloudProject: string | undefined): () => TraceFields {
  return () => {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext === undefined || !isSpanContextValid(spanContext)) {
      return {};
    }
    const { traceId, spanId } = spanContext;
    const traceSampled = (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
    if (cloudProject === undefined) {
      return { traceId, spanId, traceSampled };
    }
    return {
      traceId,
      spanId,
      traceSampled,
      'logging.googleapis.com/trace': `projects/${cloudProject}/traces/${traceId}`,
      'logging.googleapis.com/spanId': spanId,
      'logging.googleapis.com/trace_sampled': traceSampled,
    };
  };
}

/** Creates the process logger writing log-record.v1 JSON lines to stdout or `options.destination`. */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { service, version, env, googleCloudProject } = options;
  if (env === 'cloud' && !googleCloudProject) {
    throw new Error('createLogger: googleCloudProject is required when env is "cloud"');
  }

  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    messageKey: 'message',
    errorKey: 'error',
    base: { service, version, env },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ severity: SEVERITY_BY_LEVEL[label as keyof typeof SEVERITY_BY_LEVEL] }),
      bindings: (bindings) => pick(bindings, BINDING_KEYS),
      log: logFields,
    },
    serializers: { error: serializeError, ...fastifySerializers },
    mixin: traceMixin(env === 'cloud' ? googleCloudProject : undefined),
    hooks: {
      // An object logged without a message still gets one, because `message` is required on every line.
      logMethod(args, method) {
        const [first] = args;
        if (typeof first === 'object' && first !== null && args[1] === undefined) {
          method.apply(this, [first, defaultMessage(first), ...args.slice(2)]);
          return;
        }
        method.apply(this, args);
      },
    },
  };

  const logger = pino(pinoOptions, options.destination ?? pino.destination({ dest: 1, sync: false }));

  // pino 10 replaces `formatters.bindings` with an identity function on child loggers, so child bindings are
  // filtered here; children are created with Object.create(parent) and inherit this method. pino's custom-level
  // generics make its `child` type invariant, hence the double cast.
  const pinoChild: ChildFn = logger.child;
  const child: ChildFn = function (bindings, childOptions) {
    return pinoChild.call(this, pick(bindings, BINDING_KEYS), childOptions);
  };
  logger.child = child as unknown as PinoLogger<never>['child'];

  return logger;
}
