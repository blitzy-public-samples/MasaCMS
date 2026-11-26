/** `opt2-people` CLI stream capture, environment and staleness shared by the offline and PostgreSQL resolve-operation suites. */
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { RECOVERY_THRESHOLD_MS } from '../../src/domain/roster-recovery.js';

/** Just past the recovery threshold, so an operation this old is stale. */
export const STALE = RECOVERY_THRESHOLD_MS + 1;

/** Collects what `stream.write` receives while answering each write's callback. */
export function captureWrites(stream: NodeJS.WriteStream): string[] {
  const chunks: string[] = [];
  vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    const callback = rest.find((arg): arg is () => void => typeof arg === 'function');
    callback?.();
    return true;
  }) as typeof stream.write);
  return chunks;
}

/** A complete local people environment; `createPool`, the publisher, the service client and identity are replaced where it matters. */
export function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: '8112',
    OPT2_SERVICE_NAME: 'people',
    OPT2_ENV: 'local',
    TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2',
    PG_USER: 'people_app',
    PG_PASSWORD: 'REDACTED_TEST_PASSWORD',
    PUBSUB_EMULATOR_HOST: '127.0.0.1:8085',
    OPT2_SERVICE_URLS: JSON.stringify({ identity: 'http://127.0.0.1:8111' }),
    OPT2_STATE_DIR: tmpdir(),
    ...overrides,
  };
}
