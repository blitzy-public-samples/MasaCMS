/** Login strike counting of `userstrikes.cfc` over an in-memory strike repository: window reset, strike and clear reloads, block and block end. */
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, fixedClock } from '@opt2/platform/testing';
import {
  DEFAULT_STRIKE_SETTINGS,
  addStrike,
  blockedUntil,
  clearStrikes,
  isBlocked,
  loadStrikes,
  type StrikeRepository,
  type StrikeSettings,
  type StrikeState,
} from '../../src/domain/strikes.js';
import type { UserStrikeRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0);
const MINUTE = 60_000;
const CLOCK = fixedClock(NOW);
const CTX: WriteContext = { origin: 'target', actorService: 'identity', requestId: 'req-strikes' };

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

type StrikeCall =
  | { method: 'ensureStrike'; tx: TenantTx; username: string; at: Date; ctx: WriteContext | undefined }
  | { method: 'setStrike'; tx: TenantTx; username: string; values: Pick<UserStrikeRow, 'strikes' | 'lastattempt'>; ctx: WriteContext | undefined }
  | { method: 'addStrike'; tx: TenantTx; username: string; at: Date; ctx: WriteContext | undefined };

/** SQL Server's match of a username: case-insensitive, trailing spaces ignored. */
function nameKey(username: string): string {
  return username.replace(/ +$/, '').toLowerCase();
}

/** The three strike helpers of the identity repository over one tenant's rows, logging each call in order. */
function fakeStrikes(seed: Array<Pick<UserStrikeRow, 'username' | 'strikes' | 'lastattempt'>> = []): {
  repo: StrikeRepository;
  rows: Map<string, UserStrikeRow>;
  calls: StrikeCall[];
} {
  const rows = new Map(seed.map((row): [string, UserStrikeRow] => [nameKey(row.username), { tenant_id: TENANT_A.tenantId, ...row }]));
  const calls: StrikeCall[] = [];
  const copy = (row: UserStrikeRow | undefined): UserStrikeRow | null => (row === undefined ? null : { ...row });
  const repo: StrikeRepository = {
    ensureStrike(tx, username, when, ctx) {
      calls.push({ method: 'ensureStrike', tx, username, at: when, ctx });
      const key = nameKey(username);
      if (!rows.has(key)) rows.set(key, { tenant_id: tx.tenantId, username, strikes: 0, lastattempt: new Date(when.getTime() - MINUTE) });
      return Promise.resolve({ ...(rows.get(key) as UserStrikeRow) });
    },
    setStrike(tx, username, values, ctx) {
      calls.push({ method: 'setStrike', tx, username, values: { ...values }, ctx });
      const stored = rows.get(nameKey(username));
      if (stored !== undefined) Object.assign(stored, values);
      return Promise.resolve(copy(stored));
    },
    addStrike(tx, username, when, ctx) {
      calls.push({ method: 'addStrike', tx, username, at: when, ctx });
      const stored = rows.get(nameKey(username));
      if (stored !== undefined) Object.assign(stored, { strikes: stored.strikes === null ? null : stored.strikes + 1, lastattempt: when });
      return Promise.resolve(copy(stored));
    },
  };
  return { repo, rows, calls };
}

/** An open tenant transaction whose raw `query` the strike operations must leave unused. */
function tenantTx(): { tx: TenantTx; query: Mock } {
  const query = vi.fn();
  return { tx: { kind: 'tenant', tenantId: TENANT_A.tenantId, schema: 'identity', query, onCommit: vi.fn() }, query };
}

describe('strike settings', () => {
  it('defaults to four allowed strikes and a ten-minute block, frozen', () => {
    expect(DEFAULT_STRIKE_SETTINGS).toEqual({ allowedStrikes: 4, blockedDurationMinutes: 10 });
    expect(Object.isFrozen(DEFAULT_STRIKE_SETTINGS)).toBe(true);
  });
});

describe('loadStrikes', () => {
  it('inserts an unknown username with no strikes a minute ago and keeps that row without a reset', async () => {
    const { repo, rows, calls } = fakeStrikes();
    const { tx, query } = tenantTx();

    const state = await loadStrikes(repo, tx, 'newcomer', { clock: CLOCK, ctx: CTX });

    expect(state).toEqual({ username: 'newcomer', strikes: 0, lastAttempt: at(-MINUTE) });
    expect(calls).toEqual([{ method: 'ensureStrike', tx, username: 'newcomer', at: NOW, ctx: CTX }]);
    expect(rows.get('newcomer')).toMatchObject({ strikes: 0, lastattempt: at(-MINUTE) });
    expect(query).not.toHaveBeenCalled();
  });

  it.each<[string, Date]>([
    ['one second ago', at(-1_000)],
    ['exactly the block duration ago', at(-10 * MINUTE)],
  ])('keeps the stored count and attempt time of a last attempt %s', async (_label, lastattempt) => {
    const { repo, calls } = fakeStrikes([{ username: 'admin', strikes: 3, lastattempt }]);

    const state = await loadStrikes(repo, tenantTx().tx, 'admin', { clock: CLOCK });

    expect(state).toEqual({ username: 'admin', strikes: 3, lastAttempt: lastattempt });
    expect(calls.map(({ method }) => method)).toEqual(['ensureStrike']);
  });

  it.each<[string, Date | null]>([
    ['a millisecond beyond the block duration ago', at(-10 * MINUTE - 1)],
    ['a day ago', at(-24 * 60 * MINUTE)],
    ['never recorded (NULL)', null],
  ])('resets the count to 0 with an attempt a minute ago when the last attempt was %s', async (_label, lastattempt) => {
    const { repo, rows, calls } = fakeStrikes([{ username: 'admin', strikes: 7, lastattempt }]);
    const { tx } = tenantTx();

    const state = await loadStrikes(repo, tx, 'admin', { clock: CLOCK, ctx: CTX });

    expect(state).toEqual({ username: 'admin', strikes: 0, lastAttempt: at(-MINUTE) });
    expect(calls).toEqual([
      { method: 'ensureStrike', tx, username: 'admin', at: NOW, ctx: CTX },
      { method: 'setStrike', tx, username: 'admin', values: { strikes: 0, lastattempt: at(-MINUTE) }, ctx: CTX },
    ]);
    expect(rows.get('admin')).toMatchObject({ strikes: 0, lastattempt: at(-MINUTE) });
  });

  it('keeps a stored NULL count inside the window rather than reading it as 0', async () => {
    const { repo } = fakeStrikes([{ username: 'admin', strikes: null, lastattempt: at(-MINUTE) }]);

    expect(await loadStrikes(repo, tenantTx().tx, 'admin', { clock: CLOCK })).toEqual({ username: 'admin', strikes: null, lastAttempt: at(-MINUTE) });
  });

  it('reports the username as given, not as stored', async () => {
    const { repo, calls } = fakeStrikes([{ username: 'Admin', strikes: 2, lastattempt: at(-MINUTE) }]);

    const state = await loadStrikes(repo, tenantTx().tx, 'ADMIN ', { clock: CLOCK });

    expect(state).toEqual({ username: 'ADMIN ', strikes: 2, lastAttempt: at(-MINUTE) });
    expect(calls.map(({ username }) => username)).toEqual(['ADMIN ']);
  });

  it('applies the block duration of custom settings to the reset window', async () => {
    const settings: StrikeSettings = { allowedStrikes: 1, blockedDurationMinutes: 30 };
    const { repo } = fakeStrikes([
      { username: 'kept', strikes: 2, lastattempt: at(-20 * MINUTE) },
      { username: 'lapsed', strikes: 2, lastattempt: at(-30 * MINUTE - 1) },
    ]);
    const { tx } = tenantTx();

    expect(await loadStrikes(repo, tx, 'kept', { clock: CLOCK, settings })).toMatchObject({ strikes: 2 });
    expect(await loadStrikes(repo, tx, 'lapsed', { clock: CLOCK, settings })).toMatchObject({ strikes: 0 });
  });
});

describe('addStrike', () => {
  it('records a failed attempt now, then reloads the incremented count', async () => {
    const { repo, calls } = fakeStrikes([{ username: 'admin', strikes: 3, lastattempt: at(-5 * MINUTE) }]);
    const { tx } = tenantTx();
    const loaded = await loadStrikes(repo, tx, 'admin', { clock: CLOCK, ctx: CTX });

    const state = await addStrike(repo, tx, loaded, { clock: CLOCK, ctx: CTX });

    expect(state).toEqual({ username: 'admin', strikes: 4, lastAttempt: NOW });
    expect(calls.slice(1)).toEqual([
      { method: 'addStrike', tx, username: 'admin', at: NOW, ctx: CTX },
      { method: 'ensureStrike', tx, username: 'admin', at: NOW, ctx: CTX },
    ]);
  });

  it('blocks on the fifth failed attempt under the default settings until ten minutes after it', async () => {
    const { repo } = fakeStrikes();
    const { tx } = tenantTx();
    const options = { clock: CLOCK };
    let state: StrikeState = await loadStrikes(repo, tx, 'admin', options);
    const history: Array<[number | null, boolean, Date]> = [];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = await addStrike(repo, tx, state, options);
      history.push([state.strikes, isBlocked(state, DEFAULT_STRIKE_SETTINGS), blockedUntil(state, DEFAULT_STRIKE_SETTINGS, CLOCK)]);
    }

    expect(history).toEqual([
      [1, false, at(-MINUTE)],
      [2, false, at(-MINUTE)],
      [3, false, at(-MINUTE)],
      [4, false, at(-MINUTE)],
      [5, true, at(10 * MINUTE)],
    ]);
  });

  it('lifts a block once the block duration has passed since the last attempt', async () => {
    const { repo } = fakeStrikes([{ username: 'admin', strikes: 5, lastattempt: NOW }]);
    const { tx } = tenantTx();
    const later = fixedClock(at(10 * MINUTE + 1));

    const blocked = await loadStrikes(repo, tx, 'admin', { clock: fixedClock(at(10 * MINUTE)) });
    const lifted = await loadStrikes(repo, tx, 'admin', { clock: later });

    expect(isBlocked(blocked, DEFAULT_STRIKE_SETTINGS)).toBe(true);
    expect(lifted).toEqual({ username: 'admin', strikes: 0, lastAttempt: at(9 * MINUTE + 1) });
    expect(isBlocked(lifted, DEFAULT_STRIKE_SETTINGS)).toBe(false);
  });

  it('leaves a stored NULL count NULL and never blocks it', async () => {
    const { repo } = fakeStrikes([{ username: 'admin', strikes: null, lastattempt: at(-MINUTE) }]);
    const { tx } = tenantTx();
    const state = await addStrike(repo, tx, await loadStrikes(repo, tx, 'admin', { clock: CLOCK }), { clock: CLOCK });

    expect(state).toEqual({ username: 'admin', strikes: null, lastAttempt: NOW });
    expect(isBlocked(state, DEFAULT_STRIKE_SETTINGS)).toBe(false);
  });
});

describe('clearStrikes', () => {
  it('resets a blocked count to 0 with an attempt a minute ago, then reloads without a second reset', async () => {
    const { repo, calls } = fakeStrikes([{ username: 'admin', strikes: 6, lastattempt: at(-MINUTE) }]);
    const { tx } = tenantTx();
    const blocked = await loadStrikes(repo, tx, 'admin', { clock: CLOCK, ctx: CTX });

    const state = await clearStrikes(repo, tx, blocked, { clock: CLOCK, ctx: CTX });

    expect(state).toEqual({ username: 'admin', strikes: 0, lastAttempt: at(-MINUTE) });
    expect(isBlocked(state, DEFAULT_STRIKE_SETTINGS)).toBe(false);
    expect(calls.slice(1)).toEqual([
      { method: 'setStrike', tx, username: 'admin', values: { strikes: 0, lastattempt: at(-MINUTE) }, ctx: CTX },
      { method: 'ensureStrike', tx, username: 'admin', at: NOW, ctx: CTX },
    ]);
  });
});

describe('isBlocked and blockedUntil', () => {
  const state = (strikes: number | null): StrikeState => ({ username: 'admin', strikes, lastAttempt: at(-2 * MINUTE) });

  it.each<[number | null, number, boolean]>([
    [0, 4, false],
    [4, 4, false],
    [5, 4, true],
    [null, 4, false],
    [0, 0, false],
    [1, 0, true],
  ])('treats %s strikes against %s allowed as blocked: %s', (strikes, allowedStrikes, blocked) => {
    expect(isBlocked(state(strikes), { allowedStrikes, blockedDurationMinutes: 10 })).toBe(blocked);
  });

  it.each<[string, number | null, StrikeSettings, Date]>([
    ['the block duration after the last attempt when blocked', 5, DEFAULT_STRIKE_SETTINGS, at(8 * MINUTE)],
    ['a minute before now when not blocked', 4, DEFAULT_STRIKE_SETTINGS, at(-MINUTE)],
    ['a minute before now for a NULL count', null, DEFAULT_STRIKE_SETTINGS, at(-MINUTE)],
    ['whole minutes of a fractional block duration, truncated', 2, { allowedStrikes: 1, blockedDurationMinutes: 2.9 }, at(0)],
  ])('ends the block at %s', (_label, strikes, settings, expected) => {
    expect(blockedUntil(state(strikes), settings, CLOCK)).toEqual(expected);
  });
});
