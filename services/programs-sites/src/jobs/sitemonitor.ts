/** Site-monitor orchestrator replacing legacy `/_api/sitemonitor` (contentServer.cfc:669-747): cursor and run lease, catch-up, step order and per-site gating. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { registeredTenants, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import type { WriteContext } from '@opt2/platform/migration-kit';
import { SITEMONITOR_QUEUE, queueDefinition } from '@opt2/platform/tasks';
import { LegacyServiceUnavailableError, cfDateAdd, cfIsBoolean, cfToBoolean } from '@opt2/platform/legacy-compat';
import { stepNamed, type SiteMonitorStepName } from './steps.js';
import { SiteMonitorDeadlineError, type StepDispatcher, type StepInvocation, type StepOutcome } from './dispatch.js';
import { acquireLease, advanceCursor, releaseLease, type LeaseGrant } from '../repo/sitemonitor-state.js';
import { OWNER, createProgramsSitesRepository } from '../repo/repository.js';
import type { SiteRow } from '../repo/tables.js';

const DEFAULT_LEASE_POLL_MS = 1000;

/** One site as the monitor loops see it. */
export interface MonitoredSite {
  readonly siteId: string;
  readonly tenantId: string;
  /** Stored per-site `EmailBroadcaster` flag. */
  readonly emailBroadcaster: boolean;
  readonly feedManager: boolean;
  readonly mailServerUsername: string;
  /** `tsettings.orderno`; NULL is -Infinity so it sorts first, as SQL Server's `ORDER BY orderno asc` does. */
  readonly orderNo: number;
}

/** The persisted `application.lastMonitored` behind the run lease that serialises passes across instances. */
export interface CursorStore {
  /** Takes the lease for `leaseId` until `until` unless another pass holds a live one. */
  acquire(leaseId: string, until: Date): Promise<LeaseGrant>;
  /** Moves the cursor forward to `at` while `leaseId` holds the lease; false once it no longer does. */
  advance(leaseId: string, at: Date): Promise<boolean>;
  /** Clears the lease while `leaseId` holds it; false when it does not. */
  release(leaseId: string): Promise<boolean>;
}

/** Sites the per-site loops iterate, in loop order. */
export interface SiteFlagsSource {
  list(): Promise<readonly MonitoredSite[]>;
}

/** Dependencies of `runSiteMonitor`; `cursor` and `sites` default to the `programs_sites` adapters over `db`. */
export interface SiteMonitorDeps {
  db: TenantDb;
  clock: Clock;
  dispatch: StepDispatcher;
  cursor?: CursorStore;
  sites?: SiteFlagsSource;
  /** Waits `ms` between lease attempts; defaults to a timer. */
  sleep?: (ms: number) => Promise<unknown>;
  /** Interval between lease attempts while another pass holds the lease; default 1000 ms. */
  pollIntervalMs?: number;
}

/** A completed run: its `theTime` and one outcome per dispatched step, in dispatch order. */
export interface SiteMonitorResult {
  theTime: Date;
  steps: StepOutcome[];
}

/** Why a pass stopped. */
export type SiteMonitorStopReason = 'step-failed' | 'deadline';

/** Where a pass stopped before advancing the cursor; `step` is undefined before the first step, `completed` holds the outcomes before the stop. */
export interface SiteMonitorStop {
  readonly reason: SiteMonitorStopReason;
  readonly step: SiteMonitorStepName | undefined;
  readonly siteId: string | undefined;
  readonly completed: StepOutcome[];
}

function stopMessage(reason: SiteMonitorStopReason, step: SiteMonitorStepName | undefined, siteId: string | undefined): string {
  const at = step === undefined ? 'before the first step' : `at step ${step}${siteId === undefined ? '' : ` for site ${siteId}`}`;
  return `Site monitor ${reason === 'deadline' ? 'deadline passed' : 'failed'} ${at}`;
}

/** A pass stopped by a fault that is neither unavailability nor the deadline; renders as a 500. */
export class SiteMonitorRunError extends Error implements SiteMonitorStop {
  override readonly name: string = 'SiteMonitorRunError';

  constructor(
    readonly reason: SiteMonitorStopReason,
    readonly step: SiteMonitorStepName | undefined,
    readonly siteId: string | undefined,
    readonly completed: StepOutcome[],
    cause?: unknown,
  ) {
    super(stopMessage(reason, step, siteId), cause === undefined ? undefined : { cause });
  }
}

/** A pass stopped by the deadline or an unavailable executor; renders as the legacy 503 on the cause's surface. */
export class SiteMonitorUnavailableError extends LegacyServiceUnavailableError implements SiteMonitorStop {
  override readonly name: string = 'SiteMonitorUnavailableError';
  // Narrows the base field, which the base constructor assigns; a field declaration would reset it after super().
  declare readonly reason: SiteMonitorStopReason;

  constructor(
    reason: SiteMonitorStopReason,
    readonly step: SiteMonitorStepName | undefined,
    readonly siteId: string | undefined,
    readonly completed: StepOutcome[],
    override readonly cause?: unknown,
  ) {
    super(stopMessage(reason, step, siteId), cause instanceof LegacyServiceUnavailableError ? cause.surface : 'auto', reason);
  }
}

/** The stop error for `cause`: SiteMonitorUnavailableError for the deadline or an unavailable cause, else SiteMonitorRunError. */
export function siteMonitorStop(
  reason: SiteMonitorStopReason,
  step: SiteMonitorStepName | undefined,
  siteId: string | undefined,
  completed: StepOutcome[],
  cause?: unknown,
): SiteMonitorRunError | SiteMonitorUnavailableError {
  return reason === 'deadline' || cause instanceof LegacyServiceUnavailableError
    ? new SiteMonitorUnavailableError(reason, step, siteId, completed, cause)
    : new SiteMonitorRunError(reason, step, siteId, completed, cause);
}

/** Cursor store over the system-tenant `sitemonitor_state` row; its changelog rows name programs-sites as the actor. */
export function defaultCursorStore(db: TenantDb, clock: Clock): CursorStore {
  const ctx: WriteContext = { actorService: OWNER };
  return {
    acquire: (leaseId, until) => acquireLease(db, leaseId, until, clock, ctx),
    advance: (leaseId, at) => advanceCursor(db, leaseId, at, clock, ctx),
    release: (leaseId) => releaseLease(db, leaseId, clock, ctx),
  };
}

/** CFML truthiness of a stored int flag; NULL reads as off, where legacy's `cfif` would throw. */
function cfFlag(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toMonitoredSite(tenantId: string, row: SiteRow): MonitoredSite {
  const mailServerUsername = row.mailserverusername;
  return {
    siteId: row.siteid,
    tenantId,
    emailBroadcaster: cfFlag(row.emailbroadcaster),
    feedManager: cfFlag(row.feedmanager),
    // getMailServerUsername(forLogin=false) returns the stored value (settingsBean.cfc:456-462).
    mailServerUsername: typeof mailServerUsername === 'string' ? mailServerUsername : '',
    orderNo: row.orderno ?? Number.NEGATIVE_INFINITY,
  };
}

/** Registered sites by `siteId`, each read in its own tenant; a registry entry without a site row is skipped. */
export function registrySiteFlags(db: TenantDb, clock: Clock): SiteFlagsSource {
  // The site table is read from the same schema as the registry and the cursor, which tests replace with a throwaway one.
  const repo = createProgramsSitesRepository({ clock, schema: db.schema });
  return {
    async list() {
      const entries = [...(await registeredTenants(db))].sort((a, b) => compareText(a.siteId, b.siteId));
      const sites: MonitoredSite[] = [];
      for (const entry of entries) {
        const row = await withTenant(db, entry.tenantId, (tx) => repo.readSite(tx, entry.siteId));
        if (row !== null) sites.push(toMonitoredSite(entry.tenantId, row));
      }
      return sites;
    },
  };
}

/** `getList()` order: `orderNo` ascending, ties by `siteId`. */
function byOrderNo(a: MonitoredSite, b: MonitoredSite): number {
  if (a.orderNo !== b.orderNo) return a.orderNo < b.orderNo ? -1 : 1;
  return compareText(a.siteId, b.siteId);
}

/** Polls for the run lease; the stored cursor once granted, SiteMonitorUnavailableError once `deadlineAt` passes first. */
async function acquireRunLease(
  cursor: CursorStore,
  leaseId: string,
  deadlineAt: Date,
  clock: Clock,
  sleep: (ms: number) => Promise<unknown>,
  pollIntervalMs: number,
): Promise<Date | null> {
  for (;;) {
    const grant = await cursor.acquire(leaseId, deadlineAt);
    if (grant.status === 'granted') return grant.lastMonitored;
    const remainingMs = deadlineAt.getTime() - clock.now().getTime();
    if (remainingMs <= 0) throw new SiteMonitorUnavailableError('deadline', undefined, undefined, []);
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

/** Runs one site-monitor pass under the run lease; rejects with `siteMonitorStop`'s error at the first failed step, at the queue deadline or when the lease is lost. */
export async function runSiteMonitor(deps: SiteMonitorDeps): Promise<SiteMonitorResult> {
  const cursor = deps.cursor ?? defaultCursorStore(deps.db, deps.clock);
  const startedAt = deps.clock.now();
  const deadlineAt = new Date(startedAt.getTime() + queueDefinition(SITEMONITOR_QUEUE).deadlineS * 1000);
  const leaseId = randomUUID();
  const stored = await acquireRunLease(
    cursor,
    leaseId,
    deadlineAt,
    deps.clock,
    deps.sleep ?? delay,
    deps.pollIntervalMs ?? DEFAULT_LEASE_POLL_MS,
  );
  let result: SiteMonitorResult;
  try {
    result = await runPass(deps, cursor, leaseId, stored, deadlineAt);
  } catch (err) {
    // A failed release must not replace the pass's error; the lease then lapses at deadlineAt.
    await cursor.release(leaseId).catch(() => false);
    throw err;
  }
  await cursor.release(leaseId);
  return result;
}

/** The steps of one pass while `leaseId` holds the lease; `stored` is the cursor the grant returned. */
async function runPass(
  deps: SiteMonitorDeps,
  cursor: CursorStore,
  leaseId: string,
  stored: Date | null,
  deadlineAt: Date,
): Promise<SiteMonitorResult> {
  const { clock, dispatch } = deps;
  const siteFlags = deps.sites ?? registrySiteFlags(deps.db, clock);
  const steps: StepOutcome[] = [];

  // Taken after the grant, so a pass that waited starts where the previous pass ended.
  const theTime = clock.now();

  /** Advances the cursor to `at`; a lease another pass took after it lapsed stops this pass as past its deadline. */
  async function advance(at: Date, step: SiteMonitorStepName | undefined): Promise<void> {
    if (!(await cursor.advance(leaseId, at))) throw new SiteMonitorUnavailableError('deadline', step, undefined, [...steps]);
  }

  // legacy: contentServer.cfc:676 cfparam stores the default before any step runs, so a failed first run keeps it.
  const lastMonitored = stored ?? cfDateAdd('n', -1, theTime);
  if (stored === null) await advance(lastMonitored, undefined);

  async function run(name: SiteMonitorStepName, siteId?: string, at: Date = theTime): Promise<void> {
    if (clock.now().getTime() >= deadlineAt.getTime()) {
      throw new SiteMonitorUnavailableError('deadline', name, siteId, [...steps]);
    }
    const invocation: StepInvocation = {
      step: stepNamed(name),
      ...(siteId === undefined ? {} : { siteId }),
      theTime: at,
      lastMonitored,
      runAt: theTime,
      deadlineAt,
    };
    try {
      steps.push(await dispatch.dispatch(invocation));
    } catch (cause) {
      throw siteMonitorStop(cause instanceof SiteMonitorDeadlineError ? 'deadline' : 'step-failed', name, siteId, [...steps], cause);
    }
  }

  // legacy: contentServer.cfc:677-683 compares minute-of-hour only, in the process TZ (the legacy server zone).
  const prev = cfDateAdd('n', -30, theTime);
  if (lastMonitored.getMinutes() !== prev.getMinutes()) await run('sendReminders', undefined, prev);
  await run('sendReminders');
  await run('emailSend');
  await run('publishScheduledChangesets');

  const sites = await siteFlags.list();
  for (const site of sites) {
    // legacy: contentServer.cfc:692-694 discards listAppend's result, so sites sharing a mail user are never deduped.
    // coordination gap: legacy getEmailBroadcaster() is 0 while the global emailBroadcaster config is off
    // (settingsBean.cfc:435-441); the target cannot read it, so jobs.cfm?job=trackBounces re-applies that getter.
    if (site.emailBroadcaster) await run('trackBounces', site.siteId);
    if (site.feedManager) await run('feedAutoImport', site.siteId);
  }

  await run('purgeDisplayWindow');
  await run('clearOldCommands');
  await run('onGlobalMonitor');
  // legacy: contentServer.cfc:739-743 announces onSiteMonitor in getList() order (settingsGateway.cfc:86-121).
  for (const site of [...sites].sort(byOrderNo)) await run('onSiteMonitor', site.siteId);

  // legacy: contentServer.cfc:745 moves the cursor only after every step succeeded.
  await run('setCursor');
  await advance(theTime, 'setCursor');

  return { theTime, steps };
}
