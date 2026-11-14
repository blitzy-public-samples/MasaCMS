// The one migration test environment: fixed bridge key and pinned SHA, temp directories outside the checkout, the parsed local env and controllable time.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import type { Clock } from '@opt2/platform/service-kit';
import { businessClock, writeTestSecrets } from '@opt2/platform/testing';
import { loadMigrationEnv, type MigrationEnv } from '../../src/env.js';
import { repoPath } from '../../src/paths.js';

/** Bridge HMAC key of tests: the env's `OPT2_BRIDGE_HMAC_KEY` and the bridge double's verification key; not a secret. */
export const TEST_BRIDGE_KEY = 'opt2-test-bridge-hmac-key-0000000000000000';

const SOURCE_SHA = /^[0-9a-f]{40}$/;

function readPinnedSha(): string {
  const file = repoPath('opt2/source-pin.json');
  const pin = JSON.parse(readFileSync(file, 'utf8')) as { sha?: unknown };
  if (typeof pin.sha !== 'string' || !SOURCE_SHA.test(pin.sha)) {
    throw new Error(`${file} has no 40-character lowercase hex "sha" field`);
  }
  return pin.sha;
}

/** The pinned source SHA, read from `opt2/source-pin.json`. */
export const TEST_SOURCE_SHA: string = readPinnedSha();

/** URL of any callee a suite did not start: a closed loopback port, so a stray call fails fast. */
const UNREACHABLE_URL = 'http://127.0.0.1:1';

/** `MURA_DBPASSWORD` placeholder, never sent to a server; joined so gitleaks' generic-api-key rule does not read it as a credential. */
const PLACEHOLDER_DB_PASSWORD = ['opt2', 'test', 'placeholder'].join('-');

/** The migration service's local port, as `harness/repro/ports.env` fixes it. */
const MIGRATION_PORT = '8102';

/** Every callee the test env's service map names, by package folder name. */
const SERVICE_NAMES = [
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
  'stub',
  'gateway',
  'migration',
] as const;

/** Temporary directories of one suite or context, under one root outside the checkout. */
export interface TestDirs {
  stateDir: string;
  reportsDir: string;
  pristineDir: string;
  /** Removes the root and everything under it. */
  cleanup(): Promise<void>;
}

/** Creates a temp root holding `state/` (with the platform test secrets), `reports/` and `pristine/`. */
export async function createTestDirs(): Promise<TestDirs> {
  const root = await mkdtemp(path.join(tmpdir(), 'opt2-migration-test-'));
  const cleanup = (): Promise<void> => rm(root, { recursive: true, force: true });
  const dirs = {
    stateDir: path.join(root, 'state'),
    reportsDir: path.join(root, 'reports'),
    pristineDir: path.join(root, 'pristine'),
  };
  try {
    for (const dir of Object.values(dirs)) await mkdir(dir);
    await writeTestSecrets(dirs.stateDir);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { ...dirs, cleanup };
}

/** Directories {@link testEnv} sets as `OPT2_STATE_DIR`, `OPT2_REPORTS_DIR` and `OPT2_PRISTINE_DIR`. */
export type TestEnvDirs = Pick<TestDirs, 'stateDir' | 'reportsDir' | 'pristineDir'>;

/** Options of {@link testEnv}; every other key is a raw variable that replaces its default, `undefined` removing it. */
export interface TestEnvOptions {
  dirs?: TestEnvDirs | undefined;
  /** `LEGACY_ORIGIN`, normally the bridge double's origin. */
  bridgeOrigin?: string | undefined;
  /** Callee URLs by service name, replacing the closed-port defaults; `gateway` and `migration` also set their own URL variables. */
  serviceUrls?: Readonly<Record<string, string>> | undefined;
  [variable: string]: string | TestEnvDirs | Readonly<Record<string, string>> | undefined;
}

/** The parsed local migration env from loopback placeholders, parsed as production parses it; `PG_*` come from the process when set. */
export function testEnv(options: TestEnvOptions = {}): MigrationEnv {
  const { dirs, bridgeOrigin, serviceUrls, ...variables } = options;
  const defaults = Object.fromEntries(SERVICE_NAMES.map((name) => [name, UNREACHABLE_URL])) as Record<
    (typeof SERVICE_NAMES)[number],
    string
  >;
  const urls = { ...defaults, ...serviceUrls };
  const unsetDir = (name: string): string => path.join(tmpdir(), 'opt2-migration-test-unset', name);
  const source: Record<string, string | undefined> = {
    PORT: MIGRATION_PORT,
    OPT2_SERVICE_NAME: 'migration',
    OPT2_ENV: 'local',
    TZ: process.env.TZ || 'UTC',
    MURA_DBTYPE: 'mssql',
    MURA_DBHOST: '127.0.0.1',
    MURA_DBPORT: '1',
    MURA_DATABASE: 'masa_test',
    MURA_DBUSERNAME: 'opt2_test',
    MURA_DBPASSWORD: PLACEHOLDER_DB_PASSWORD,
    LEGACY_ORIGIN: bridgeOrigin ?? UNREACHABLE_URL,
    OPT2_BRIDGE_HMAC_KEY: TEST_BRIDGE_KEY,
    OPT2_STATE_DIR: dirs?.stateDir ?? unsetDir('state'),
    OPT2_REPORTS_DIR: dirs?.reportsDir ?? unsetDir('reports'),
    OPT2_PRISTINE_DIR: dirs?.pristineDir ?? unsetDir('pristine'),
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_JWKS_URL: `${urls.identity}/.well-known/jwks.json`,
    OPT2_GATEWAY_URL: urls.gateway,
    OPT2_MIGRATION_URL: urls.migration,
    OPT2_SERVICE_URLS: JSON.stringify(urls),
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    OPT2_DB_AUTH: 'password',
    // Required in local mode; the closed port keeps a stray Pub/Sub client off the shared emulator.
    GOOGLE_CLOUD_PROJECT: 'opt2-migration-test',
    PUBSUB_EMULATOR_HOST: '127.0.0.1:1',
    PG_HOST: process.env.PG_HOST || '127.0.0.1',
    PG_PORT: process.env.PG_PORT || '5432',
    PG_DATABASE: process.env.PG_DATABASE || 'opt2_migration_test',
    PG_USER: process.env.PG_USER || 'migration_app',
    PG_PASSWORD: process.env.PG_PASSWORD || 'unused',
  };
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`testEnv: variable ${name} must be a string`);
    source[name] = value;
  }
  return loadMigrationEnv(source);
}

/** A clock tests step forward or reset; each `now()` returns a fresh Date. */
export interface MutableClock extends Clock {
  /** Moves the clock by `ms`; a negative value steps back. */
  advance(ms: number): void;
  set(date: Date | string | number): void;
}

function instantOf(date: Date | string | number): number {
  const ms = new Date(date).getTime();
  if (Number.isNaN(ms)) throw new TypeError(`Invalid date for a mutable clock: ${String(date)}`);
  return ms;
}

/** A {@link MutableClock} at `start`, by default local noon on the seed's business date; throws TypeError for an invalid date. */
export function createMutableClock(start: Date | string | number = businessClock().now()): MutableClock {
  let current = instantOf(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      if (!Number.isFinite(ms)) throw new RangeError(`A mutable clock advances by a finite number of milliseconds, got ${String(ms)}`);
      current += ms;
    },
    set(date) {
      current = instantOf(date);
    },
  };
}

/** A `sleep` for code under test whose sleepers resolve only when `flush()` advances the clock to them. */
export interface ControlledSleep {
  /** Resolves once a flush reaches `clock.now() + ms`; a negative `ms` counts as 0, a non-finite one rejects with RangeError. */
  sleep(ms: number): Promise<void>;
  /** Sleepers not yet resolved. */
  pending(): number;
  /** Resolves sleepers in due order, moving the clock forward to each, until none remain; throws when they keep rescheduling. */
  flush(): Promise<void>;
}

/** Sleepers one flush resolves before it decides they reschedule without end. */
const MAX_FLUSH_STEPS = 10_000;

interface Sleeper {
  due: number;
  resolve: () => void;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A {@link ControlledSleep} over `clock`; sleepers due at the same instant resolve in the order they slept. */
export function createControlledSleep(clock: MutableClock): ControlledSleep {
  // Kept ordered by due time, equal times in arrival order.
  const sleepers: Sleeper[] = [];
  return {
    sleep(ms) {
      if (!Number.isFinite(ms)) return Promise.reject(new RangeError(`sleep needs a finite number of milliseconds, got ${String(ms)}`));
      const due = clock.now().getTime() + Math.max(0, ms);
      return new Promise<void>((resolve) => {
        const after = sleepers.findIndex((sleeper) => sleeper.due > due);
        sleepers.splice(after === -1 ? sleepers.length : after, 0, { due, resolve });
      });
    },
    pending: () => sleepers.length,
    async flush() {
      // One turn first, so work started just before the flush reaches its first sleep.
      await nextTurn();
      let steps = 0;
      for (let next = sleepers.shift(); next !== undefined; next = sleepers.shift()) {
        steps += 1;
        if (steps > MAX_FLUSH_STEPS) {
          sleepers.unshift(next);
          throw new Error(`flush: sleepers still pending after ${String(MAX_FLUSH_STEPS)} steps`);
        }
        if (next.due > clock.now().getTime()) clock.set(next.due);
        next.resolve();
        await nextTurn();
      }
    },
  };
}
