import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GATE_WAIT_MS,
  GateClosedError,
  GateConflictError,
  GateRaceError,
  OperationBlockedError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  acquireWriteGates,
  awaitReadable,
  closeGates,
  endOperation,
  ensureUnitGates,
  migrationKitSql,
  openGates,
  openOperations,
  readGates,
  registerOperation,
  setGatePhase,
  withGatedTenant,
  type GatePhase,
  type GateState,
  type UnitGate,
} from '../../src/migration-kit/index.js';
import { rlsSql, withMetadata, withTenant, type TenantTx } from '../../src/tenancy/index.js';
import { LegacyServiceUnavailableError, cfUuid } from '../../src/legacy-compat/index.js';
import { TENANT_A, createThrowawaySchema, pgAvailable, testPgConfig, type ThrowawaySchema } from '../../src/testing/index.js';

const SCHEMA = 'isogate';
const BUDGET_MS = 400;
const PROMPT_MS = 5_000;
const SETUP_HOLDER = 'setup';
const TENANT = TENANT_A.tenantId;

const NOTE_SQL = [
  `CREATE TABLE ${SCHEMA}.note (`,
  '  tenant_id uuid NOT NULL,',
  '  id char(35) PRIMARY KEY,',
  '  body text,',
  '  row_version int NOT NULL DEFAULT 0',
  ');',
  rlsSql(SCHEMA, 'note'),
].join('\n');

/** Expected `unit_gate` row. */
function gate(unit: string, state: GateState, holderId: string | null = null, phase: GatePhase = 'quiet'): UnitGate {
  return { unit, state, holderId, phase };
}

/** Resolves with the rejection of `work()` and how long it took; fails if it fulfils. */
async function failure(work: () => Promise<unknown>): Promise<{ err: unknown; elapsedMs: number }> {
  const started = Date.now();
  try {
    await work();
  } catch (err) {
    return { err, elapsedMs: Date.now() - started };
  }
  throw new Error('Expected a rejection');
}

/** A promise with a synchronous view of whether it has settled. */
interface Tracked<T> {
  promise: Promise<T>;
  settled: () => boolean;
}

/** Tracks whether `promise` has settled. */
function track<T>(promise: Promise<T>): Tracked<T> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { promise, settled: () => done };
}

/** A promise with its resolver exposed. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('unit gates against PostgreSQL', () => {
  let handle: ThrowawaySchema | undefined;

  function db(): ThrowawaySchema {
    if (handle === undefined) {
      throw new Error('The throwaway schema was not created');
    }
    return handle;
  }

  beforeAll(async () => {
    const config = testPgConfig();
    if (!(await pgAvailable())) {
      throw new Error(`PostgreSQL at PG_HOST=${config.host} PG_PORT=${String(config.port)} is unreachable`);
    }
    handle = await createThrowawaySchema({ service: SCHEMA, extraSql: [migrationKitSql(SCHEMA), NOTE_SQL] });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  /** Brings `unit` to an open gate through the primitives: legacy, closed by the setup holder, reopened. */
  async function openGate(unit: string): Promise<void> {
    await ensureUnitGates(db().app, [unit]);
    await closeGates(db().app, { units: [unit], holderId: SETUP_HOLDER, allowLegacy: true });
    await openGates(db().app, { units: [unit], holderId: SETUP_HOLDER });
  }

  function insertNote(tx: TenantTx, id: string, body: string): Promise<unknown> {
    return tx.query(`INSERT INTO ${db().schema}.note (tenant_id, id, body) VALUES ($1, $2, $3)`, [tx.tenantId, id, body]);
  }

  async function noteBodies(ids: readonly string[]): Promise<string[]> {
    const { rows } = await withTenant(db().app, TENANT, (tx) =>
      tx.query<{ body: string }>(`SELECT body FROM ${db().schema}.note WHERE id = ANY($1::text[]) ORDER BY body`, [ids]),
    );
    return rows.map((row) => row.body);
  }

  it('creates one legacy, quiet, holderless gate per unit and leaves existing gates untouched on a repeat', async () => {
    const [a, b] = ['note.ensure.a', 'note.ensure.b'];
    await ensureUnitGates(db().app, [b, a, a]);
    expect(await readGates(db().app, [a, b])).toEqual([gate(a, 'legacy'), gate(b, 'legacy')]);

    await closeGates(db().app, { units: [a], holderId: 'H-ensure', allowLegacy: true });
    await ensureUnitGates(db().app, [a, b]);
    await ensureUnitGates(db().app, []);
    const all = await readGates(db().app);
    expect(all.filter((row) => row.unit.startsWith('note.ensure.'))).toEqual([gate(a, 'closed', 'H-ensure'), gate(b, 'legacy')]);
  });

  it('lets a write through an open gate and commits it in the same transaction', async () => {
    const unit = 'note.open';
    await openGate(unit);
    const id = cfUuid();
    await withTenant(db().app, TENANT, async (tx) => {
      await acquireWriteGates(tx, [unit]);
      await insertNote(tx, id, 'open');
    });
    expect(await noteBodies([id])).toEqual(['open']);
  });

  it('holds a write on a closed gate for its budget, then fails it as the legacy 503 GateClosedError', async () => {
    const unit = 'note.closed';
    await openGate(unit);
    await closeGates(db().app, { units: [unit], holderId: 'H-closed' });
    const id = cfUuid();

    const { err, elapsedMs } = await failure(() =>
      withTenant(db().app, TENANT, async (tx) => {
        await acquireWriteGates(tx, [unit], { budgetMs: BUDGET_MS });
        await insertNote(tx, id, 'closed');
      }),
    );

    expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS);
    expect(err).toBeInstanceOf(GateClosedError);
    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ units: [unit], surface: 'auto', reason: 'unit-gate-closed' });
    expect(await noteBodies([id])).toEqual([]);
  });

  it('keeps a write waiting on a closed gate within the 30 s default budget until the holder reopens it', async () => {
    expect(GATE_WAIT_MS).toBe(30_000);
    const unit = 'note.reopen';
    await openGate(unit);
    await closeGates(db().app, { units: [unit], holderId: 'H-reopen' });
    const id = cfUuid();

    const write = track(
      withTenant(db().app, TENANT, async (tx) => {
        await acquireWriteGates(tx, [unit]);
        await insertNote(tx, id, 'reopened');
      }),
    );
    await sleep(1_000);
    expect(write.settled()).toBe(false);

    await openGates(db().app, { units: [unit], holderId: 'H-reopen' });
    await write.promise;
    expect(await noteBodies([id])).toEqual(['reopened']);
  });

  it.each([
    ['legacy', true],
    ['missing', false],
  ] as const)('rejects a write to a %s gate at once with UnitNotAuthoritativeError', async (label, ensure) => {
    const unit = `note.${label}`;
    if (ensure) {
      await ensureUnitGates(db().app, [unit]);
    }

    const { err, elapsedMs } = await failure(() => withTenant(db().app, TENANT, (tx) => acquireWriteGates(tx, [unit])));

    expect(elapsedMs).toBeLessThan(PROMPT_MS);
    expect(err).toBeInstanceOf(UnitNotAuthoritativeError);
    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ units: [unit], reason: 'unit-not-authoritative' });
  });

  it.each(['executing', 'importing', 'import-pending'] as const)(
    'holds a read for its budget while the window is in phase %s, then fails it with UnitReadBlockedError',
    async (phase) => {
      const unit = `note.read.${phase}`;
      await openGate(unit);
      await closeGates(db().app, { units: [unit], holderId: 'H-read', phase });

      const { err, elapsedMs } = await failure(() =>
        withTenant(db().app, TENANT, (tx) => awaitReadable(tx, [unit], { budgetMs: BUDGET_MS })),
      );

      expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS);
      expect(err).toBeInstanceOf(UnitReadBlockedError);
      expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(err).toMatchObject({ units: [unit], reason: 'unit-read-blocked' });
    },
  );

  it('lets reads through quiet legacy and closed gates in tenant and metadata transactions', async () => {
    const [legacyUnit, closedUnit] = ['note.read.quiet-legacy', 'note.read.quiet-closed'];
    await ensureUnitGates(db().app, [legacyUnit]);
    await openGate(closedUnit);
    await closeGates(db().app, { units: [closedUnit], holderId: 'H-quiet' });
    const units = [legacyUnit, closedUnit];

    await expect(withTenant(db().app, TENANT, (tx) => awaitReadable(tx, units, { budgetMs: PROMPT_MS }))).resolves.toBeUndefined();
    await expect(withMetadata(db().app, (tx) => awaitReadable(tx, units, { budgetMs: PROMPT_MS }))).resolves.toBeUndefined();
  });

  it('waits for an in-flight writer holding FOR SHARE before closing the gate', async () => {
    const unit = 'note.drain';
    await openGate(unit);
    const locked = deferred();
    const release = deferred();
    const id = cfUuid();

    const writer = withTenant(db().app, TENANT, async (tx) => {
      await acquireWriteGates(tx, [unit]);
      await insertNote(tx, id, 'drained');
      locked.resolve();
      await release.promise;
    });
    let closing: Tracked<UnitGate[]>;
    try {
      await Promise.race([locked.promise, writer]);
      closing = track(closeGates(db().app, { units: [unit], holderId: 'H1' }));
      await sleep(300);
      expect(closing.settled()).toBe(false);
      expect(await readGates(db().app, [unit])).toEqual([gate(unit, 'open')]);
    } finally {
      release.resolve();
    }

    await writer;
    expect(await closing.promise).toEqual([gate(unit, 'closed', 'H1')]);
    expect(await readGates(db().app, [unit])).toEqual([gate(unit, 'closed', 'H1')]);
    expect(await noteBodies([id])).toEqual(['drained']);
  });

  it('closes and reopens a gate only by compare-and-set on its holder', async () => {
    const unit = 'note.cas';
    await openGate(unit);
    await closeGates(db().app, { units: [unit], holderId: 'H1' });
    expect(await closeGates(db().app, { units: [unit], holderId: 'H1' })).toEqual([gate(unit, 'closed', 'H1')]);

    const close = await failure(() => closeGates(db().app, { units: [unit], holderId: 'H2' }));
    expect(close.err).toBeInstanceOf(GateConflictError);
    expect(close.err).toMatchObject({ units: [unit] });

    const reopen = await failure(() => openGates(db().app, { units: [unit], holderId: 'H2' }));
    expect(reopen.err).toBeInstanceOf(GateConflictError);
    expect(await readGates(db().app, [unit])).toEqual([gate(unit, 'closed', 'H1')]);

    expect(await openGates(db().app, { units: [unit], holderId: 'H1' })).toEqual([gate(unit, 'open')]);
  });

  it('closes a legacy gate only when allowed and can hand it back as legacy', async () => {
    const [unit, ghost] = ['note.cas.legacy', 'note.cas.ghost'];
    await ensureUnitGates(db().app, [unit]);

    expect((await failure(() => closeGates(db().app, { units: [unit], holderId: 'T1' }))).err).toBeInstanceOf(GateConflictError);
    expect((await failure(() => closeGates(db().app, { units: [ghost], holderId: 'T1', allowLegacy: true }))).err).toBeInstanceOf(
      GateConflictError,
    );
    expect(await readGates(db().app, [unit, ghost])).toEqual([gate(unit, 'legacy')]);

    expect(await closeGates(db().app, { units: [unit], holderId: 'T1', allowLegacy: true })).toEqual([gate(unit, 'closed', 'T1')]);
    expect(await openGates(db().app, { units: [unit], holderId: 'T1', state: 'legacy' })).toEqual([gate(unit, 'legacy')]);
  });

  it('blocks a close while an open operation touches the unit and blocks new operations on a closed unit', async () => {
    const unit = 'note.op';
    await openGate(unit);
    await registerOperation(db().app, { operationId: 'op-1', kind: 'roster', units: [unit, unit] });
    expect(await openOperations(db().app, [unit])).toMatchObject([{ operationId: 'op-1', kind: 'roster', units: [unit] }]);

    const blocked = await failure(() => closeGates(db().app, { units: [unit], holderId: 'H1', timeoutMs: BUDGET_MS }));
    expect(blocked.elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS);
    expect(blocked.err).toBeInstanceOf(OperationBlockedError);
    expect(blocked.err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(blocked.err).toMatchObject({ units: [unit], reason: 'operation-blocked' });
    expect(await readGates(db().app, [unit])).toEqual([gate(unit, 'open')]);

    const closing = track(closeGates(db().app, { units: [unit], holderId: 'H1' }));
    await sleep(300);
    expect(closing.settled()).toBe(false);
    await endOperation(db().app, 'op-1');
    expect(await closing.promise).toEqual([gate(unit, 'closed', 'H1')]);
    expect(await openOperations(db().app, [unit])).toEqual([]);
    await expect(endOperation(db().app, 'op-1')).resolves.toBeUndefined();

    const refused = await failure(() =>
      registerOperation(db().app, { operationId: 'op-2', kind: 'roster', units: [unit] }, { budgetMs: BUDGET_MS }),
    );
    expect(refused.elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS);
    expect(refused.err).toBeInstanceOf(OperationBlockedError);
    expect(refused.err).toMatchObject({ units: [unit], reason: 'operation-blocked' });
    expect(await openOperations(db().app, [unit])).toEqual([]);
  });

  it('changes the phase only for the holder of every unit and resets it to quiet on reopen', async () => {
    const [held, other] = ['note.phase.held', 'note.phase.other'];
    await openGate(held);
    await openGate(other);
    await closeGates(db().app, { units: [held], holderId: 'H1' });

    expect(await setGatePhase(db().app, { units: [held], holderId: 'H1', phase: 'executing' })).toEqual([
      gate(held, 'closed', 'H1', 'executing'),
    ]);
    expect((await failure(() => setGatePhase(db().app, { units: [held], holderId: 'H2', phase: 'importing' }))).err).toBeInstanceOf(
      GateConflictError,
    );
    expect(
      (await failure(() => setGatePhase(db().app, { units: [held, other], holderId: 'H1', phase: 'importing' }))).err,
    ).toBeInstanceOf(GateConflictError);
    expect(await readGates(db().app, [held, other])).toEqual([gate(held, 'closed', 'H1', 'executing'), gate(other, 'open')]);

    expect(await openGates(db().app, { units: [held], holderId: 'H1' })).toEqual([gate(held, 'open')]);
  });

  it('re-runs a unit of work after a GateRaceError, rolling back the failed attempt', async () => {
    const unit = 'note.retry';
    const [first, second] = [cfUuid(), cfUuid()];
    let calls = 0;

    const result = await withGatedTenant(
      db().app,
      TENANT,
      async (tx) => {
        calls += 1;
        expect(tx.tenantId).toBe(TENANT);
        if (calls === 1) {
          await insertNote(tx, first, 'first');
          throw new GateRaceError([unit]);
        }
        await insertNote(tx, second, 'second');
        return 'second attempt';
      },
      { budgetMs: PROMPT_MS },
    );

    expect(result).toBe('second attempt');
    expect(calls).toBe(2);
    expect(await noteBodies([first, second])).toEqual(['second']);
  });

  it('fails as GateClosedError once repeated races exhaust the budget', async () => {
    const unit = 'note.retry.exhausted';
    let calls = 0;

    const { err, elapsedMs } = await failure(() =>
      withGatedTenant(
        db().app,
        TENANT,
        () => {
          calls += 1;
          return Promise.reject(new GateRaceError([unit]));
        },
        { budgetMs: BUDGET_MS },
      ),
    );

    expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS);
    expect(calls).toBeGreaterThan(1);
    expect(err).toBeInstanceOf(GateClosedError);
    expect(err).toMatchObject({ units: [unit], reason: 'unit-gate-closed' });
  });

  it('propagates any other error without re-running the unit of work', async () => {
    let calls = 0;
    const boom = new Error('not a gate race');

    const { err } = await failure(() =>
      withGatedTenant(db().app, TENANT, () => {
        calls += 1;
        return Promise.reject(boom);
      }),
    );

    expect(err).toBe(boom);
    expect(calls).toBe(1);
  });
});
