// Scripted fault window-import-interrupted: one legacy write inside a write window whose import the running service fails until
// resume, which then writes the old value back inside a second window.
import sql from 'mssql';
import type { ConnectionPool } from 'mssql';
import { ServiceUnavailableError, z, type ServiceResponse } from '@opt2/platform/service-kit';

import { runFeed } from '../../apply/index.js';
import type { MigrationContext } from '../../context.js';
import { currentAuthority, type CurrentAuthority } from '../../cutover/index.js';
import type { paths } from '../../generated/openapi.js';
import { completeWindowViaService, openWindowViaService } from '../../windows/index.js';
import { WindowCallError, type WindowOpenResponse, type WindowScope, type WriteWindow } from '../../windows/via-service.js';
import { fail, pass, skipped, type FaultAssertion, type FaultEnv, type FaultResumeOutput, type FaultRunOutput, type FaultScript } from './types.js';

const FAULT = 'window-import-interrupted';
const ROUTE_KEY = `fault:${FAULT}`;
const LEGACY_TABLE = 'tcontent';
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
const ROW_RESTORED = 'row-restored';

/** Query of every owner read: the JSON API's default content fields leave out `credits`, a selected field is answered. */
const CONTENT_READ_QUERY = { fields: 'credits' };

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

/** What `run` hands `resume`: the opened window, whether legacy committed the write inside it, and the row's value before it. */
const stateSchema = z.object({
  windowId: z.string().min(1),
  completed: z.boolean(),
  written: z.boolean(),
  siteId: z.string(),
  contentId: z.string(),
  contentHistId: z.string().min(1),
  oldCredits: z.string().nullable(),
  newCredits: z.string(),
  units: z.array(z.string()),
});

type WindowState = z.output<typeof stateSchema>;

interface ContentRow {
  ContentHistID: string;
  ContentID: string;
  Credits: string | null;
}

/** An owner read of one content node: its status and `data.credits`, or `waited` when it outlasted the timeout. */
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

/** Owner of the first target-authoritative `tcontent` unit among `units`, which serves the content read; undefined when none. */
function contentOwner(ctx: MigrationContext, authority: CurrentAuthority, units: readonly string[]): string | undefined {
  return ctx.catalog.unitsForLegacyTable(LEGACY_TABLE).find((target) => units.includes(target.unit) && authority.isTargetAuthoritative(target.unit))?.owner;
}

/** Skip reason of a read check whose window holds no target-authoritative `tcontent` unit. */
function noContentUnitReason(authority: CurrentAuthority): string {
  return `no target-authoritative unit of the window holds ${LEGACY_TABLE} under ${versionOf(authority)}`;
}

/** Scope of both windows: the row's site and content. */
function windowScope(siteId: string, contentId: string): WindowScope {
  return { keys: { siteid: siteId, contentid: contentId } };
}

/** Sets `Credits` of content version `contentHistId` in the live legacy database; returns the rows changed. */
async function writeCredits(pool: ConnectionPool, contentHistId: string, credits: string | null): Promise<number> {
  const update = await pool.request().input('credits', sql.NVarChar(255), credits).input('contentHistId', sql.Char(35), contentHistId).query(UPDATE_SQL);
  return update.rowsAffected[0] ?? 0;
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

/** Whether the service client gave up on a call that outlasted its timeout, as opposed to a refused or dropped connection. */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof ServiceUnavailableError)) return false;
  const { name } = (error.cause ?? {}) as { name?: unknown };
  return name === 'TimeoutError' || name === 'HeadersTimeoutError' || name === 'BodyTimeoutError';
}

/**
 * Anonymous JSON API read of content `contentId` at its owner, bounded by `timeoutMs`; the owner gates it whatever the gateway routes.
 * @throws the service client's error for anything but a timeout, such as a refused connection
 */
async function readContent(ctx: Pick<MigrationContext, 'clientAs'>, owner: string, siteId: string, contentId: string, timeoutMs: number): Promise<ContentRead> {
  let response: ServiceResponse;
  try {
    response = await ctx.clientAs('operator').request({
      service: owner,
      method: 'GET',
      path: `/_api/json/v1/${encodeURIComponent(siteId)}/content/${encodeURIComponent(contentId)}`,
      query: CONTENT_READ_QUERY,
      userToken: null,
      timeoutMs,
    });
  } catch (error) {
    if (isTimeout(error)) return { kind: 'waited' };
    throw error;
  }
  const { status, body } = response;
  if (status !== HTTP_OK) return { kind: 'status', status };
  const credits = (body as { data?: { credits?: unknown } } | null | undefined)?.data?.credits;
  return typeof credits === 'string' || credits === null ? { kind: 'status', status, credits } : { kind: 'status', status };
}

/**
 * Verdict on a read while the import is pending: only a wait or a 503 passes. A 200 fails, as superseded when it serves the
 * old value or its null/empty serialisation.
 */
function readVerdict(read: ContentRead, newCredits: string, oldCredits: string | null, timeoutMs: number): FaultAssertion {
  if (read.kind === 'waited') return pass(READ_NOT_SUPERSEDED, { read: 'waited', timeoutMs });
  if (read.status === HTTP_UNAVAILABLE) return pass(READ_NOT_SUPERSEDED, { status: read.status });
  const detail = { status: read.status, credits: read.credits ?? null, oldCredits, newCredits };
  if (read.status !== HTTP_OK) return fail(READ_NOT_SUPERSEDED, detail, `the content owner answered HTTP ${String(read.status)}`);
  if (read.credits === newCredits) return fail(READ_NOT_SUPERSEDED, detail, 'the content owner answered the read instead of waiting or answering 503');
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
    opened = await openWindowViaService(ctx, { routeKey: ROUTE_KEY, units, scope: windowScope(siteId, contentId) });
  } catch (error) {
    return { assertions: [fail(IMPORT_PENDING, { ...base, error: messageOf(error) }, 'the migration service refused the write window')], details: base };
  }

  const { windowId } = opened;
  const newCredits = `opt2-fault-${windowId}`;
  const state: WindowState = { windowId, completed: false, written: false, siteId, contentId, contentHistId, oldCredits, newCredits, units };
  const details: Record<string, unknown> = { ...base, windowId, newCredits };
  const done = (assertions: FaultAssertion[]): FaultRunOutput => ({ assertions, details, state });

  // From here every failure is an assertion, so `resume` always receives the window to complete.
  let authority: CurrentAuthority;
  try {
    // The window leases its units, so no transition can change their authority until it closes.
    authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
    await env.remote.set(FAULT, { windowId });
    const rowsAffected = await writeCredits(pool, contentHistId, newCredits);
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
  const owner = contentOwner(ctx, authority, targetUnits);
  if (owner === undefined) return done([...assertions, skipped(READ_NOT_SUPERSEDED, noContentUnitReason(authority))]);
  details.readOwner = owner;
  try {
    assertions.push(readVerdict(await readContent(ctx, owner, siteId, contentId, readTimeoutMs), newCredits, oldCredits, readTimeoutMs));
  } catch (error) {
    assertions.push(fail(READ_NOT_SUPERSEDED, { siteId, contentId, owner, error: messageOf(error) }, `the content read at ${owner} failed`));
  }
  return done(assertions);
}

/** Polls the window every second until it is closed, aborted or `timeoutMs` has elapsed; the verdict is assertion `name`. */
async function awaitClosed(env: FaultEnv, windowId: string, timeoutMs: number, name = RETRY_CLOSED): Promise<FaultAssertion> {
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
    if (window?.state === 'closed') return pass(name, { elapsedMs, window });
    if (window?.state === 'aborted' || elapsedMs >= timeoutMs) {
      return fail(name, { elapsedMs, window: window ?? null, ...(error === undefined ? {} : { error }) }, `window ${windowId} did not close within ${String(timeoutMs)} ms`);
    }
    await env.sleep(POLL_MS);
  }
}

/**
 * Forward-feeds the legacy-authoritative units and re-reads the content at the owner of its target-authoritative unit, after
 * a window closed, expecting `credits`; a null column matches its empty serialisation.
 */
async function propagation(env: FaultEnv, state: WindowState, credits: string | null, timeoutMs: number): Promise<{ steps: string[]; assertions: FaultAssertion[] }> {
  const { ctx } = env;
  let authority: CurrentAuthority;
  try {
    authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
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
  if (!state.units.some((unit) => authority.isTargetAuthoritative(unit))) return { steps, assertions };
  const owner = contentOwner(ctx, authority, state.units);
  if (owner === undefined) {
    assertions.push(skipped(TARGET_READ_CURRENT, noContentUnitReason(authority)));
    return { steps, assertions };
  }
  try {
    const read = await readContent(ctx, owner, state.siteId, state.contentId, timeoutMs);
    const detail = read.kind === 'waited' ? { owner, read: 'waited', timeoutMs } : { owner, status: read.status, credits: read.credits ?? null, expected: credits };
    assertions.push(
      read.kind === 'status' && read.status === HTTP_OK && read.credits !== undefined && (read.credits ?? '') === (credits ?? '')
        ? pass(TARGET_READ_CURRENT, detail)
        : fail(TARGET_READ_CURRENT, detail, 'the target does not serve the value legacy committed inside the window'),
    );
  } catch (error) {
    assertions.push(fail(TARGET_READ_CURRENT, { owner, error: messageOf(error) }, `the content read at ${owner} failed`));
  }
  steps.push('reread-target');
  return { steps, assertions };
}

/**
 * Writes the row's old `Credits` back inside a second window over the same units and scope, with no fault armed, and checks it
 * propagated as the first write did, so the reconciliation that follows compares the state from before the fault.
 */
async function restoreRow(env: FaultEnv, state: WindowState, params: WindowImportParams): Promise<{ steps: string[]; assertion: FaultAssertion }> {
  const { ctx } = env;
  const steps = ['restore-row'];
  const detail: Record<string, unknown> = { contentHistId: state.contentHistId, credits: state.oldCredits };
  const failed = (reason: string): { steps: string[]; assertion: FaultAssertion } => ({ steps, assertion: fail(ROW_RESTORED, detail, reason) });

  let windowId: string;
  try {
    ({ windowId } = await openWindowViaService(ctx, { routeKey: ROUTE_KEY, units: state.units, scope: windowScope(state.siteId, state.contentId) }));
  } catch (error) {
    detail.error = messageOf(error);
    return failed('the migration service refused the restoring write window');
  }
  detail.windowId = windowId;
  let rowsAffected = 0;
  try {
    rowsAffected = await writeCredits(await ctx.legacy.live(), state.contentHistId, state.oldCredits);
  } catch (error) {
    detail.updateError = messageOf(error);
  }
  detail.rowsAffected = rowsAffected;
  // Completed and awaited whatever the UPDATE did, so the window reopens its gates and releases its leases.
  try {
    detail.completion = await completeWindowViaService(ctx, windowId, { forwarded: rowsAffected > 0 });
  } catch (error) {
    detail.completeError = messageOf(error);
  }
  const closed = await awaitClosed(env, windowId, params.closeTimeoutMs, ROW_RESTORED);
  detail.closed = closed.detail;
  if (detail.updateError !== undefined) return failed('the restoring legacy UPDATE failed');
  if (rowsAffected !== 1) return failed('the restoring legacy UPDATE did not change exactly one row');
  if (closed.status !== 'pass') return failed(closed.reason ?? `window ${windowId} did not close`);

  const propagated = await propagation(env, state, state.oldCredits, params.readTimeoutMs);
  steps.push(...propagated.steps);
  detail.checks = propagated.assertions;
  const failedCheck = propagated.assertions.find((check) => check.status === 'fail');
  if (failedCheck !== undefined) return failed(`the restored value did not propagate: ${failedCheck.reason ?? failedCheck.name}`);
  const skippedCheck = propagated.assertions.find((check) => check.status === 'skipped');
  if (skippedCheck !== undefined) return { steps, assertion: skipped(ROW_RESTORED, `the restored value's propagation was not checked: ${skippedCheck.reason ?? skippedCheck.name}`) };
  return { steps, assertion: pass(ROW_RESTORED, detail) };
}

/** Disarms the fault, completes a window `run` left open, awaits the service's retry closing it, checks the write propagated, then restores the row. */
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
    const propagated = await propagation(env, state, state.newCredits, params.readTimeoutMs);
    steps.push(...propagated.steps);
    assertions.push(...propagated.assertions);
    const restored = await restoreRow(env, state, params);
    steps.push(...restored.steps);
    assertions.push(restored.assertion);
  }
  return result();
}

/** Interrupts a write window's import after legacy committed its write, checks the pending window and its reads, lets the service's retry close it, then restores the row. */
export const windowImportInterrupted: FaultScript<WindowImportParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,
  run,
  resume,
};
