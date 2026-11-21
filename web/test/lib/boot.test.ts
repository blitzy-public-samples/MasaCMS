// Web start-up: a valid environment signals the custom server; any failure writes one start-up line and exits 1.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEVERITY_BY_LEVEL, validateLogRecord } from '@opt2/platform/logging';
import { setWebAuthRuntimeForTests } from '@/lib/auth';
import { bootWeb } from '@/lib/boot';
import { resetLegacySettingsForTests, setWebEnvForTests, webEnvSchema } from '@/lib/env';
import { WEB_VERSION, ensureTracing } from '@/lib/telemetry';
import { awaitBoot } from '@/server/shared';
import { TEST_ENV_DEFAULTS, useTestEnv } from '../helpers/env';
import { captureLines } from '../helpers/log-lines';

vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  ensureTracing: vi.fn(async () => undefined),
}));

const cleanups: (() => void)[] = [];

/** Whether `promise` settled within a macrotask. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

/** Points `process.env` at the valid test variables with `overrides`, and drops every cached value built from it. */
function useProcessEnv(overrides: Record<string, string | undefined>): void {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'opt2-web-boot-'));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const source: Record<string, string | undefined> = { ...TEST_ENV_DEFAULTS, OPT2_STATE_DIR: stateDir, ...overrides };
  for (const key of Object.keys(webEnvSchema.shape)) vi.stubEnv(key, source[key]);
  cleanups.push(setWebEnvForTests(undefined), setWebAuthRuntimeForTests(undefined), resetLegacySettingsForTests);
}

beforeEach(() => {
  vi.mocked(ensureTracing).mockClear();
});

afterEach(() => {
  for (let restore = cleanups.pop(); restore !== undefined; restore = cleanups.pop()) restore();
  vi.unstubAllEnvs();
});

describe('bootWeb', () => {
  it('validates, builds the auth runtime, starts tracing once and signals the handshake', async () => {
    cleanups.push(useTestEnv());
    const exit = vi.fn();
    const booted = awaitBoot();

    await bootWeb({ exit });

    expect(exit).not.toHaveBeenCalled();
    expect(vi.mocked(ensureTracing)).toHaveBeenCalledTimes(1);
    expect(await settled(booted)).toBe(true);
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['OPT2_GATEWAY_URL removed', { OPT2_GATEWAY_URL: undefined }, 'OPT2_GATEWAY_URL'],
    ['OPT2_ENV=bogus', { OPT2_ENV: 'bogus' }, 'OPT2_ENV'],
    ['OPT2_JWKS_URL removed', { OPT2_JWKS_URL: undefined }, 'OPT2_JWKS_URL'],
    ['TZ removed', { TZ: undefined }, 'TZ'],
    ['OPT2_SERVICE_NAME=people', { OPT2_SERVICE_NAME: 'people' }, 'OPT2_SERVICE_NAME'],
    ['OPT2_SERVICE_URLS={bad', { OPT2_SERVICE_URLS: '{bad' }, 'OPT2_SERVICE_URLS'],
    ['OPT2_TASKS_ADAPTER=cloud', { OPT2_TASKS_ADAPTER: 'cloud' }, 'OPT2_TASKS_ADAPTER'],
  ])('refuses to start with %s, naming the variable', async (_case, overrides, key) => {
    useProcessEnv(overrides);
    const { lines, destination } = captureLines();
    const exit = vi.fn();
    const booted = awaitBoot();

    await bootWeb({ exit, destination });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(validateLogRecord(line).errors).toEqual([]);
    expect(line).toMatchObject({
      severity: SEVERITY_BY_LEVEL.error,
      message: 'start-up failed',
      service: 'web',
      version: WEB_VERSION,
      error: { type: 'EnvValidationError' },
    });
    expect((line?.error as { message: string }).message).toMatch(new RegExp(`invalid environment \\(.*\\b${key}\\b`));
    expect(vi.mocked(ensureTracing)).not.toHaveBeenCalled();
    expect(await settled(booted)).toBe(false);
  });

  it('refuses to start when the auth runtime cannot be built from the state directory', async () => {
    // The fresh state directory holds no signing key pair.
    useProcessEnv({});
    const { lines, destination } = captureLines();
    const exit = vi.fn();

    await bootWeb({ exit, destination });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lines).toEqual([expect.objectContaining({ message: 'start-up failed', error: expect.any(Object) })]);
    expect(vi.mocked(ensureTracing)).not.toHaveBeenCalled();
  });

  it('refuses to start when tracing fails to start', async () => {
    cleanups.push(useTestEnv());
    vi.mocked(ensureTracing).mockRejectedValueOnce(new Error('exporter failed'));
    const { lines, destination } = captureLines();
    const exit = vi.fn();
    const booted = awaitBoot();

    await bootWeb({ exit, destination });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lines).toEqual([
      expect.objectContaining({ message: 'start-up failed', error: expect.objectContaining({ type: 'Error' }) }),
    ]);
    expect(await settled(booted)).toBe(false);
  });
});
