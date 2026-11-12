// Unit tests for the projection awaiter over a scripted checkpoint table, owners client, authority and driven clock.
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { PositionResponse } from '@opt2/platform/migration-kit';
import type { ConnectionPool } from 'mssql';
import { describe, expect, it, vi } from 'vitest';

import type { CurrentAuthority } from '../../src/cutover/index.js';
import type { DataOwner } from '../../src/owners/index.js';
import { ProjectionTimeoutError, createAwaiter, type AwaitProjectionRequest } from '../../src/reverse/await.js';

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

/** Awaiter over fakes: `sleep` advances the clock, and `onSleep` lets a test change checkpoints between polls. */
function harness(opts: { targetUnits?: string[]; tenants?: string[]; checkpoints?: Checkpoint[]; current?: Record<string, string> } = {}) {
  const checkpoints: Checkpoint[] = [...(opts.checkpoints ?? [])];
  const log: string[] = [];
  let now = Date.parse('2026-06-30T10:00:00.000Z');
  const sleeps: number[] = [];
  const onSleep: Array<() => void> = [];

  const pool = {
    request() {
      const owners: string[] = [];
      const fake = {
        input(_name: string, _type: unknown, value: string) {
          owners.push(value);
          return fake;
        },
        async query() {
          log.push(`checkpoints:${owners.join(',')}`);
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
            }));
          return { recordset: records, recordsets: [], rowsAffected: [], output: {} };
        },
      };
      return fake;
    },
  } as unknown as ConnectionPool;

  const position = vi.fn(async (owner: DataOwner): Promise<PositionResponse> => {
    log.push(`position:${owner}`);
    const current = opts.current?.[owner];
    if (current === undefined) throw new Error(`unscripted position of ${owner}`);
    return { owner, position: current, outbox: null, inbox: null };
  });
  const authority = vi.fn(async () => authorityOf(opts.targetUnits ?? ['programs_sites.image_size']));
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
    now += ms;
    onSleep.shift()?.();
  });

  const awaiter = createAwaiter({
    legacy: { live: async () => pool },
    owners: { position },
    authority,
    catalog: { ownerOf: (unit) => UNIT_OWNERS[unit] as DataOwner },
    tenants: async () => opts.tenants ?? [TENANT_A],
    clock: { now: () => new Date(now) },
    sleep,
    defaults: { timeoutMs: TIMEOUT_MS, pollIntervalMs: POLL_MS },
  });
  return { awaiter, checkpoints, log, sleeps, onSleep, position, authority };
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

  it('returns at once for an empty request without reading authority', async () => {
    const h = harness();

    await expect(h.awaiter.awaitProjection({})).resolves.toEqual({ positions: new Map(), waitedMs: 0 });
    expect(h.authority).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
  });
});
