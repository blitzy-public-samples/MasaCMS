// The gateway's real composition (buildApp) over the in-memory gateway schema and doubles of legacy, identity, migration and the targets.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INVOCATION_HEADER, rolesForService } from '@opt2/platform/auth';
import { loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { mintServiceToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { buildApp, gatewayEnvSchema, type GatewayEnv } from '../../src/app.js';
import { RELAY_SERVICES } from '../../src/dispatcher/relay.js';
import { createGatewayDb, type DurableSnapshot, type GatewayDbDouble } from './gateway-db.js';
import { startIdentityDouble, type IdentityDouble } from './identity-double.js';
import { startLegacyDouble, type LegacyDouble } from './legacy-double.js';
import { startMigrationDouble, type MigrationDouble } from './migration-double.js';
import { startTargetDouble, type TargetDouble } from './target-double.js';

/** The app under test, as `OPT2_SERVICE_NAME` and the audience of credentials addressed to it. */
export const SERVICE = 'gateway';

/** Instance id the harness's gateway heartbeats as. */
export const INSTANCE_ID = 'gw-app-test';

/** Callees served by target doubles: every relay service but identity, plus web and the stub. */
export const TARGET_SERVICES: readonly string[] = Object.freeze([
  ...RELAY_SERVICES.filter((service) => service !== 'identity'),
  'web',
  'stub',
]);

/** Upstream URLs a gateway environment names. */
export interface UpstreamUrls {
  legacy: string;
  identity: string;
  migration: string;
  targets: Readonly<Record<string, string>>;
}

/** Requests each upstream received, the legacy site registry's periodic reads excepted. */
export interface UpstreamCounts {
  legacy: number;
  identity: number;
  migration: number;
  targets: Record<string, number>;
}

/** What a request may change: the durable gateway rows and the requests every upstream received. */
export interface Effects {
  db: DurableSnapshot;
  upstream: UpstreamCounts;
}

/** A started gateway with its doubles. */
export interface GatewayHarness {
  app: FastifyInstance;
  env: GatewayEnv;
  db: GatewayDbDouble;
  legacy: LegacyDouble;
  identity: IdentityDouble;
  migration: MigrationDouble;
  /** The double serving `name`; throws for a name without one. */
  target(name: string): TargetDouble;
  bridgeKey: string;
  effects(): Effects;
  close(): Promise<void>;
}

/** A local gateway environment, as `up.sh` passes it, over `urls`. */
export function gatewayEnv(urls: UpstreamUrls, stateDir: string, bridgeKey: string): GatewayEnv {
  return loadEnv(gatewayEnvSchema, {
    PORT: '8100',
    OPT2_SERVICE_NAME: SERVICE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: `${urls.identity}/.well-known/jwks.json`,
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify({ identity: urls.identity, migration: urls.migration, ...urls.targets }),
    OPT2_STATE_DIR: stateDir,
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    TZ: 'UTC',
    LEGACY_ORIGIN: urls.legacy,
    OPT2_BRIDGE_HMAC_KEY: bridgeKey,
  });
}

/** `X-Serverless-Authorization` of `caller`'s local service token addressed to `audience`. */
export async function serviceHeaders(caller: string, audience: string = SERVICE): Promise<Record<string, string>> {
  const token = await mintServiceToken({ caller, audience, roles: rolesForService(caller) });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

/** Activates `tableVersion` through the operator's `cutoverActivate` call; throws unless it answers 200. */
export async function activate(app: FastifyInstance, tableVersion: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/v1/cutover/activate',
    headers: await serviceHeaders('operator'),
    payload: { tableVersion },
  });
  if (res.statusCode !== 200) throw new Error(`activating ${tableVersion} answered ${res.statusCode}: ${res.body}`);
}

/** Starts every double, then the gateway with its background loops, and activates `activate` in order. */
export async function startGatewayHarness(opts: { activate?: readonly string[] } = {}): Promise<GatewayHarness> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-gateway-app-'));
  const bridgeKey = randomBytes(32).toString('hex');
  const closers: Array<() => Promise<void>> = [() => rm(stateDir, { recursive: true, force: true })];
  const closeAll = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const close of closers.splice(0).reverse()) await close().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw new AggregateError(failures, 'closing the gateway harness failed');
  };
  try {
    await writeTestSecrets(stateDir);
    const legacy = await startLegacyDouble(bridgeKey);
    closers.push(() => legacy.close());
    const identity = await startIdentityDouble();
    closers.push(() => identity.close());
    const migration = await startMigrationDouble();
    closers.push(() => migration.close());
    const targets = new Map<string, TargetDouble>();
    for (const name of TARGET_SERVICES) {
      const double = await startTargetDouble(name);
      closers.push(() => double.close());
      targets.set(name, double);
    }
    const env = gatewayEnv(
      {
        legacy: legacy.url,
        identity: identity.url,
        migration: migration.url,
        targets: Object.fromEntries([...targets].map(([name, double]) => [name, double.url])),
      },
      stateDir,
      bridgeKey,
    );
    const db = createGatewayDb();
    const app = await buildApp({ env, verifierOverride: testVerifier(SERVICE), db, instanceId: INSTANCE_ID });
    closers.push(() => app.opt2.shutdown());
    await app.ready();
    for (const tableVersion of opts.activate ?? []) await activate(app, tableVersion);

    const target = (name: string): TargetDouble => {
      const double = targets.get(name);
      if (double === undefined) throw new TypeError(`no target double serves ${name}`);
      return double;
    };
    return {
      app,
      env,
      db,
      legacy,
      identity,
      migration,
      target,
      bridgeKey,
      effects: () => ({
        db: db.durable(),
        upstream: {
          legacy: legacy.forwarded().length,
          identity: identity.requests.length,
          migration: migration.requests.length,
          targets: Object.fromEntries([...targets].map(([name, double]) => [name, double.requests.length])),
        },
      }),
      close: closeAll,
    };
  } catch (error) {
    await closeAll().catch(() => undefined);
    throw error;
  }
}
