import type { FastifyBaseLogger } from 'fastify';

/** Structural logger shape Fastify accepts as `loggerInstance`; kept local so this module never imports `./logger.js`. */
type LoggerLike = { child: (...args: never[]) => unknown } & Record<
  'info' | 'error' | 'debug' | 'fatal' | 'warn' | 'trace',
  (...args: never[]) => void
>;

/** pino serializers that drop the request and reply objects Fastify passes to its own log calls. */
export const fastifySerializers: Readonly<Record<'req' | 'res', (value: unknown) => undefined>> = {
  req: () => undefined,
  res: () => undefined,
};

/** Fastify server options that route Fastify's logging through the OPT-2 logger. */
export interface FastifyLoggerOptions {
  loggerInstance: FastifyBaseLogger;
  disableRequestLogging: true;
  requestIdLogLabel: 'requestId';
}

/** Builds the options service-kit spreads into `fastify({...})` for the given logger. */
export function fastifyLoggerOptions(logger: LoggerLike): FastifyLoggerOptions {
  return {
    loggerInstance: logger as FastifyBaseLogger,
    // Deprecated top-level keys in Fastify 5.12 (FSTDEP023/FSTDEP024), supported until Fastify 6. Kept over a
    // `logController`, which would need a runtime Fastify import in this type-only module.
    disableRequestLogging: true,
    requestIdLogLabel: 'requestId',
  };
}
