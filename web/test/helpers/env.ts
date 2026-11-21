// Installs and restores one test's web environment and auth runtime, over the platform test keys, and the oracle's URL settings.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import { loadEnv } from '@opt2/platform/service-kit';
import { testVerifier } from '@opt2/platform/testing';
import { setWebAuthRuntimeForTests } from '@/lib/auth';
import { setWebEnvForTests, webEnvSchema, type WebEnv } from '@/lib/env';

/** Origin of endpoints a suite does not serve. */
const UNSERVED_ORIGIN = 'http://127.0.0.1:1';

/** Valid local-mode web variables; `useTestEnv` adds `OPT2_STATE_DIR`. */
export const TEST_ENV_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  PORT: '8101',
  OPT2_SERVICE_NAME: 'web',
  OPT2_ENV: 'local',
  OPT2_GATEWAY_URL: UNSERVED_ORIGIN,
  OPT2_MIGRATION_URL: UNSERVED_ORIGIN,
  OPT2_SERVICE_URLS: '{}',
  OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
  OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
  // Never fetched: the installed user verifier resolves keys from the in-memory test JWKS.
  OPT2_JWKS_URL: `${UNSERVED_ORIGIN}/.well-known/jwks.json`,
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  OPT2_TASKS_ADAPTER: 'local',
  OPT2_STORAGE_ADAPTER: 'local',
  // A blank TZ is UTC to the process.
  TZ: process.env.TZ || 'UTC',
});

/**
 * Installs the parsed web environment (`TEST_ENV_DEFAULTS` with `overrides`; an `undefined` value unsets a default,
 * but an absent or `undefined` `OPT2_STATE_DIR` gets a fresh private directory) and an auth runtime over the
 * platform test keys.
 * @returns Restore function that reinstates both and removes the state directory this call created.
 * @throws EnvValidationError when the merged variables are invalid; nothing is then installed.
 */
export function useTestEnv(overrides: Partial<Record<string, string>> = {}): () => void {
  const ownStateDir =
    overrides.OPT2_STATE_DIR === undefined ? mkdtempSync(path.join(os.tmpdir(), 'opt2-web-test-')) : undefined;
  const removeOwnStateDir = (): void => {
    if (ownStateDir !== undefined) rmSync(ownStateDir, { recursive: true, force: true });
  };

  let env: WebEnv;
  try {
    env = loadEnv(webEnvSchema, {
      // Required by Next's `ProcessEnv` typing; the schema drops it.
      NODE_ENV: 'test',
      ...TEST_ENV_DEFAULTS,
      ...overrides,
      OPT2_STATE_DIR: overrides.OPT2_STATE_DIR ?? ownStateDir,
    });
  } catch (error) {
    removeOwnStateDir();
    throw error;
  }

  const restoreEnv = setWebEnvForTests(env);
  // createAuthFromEnv is async; given every piece, as testVerifier(callee) supplies them, it returns these same pieces.
  const restoreRuntime = setWebAuthRuntimeForTests(testVerifier(env.OPT2_SERVICE_NAME));
  return () => {
    restoreRuntime();
    restoreEnv();
    removeOwnStateDir();
  };
}

/** The legacy oracle's content URL settings: port 8080, neither the site id nor the index file in URLs. */
export const ORACLE_URL_SETTINGS: Readonly<Record<string, string | undefined>> = Object.freeze({
  MURA_PORT: '8080',
  MURA_CONTEXT: undefined,
  MURA_SITEIDINURLS: 'false',
  MURA_INDEXFILEINURLS: 'false',
  MURA_HASHURLS: undefined,
  MURA_LEGACYINDEXFILELOCATION: undefined,
  MURA_SITEDIR: undefined,
});

/** Stubs {@link ORACLE_URL_SETTINGS} into `process.env` for one test; call before `useTestEnv`, which drops cached settings. */
export function stubOracleUrlSettings(): void {
  for (const [name, value] of Object.entries(ORACLE_URL_SETTINGS)) vi.stubEnv(name, value);
}
