/** `opt2-people resolve-operation`: argument parsing, environment checks, and resolutions over a recording database with identity doubles. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createOutbox } from '@opt2/platform/outbox';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, createCapturingPublisher } from '@opt2/platform/testing';
import { OperationNotFoundError, UsageError, main, parseArgs, runResolveOperation, type ResolveReport } from '../../src/cli.js';
import { HALT_AFTER_MS, type RecoveryDeps, type ResolveTarget } from '../../src/domain/roster-recovery.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import { FINISH_PENDING_ERROR, type RosterOperationRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, createMutableClock, createRecordingDb, type MutableClock, type RecordingDb } from '../helpers/app.js';
import { STALE, captureWrites, cliEnv } from '../helpers/cli-doubles.js';
import { rosterOperationRow } from '../helpers/fixtures.js';
import { createIdentityDouble, type IdentityDouble } from '../helpers/identity-double.js';

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  assertTenantId: vi.fn(),
  createPublisher: vi.fn(),
  createIdentityClient: vi.fn(),
}));

// Pass-through spies; the main tests replace them to run the CLI over a test database, and one parseArgs test fails the tenant check.
vi.mock('@opt2/platform/tenancy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tenancy')>();
  mocks.createPool.mockImplementation(actual.createPool);
  mocks.assertTenantId.mockImplementation(actual.assertTenantId);
  return { ...actual, createPool: mocks.createPool, assertTenantId: mocks.assertTenantId };
});
vi.mock('@opt2/platform/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/events')>();
  mocks.createPublisher.mockImplementation(actual.createPublisher);
  return { ...actual, createPublisher: mocks.createPublisher };
});
vi.mock('../../src/legacy/identity-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/legacy/identity-client.js')>();
  mocks.createIdentityClient.mockImplementation(actual.createIdentityClient);
  return { ...actual, createIdentityClient: mocks.createIdentityClient };
});

const A = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  const OP = 'OP-0000-0000-0000000000000000000001';

  it.each<[string[], ReturnType<typeof parseArgs>]>([
    [['resolve-operation', OP], { command: 'resolve-operation', operationId: OP }],
    [['resolve-operation', OP, '--to', 'done'], { command: 'resolve-operation', operationId: OP, to: 'done' }],
    [['resolve-operation', '--to=rolled-back', OP], { command: 'resolve-operation', operationId: OP, to: 'rolled-back' }],
    [['resolve-operation', OP, '--tenant', A.toUpperCase()], { command: 'resolve-operation', operationId: OP, tenant: A }],
    [['--help'], 'help'],
    [['resolve-operation', '-h'], 'help'],
  ])('parses %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each<[string[], string]>([
    [[], 'missing subcommand'],
    [['resolve'], 'unknown subcommand "resolve"'],
    [['resolve-operation'], 'missing operation id'],
    [['resolve-operation', ''], 'missing operation id'],
    [['resolve-operation', OP, 'extra'], 'unexpected argument "extra"'],
    [['resolve-operation', OP, '--to', 'halted'], '--to must be one of rolled-back, done, got "halted"'],
    [['resolve-operation', OP, '--tenant', 'tenant-a'], '--tenant must be a tenant UUID, got "tenant-a"'],
    [['resolve-operation', OP, '--force'], "Unknown option '--force'"],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('rethrows a tenant check failure other than an invalid tenant id', () => {
    const failure = new TypeError('tenant check failed');
    mocks.assertTenantId.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => parseArgs(['resolve-operation', OP, '--tenant', A])).toThrow(failure);
  });
});

describe('main before any dependency opens', () => {
  it.each<[string[], string]>([
    [[], 'missing subcommand'],
    [['resolve'], 'unknown subcommand "resolve"'],
    [['resolve-operation'], 'missing operation id'],
    [['resolve-operation', 'OP-1', '--to', 'other'], '--to must be one of rolled-back, done, got "other"'],
    [['resolve-operation', 'OP-1', '--tenant', 'not-a-uuid'], '--tenant must be a tenant UUID, got "not-a-uuid"'],
  ])('exits 2 for %j with the reason and the usage line on stderr', async (argv, reason) => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    expect(await main(argv, cliEnv())).toBe(2);
    expect(stderr).toEqual([`opt2-people: ${reason}; usage: opt2-people resolve-operation <operationId> [--to rolled-back|done] [--tenant <uuid>]\n`]);
    expect(stdout).toEqual([]);
  });

  it('prints the help and exits 0', async () => {
    const stdout = captureWrites(process.stdout);
    expect(await main(['--help'], {})).toBe(0);
    expect(stdout.join('')).toContain('Exit codes: 0 the operation stands resolved');
  });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    ['an empty environment', {}, 'OPT2_SERVICE_NAME: is required'],
    ['no identity URL', cliEnv({ OPT2_SERVICE_URLS: '{}' }), 'OPT2_SERVICE_URLS: must name identity'],
    ['no database settings', cliEnv({ OPT2_DB_AUTH: undefined, PG_DATABASE: undefined }), 'PG_DATABASE: is required'],
    ['no local emulator', cliEnv({ PUBSUB_EMULATOR_HOST: undefined }), 'PUBSUB_EMULATOR_HOST: is required when OPT2_ENV=local'],
  ])('exits 2 for %s', async (_label, env, message) => {
    const stderr = captureWrites(process.stderr);
    expect(await main(['resolve-operation', 'OP-1'], env)).toBe(2);
    expect(stderr.join('')).toContain(message);
    expect(mocks.createPool).not.toHaveBeenCalled();
  });
});

const quietLogger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });

/** A before-image of a user who had no stored rows, as the people commit records one. */
const BEFORE_IMAGE = JSON.stringify({ existed: true, addresses: [], interests: [], tags: [], extendData: [] });

/** `tenant_registry` rows of tenants A and B in site order. */
const REGISTRY_ROWS = [TENANT_A, TENANT_B].map(({ tenantId, siteId }) => ({ tenant_id: tenantId, site_id: siteId }));

const REGISTRY_READ = /FROM "?people"?\."?tenant_registry"?/;
const ROSTER_READ = /^SELECT \* FROM "people"\."roster_operation" WHERE/;
const ROSTER_UPDATE = /^UPDATE "people"\."roster_operation" SET (.+) WHERE /;
const ROSTER_CLAIM = /^UPDATE "people"\."roster_operation" SET "claimed_by" = \$1, "updated_at" = \$2 WHERE/;
const CHANGELOG_INSERT = /^INSERT INTO "people"\."changelog"/;
const SET_TENANT = /set_config\('app\.tenant_id'/;

/** A recording `people` database whose registry lists tenants A and B and whose `roster_operation` holds one row that updates change. */
interface RosterDb {
  readonly db: RecordingDb;
  /** The held row of the operation in tenant A. */
  stored(operationId: string): RosterOperationRow | undefined;
  /** Tenant of every tenant transaction, in order; metadata transactions set an empty one. */
  tenantsRead(): string[];
}

function rosterDb(row: RosterOperationRow): RosterDb {
  const held = new Map([[`${row.tenant_id}/${row.operation_id}`, { ...row }]]);
  // Both the key read and the update end their parameters with the tenant and the operation id.
  const heldBy = (values: readonly unknown[]): RosterOperationRow | undefined => held.get(`${String(values.at(-2))}/${String(values.at(-1))}`);
  const db = createRecordingDb({
    responses: [
      [REGISTRY_READ, REGISTRY_ROWS],
      [ROSTER_READ, (_text, values) => [heldBy(values)].filter((row) => row !== undefined)],
      [
        ROSTER_UPDATE,
        (text, values) => {
          const updated = heldBy(values);
          if (updated === undefined) return [];
          for (const [, column, index] of (ROSTER_UPDATE.exec(text)?.[1] ?? '').matchAll(/"(\w+)" = \$(\d+)/g)) {
            Object.assign(updated, { [String(column)]: values[Number(index) - 1] });
          }
          return [updated];
        },
      ],
    ],
  });
  return {
    db,
    stored: (operationId) => held.get(`${A}/${operationId}`),
    tenantsRead: () => db.statements().flatMap(({ text, values }) => (SET_TENANT.test(text) && values[0] !== '' ? [String(values[0])] : [])),
  };
}

/** One operation of tenant A, its recording database and the identity double that holds identity's side of it. */
interface Scenario {
  readonly store: RosterDb;
  readonly identity: IdentityDouble;
  readonly operationId: string;
}

/** An operation of tenant A built from `overrides`, prepared at identity, or prepared and committed, as `identityState` names. */
async function scenario(overrides: Partial<RosterOperationRow>, identityState?: 'prepared' | 'committed'): Promise<Scenario> {
  const row = rosterOperationRow(overrides);
  const identity = createIdentityDouble();
  if (identityState !== undefined) {
    const account = { UserName: 'pat', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 as const };
    const prepared = await identity.identityClient.prepare(row.user_id, row.operation_id, { kind: 'create', siteId: SITE, account, groupIds: [] });
    expect(prepared).toMatchObject({ ok: true, state: 'prepared' });
    if (identityState === 'committed') await identity.identityClient.commit(row.user_id, row.operation_id);
  }
  return { store: rosterDb(row), identity, operationId: row.operation_id };
}

const preparedStarted = (): Promise<Scenario> => scenario({}, 'prepared');
const haltedCommitted = (): Promise<Scenario> => scenario({ state: 'halted', before_image: BEFORE_IMAGE }, 'committed');

/** The business clock moved past the recovery threshold, so every fixture operation is stale. */
function staleClock(): MutableClock {
  const clock = createMutableClock(TEST_CLOCK.now());
  clock.advance(STALE);
  return clock;
}

/** Recovery collaborators over the scenario's database and identity double, with the `people` outbox registered on it. */
function recordingDeps({ store, identity }: Scenario, clock: MutableClock = staleClock()): RecoveryDeps {
  const repo = createPeopleRepository({ clock, schema: store.db.schema });
  createOutbox({ service: 'people', db: store.db, publisher: createCapturingPublisher(), logger: quietLogger, clock, payloadValidators: peoplePayloadValidators });
  return { db: store.db, repo, identity: identity.identityClient, events: createPeopleEvents(repo), clock, logger: quietLogger };
}

function writeTexts(store: RosterDb): string[] {
  return store.db.writes().map(({ text }) => text);
}

describe('runResolveOperation over a recording database', () => {
  it('aborts identity and rolls back an operation identity only prepared, found in tenant A through the registry', async () => {
    const s = await preparedStarted();
    const clock = staleClock();
    const run = await runResolveOperation(recordingDeps(s, clock), { operationId: s.operationId });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: 'started', to: 'rolled-back', identityState: 'prepared', outcome: 'aborted' },
      settled: true,
    });
    expect(s.identity.operation(s.operationId)?.state).toBe('aborted');
    expect(s.store.stored(s.operationId)).toMatchObject({ state: 'rolled-back', identity_unreachable_since: null, updated_at: clock.now() });
    expect(s.store.db.statements().some(({ text }) => REGISTRY_READ.test(text))).toBe(true);
    expect(new Set(s.store.tenantsRead())).toEqual(new Set([A]));
    expect(writeTexts(s.store)).toContainEqual(expect.stringMatching(/^DELETE FROM \S*open_operation/));
  });

  it.each<[string, string | undefined, string[], RegExp]>([
    ['only tenant B under --tenant', TENANT_B.tenantId, [TENANT_B.tenantId], /is held by no row of tenant /],
    ['every registered tenant', undefined, [A, TENANT_B.tenantId], /is held by no registered tenant/],
  ])('throws OperationNotFoundError after searching %s, writing nothing', async (_label, tenant, searched, message) => {
    const s = await scenario({});
    const operationId = tenant === undefined ? cfUuid() : s.operationId;
    const run = runResolveOperation(recordingDeps(s), { operationId, ...(tenant === undefined ? {} : { tenant }) });
    await expect(run).rejects.toThrow(OperationNotFoundError);
    await expect(run).rejects.toThrow(message);
    expect(s.store.tenantsRead()).toEqual(searched);
    expect(s.store.db.statements().some(({ text }) => REGISTRY_READ.test(text))).toBe(tenant === undefined);
    expect(s.store.db.writes()).toEqual([]);
    expect(s.identity.requests).toEqual([]);
  });

  it('reports a halted operation without --to unchanged and unsettled, without calling identity or writing', async () => {
    const s = await haltedCommitted();
    const calls = s.identity.requests.length;
    const run = await runResolveOperation(recordingDeps(s), { operationId: s.operationId });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: 'halted', to: 'halted', identityState: null, outcome: 'unchanged' },
      settled: false,
    });
    expect(s.identity.requests).toHaveLength(calls);
    expect(s.store.db.writes()).toEqual([]);
  });

  it('finishes a halted operation with --to done once identity committed, releasing its held events', async () => {
    const s = await haltedCommitted();
    const run = await runResolveOperation(recordingDeps(s), { operationId: s.operationId, to: 'done', tenant: A });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: 'halted', to: 'done', identityState: 'committed', outcome: 'finished' },
      settled: true,
    });
    expect(s.identity.operation(s.operationId)?.state).toBe('finished');
    expect(s.store.stored(s.operationId)).toMatchObject({ state: 'done', error: null });
    expect(writeTexts(s.store)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^UPDATE \S*outbox"? SET held = false/), expect.stringMatching(/^DELETE FROM \S*open_operation/)]),
    );
  });

  it.each<ResolveTarget>(['rolled-back', 'done'])('fails with identity unreachable under --to %s, leaving the operation in its state', async (to) => {
    const s = await scenario({ state: 'people-committed', before_image: BEFORE_IMAGE }, 'committed');
    s.identity.setUnreachable(true);
    const calls = s.identity.requests.length;
    await expect(runResolveOperation(recordingDeps(s), { operationId: s.operationId, to })).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(s.store.stored(s.operationId)).toMatchObject({ state: 'people-committed', error: null, before_image: BEFORE_IMAGE, identity_unreachable_since: null });
    // The claim, with its changelog row, is the only write.
    expect(writeTexts(s.store).filter((text) => !CHANGELOG_INSERT.test(text))).toEqual([expect.stringMatching(ROSTER_CLAIM)]);
    expect(s.identity.requests.slice(calls).map((request) => request.operationId)).toEqual(['getAccountOperation']);
    expect(s.identity.operation(s.operationId)?.state).toBe('committed');
  });

  it.each<[string, Partial<RosterOperationRow>]>([
    ['a rolled-back operation', { state: 'rolled-back' }],
    ['a done operation', { state: 'done', before_image: BEFORE_IMAGE }],
  ])('reports %s without --to unchanged and settled', async (_label, overrides) => {
    const s = await scenario(overrides);
    const run = await runResolveOperation(recordingDeps(s), { operationId: s.operationId });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: overrides.state, to: overrides.state, identityState: null, outcome: 'unchanged' },
      settled: true,
    });
    expect(s.store.db.writes()).toEqual([]);
  });

  it('halts an operation whose identity stayed unreachable past the halt period, leaving it unsettled', async () => {
    const since = TEST_CLOCK.now();
    const s = await scenario({ state: 'people-committed', before_image: BEFORE_IMAGE, identity_unreachable_since: since }, 'committed');
    s.identity.setUnreachable(true);
    const clock = createMutableClock(since);
    clock.advance(HALT_AFTER_MS + 1);
    const run = await runResolveOperation(recordingDeps(s, clock), { operationId: s.operationId });
    expect(run).toEqual({
      report: { operationId: s.operationId, tenantId: A, from: 'people-committed', to: 'halted', identityState: null, outcome: 'halted' },
      settled: false,
    });
    expect(s.store.stored(s.operationId)).toMatchObject({ state: 'halted', identity_unreachable_since: since });
  });
});

const unreachable = (s: Scenario): void => s.identity.setUnreachable(true);

/** How one `main` run over a recording database is set up and what it prints. */
interface MainCase {
  setUp: () => Promise<Scenario>;
  flags: string[];
  /** Applied to the scenario before the run. */
  arrange?: (s: Scenario) => void;
  exit: number;
  /** The report line's fields; no stdout line when absent. */
  report?: Omit<ResolveReport, 'operationId' | 'tenantId'>;
  /** What stderr matches; nothing on stderr when absent. */
  stderr?: RegExp;
}

describe('main over a recording database', () => {
  it.each<[string, MainCase]>([
    ['a prepared operation found through the registry', { setUp: preparedStarted, flags: [], exit: 0, report: { from: 'started', to: 'rolled-back', identityState: 'prepared', outcome: 'aborted' } }],
    [
      'an operation tenant B does not hold',
      { setUp: preparedStarted, flags: ['--tenant', TENANT_B.tenantId], exit: 1, stderr: /^opt2-people: Roster operation \S+ is held by no row of tenant \S+\n$/ },
    ],
    [
      'a halted operation without --to',
      { setUp: haltedCommitted, flags: [], exit: 1, report: { from: 'halted', to: 'halted', identityState: null, outcome: 'unchanged' }, stderr: /^opt2-people: roster operation \S+ is halted; rerun with --to rolled-back or --to done\n$/ },
    ],
    ['a halted operation with --to done', { setUp: haltedCommitted, flags: ['--to', 'done'], exit: 0, report: { from: 'halted', to: 'done', identityState: 'committed', outcome: 'finished' } }],
    ['identity unreachable', { setUp: haltedCommitted, flags: ['--to', 'done'], arrange: unreachable, exit: 1, stderr: /^opt2-people: .*Service identity unavailable.*\n$/ }],
    [
      'an operation its request still holds',
      {
        setUp: () => scenario({ updated_at: new Date() }),
        flags: [],
        exit: 1,
        report: { from: 'started', to: 'started', identityState: null, outcome: 'unchanged' },
        stderr: /^opt2-people: roster operation \S+ is still started: its request or another resolution holds it, or identity is unreachable; rerun later\n$/,
      },
    ],
    [
      'a done operation whose finish identity cannot take',
      {
        setUp: () => scenario({ state: 'done', error: FINISH_PENDING_ERROR, before_image: BEFORE_IMAGE }, 'committed'),
        flags: [],
        arrange: unreachable,
        exit: 1,
        report: { from: 'done', to: 'done', identityState: null, outcome: 'unchanged' },
        stderr: /^opt2-people: roster operation \S+ is done but identity's finish is still pending; rerun later\n$/,
      },
    ],
    [
      'a database failure',
      {
        setUp: preparedStarted,
        flags: [],
        arrange: (s) =>
          s.store.db.respond(ROSTER_CLAIM, () => {
            throw new Error('database down');
          }),
        exit: 1,
        stderr: /opt2-people resolve-operation failed/,
      },
    ],
  ])('runs %s: its exit code and output lines, and the pool closed', async (_label, c) => {
    const s = await c.setUp();
    c.arrange?.(s);
    const end = vi.spyOn(s.store.db, 'end');
    mocks.createPool.mockResolvedValueOnce(s.store.db);
    mocks.createPublisher.mockReturnValueOnce(createCapturingPublisher());
    mocks.createIdentityClient.mockReturnValueOnce(s.identity.identityClient);
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    expect(await main(['resolve-operation', s.operationId, ...c.flags], cliEnv())).toBe(c.exit);
    expect(stdout.map((line) => JSON.parse(line) as unknown)).toEqual(
      c.report === undefined ? [] : [{ operationId: s.operationId, tenantId: A, ...c.report }],
    );
    if (c.stderr === undefined) expect(stderr).toEqual([]);
    else expect(stderr.join('')).toMatch(c.stderr);
    expect(end).toHaveBeenCalledOnce();
  });
});
