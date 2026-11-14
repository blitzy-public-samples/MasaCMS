// Scripted fault window-import-interrupted: one legacy write inside a write window whose import the running service fails until resume.
import sql from 'mssql';
import { z } from '@opt2/platform/service-kit';

import { runFeed } from '../../apply/index.js';
import type { MigrationContext } from '../../context.js';
import { currentAuthority, loadVersion, type CurrentAuthority } from '../../cutover/index.js';
import type { paths } from '../../generated/openapi.js';
import { completeWindowViaService, openWindowViaService } from '../../windows/index.js';
import { WindowCallError, type WindowOpenResponse, type WriteWindow } from '../../windows/via-service.js';
import { fail, pass, skipped, type FaultAssertion, type FaultEnv, type FaultResumeOutput, type FaultRunOutput, type FaultScript } from './types.js';

const FAULT = 'window-import-interrupted';
const ROUTE_KEY = `fault:${FAULT}`;
const LEGACY_TABLE = 'tcontent';
/** Route key of the gateway's anonymous JSON API read `GET /_api/json/v1/<site>/content/<id>`. */
const CONTENT_READ_ROUTE = 'api:content.findone';
const MIGRATION_SERVICE = 'migration';
const WINDOW_PATH = '/internal/v1/windows/{windowId}' satisfies keyof paths;
const POLL_MS = 1000;
const HTTP_OK = 200;
const HTTP_UNAVAILABLE = 503;

const FAULT_CLEARED = 'fault-cleared';
const IMPORT_PENDING = 'window-import-pending';
const READ_NOT_SUPERSEDED = 'read-not-superseded';
const RETRY_CLOSED = 'retry-closed';
const FEED_PROPAGATED = 'feed-propagated';
const TARGET_READ_CURRENT = 'target-read-current';

// Restricted pages are left out because the read check reads anonymously.
const PICK_SQL = `SELECT TOP 1 [ContentHistID], [ContentID], [Credits] FROM [dbo].[tcontent]
WHERE [SiteID] = @siteId AND [Active] = 1 AND [Approved] = 1 AND [Type] = 'Page' AND ISNULL([Restricted], 0) = 0
ORDER BY [ContentHistID]`;
const UPDATE_SQL = 'UPDATE [dbo].[tcontent] SET [Credits] = @credits WHERE [ContentHistID] = @contentHistId';

const paramsSchema = z
  .object({
    siteId: z.string().min(1).default('tenant-a'),
    units: z.array(z.string()).min(1).optional(),
    readTimeoutMs: z.number().int().positive().default(35_000),
    closeTimeoutMs: z.number().int().positive().default(60_000),
  })
  .strict();

/** Parameters of {@link windowImportInterrupted}; `units` defaults to the units of `tcontent`. */
export type WindowImportParams = z.output<typeof paramsSchema>;

/** What `run` hands `resume`: the opened window and whether legacy committed the write inside it. */
const stateSchema = z.object({
  windowId: z.string().min(1),
  completed: z.boolean(),
  written: z.boolean(),
  siteId: z.string(),
  contentId: z.string(),
  newCredits: z.string(),
  units: z.array(z.string()),
});

type WindowState = z.output<typeof stateSchema>;

interface ContentRow {
  ContentHistID: string;
  ContentID: string;
  Credits: string | null;
}

/** A gateway read of one content node: its status and `data.credits`, or `waited` when it outlasted the timeout. */
type ContentRead = { kind: 'status'; status: number; credits?: string | null } | { kind: 'waited' };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function versionOf(authority: CurrentAuthority): string {
  return authority.tableVersion ?? 'no active version';
}

/** The window's units: `params.units` or the units of `tcontent`, without repeats. */
function windowUnits(ctx: MigrationContext, params: WindowImportParams): string[] {
  const units = params.units ?? ctx.catalog.unitsForLegacyTable(LEGACY_TABLE).map((target) => target.unit);
  return [...new Set(units)];
}

/** Whether the active version routes the content read to the target; no version or no entry for it means legacy. @throws when the version file cannot be read */
function readReachesTarget(ctx: MigrationContext, authority: CurrentAuthority): boolean {
  if (authority.tableVersion === null) return false;
  const { entries } = loadVersion(ctx.config.paths.cutoverDir, authority.tableVersion);
  return entries.some((entry) => entry.route === CONTENT_READ_ROUTE && entry.state === 'target');
}

/** Skip reason of a read check whose content read routes to legacy. */
function legacyReadReason(authority: CurrentAuthority): string {
  return `the content read (${CONTENT_READ_ROUTE}) routes to legacy under ${versionOf(authority)}`;
}

/** Reads window `windowId` from the running migration service (`windowGet`). @throws WindowCallError on a non-200 answer */
async function getWindow(ctx: Pick<MigrationContext, 'clientAs'>, windowId: string): Promise<WriteWindow> {
  const response = await ctx.clientAs('operator').request<WriteWindow>({
    service: MIGRATION_SERVICE,
    method: 'GET',
    path: WINDOW_PATH.replace('{windowId}', encodeURIComponent(windowId)),
    userToken: null,
  });
  if (response.status !== HTTP_OK) throw new WindowCallError('windowGet', response.status, response.body);
  return response.body;
}

function isTimeout(error: unknown): boolean {
  const { name } = (error ?? {}) as { name?: unknown };
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Anonymous JSON API read of content `contentId` through the gateway, bounded by `timeoutMs`. */
async function readContent(ctx: Pick<MigrationContext, 'env'>, siteId: string, contentId: string, timeoutMs: number): Promise<ContentRead> {
  const gatewayUrl = ctx.env.OPT2_GATEWAY_URL;
  if (gatewayUrl === undefined) throw new Error('OPT2_GATEWAY_URL is not set');
  const url = new URL(`/_api/json/v1/${encodeURIComponent(siteId)}/content/${encodeURIComponent(contentId)}`, gatewayUrl);
  let status: number;
  let text: string;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if (isTimeout(error)) return { kind: 'waited' };
    throw error;
  }
  if (status !== HTTP_OK) return { kind: 'status', status };
  let credits: unknown;
  try {
    credits = (JSON.parse(text) as { data?: { credits?: unknown } } | null)?.data?.credits;
  } catch {
    return { kind: 'status', status };
  }
  return typeof credits === 'string' || credits === null ? { kind: 'status', status, credits } : { kind: 'status', status };
}

/**
 * Verdict on a read while the import is pending. Only the value legacy committed passes on a 200: the old value, or its
 * null/empty serialisation, is the superseded one, and no other writer touches the row inside the window.
 */
function readVerdict(read: ContentRead, newCredits: string, oldCredits: string | null, timeoutMs: number): FaultAssertion {
  if (read.kind === 'waited') return pass(READ_NOT_SUPERSEDED, { read: 'waited', timeoutMs });
  if (read.status === HTTP_UNAVAILABLE) return pass(READ_NOT_SUPERSEDED, { status: read.status });
  const detail = { status: read.status, credits: read.credits ?? null, oldCredits, newCredits };
  if (read.status !== HTTP_OK) return fail(READ_NOT_SUPERSEDED, detail, `the gateway answered HTTP ${String(read.status)}`);
  if (read.credits === newCredits) return pass(READ_NOT_SUPERSEDED, detail);
  const superseded = (read.credits ?? '') === (oldCredits ?? '');
  return fail(READ_NOT_SUPERSEDED, detail, superseded ? 'the superseded value was served' : 'a value legacy never committed was served');
}

/** Arms the import fault, writes the row as the window's legacy writer and completes the window; the window stays import-pending. */
async function run(env: FaultEnv, params: WindowImportParams): Promise<FaultRunOutput> {
  const { ctx } = env;
  const { siteId, readTimeoutMs } = params;
  const units = windowUnits(ctx, params);
  const pool = await ctx.legacy.live();
  const picked = await pool.request().input('siteId', sql.NVarChar(25), siteId).query<ContentRow>(PICK_SQL);
  const row = picked.recordset[0];
  if (row === undefined) {
    return { assertions: [fail(IMPORT_PENDING, { siteId }, 'no active approved Page in tcontent for the site')], details: { siteId, units } };
  }
  const { ContentHistID: contentHistId, ContentID: contentId, Credits: oldCredits } = row;
  const base = { siteId, contentId, contentHistId, oldCredits, units };

  let opened: WindowOpenResponse;
  try {
    opened = await openWindowViaService(ctx, { routeKey: ROUTE_KEY, units, scope: { keys: { siteid: siteId, contentid: contentId } } });
  } catch (error) {
    return { assertions: [fail(IMPORT_PENDING, { ...base, error: messageOf(error) }, 'the migration service refused the write window')], details: base };
  }

  const { windowId } = opened;
  const newCredits = `opt2-fault-${windowId}`;
  const state: WindowState = { windowId, completed: false, written: false, siteId, contentId, newCredits, units };
  const details: Record<string, unknown> = { ...base, windowId, newCredits };
  const done = (assertions: FaultAssertion[]): FaultRunOutput => ({ assertions, details, state });

  // From here every failure is an assertion, so `resume` always receives the window to complete.
  let authority: CurrentAuthority;
  let readsTarget: boolean;
  try {
    // The window leases its units, so no transition can change their authority until it closes.
    authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
    readsTarget = readReachesTarget(ctx, authority);
    await env.remote.set(FAULT, { windowId });
    const update = await pool
      .request()
      .input('credits', sql.NVarChar(255), newCredits)
      .input('contentHistId', sql.Char(35), contentHistId)
      .query(UPDATE_SQL);
    const rowsAffected = update.rowsAffected[0] ?? 0;
    state.written = rowsAffected > 0;
    if (rowsAffected !== 1) return done([fail(IMPORT_PENDING, { ...details, rowsAffected }, 'the in-window legacy UPDATE did not change exactly one row')]);
  } catch (error) {
    return done([fail(IMPORT_PENDING, { ...details, error: messageOf(error) }, 'the fault could not be armed or the legacy row written inside the window')]);
  }

  const targetUnits = units.filter((unit) => authority.isTargetAuthoritative(unit));
  Object.assign(details, { targetUnits, tableVersion: authority.tableVersion });

  try {
    details.completion = await completeWindowViaService(ctx, windowId, { forwarded: true });
    // Left false on an error, so `resume` sends it again: a repeated complete answers the window's state and changes nothing.
    state.completed = true;
  } catch (error) {
    details.completeError = messageOf(error);
  }

  // The service imports only units whose gates the window closed, which are the target-authoritative ones; with none
  // there is no import to interrupt and legacy's write reaches the target through the forward feed, checked in `resume`.
  if (targetUnits.length === 0) {
    const cannotRun = (check: string): string => `the ${check} check cannot run under ${versionOf(authority)}: no unit of the window is target-authoritative`;
    return done([
      skipped(IMPORT_PENDING, `${cannotRun('import-pending')}, so the window closes no gates and imports nothing`),
      skipped(READ_NOT_SUPERSEDED, `${cannotRun('protected-read')}, so reads route to legacy`),
    ]);
  }

  const assertions: FaultAssertion[] = [];
  try {
    const window = await getWindow(ctx, windowId);
    assertions.push(
      window.state === 'import-pending'
        ? pass(IMPORT_PENDING, window)
        : fail(IMPORT_PENDING, window, `window ${windowId} is ${window.state}, not import-pending`),
    );
  } catch (error) {
    assertions.push(fail(IMPORT_PENDING, { windowId, error: messageOf(error) }, 'the window could not be read'));
  }
  if (!readsTarget) return done([...assertions, skipped(READ_NOT_SUPERSEDED, legacyReadReason(authority))]);
  try {
    assertions.push(readVerdict(await readContent(ctx, siteId, contentId, readTimeoutMs), newCredits, oldCredits, readTimeoutMs));
  } catch (error) {
    assertions.push(fail(READ_NOT_SUPERSEDED, { siteId, contentId, error: messageOf(error) }, 'the gateway read failed'));
  }
  return done(assertions);
}

/** Polls the window every second until it is closed, aborted or `timeoutMs` has elapsed. */
async function awaitClosed(env: FaultEnv, windowId: string, timeoutMs: number): Promise<FaultAssertion> {
  const startedAt = env.clock.now().getTime();
  let window: WriteWindow | undefined;
  let error: string | undefined;
  for (;;) {
    try {
      window = await getWindow(env.ctx, windowId);
      error = undefined;
    } catch (caught) {
      error = messageOf(caught);
    }
    const elapsedMs = env.clock.now().getTime() - startedAt;
    if (window?.state === 'closed') return pass(RETRY_CLOSED, { elapsedMs, window });
    if (window?.state === 'aborted' || elapsedMs >= timeoutMs) {
      return fail(RETRY_CLOSED, { elapsedMs, window: window ?? null, ...(error === undefined ? {} : { error }) }, `window ${windowId} did not close within ${String(timeoutMs)} ms`);
    }
    await env.sleep(POLL_MS);
  }
}

/** Forward-feeds the legacy-authoritative units and re-reads the target-authoritative ones where the content read reaches the target, after the window closed. */
async function propagation(env: FaultEnv, state: WindowState, timeoutMs: number): Promise<{ steps: string[]; assertions: FaultAssertion[] }> {
  const { ctx } = env;
  let authority: CurrentAuthority;
  let readsTarget: boolean;
  try {
    authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
    readsTarget = readReachesTarget(ctx, authority);
  } catch (error) {
    return { steps: [], assertions: [fail(FEED_PROPAGATED, { error: messageOf(error) }, 'the active cut-over version could not be read')] };
  }
  const steps: string[] = [];
  const assertions: FaultAssertion[] = [];
  if (state.units.some((unit) => !authority.isTargetAuthoritative(unit))) {
    try {
      const feed = await runFeed(ctx);
      const detail = { snapshotSeq: feed.snapshotSeq, tableVersion: feed.tableVersion, exitCode: feed.exitCode, reconciliation: feed.reconciliation };
      assertions.push(feed.exitCode === 0 ? pass(FEED_PROPAGATED, detail) : fail(FEED_PROPAGATED, detail, `the forward feed ended with exit code ${String(feed.exitCode)}`));
    } catch (error) {
      assertions.push(fail(FEED_PROPAGATED, { error: messageOf(error) }, 'the forward feed failed'));
    }
    steps.push('rerun-feed');
  }
  const anyTarget = state.units.some((unit) => authority.isTargetAuthoritative(unit));
  if (anyTarget && !readsTarget) {
    assertions.push(skipped(TARGET_READ_CURRENT, legacyReadReason(authority)));
  } else if (anyTarget) {
    try {
      const read = await readContent(ctx, state.siteId, state.contentId, timeoutMs);
      const detail = read.kind === 'waited' ? { read: 'waited', timeoutMs } : { status: read.status, credits: read.credits ?? null, newCredits: state.newCredits };
      assertions.push(
        read.kind === 'status' && read.status === HTTP_OK && read.credits === state.newCredits
          ? pass(TARGET_READ_CURRENT, detail)
          : fail(TARGET_READ_CURRENT, detail, 'the target does not serve the value legacy committed inside the window'),
      );
    } catch (error) {
      assertions.push(fail(TARGET_READ_CURRENT, { error: messageOf(error) }, 'the gateway read failed'));
    }
    steps.push('reread-target');
  }
  return { steps, assertions };
}

/** Disarms the fault, completes a window `run` left open, awaits the service's retry closing it and checks the write propagated. */
async function resume(env: FaultEnv, params: WindowImportParams, output?: FaultRunOutput): Promise<FaultResumeOutput> {
  const { ctx } = env;
  const steps: string[] = [];
  const assertions: FaultAssertion[] = [];
  const details: Record<string, unknown> = {};
  const result = (): FaultResumeOutput => (Object.keys(details).length > 0 ? { steps, assertions, details } : { steps, assertions });

  try {
    await env.remote.clear(FAULT);
    assertions.push(pass(FAULT_CLEARED));
  } catch (error) {
    assertions.push(fail(FAULT_CLEARED, { error: messageOf(error) }, 'the migration service did not confirm the fault was cleared'));
  }
  steps.push('clear-fault');

  const parsed = stateSchema.safeParse(output?.state);
  if (!parsed.success) return result();
  const state = parsed.data;

  if (!state.completed) {
    try {
      details.completion = await completeWindowViaService(ctx, state.windowId, { forwarded: state.written });
    } catch (error) {
      details.completeError = messageOf(error);
    }
    steps.push('complete-window');
  }

  assertions.push(await awaitClosed(env, state.windowId, params.closeTimeoutMs));
  steps.push('await-closed');

  if (state.written) {
    const propagated = await propagation(env, state, params.readTimeoutMs);
    steps.push(...propagated.steps);
    assertions.push(...propagated.assertions);
  }
  return result();
}

/** Interrupts a write window's import after legacy committed its write, checks the pending window and its reads, then lets the service's retry close it. */
export const windowImportInterrupted: FaultScript<WindowImportParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,
  run,
  resume,
};
