// Latency, cold start, min_instance_count, scale-to-zero and write-window report (`npm run performance`).
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from '@opt2/platform/service-kit';

import { FIXTURES_UNAVAILABLE, readFixtureStatus } from '../golden/catalogue.js';
import {
  adminLogin,
  loadSecretStore,
  originBaseUrl,
  SEED_CONFIG_PATH,
  type LoginCredentials,
  type SecretStore,
} from '../golden/session.js';
import { isMainModule, parseFlags, runCli, type CliOutcome } from '../lib/cli.js';
import { createHttpSession, type FetchLike, type HttpSession } from '../lib/http.js';
import { reportsDir, type EnvLike } from '../lib/paths.js';
import { readJson, writeJsonReport, writeMarkdown } from '../lib/report.js';
import { PACKAGE_NAMES, portFor, type PackageName } from '../repro/ports.js';
import {
  readUpState,
  writeUpState,
  type UpProcessEntry,
  type UpState,
  type UpStateOptions,
  type UpStatePatch,
} from '../repro/up-state.js';

/** Recorded as `generatedBy` in `performance.json`. */
export const GENERATED_BY = 'harness/src/performance/run.ts';

/** Measured requests per read set and side. */
export const REQUESTS_PER_SET = 200;

/** Target p95 over legacy p95 above which a latency finding is raised; never a failure. */
export const RATIO_FINDING_THRESHOLD = 1.5;

/** Write-window duration above which a window is flagged; never a failure. */
export const WINDOW_THRESHOLD_MS = 5000;

/** Home node id, which legacy findOne accepts for every site (jsonApiUtility.cfc:1265). */
export const HOME_CONTENT_ID = '00000000000000000000000000000000001';

/** `cloudMeasurement` of the report: Terraform never applies, so nothing runs in the cloud. */
export const CLOUD_MEASUREMENT = 'not possible without apply';

/** Detection limit of every health, probe and stop wait. */
export const POLL_LIMIT_MS = 60_000;

/** Interval of the health and gateway probe polls. */
export const PROBE_INTERVAL_MS = 50;

/** Interval of the liveness poll after SIGTERM. */
export const STOP_POLL_MS = 100;

/** Time after SIGTERM at which a still-running process gets SIGKILL. */
export const STOP_KILL_AFTER_MS = 15_000;

/** Site every read set and probe addresses. */
export const SEED_SITE = 'tenant-a';

/** Seeded role whose user reads the timesheet sheet list. */
export const TIMESHEETS_ROLE = 'timesheets.primary-approver';

const NOT_RESTARTED = new Set<PackageName>(['gateway', 'web', 'migration', 'stub']);

/** A target service whose local process is stopped and restarted. */
export type RestartService = Exclude<PackageName, 'gateway' | 'web' | 'migration' | 'stub'>;

function isRestartService(name: string): name is RestartService {
  return (PACKAGE_NAMES as readonly string[]).includes(name) && !NOT_RESTARTED.has(name as PackageName);
}

/** The ten domain services, in `PACKAGE_NAMES` order. */
export const RESTART_SERVICES: readonly RestartService[] = Object.freeze(PACKAGE_NAMES.filter(isRestartService));

/** Planned Cloud Run `min_instance_count` per deployed service: migration alone stays warm. */
export const EXPECTED_MIN_INSTANCES: Readonly<Record<string, number>> = Object.freeze({
  gateway: 0,
  web: 0,
  ...Object.fromEntries(RESTART_SERVICES.map((name) => [name, 0])),
  migration: 1,
});

/** One fixed latency read; `path` may hold `{ids}`, `{feedId}` and `{asOf}`, filled before measurement. */
export interface ReadSetEntry {
  set: string;
  session: 'anonymous' | 'admin' | 'timesheets';
  path: string;
  needs?: 'ids' | 'feedId';
  fixtures?: true;
}

const FIXTURE_API = '/legacy-fixtures/cfml/api.cfm';
const CONTENT_API = `/_api/json/v1/${SEED_SITE}`;
const CUSERS_LISTUSERS_PATH = `/admin/?muraAction=cUsers.listUsers&siteid=${SEED_SITE}&ispublic=0`;
const CSETTINGS_LIST_PATH = '/admin/?muraAction=cSettings.list';
const CONTENT_FIND_ONE_PATH = `${CONTENT_API}/content/${HOME_CONTENT_ID}`;
const TIMESHEET_SHEETS_PATH = `${FIXTURE_API}/timesheets/sheets?siteid=${SEED_SITE}&asOf={asOf}`;
const PRIME_CONTENT_PATH = `${CONTENT_API}/content/?type=Page`;
// A query, because legacy findAll answers invalidParameters for the feed entity (jsonApiUtility.cfc:2598-2599).
const PRIME_FEED_PATH = `${CONTENT_API}/feed/?method=findQuery&entityname=feed`;
const PRIMED_ID_COUNT = 5;

/** The fixed read set; the GS-CO-05 reads use the catalogue's literal requests with the home id for its seed page. */
export const READ_SET: readonly ReadSetEntry[] = Object.freeze([
  { set: 'gs-co-05.content.findOne', session: 'anonymous', path: CONTENT_FIND_ONE_PATH },
  { set: 'gs-co-05.content.findMany', session: 'anonymous', path: `${CONTENT_API}/content/{ids}`, needs: 'ids' },
  {
    set: 'gs-co-05.content.findQuery',
    session: 'anonymous',
    path: `${CONTENT_API}/content/?method=findQuery&entityname=content&type=Page`,
  },
  { set: 'gs-co-05.contentnav', session: 'anonymous', path: `${CONTENT_API}/contentnav/${HOME_CONTENT_ID}` },
  { set: 'gs-co-05.feed', session: 'anonymous', path: `/_api/feed/v1/${SEED_SITE}/?feedID={feedId}`, needs: 'feedId' },
  { set: 'cusers.listusers', session: 'admin', path: CUSERS_LISTUSERS_PATH },
  { set: 'csettings.list', session: 'admin', path: CSETTINGS_LIST_PATH },
  { set: 'timesheets.sheets', session: 'timesheets', path: TIMESHEET_SHEETS_PATH, fixtures: true },
]);

/**
 * The read through the gateway that stands for one service: a fresh admin login, or a GET of `path` (which may
 * hold `{asOf}`) in the `admin`, `anonymous` or seeded `tenant-a` role session.
 */
export type ProbeSpec = { login: true } | { session: string; path: string; fixtures?: true };

/** Gateway probe per restarted service; `fixtures` probes need the synthetic legacy oracle. */
export const GATEWAY_PROBES: Readonly<Record<RestartService, ProbeSpec>> = Object.freeze({
  identity: { login: true },
  people: { session: 'admin', path: CUSERS_LISTUSERS_PATH },
  'programs-sites': { session: 'admin', path: CSETTINGS_LIST_PATH },
  'strategies-content': { session: 'anonymous', path: CONTENT_FIND_ONE_PATH },
  communications: {
    session: 'communications.sender',
    path: `${FIXTURE_API}/communications/templates?siteid=${SEED_SITE}`,
    fixtures: true,
  },
  reporting: { session: 'reporting.exporter', path: `${FIXTURE_API}/reporting/exports?siteid=${SEED_SITE}`, fixtures: true },
  surveys: { session: 'surveys.manager', path: `${FIXTURE_API}/surveys/surveys?siteid=${SEED_SITE}`, fixtures: true },
  timesheets: { session: TIMESHEETS_ROLE, path: TIMESHEET_SHEETS_PATH, fixtures: true },
  finance: { session: 'finance.preparer', path: `${FIXTURE_API}/finance/records?siteid=${SEED_SITE}`, fixtures: true },
  'e-signature': {
    session: 'esignature.signer',
    path: `${FIXTURE_API}/esignature/requests?siteid=${SEED_SITE}`,
    fixtures: true,
  },
});

/** One report finding; findings are flags, never failures. */
export interface Finding {
  kind: string;
  subject: string;
  detail: string;
}

/** Nearest-rank p50 and p95 of one side, in ms rounded to 0.1. */
export interface LatencySummary {
  p50Ms: number;
  p95Ms: number;
}

/** One latency row; a skipped set has null sides and its reason as `finding`. */
export type LatencyRow = {
  set: string;
  requests: number;
  target: LatencySummary | null;
  legacy: LatencySummary | null;
  ratioP95: number | null;
  finding: string | null;
};

/** Local process start to first `/healthz` 200. */
export type ColdStartRow = { service: string; startToFirst200Ms: number | null; label: 'measured' };

/** Stopped state, through cold start, to the first successful request through the gateway. */
export type ScaleToZeroRow = { service: string; stopToFirstSuccessMs: number | null; label: 'derived' };

/** A write window longer than {@link WINDOW_THRESHOLD_MS}. */
export type WindowOverThreshold = { windowId: string; routeKey: string; durationMs: number };

/** Where the planned min instance counts came from. */
export type MinInstanceSource = 'minInstanceCounts' | 'plan.planned_values' | 'unavailable';

/** Planned min instance counts and their source. */
export type MinInstanceCounts = { source: MinInstanceSource; values: Record<string, number> };

/** The body of `performance.json` before `writeJsonReport` stamps it. */
export type PerformanceReport = {
  latency: LatencyRow[];
  coldStart: ColdStartRow[];
  minInstanceCount: MinInstanceCounts & { label: 'measured' };
  scaleToZero: ScaleToZeroRow[];
  windowsOverThreshold: WindowOverThreshold[];
  findings: Finding[];
  cloudMeasurement: typeof CLOUD_MEASUREMENT;
};

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Nearest-rank percentile (`q` from 0 to 100) of `samples`, which stays unsorted; throws on an empty array. */
export function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) throw new RangeError('percentile of an empty sample set');
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

/** p50 and p95 of `samples`, each rounded to 0.1 ms; throws on an empty array. */
export function summariseSamples(samples: readonly number[]): LatencySummary {
  return { p50Ms: round(percentile(samples, 50), 1), p95Ms: round(percentile(samples, 95), 1) };
}

/** Target p95 over legacy p95 (2 decimals, null when legacy p95 is 0) and the finding text when the unrounded ratio is above the threshold. */
export function ratioFinding(
  target: LatencySummary,
  legacy: LatencySummary,
): { ratioP95: number | null; finding: string | null } {
  const ratioP95 = legacy.p95Ms === 0 ? null : round(target.p95Ms / legacy.p95Ms, 2);
  // Whole 0.1 ms units keep the comparison exact, so 2.1 over 1.4 is not above 1.5.
  const finding =
    ratioP95 !== null && Math.round(target.p95Ms * 10) > RATIO_FINDING_THRESHOLD * Math.round(legacy.p95Ms * 10)
      ? `target p95 ${target.p95Ms} ms is ${ratioP95}x legacy p95 ${legacy.p95Ms} ms (above ${RATIO_FINDING_THRESHOLD}x)`
      : null;
  return { ratioP95, finding };
}

/** Values the read-set placeholders take; `ids` and `feedId` come from the priming lookups. */
export interface ReadSetValues {
  asOf: string;
  ids: readonly string[];
  feedId: string | undefined;
}

/** `entry.path` with its placeholders filled, or the reason the set cannot be measured. */
export function resolveReadPath(
  entry: ReadSetEntry,
  values: ReadSetValues,
  fixturesAvailable: boolean,
): { path: string } | { skipped: string } {
  if (entry.fixtures === true && !fixturesAvailable) return { skipped: FIXTURES_UNAVAILABLE };
  if (entry.needs === 'ids' && values.ids.length === 0) {
    return { skipped: `no content ids from GET ${PRIME_CONTENT_PATH} on legacy` };
  }
  if (entry.needs === 'feedId' && values.feedId === undefined) {
    return { skipped: `no feed id from GET ${PRIME_FEED_PATH} on legacy` };
  }
  return {
    path: entry.path
      .replace('{ids}', values.ids.map(encodeURIComponent).join(','))
      .replace('{feedId}', encodeURIComponent(values.feedId ?? ''))
      .replace('{asOf}', encodeURIComponent(values.asOf)),
  };
}

const itemsEnvelope = z
  .object({ data: z.object({ items: z.array(z.record(z.string(), z.unknown())) }).loose() })
  .loose();

/** Value of `key` in `record`, matched case-insensitively, when it is a non-empty string. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const match = Object.keys(record).find((candidate) => candidate.toLowerCase() === key);
  const value = match === undefined ? undefined : record[match];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function listItems(s: HttpSession, apiPath: string): Promise<Record<string, unknown>[]> {
  const result = await s.get(apiPath);
  if (result.status !== 200) return [];
  let body: unknown;
  try {
    body = JSON.parse(result.text);
  } catch {
    return [];
  }
  const parsed = itemsEnvelope.safeParse(body);
  return parsed.success ? parsed.data.data.items : [];
}

/**
 * Untimed legacy lookups for the findMany ids and the feed id. `s` is the admin session: the JSON API `feed`
 * entity is not public (jsonApiUtility.cfc:94), so an anonymous lookup answers 401.
 */
export async function primeLookups(s: HttpSession): Promise<Pick<ReadSetValues, 'ids' | 'feedId'>> {
  const pages = await listItems(s, PRIME_CONTENT_PATH);
  const ids = pages
    .map((item) => stringField(item, 'contentid') ?? stringField(item, 'id'))
    .filter((id): id is string => id !== undefined)
    .slice(0, PRIMED_ID_COUNT);
  const [feed] = await listItems(s, PRIME_FEED_PATH);
  return { ids, feedId: feed === undefined ? undefined : stringField(feed, 'feedid') };
}

/** Sessions of one read set on each side. */
export interface SidePair {
  legacy: HttpSession;
  target: HttpSession;
}

/** A measured latency row and the findings it raised. */
export interface LatencyMeasurement {
  row: LatencyRow;
  findings: Finding[];
}

/**
 * Measures `entry.path` (already resolved) `requests` times on each side, sequentially and interleaved (legacy,
 * then target, per iteration). A sample runs from before the request until its body has been read.
 */
export async function measureLatencySet(
  entry: Pick<ReadSetEntry, 'set' | 'path'>,
  sessions: SidePair,
  opts: { requests: number; now: () => number },
): Promise<LatencyMeasurement> {
  const sides = ['legacy', 'target'] as const;
  const samples = { legacy: [] as number[], target: [] as number[] };
  const notOk = { legacy: [] as number[], target: [] as number[] };
  for (let i = 0; i < opts.requests; i += 1) {
    for (const side of sides) {
      const started = opts.now();
      const result = await sessions[side].get(entry.path);
      samples[side].push(opts.now() - started);
      if (result.status !== 200) notOk[side].push(result.status);
    }
  }
  const legacy = summariseSamples(samples.legacy);
  const target = summariseSamples(samples.target);
  const { ratioP95, finding } = ratioFinding(target, legacy);
  const findings: Finding[] = [];
  if (finding !== null) findings.push({ kind: 'latency-ratio', subject: entry.set, detail: finding });
  for (const side of sides) {
    if (notOk[side].length === 0) continue;
    const statuses = [...new Set(notOk[side])].sort((a, b) => a - b).join(', ');
    findings.push({
      kind: 'non-ok-response',
      subject: `${entry.set}/${side}`,
      detail: `${notOk[side].length} of ${opts.requests}: ${statuses}`,
    });
  }
  return { row: { set: entry.set, requests: opts.requests, target, legacy, ratioP95, finding }, findings };
}

/** Row of a set that is not measured (0 requests), its reason both the row's finding and a `set-skipped` finding. */
export function skippedLatency(set: string, reason: string): LatencyMeasurement {
  return {
    row: { set, requests: 0, target: null, legacy: null, ratioP95: null, finding: reason },
    findings: [{ kind: 'set-skipped', subject: set, detail: reason }],
  };
}

/** The part of a spawned child the restart uses; `pid` is undefined when the spawn failed. */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  unref(): void;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

/** `child_process.spawn` as the restart calls it. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

/** Signals `pid` (negative for a process group); signal 0 only probes that it exists. */
export type KillLike = (pid: number, signal: NodeJS.Signals | 0) => unknown;

/** Every side effect of a restart cycle, injectable for tests. */
export interface ProcessDeps {
  spawn: SpawnLike;
  kill: KillLike;
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  readUpState: () => UpState;
  writeUpState: (patch: UpStatePatch) => unknown;
}

function errnoOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

/** Sends `signal` to the process group of `pid`, else to `pid` alone; returns the target signalled, or null when gone. */
function signalGroupOrPid(kill: KillLike, pid: number, signal: NodeJS.Signals): number | null {
  try {
    kill(-pid, signal);
    return -pid;
  } catch (err) {
    const code = errnoOf(err);
    if (code !== 'ESRCH' && code !== 'EPERM') throw err;
  }
  try {
    kill(pid, signal);
    return pid;
  } catch (err) {
    if (errnoOf(err) === 'ESRCH') return null;
    throw err;
  }
}

function isAlive(kill: KillLike, target: number): boolean {
  try {
    kill(target, 0);
    return true;
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
}

/**
 * SIGTERMs the process group of `entry.pid` (the pid alone when that fails) and polls until it has exited,
 * sending SIGKILL after {@link STOP_KILL_AFTER_MS}; throws when it still runs after {@link POLL_LIMIT_MS}.
 */
export async function stopProcess(
  entry: Pick<UpProcessEntry, 'pid'>,
  deps: Pick<ProcessDeps, 'kill' | 'now' | 'sleep'>,
): Promise<void> {
  const target = signalGroupOrPid(deps.kill, entry.pid, 'SIGTERM');
  if (target === null) return;
  const started = deps.now();
  let killed = false;
  while (isAlive(deps.kill, target)) {
    const elapsed = deps.now() - started;
    if (elapsed >= POLL_LIMIT_MS) throw new Error(`pid ${entry.pid} still running ${POLL_LIMIT_MS} ms after SIGTERM`);
    if (!killed && elapsed >= STOP_KILL_AFTER_MS) {
      try {
        deps.kill(target, 'SIGKILL');
      } catch (err) {
        if (errnoOf(err) !== 'ESRCH') throw err;
      }
      killed = true;
    }
    await deps.sleep(STOP_POLL_MS);
  }
}

/**
 * Spawns `entry.command` detached (an argv as is, a string through `/bin/sh -c`) in `entry.cwd`, output appended
 * to `entry.log` (relative to `cwd`) when set; records the new pid in up.json at once and returns it.
 */
export async function startProcess(
  name: string,
  entry: UpProcessEntry,
  deps: Pick<ProcessDeps, 'spawn' | 'writeUpState'>,
): Promise<number> {
  const [command, args] =
    typeof entry.command === 'string'
      ? ['/bin/sh', ['-c', entry.command]]
      : [entry.command[0], entry.command.slice(1)];
  const logFd = entry.log === undefined ? undefined : openSync(path.resolve(entry.cwd, entry.log), 'a', 0o600);
  let child: SpawnedProcess;
  try {
    child = deps.spawn(command, args, {
      cwd: entry.cwd,
      env: { ...process.env, ...entry.env },
      detached: true,
      stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    });
  } finally {
    // The child holds its own copy of the descriptor.
    if (logFd !== undefined) closeSync(logFd);
  }
  // Listening keeps an asynchronous spawn error from becoming an uncaught 'error' event.
  const failed = new Promise<Error>((resolve) => child.once('error', resolve));
  const { pid } = child;
  if (pid === undefined) throw new Error(`${name}: cannot start ${command}`, { cause: await failed });
  child.unref();
  deps.writeUpState({ processes: { [name]: { ...entry, pid } } });
  return pid;
}

/** One gateway request standing for a service; resolves true when it succeeded (HTTP 200, or a completed login). */
export interface GatewayProbe {
  describe: string;
  attempt(timeoutMs: number): Promise<boolean>;
}

/** The probe of a service, or why its scale-to-zero measurement is skipped. */
export type ProbePlan = GatewayProbe | { skipped: string };

/** Rows, findings and health of one restart cycle. */
export interface RestartOutcome {
  coldStart: ColdStartRow;
  scaleToZero: ScaleToZeroRow;
  findings: Finding[];
  unhealthy: boolean;
}

async function attemptSafely(check: (timeoutMs: number) => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  try {
    return await check(timeoutMs);
  } catch {
    // Refused or failed exchanges are expected while the service is stopped or starting.
    return false;
  }
}

/** `now()` at the first passing `check`, polled every {@link PROBE_INTERVAL_MS} for up to {@link POLL_LIMIT_MS}; null on expiry. */
async function pollUntil(
  check: (timeoutMs: number) => Promise<boolean>,
  deps: Pick<ProcessDeps, 'now' | 'sleep'>,
): Promise<number | null> {
  const started = deps.now();
  for (;;) {
    const remaining = POLL_LIMIT_MS - (deps.now() - started);
    if (remaining <= 0) return null;
    if (await attemptSafely(check, Math.ceil(remaining))) return deps.now();
    await deps.sleep(Math.min(PROBE_INTERVAL_MS, remaining));
  }
}

function healthCheck(fetchFn: FetchLike, url: string): (timeoutMs: number) => Promise<boolean> {
  return async (timeoutMs) => {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.status === 200;
  };
}

/**
 * One restart cycle of `name`: stop, confirm through `probe` that the gateway no longer serves it, start, time the
 * first `/healthz` 200 (cold start) and the first successful gateway probe (scale to zero and back). Throws for a
 * name outside {@link RESTART_SERVICES}.
 */
export async function restartAndMeasure(name: string, deps: ProcessDeps, probe: ProbePlan): Promise<RestartOutcome> {
  if (!isRestartService(name)) throw new Error(`${name} is not a restartable target service`);
  const findings: Finding[] = [];
  const outcome = (cold: number | null, scale: number | null, unhealthy = false): RestartOutcome => ({
    coldStart: { service: name, startToFirst200Ms: cold === null ? null : round(cold, 1), label: 'measured' },
    scaleToZero: { service: name, stopToFirstSuccessMs: scale === null ? null : round(scale, 1), label: 'derived' },
    findings,
    unhealthy,
  });
  const { processes } = deps.readUpState();
  const entry = Object.hasOwn(processes, name) ? processes[name] : undefined;
  if (entry === undefined) {
    findings.push({ kind: 'process-entry-missing', subject: name, detail: `no ${name} entry in up.json` });
    return outcome(null, null);
  }

  try {
    await stopProcess(entry, deps);
  } catch (err) {
    findings.push({ kind: 'stop-failed', subject: name, detail: (err as Error).message });
    return outcome(null, null);
  }
  const servedWhileStopped = 'skipped' in probe ? false : await attemptSafely(probe.attempt, POLL_LIMIT_MS);

  const t0 = deps.now();
  try {
    await startProcess(name, entry, deps);
  } catch (err) {
    findings.push({ kind: 'start-failed', subject: name, detail: (err as Error).message });
    return outcome(null, null, true);
  }
  const healthUrl = `http://127.0.0.1:${entry.port ?? portFor(name)}/healthz`;
  const healthyAt = await pollUntil(healthCheck(deps.fetch, healthUrl), deps);
  if (healthyAt === null) {
    const detail = `${healthUrl} did not answer 200 within ${POLL_LIMIT_MS} ms`;
    findings.push({ kind: 'cold-start-timeout', subject: name, detail });
    return outcome(null, null, true);
  }

  if ('skipped' in probe) {
    findings.push({ kind: 'scale-probe-skipped', subject: name, detail: probe.skipped });
    return outcome(healthyAt - t0, null);
  }
  if (servedWhileStopped) {
    const detail = `${probe.describe} answered 200 through the gateway while ${name} was stopped`;
    findings.push({ kind: 'probe-not-routed', subject: name, detail });
    return outcome(healthyAt - t0, null);
  }
  const servedAt = await pollUntil(probe.attempt, deps);
  if (servedAt === null) {
    const detail = `${probe.describe} did not answer 200 through the gateway within ${POLL_LIMIT_MS} ms`;
    findings.push({ kind: 'scale-probe-timeout', subject: name, detail });
    return outcome(healthyAt - t0, null, true);
  }
  return outcome(healthyAt - t0, servedAt - t0);
}

const CLOUD_RUN_SERVICE_TYPE = 'google_cloud_run_v2_service';

// Shape mismatches inside a resource read as absent, so a resource of another type never fails the file.
const scalingSchema = z
  .array(z.object({ min_instance_count: z.number().nullable().optional() }).loose())
  .nullable()
  .optional()
  .catch(undefined);

const planResourceSchema = z
  .object({
    address: z.string().optional(),
    type: z.string(),
    values: z
      .object({
        name: z.string().optional().catch(undefined),
        template: z.array(z.object({ scaling: scalingSchema }).loose()).nullable().optional().catch(undefined),
        scaling: scalingSchema,
      })
      .loose()
      .nullable()
      .optional()
      .catch(undefined),
  })
  .loose();

type PlanResource = z.infer<typeof planResourceSchema>;

interface PlanModule {
  resources?: PlanResource[] | undefined;
  child_modules?: PlanModule[] | undefined;
}

const planModuleSchema: z.ZodType<PlanModule> = z.lazy(() =>
  z.object({ resources: z.array(planResourceSchema).optional(), child_modules: z.array(planModuleSchema).optional() }).loose(),
);

/** `opt2/reports/terraform-plan.json`: the `minInstanceCounts` summary, or `plan` as `terraform show -json` writes it. */
export const terraformPlanReportSchema = z
  .object({
    minInstanceCounts: z.record(z.string(), z.number()).nullable().optional(),
    plan: z
      .object({ planned_values: z.object({ root_module: planModuleSchema.optional() }).loose().optional() })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

/** A parsed `terraform-plan.json`. */
export type TerraformPlanReport = z.infer<typeof terraformPlanReportSchema>;

const MODULE_INSTANCE_KEY = /^module\.[^.[]+\["([^"]+)"\]/;

function cloudRunServiceName(resource: PlanResource): string | undefined {
  const key = resource.address === undefined ? undefined : MODULE_INSTANCE_KEY.exec(resource.address)?.[1];
  return key ?? resource.values?.name?.replace(/^opt2-/, '');
}

function collectCloudRun(module: PlanModule, into: Record<string, number>): void {
  for (const resource of module.resources ?? []) {
    if (resource.type !== CLOUD_RUN_SERVICE_TYPE) continue;
    const name = cloudRunServiceName(resource);
    if (name === undefined) continue;
    const values = resource.values;
    into[name] =
      values?.template?.[0]?.scaling?.[0]?.min_instance_count ?? values?.scaling?.[0]?.min_instance_count ?? 0;
  }
  for (const child of module.child_modules ?? []) collectCloudRun(child, into);
}

/** Planned Cloud Run min instance counts: the summary map when non-empty, else every Cloud Run service in the plan. */
export function parseMinInstanceCounts(planReport: TerraformPlanReport | undefined): MinInstanceCounts {
  const summary = planReport?.minInstanceCounts;
  if (summary !== undefined && summary !== null && Object.keys(summary).length > 0) {
    return { source: 'minInstanceCounts', values: { ...summary } };
  }
  const plannedValues = planReport?.plan?.planned_values;
  if (plannedValues === undefined) return { source: 'unavailable', values: {} };
  const values: Record<string, number> = {};
  if (plannedValues.root_module !== undefined) collectCloudRun(plannedValues.root_module, values);
  return { source: 'plan.planned_values', values };
}

/** Findings for every planned count that differs from, is missing from, or is not in {@link EXPECTED_MIN_INSTANCES}. */
export function checkMinInstanceCounts(values: Readonly<Record<string, number>>): Finding[] {
  const findings: Finding[] = [];
  for (const [service, expected] of Object.entries(EXPECTED_MIN_INSTANCES)) {
    if (!Object.hasOwn(values, service)) {
      findings.push({ kind: 'min-instance-count-missing', subject: service, detail: `expected ${expected}, absent from the plan` });
    } else if (values[service] !== expected) {
      findings.push({ kind: 'min-instance-count', subject: service, detail: `expected ${expected}, planned ${values[service]}` });
    }
  }
  for (const [service, planned] of Object.entries(values)) {
    if (!Object.hasOwn(EXPECTED_MIN_INSTANCES, service) && planned !== 0) {
      findings.push({ kind: 'min-instance-count-unexpected', subject: service, detail: `not an expected service; planned ${planned}, expected 0` });
    }
  }
  return findings;
}

/** `opt2/reports/windows.json` as the migration service writes it; only the fields the flag reads are typed. */
export const windowsReportSchema = z
  .object({
    windows: z
      .array(
        z
          .object({
            windowId: z.string(),
            routeKey: z.string(),
            durationMs: z.number().optional(),
            phases: z.array(z.object({ phase: z.string(), at: z.string() }).loose()).optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

/** A parsed `windows.json`. */
export type WindowsReport = z.infer<typeof windowsReportSchema>;

/** Windows longer than {@link WINDOW_THRESHOLD_MS}, longest first; a missing `durationMs` spans the first to last phase. */
export function windowsOverThreshold(windowsReport: WindowsReport | undefined): WindowOverThreshold[] {
  const flagged: WindowOverThreshold[] = [];
  for (const window of windowsReport?.windows ?? []) {
    const phases = window.phases ?? [];
    const first = phases[0];
    const last = phases.at(-1);
    const durationMs =
      window.durationMs ?? (first === undefined || last === undefined ? 0 : Date.parse(last.at) - Date.parse(first.at));
    if (durationMs > WINDOW_THRESHOLD_MS) flagged.push({ windowId: window.windowId, routeKey: window.routeKey, durationMs });
  }
  return flagged.sort((a, b) => b.durationMs - a.durationMs);
}

/** Inputs of {@link buildPerformanceReport}; `findings` are those the measurements raised. */
export interface PerformanceParts {
  latency: LatencyRow[];
  coldStart: ColdStartRow[];
  scaleToZero: ScaleToZeroRow[];
  minInstanceCount: MinInstanceCounts;
  windowsOverThreshold: WindowOverThreshold[];
  findings: Finding[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFindings(a: Finding, b: Finding): number {
  return compareText(a.kind, b.kind) || compareText(a.subject, b.subject) || compareText(a.detail, b.detail);
}

/** The report body, adding the min-instance and window findings to `parts.findings`, sorted by kind then subject. */
export function buildPerformanceReport(parts: PerformanceParts): PerformanceReport {
  const windowFindings = parts.windowsOverThreshold.map(
    (window): Finding => ({
      kind: 'window-over-threshold',
      subject: window.windowId,
      detail: `${window.routeKey} ${window.durationMs} ms`,
    }),
  );
  return {
    latency: parts.latency,
    coldStart: parts.coldStart,
    minInstanceCount: { ...parts.minInstanceCount, label: 'measured' },
    scaleToZero: parts.scaleToZero,
    windowsOverThreshold: parts.windowsOverThreshold,
    findings: [...parts.findings, ...checkMinInstanceCounts(parts.minInstanceCount.values), ...windowFindings].sort(
      compareFindings,
    ),
    cloudMeasurement: CLOUD_MEASUREMENT,
  };
}

function cell(value: string | number | null): string {
  return value === null ? 'n/a' : String(value).replaceAll('|', '\\|');
}

function table(headers: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
}

/** Markdown body of `performance.md`; `writeMarkdown` adds the title and the `Source SHA:` line. */
export function renderPerformanceMarkdown(report: PerformanceReport): string[] {
  const { values } = report.minInstanceCount;
  const extraServices = Object.keys(values)
    .filter((service) => !Object.hasOwn(EXPECTED_MIN_INSTANCES, service))
    .sort(compareText);
  const minInstanceRows = [...Object.keys(EXPECTED_MIN_INSTANCES), ...extraServices].map((service) => [
    service,
    Object.hasOwn(values, service) ? (values[service] as number) : 'absent',
    EXPECTED_MIN_INSTANCES[service] ?? 0,
  ]);
  return [
    '## Method',
    '',
    `- ${REQUESTS_PER_SET} sequential requests per read set and side, interleaved: one legacy request, then one target request.`,
    '- p50 and p95 by nearest rank, in ms rounded to 0.1.',
    '- Target is the gateway with the active cut-over version; legacy is the ColdFusion origin, requested directly.',
    `- The request sets no latency threshold: a target p95 above ${RATIO_FINDING_THRESHOLD}x legacy and a write window over ${WINDOW_THRESHOLD_MS / 1000} s are flags, not failures.`,
    "- The legacy-direct admin and timesheet sessions log in on legacy itself, which updates that user's `tusers.LastLogin` on the legacy side.",
    `- Cold start is measured locally (process start to the first \`/healthz\` 200); scale to zero and back is derived (stopped service, restart, first successful request through the gateway). Each poll is bounded at ${POLL_LIMIT_MS} ms.`,
    `- Cloud measurement: ${report.cloudMeasurement}.`,
    '',
    '## Latency',
    '',
    ...table(
      ['Set', 'Requests', 'Target p50 (ms)', 'Target p95 (ms)', 'Legacy p50 (ms)', 'Legacy p95 (ms)', 'Ratio p95', 'Finding'],
      report.latency.map((row) => [
        row.set,
        row.requests,
        row.target?.p50Ms ?? null,
        row.target?.p95Ms ?? null,
        row.legacy?.p50Ms ?? null,
        row.legacy?.p95Ms ?? null,
        row.ratioP95,
        row.finding ?? '',
      ]),
    ),
    '',
    '## Cold start (measured)',
    '',
    ...table(
      ['Service', 'Start to first 200 (ms)'],
      report.coldStart.map((row) => [row.service, row.startToFirst200Ms]),
    ),
    '',
    '## min_instance_count (measured from the Terraform plan)',
    '',
    `Source: \`${report.minInstanceCount.source}\`.`,
    '',
    ...table(['Service', 'Planned', 'Expected'], minInstanceRows),
    '',
    '## Scale to zero and back (derived)',
    '',
    ...table(
      ['Service', 'Stop to first success through the gateway (ms)'],
      report.scaleToZero.map((row) => [row.service, row.stopToFirstSuccessMs]),
    ),
    '',
    `## Windows over ${WINDOW_THRESHOLD_MS / 1000} s`,
    '',
    ...(report.windowsOverThreshold.length === 0
      ? ['None.']
      : table(
          ['Window', 'Route key', 'Duration (ms)'],
          report.windowsOverThreshold.map((window) => [window.windowId, window.routeKey, window.durationMs]),
        )),
    '',
    '## Findings',
    '',
    ...(report.findings.length === 0
      ? ['None.']
      : table(
          ['Kind', 'Subject', 'Detail'],
          report.findings.map((finding) => [finding.kind, finding.subject, finding.detail]),
        )),
  ];
}

/** Side effects {@link main} lets tests replace; each defaults to the real process, clock, network and up.json. */
export interface MainDeps {
  env?: EnvLike;
  fetch?: FetchLike;
  spawn?: SpawnLike;
  kill?: KillLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readUpState?: (opts: UpStateOptions) => UpState;
  writeUpState?: (patch: UpStatePatch, opts: UpStateOptions) => unknown;
}

const USAGE = 'usage: tsx src/performance/run.ts';

const seedConfigSchema = z.object({ businessDate: z.iso.date() }).loose();

/** `file` parsed by `schema`, or undefined when it does not exist. */
async function readOptional<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return await readJson(file, schema);
  } catch (err) {
    if (errnoOf((err as Error).cause) === 'ENOENT') return undefined;
    throw err;
  }
}

function adminCredentials(env: EnvLike, secrets: SecretStore): LoginCredentials {
  const username = env.MURA_ADMIN_USERNAME === undefined || env.MURA_ADMIN_USERNAME === '' ? 'admin' : env.MURA_ADMIN_USERNAME;
  return { username, password: secrets.secret('admin') };
}

function roleCredentials(secrets: SecretStore, role: string): LoginCredentials {
  const username = secrets.username(SEED_SITE, role);
  return { username, password: secrets.secret(`seed:${username}`) };
}

async function loggedIn(baseUrl: string, fetchFn: FetchLike, credentials: LoginCredentials, label: string): Promise<HttpSession> {
  const s = createHttpSession({ baseUrl, fetch: fetchFn });
  const { ok, result } = await adminLogin(s, credentials);
  if (!ok) {
    const at = new URL(result.url).pathname;
    throw new Error(`${label}: admin login as ${credentials.username} was refused (status ${result.status} at ${at})`);
  }
  return s;
}

/** An anonymous and an admin session on `baseUrl`, plus one per seeded role, each logged in once. */
async function openSessions(
  label: string,
  baseUrl: string,
  fetchFn: FetchLike,
  admin: LoginCredentials,
  roles: readonly string[],
  secrets: SecretStore,
): Promise<Map<string, HttpSession>> {
  const sessions = new Map<string, HttpSession>([['anonymous', createHttpSession({ baseUrl, fetch: fetchFn })]]);
  sessions.set('admin', await loggedIn(baseUrl, fetchFn, admin, `${label} admin`));
  for (const role of roles) {
    sessions.set(role, await loggedIn(baseUrl, fetchFn, roleCredentials(secrets, role), `${label} ${role}`));
  }
  return sessions;
}

function sessionOf(sessions: ReadonlyMap<string, HttpSession>, key: string): HttpSession {
  const found = sessions.get(key);
  if (found === undefined) throw new Error(`no ${key} session was opened`);
  return found;
}

function readSetSessionKey(session: ReadSetEntry['session']): string {
  return session === 'timesheets' ? TIMESHEETS_ROLE : session;
}

interface ProbeContext {
  gatewayUrl: string;
  sessions: ReadonlyMap<string, HttpSession>;
  fetch: FetchLike;
  admin: LoginCredentials;
  fixturesAvailable: boolean;
  asOf: string;
}

function probePlan(service: RestartService, ctx: ProbeContext): ProbePlan {
  const spec = GATEWAY_PROBES[service];
  if ('login' in spec) {
    return {
      describe: 'admin login',
      attempt: async (timeoutMs) => {
        const fresh = createHttpSession({ baseUrl: ctx.gatewayUrl, fetch: ctx.fetch, timeoutMs });
        return (await adminLogin(fresh, ctx.admin)).ok;
      },
    };
  }
  if (spec.fixtures === true && !ctx.fixturesAvailable) return { skipped: FIXTURES_UNAVAILABLE };
  const s = sessionOf(ctx.sessions, spec.session);
  const probePath = spec.path.replace('{asOf}', encodeURIComponent(ctx.asOf));
  return {
    describe: `GET ${probePath} as ${spec.session}`,
    attempt: async (timeoutMs) => (await s.get(probePath, { timeoutMs })).status === 200,
  };
}

/** Seeded roles the gateway probes log in as. */
function probeRoles(): string[] {
  const roles = Object.values(GATEWAY_PROBES).flatMap((spec) => ('login' in spec ? [] : [spec.session]));
  return [...new Set(roles)].filter((role) => role !== 'admin' && role !== 'anonymous');
}

/**
 * CLI entry; takes no flags. Measures latency, then restarts each service once, reads the plan and window reports,
 * and writes `performance.json` and `performance.md` to the reports directory. Exit 1 when up.json is missing or a
 * restarted service did not come back.
 */
export async function main(argv: string[], deps: MainDeps = {}): Promise<CliOutcome> {
  parseFlags(argv, { options: {}, usage: USAGE });
  const env = deps.env ?? process.env;
  const upOptions: UpStateOptions = { env };
  const readUp = deps.readUpState ?? readUpState;
  const writeUp = deps.writeUpState ?? writeUpState;
  readUp(upOptions);
  const fetchFn: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => performance.now());
  const processDeps: ProcessDeps = {
    spawn: deps.spawn ?? nodeSpawn,
    kill: deps.kill ?? ((pid, signal) => process.kill(pid, signal)),
    fetch: fetchFn,
    now,
    sleep: deps.sleep ?? ((ms) => delay(ms)),
    readUpState: () => readUp(upOptions),
    writeUpState: (patch) => writeUp(patch, upOptions),
  };

  const fixturesAvailable = readFixtureStatus(env).available;
  const { businessDate } = await readJson(SEED_CONFIG_PATH, seedConfigSchema);
  const secrets = loadSecretStore(env);
  const admin = adminCredentials(env, secrets);
  const gatewayUrl = originBaseUrl('gateway', env);
  const legacySessions = await openSessions(
    'legacy',
    originBaseUrl('legacy', env),
    fetchFn,
    admin,
    fixturesAvailable ? [TIMESHEETS_ROLE] : [],
    secrets,
  );
  const gatewaySessions = await openSessions(
    'gateway',
    gatewayUrl,
    fetchFn,
    admin,
    fixturesAvailable ? probeRoles() : [],
    secrets,
  );

  const primed = await primeLookups(sessionOf(legacySessions, 'admin'));
  const findings: Finding[] = [];
  const latency: LatencyRow[] = [];
  for (const entry of READ_SET) {
    const resolved = resolveReadPath(entry, { asOf: businessDate, ...primed }, fixturesAvailable);
    const key = readSetSessionKey(entry.session);
    const measured =
      'skipped' in resolved
        ? skippedLatency(entry.set, resolved.skipped)
        : await measureLatencySet(
            { set: entry.set, path: resolved.path },
            { legacy: sessionOf(legacySessions, key), target: sessionOf(gatewaySessions, key) },
            { requests: REQUESTS_PER_SET, now },
          );
    latency.push(measured.row);
    findings.push(...measured.findings);
  }

  const probeContext: ProbeContext = {
    gatewayUrl,
    sessions: gatewaySessions,
    fetch: fetchFn,
    admin,
    fixturesAvailable,
    asOf: businessDate,
  };
  const coldStart: ColdStartRow[] = [];
  const scaleToZero: ScaleToZeroRow[] = [];
  let unhealthy = false;
  for (const service of RESTART_SERVICES) {
    const cycle = await restartAndMeasure(service, processDeps, probePlan(service, probeContext));
    coldStart.push(cycle.coldStart);
    scaleToZero.push(cycle.scaleToZero);
    findings.push(...cycle.findings);
    unhealthy ||= cycle.unhealthy;
  }

  const reports = reportsDir(env);
  const planReport = await readOptional(path.join(reports, 'terraform-plan.json'), terraformPlanReportSchema);
  if (planReport === undefined) {
    findings.push({ kind: 'terraform-plan-missing', subject: 'terraform-plan.json', detail: 'not in the reports directory' });
  }
  const windowsReport = await readOptional(path.join(reports, 'windows.json'), windowsReportSchema);
  if (windowsReport === undefined) {
    findings.push({ kind: 'windows-report-missing', subject: 'windows.json', detail: 'not in the reports directory' });
  }

  const report = buildPerformanceReport({
    latency,
    coldStart,
    scaleToZero,
    minInstanceCount: parseMinInstanceCounts(planReport),
    windowsOverThreshold: windowsOverThreshold(windowsReport),
    findings,
  });
  const written = await writeJsonReport(path.join(reports, 'performance.json'), report, { generatedBy: GENERATED_BY });
  await writeMarkdown(path.join(reports, 'performance.md'), 'Performance report', renderPerformanceMarkdown(report));
  return {
    code: unhealthy ? 1 : 0,
    summary: {
      report: written.path,
      latencySets: latency.filter((row) => row.legacy !== null).length,
      findings: report.findings.length,
      unhealthy,
    },
  };
}

if (isMainModule(import.meta.url)) void runCli(main);
