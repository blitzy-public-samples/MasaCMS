import type { DiagLogger } from '@opentelemetry/api';
// Not logger.ts or the logging barrel: they load Fastify, which must load after tracing starts. diagnostics.ts imports logger.ts for types only.
import { getDiagnosticLogger } from '../logging/diagnostics.js';
import { serializeError } from '../logging/safe-error.js';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** Writes one OTel diagnostic as a line of the process diagnostic logger: primitive values as the message, the first Error as `error`, other objects omitted. */
function write(level: Level, values: unknown[]): void {
  const logger = getDiagnosticLogger();
  if (logger === undefined) return;
  try {
    const message = values.filter(isPrimitive).join(' ');
    const err = values.find((value) => value instanceof Error);
    if (err === undefined) {
      logger[level](message);
    } else {
      logger[level]({ error: serializeError(err) }, message);
    }
  } catch {
    // The record is dropped: OTel components call diag inline, so a failing sink must not fail them.
  }
}

/** OTel diag logger writing log-record.v1 lines through the registered diagnostic logger; records are dropped while none is registered. */
export const platformDiagLogger: DiagLogger = {
  error: (message, ...args) => write('error', [message, ...args]),
  warn: (message, ...args) => write('warn', [message, ...args]),
  info: (message, ...args) => write('info', [message, ...args]),
  debug: (message, ...args) => write('debug', [message, ...args]),
  verbose: (message, ...args) => write('trace', [message, ...args]),
};
