import type { DestinationStream } from 'pino';
import { createLogger, type Logger } from './logger.js';
import { serializeError } from './safe-error.js';

/** The failing process and where its start-up line goes. */
export interface StartupFailureOptions {
  service: string;
  version: string;
  /** Variables `env` and the Cloud Logging project are read from; defaults to process.env. */
  source?: NodeJS.ProcessEnv;
  /** Output stream; defaults to stdout. */
  destination?: DestinationStream;
}

/** Logger at the default level: `cloud` when the source selects it with a usable project, otherwise `local`. */
function startupLogger(options: StartupFailureOptions): Logger {
  const { service, version, source = process.env, destination } = options;
  if (source.OPT2_ENV === 'cloud') {
    try {
      return createLogger({ service, version, env: 'cloud', googleCloudProject: source.GOOGLE_CLOUD_PROJECT, destination });
    } catch {
      // The line is still written, as local; loadEnv rejects a missing GOOGLE_CLOUD_PROJECT with an error naming it.
    }
  }
  return createLogger({ service, version, env: 'local', destination });
}

/** Writes `err` as one safe log-record.v1 ERROR line, `start-up failed`, and resolves once the destination has flushed it. */
export async function logStartupFailure(err: unknown, options: StartupFailureOptions): Promise<void> {
  const logger = startupLogger(options);
  logger.error({ error: serializeError(err) }, 'start-up failed');
  await new Promise<void>((resolve) => {
    logger.flush(() => resolve());
  });
}
