// The custom server's process logger, and the routing of console calls and process warnings through it.
import { formatWithOptions, inspect, stripVTControlCharacters, type InspectOptions } from 'node:util';
import {
  SEVERITY_BY_LEVEL,
  createLogger,
  serializeError,
  type CreateLoggerOptions,
  type Logger,
} from '@opt2/platform/logging';
import { WEB_VERSION } from './shared.ts';

type LineLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: ReadonlySet<string> = new Set(Object.keys(SEVERITY_BY_LEVEL));

/** The web process logger: `cloud` only with a usable project, else `local`; at a valid `LOG_LEVEL`, else `info`. */
export function createProcessLogger(
  source: Readonly<Record<string, string | undefined>> = process.env,
  destination?: CreateLoggerOptions['destination'],
): Logger {
  const level = source.LOG_LEVEL !== undefined && LEVELS.has(source.LOG_LEVEL) ? source.LOG_LEVEL : 'info';
  const options = { service: 'web', version: WEB_VERSION, level, destination };
  if (source.OPT2_ENV === 'cloud') {
    try {
      return createLogger({ ...options, env: 'cloud', googleCloudProject: source.GOOGLE_CLOUD_PROJECT });
    } catch {
      // Written as local; boot then refuses the missing or unusable GOOGLE_CLOUD_PROJECT, naming it.
    }
  }
  return createLogger({ ...options, env: 'local' });
}

/** Writes one console call as one line: the first Error as `error`, the rest formatted without ANSI escapes. */
function writeLine(logger: Logger, level: LineLevel, args: readonly unknown[]): void {
  const error = args.find((arg): arg is Error => arg instanceof Error);
  const rest = args
    .filter((arg) => arg !== error)
    .map((arg) => (arg instanceof Error ? serializeError(arg).message : arg));
  const message = stripVTControlCharacters(formatWithOptions({ colors: false }, ...rest)).trim();
  if (error === undefined) {
    logger[level](message);
  } else if (message === '') {
    logger[level]({ error });
  } else {
    logger[level]({ error }, message);
  }
}

/** Replaces the output methods of `target` so each call writes one log-record.v1 line through `logger`. */
export function routeConsole(logger: Logger, target: Console = console): void {
  const route =
    (level: LineLevel) =>
    (...args: unknown[]): void => {
      writeLine(logger, level, args);
    };
  // count, group, table, time*, dirxml and assert print through log and warn, so they follow.
  target.debug = route('debug');
  target.trace = route('debug');
  target.log = route('info');
  target.info = route('info');
  target.warn = route('warn');
  target.error = route('error');
  target.dir = (item?: unknown, options?: InspectOptions): void => {
    logger.info(stripVTControlCharacters(inspect(item, { ...options, colors: false })));
  };
}

/** Writes each process warning as one WARNING line in place of Node's stderr printer. */
export function routeWarnings(logger: Logger, emitter: NodeJS.EventEmitter = process): void {
  emitter.removeAllListeners('warning');
  emitter.on('warning', (warning: Error & { code?: string }) => {
    logger.warn(`${warning.name}${warning.code === undefined ? '' : ` [${warning.code}]`}: ${warning.message}`);
  });
}

/** Resolves once `logger` has written out every buffered line. */
export function flushLogger(logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    logger.flush(() => resolve());
  });
}
