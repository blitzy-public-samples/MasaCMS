/** Public surface of `@opt2/platform/logging`: the log-record.v1 logger, its validator and Fastify helpers. */
export { createLogger, SEVERITY_BY_LEVEL, serializeError } from './logger.js';
export type { CreateLoggerOptions, LogFn, Logger } from './logger.js';
export { validateLogRecord } from './validate.js';
export type { LogRecordValidation } from './validate.js';
export { fastifyLoggerOptions, fastifySerializers } from './fastify.js';
export type { FastifyLoggerOptions } from './fastify.js';
export { LOG_FIELD_KEYS } from './fields.js';
export type { LogEnv, LogErrorRecord, LogFields } from './fields.js';
