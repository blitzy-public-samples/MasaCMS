import { readFileSync } from 'node:fs';
import type { DestinationStream } from 'pino';
import { setDiagnosticLogger } from './diagnostics.js';
import type { Logger } from './logger.js';
import { serializeError } from './safe-error.js';
import { startupLogger } from './startup.js';

/** Fixed problem text of each node:util parseArgs failure, by its error code. */
const PARSE_ARGS_PROBLEMS: ReadonlyMap<string, string> = new Map([
  ['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'unknown option'],
  ['ERR_PARSE_ARGS_INVALID_OPTION_VALUE', 'an option is missing its value or was given one it does not take'],
  ['ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', 'unexpected argument'],
]);

/** Settings of one command-line run's diagnostics. */
export interface CliDiagnosticsOptions {
  /** Command name that starts every message, e.g. `opt2-auth`. */
  cli: string;
  /** Usage line that ends every usage problem. */
  usage: string;
  /** log-record.v1 `service`; defaults to `cli`. */
  service?: string;
  /** log-record.v1 `version`; defaults to the @opt2/platform version. */
  version?: string;
  /** Unvalidated variables `env` and the Cloud Logging project are read from; defaults to process.env. */
  source?: NodeJS.ProcessEnv;
  /** Output stream; defaults to stderr. */
  destination?: DestinationStream;
}

/** Diagnostics of one command-line run: log-record.v1 lines with fixed messages and safe error records. */
export interface CliDiagnostics {
  /** The run's logger, also registered as the process diagnostic logger. */
  readonly logger: Logger;
  /** Writes `<cli>: <problem>; <usage>` as one ERROR line; `problem` names options, never the values given. */
  usage(problem: string): void;
  /** Writes `<cli>: <problem>` as one ERROR line, with `err` as its safe record when given. */
  error(problem: string, err?: unknown): void;
  /** Writes `<cli>: <problem>` as one CRITICAL line with `err` as its safe record. */
  fatal(problem: string, err: unknown): void;
  /** Resolves once every line written so far has left the process. */
  flush(): Promise<void>;
}

/** Writes each line to process.stderr; flush waits until stderr has handed off what it still buffers. */
const stderrDestination: DestinationStream & { flush(cb: () => void): void } = {
  write(line) {
    process.stderr.write(line);
  },
  flush(cb) {
    // A pipe buffers what the kernel did not take at once; an empty write calls back after everything queued before it.
    if (process.stderr.writableLength === 0) cb();
    else process.stderr.write('', () => cb());
  },
};

/** Fixed problem text of a node:util parseArgs failure, chosen by its code, so no rejected argument is quoted. */
export function parseArgsProblem(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return (typeof code === 'string' ? PARSE_ARGS_PROBLEMS.get(code) : undefined) ?? 'invalid arguments';
}

let platformVersionText: string | undefined;

/** Version of @opt2/platform, read once from its package.json beside `src` and `dist`. */
function platformVersion(): string {
  platformVersionText ??= (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  return platformVersionText;
}

/** Opens a run's diagnostics ahead of argument and environment parsing; `env` is `cloud` only when the source selects it with a usable project. */
export function createCliDiagnostics(options: CliDiagnosticsOptions): CliDiagnostics {
  const { cli, usage, service = cli, source, destination = stderrDestination } = options;
  // Synchronous, so a CLI's main runs up to its own first await before it yields.
  const version = options.version ?? platformVersion();
  const logger = startupLogger({ service, version, source, destination });
  setDiagnosticLogger(logger);
  return {
    logger,
    usage: (problem) => logger.error(`${cli}: ${problem}; ${usage}`),
    error: (problem, err) => {
      if (err === undefined) logger.error(`${cli}: ${problem}`);
      else logger.error({ error: serializeError(err) }, `${cli}: ${problem}`);
    },
    fatal: (problem, err) => logger.fatal({ error: serializeError(err) }, `${cli}: ${problem}`),
    flush: () => new Promise<void>((resolve) => logger.flush(() => resolve())),
  };
}
