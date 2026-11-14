/** Roster recovery over the recording database and the identity double: thresholds, the sweep hook, the state matrix, halting, operator runs and claim races. */
import { describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { encodeRow } from '@opt2/platform/migration-kit';
import { createOutbox, type OutboxRuntime, type RecoveryContext } from '@opt2/platform/outbox';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, createCapturingPublisher, type CapturingPublisher } from '@opt2/platform/testing';
import type { BeforeImage } from '../../src/domain/roster-protocol.js';
import {
  HALT_AFTER_MS,
  RECOVERY_THRESHOLD_MS,
  RosterRecoveryError,
  RosterResolutionError,
  resolveOperation,
  rosterRecoveryHook,
  type RecoveryDeps,
  type ResolveOutcome,
  type ResolveTarget,
} from '../../src/domain/roster-recovery.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import type { AccountOperationState, AccountPrepareRequest } from '../../src/legacy/identity-client.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import { FINISH_PENDING_ERROR, PERSON, type PersonRow, type RosterOperationRow, type RosterState } from '../../src/repo/tables.js';
import { PG_AVAILABLE, createMutableClock, createRecordingDb, withPgApp, type MutableClock, type RecordedStatement, type RecordingDb } from '../helpers/app.js';
import { createIdentityDouble, type IdentityDouble } from '../helpers/identity-double.js';
import { accountFor, personRow, rosterOperationRow } from '../helpers/fixtures.js';

const A = TENANT_A.tenantId;
const B = TENANT_B.tenantId;
const PERSON_CHANGED_TOPIC = 'people.person.changed.v1';
const OTHER_RESOLVER = 'OTHER-RESOLVER-0000-000000000000001';
/** Age of a stale operation: just past the recovery threshold. */
const STALE_MS = RECOVERY_THRESHOLD_MS + 1_000;

/** The account part of a roster update, as identity's prepare takes it. */
const CHANGE: AccountPrepareRequest = {
  kind: 'update',
  siteId: TENANT_A.siteId,
  account: { UserName: 'jdoe', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 },
  groupIds: [],
};

type Row = Record<string, unknown>;

/** An outbox row as the recording database stores and answers it. */
type OutboxRow = {
  seq: string;
  tenant_id: string;
  event_id: string;
  topic: string;
  kind: string;
  ordering_key: string;
  envelope: unknown;
  operation_id: string | null;
  held: boolean;
  created_at: string;
  published_at: string | null;
};

/** A char(35) id as people compares it: case-insensitive, trailing spaces ignored. */
function charKey(value: unknown): string {
  return String(value).replace(/ +$/, '').toUpperCase();
}

function sameTenant(row: Row, tenantId: unknown): boolean {
  return String(row.tenant_id).toLowerCase() === String(tenantId).toLowerCase();
}

/** The `"column" = $n` assignments of a SQL fragment as column to bound value. */
function assignments(fragment: string, values: readonly unknown[]): Row {
  return Object.fromEntries([...fragment.matchAll(/"?(\w+)"? = \$(\d+)/g)].map(([, column, index]) => [column, values[Number(index) - 1]]));
}

/** Rows of a keyed people table that the recording database reads, locks and updates in place; `onLock` sees each row a `FOR UPDATE` read returns. */
interface KeyedTable<R extends Row> {
  put(row: R): R;
  get(key: string): R | undefined;
  onLock?: (row: R) => void;
}

type ListSelect<R> = (text: string, values: readonly unknown[], rows: readonly R[]) => readonly R[] | undefined;

function keyedTable<R extends Row>(db: RecordingDb, table: string, key: keyof R & string, list?: ListSelect<R>): KeyedTable<R> {
  const rows = new Map<string, R>();
  const model: KeyedTable<R> = {
    put(row) {
      rows.set(charKey(row[key]), row);
      return row;
    },
    get: (id) => rows.get(charKey(id)),
  };
  db.respond(new RegExp(`"people"\\."${table}"(?![\\w"])`), (text, values) => {
    if (text.startsWith('UPDATE ')) {
      const where = assignments(text.slice(text.indexOf(' WHERE ')), values);
      const row = model.get(String(where[key]));
      if (row === undefined || !sameTenant(row, where.tenant_id)) return [];
      Object.assign(row, assignments(text.slice(text.indexOf(' SET '), text.indexOf(' WHERE ')), values));
      return [row];
    }
    if (!text.startsWith('SELECT ')) return [];
    const listed = list?.(text, values, [...rows.values()]);
    if (listed !== undefined) return listed;
    const row = model.get(String(values[1]));
    if (row === undefined || !sameTenant(row, values[0])) return [];
    if (text.endsWith(' FOR UPDATE')) model.onLock?.(row);
    return [row];
  });
  return model;
}

/** `listStaleRosterOperations`' page: recoverable or finish-pending rows of the tenant updated before `$3`, oldest first. */
const staleRosterPage: ListSelect<RosterOperationRow> = (text, values, rows) => {
  if (!text.includes(' updated_at < $3')) return undefined;
  const [tenantId, states, olderThan, afterAt, afterId, take, pending] = values as [string, string[], Date, Date | null, string | null, number, string];
  const after = (row: RosterOperationRow): boolean =>
    afterAt === null || row.updated_at > afterAt || (row.updated_at.getTime() === afterAt.getTime() && row.operation_id > String(afterId));
  return rows
    .filter((row) => sameTenant(row, tenantId) && (states.includes(row.state) || (row.state === 'done' && row.error === pending)))
    .filter((row) => row.updated_at < olderThan && after(row))
    .sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime() || a.operation_id.localeCompare(b.operation_id))
    .slice(0, take);
};

/** The people outbox: writes, the operation hold, its release and discard, and the in-request flush's selection and stamp. */
function outboxTable(db: RecordingDb): OutboxRow[] {
  const rows: OutboxRow[] = [];
  const ofOperation = (operationId: unknown): OutboxRow[] => rows.filter((row) => row.operation_id === operationId && row.held);
  db.respond(/"people"\.outbox(?!\w)/, (text, values) => {
    if (text.startsWith('INSERT ')) {
      const [tenant_id, event_id, topic, kind, ordering_key, envelope, operation_id, held, created_at] = values as [
        string, string, string, string, string, string, string | null, boolean, string,
      ];
      rows.push({ seq: String(rows.length + 1), tenant_id, event_id, topic, kind, ordering_key, envelope: JSON.parse(envelope), operation_id, held, created_at, published_at: null });
      return [];
    }
    if (text.startsWith('UPDATE ') && text.includes(' SET held = false ')) {
      const released = ofOperation(values[0]);
      for (const row of released) row.held = false;
      return released.map((row) => ({ event_id: row.event_id }));
    }
    if (text.startsWith('UPDATE ') && text.includes(' SET published_at = $1 ')) {
      for (const row of rows) if ((values[1] as string[]).includes(row.event_id) && row.published_at === null) row.published_at = String(values[0]);
      return [];
    }
    if (text.startsWith('DELETE ')) {
      const discarded = ofOperation(values[0]);
      rows.splice(0, rows.length, ...rows.filter((row) => !discarded.includes(row)));
      return discarded;
    }
    if (text.startsWith('SELECT o.* ')) return rows.filter((row) => (values[0] as string[]).includes(row.event_id) && !row.held && row.published_at === null);
    return [];
  });
  return rows;
}

/** One recovery world: the recording database with its table models, the identity double, a capturing outbox and a mutable clock. */
interface World {
  db: RecordingDb;
  clock: MutableClock;
  identity: IdentityDouble;
  publisher: CapturingPublisher;
  runtime: OutboxRuntime;
  deps: RecoveryDeps;
  operations: KeyedTable<RosterOperationRow>;
  persons: KeyedTable<PersonRow>;
  outbox: OutboxRow[];
  lines: string[];
}

function world(): World {
  const db = createRecordingDb();
  const clock = createMutableClock();
  const lines: string[] = [];
  const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: (line: string) => void lines.push(line) } });
  const publisher = createCapturingPublisher();
  const runtime = createOutbox({ service: 'people', db, publisher, logger, clock });
  const repo = createPeopleRepository({ clock, schema: db.schema });
  const identity = createIdentityDouble({ clock });
  const deps: RecoveryDeps = { db, repo, identity: identity.identityClient, events: createPeopleEvents(repo), clock, logger };
  return {
    db,
    clock,
    identity,
    publisher,
    runtime,
    deps,
    operations: keyedTable<RosterOperationRow>(db, 'roster_operation', 'operation_id', staleRosterPage),
    persons: keyedTable<PersonRow>(db, 'person', 'userid'),
    outbox: outboxTable(db),
    lines,
  };
}

/** `ms` before the world's clock. */
function ago(w: World, ms: number): Date {
  return new Date(w.clock.now().getTime() - ms);
}

/** The before-image a people commit stores for an update of `person`. */
function imageOf(person: PersonRow): string {
  const image: BeforeImage = { existed: true, person, addresses: [], interests: [], tags: [], extendData: [] };
  return JSON.stringify(image);
}

type PeopleStage = 'started' | 'people-committed' | 'done';

/**
 * A stale operation stored at `stage`, then `overrides`; past `started` the person row holds the committed update, and a
 * people-committed operation also holds its person event. The recording is cleared afterwards.
 */
async function storedOperation(w: World, stage: PeopleStage, overrides: Partial<RosterOperationRow> = {}): Promise<{ operation: RosterOperationRow; before: PersonRow }> {
  const before = personRow();
  const committed: PersonRow = { ...before, fname: 'Robin', row_version: '2' };
  const operation = w.operations.put(
    rosterOperationRow({
      user_id: before.userid,
      state: stage,
      updated_at: ago(w, STALE_MS),
      ...(stage === 'started' ? {} : { before_image: imageOf(before) }),
      ...(stage === 'done' ? { error: FINISH_PENDING_ERROR } : {}),
      ...overrides,
    }),
  );
  if (stage !== 'started') w.persons.put(committed);
  if (stage === 'people-committed') {
    await w.db.withTenant(A, (tx) => w.deps.events.publishPersonChanged(tx, committed, { operationId: operation.operation_id }));
  }
  w.db.clear();
  return { operation, before };
}

type IdentityStage = 'unknown' | 'prepared' | 'committed' | 'aborted' | 'reverted' | 'finished';

/** Drives identity's record of the operation to `stage` through its own endpoints. */
async function stageIdentity(w: World, operation: RosterOperationRow, stage: IdentityStage): Promise<void> {
  if (stage === 'unknown') return;
  const client = w.identity.identityClient;
  const { user_id: userId, operation_id: operationId } = operation;
  w.identity.seedAccounts(accountFor({ userid: userId, siteid: TENANT_A.siteId, email: null }));
  await client.prepare(userId, operationId, CHANGE);
  if (stage === 'aborted') await client.abort(userId, operationId);
  if (stage === 'committed' || stage === 'reverted' || stage === 'finished') await client.commit(userId, operationId);
  if (stage === 'reverted') await client.revert(userId, operationId);
  if (stage === 'finished') await client.finish(userId, operationId);
}

function resolve(w: World, operation: RosterOperationRow, to?: ResolveTarget): Promise<ResolveOutcome> {
  return resolveOperation(w.deps, { tenantId: operation.tenant_id, operationId: operation.operation_id, ...(to === undefined ? {} : { to }) });
}

/** Identity calls after the first `mark` requests, as `[contract operation, status]`. */
function callsSince(w: World, mark: number): Array<[string | undefined, number | undefined]> {
  return w.identity.requests.slice(mark).map((request) => [request.operationId, request.response?.status]);
}

function personWrites(w: World): RecordedStatement[] {
  return w.db.writes().filter((statement) => /"people"\."person"(?![\w"])/.test(statement.text));
}

function rosterUpdates(w: World): RecordedStatement[] {
  return w.db.writes().filter((statement) => statement.text.startsWith('UPDATE "people"."roster_operation"'));
}

/** Whether recovery removed the operation's open-operation registration, reopening its units. */
function ended(w: World, operation: RosterOperationRow): boolean {
  return w.db.writes().some((statement) => statement.text.includes('"open_operation"') && statement.values[0] === operation.operation_id);
}

function stateOf(w: World, operation: RosterOperationRow): RosterOperationRow | undefined {
  return w.operations.get(operation.operation_id);
}

describe('recovery thresholds', () => {
  it('claims operations unchanged for 30 s and halts them after 5 min of identity unreachability', () => {
    expect(RECOVERY_THRESHOLD_MS).toBe(30_000);
    expect(HALT_AFTER_MS).toBe(300_000);
  });
});

describe('the roster-operations recovery hook', () => {
  /** Registry rows of `tenantIds`, in that order. */
  function registry(w: World, tenantIds: readonly string[]): void {
    w.db.respond(/ FROM people\.tenant_registry /, tenantIds.map((tenantId, index) => ({ tenant_id: tenantId, site_id: `site-${String(index)}` })));
  }

  function context(w: World): RecoveryContext {
    return { service: 'people', runtime: w.runtime, clock: w.clock, logger: w.deps.logger };
  }

  it('is the sweep hook named roster-operations', () => {
    expect(rosterRecoveryHook(world().deps).name).toBe('roster-operations');
  });

  it('visits each registry tenant once and resolves only operations older than the threshold', async () => {
    const w = world();
    registry(w, [A, A.toUpperCase(), B]);
    const { operation: fresh } = await storedOperation(w, 'started', { updated_at: ago(w, RECOVERY_THRESHOLD_MS - 1_000) });
    const { operation: stale } = await storedOperation(w, 'started', { updated_at: ago(w, RECOVERY_THRESHOLD_MS + 1_000) });
    const { operation: otherTenant } = await storedOperation(w, 'started', { tenant_id: B });

    await expect(rosterRecoveryHook(w.deps).run(context(w))).resolves.toBeUndefined();

    const listings = w.db.statements().filter((statement) => statement.text.includes(' updated_at < $3'));
    expect(listings.map((statement) => statement.values[0])).toEqual([A, B]);
    for (const listing of listings) expect(listing.values[2]).toEqual(ago(w, RECOVERY_THRESHOLD_MS));
    expect(stateOf(w, fresh)).toMatchObject({ state: 'started', claimed_by: null, updated_at: fresh.updated_at });
    expect(stateOf(w, stale)).toMatchObject({ state: 'rolled-back' });
    expect(stateOf(w, otherTenant)).toMatchObject({ state: 'rolled-back' });
  });

  it('tries every stale operation, counts halted, resolved and failed ones, logs each failure and then fails the sweep', async () => {
    const w = world();
    registry(w, [B, A, A.toUpperCase()]);
    const { operation: halting } = await storedOperation(w, 'started', {
      tenant_id: B,
      updated_at: ago(w, 50_000),
      identity_unreachable_since: ago(w, HALT_AFTER_MS + 1_000),
    });
    const { operation: unreachable } = await storedOperation(w, 'started', { updated_at: ago(w, 50_000) });
    const { operation: resolvable } = await storedOperation(w, 'started', { updated_at: ago(w, 45_000) });
    const { operation: refused } = await storedOperation(w, 'done', { updated_at: ago(w, 40_000) });
    await stageIdentity(w, refused, 'prepared');
    w.identity.failAt('status', 'unreachable', { times: 2 });

    const failure: unknown = await rosterRecoveryHook(w.deps).run(context(w)).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(RosterRecoveryError);
    expect(failure).toMatchObject({ counts: { resolved: 1, halted: 1, failed: 1 } });
    expect(w.lines.filter((line) => line.includes(`roster operation ${refused.operation_id} recovery failed`))).toHaveLength(1);
    expect(stateOf(w, halting)).toMatchObject({ state: 'halted' });
    expect(stateOf(w, unreachable)).toMatchObject({ state: 'started', identity_unreachable_since: w.clock.now() });
    expect(stateOf(w, resolvable)).toMatchObject({ state: 'rolled-back' });
    expect(stateOf(w, refused)).toMatchObject({ state: 'done', error: FINISH_PENDING_ERROR });
  });
});

/** One resolution from both sides' recorded states to their final ones. */
interface MatrixCase {
  label: string;
  people: PeopleStage;
  identity: IdentityStage;
  to?: ResolveTarget;
  outcome: { to: RosterState; action: ResolveOutcome['action']; identityState?: AccountOperationState };
  calls: Array<[string, number]>;
  identityAfter: IdentityStage;
  restored: boolean;
  published: boolean;
}

const STATUS = ['getAccountOperation', 200] as [string, number];
const ABORT = ['abortAccountOperation', 200] as [string, number];
const REVERT = ['revertAccountOperation', 200] as [string, number];
const FINISH = ['finishAccountOperation', 200] as [string, number];

describe('resolveOperation state matrix', () => {
  it.each<MatrixCase>([
    {
      label: 'aborts identity for a started operation identity prepared, writing no person row',
      people: 'started',
      identity: 'prepared',
      outcome: { to: 'rolled-back', action: 'aborted', identityState: 'prepared' },
      calls: [STATUS, ABORT],
      identityAfter: 'aborted',
      restored: false,
      published: false,
    },
    {
      label: 'rolls back a started operation identity never recorded, its abort answered as already done',
      people: 'started',
      identity: 'unknown',
      outcome: { to: 'rolled-back', action: 'aborted' },
      calls: [STATUS, ['abortAccountOperation', 409]],
      identityAfter: 'unknown',
      restored: false,
      published: false,
    },
    {
      label: 'repeats the abort of a started operation identity already aborted',
      people: 'started',
      identity: 'aborted',
      outcome: { to: 'rolled-back', action: 'aborted', identityState: 'aborted' },
      calls: [STATUS, ABORT],
      identityAfter: 'aborted',
      restored: false,
      published: false,
    },
    {
      label: 'restores the before-image and aborts identity for a people-committed operation identity still prepared',
      people: 'people-committed',
      identity: 'prepared',
      outcome: { to: 'rolled-back', action: 'aborted', identityState: 'prepared' },
      calls: [STATUS, ABORT],
      identityAfter: 'aborted',
      restored: true,
      published: false,
    },
    // A people-committed operation means its request answered 503, so recovery rolls both sides back; only an operator rolls it forward.
    {
      label: 'restores the before-image and reverts identity for a people-committed operation identity committed',
      people: 'people-committed',
      identity: 'committed',
      outcome: { to: 'rolled-back', action: 'reverted', identityState: 'committed' },
      calls: [STATUS, REVERT],
      identityAfter: 'reverted',
      restored: true,
      published: false,
    },
    {
      label: 'repeats the revert of a people-committed operation identity already reverted',
      people: 'people-committed',
      identity: 'reverted',
      outcome: { to: 'rolled-back', action: 'reverted', identityState: 'reverted' },
      calls: [STATUS, REVERT],
      identityAfter: 'reverted',
      restored: true,
      published: false,
    },
    {
      label: 'restores the before-image and reverts identity when an operator rolls a committed operation back',
      people: 'people-committed',
      identity: 'committed',
      to: 'rolled-back',
      outcome: { to: 'rolled-back', action: 'reverted', identityState: 'committed' },
      calls: [STATUS, REVERT],
      identityAfter: 'reverted',
      restored: true,
      published: false,
    },
    {
      label: 'finishes both sides and publishes the held event when an operator rolls a committed operation forward',
      people: 'people-committed',
      identity: 'committed',
      to: 'done',
      outcome: { to: 'done', action: 'finished', identityState: 'committed' },
      calls: [STATUS, FINISH],
      identityAfter: 'finished',
      restored: false,
      published: true,
    },
    {
      label: 'rolls people forward and publishes the held event without a step once identity has finished',
      people: 'people-committed',
      identity: 'finished',
      outcome: { to: 'done', action: 'finished', identityState: 'finished' },
      calls: [STATUS],
      identityAfter: 'finished',
      restored: false,
      published: true,
    },
    {
      label: "repeats the lost finish of a done operation, which stays done",
      people: 'done',
      identity: 'committed',
      outcome: { to: 'done', action: 'finished', identityState: 'committed' },
      calls: [STATUS, FINISH],
      identityAfter: 'finished',
      restored: false,
      published: false,
    },
    {
      label: 'clears the pending finish of a done operation identity has finished',
      people: 'done',
      identity: 'finished',
      outcome: { to: 'done', action: 'finished', identityState: 'finished' },
      calls: [STATUS],
      identityAfter: 'finished',
      restored: false,
      published: false,
    },
  ])('$label', async (c) => {
    const w = world();
    const { operation, before } = await storedOperation(w, c.people);
    await stageIdentity(w, operation, c.identity);
    const mark = w.identity.requests.length;

    const outcome = await resolve(w, operation, c.to);

    expect(outcome).toEqual({ operationId: operation.operation_id, from: c.people, ...c.outcome });
    expect(callsSince(w, mark)).toEqual(c.calls);
    expect(w.identity.operation(operation.operation_id)?.state ?? 'unknown').toBe(c.identityAfter);
    expect(stateOf(w, operation)).toMatchObject({ state: c.outcome.to, error: null, identity_unreachable_since: null });
    expect(ended(w, operation)).toBe(true);
    if (c.restored) expect(w.persons.get(before.userid)).toEqual({ ...before, row_version: '3' });
    else expect(personWrites(w)).toEqual([]);
    const held = w.outbox.filter((row) => row.operation_id === operation.operation_id);
    if (c.published) {
      expect(held).toMatchObject([{ held: false, published_at: expect.any(String) }]);
      expect(w.publisher.published.map(({ topic, envelope }) => [topic, envelope.aggregateId])).toEqual([[PERSON_CHANGED_TOPIC, before.userid]]);
    } else {
      expect(held).toEqual([]);
      expect(w.publisher.published).toEqual([]);
    }
  });
});

describe('halting', () => {
  it('records identity unreachable, keeps the operation open below HALT_AFTER_MS and halts it past that, the user staying closed', async () => {
    const w = world();
    const { operation } = await storedOperation(w, 'people-committed');
    await stageIdentity(w, operation, 'prepared');
    w.identity.setUnreachable(true);
    const since = w.clock.now();
    const open = { operationId: operation.operation_id, from: 'people-committed', to: 'people-committed', action: 'unchanged' };

    expect(await resolve(w, operation)).toEqual(open);
    expect(stateOf(w, operation)).toMatchObject({ state: 'people-committed', identity_unreachable_since: since });

    w.clock.advance(HALT_AFTER_MS - STALE_MS);
    w.db.clear();
    expect(await resolve(w, operation)).toEqual(open);
    expect(rosterUpdates(w)).toHaveLength(1);
    expect(stateOf(w, operation)).toMatchObject({ state: 'people-committed', identity_unreachable_since: since });

    w.clock.advance(STALE_MS + 1);
    expect(await resolve(w, operation)).toEqual({ ...open, to: 'halted', action: 'halted' });
    expect(stateOf(w, operation)).toMatchObject({ state: 'halted', identity_unreachable_since: since });
    expect(ended(w, operation)).toBe(false);
    expect(w.identity.isUserClosed(operation.user_id)).toBe(true);
    expect(personWrites(w)).toEqual([]);
    expect(w.publisher.published).toEqual([]);
    const halted = `roster operation ${operation.operation_id} of user ${operation.user_id} halted: identity unreachable since ${since.toISOString()}`;
    expect(w.lines.filter((line) => line.includes(halted))).toHaveLength(1);
  });

  it('never halts a done operation whose finish is pending, however long identity stays unreachable', async () => {
    const w = world();
    const since = ago(w, HALT_AFTER_MS + 1_000);
    const { operation } = await storedOperation(w, 'done', { identity_unreachable_since: since });
    w.identity.setUnreachable(true);

    expect(await resolve(w, operation)).toEqual({ operationId: operation.operation_id, from: 'done', to: 'done', action: 'unchanged' });
    expect(stateOf(w, operation)).toMatchObject({ state: 'done', error: FINISH_PENDING_ERROR, identity_unreachable_since: since });
    expect(rosterUpdates(w)).toHaveLength(1);
  });

  it('restarts the unreachable period when identity answered earlier in the same run', async () => {
    const w = world();
    const { operation } = await storedOperation(w, 'started', { identity_unreachable_since: ago(w, HALT_AFTER_MS + 1_000) });
    await stageIdentity(w, operation, 'prepared');
    w.identity.failAt('abort', 'unreachable');

    expect(await resolve(w, operation)).toEqual({
      operationId: operation.operation_id,
      from: 'started',
      to: 'started',
      action: 'unchanged',
      identityState: 'prepared',
    });
    expect(stateOf(w, operation)).toMatchObject({ state: 'started', identity_unreachable_since: w.clock.now() });
    expect(w.identity.operation(operation.operation_id)?.state).toBe('prepared');
  });

  /** A halted operation, updated just now, that identity recorded at `identity`. */
  async function haltedOperation(w: World, identity: IdentityStage): Promise<{ operation: RosterOperationRow; before: PersonRow }> {
    const halted = await storedOperation(w, 'people-committed', {
      state: 'halted',
      updated_at: w.clock.now(),
      identity_unreachable_since: ago(w, HALT_AFTER_MS + 1_000),
    });
    await stageIdentity(w, halted.operation, identity);
    return halted;
  }

  it('leaves a halted operation alone until an operator names its target', async () => {
    const w = world();
    const { operation } = await haltedOperation(w, 'prepared');
    const mark = w.identity.requests.length;

    expect(await resolve(w, operation)).toEqual({ operationId: operation.operation_id, from: 'halted', to: 'halted', action: 'unchanged' });
    expect(callsSince(w, mark)).toEqual([]);
    expect(w.db.writes()).toEqual([]);
  });

  it.each<[ResolveTarget, IdentityStage, ResolveOutcome['action'], Array<[string, number]>, boolean]>([
    ['rolled-back', 'prepared', 'aborted', [STATUS, ABORT], false],
    ['rolled-back', 'committed', 'reverted', [STATUS, REVERT], false],
    ['done', 'committed', 'finished', [STATUS, FINISH], true],
  ])('resolves a halted operation to %s at once when identity recorded it %s', async (to, identity, action, calls, published) => {
    const w = world();
    const { operation, before } = await haltedOperation(w, identity);
    const mark = w.identity.requests.length;

    expect(await resolve(w, operation, to)).toEqual({ operationId: operation.operation_id, from: 'halted', to, action, identityState: identity });
    expect(callsSince(w, mark)).toEqual(calls);
    expect(stateOf(w, operation)).toMatchObject({ state: to, error: null, identity_unreachable_since: null });
    expect(ended(w, operation)).toBe(true);
    expect(w.persons.get(before.userid)).toEqual(to === 'rolled-back' ? { ...before, row_version: '3' } : { ...before, fname: 'Robin', row_version: '2' });
    expect(w.publisher.published).toHaveLength(published ? 1 : 0);
  });

  it("fails an operator's run while identity is unreachable and leaves the halted operation as it was", async () => {
    const w = world();
    const { operation } = await haltedOperation(w, 'prepared');
    const since = operation.identity_unreachable_since;
    w.identity.setUnreachable(true);

    await expect(resolve(w, operation, 'rolled-back')).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(stateOf(w, operation)).toMatchObject({ state: 'halted', identity_unreachable_since: since });
    expect(ended(w, operation)).toBe(false);
    expect(personWrites(w)).toEqual([]);
  });
});

/** An operation whose recorded states refuse the resolution. */
interface RefusalCase {
  label: string;
  people: PeopleStage;
  overrides?: Partial<RosterOperationRow>;
  identity: IdentityStage;
  to?: ResolveTarget;
  message: RegExp;
  calls: Array<[string, number]>;
}

describe('refused resolutions', () => {
  it('refuses an operation the tenant does not hold', async () => {
    const w = world();
    const operationId = cfUuid();
    const attempt = resolveOperation(w.deps, { tenantId: A, operationId });
    await expect(attempt).rejects.toBeInstanceOf(RosterResolutionError);
    await expect(attempt).rejects.toMatchObject({ operationId, message: `Roster operation ${operationId} is not held by tenant ${A}` });
  });

  it.each<RefusalCase>([
    {
      label: 'a rolled-back operation an operator rolls forward',
      people: 'started',
      overrides: { state: 'rolled-back' },
      identity: 'aborted',
      to: 'done',
      message: /in state rolled-back cannot resolve to done while identity reports unknown$/,
      calls: [],
    },
    {
      label: 'a finished operation an operator rolls back',
      people: 'done',
      overrides: { error: null },
      identity: 'finished',
      to: 'rolled-back',
      message: /in state done cannot resolve to rolled-back/,
      calls: [],
    },
    {
      label: 'a done operation with its finish pending that an operator rolls back',
      people: 'done',
      identity: 'committed',
      to: 'rolled-back',
      message: /in state done cannot resolve to rolled-back/,
      calls: [],
    },
    {
      label: 'a started operation an operator rolls forward before people committed',
      people: 'started',
      identity: 'prepared',
      to: 'done',
      message: /in state started cannot resolve to done while identity reports prepared$/,
      calls: [STATUS],
    },
    {
      label: 'a people-committed operation an operator rolls forward while identity is still prepared',
      people: 'people-committed',
      identity: 'prepared',
      to: 'done',
      message: /in state people-committed cannot resolve to done while identity reports prepared$/,
      calls: [STATUS],
    },
    {
      label: 'a people-committed operation an operator rolls back after identity finished',
      people: 'people-committed',
      identity: 'finished',
      to: 'rolled-back',
      message: /in state people-committed cannot resolve to rolled-back while identity reports finished$/,
      calls: [STATUS],
    },
    {
      label: 'a done operation identity reports prepared, even without an operator',
      people: 'done',
      identity: 'prepared',
      message: /in state done cannot resolve to done while identity reports prepared$/,
      calls: [STATUS],
    },
    {
      label: "an operator's run on an operation its request still holds",
      people: 'started',
      overrides: { updated_at: new Date(createMutableClock().now().getTime() - 1_000) },
      identity: 'prepared',
      to: 'rolled-back',
      message: /is held by its request or another resolution$/,
      calls: [],
    },
  ])('refuses $label, changing neither side', async (c) => {
    const w = world();
    const { operation } = await storedOperation(w, c.people, c.overrides);
    await stageIdentity(w, operation, c.identity);
    const recorded = { ...operation };
    const identityBefore = w.identity.operation(operation.operation_id)?.state;
    const mark = w.identity.requests.length;

    const attempt = resolve(w, operation, c.to);
    await expect(attempt).rejects.toBeInstanceOf(RosterResolutionError);
    await expect(attempt).rejects.toMatchObject({ operationId: operation.operation_id, message: expect.stringMatching(c.message) });
    expect(callsSince(w, mark)).toEqual(c.calls);
    expect(w.identity.operation(operation.operation_id)?.state).toBe(identityBefore);
    expect(stateOf(w, operation)).toMatchObject({ state: recorded.state, error: recorded.error, identity_unreachable_since: recorded.identity_unreachable_since });
    expect(ended(w, operation)).toBe(false);
    expect(personWrites(w)).toEqual([]);
    expect(w.publisher.published).toEqual([]);
  });

  it.each<[string, PeopleStage, Partial<RosterOperationRow>, ResolveTarget | undefined]>([
    ['a rolled-back operation', 'started', { state: 'rolled-back' }, undefined],
    ['a rolled-back operation an operator rolls back', 'started', { state: 'rolled-back' }, 'rolled-back'],
    ['a finished operation', 'done', { error: null }, undefined],
    ['a finished operation an operator rolls forward', 'done', { error: null }, 'done'],
    ['an operation its request still holds', 'started', { updated_at: new Date(createMutableClock().now().getTime() - 1_000) }, undefined],
  ])('leaves %s unchanged without calling identity or writing', async (_label, people, overrides, to) => {
    const w = world();
    const { operation } = await storedOperation(w, people, overrides);
    const state = operation.state;

    expect(await resolve(w, operation, to)).toEqual({ operationId: operation.operation_id, from: state, to: state, action: 'unchanged' });
    expect(w.identity.requests).toEqual([]);
    expect(w.db.writes()).toEqual([]);
  });
});

describe('claim races', () => {
  it.each<[string, ResolveTarget | undefined]>([
    ['a sweep leaves', undefined],
    ['an operator is refused', 'rolled-back'],
  ])('%s an operation another resolver took over after the claim, touching neither side', async (_label, to) => {
    const w = world();
    const { operation } = await storedOperation(w, 'people-committed');
    await stageIdentity(w, operation, 'prepared');
    w.operations.onLock = (row) => {
      if (row.claimed_by !== null) row.claimed_by = OTHER_RESOLVER;
    };
    const mark = w.identity.requests.length;

    const attempt = resolve(w, operation, to);
    if (to === undefined) {
      expect(await attempt).toEqual({ operationId: operation.operation_id, from: 'people-committed', to: 'people-committed', action: 'unchanged' });
    } else {
      await expect(attempt).rejects.toBeInstanceOf(RosterResolutionError);
      await expect(attempt).rejects.toMatchObject({ message: expect.stringMatching(/is held by its request or another resolution$/) });
    }
    expect(callsSince(w, mark)).toEqual([STATUS]);
    expect(w.identity.operation(operation.operation_id)?.state).toBe('prepared');
    expect(stateOf(w, operation)).toMatchObject({ state: 'people-committed', claimed_by: OTHER_RESOLVER });
    expect(personWrites(w)).toEqual([]);
    expect(w.outbox.filter((row) => row.operation_id === operation.operation_id && row.held)).toHaveLength(1);
  });

  it.each<[ResolveTarget | undefined]>([[undefined], ['done']])(
    'leaves a done operation its request finished between the read and the claim (to %s)',
    async (to) => {
      const w = world();
      const { operation } = await storedOperation(w, 'done');
      await stageIdentity(w, operation, 'finished');
      w.operations.onLock = (row) => {
        row.error = null;
      };
      const mark = w.identity.requests.length;

      expect(await resolve(w, operation, to)).toEqual({ operationId: operation.operation_id, from: 'done', to: 'done', action: 'unchanged' });
      expect(callsSince(w, mark)).toEqual([]);
      expect(ended(w, operation)).toBe(false);
    },
  );
});

describe.skipIf(!PG_AVAILABLE)('roster recovery against PostgreSQL', () => {
  it('rolls a people-committed operation identity still prepared back to its before-image byte for byte', async () => {
    const result = await withPgApp(async ({ db, identity }) => {
      const clock = createMutableClock();
      const lines: string[] = [];
      const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: (line: string) => void lines.push(line) } });
      const repo = createPeopleRepository({ clock, schema: db.schema });
      const deps: RecoveryDeps = { db, repo, identity: identity.identityClient, events: createPeopleEvents(repo), clock, logger };
      const before = await db.withTenant(A, (tx) => repo.insert<PersonRow>(tx, PERSON.table, personRow()));
      const operation = await db.withTenant(A, async (tx) => {
        const started = await repo.insertRosterOperation(tx, { kind: 'admin-update', userId: before.userid, payload: '{}' });
        await repo.update(tx, PERSON.table, { userid: before.userid }, { fname: 'Robin', email: 'robin@tenant-a.opt2.test', row_version: '2' });
        return repo.setRosterOperationState(tx, started.operation_id, { state: 'people-committed', beforeImage: imageOf(before) });
      });
      if (operation === null) throw new Error('roster operation missing after its insert');
      identity.seedAccounts(accountFor(before));
      await identity.identityClient.prepare(before.userid, operation.operation_id, CHANGE);
      clock.advance(STALE_MS);

      const outcome = await resolveOperation(deps, { tenantId: A, operationId: operation.operation_id });
      const restored = await db.withTenant(A, (tx) => repo.findPerson(tx, before.userid));
      const final = await db.withTenant(A, (tx) => repo.findRosterOperation(tx, operation.operation_id));
      return { outcome, restored, final, identityState: identity.operation(operation.operation_id)?.state, before };
    });

    if ('skipped' in result) throw new Error(result.reason);
    const { outcome, restored, final, identityState, before } = result;
    expect(outcome).toMatchObject({ from: 'people-committed', to: 'rolled-back', action: 'aborted', identityState: 'prepared' });
    expect(identityState).toBe('aborted');
    expect(final).toMatchObject({ state: 'rolled-back' });
    if (restored === null) throw new Error('restored person missing');
    const legacyColumns = PERSON.columns.filter((column) => column.name !== 'row_version');
    expect(encodeRow(legacyColumns, restored)).toBe(encodeRow(legacyColumns, before));
    expect(restored.row_version).toBe('3');
  });
});
