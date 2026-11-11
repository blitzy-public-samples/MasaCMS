/** Site-monitor orchestrator replacing legacy `/_api/sitemonitor` (contentServer.cfc:669-747): cursor, catch-up, step order and per-site gating. */
import { registeredTenants, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { SITEMONITOR_QUEUE, queueDefinition } from '@opt2/platform/tasks';
import { cfDateAdd, cfIsBoolean, cfToBoolean } from '@opt2/platform/legacy-compat';
import { stepNamed, type SiteMonitorStepName } from './steps.js';
import { SiteMonitorDeadlineError, type StepDispatcher, type StepInvocation, type StepOutcome } from './dispatch.js';
import { readCursor, writeCursor } from '../repo/sitemonitor-state.js';
import { createProgramsSitesRepository } from '../repo/repository.js';
import type { SiteRow } from '../repo/tables.js';

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

/** The persisted `application.lastMonitored`. */
export interface CursorStore {
  read(): Promise<Date | null>;
  write(at: Date): Promise<void>;
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
}

/** A completed run: its `theTime` and one outcome per dispatched step, in dispatch order. */
export interface SiteMonitorResult {
  theTime: Date;
  steps: StepOutcome[];
}

/** A run that stopped before `setCursor`, leaving the cursor unchanged; `completed` holds the outcomes before the stop. */
export class SiteMonitorRunError extends Error {
  override readonly name: string = 'SiteMonitorRunError';

  constructor(
    readonly reason: 'step-failed' | 'deadline',
    readonly step: SiteMonitorStepName | undefined,
    readonly siteId: string | undefined,
    readonly completed: StepOutcome[],
    cause?: unknown,
  ) {
    super(
      `Site monitor ${reason === 'deadline' ? 'deadline passed at' : 'failed at'} step ${String(step)}` +
        (siteId === undefined ? '' : ` for site ${siteId}`),
      cause === undefined ? undefined : { cause },
    );
  }
}

/** Cursor store over the system-tenant `sitemonitor_state` row. */
export function defaultCursorStore(db: TenantDb, clock: Clock): CursorStore {
  return {
    read: () => readCursor(db),
    write: (at) => writeCursor(db, at, clock),
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

/** Runs one site-monitor pass; rejects with `SiteMonitorRunError` at the first failed step or at the queue deadline. */
export async function runSiteMonitor(deps: SiteMonitorDeps): Promise<SiteMonitorResult> {
  const { clock, dispatch } = deps;
  const cursor = deps.cursor ?? defaultCursorStore(deps.db, clock);
  const siteFlags = deps.sites ?? registrySiteFlags(deps.db, clock);

  const theTime = clock.now();
  const deadlineAt = new Date(theTime.getTime() + queueDefinition(SITEMONITOR_QUEUE).deadlineS * 1000);

  // legacy: contentServer.cfc:676 cfparam stores the default before any step runs, so a failed first run keeps it.
  const stored = await cursor.read();
  const lastMonitored = stored ?? cfDateAdd('n', -1, theTime);
  if (stored === null) await cursor.write(lastMonitored);

  const steps: StepOutcome[] = [];

  async function run(name: SiteMonitorStepName, siteId?: string, at: Date = theTime): Promise<void> {
    if (clock.now().getTime() >= deadlineAt.getTime()) {
      throw new SiteMonitorRunError('deadline', name, siteId, [...steps]);
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
      const reason = cause instanceof SiteMonitorDeadlineError ? 'deadline' : 'step-failed';
      throw new SiteMonitorRunError(reason, name, siteId, [...steps], cause);
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
  await cursor.write(theTime);

  return { theTime, steps };
}
