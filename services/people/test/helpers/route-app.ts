/** The people service composed from its own route, consumer, migration and task registrars over a throwaway schema. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerConsumers } from '@opt2/platform/events';
import { createLogger, type Logger } from '@opt2/platform/logging';
import {
  closeGates,
  ensureUnitGates,
  openGates,
  registerMigrationHandlers,
  registerWritePositionHeader,
} from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import {
  CSRF_CONSUME_PATH,
  createService,
  currentRequestContext,
  loadEnv,
  type BaseEnv,
  type Clock,
  type FastifyInstance,
  type ServiceRequest,
} from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import type { MetadataTx, TenantDb, TenantTx, TransactionCallOptions } from '@opt2/platform/tenancy';
import {
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createFaultHooks } from '../../src/domain/faults.js';
import type { RosterDeps } from '../../src/domain/roster-protocol.js';
import { peopleConsumerRegistrations } from '../../src/events/consumers.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import type { AccountView, AdminSessionState, IdentityClient } from '../../src/legacy/identity-client.js';
import { PEOPLE_MAPPINGS } from '../../src/migration/mappings/index.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';
import { registerAdminDownloadRoutes, type SearchCriteriaReader } from '../../src/routes/admin-downloads.js';
import { registerAdminProfileRoutes } from '../../src/routes/admin-profile.js';
import { registerAdminUserRoutes } from '../../src/routes/admin-users.js';
import { PEOPLE_SERVICE, createPeopleTaskPort, registerQueueControlRoutes, registerSweep } from '../../src/tasks/port.js';
import { IdentityDouble as TokenAccountReads, charKey } from './search-doubles.js';

/** People's own base URL, which the sweep chain addresses its successor tasks to. */
export const PEOPLE_SERVICE_URLS: Readonly<Record<string, string>> = Object.freeze({ [PEOPLE_SERVICE]: 'http://127.0.0.1:8112' });

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const GATE_HOLDER = 'people-route-app';

/** A logger that writes nothing. */
export function silentLogger(): Logger {
  return createLogger({ service: PEOPLE_SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });
}

/** The local people environment over `stateDir`, with people's service URL. */
export function peopleEnv(stateDir: string): BaseEnv {
  return loadEnv(undefined, {
    PORT: '8112',
    OPT2_SERVICE_NAME: PEOPLE_SERVICE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify(PEOPLE_SERVICE_URLS),
    OPT2_STATE_DIR: stateDir,
    TZ: process.env.TZ ?? 'UTC',
  });
}

/** A TenantDb that counts the transactions it opens, so a refused request can be shown to have reached no data. */
export interface CountingDb extends TenantDb {
  readonly transactions: number;
}

/** Wraps `db`, counting every tenant and metadata transaction. */
export function countingDb(db: TenantDb): CountingDb {
  let transactions = 0;
  return Object.freeze({
    schema: db.schema,
    get transactions(): number {
      return transactions;
    },
    withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
      transactions += 1;
      return db.withTenant(tenantId, fn);
    },
    withMetadata<T>(fn: (tx: MetadataTx) => Promise<T>, options?: TransactionCallOptions): Promise<T> {
      transactions += 1;
      return options === undefined ? db.withMetadata(fn) : db.withMetadata(fn, options);
    },
    end: () => db.end(),
  });
}

/** Identity's side of people's calls, held in memory; `calls` lists every call by method name. */
export interface IdentityDouble extends IdentityClient {
  readonly calls: string[];
  /** Adds or replaces the accounts identity holds. */
  seedAccounts(accounts: readonly AccountView[]): void;
}

/**
 * An identity double holding seeded accounts, no memberships or login strikes, and one admin session's state; it accepts every
 * account step of the roster protocol, and answers the list and search reads for the forwarded user token's pools in `registry`.
 */
export function createIdentityDouble(registry: TenantDb): IdentityDouble {
  const accounts = new Map<string, AccountView>();
  const memberships = new Map<string, string[]>();
  const calls: string[] = [];
  let sessionState: AdminSessionState = {};
  const called = (name: string): void => {
    calls.push(name);
  };
  const unexpected = (name: string) => (): Promise<never> => {
    called(name);
    return Promise.reject(new Error(`unexpected identity call ${name}`));
  };
  /** Identity's account reads for the request's forwarded user token, which every one of them requires. */
  const tokenReads = (): TokenAccountReads => {
    const user = currentRequestContext()?.user;
    if (user === undefined) throw new Error('identity answers 401 to an account read without a forwarded user token');
    return new TokenAccountReads(accounts, memberships, { db: registry, tid: user.tid, s2: user.s2 });
  };
  return {
    calls,
    seedAccounts(seeded) {
      for (const account of seeded) accounts.set(charKey(account.userId), account);
    },
    async prepare(userId, operationId, change) {
      called('prepare');
      return { ok: true, operationId, userId, kind: change.kind, state: 'prepared' };
    },
    async commit(userId, operationId) {
      called('commit');
      return { operationId, userId, state: 'committed', writePosition: '1' };
    },
    async abort() {
      called('abort');
    },
    async finish() {
      called('finish');
    },
    revert: unexpected('revert'),
    operationState: unexpected('operationState'),
    async readAccount(userId) {
      called('readAccount');
      return accounts.get(charKey(userId));
    },
    async readAccounts(userIds, where) {
      called('readAccounts');
      return tokenReads().readAccounts(userIds, where);
    },
    async readAccountsAllSites(userIds, where) {
      called('readAccountsAllSites');
      return tokenReads().readAccountsAllSites(userIds, where);
    },
    async countAccounts(request) {
      called('countAccounts');
      return tokenReads().countAccounts(request);
    },
    async usernameCandidates(request) {
      called('usernameCandidates');
      return tokenReads().usernameCandidates(request);
    },
    async lookupMemberships(userIds) {
      called('lookupMemberships');
      return tokenReads().lookupMemberships(userIds);
    },
    // Only the cUsers save, which people does not serve yet, lists a user's memberships.
    userMemberships: unexpected('userMemberships'),
    async membershipGroupIds() {
      called('membershipGroupIds');
      return [];
    },
    async siteGroups() {
      called('siteGroups');
      return [];
    },
    async userGroups() {
      called('userGroups');
      return [];
    },
    async actingUser() {
      called('actingUser');
      return undefined;
    },
    async adminSessionState() {
      called('adminSessionState');
      return sessionState;
    },
    async saveAdminSessionState(state) {
      called('saveAdminSessionState');
      sessionState = { ...sessionState, ...state };
      return sessionState;
    },
    async sessionSites() {
      called('sessionSites');
      return [];
    },
    // No user holds a login strike, so none is blocked and removing a block leaves none.
    async loginBlock() {
      called('loginBlock');
      return null;
    },
  };
}

/** The composed app and the collaborators a suite inspects. */
export interface PeopleRouteApp {
  readonly app: FastifyInstance;
  readonly handle: ThrowawaySchema;
  /** The counting database every registrar was given. */
  readonly db: CountingDb;
  readonly repository: PeopleRepository;
  readonly identity: IdentityDouble;
  readonly publisher: CapturingPublisher;
  readonly port: TaskPort;
  readonly clock: Clock;
  /** Every service call the app made through `app.opt2.client`. */
  readonly serviceCalls: ServiceRequest[];
  /** Closes the app, drops the schema and removes the state directory. */
  close(): Promise<void>;
}

/**
 * Builds people over a migrated throwaway schema with the fixture registry and open unit gates: the cUsers, download and
 * profile routes, the push consumers, the migration handlers, the outbox sweep and queue control. The local task port's
 * dispatcher is stopped, and identity's CSRF consume, the only service call, answers valid.
 */
export async function buildPeopleRouteApp(): Promise<PeopleRouteApp> {
  const clock = businessClock();
  const logger = silentLogger();
  const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-people-route-app-'));
  await writeTestSecrets(stateDir);
  const env = peopleEnv(stateDir);
  const handle = await createThrowawaySchema({ service: PEOPLE_SERVICE, migrationsDir: MIGRATIONS_DIR });
  await ensureUnitGates(handle.app, PEOPLE_UNITS);
  await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: GATE_HOLDER, allowLegacy: true });
  await openGates(handle.app, { units: PEOPLE_UNITS, holderId: GATE_HOLDER, state: 'open' });
  await seedRegistry(handle.app);

  const db = countingDb(handle.app);
  const repository = createPeopleRepository({ clock, schema: handle.schema });
  // Identity reads its own registry copy, so its reads are not people's counted transactions.
  const identity = createIdentityDouble(handle.app);
  const publisher = createCapturingPublisher();
  createOutbox({ service: PEOPLE_SERVICE, db, publisher, logger, clock, payloadValidators: peoplePayloadValidators });
  const port = await createPeopleTaskPort(env, { db, clock, logger });
  // Stopped, so no background dispatch touches the database between requests.
  await port.close();

  const app = await createService({
    name: PEOPLE_SERVICE,
    version: '1.0.0',
    env,
    verifierOverride: testVerifier(PEOPLE_SERVICE),
    clock,
    pool: db,
    logger,
  });
  const serviceCalls: ServiceRequest[] = [];
  const request = async (req: ServiceRequest) => {
    serviceCalls.push(req);
    if (req.service !== 'identity' || req.path !== CSRF_CONSUME_PATH) throw new Error(`unexpected service call ${req.service} ${req.path}`);
    return { status: 200, headers: {}, body: { valid: true } };
  };
  Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });

  const roster: RosterDeps = {
    db,
    repo: repository,
    events: createPeopleEvents(repository),
    identity,
    clock,
    faults: createFaultHooks({}, {}),
    sleep: () => Promise.resolve(),
  };
  // No advanced-search criteria are stored for any session, so a download runs admin start-up's defaults.
  const searchCriteria: SearchCriteriaReader = { read: () => Promise.resolve(undefined) };

  registerWritePositionHeader(app);
  await registerAdminUserRoutes(app, { db, repository, identity, clock });
  await registerAdminDownloadRoutes(app, { search: { db, repo: repository, identity }, searchCriteria });
  await registerAdminProfileRoutes(app, { roster });
  registerConsumers(app, { service: PEOPLE_SERVICE, consumers: peopleConsumerRegistrations(repository), publisher, db });
  registerMigrationHandlers(app, { owner: PEOPLE_SERVICE, repository: repository.base, mappings: PEOPLE_MAPPINGS, units: PEOPLE_UNITS, db });
  registerSweep(app, { port, serviceUrls: PEOPLE_SERVICE_URLS, clock, recoveryHooks: [] });
  registerQueueControlRoutes(app, { port, serviceUrls: PEOPLE_SERVICE_URLS, clock });
  await app.ready();

  return {
    app,
    handle,
    db,
    repository,
    identity,
    publisher,
    port,
    clock,
    serviceCalls,
    async close() {
      await app.close();
      await handle.drop();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
