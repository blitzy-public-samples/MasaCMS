// Web start-up: validates the configuration, builds the auth runtime and starts tracing before the process serves
// (server-only).
import { logStartupFailure, type StartupFailureOptions } from '@opt2/platform/logging';
import { WEB_VERSION, signalBooted } from '../server/shared';
import { webAuthRuntime } from './auth';
import { legacySettings, webEnv } from './env';
import { ensureTracing } from './telemetry';

/** Where a failed start-up goes; both default to the process's own. */
export interface BootOptions {
  readonly exit?: (code: number) => void;
  readonly destination?: StartupFailureOptions['destination'];
}

/** Validates the environment and Masa settings, builds the auth runtime and starts tracing; a failure exits 1. */
export async function bootWeb({ exit = (code) => process.exit(code), destination }: BootOptions = {}): Promise<void> {
  try {
    webEnv();
    legacySettings();
    await webAuthRuntime();
    await ensureTracing();
  } catch (error) {
    await logStartupFailure(error, { service: 'web', version: WEB_VERSION, destination });
    exit(1);
    return;
  }
  signalBooted();
}
