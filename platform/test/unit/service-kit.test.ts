// The clock suite, plus the service-kit cases that the env, context and create-service suites do not already cover.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError } from '../../src/legacy-compat/index.js';
import { createLogger, validateLogRecord } from '../../src/logging/index.js';
import {
  baseEnvSchema,
  createService,
  currentRequestContext,
  fixedClock,
  isClock,
  loadEnv,
  systemClock,
  type Clock,
  type FastifyInstance,
} from '../../src/service-kit/index.js';
import { testVerifier } from '../../src/testing/index.js';

const INSTANT = '2026-11-10T08:57:16.524Z';
const INSTANT_MS = Date.parse(INSTANT);
const STATE_DIR = path.join(tmpdir(), 'opt2-service-kit-unit-state');

const apps: FastifyInstance[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('systemClock', () => {
  it('reads the current system time as a new Date on each call', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INSTANT_MS);
    const first = systemClock.now();
    vi.setSystemTime(INSTANT_MS + 1_000);
    const second = systemClock.now();
    expect(first.getTime()).toBe(INSTANT_MS);
    expect(second.getTime()).toBe(INSTANT_MS + 1_000);
    expect(second).not.toBe(first);
  });
});

describe('fixedClock', () => {
  it.each([
    ['a Date', new Date(INSTANT_MS)],
    ['an ISO string', INSTANT],
    ['epoch milliseconds', INSTANT_MS],
  ])('freezes at the instant given as %s', (_label, at) => {
    const clock = fixedClock(at);
    expect(clock.now().toISOString()).toBe(INSTANT);
    expect(clock.now().getTime()).toBe(INSTANT_MS);
  });

  it('returns an equal but distinct Date on each call', () => {
    const clock = fixedClock(INSTANT);
    const first = clock.now();
    const second = clock.now();
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    first.setTime(0);
    expect(clock.now().getTime()).toBe(INSTANT_MS);
  });

  it('keeps its instant when the Date it was given is mutated', () => {
    const at = new Date(INSTANT_MS);
    const clock = fixedClock(at);
    at.setTime(0);
    expect(clock.now().getTime()).toBe(INSTANT_MS);
  });

  it('ignores changes to system time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const clock = fixedClock(INSTANT);
    vi.setSystemTime(INSTANT_MS + 60_000);
    expect(clock.now().getTime()).toBe(INSTANT_MS);
  });

  it.each([
    ['an unparseable string', 'not a date'],
    ['NaN', Number.NaN],
    ['an invalid Date', new Date(Number.NaN)],
  ])('throws TypeError naming %s', (_label, at) => {
    expect(() => fixedClock(at)).toThrow(TypeError);
    expect(() => fixedClock(at)).toThrow(`Invalid date for fixedClock: ${String(at)}`);
  });
});

describe('isClock', () => {
  it.each([
    ['systemClock', systemClock],
    ['a fixedClock', fixedClock(INSTANT)],
    ['an object with a now method', { now: () => new Date(0) }],
  ])('accepts %s', (_label, value) => {
    expect(isClock(value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a Date', new Date(0)],
    ['an empty object', {}],
    ['an object whose now is not a function', { now: 0 }],
    ['a number', 0],
    ['a string', 'now'],
  ])('rejects %s', (_label, value) => {
    expect(isClock(value)).toBe(false);
  });
});

describe('loadEnv with every base variable set', () => {
  const everyLocalVariable: Record<string, string> = {
    PORT: '8112',
    OPT2_SERVICE_NAME: 'people',
    OPT2_ENV: 'local',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'masa_services',
    PG_USER: 'people_app',
    PG_PASSWORD: 'unused',
    OPT2_DB_AUTH: 'password',
    PUBSUB_EMULATOR_HOST: 'localhost:8085',
    GOOGLE_CLOUD_PROJECT: 'opt2-local',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/',
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/internal/v1/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_GATEWAY_URL: 'http://127.0.0.1:8100',
    OPT2_MIGRATION_URL: 'http://127.0.0.1:8102',
    OPT2_SERVICE_URLS: '{"identity":"http://127.0.0.1:8111","timesheets":"http://127.0.0.1:8118/"}',
    OPT2_STATE_DIR: STATE_DIR,
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    TZ: 'UTC',
  };

  it('parses the given source and ignores process.env', () => {
    vi.stubEnv('PORT', 'not-a-port');
    vi.stubEnv('OPT2_SERVICE_NAME', 'identity');

    expect(loadEnv(baseEnvSchema, everyLocalVariable)).toEqual({
      ...everyLocalVariable,
      PORT: 8112,
      PG_PORT: 5432,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OPT2_SERVICE_URLS: { identity: 'http://127.0.0.1:8111', timesheets: 'http://127.0.0.1:8118' },
    });
  });
});

describe('createService', () => {
  const env = loadEnv(baseEnvSchema, {
    PORT: '26112',
    OPT2_SERVICE_NAME: 'people',
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: STATE_DIR,
    TZ: 'UTC',
  });

  async function build(clock: Clock = fixedClock(INSTANT)): Promise<{ app: FastifyInstance; lines: Record<string, unknown>[] }> {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'people',
      version: '1.0.0',
      env: 'local',
      destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) },
    });
    const app = await createService({ name: 'people', version: '1.0.0', env, verifierOverride: testVerifier('people'), clock, logger });
    apps.push(app);
    return { app, lines };
  }

  it('stamps app.opt2 and every request context with the injected clock', async () => {
    const clock = fixedClock(INSTANT);
    const { app } = await build(clock);
    app.get('/started', { config: { opt2: { public: true } } }, async () => ({
      startedAt: currentRequestContext()?.startedAt.toISOString(),
    }));

    const res = await app.inject({ method: 'GET', url: '/started' });

    expect(app.opt2.clock).toBe(clock);
    expect(res.json()).toStrictEqual({ startedAt: INSTANT });
  });

  it.each<[string, string, Error | undefined, number]>([
    ['an unmatched API route', '/_api/json/v1/tenant-a/nothing', undefined, 404],
    ['an unmatched admin route', '/admin/nothing', undefined, 404],
    ['a LegacyApiError', '/_api/json/v1/tenant-a/content', new LegacyApiError('badRequest'), 400],
    ['a LegacyServiceUnavailableError', '/_api/json/v1/tenant-a/content', new LegacyServiceUnavailableError(), 503],
    ['an unhandled API error', '/_api/json/v1/tenant-a/content', new Error('boom'), 500],
    ['an unhandled admin error', '/admin-actions/carch/update', new Error('boom'), 500],
  ])('answers %s with the legacy headers and one valid completion log line', async (_label, url, error, status) => {
    const { app, lines } = await build();
    if (error !== undefined) {
      app.get(url, { config: { opt2: { public: true } } }, async () => {
        throw error;
      });
    }

    const res = await app.inject({ method: 'GET', url: `${url}?method=findOne`, headers: { 'x-request-id': 'req-err' } });

    expect(res.statusCode).toBe(status);
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
    const completed = lines.filter((line) => line.message === 'request completed');
    expect(completed).toHaveLength(1);
    expect(validateLogRecord(completed[0]).errors).toStrictEqual([]);
    expect(completed[0]).toMatchObject({ requestId: 'req-err', route: url, httpMethod: 'GET', statusCode: status });
    expect(completed[0]?.latencyMs).toEqual(expect.any(Number));
  });
});
