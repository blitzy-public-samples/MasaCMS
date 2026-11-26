/** Deployment environment recorded on every log line. */
export type LogEnv = 'local' | 'cloud';

/** Serialized error written under the `error` key. */
export interface LogErrorRecord {
  type: string;
  message: string;
  stack?: string;
}

/** Contextual fields a caller may pass to a log call or bind on a child logger. */
export interface LogFields {
  /** Tenant UUID. */
  tenantId?: string;
  /** Masa `UserID`, a 35-character CF UUID. */
  userId?: string;
  requestId?: string;
  eventId?: string;
  route?: string;
  httpMethod?: string;
  statusCode?: number;
  latencyMs?: number;
  /** An `Error` is serialized to a `LogErrorRecord` by the logger. */
  error?: Error | LogErrorRecord;
}

/** Trace-correlation fields the logger derives from the active span. */
export interface TraceFields {
  traceId?: string;
  spanId?: string;
  traceSampled?: boolean;
  'logging.googleapis.com/trace'?: string;
  'logging.googleapis.com/spanId'?: string;
  'logging.googleapis.com/trace_sampled'?: boolean;
}

/** Resolves to `K` when it lists every key of `T`, otherwise to a type naming the missing keys. */
type KeyList<T, K extends readonly (keyof T)[]> = [Exclude<keyof T, K[number]>] extends [never]
  ? K
  : { missingKeys: Exclude<keyof T, K[number]> };

const logFieldKeys = [
  'tenantId',
  'userId',
  'requestId',
  'eventId',
  'route',
  'httpMethod',
  'statusCode',
  'latencyMs',
  'error',
] as const;

const traceFieldKeys = [
  'traceId',
  'spanId',
  'traceSampled',
  'logging.googleapis.com/trace',
  'logging.googleapis.com/spanId',
  'logging.googleapis.com/trace_sampled',
] as const;

/** Every `LogFields` key; the allowlist for merge objects and child bindings. */
export const LOG_FIELD_KEYS: KeyList<LogFields, typeof logFieldKeys> = logFieldKeys;

/** Every `TraceFields` key; the allowlist for span-derived fields. */
export const TRACE_FIELD_KEYS: KeyList<TraceFields, typeof traceFieldKeys> = traceFieldKeys;

/** Keys of the per-process base binding. */
export const BASE_FIELD_KEYS = ['service', 'version', 'env'] as const;
