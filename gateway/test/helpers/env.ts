// The one gateway test environment: fixed clock and keys, the suite's state directory and the parsed local env.
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_TOKEN, localSecretPath } from '@opt2/platform/auth';
import { loadEnv } from '@opt2/platform/service-kit';
import { businessClock, writeTestSecrets, type Clock } from '@opt2/platform/testing';
import { SERVICE_NAME, gatewayEnvSchema, type GatewayEnv } from '../../src/app.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';

/** Every callee a test gateway's service map names, by package folder name. */
export const TEST_SERVICE_NAMES = [
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
  'web',
  'stub',
  'migration',
] as const;

/** One callee of {@link TEST_SERVICE_NAMES}. */
export type TestServiceName = (typeof TEST_SERVICE_NAMES)[number];

/** Clock every gateway suite shares: local `2026-06-30T12:00:00`, the seed's business date. */
export const TEST_CLOCK: Clock = businessClock();

/** Bridge HMAC key of tests: the gateway's `OPT2_BRIDGE_HMAC_KEY` and the legacy double's verification key; not a secret. */
export const TEST_BRIDGE_KEY = 'opt2-gateway-test-bridge-hmac-key-000000';

/** Storage HMAC key of tests, written to `secrets/storage-hmac-key`; not a secret. */
export const TEST_STORAGE_HMAC_KEY = 'opt2-gateway-test-storage-hmac-key-00000';

/** Instance id the gateway under test heartbeats as. */
export const TEST_INSTANCE_ID = 'gateway-test-1';

/** Time zone of the test env, as up.sh exports the legacy server's. */
export const TEST_TZ = 'UTC';

/** URL of any upstream a suite did not start: the loopback discard port, which refuses connections. */
export const UNREACHABLE_URL = 'http://127.0.0.1:9';

/** The gateway's local port, as `harness/repro/ports.env` fixes it. */
const GATEWAY_PORT = '8100';

/** File name the platform's local storage adapter reads its HMAC key from, under `secrets/`. */
const STORAGE_HMAC_KEY_FILE = 'storage-hmac-key';

let stateDir: string | undefined;
const preparedStateDirs = new Map<string, Promise<string>>();

/** Removes `dir` when the process exits or is ended by SIGTERM or SIGINT. */
function removeAtExit(dir: string): void {
  const remove = (): void => rmSync(dir, { recursive: true, force: true });
  process.once('exit', remove);
  // Vitest's fork pool ends each worker with SIGTERM, which skips 'exit'; the signal is re-raised once the directory is gone.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      remove();
      process.kill(process.pid, signal);
    });
  }
}

/** The suite's state directory under `os.tmpdir()`, created on first use and removed when the process ends. */
export function testStateDir(): string {
  if (stateDir === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), 'opt2-gateway-test-'));
    removeAtExit(dir);
    stateDir = dir;
  }
  return stateDir;
}

/** Writes the platform test secrets, then the storage HMAC key unless present. */
async function writeStateDirSecrets(dir: string): Promise<string> {
  await writeTestSecrets(dir);
  try {
    await writeFile(localSecretPath(dir, STORAGE_HMAC_KEY_FILE), TEST_STORAGE_HMAC_KEY, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return dir;
}

/** Writes the local secrets the gateway reads into `dir`, once per directory; resolves to `dir`. */
export async function prepareTestStateDir(dir: string = testStateDir()): Promise<string> {
  let prepared = preparedStateDirs.get(dir);
  if (prepared === undefined) {
    prepared = writeStateDirSecrets(dir);
    preparedStateDirs.set(dir, prepared);
  }
  return prepared;
}

/** Every service of {@link TEST_SERVICE_NAMES} mapped to its URL in `urls`, else {@link UNREACHABLE_URL}. */
export function serviceUrlMap(urls: Partial<Record<TestServiceName, string>> = {}): Record<TestServiceName, string> {
  return Object.fromEntries(TEST_SERVICE_NAMES.map((name) => [name, urls[name] ?? UNREACHABLE_URL])) as Record<
    TestServiceName,
    string
  >;
}

/** Variable overrides of {@link testEnv}; `serviceUrls` names the doubles a suite started. */
export interface TestEnvOverrides {
  serviceUrls?: Partial<Record<TestServiceName, string>>;
  // A string-only index signature would reject `serviceUrls`, so it admits the map too; testEnv refuses it on any other key.
  [variable: string]: string | Partial<Record<TestServiceName, string>> | undefined;
}

/**
 * The parsed local gateway env, built from literals only and parsed as production parses it. Each override replaces its
 * default verbatim and `undefined` removes the variable; the `PG_*` values are never connected to, since suites inject the database.
 */
export function testEnv(overrides: TestEnvOverrides = {}): GatewayEnv {
  const { serviceUrls, ...variables } = overrides;
  const urls = serviceUrlMap(serviceUrls);
  const source: Record<string, string | undefined> = {
    PORT: GATEWAY_PORT,
    OPT2_SERVICE_NAME: SERVICE_NAME,
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2_test',
    PG_USER: 'gateway_app',
    PG_PASSWORD: 'unused',
    GOOGLE_CLOUD_PROJECT: 'opt2-test',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_JWKS_URL: `${urls.identity}/.well-known/jwks.json`,
    OPT2_GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
    OPT2_MIGRATION_URL: urls.migration,
    OPT2_SERVICE_URLS: JSON.stringify(urls),
    OPT2_STATE_DIR: 'OPT2_STATE_DIR' in variables ? undefined : testStateDir(),
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    TZ: TEST_TZ,
    // An empty env, so the committed cut-over directory is used whatever the developer shell sets.
    OPT2_CUTOVER_DIR: resolveGatewayPaths({}).cutoverDir,
    OPT2_BRIDGE_HMAC_KEY: TEST_BRIDGE_KEY,
    LEGACY_ORIGIN: UNREACHABLE_URL,
  };
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`testEnv: override ${name} must be a string`);
    source[name] = value;
  }
  return loadEnv(gatewayEnvSchema, source);
}
