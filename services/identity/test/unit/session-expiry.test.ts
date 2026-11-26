/** Session expiry after legacy's session timeout: the timeout setting, activity records, the end of an expired session and the purge a new session runs, over the memory repository. */
import { describe, expect, it } from 'vitest';
import type { Clock } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A } from '@opt2/platform/testing';
import {
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  SESSION_ACTIVITY_INTERVAL_MS,
  SESSION_PURGE_BATCH,
  adoptLegacySession,
  applyLogin,
  endSession,
  ensureSession,
  sessionAdminSite,
  sessionSnapshot,
  sessionState,
  sessionTimeoutMinutes,
  type SessionDeps,
} from '../../src/domain/sessions.js';
import type { SessionLockMode } from '../../src/repo/repository.js';
import type { CsrfClaimRow, SessionRow } from '../../src/repo/tables.js';
import { legacyApiSettings } from '../../src/routes/legacy-api.js';
import { createMemoryIdentityRepo, createRecordingDb, type MemoryIdentityRepo } from '../helpers/memory-repo.js';
import { loginSnapshotFixture, sessionRow, SITE_ADMIN_A } from '../helpers/rows.js';

const START = new Date(2026, 5, 30, 12, 0, 0, 0);
const MINUTE_MS = 60_000;
const TIMEOUT_MINUTES = 30;
/** The idle time past which a session expires: the timeout and one activity interval. */
const IDLE_LIMIT_MS = TIMEOUT_MINUTES * MINUTE_MS + SESSION_ACTIVITY_INTERVAL_MS;
const REGISTRY_READ = /FROM identity\.tenant_registry\b/;
const SNAPSHOT = loginSnapshotFixture({ actor: SITE_ADMIN_A });

/** A clock a test moves. */
interface MovableClock extends Clock {
  advance(ms: number): void;
}

function movableClock(at: Date): MovableClock {
  let current = at.getTime();
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}

interface Fixture {
  repo: MemoryIdentityRepo;
  deps: SessionDeps;
  clock: MovableClock;
}

/** Session dependencies with `timeout` minutes, none for null, over a memory repository holding `sessions` and `claims`. */
function fixture(sessions: SessionRow[] = [], claims: CsrfClaimRow[] = [], timeout: number | null = TIMEOUT_MINUTES): Fixture {
  const clock = movableClock(START);
  const db = createRecordingDb({ responses: [[REGISTRY_READ, [{ tenant_id: TENANT_A.tenantId, site_id: TENANT_A.siteId }]]] });
  const repo = createMemoryIdentityRepo({ sessions, csrfClaims: claims }, { clock });
  return { repo, clock, deps: { db, repo, clock, ...(timeout === null ? {} : { sessionTimeoutMinutes: timeout }) } };
}

/** An active logged-in system-tenant session last active `idleMs` before the start. */
function idleSession(sessionId: string, idleMs: number, overrides: Partial<SessionRow> = {}): SessionRow {
  const at = new Date(START.getTime() - idleMs);
  return sessionRow({
    tenant_id: SYSTEM_TENANT_ID,
    session_id: sessionId,
    user_id: SNAPSHOT.userid,
    login_snapshot: JSON.stringify(SNAPSHOT),
    epoch: '2',
    admin_state: JSON.stringify({ siteid: TENANT_A.siteId }),
    created_at: at,
    updated_at: at,
    last_active_at: at,
    ...overrides,
  });
}

function claim(sessionId: string, token: string, tenantId = SYSTEM_TENANT_ID): CsrfClaimRow {
  return { tenant_id: tenantId, session_id: sessionId, token, state: 'used', request_id: null, claimed_at: START, used_at: START };
}

function stored(f: Fixture, sessionId: string, tenantId = SYSTEM_TENANT_ID): SessionRow | undefined {
  return f.repo.rows('session', tenantId).find((row) => row.session_id === sessionId);
}

describe('session timeout setting', () => {
  it.each<[string, string | undefined, number]>([
    ['unset', undefined, DEFAULT_SESSION_TIMEOUT_MINUTES],
    ['blank', '  ', DEFAULT_SESSION_TIMEOUT_MINUTES],
    ['zero', '0', DEFAULT_SESSION_TIMEOUT_MINUTES],
    ['below one minute', '0.5', DEFAULT_SESSION_TIMEOUT_MINUTES],
    ['negative', '-5', DEFAULT_SESSION_TIMEOUT_MINUTES],
    ['one minute', '1', 1],
    ['whole minutes with spaces', ' 45 ', 45],
    ['fractional minutes', '90.5', 90.5],
  ])('reads %s MURA_SESSIONTIMEOUT as Masa does', (_label, setting, minutes) => {
    expect(sessionTimeoutMinutes(setting)).toBe(minutes);
    expect(legacyApiSettings(setting === undefined ? {} : { MURA_SESSIONTIMEOUT: setting }).sessionTimeout).toBe(minutes);
  });

  it.each(['${application.timeout}', '{{application.timeout}}'])('reads the expression %s, which only CFML evaluates, as unset', (setting) => {
    expect(legacyApiSettings({ MURA_SESSIONTIMEOUT: setting }).sessionTimeout).toBe(DEFAULT_SESSION_TIMEOUT_MINUTES);
  });
});

describe('session activity', () => {
  it('records a state read as activity at most once per interval, writing only last_active_at', async () => {
    const f = fixture([idleSession('S-1', 0)]);

    f.clock.advance(SESSION_ACTIVITY_INTERVAL_MS - 1);
    await sessionState(f.deps, 'S-1');
    expect(f.repo.writes()).toEqual([]);

    f.clock.advance(1);
    await sessionState(f.deps, 'S-1');
    await sessionState(f.deps, 'S-1');
    expect(f.repo.writes()).toEqual([
      expect.objectContaining({ table: 'session', op: 'update', before: expect.objectContaining({ last_active_at: START }) }),
    ]);
    const [write] = f.repo.writes();
    expect(write?.after).toEqual({ ...write?.before, last_active_at: f.clock.now() });
  });

  it.each<[string, SessionRow, number | null]>([
    ['an ended session', idleSession('S-1', MINUTE_MS * 5, { state: 'ended', user_id: null }), TIMEOUT_MINUTES],
    ['an active session when no timeout is set', idleSession('S-1', MINUTE_MS * 5), null],
  ])('records no activity of %s', async (_label, row, timeout) => {
    const f = fixture([row], [], timeout);

    await sessionState(f.deps, 'S-1');

    expect(f.repo.writes()).toEqual([]);
  });

  it('records every session write as activity', async () => {
    const f = fixture([idleSession('S-1', MINUTE_MS * 20)]);

    await applyLogin(f.deps, { sessionId: 'S-1', snapshot: SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });

    expect(stored(f, 'S-1')?.last_active_at).toEqual(START);
  });

  it.each<[string, number, SessionLockMode, Date[]]>([
    ['recorded within the interval under a share lock, writing nothing', SESSION_ACTIVITY_INTERVAL_MS - 1, 'share', []],
    ['an interval old once under an update lock', SESSION_ACTIVITY_INTERVAL_MS, 'update', [START]],
  ])('records the activity of an unchanged re-adoption %s', async (_label, idleMs, lock, activity) => {
    const row = idleSession('S-1', idleMs, { mode: 'legacy-primary' });
    const f = fixture([row]);
    const locks: SessionLockMode[] = [];
    const repo = {
      ...f.repo,
      lockSession: (tx: TenantTx, sessionId: string, mode: SessionLockMode) => {
        locks.push(mode);
        return f.repo.lockSession(tx, sessionId, mode);
      },
    };
    const description = { user: { isLoggedIn: true, userID: SNAPSHOT.userid }, roles: [], csrfSecretKey: row.csrf_secret, usedTokens: [] };

    const adopted = await adoptLegacySession({ ...f.deps, repo }, { legacySessionId: 'S-1', siteId: TENANT_A.siteId, describe: description }, { mode: 'legacy-primary' });

    expect(adopted.epoch).toBe(2);
    expect(locks).toEqual([lock]);
    expect(f.repo.writes().map((write) => [write.table, write.op, write.after?.last_active_at])).toEqual(activity.map((at) => ['session', 'update', at]));
  });
});

describe('session expiry', () => {
  it('keeps a session idle for exactly the timeout plus one interval', async () => {
    const f = fixture([idleSession('S-1', IDLE_LIMIT_MS)]);

    await expect(sessionState(f.deps, 'S-1')).resolves.toMatchObject({ state: 'active', epoch: 2, userId: SNAPSHOT.userid });
  });

  it('ends a session idle any longer on its state read, as logout clears it, keeping its idle time for the purge', async () => {
    const f = fixture([idleSession('S-1', IDLE_LIMIT_MS + 1, { jar_ref: 'jar-S-1' })], [claim('S-1', 'TOKEN-1')]);

    await expect(sessionState(f.deps, 'S-1')).resolves.toEqual({ state: 'ended', epoch: 3, mode: 'target-primary', userId: '', siteId: '' });

    expect(stored(f, 'S-1')).toMatchObject({
      state: 'ended',
      epoch: '3',
      user_id: null,
      jar_ref: null,
      admin_state: null,
      ended_at: START,
      last_active_at: new Date(START.getTime() - IDLE_LIMIT_MS - 1),
    });
    expect(f.repo.rows('csrf_claim')).toEqual([]);
    await expect(sessionState(f.deps, 'S-1')).resolves.toMatchObject({ state: 'ended', epoch: 3 });
  });

  it('reads an expired session as having no snapshot and no admin site before anything ends it', async () => {
    const f = fixture([idleSession('S-1', IDLE_LIMIT_MS + 1)]);

    await expect(sessionSnapshot(f.deps, 'S-1')).resolves.toBeUndefined();
    await expect(sessionAdminSite(f.deps, 'S-1')).resolves.toBe('');
    expect(f.repo.writes()).toEqual([]);
  });

  it('reactivates an expired session as a new anonymous one under its id, as legacy starts a new session', async () => {
    const f = fixture([idleSession('S-1', IDLE_LIMIT_MS + 1)]);

    const ensured = await ensureSession(f.deps, { sessionId: 'S-1', mode: 'target-primary' });

    expect(ensured).toMatchObject({ sessionId: 'S-1', tenantId: SYSTEM_TENANT_ID, epoch: 4, created: false });
    expect(stored(f, 'S-1')).toMatchObject({ state: 'active', user_id: null, admin_state: null, last_active_at: START, epoch: '4' });
  });

  it('logs into an expired session without its admin state or jar', async () => {
    const f = fixture([idleSession('S-1', IDLE_LIMIT_MS + 1, { jar_ref: 'jar-S-1' })]);

    const applied = await applyLogin(f.deps, { sessionId: 'S-1', snapshot: SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });

    expect(applied.epoch).toBe(4);
    expect(stored(f, 'S-1')).toMatchObject({ state: 'active', user_id: SNAPSHOT.userid, admin_state: null, jar_ref: null });
  });

  it('ends an expired session once on logout', async () => {
    const f = fixture([idleSession('S-1', IDLE_LIMIT_MS + 1)]);

    await expect(endSession(f.deps, 'S-1')).resolves.toEqual({ epoch: 3 });
    await expect(endSession(f.deps, 'S-1')).resolves.toEqual({ epoch: 3 });
  });

  it('keeps an idle session legacy still describes with its secret, since legacy owns an adopted session', async () => {
    const row = idleSession('S-1', IDLE_LIMIT_MS + 1, { mode: 'legacy-primary' });
    const f = fixture([row]);
    const user = { isLoggedIn: true, userID: SNAPSHOT.userid };

    const adopted = await adoptLegacySession(
      f.deps,
      { legacySessionId: 'S-1', siteId: TENANT_A.siteId, describe: { user, roles: [], csrfSecretKey: row.csrf_secret, usedTokens: [] } },
      { mode: 'legacy-primary' },
    );

    expect(adopted.epoch).toBe(2);
    expect(stored(f, 'S-1')).toMatchObject({ state: 'active', epoch: '2', last_active_at: START });
    await expect(sessionState(f.deps, 'S-1')).resolves.toMatchObject({ state: 'active', epoch: 2 });
  });

  it('never expires a session when no timeout is set', async () => {
    const f = fixture([idleSession('S-1', 24 * 60 * MINUTE_MS)], [], null);

    await expect(sessionState(f.deps, 'S-1')).resolves.toMatchObject({ state: 'active', epoch: 2 });
    await expect(ensureSession(f.deps, { sessionId: 'S-1', mode: 'target-primary' })).resolves.toMatchObject({ epoch: 2 });
  });
});

describe('session purge', () => {
  it("removes the system tenant's sessions idle past the limit, ended or not, with their CSRF claims, when a session is created", async () => {
    const f = fixture(
      [
        idleSession('S-idle', IDLE_LIMIT_MS + 1),
        idleSession('S-ended', IDLE_LIMIT_MS + MINUTE_MS, { state: 'ended', user_id: null }),
        idleSession('S-live', IDLE_LIMIT_MS - 1),
        idleSession('S-site', IDLE_LIMIT_MS * 2, { tenant_id: TENANT_A.tenantId }),
      ],
      [claim('S-idle', 'TOKEN-1'), claim('S-idle', 'TOKEN-2'), claim('S-live', 'TOKEN-3'), claim('S-site', 'TOKEN-4', TENANT_A.tenantId)],
    );

    const created = await ensureSession(f.deps, { mode: 'target-primary' });

    expect(f.repo.rows('session', SYSTEM_TENANT_ID).map((row) => row.session_id).sort()).toEqual(['S-live', created.sessionId].sort());
    expect(f.repo.rows('session', TENANT_A.tenantId).map((row) => row.session_id)).toEqual(['S-site']);
    expect(f.repo.rows('csrf_claim').map((row) => row.token).sort()).toEqual(['TOKEN-3', 'TOKEN-4']);
    expect(f.repo.writes().filter((write) => write.op === 'delete').map((write) => [write.table, write.key])).toEqual([
      ['csrf_claim', { session_id: 'S-idle', token: 'TOKEN-1' }],
      ['csrf_claim', { session_id: 'S-idle', token: 'TOKEN-2' }],
      ['session', { session_id: 'S-ended' }],
      ['session', { session_id: 'S-idle' }],
    ]);
  });

  it('removes at most one batch per new session, oldest first', async () => {
    const extra = 5;
    const rows = Array.from({ length: SESSION_PURGE_BATCH + extra }, (_, i) => idleSession(`S-${String(i).padStart(3, '0')}`, IDLE_LIMIT_MS + 1 + i * 1000));
    const f = fixture(rows);

    await ensureSession(f.deps, { sessionId: 'S-new', mode: 'target-primary' });

    const kept = f.repo.rows('session', SYSTEM_TENANT_ID).map((row) => row.session_id).sort();
    expect(kept).toEqual(['S-000', 'S-001', 'S-002', 'S-003', 'S-004', 'S-new']);
  });

  it.each<[string, (deps: SessionDeps) => Promise<unknown>]>([
    ['an adoption', (deps) => adoptLegacySession(deps, { legacySessionId: 'S-new', siteId: TENANT_A.siteId, describe: { user: {}, roles: [], csrfSecretKey: 'SECRET', usedTokens: [] } }, { mode: 'legacy-primary' })],
    ['a login', (deps) => applyLogin(deps, { sessionId: 'S-new', snapshot: SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId })],
  ])('purges when %s creates a session', async (_label, create) => {
    const f = fixture([idleSession('S-idle', IDLE_LIMIT_MS + 1)]);

    await create(f.deps);

    expect(f.repo.rows('session', SYSTEM_TENANT_ID).map((row) => row.session_id)).toEqual(['S-new']);
  });

  it('purges nothing when a session write creates no row, or when no timeout is set', async () => {
    const live = fixture([idleSession('S-live', MINUTE_MS), idleSession('S-idle', IDLE_LIMIT_MS + 1)]);
    await applyLogin(live.deps, { sessionId: 'S-live', snapshot: SNAPSHOT, mode: 'target-primary', siteId: TENANT_A.siteId });
    expect(stored(live, 'S-idle')).toBeDefined();

    const unset = fixture([idleSession('S-idle', IDLE_LIMIT_MS * 10)], [], null);
    await ensureSession(unset.deps, { mode: 'target-primary' });
    expect(stored(unset, 'S-idle')).toBeDefined();
  });
});
