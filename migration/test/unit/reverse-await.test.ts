// Unit tests for the projection awaiter over a scripted checkpoint table, quarantine, owners client, authority and driven clock.
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { REDACTED, SAFE_ERROR_TEXT, serializeError } from '@opt2/platform/logging';
import { formatWritePosition, type PositionResponse } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import type { ConnectionPool } from 'mssql';
import { describe, expect, it, vi } from 'vitest';

import { GatewayCallError, type CurrentAuthority } from '../../src/cutover/index.js';
import { OwnerCallError, type DataOwner } from '../../src/owners/index.js';
import { CHECKPOINT_TABLE, type LegacyEffect } from '../../src/reverse/apply-legacy.js';
import {
  ProjectionQuarantinedError,
  ProjectionTimeoutError,
  ProjectionUnavailableError,
  createAwaiter,
  type AwaitProjectionRequest,
  type PendingPosition,
  type ProjectionRead,
  type ReadBudget,
} from '../../src/reverse/await.js';
import type { QuarantinedPosition } from '../../src/reverse/quarantine.js';
import { connectionLost, sqlError } from '../helpers/fake-legacy-db.js';

const TENANT_A = '3f9c3a52-1c1b-5d4e-8f00-0a1b2c3d4e5f';
const TENANT_B = '7d2e9b10-4a6c-5f8e-9b11-1c2d3e4f5a6b';
const POLL_MS = 250;
const TIMEOUT_MS = 5000;

const UNIT_OWNERS: Record<string, DataOwner> = {
  'programs_sites.image_size': 'programs-sites',
  'people.person': 'people',
  'identity.user_account': 'identity',
};

interface Checkpoint {
  owner: string;
  tenantId: string;
  appliedHorizon: string;
  /** Effects the checkpoint still owes, with the horizon ready before them. */
  owed?: { effects: LegacyEffect[]; readyHorizon: string | null };
}

function authorityOf(targetUnits: string[]): CurrentAuthority {
  const target = new Set(targetUnits);
  return {
    tableVersion: target.size > 0 ? 'v0002' : 'v0001',
    epoch: 1,
    units: new Map(Object.keys(UNIT_OWNERS).map((unit) => [unit, target.has(unit) ? 'target' : 'legacy'])),
    targetUnits: target,
    isTargetAuthoritative: (unit) => target.has(unit),
    anyTarget: target.size > 0,
  };
}

/** A dependency read that can be made to never answer on its own. */
type Stalled = 'position' | 'authority' | 'tenants' | 'live' | 'checkpoints' | 'quarantine';

/** A read whose failure fails the await closed. */
type Failing = Exclude<Stalled, 'position'>;

interface HarnessOptions {
  targetUnits?: string[];
  tenants?: string[];
  checkpoints?: Checkpoint[];
  /** Unrepaired quarantined changes; a quarantine read returns those at the positions it is given. */
  quarantine?: QuarantinedPosition[];
  current?: Record<string, string>;
  /** Read that never answers from its `stallFrom`-th call on (default the first); a cancelled read rejects as its driver does. */
  stall?: Stalled;
  stallFrom?: number;
  /** Read that rejects with `error` on every call. */
  fail?: { read: Failing; error: Error };
  /** Clock and sleep follow vitest's fake timers instead of the sleep-driven clock. */
  fakeTimers?: boolean;
  /** Milliseconds the clock moves while a checkpoint read runs. */
  readTakesMs?: number;
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** Never answers; once `signal` aborts, rejects with the AbortError a signalled driver raises. */
const untilAborted = <T>(signal: AbortSignal | undefined): Promise<T> =>
  new Promise<T>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
  });

/** Awaiter over fakes: `sleep` advances the clock, and `onSleep` lets a test change checkpoints between polls. */
function harness(opts: HarnessOptions = {}) {
  const checkpoints: Checkpoint[] = [...(opts.checkpoints ?? [])];
  const quarantine: QuarantinedPosition[] = [...(opts.quarantine ?? [])];
  const log: string[] = [];
  /** Positions of each quarantine read, as `<owner>=<xid>` lists. */
  const quarantineReads: string[] = [];
  /** Checkpoint reads made before each quarantine read. */
  const checkpointsBeforeQuarantine: number[] = [];
  let now = Date.parse('2026-06-30T10:00:00.000Z');
  const sleeps: number[] = [];
  const onSleep: Array<() => void> = [];
  const reads: Record<Stalled, number> = { position: 0, authority: 0, tenants: 0, live: 0, checkpoints: 0, quarantine: 0 };
  const stalls = (read: Stalled): boolean => {
    reads[read] += 1;
    return opts.stall === read && reads[read] >= (opts.stallFrom ?? 1);
  };
  const failIf = (read: Failing): void => {
    if (opts.fail?.read === read) throw opts.fail.error;
  };
  /** Budgets and options the dependencies were called with, and the checkpoint requests cancelled. */
  const seen: { position?: { timeoutMs?: number }; authority?: ReadBudget; tenants?: ReadBudget; quarantine?: ReadBudget; cancels: number } = { cancels: 0 };

  const pool = {
    request() {
      const owners: string[] = [];
      let cancelled = (): void => undefined;
      const fake = {
        input(_name: string, _type: unknown, value: string) {
          owners.push(value);
          return fake;
        },
        cancel() {
          seen.cancels += 1;
          cancelled();
        },
        async query() {
          log.push(`checkpoints:${owners.join(',')}`);
          now += opts.readTakesMs ?? 0;
          failIf('checkpoints');
          if (stalls('checkpoints')) {
            return new Promise((_resolve, reject) => {
              cancelled = () => reject(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
            });
          }
          const records = checkpoints
            .filter((row) => owners.includes(row.owner))
            .map((row) => ({
              owner: row.owner,
              tenant_id: row.tenantId,
              cursor_xid: '0',
              cursor_seq: '0',
              applied_horizon: row.appliedHorizon,
              batch_id: 'batch',
              rows_applied: 0,
              updated_at: null,
              pending_effects: row.owed === undefined ? null : JSON.stringify(row.owed.effects),
              ready_horizon: row.owed?.readyHorizon ?? null,
            }));
          return { recordset: records, recordsets: [], rowsAffected: [], output: {} };
        },
      };
      return fake;
    },
  } as unknown as ConnectionPool;

  const position = vi.fn(async (owner: DataOwner, _params?: unknown, options?: { timeoutMs?: number }): Promise<PositionResponse> => {
    log.push(`position:${owner}`);
    seen.position = options;
    if (stalls('position')) return never();
    const current = opts.current?.[owner];
    if (current === undefined) throw new Error(`unscripted position of ${owner}`);
    return { owner, position: current, outbox: null, inbox: null };
  });
  const authority = vi.fn(async (budget?: ReadBudget) => {
    seen.authority = budget;
    failIf('authority');
    if (stalls('authority')) return untilAborted<CurrentAuthority>(budget?.signal);
    return authorityOf(opts.targetUnits ?? ['programs_sites.image_size']);
  });
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
    if (opts.fakeTimers === true) await new Promise((resolve) => setTimeout(resolve, ms));
    else now += ms;
    onSleep.shift()?.();
  });

  const awaiter = createAwaiter({
    legacy: {
      live: async () => {
        failIf('live');
        return stalls('live') ? never<ConnectionPool>() : pool;
      },
    },
    owners: { position },
    authority,
    catalog: { ownerOf: (unit) => UNIT_OWNERS[unit] as DataOwner },
    tenants: async (budget) => {
      seen.tenants = budget;
      failIf('tenants');
      return stalls('tenants') ? untilAborted<string[]>(budget.signal) : (opts.tenants ?? [TENANT_A]);
    },
    quarantined: async (listed, budget) => {
      seen.quarantine = budget;
      quarantineReads.push(formatWritePosition(listed));
      checkpointsBeforeQuarantine.push(reads.checkpoints);
      failIf('quarantine');
      if (stalls('quarantine')) return untilAborted<QuarantinedPosition[]>(budget.signal);
      return quarantine.filter((row) => listed.get(row.owner) === row.xid);
    },
    clock: { now: () => (opts.fakeTimers === true ? new Date() : new Date(now)) },
    sleep,
    defaults: { timeoutMs: TIMEOUT_MS, pollIntervalMs: POLL_MS },
  });
  return { awaiter, checkpoints, quarantine, quarantineReads, checkpointsBeforeQuarantine, log, sleeps, onSleep, position, authority, seen };
}

const positions = (entries: Record<string, string>): AwaitProjectionRequest['positions'] => new Map(Object.entries(entries));

describe('createAwaiter', () => {
  it('resolves on the first poll once every tenant checkpoint is above the position', async () => {
    const h = harness({
      tenants: [TENANT_A, TENANT_B],
      checkpoints: [
        { owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '901' },
        { owner: 'programs-sites', tenantId: TENANT_B.toUpperCase(), appliedHorizon: '1000' },
      ],
    });

    await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) })).resolves.toEqual({
      positions: positions({ 'programs-sites': '900' }),
      waitedMs: 0,
    });
    expect(h.log).toEqual(['checkpoints:programs-sites']);
    expect(h.sleeps).toEqual([]);
  });

  it.each([
    { label: 'a horizon equal to the position', horizon: '900', xid: '900' },
    { label: 'a horizon below the position', horizon: '899', xid: '900' },
    { label: 'xids beyond 2^53 compared exactly', horizon: '18446744073709551614', xid: '18446744073709551614' },
  ])('keeps waiting for $label', async ({ horizon, xid }) => {
    const h = harness({ checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: horizon }] });
    h.onSleep.push(() => {
      h.checkpoints[0] = { owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: (BigInt(xid) + 1n).toString() };
    });

    const result = await h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': xid }) });

    expect(result.waitedMs).toBe(POLL_MS);
    expect(h.log).toEqual(['checkpoints:programs-sites', 'checkpoints:programs-sites']);
  });

  it('counts a tenant without a checkpoint row as not applied until its first batch is checkpointed', async () => {
    const h = harness({
      tenants: [TENANT_A, TENANT_B],
      checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' }],
    });
    h.onSleep.push(() => undefined);
    h.onSleep.push(() => h.checkpoints.push({ owner: 'programs-sites', tenantId: TENANT_B, appliedHorizon: '1000' }));

    const result = await h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) });

    expect(result.waitedMs).toBe(2 * POLL_MS);
    expect(h.log).toHaveLength(3);
  });

  const PURGE: LegacyEffect[] = [{ kind: 'purgeCache', siteId: 'tenant-a' }];

  it.each([
    { label: 'below the position', readyHorizon: '900' },
    { label: 'absent because no batch effects ever ran', readyHorizon: null },
  ])('keeps a position past the applied horizon pending while effects are owed and the ready horizon is $label', async ({ readyHorizon }) => {
    const h = harness({ checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000', owed: { effects: PURGE, readyHorizon } }] });
    h.onSleep.push(() => {
      h.checkpoints[0] = { owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' };
    });

    const result = await h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) });

    expect(result.waitedMs).toBe(POLL_MS);
    expect(h.log).toEqual(['checkpoints:programs-sites', 'checkpoints:programs-sites']);
  });

  it('releases a position below the ready horizon while later batches still owe effects', async () => {
    const h = harness({ checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000', owed: { effects: PURGE, readyHorizon: '901' } }] });

    await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) })).resolves.toMatchObject({ waitedMs: 0 });
    expect(h.sleeps).toEqual([]);
  });

  const DEPARTED = '9a8b7c6d-5e4f-5a3b-8c2d-1e0f9a8b7c6d';
  const GONE: LegacyEffect[] = [
    { kind: 'siteRefresh', siteId: 'gone-site' },
    { kind: 'purgeCache', siteId: 'gone-site' },
  ];

  it.each([
    { label: 'omits it', tenants: [TENANT_A], readyHorizon: null },
    { label: 'omits it', tenants: [TENANT_A], readyHorizon: '900' },
    { label: 'is empty', tenants: [], readyHorizon: null },
    { label: 'is empty', tenants: [], readyHorizon: '900' },
  ])(
    'holds a position while a departed tenant owes effects ready at $readyHorizon and the tenant set $label, until they are cleared',
    async ({ tenants, readyHorizon }) => {
      const owing: Checkpoint = { owner: 'programs-sites', tenantId: DEPARTED.toUpperCase(), appliedHorizon: '1000', owed: { effects: GONE, readyHorizon } };
      const h = harness({ tenants, checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' }, owing] });

      const error: unknown = await h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }), timeoutMs: 600 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProjectionTimeoutError);
      expect(error).toMatchObject({ pending: [{ owner: 'programs-sites', xid: '900', tenantsBehind: [DEPARTED] }] });
      h.onSleep.push(() => {
        h.checkpoints[1] = { owner: 'programs-sites', tenantId: DEPARTED.toUpperCase(), appliedHorizon: '1000' };
      });
      await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) })).resolves.toMatchObject({ waitedMs: POLL_MS });
    },
  );

  it.each([
    { label: 'owes nothing behind a stale applied horizon', tenants: [TENANT_A], departed: { appliedHorizon: '1' } },
    { label: 'owes nothing behind a stale applied horizon', tenants: [], departed: { appliedHorizon: '1' } },
    { label: 'owes effects ready above the position', tenants: [TENANT_A], departed: { appliedHorizon: '1000', owed: { effects: GONE, readyHorizon: '901' } } },
    { label: 'owes effects ready above the position', tenants: [], departed: { appliedHorizon: '1000', owed: { effects: GONE, readyHorizon: '901' } } },
  ])('releases a position over a departed tenant whose checkpoint $label', async ({ tenants, departed }) => {
    const h = harness({
      tenants,
      checkpoints: [
        { owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' },
        { owner: 'programs-sites', tenantId: DEPARTED, ...departed },
      ],
    });

    await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) })).resolves.toMatchObject({ waitedMs: 0 });
  });

  it('lists a streamed tenant that owes effects once, in lower case', async () => {
    const h = harness({
      tenants: [TENANT_A.toUpperCase()],
      checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A.toUpperCase(), appliedHorizon: '1000', owed: { effects: PURGE, readyHorizon: null } }],
    });

    await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }), timeoutMs: 600 })).rejects.toMatchObject({
      pending: [{ owner: 'programs-sites', xid: '900', tenantsBehind: [TENANT_A] }],
    });
  });

  it('throws ProjectionTimeoutError, a legacy 503, listing the tenants behind once the budget passes', async () => {
    const h = harness({
      tenants: [TENANT_A, TENANT_B],
      checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '899' }],
    });

    const error: unknown = await h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }), timeoutMs: 600 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProjectionTimeoutError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    const timeout = error as ProjectionTimeoutError;
    expect(timeout.pending).toEqual([{ owner: 'programs-sites', xid: '900', tenantsBehind: [TENANT_A, TENANT_B] }]);
    expect(timeout.timeoutMs).toBe(600);
    expect(timeout.surface).toBe('auto');
    expect(timeout.reason).toBe('projection-timeout');
    expect(timeout.message).toBe('Projection of programs-sites=900 was not applied in legacy within 600 ms');
    expect(serializeError(timeout)).toMatchObject({ type: 'ProjectionTimeoutError', message: timeout.message });
    expect(h.sleeps).toEqual([POLL_MS, POLL_MS, 100]);
    expect(h.log).toHaveLength(4);
  });

  it('applies the configured default budget when the request names none', async () => {
    const h = harness({ checkpoints: [] });

    await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) })).rejects.toMatchObject({
      timeoutMs: TIMEOUT_MS,
    });
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(TIMEOUT_MS);
  });

  it('resolves at once for owners without a target-authoritative unit and awaits only the others', async () => {
    const h = harness({
      targetUnits: ['programs_sites.image_size'],
      checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' }],
    });

    await expect(h.awaiter.awaitProjection({ positions: positions({ people: '5000', 'programs-sites': '900' }) })).resolves.toEqual({
      positions: positions({ people: '5000', 'programs-sites': '900' }),
      waitedMs: 0,
    });
    expect(h.log).toEqual(['checkpoints:programs-sites']);
  });

  it('reads no checkpoint while every unit is legacy-authoritative', async () => {
    const h = harness({ targetUnits: [] });

    await expect(h.awaiter.awaitProjection({ positions: positions({ people: '5000' }) })).resolves.toMatchObject({ waitedMs: 0 });
    expect(h.log).toEqual([]);
  });

  it('reads each requested owner position before any checkpoint and keeps the higher xid per owner', async () => {
    const h = harness({
      targetUnits: ['people.person', 'identity.user_account'],
      current: { people: '700', identity: '650' },
      checkpoints: [
        { owner: 'people', tenantId: TENANT_A, appliedHorizon: '701' },
        { owner: 'identity', tenantId: TENANT_A, appliedHorizon: '801' },
      ],
    });

    const result = await h.awaiter.awaitProjection({ positions: positions({ identity: '800', people: '600' }), owners: ['people', 'identity'] });

    expect(result.positions).toEqual(positions({ identity: '800', people: '700' }));
    expect(h.position).toHaveBeenCalledTimes(2);
    expect(h.log).toEqual(['position:people', 'position:identity', 'checkpoints:identity,people']);
  });

  const ownerAnswer = (status: number): OwnerCallError =>
    new OwnerCallError('people', 'GET', '/internal/v1/migration/position', status, { apiversion: 'v1', error: { code: 'server_error' } });

  it.each([502, 503, 504])('throws ServiceUnavailableError, a legacy 503, when a requested owner answers its position read with %i', async (status) => {
    const h = harness();
    const answer = ownerAnswer(status);
    h.position.mockRejectedValueOnce(answer);

    const error: unknown = await h.awaiter.awaitProjection({ owners: ['people'] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    const unavailable = error as ServiceUnavailableError;
    expect(unavailable.service).toBe('people');
    expect(unavailable.cause).toBe(answer);
    expect(unavailable.reason).toBe('service-unavailable');
    expect(h.authority).not.toHaveBeenCalled();
  });

  it.each([500, 404])('propagates an owner position answer of %i unchanged', async (status) => {
    const h = harness();
    const answer = ownerAnswer(status);
    h.position.mockRejectedValueOnce(answer);

    await expect(h.awaiter.awaitProjection({ owners: ['people'] })).rejects.toBe(answer);
  });

  it.each<{ fail: Failing; error: Error; read: ProjectionRead }>([
    { fail: 'checkpoints', error: sqlError(208, `Invalid object name '${CHECKPOINT_TABLE}'.`), read: 'checkpoint' },
    { fail: 'live', error: connectionLost(), read: 'checkpoint' },
    { fail: 'tenants', error: sqlError(208, "Invalid object name 'dbo.tsettings'."), read: 'tenant set' },
    { fail: 'authority', error: new GatewayCallError('cutoverStatus', 500, { error: 'internal' }), read: 'cut-over authority' },
    { fail: 'quarantine', error: Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }), read: 'quarantine' },
  ])('fails closed with ProjectionUnavailableError, a legacy 503, when the $fail read rejects', async ({ fail, error, read }) => {
    const h = harness({ fail: { read: fail, error } });

    const outcome: unknown = await h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) }).catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(ProjectionUnavailableError);
    expect(outcome).toBeInstanceOf(LegacyServiceUnavailableError);
    const unavailable = outcome as ProjectionUnavailableError;
    expect(unavailable.cause).toBe(error);
    expect(unavailable).toMatchObject({
      name: 'ProjectionUnavailableError',
      read,
      surface: 'auto',
      reason: 'projection-unavailable',
      message: `Projection await could not read the ${read}`,
    });
    expect(unavailable.message).not.toContain(error.message);
    expect(h.sleeps).toEqual([]);
  });

  it('passes a legacy 503 that a read raises through unchanged', async () => {
    const refused = new ServiceUnavailableError('gateway', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), { code: 'ECONNREFUSED' }));
    const h = harness({ fail: { read: 'authority', error: refused } });

    await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) })).rejects.toBe(refused);
  });

  const QUARANTINED: QuarantinedPosition = { owner: 'programs-sites', xid: '900', tenantId: TENANT_A };

  it.each([
    { label: 'its checkpoint is still behind', horizon: '899' },
    { label: 'its checkpoint has passed it', horizon: '1000' },
  ])('rejects at once with ProjectionQuarantinedError, a legacy 503, when a listed position is quarantined and $label', async ({ horizon }) => {
    const h = harness({ checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: horizon }], quarantine: [QUARANTINED] });

    const error: unknown = await h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProjectionQuarantinedError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    const quarantined = error as ProjectionQuarantinedError;
    expect(quarantined).toMatchObject({ name: 'ProjectionQuarantinedError', quarantined: [QUARANTINED], surface: 'auto', reason: 'projection-quarantined' });
    expect(quarantined.message).toBe('Projection of programs-sites=900 is quarantined: legacy could not take the write');
    expect(quarantined[SAFE_ERROR_TEXT]).toBe(quarantined.message);
    expect(quarantined[SAFE_ERROR_TEXT]).not.toContain(TENANT_A);
    expect(h.log).toEqual(['checkpoints:programs-sites']);
    expect(h.quarantineReads).toEqual(['programs-sites=900']);
    expect(h.sleeps).toEqual([]);
  });

  it('reads the quarantine after the checkpoints on every poll and rejects once the position is quarantined', async () => {
    const h = harness({ checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '899' }] });
    h.onSleep.push(() => {
      h.checkpoints[0] = { owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' };
      h.quarantine.push(QUARANTINED);
    });

    await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) })).rejects.toBeInstanceOf(ProjectionQuarantinedError);
    expect(h.quarantineReads).toEqual(['programs-sites=900', 'programs-sites=900']);
    expect(h.checkpointsBeforeQuarantine).toEqual([1, 2]);
    expect(h.sleeps).toEqual([POLL_MS]);
  });

  it.each([
    { label: 'another xid of the owner', quarantine: [{ ...QUARANTINED, xid: '899' }] },
    { label: 'the same xid of another owner', quarantine: [{ ...QUARANTINED, owner: 'people' }] },
    { label: 'none', quarantine: [] },
  ])('reports a position applied as before when the quarantine holds $label', async ({ quarantine }) => {
    const h = harness({ checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' }], quarantine });

    await expect(h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }) })).resolves.toMatchObject({ waitedMs: 0 });
  });

  it("reads the quarantine only at listed positions of projected owners, never at an owner's current position", async () => {
    const h = harness({
      targetUnits: ['people.person', 'programs_sites.image_size'],
      current: { people: '700' },
      checkpoints: [
        { owner: 'people', tenantId: TENANT_A, appliedHorizon: '701' },
        { owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' },
      ],
      quarantine: [{ owner: 'people', xid: '700', tenantId: TENANT_A }],
    });

    await expect(h.awaiter.awaitProjection({ owners: ['people'] })).resolves.toMatchObject({ positions: positions({ people: '700' }) });
    expect(h.quarantineReads).toEqual([]);
    await expect(
      h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900', identity: '5', people: '600' }), owners: ['people'] }),
    ).resolves.toMatchObject({ positions: positions({ 'programs-sites': '900', identity: '5', people: '700' }) });
    expect(h.quarantineReads).toEqual(['people=600,programs-sites=900']);
  });

  it('rejects a listed position that an owner position read supersedes when that listed write is quarantined', async () => {
    const h = harness({
      targetUnits: ['people.person'],
      current: { people: '700' },
      checkpoints: [{ owner: 'people', tenantId: TENANT_A, appliedHorizon: '701' }],
      quarantine: [{ owner: 'people', xid: '600', tenantId: TENANT_A }],
    });

    await expect(h.awaiter.awaitProjection({ positions: positions({ people: '600' }), owners: ['people'] })).rejects.toMatchObject({
      quarantined: [{ owner: 'people', xid: '600', tenantId: TENANT_A }],
    });
  });

  it('returns at once for an empty request without reading authority', async () => {
    const h = harness();

    await expect(h.awaiter.awaitProjection({})).resolves.toEqual({ positions: new Map(), waitedMs: 0 });
    expect(h.authority).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
  });
});

describe('createAwaiter budget', () => {
  type Seen = ReturnType<typeof harness>['seen'];
  const UNREAD = [{ owner: 'programs-sites', xid: '900', tenantsBehind: [] }];
  const budgetOf = (budget: ReadBudget | undefined) => ({ timeoutMs: budget?.timeoutMs, aborted: budget?.signal.aborted });

  it.each<{ stall: Stalled; owners?: string[]; abandoned: (seen: Seen) => unknown; expected: unknown }>([
    { stall: 'position', owners: ['people'], abandoned: (seen) => seen.position, expected: { timeoutMs: 600 } },
    { stall: 'authority', abandoned: (seen) => budgetOf(seen.authority), expected: { timeoutMs: 600, aborted: true } },
    { stall: 'tenants', abandoned: (seen) => budgetOf(seen.tenants), expected: { timeoutMs: 600, aborted: true } },
    { stall: 'live', abandoned: (seen) => seen.cancels, expected: 0 },
    { stall: 'checkpoints', abandoned: (seen) => seen.cancels, expected: 1 },
    { stall: 'quarantine', abandoned: (seen) => budgetOf(seen.quarantine), expected: { timeoutMs: 600, aborted: true } },
  ])('rejects with ProjectionTimeoutError at the deadline while the $stall read never answers, and abandons it', async ({ stall, owners, abandoned, expected }) => {
    vi.useFakeTimers();
    try {
      const h = harness({ stall, fakeTimers: true, targetUnits: ['programs_sites.image_size', 'people.person'], current: { people: '700' } });
      let outcome: unknown;
      const settled = h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }), owners, timeoutMs: 600 }).then(
        (result) => (outcome = result),
        (error: unknown) => (outcome = error),
      );

      await vi.advanceTimersByTimeAsync(599);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await settled;

      expect(outcome).toBeInstanceOf(ProjectionTimeoutError);
      expect(outcome).toMatchObject({ pending: UNREAD, timeoutMs: 600, message: 'Projection of programs-sites=900 was not applied in legacy within 600 ms' });
      expect(abandoned(h.seen)).toEqual(expected);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the tenants the last poll found behind when a later checkpoint read never answers', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        stall: 'checkpoints',
        stallFrom: 2,
        fakeTimers: true,
        tenants: [TENANT_A, TENANT_B],
        checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' }],
      });
      const settled = h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }), timeoutMs: 600 }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(600);

      expect(await settled).toMatchObject({ pending: [{ owner: 'programs-sites', xid: '900', tenantsBehind: [TENANT_B] }] });
      expect(h.sleeps).toEqual([POLL_MS]);
      expect(h.seen.cancels).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a read that finds every position applied only after the budget has passed', async () => {
    const h = harness({ readTakesMs: 700, checkpoints: [{ owner: 'programs-sites', tenantId: TENANT_A, appliedHorizon: '1000' }] });

    const error = await h.awaiter.awaitProjection({ positions: positions({ 'programs-sites': '900' }), timeoutMs: 600 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProjectionTimeoutError);
    expect(error).toMatchObject({ pending: UNREAD, timeoutMs: 600 });
  });
});

describe('ProjectionTimeoutError safe text', () => {
  it.each<[string, PendingPosition[], number, string]>([
    ['one position', [{ owner: 'programs-sites', xid: '900', tenantsBehind: [TENANT_A] }], 600, 'Projection of programs-sites=900 was not applied in legacy within 600 ms'],
    [
      'positions of several owners',
      [
        { owner: 'timesheets', xid: '18446744073709551614', tenantsBehind: [] },
        { owner: 'e-signature', xid: '7', tenantsBehind: [TENANT_B] },
      ],
      TIMEOUT_MS,
      'Projection of e-signature=7,timesheets=18446744073709551614 was not applied in legacy within 5000 ms',
    ],
    ['no position read yet', [], TIMEOUT_MS, 'Projection of  was not applied in legacy within 5000 ms'],
    ['an owner name outside the allowlist', [{ owner: 'Ada Lovelace', xid: '900', tenantsBehind: [] }], 600, REDACTED],
    ['a fractional budget', [{ owner: 'people', xid: '900', tenantsBehind: [] }], 600.5, REDACTED],
  ])('serializes a timeout over %s with only its fixed text', (_label, pending, timeoutMs, message) => {
    const record = serializeError(new ProjectionTimeoutError(pending, timeoutMs));

    expect(record).toMatchObject({ type: 'ProjectionTimeoutError', message });
    expect(JSON.stringify(record)).not.toContain('Ada');
    expect(JSON.stringify(record)).not.toContain(TENANT_A);
  });
});
