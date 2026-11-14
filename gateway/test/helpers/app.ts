// The whole gateway (buildApp) for suites, wired only to in-process doubles of legacy, identity, migration, web and the services.
import { rm } from 'node:fs/promises';
import { IDENTITY_SERVICE, createServiceClient, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { ROLE_SET, authHeadersFor, testInvocationMinter, testVerifier, type RoleSubject } from '@opt2/platform/testing';
import { SERVICE_NAME, buildApp, type BuildAppOptions, type GatewayEnv } from '../../src/app.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { CutoverStatus } from '../../src/cutover/state.js';
import type { CutoverTable, GroupsFile, VariantsFile } from '../../src/cutover/types.js';
import { createIdentityClient } from '../../src/session/identity-client.js';
import { TEST_CLOCK, TEST_INSTANCE_ID, TEST_SERVICE_NAMES, prepareTestStateDir, testEnv, type TestServiceName } from './env.js';
import { startIdentityDouble, type IdentityDouble, type IdentityDoubleOptions } from './identity-double.js';
import { startLegacyOrigin, type LegacyOrigin, type LegacyOriginOptions } from './legacy-origin.js';
import { createMemoryGatewayDb, type MemoryGatewayDb, type MemoryGatewaySeed } from './memory-store.js';
import { startMigrationDouble, type MigrationDouble, type MigrationDoubleOptions } from './migration-double.js';
import { startTargetDouble, type TargetDouble, type TargetDoubleOptions } from './target-double.js';
import { committedTable, writeCutoverDir, type CommittedVersion } from './versions.js';

/** Site user tokens are minted for unless a suite names another. */
const DEFAULT_SITE = 'default';

const COMMITTED_VERSIONS: readonly string[] = ['v0001', 'v0002', 'v0003'] satisfies CommittedVersion[];

// An empty env, so the committed directory is used whatever OPT2_CUTOVER_DIR the shell sets.
const COMMITTED_CUTOVER_DIR = resolveGatewayPaths({}).cutoverDir;

/** Callees with a dedicated double, so no target double is started for them by default. */
const DEDICATED_DOUBLES: ReadonlySet<string> = new Set<TestServiceName>(['web', 'migration', 'identity']);

const ACTIVATE_PATH = '/internal/v1/cutover/activate';
const FREEZE_PATH = '/internal/v1/cutover/freeze';
const UNFREEZE_PATH = '/internal/v1/cutover/unfreeze';
const STATUS_PATH = '/internal/v1/cutover/status';

/** Options of {@link buildTestGateway}; every collaborator not given is a double or the committed default. */
export interface TestGatewayOptions {
  /** Version made active: a committed one, or a fixture table served from a temporary cut-over directory; none leaves no version active. */
  version?: CommittedVersion | CutoverTable;
  /** `groups.json` of a fixture `version`'s directory. */
  groups?: GroupsFile;
  /** `variants.json` of a fixture `version`'s directory. */
  variants?: VariantsFile;
  /** Further versions in a fixture `version`'s directory, for `previous` chains and later activations. */
  extraTables?: CutoverTable[];
  /** `seed` (default) commits the activation in the memory store before the app starts; `api` activates through the operator route. */
  activateVia?: 'seed' | 'api';
  /** Gateway-schema store; a memory store over `seed` when absent. The suite keeps ownership of a store it passes. */
  db?: TenantDb;
  /** Committed state of the created memory store; unused with `db`. */
  seed?: MemoryGatewaySeed;
  /** Variable overrides of {@link testEnv}; the doubles' URLs, the cut-over and the state directory are set over them. */
  env?: Partial<Record<string, string>>;
  legacy?: LegacyOriginOptions;
  identity?: IdentityDoubleOptions;
  migration?: MigrationDoubleOptions;
  /** Target double options by service name, `web` included. */
  targets?: Partial<Record<TestServiceName, TargetDoubleOptions>>;
  /** Services that get a target double, defaulting to all; typed by the names testEnv maps to URLs, the only ones the app can reach. */
  services?: readonly TestServiceName[];
  clock?: Clock;
  instanceId?: string;
  identityClient?: BuildAppOptions['identityClient'];
  migrationClient?: BuildAppOptions['migrationClient'];
  bridgeClient?: BuildAppOptions['bridgeClient'];
}

/** A ready gateway and the doubles behind it. */
export interface TestGateway {
  app: FastifyInstance;
  legacy: LegacyOrigin;
  identity: IdentityDouble;
  migration: MigrationDouble;
  /** Target doubles by service name, `web` included. */
  targets: Record<string, TargetDouble>;
  web: TargetDouble;
  db: TenantDb;
  /** `db` when it is a memory store. */
  memory?: MemoryGatewayDb;
  clock: Clock;
  env: GatewayEnv;
  stateDir: string;
  /** The cut-over directory the app reads. */
  cutoverDir: string;
  /** Closes the app, every double and owned store, and removes a temporary cut-over directory; safe to call repeatedly. */
  close(): Promise<void>;
}

/** Runs registered closers in reverse order, each even when an earlier one fails, once. */
function closerStack(): { push(close: () => Promise<unknown>): void; close(): Promise<void> } {
  const closers: Array<() => Promise<unknown>> = [];
  let closing: Promise<void> | undefined;
  return {
    push(close) {
      closers.push(close);
    },
    close() {
      closing ??= (async () => {
        const failures: unknown[] = [];
        for (const close of closers.splice(0).reverse()) await close().catch((error: unknown) => failures.push(error));
        if (failures.length > 0) throw new AggregateError(failures, 'closing the test gateway failed');
      })();
      return closing;
    },
  };
}

function isCutoverTable(version: TestGatewayOptions['version']): version is CutoverTable {
  return typeof version === 'object';
}

function isMemoryDb(db: TenantDb): db is MemoryGatewayDb {
  return typeof (db as Partial<MemoryGatewayDb>).setActive === 'function';
}

/** Reads a version of the app's cut-over directory: the fixture tables of a temporary one, else the committed versions. */
function versionReader(opts: TestGatewayOptions): (tableVersion: string) => Promise<CutoverTable> {
  const { version } = opts;
  if (isCutoverTable(version)) {
    const known = new Map([version, ...(opts.extraTables ?? [])].map((table) => [table.tableVersion, table]));
    return async (tableVersion) => {
      const table = known.get(tableVersion);
      if (table === undefined) throw new Error(`buildTestGateway: no fixture table ${tableVersion} was given`);
      return table;
    };
  }
  return async (tableVersion) => {
    if (!COMMITTED_VERSIONS.includes(tableVersion)) throw new Error(`buildTestGateway: no committed version ${tableVersion}`);
    return committedTable(tableVersion as CommittedVersion);
  };
}

/** Versions to activate, oldest first, so that `target` follows `active` along the `previous` chain. */
async function activationChain(
  target: string,
  active: string | null,
  read: (tableVersion: string) => Promise<CutoverTable>,
): Promise<string[]> {
  const chain: string[] = [];
  for (let version: string | null = target; version !== active; ) {
    if (version === null || chain.includes(version)) {
      throw new Error(`buildTestGateway: ${target} does not follow the active version ${active ?? 'null'}`);
    }
    chain.unshift(version);
    version = (await read(version)).previous;
  }
  return chain;
}

/** Sends an operator call through `app.inject`; throws unless it answers 2xx. */
async function operatorCall<T>(app: FastifyInstance, method: 'GET' | 'POST', url: string, payload?: object): Promise<T> {
  const res = await app.inject({ method, url, headers: await operatorHeaders(), ...(payload === undefined ? {} : { payload }) });
  if (res.statusCode < 200 || res.statusCode > 299) {
    throw new Error(`buildTestGateway: ${method} ${url} answered ${res.statusCode}: ${res.body}`);
  }
  return res.json<T>();
}

/**
 * Loads the stored active version into the instance, whose background refresh does not run: an operator unfreeze of an
 * unfrozen entry, or a re-freeze of a frozen one when all are, leaves every freeze row as it was and commits one epoch.
 */
async function loadStoredVersion(
  app: FastifyInstance,
  status: CutoverStatus,
  read: (tableVersion: string) => Promise<CutoverTable>,
): Promise<void> {
  if (status.tableVersion === null) return;
  const { entries } = await read(status.tableVersion);
  const frozen = new Set(status.frozen);
  const unfrozen = entries.find((item) => !frozen.has(item.route));
  const route = unfrozen?.route ?? entries[0]?.route;
  if (route === undefined) throw new Error(`buildTestGateway: active version ${status.tableVersion} has no entry`);
  await operatorCall(app, 'POST', unfrozen === undefined ? FREEZE_PATH : UNFREEZE_PATH, { routes: [route] });
}

/**
 * Builds and readies the gateway over doubles only, then makes `opts.version` active; a failed build closes what it started.
 * With `targets.identity`, a target double serves identity's URL and session calls reach the identity double through an explicit identityClient.
 */
export async function buildTestGateway(opts: TestGatewayOptions = {}): Promise<TestGateway> {
  const resources = closerStack();
  const clock = opts.clock ?? TEST_CLOCK;
  try {
    const stateDir = await prepareTestStateDir();
    const { version } = opts;
    const tempCutoverDir = isCutoverTable(version)
      ? await writeCutoverDir(version, { groups: opts.groups, variants: opts.variants, extraTables: opts.extraTables })
      : undefined;
    if (tempCutoverDir !== undefined) resources.push(() => rm(tempCutoverDir, { recursive: true, force: true }));
    const cutoverDir = tempCutoverDir ?? COMMITTED_CUTOVER_DIR;

    const identityTarget = opts.targets?.identity !== undefined;
    const serviceNames: TestServiceName[] = [
      ...new Set<TestServiceName>([
        ...(opts.services ?? TEST_SERVICE_NAMES).filter((name) => !DEDICATED_DOUBLES.has(name)),
        ...(identityTarget ? (['identity'] as const) : []),
      ]),
    ];
    // Each double is registered for closing as soon as it starts, so a sibling's failed start leaks none.
    const track = <T extends { close(): Promise<void> }>(pending: Promise<T>): Promise<T> =>
      pending.then((double) => {
        resources.push(() => double.close());
        return double;
      });
    const legacyStart = track(startLegacyOrigin({ bridgeKey: opts.env?.OPT2_BRIDGE_HMAC_KEY, clock, ...opts.legacy }));
    const identityStart = track(startIdentityDouble(opts.identity));
    const migrationStart = track(startMigrationDouble(opts.migration));
    const webStart = track(startTargetDouble('web', opts.targets?.web));
    const serviceStarts = serviceNames.map((name) => track(startTargetDouble(name, opts.targets?.[name])));
    await Promise.allSettled([legacyStart, identityStart, migrationStart, webStart, ...serviceStarts]);
    const [legacy, identity, migration, web, services] = await Promise.all([
      legacyStart,
      identityStart,
      migrationStart,
      webStart,
      Promise.all(serviceStarts),
    ]);
    const targets: Record<string, TargetDouble> = Object.fromEntries([web, ...services].map((double) => [double.name, double]));

    const env = testEnv({
      OPT2_JWKS_URL: `${identity.url}/.well-known/jwks.json`,
      ...opts.env,
      LEGACY_ORIGIN: legacy.url,
      OPT2_CUTOVER_DIR: cutoverDir,
      OPT2_STATE_DIR: stateDir,
      serviceUrls: {
        identity: identity.url,
        ...Object.fromEntries(services.map((double) => [double.name, double.url])),
        web: web.url,
        migration: migration.url,
      },
    });

    let db: TenantDb;
    if (opts.db === undefined) {
      const created = createMemoryGatewayDb(opts.seed);
      resources.push(() => created.end());
      db = created;
    } else {
      db = opts.db;
    }
    const memory = isMemoryDb(db) ? db : undefined;
    const readVersion = versionReader(opts);
    const activateVia = opts.activateVia ?? 'seed';
    if (version !== undefined && activateVia === 'seed') {
      if (memory === undefined) throw new TypeError('buildTestGateway: seeding a version needs a memory store; use activateVia "api"');
      const table = isCutoverTable(version) ? version : await committedTable(version);
      memory.setActive(table.tableVersion, { previous: table.previous });
    }

    let identityClient = opts.identityClient;
    if (identityClient === undefined && identityTarget) {
      const client = createServiceClient({
        serviceUrls: { [IDENTITY_SERVICE]: identity.url },
        self: SERVICE_NAME,
        credentials: testInvocationMinter({ caller: SERVICE_NAME }),
      });
      resources.push(() => client.close());
      identityClient = createIdentityClient(client);
    }

    const app = await buildApp({
      env,
      clock,
      verifierOverride: testVerifier(),
      db,
      instanceId: opts.instanceId ?? TEST_INSTANCE_ID,
      legacyOrigin: legacy.url,
      startBackground: false,
      identityClient,
      migrationClient: opts.migrationClient,
      bridgeClient: opts.bridgeClient,
    });
    // app.close() leaves the service client's agent open, so it is closed after the app.
    resources.push(() => app.opt2.client.close());
    resources.push(() => app.close());
    await app.ready();

    const status = await operatorCall<CutoverStatus>(app, 'GET', STATUS_PATH);
    const chain =
      version !== undefined && activateVia === 'api'
        ? await activationChain(isCutoverTable(version) ? version.tableVersion : version, status.tableVersion, readVersion)
        : [];
    for (const tableVersion of chain) await operatorCall(app, 'POST', ACTIVATE_PATH, { tableVersion });
    // Each activation refreshes the instance; otherwise the stored version is loaded explicitly.
    if (chain.length === 0) await loadStoredVersion(app, status, readVersion);

    return {
      app,
      legacy,
      identity,
      migration,
      targets,
      web,
      db,
      ...(memory === undefined ? {} : { memory }),
      clock,
      env,
      stateDir,
      cutoverDir,
      close: () => resources.close(),
    };
  } catch (error) {
    await resources.close().catch(() => undefined);
    throw error;
  }
}

/** The `ROLE_SET` service subject holding `role`; throws TypeError when there is none. */
function serviceSubjectHolding(role: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.kind === 'service' && candidate.roles.includes(role));
  if (subject === undefined) throw new TypeError(`ROLE_SET has no service subject holding ${role}`);
  return subject;
}

/** `app.inject` headers presenting `subject` to the gateway; user tokens are minted for `site`, `default` unless given. */
export function headersFor(subject: RoleSubject, opts: { site?: string; audience?: string } = {}): Promise<Record<string, string>> {
  return authHeadersFor(subject, { site: opts.site ?? DEFAULT_SITE, audience: opts.audience ?? SERVICE_NAME });
}

/** Headers of the `platform.operator` workload, as the cut-over routes require. */
export function operatorHeaders(): Promise<Record<string, string>> {
  return headersFor(serviceSubjectHolding('platform.operator'));
}

/** Headers of the `platform.migration` workload. */
export function migrationServiceHeaders(): Promise<Record<string, string>> {
  return headersFor(serviceSubjectHolding('platform.migration'));
}

/** Headers of web's invocation credential, as the relay routes require. */
export function webServiceHeaders(): Promise<Record<string, string>> {
  return headersFor(serviceSubjectHolding('service:web'));
}

/** Headers of identity's invocation credential, as the legacy-session mark-used route requires. */
export function identityServiceHeaders(): Promise<Record<string, string>> {
  return headersFor(serviceSubjectHolding('service:identity'));
}
