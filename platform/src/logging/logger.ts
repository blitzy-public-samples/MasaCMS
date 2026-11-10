import { isSpanContextValid, trace, TraceFlags } from '@opentelemetry/api';
import pino from 'pino';
import type {
  Bindings,
  ChildLoggerOptions,
  DestinationStream,
  LoggerOptions,
  Logger as PinoLogger,
} from 'pino';
import { getDiagnosticLogger, setDiagnosticLogger } from './diagnostics.js';
import { fastifySerializers } from './fastify.js';
import {
  BASE_FIELD_KEYS,
  LOG_FIELD_KEYS,
  TRACE_FIELD_KEYS,
  type LogEnv,
  type LogFields,
  type TraceFields,
} from './fields.js';
import { redactErrorText, redactText } from './redact.js';
import { serializeError } from './safe-error.js';
import { isValidLogField } from './validate.js';

export { serializeError } from './safe-error.js';

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
const TEXT_FIELD_KEYS: ReadonlySet<string> = new Set<string>(['tenantId', 'userId', 'requestId', 'eventId', 'route', 'httpMethod']);
/** A word character (Unicode letter or digit, or `_`) at the start, or at the end, of a text. */
const WORD_START = /^[\p{L}\p{N}_]/u;
const WORD_END = /[\p{L}\p{N}_]$/u;

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

/** Copies contract fields with `error` serialized and free-text values redacted, dropping values log-record.v1 rejects. */
function conformFields(fields: Record<string, unknown>): Record<string, unknown> {
  const conformed: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(fields)) {
    let value = raw;
    if (key === 'error') {
      value = serializeError(raw);
    } else if (typeof raw === 'string' && TEXT_FIELD_KEYS.has(key)) {
      value = redactText(raw);
    }
    if (isValidLogField(key, value)) {
      conformed[key] = value;
    }
  }
  return conformed;
}

/** Keeps only contract keys of a merged log object, taking Fastify's `err` as `error`. */
function logFields(object: Record<string, unknown>): Record<string, unknown> {
  const fields = pick(object, MERGE_KEYS);
  if (fields.error === undefined && object.err !== undefined) {
    fields.error = object.err;
  }
  return conformFields(fields);
}

function messageOf(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'
    ? value.message
    : undefined;
}

/** The error a merge argument logs, as `logFields` takes it: the argument itself, `error`, else `err`. */
function loggedError(object: object): unknown {
  if (object instanceof Error) {
    return object;
  }
  const { error, err } = object as { error?: unknown; err?: unknown };
  return error !== undefined ? error : err;
}

/** Message for a call without one: the logged error's safe message, otherwise empty. */
function defaultMessage(object: object): string {
  const logged = loggedError(object);
  return logged === undefined ? '' : serializeError(logged).message;
}

/** Serializer of the top-level message: coerces it to a string and masks credentials and PII. */
function logMessage(message: unknown): string {
  return redactText(String(message));
}

/** Raw text of a logged error value: an Error's or record's message, or a thrown string. */
function rawMessage(value: unknown): string | undefined {
  return typeof value === 'string' ? value : messageOf(value);
}

/** `text` with each occurrence of `raw` that is not part of a longer word replaced by `safe`; `raw` is non-empty. */
function replaceStandalone(text: string, raw: string, safe: string): string {
  const startsWord = WORD_START.test(raw);
  const endsWord = WORD_END.test(raw);
  let replaced = '';
  let copied = 0;
  let at = text.indexOf(raw);
  while (at >= 0) {
    const end = at + raw.length;
    // Two code units hold any code point, so each test sees the whole neighbouring character.
    const standalone =
      !(startsWord && WORD_END.test(text.slice(Math.max(0, at - 2), at))) &&
      !(endsWord && WORD_START.test(text.slice(end, end + 2)));
    if (standalone) {
      replaced += text.slice(copied, at) + safe;
      copied = end;
    }
    at = text.indexOf(raw, standalone ? end : at + 1);
  }
  return replaced + text.slice(copied);
}

/** Log call `args` with each later Error written as its safe message; beside a logged error, each later string has its raw message made safe where it stands alone and is masked as error text. */
function besideError<A extends unknown[]>(args: A): A {
  const [merge] = args;
  const { error, err } = (typeof merge === 'object' && merge !== null ? merge : {}) as { error?: unknown; err?: unknown };
  const logged = [merge instanceof Error ? merge : undefined, error, err].filter((value) => value !== undefined);
  const mask = (text: string): string =>
    redactErrorText(
      logged.reduce<string>((masked, value) => {
        const raw = rawMessage(value);
        return raw ? replaceStandalone(masked, raw, serializeError(value).message) : masked;
      }, text),
    );
  return args.map((arg, index) => {
    if (index === 0) return arg;
    if (arg instanceof Error) return serializeError(arg).message;
    return typeof arg === 'string' && logged.length > 0 ? mask(arg) : arg;
  }) as A;
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

/** Creates the process logger writing log-record.v1 JSON lines to stdout or `options.destination`; the first stdout logger also becomes the diagnostic logger. */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { service, version, env, googleCloudProject } = options;
  for (const [name, value] of Object.entries({ service, version, env })) {
    if (!isValidLogField(name, value)) {
      throw new TypeError(`createLogger: ${name} does not satisfy log-record.v1`);
    }
  }
  if (env === 'cloud') {
    if (!googleCloudProject) {
      throw new Error('createLogger: googleCloudProject is required when env is "cloud"');
    }
    // Any 32-hex trace id stands in for the per-line value.
    if (!isValidLogField('logging.googleapis.com/trace', `projects/${googleCloudProject}/traces/${'0'.repeat(32)}`)) {
      throw new TypeError('createLogger: googleCloudProject cannot form a log-record.v1 logging.googleapis.com/trace value');
    }
  }

  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    messageKey: 'message',
    errorKey: 'error',
    base: { service, version, env },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ severity: SEVERITY_BY_LEVEL[label as keyof typeof SEVERITY_BY_LEVEL] }),
      bindings: (bindings) => conformFields(pick(bindings, BINDING_KEYS)),
      log: logFields,
    },
    serializers: { error: serializeError, message: logMessage, ...fastifySerializers },
    mixin: traceMixin(env === 'cloud' ? googleCloudProject : undefined),
    hooks: {
      // A call without a message still gets one, because `message` is required on every line.
      logMethod(args, method) {
        const [first] = args;
        const masked = besideError(args);
        if (typeof first === 'object' && first !== null && args[1] === undefined) {
          method.apply(this, [first, defaultMessage(first), ...masked.slice(2)]);
          return;
        }
        if (first === undefined && args[1] === undefined) {
          method.apply(this, ['']);
          return;
        }
        method.apply(this, masked);
      },
    },
  };

  const logger = pino(pinoOptions, options.destination ?? pino.destination({ dest: 1, sync: false }));

  // pino 10 replaces `formatters.bindings` with an identity function on child loggers, so child bindings are
  // filtered here; children are created with Object.create(parent) and inherit this method. pino's custom-level
  // generics make its `child` type invariant, hence the double cast.
  const pinoChild: ChildFn = logger.child;
  const child: ChildFn = function (bindings, childOptions) {
    return pinoChild.call(this, conformFields(pick(bindings, BINDING_KEYS)), childOptions);
  };
  logger.child = child as unknown as PinoLogger<never>['child'];

  if (options.destination === undefined && getDiagnosticLogger() === undefined) {
    setDiagnosticLogger(logger);
  }
  return logger;
}
