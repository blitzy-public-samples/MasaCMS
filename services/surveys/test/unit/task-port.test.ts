// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Surveys task port: the platform adapter `OPT2_TASKS_ADAPTER` selects, built from the env and deps it is given. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createLogger } from '@opt2/platform/logging';
import { baseEnvSchema, loadEnv, type BaseEnv } from '@opt2/platform/service-kit';
import { createTaskPort, type TaskAdapterKind, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { fixedClock, writeTestSecrets } from '@opt2/platform/testing';
import { createSurveysTaskPort, type SurveysTaskPortDeps } from '../../src/tasks/port.js';

// Wraps the real factory so its call arguments can be read back.
vi.mock(import('@opt2/platform/tasks'), async (importOriginal) => {
  const tasks = await importOriginal();
  return { ...tasks, createTaskPort: vi.fn(tasks.createTaskPort) };
});

const METADATA_REGION_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/region';
const GOOGLE_CLOUD_PROJECT = 'opt2-surveys-test';

const noSql = (): Promise<never> => Promise.reject(new Error('task port tests run no SQL'));
const db: TenantDb = { schema: 'surveys', withTenant: noSql, withMetadata: noSql, end: () => Promise.resolve() };
const deps: SurveysTaskPortDeps = {
  db,
  clock: fixedClock('2026-06-30T12:00:00Z'),
  logger: createLogger({ service: 'surveys', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
};

let stateDir: string;
let fetchStub: Mock<typeof fetch>;
const ports: TaskPort[] = [];

function surveysEnv(adapter: TaskAdapterKind, extra: Record<string, string>): BaseEnv {
  return loadEnv(baseEnvSchema, {
    PORT: '8117',
    OPT2_SERVICE_NAME: 'surveys',
    OPT2_ENV: adapter,
    OPT2_TASKS_ADAPTER: adapter,
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify({ surveys: 'http://127.0.0.1:8117' }),
    OPT2_STATE_DIR: stateDir,
    TZ: 'UTC',
    ...extra,
  });
}

// The local adapter signs its dispatches with the key pair under OPT2_STATE_DIR.
beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-surveys-task-port-'));
  await writeTestSecrets(stateDir);
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

// Answers the cloud adapter's Cloud Run region lookup in-process.
beforeEach(() => {
  fetchStub = vi.fn<typeof fetch>(() => Promise.resolve(new Response('projects/123456789/regions/europe-west1')));
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(async () => {
  await Promise.all(ports.splice(0).map((port) => port.close()));
  vi.unstubAllGlobals();
  vi.mocked(createTaskPort).mockClear();
});

describe('createSurveysTaskPort', () => {
  it.each<[TaskAdapterKind, Record<string, string>, string[]]>([
    ['local', {}, []],
    ['cloud', { GOOGLE_CLOUD_PROJECT }, [METADATA_REGION_URL]],
  ])('builds the %s adapter from the env and deps it is given', async (adapter, extra, fetchedUrls) => {
    const env = surveysEnv(adapter, extra);

    const port = await createSurveysTaskPort(env, deps);
    ports.push(port);

    expect(port.kind).toBe(adapter);
    expect(createTaskPort).toHaveBeenCalledOnce();
    const [passedEnv, options] = vi.mocked(createTaskPort).mock.lastCall ?? [];
    expect(passedEnv).toBe(env);
    expect(options).toStrictEqual(deps);
    expect(options?.db).toBe(deps.db);
    expect(options?.clock).toBe(deps.clock);
    expect(options?.logger).toBe(deps.logger);
    expect(createTaskPort).toHaveResolvedWith(port);
    expect(fetchStub.mock.calls.map(([input]) => input)).toStrictEqual(fetchedUrls);
  });
});
