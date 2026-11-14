/** Public surface of `@opt2/platform/logging`: the log-record.v1 logger, its validator, diagnostics, the start-up failure line, text redaction, the safe-error-text key and Fastify helpers. */
export { createLogger, SEVERITY_BY_LEVEL, serializeError } from './logger.js';
export { emitDiagnostic, setDiagnosticLogger } from './diagnostics.js';
export type { CreateLoggerOptions, LogFn, Logger } from './logger.js';
export { logStartupFailure } from './startup.js';
export type { StartupFailureOptions } from './startup.js';
export { validateLogRecord } from './validate.js';
export type { LogRecordValidation } from './validate.js';
export { fastifyLoggerOptions, fastifySerializers } from './fastify.js';
export type { FastifyLoggerOptions } from './fastify.js';
export { LOG_FIELD_KEYS } from './fields.js';
export type { LogEnv, LogErrorRecord, LogFields } from './fields.js';
export { REDACTED, redactErrorText, redactText } from './redact.js';
export { SAFE_ERROR_TEXT } from './safe-error.js';
