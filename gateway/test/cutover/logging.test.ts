/** Cut-over activation, freeze and orphan-clear log lines as the platform logger writes them, against log-record.v1. */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, rolesForService } from '@opt2/platform/auth';
import { createLogger, validateLogRecord, type CreateLoggerOptions, type Logger } from '@opt2/platform/logging';
import { createService, loadEnv, systemClock, type FastifyInstance } from '@opt2/platform/service-kit';
import { createThrowawaySchema, mintServiceToken, pgAvailable, testVerifier, type ThrowawaySchema } from '@opt2/platform/testing';
import type { InflightClearInput, InflightClearResult, InflightStore } from '../../src/cutover/inflight.js';
import { loadGroups, loadVariants } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import { registerCutoverRoutes } from '../../src/cutover/routes.js';
import { createCutoverState, type CutoverState } from '../../src/cutover/state.js';

type LogLine = Record<string, unknown>;

const BASE = { service: 'gateway', version: '1.0.0', env: 'local' } as const;
const OPERATOR = 'operator';
const PERM_ROUTE = 'admin:cperm.update';
const USERS_ROUTE = 'admin:cusers.update{type=1,action=delete}';
const AT = '2026-06-30T12:00:00.000+00:00';
const ORPHAN_REQUEST_ID = 'r-orphan-1';
/** Matches any string; `expect.any` itself is typed `any`. */
const ANY_STRING: unknown = expect.any(String);

/** A platform logger writing to memory; `lines()` parses every line written so far. */
function captureLogger(): { logger: Logger; lines: () => LogLine[] } {
  const chunks: string[] = [];
  const destination: NonNullable<CreateLoggerOptions['destination']> = { write: (chunk: string) => void chunks.push(chunk) };
  return {
    logger: createLogger({ ...BASE, destination }),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogLine),
  };
}

/** Asserts that every captured line satisfies log-record.v1. */
function expectConforming(lines: readonly LogLine[]): void {
  for (const line of lines) expect(validateLogRecord(line), JSON.stringify(line)).toStrictEqual({ valid: true, errors: [] });
}

/** `impl` as a `T` whose every other member fails the test when called. */
function only<T extends object>(impl: Partial<T>): T {
  return new Proxy(impl, {
    get: (target, op) =>
      op in target
        ? Reflect.get(target, op)
        : () => {
            throw new Error(`unexpected ${String(op)} call`);
          },
  }) as T;
}

const available = await pgAvailable();

describe.skipIf(!available)('cut-over state log lines', () => {
  let handle: ThrowawaySchema;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'gateway',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('writes the version, previous version, epoch, actor, instance and normalised routes of each operation', async () => {
    const paths = resolveGatewayPaths({});
    const [variants, groups] = await Promise.all([loadVariants(paths), loadGroups(paths)]);
    const { logger, lines } = captureLogger();
    const state = createCutoverState({ db: handle.app, clock: systemClock, paths, instanceId: 'gw-log', logger, variants, groups });
    try {
      await state.start();
      await state.activate({ tableVersion: 'v0001', actor: OPERATOR });
      await state.freeze([USERS_ROUTE, PERM_ROUTE.toUpperCase()], OPERATOR);
      await state.unfreeze([PERM_ROUTE, USERS_ROUTE], OPERATOR);
      await state.activate({ tableVersion: 'v0002', actor: OPERATOR });
    } finally {
      state.stop();
    }

    const routes = JSON.stringify([PERM_ROUTE, USERS_ROUTE]);
    const context = `actor=${OPERATOR} instance=gw-log`;
    expectConforming(lines());
    expect(lines().filter((line) => line.severity === 'INFO')).toStrictEqual(
      [
        `cut-over version activated: tableVersion=v0001 previous=null epoch=1 ${context}`,
        `cut-over routes frozen: count=2 epoch=2 ${context} routes=${routes}`,
        `cut-over routes unfrozen: count=2 epoch=3 ${context} routes=${routes}`,
        `cut-over version activated: tableVersion=v0002 previous=v0001 epoch=4 ${context}`,
      ].map((message) => ({ severity: 'INFO', timestamp: ANY_STRING, ...BASE, message })),
    );
  });
});

describe('orphan-clear log line', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
  });

  it.each<[string, string, InflightClearInput, number, string]>([
    [
      'legacy-side rows on a legacy restart',
      'operator',
      { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: 'window-1', at: AT } },
      1,
      'count=1 side=legacy evidence=legacy-restart holder=window-1 actor=operator',
    ],
    [
      'target-side rows of named instances once gates closed',
      'migration',
      {
        side: 'target',
        evidence: { kind: 'gates-closed', holderId: 'transition-1', at: AT, units: ['identity.group_account'] },
        instanceIds: ['gw-dead'],
      },
      2,
      'count=2 side=target evidence=gates-closed holder=transition-1 units=["identity.group_account"] instances=["gw-dead"] actor=migration',
    ],
  ])('names the count, side, evidence and actor of %s without the cleared rows', async (_label, caller, payload, cleared, context) => {
    const rows = Array.from({ length: cleared }, (_, i) => ({
      instanceId: 'gw-dead',
      requestId: `${ORPHAN_REQUEST_ID}${i}`,
      route: USERS_ROUTE,
      side: payload.side,
      windowId: null,
      startedAt: AT,
    }));
    const { logger, lines } = captureLogger();
    const app = await createService({
      name: 'gateway',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8100',
        OPT2_SERVICE_NAME: 'gateway',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('gateway'),
      logger,
    });
    apps.push(app);
    const inflight = only<InflightStore>({ clearOrphans: (): Promise<InflightClearResult> => Promise.resolve({ cleared, rows }) });
    await registerCutoverRoutes(app, { state: only<CutoverState>({}), inflight });
    await app.ready();

    const token = await mintServiceToken({ caller, audience: 'gateway', roles: rolesForService(caller) });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/inflight:clear-orphans',
      headers: { [INVOCATION_HEADER]: `Bearer ${token}` },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expectConforming(lines());
    const logged = lines().filter((line) => String(line.message).startsWith('in-flight orphans cleared'));
    expect(logged).toStrictEqual([
      {
        severity: 'INFO',
        timestamp: ANY_STRING,
        ...BASE,
        requestId: ANY_STRING,
        message: `in-flight orphans cleared: ${context}`,
      },
    ]);
    expect(JSON.stringify(lines())).not.toContain(ORPHAN_REQUEST_ID);
  });
});
