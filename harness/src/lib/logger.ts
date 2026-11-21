import { readFileSync } from 'node:fs';
import { createLogger, type Logger } from '@opt2/platform/logging';
import { repoPath, type EnvLike } from './paths.js';

let harnessVersion: string | undefined;

/** Version of @opt2/harness, read once from harness/package.json. */
function version(): string {
  const manifest = (): { version: string } => JSON.parse(readFileSync(repoPath('harness', 'package.json'), 'utf8'));
  harnessVersion ??= manifest().version;
  return harnessVersion;
}

/** log-record.v1 logger of harness command `service` on stderr, which leaves stdout to the summary line. */
export function createHarnessLogger(service: string, env: EnvLike = process.env): Logger {
  return createLogger({
    service,
    version: version(),
    env: env.OPT2_ENV === 'cloud' ? 'cloud' : 'local',
    googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
    destination: process.stderr,
  });
}
