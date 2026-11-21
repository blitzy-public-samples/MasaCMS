// Latency, cold start, min_instance_count, scale-to-zero and write-window report (`npm run performance`).
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { load, type CheerioAPI } from 'cheerio';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, matchRouteKey, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { z } from '@opt2/platform/service-kit';

import {
  FIXTURES_UNAVAILABLE,
  loadCatalogue,
  readFixtureStatus,
  scenarioById,
  type Scenario,
  type Step,
} from '../golden/catalogue.js';
import { coverageRouteResults, type StepRequest } from '../golden/coverage.js';
import { GoldenConfigError } from '../golden/errors.js';
import { activeTableVersion } from '../golden/replay.js';
import {
  adminLogin,
  createScenarioContext,
  DEFAULT_SESSION,
  formTokensFrom,
  GATEWAY_PORT,
  loadSecretStore,
  loadSeedStore,
  loginSessions,
  originBaseUrl,
  resolvePlaceholders,
  SEED_CONFIG_PATH,
  session,
  type FormTokens,
  type LoginCredentials,
  type SecretStore,
  type SeedStore,
} from '../golden/session.js';
import { isMainModule, parseFlags, runCli, type CliOutcome } from '../lib/cli.js';
import { createHttpSession, type FetchLike, type HttpResult, type HttpSession } from '../lib/http.js';
import type { HarnessInvoker } from '../lib/invocation.js';
import { repoPath, reportsDir, type EnvLike } from '../lib/paths.js';
import { readJson, writeJsonReport, writeMarkdown } from '../lib/report.js';
import { PACKAGE_NAMES, portFor, type PackageName } from '../repro/ports.js';
import {
  processStartTime,
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

/** Catalogue scenario whose own requests lead the latency rows. */
export const CATALOGUE_SCENARIO = 'GS-CO-05';

/** Name of the Local collection the run creates for the feed read set and deletes after it. */
export const PERFORMANCE_FEED_NAME = 'OPT2 performance read set';

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

/** Where a latency row comes from: the catalogue scenario's own requests, or the fixed read set. */
export type ReadSource = 'catalogue' | 'read-set';

/** One fixed latency read; `path` may hold `{ids}`, `{feedId}` and `{asOf}`, filled before measurement. */
export interface ReadSetEntry {
  set: string;
  session: 'anonymous' | 'admin' | 'timesheets';
  path: string;
  /** Measured against a Local collection the run creates just before the set and deletes just after it. */
  needs?: 'feedId';
  fixtures?: true;
}

const FIXTURE_API = '/legacy-fixtures/cfml/api.cfm';
const CONTENT_API = `/_api/json/v1/${SEED_SITE}`;
const CUSERS_LISTUSERS_PATH = `/admin/?muraAction=cUsers.listUsers&siteid=${SEED_SITE}&ispublic=0`;
const CSETTINGS_LIST_PATH = '/admin/?muraAction=cSettings.list';
const CONTENT_FIND_ONE_PATH = `${CONTENT_API}/content/${HOME_CONTENT_ID}`;
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
// The Site Manager tree under the home node, in the form carch/list.cfm redirects to.
const SITE_MANAGER_TREE_PATH = `/admin/?muraAction=cArch.list&siteid=${SEED_SITE}&moduleid=${SITE_MANAGER_MODULE_ID}&topid=${HOME_CONTENT_ID}`;
const TIMESHEET_SHEETS_PATH = `${FIXTURE_API}/timesheets/sheets?siteid=${SEED_SITE}&asOf={asOf}`;
// GS-CO-13's rss step requests the feed API in this form.
const FEED_READ_PATH = `/_api/feed/v1/?feedid={feedId}&siteid=${SEED_SITE}`;
const FIND_MANY_ID_COUNT = 5;

/** The fixed reads measured after the catalogue's: findMany over seeded pages, the RSS read, and the named sets. */
export const READ_SET: readonly ReadSetEntry[] = Object.freeze([
  { set: 'gs-co-05.content.findMany', session: 'anonymous', path: `${CONTENT_API}/content/{ids}` },
  { set: 'gs-co-05.feed', session: 'anonymous', path: FEED_READ_PATH, needs: 'feedId' },
  { set: 'cusers.listusers', session: 'admin', path: CUSERS_LISTUSERS_PATH },
  { set: 'csettings.list', session: 'admin', path: CSETTINGS_LIST_PATH },
  { set: 'timesheets.sheets', session: 'timesheets', path: TIMESHEET_SHEETS_PATH, fixtures: true },
]);

/** One request of a catalogue step: `route` has its `${matrix.*}` values substituted and keeps `${seed.*}`. */
export interface CatalogueRead {
  set: string;
  source: 'catalogue';
  session: string;
  route: string;
}

const MATRIX_REF = /\$\{matrix\.([a-zA-Z][\w-]*)\}/g;

function isPlainGet(step: Step): boolean {
  return (
    step.method === 'GET' &&
    step.auth === undefined &&
    step.csrf === 'none' &&
    step.headers === undefined &&
    step.form === undefined &&
    step.body === undefined &&
    step.multipart === undefined &&
    step.candidates === undefined
  );
}

/** One read per step and matrix combination (first declared key slowest); throws GoldenConfigError for a non-plain GET. */
export function expandCatalogueReads(scenario: Pick<Scenario, 'id' | 'sessions' | 'steps'>): CatalogueRead[] {
  const declared = Object.keys(scenario.sessions);
  return scenario.steps.flatMap((step) => {
    if (!isPlainGet(step)) {
      throw new GoldenConfigError(`${scenario.id} step ${step.name} is not a plain GET, so it cannot be timed as sent`);
    }
    const combinations = Object.entries(step.matrix ?? {}).reduce<Record<string, string>[]>(
      (acc, [name, values]) => acc.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value }))),
      [{}],
    );
    return combinations.map((combo): CatalogueRead => {
      const fill = (text: string): string => text.replace(MATRIX_REF, (whole, name: string) => combo[name] ?? whole);
      // An unnamed step runs in the scenario's only session, else in `default`, as session() picks it.
      const named = fill(step.as ?? (declared.length === 1 ? declared[0] : undefined) ?? DEFAULT_SESSION);
      const route = fill(step.route);
      return { set: `${scenario.id.toLowerCase()}:${named} ${route}`, source: 'catalogue', session: named, route };
    });
  });
}

/**
 * The read through the gateway that stands for one service: a fresh admin login, or a GET of `path` (which may
 * hold `{asOf}`) in the `admin`, `anonymous` or seeded `tenant-a` role session.
 */
export type ProbeSpec = { login: true } | { session: string; path: string; fixtures?: true };

/** A service's gateway probes in preference order. */
export type ProbeCandidates = readonly [ProbeSpec, ...ProbeSpec[]];

/** Gateway probes per restarted service; `fixtures` probes need the synthetic legacy oracle. */
export const GATEWAY_PROBES: Readonly<Record<RestartService, ProbeCandidates>> = Object.freeze({
  identity: [{ login: true }],
  people: [{ session: 'admin', path: CUSERS_LISTUSERS_PATH }],
  'programs-sites': [{ session: 'admin', path: CSETTINGS_LIST_PATH }],
  'strategies-content': [
    { session: 'anonymous', path: CONTENT_FIND_ONE_PATH },
    { session: 'admin', path: SITE_MANAGER_TREE_PATH },
  ],
  communications: [
    {
      session: 'communications.sender',
      path: `${FIXTURE_API}/communications/templates?siteid=${SEED_SITE}`,
      fixtures: true,
    },
  ],
  reporting: [{ session: 'reporting.exporter', path: `${FIXTURE_API}/reporting/exports?siteid=${SEED_SITE}`, fixtures: true }],
  surveys: [{ session: 'surveys.manager', path: `${FIXTURE_API}/surveys/surveys?siteid=${SEED_SITE}`, fixtures: true }],
  timesheets: [{ session: TIMESHEETS_ROLE, path: TIMESHEET_SHEETS_PATH, fixtures: true }],
  finance: [{ session: 'finance.preparer', path: `${FIXTURE_API}/finance/records?siteid=${SEED_SITE}`, fixtures: true }],
  'e-signature': [
    {
      session: 'esignature.signer',
      path: `${FIXTURE_API}/esignature/requests?siteid=${SEED_SITE}`,
      fixtures: true,
    },
  ],
});

/** A probe that reads a path in a session. */
export type SessionProbeSpec = Extract<ProbeSpec, { path: string }>;

/**
 * A service's probe under the active version; identity may borrow a target read whose fresh session it resolves.
 * `not-target` lists the route key of every candidate.
 */
export type ProbeChoice =
  | { kind: 'own'; spec: ProbeSpec; routeKey: string }
  | { kind: 'fresh-session'; via: RestartService; spec: SessionProbeSpec; routeKey: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'not-target'; routeKeys: string[] };

// The admin login post, whose route key (admin:clogin.login) stands for identity's own login probe.
const LOGIN_REQUEST: StepRequest = { method: 'POST', route: '/admin/index.cfm', form: { muraAction: 'cLogin.login' } };

function probeServing(table: CutoverTable, spec: ProbeSpec): Pick<ReadLabels, 'routeKey' | 'servedBy'> {
  return servingSide(table, 'login' in spec ? LOGIN_REQUEST : { method: 'GET', route: spec.path });
}

function probeUsable(spec: ProbeSpec, fixturesAvailable: boolean): boolean {
  return fixturesAvailable || !('path' in spec && spec.fixtures === true);
}

/**
 * The probe {@link restartAndMeasure} uses for `service` under `table`: its first usable target-served candidate,
 * skipped when every target-served one needs the unavailable fixtures.
 */
export function chooseProbe(service: RestartService, table: CutoverTable, fixturesAvailable: boolean): ProbeChoice {
  const candidates = GATEWAY_PROBES[service].map((spec) => ({ spec, ...probeServing(table, spec) }));
  const routed = candidates.filter((candidate) => candidate.servedBy === 'target');
  const own = routed.find((candidate) => probeUsable(candidate.spec, fixturesAvailable));
  if (own !== undefined) return { kind: 'own', spec: own.spec, routeKey: own.routeKey };
  if (routed.length > 0) return { kind: 'skipped', reason: FIXTURES_UNAVAILABLE };
  if (service === 'identity') {
    const borrowed = RESTART_SERVICES.filter((via) => via !== service).flatMap((via) =>
      GATEWAY_PROBES[via]
        .filter((spec): spec is SessionProbeSpec => 'path' in spec)
        .flatMap((spec): Extract<ProbeChoice, { kind: 'fresh-session' }>[] => {
          const side = probeServing(table, spec);
          return side.servedBy === 'target' ? [{ kind: 'fresh-session', via, spec, routeKey: side.routeKey }] : [];
        }),
    );
    const usable = borrowed.find((choice) => probeUsable(choice.spec, fixturesAvailable));
    if (usable !== undefined) return usable;
    if (borrowed.length > 0) return { kind: 'skipped', reason: FIXTURES_UNAVAILABLE };
  }
  return { kind: 'not-target', routeKeys: candidates.map((candidate) => candidate.routeKey) };
}

/** Detail of the `probe-not-target` finding of `service`, whose candidate `routeKeys` are legacy-routed in `version`. */
export function notTargetDetail(service: string, routeKeys: readonly string[], version: string): string {
  const last = routeKeys.at(-1);
  const keys = routeKeys.length > 1 ? `${routeKeys.slice(0, -1).join(', ')} and ${last} are` : `${last} is`;
  return `${keys} legacy-routed in ${version}, so no gateway read reaches ${service}`;
}

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

/** Side the active cut-over version sends a request to. */
export type ServedBy = 'target' | 'legacy';

/** What a latency row reads, in which session, its route key, and the side the active version serves it from. */
export interface ReadLabels {
  set: string;
  source: ReadSource;
  session: string;
  routeKey: string;
  servedBy: ServedBy;
}

/** Distinct statuses each side answered, ascending. */
export interface SideStatuses {
  legacy: number[];
  target: number[];
}

/** One latency row; a skipped set has null sides, no statuses and its reason as `finding`. */
export type LatencyRow = ReadLabels & {
  requests: number;
  target: LatencySummary | null;
  legacy: LatencySummary | null;
  statuses: SideStatuses;
  ratioP95: number | null;
  finding: string | null;
};

/** Local process start to first `/healthz` 200. */
export type ColdStartRow = { service: string; startToFirst200Ms: number | null; label: 'measured' };

/** Stopped state, through cold start, to the first successful request through the gateway; `unavailable` when none was timed. */
export type ScaleToZeroRow =
  | { service: string; stopToFirstSuccessMs: number; label: 'derived' }
  | { service: string; stopToFirstSuccessMs: null; label: 'unavailable' };

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

/** The cut-over version fields the serving side is read from. */
export const cutoverTableSchema = z.object({
  tableVersion: z.string(),
  entries: z.array(
    z.object({ route: z.string(), owningService: z.string(), state: z.enum(['legacy', 'target']), kind: z.string() }),
  ),
});

/** A parsed cut-over version file. */
export type CutoverTable = z.infer<typeof cutoverTableSchema>;

/** Cut-over version `version` from `<OPT2_CUTOVER_DIR, else gateway/cutover>/versions/`, as the gateway reads it. */
export async function loadCutoverTable(version: string, env: EnvLike = process.env): Promise<CutoverTable> {
  const dir = env.OPT2_CUTOVER_DIR;
  const file = path.join(dir ? path.resolve(dir) : repoPath('gateway', 'cutover'), 'versions', `${version}.json`);
  const table = await readJson(file, cutoverTableSchema);
  if (table.tableVersion !== version) throw new Error(`${file}: tableVersion ${table.tableVersion} is not ${version}`);
  return table;
}

/** Route key of `request` and the side `table` sends it to, matched as the gateway matches; no entry is legacy. */
export function servingSide(table: CutoverTable, request: StepRequest): Pick<ReadLabels, 'routeKey' | 'servedBy'> {
  const result = coverageRouteResults(request)[0] as RouteKeyResult;
  const route = matchRouteKey(result, table.entries.map((entry) => entry.route));
  const state = table.entries.find((entry) => entry.route === route)?.state;
  return { routeKey: result.key, servedBy: state === 'target' ? 'target' : 'legacy' };
}

/** The `legacy-served` finding of a row the active version leaves on legacy; none for a target-served row. */
export function legacyServedFindings(labels: ReadLabels, version: string): Finding[] {
  if (labels.servedBy === 'target') return [];
  const detail = `${labels.routeKey} is legacy-routed in ${version}: the target columns measure the gateway proxying to legacy`;
  return [{ kind: 'legacy-served', subject: labels.set, detail }];
}

/** Values the read-set placeholders take; `feedId` is the collection the run created for the feed set. */
export interface ReadSetValues {
  asOf: string;
  ids: readonly string[];
  feedId?: string | undefined;
}

/** `entry.path` with `{ids}` (comma-joined), `{feedId}` and `{asOf}` filled, each URL-encoded. */
export function resolveReadPath(entry: Pick<ReadSetEntry, 'path'>, values: ReadSetValues): string {
  return entry.path
    .replace('{ids}', values.ids.map(encodeURIComponent).join(','))
    .replace('{feedId}', encodeURIComponent(values.feedId ?? ''))
    .replace('{asOf}', encodeURIComponent(values.asOf));
}

const contentRowSchema = z.looseObject({ contentID: z.string().min(1) });

/** Content ids of the first {@link FIND_MANY_ID_COUNT} seeded `tenant-a` Pages, for the findMany read. */
export function seededPageIds(seed: SeedStore): string[] {
  return Array.from({ length: FIND_MANY_ID_COUNT }, (_, index) => {
    const row = seed.select({
      as: 'findMany',
      source: 'dataset',
      path: 'masa.content',
      where: { siteID: SEED_SITE, type: 'Page' },
      index,
    });
    return contentRowSchema.parse(row).contentID;
  });
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

function distinctSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function labelsOf({ set, source, session: name, routeKey, servedBy }: ReadLabels): ReadLabels {
  return { set, source, session: name, routeKey, servedBy };
}

/**
 * Measures `entry.path` (already resolved) `requests` times on each side, sequentially and interleaved (legacy,
 * then target, per iteration). A sample runs from before the request until its body has been read.
 */
export async function measureLatencySet(
  entry: ReadLabels & { path: string },
  sessions: SidePair,
  opts: { requests: number; now: () => number },
): Promise<LatencyMeasurement> {
  const sides = ['legacy', 'target'] as const;
  const samples = { legacy: [] as number[], target: [] as number[] };
  const answered = { legacy: [] as number[], target: [] as number[] };
  for (let i = 0; i < opts.requests; i += 1) {
    for (const side of sides) {
      const started = opts.now();
      const result = await sessions[side].get(entry.path);
      samples[side].push(opts.now() - started);
      answered[side].push(result.status);
    }
  }
  const legacy = summariseSamples(samples.legacy);
  const target = summariseSamples(samples.target);
  const statuses: SideStatuses = { legacy: distinctSorted(answered.legacy), target: distinctSorted(answered.target) };
  const { ratioP95, finding } = ratioFinding(target, legacy);
  const findings: Finding[] = [];
  if (finding !== null) findings.push({ kind: 'latency-ratio', subject: entry.set, detail: finding });
  for (const side of sides) {
    const notOk = answered[side].filter((status) => status !== 200);
    if (notOk.length === 0) continue;
    findings.push({
      kind: 'non-ok-response',
      subject: `${entry.set}/${side}`,
      detail: `${notOk.length} of ${opts.requests}: ${distinctSorted(notOk).join(', ')}`,
    });
  }
  if (statuses.legacy.join() !== statuses.target.join()) {
    findings.push({
      kind: 'status-mismatch',
      subject: entry.set,
      detail: `legacy answered ${statuses.legacy.join(', ')}; target answered ${statuses.target.join(', ')}`,
    });
  }
  return {
    row: { ...labelsOf(entry), requests: opts.requests, target, legacy, statuses, ratioP95, finding },
    findings,
  };
}

/** Row of a set that is not measured (0 requests), its reason both the row's finding and a `set-skipped` finding. */
export function skippedLatency(labels: ReadLabels, reason: string): LatencyMeasurement {
  return {
    row: {
      ...labelsOf(labels),
      requests: 0,
      target: null,
      legacy: null,
      statuses: { legacy: [], target: [] },
      ratioP95: null,
      finding: reason,
    },
    findings: [{ kind: 'set-skipped', subject: labels.set, detail: reason }],
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
  /** Start time of a running pid, undefined once it is gone; defaults to `processStartTime` over `/proc`. */
  startTimeOf?: (pid: number) => string | undefined;
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
 * to `entry.log` (relative to `cwd`) when set; records the new pid and its start time in up.json at once and
 * returns the pid.
 */
export async function startProcess(
  name: string,
  entry: UpProcessEntry,
  deps: Pick<ProcessDeps, 'spawn' | 'writeUpState' | 'startTimeOf'>,
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
  const startTime = (deps.startTimeOf ?? processStartTime)(pid);
  // The previous process's start time never describes the new pid.
  const { startTime: _previous, ...recorded } = entry;
  deps.writeUpState({ processes: { [name]: { ...recorded, pid, ...(startTime === undefined ? {} : { startTime }) } } });
  return pid;
}

/** One gateway request standing for a service; resolves true when it succeeded (HTTP 200, or a completed login). */
export interface GatewayProbe {
  describe: string;
  attempt(timeoutMs: number): Promise<boolean>;
}

/** The probe of a service, why its scale-to-zero measurement is skipped, or why no gateway read reaches it. */
export type ProbePlan = GatewayProbe | { skipped: string } | { notTarget: string };

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
 * first `/healthz` 200 (cold start) and the first successful gateway probe (scale to zero and back); a skipped or
 * not-target plan times the cold start only. Throws for a name outside {@link RESTART_SERVICES}.
 */
export async function restartAndMeasure(name: string, deps: ProcessDeps, probe: ProbePlan): Promise<RestartOutcome> {
  if (!isRestartService(name)) throw new Error(`${name} is not a restartable target service`);
  const findings: Finding[] = [];
  const outcome = (cold: number | null, scale: number | null, unhealthy = false): RestartOutcome => ({
    coldStart: { service: name, startToFirst200Ms: cold === null ? null : round(cold, 1), label: 'measured' },
    scaleToZero:
      scale === null
        ? { service: name, stopToFirstSuccessMs: null, label: 'unavailable' }
        : { service: name, stopToFirstSuccessMs: round(scale, 1), label: 'derived' },
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
  const servedWhileStopped = 'attempt' in probe ? await attemptSafely(probe.attempt, POLL_LIMIT_MS) : false;

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
  if ('notTarget' in probe) {
    findings.push({ kind: 'probe-not-target', subject: name, detail: probe.notTarget });
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

/** Sessions and clock of the feed collection lifecycle: the gateway admin session writes, anonymous sessions read. */
export interface FeedDeps {
  admin: HttpSession;
  readers: SidePair;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const FEED_LIST_PATH = `/admin/?muraAction=cFeed.list&siteid=${SEED_SITE}`;
const FEED_NEW_PATH = `/admin/?muraAction=cFeed.edit&siteid=${SEED_SITE}&feedID=&type=Local`;

/** The anonymous RSS read of collection `feedId`. */
export function feedReadPath(feedId: string): string {
  return resolveReadPath({ path: FEED_READ_PATH }, { asOf: '', ids: [], feedId });
}

/** Local collections a `cFeed.list` page links to for editing, with the text of each link. */
function localFeedLinks(page: HttpResult): { feedId: string; text: string }[] {
  const $ = load(page.text);
  return $('a[href]')
    .toArray()
    .flatMap((el) => {
      const params = new URL($(el).attr('href') ?? '', page.url).searchParams;
      const feedId = params.get('feedID') ?? '';
      const editsLocal = params.get('muraAction')?.toLowerCase() === 'cfeed.edit' && params.get('type') === 'Local';
      return editsLocal && feedId !== '' ? [{ feedId, text: $(el).text().trim() }] : [];
    });
}

const UNSUBMITTED_INPUT_TYPES = new Set(['submit', 'button', 'image', 'reset', 'file']);
const CHECKABLE_INPUT_TYPES = new Set(['checkbox', 'radio']);

// cheerio's element selection, derived so `domhandler` need not be a direct dependency.
type Selection = ReturnType<ReturnType<CheerioAPI['root']>['find']>;

// Disabled by its own attribute, or by a disabled fieldset unless the control sits in that fieldset's first legend.
function isDisabled($: CheerioAPI, control: Selection): boolean {
  if (control.is('[disabled]')) return true;
  return control
    .parents('fieldset[disabled]')
    .toArray()
    .some((fieldset) => $(fieldset).children('legend').first().find(control).length === 0);
}

// Every selected option of a multiple select; else the last selected one, or by default a drop-down's (display
// size 1) first enabled option.
function selectedOptions(select: Selection): Selection {
  const options = select.find('option');
  const selected = options.filter('[selected]');
  if (select.is('[multiple]')) return selected;
  if (selected.length > 0) return selected.last();
  return Number(select.attr('size') ?? '1') > 1 ? selected : options.not(':disabled').first();
}

function optionValue(option: Selection): string {
  // cheerio answers attr('value') of an option with its text even without the attribute.
  return option.is('[value]') ? (option.attr('value') ?? '') : option.text().replace(/[\t\n\f\r ]+/g, ' ').trim();
}

/**
 * Name/value pairs of the first `form` on `page` holding a `csrf_token` field, as a browser submits it without a
 * submitter: in document order, a repeated name once per control.
 */
function browserFormData(page: HttpResult): URLSearchParams {
  const $ = load(page.text);
  const form = $('form')
    .filter((_, el) => $(el).find(`input[name="${CSRF_FIELD_TOKEN}"]`).length > 0)
    .first();
  const formId = form.attr('id');
  const data = new URLSearchParams();
  $('input[name], select[name], textarea[name]').each((_, el) => {
    const control = $(el);
    const owner = control.attr('form');
    const owned = owner === undefined ? control.closest('form').is(form) : owner === formId;
    const name = control.attr('name') ?? '';
    if (!owned || name === '' || isDisabled($, control)) return;
    if (el.tagName === 'select') {
      selectedOptions(control)
        .not(':disabled')
        .each((_, option) => data.append(name, optionValue($(option))));
    } else if (el.tagName === 'textarea') {
      data.append(name, control.text().replace(/\r\n|\r|\n/g, '\r\n'));
    } else {
      const type = (control.attr('type') ?? 'text').toLowerCase();
      const checkable = CHECKABLE_INPUT_TYPES.has(type);
      if (UNSUBMITTED_INPUT_TYPES.has(type) || (checkable && !control.is('[checked]'))) return;
      data.append(name, control.attr('value') ?? (checkable ? 'on' : ''));
    }
  });
  return data;
}

/** `page`'s CSRF form as a browser submits it, with the CSRF pair and `fields` replacing every control of their names. */
function submittedForm(page: HttpResult, form: FormTokens, fields: Record<string, string>): URLSearchParams {
  const data = browserFormData(page);
  const overrides = { [CSRF_FIELD_TOKEN]: form.token, [CSRF_FIELD_EXPIRES]: form.expires, ...fields };
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);
  return data;
}

/** Creates the run's Local collection over `contentId` as GS-CO-13's save-local does; returns its id once both sides serve it. */
export async function createFeedCollection(deps: FeedDeps, contentId: string): Promise<string> {
  const before = new Set(localFeedLinks(await deps.admin.get(FEED_LIST_PATH)).map((link) => link.feedId));
  const page = await deps.admin.get(FEED_NEW_PATH);
  const form = formTokensFrom(deps.admin, page);
  const saved = await deps.admin.post(form.action, {
    form: submittedForm(page, form, {
      feedID: form.fields.feedID ?? '',
      siteid: SEED_SITE,
      action: 'add',
      type: 'Local',
      name: PERFORMANCE_FEED_NAME,
      isActive: '1',
      isPublic: '1',
      maxItems: '20',
      contentID: contentId,
    }),
  });
  // A new collection's form posts an empty feedID and legacy assigns the id (feedManager.cfc:175-177); cFeed.update
  // redirects to cFeed.list on success and on a refused CSRF token alike (cfeed.cfc:117-146), so the list shows which.
  const created = localFeedLinks(saved).find((link) => link.text === PERFORMANCE_FEED_NAME && !before.has(link.feedId));
  if (created === undefined) {
    const at = new URL(saved.url).pathname;
    throw new Error(`cFeed.update listed no new ${PERFORMANCE_FEED_NAME} collection (status ${saved.status} at ${at})`);
  }
  const readPath = feedReadPath(created.feedId);
  const confirmedAt = await pollUntil(async (timeoutMs) => {
    const legacy = await deps.readers.legacy.get(readPath, { timeoutMs });
    return legacy.status === 200 && (await deps.readers.target.get(readPath, { timeoutMs })).status === 200;
  }, deps);
  if (confirmedAt !== null) return created.feedId;
  const unconfirmed = `GET ${readPath} did not answer 200 on both sides within ${POLL_LIMIT_MS} ms`;
  try {
    await deleteFeedCollection(deps, created.feedId);
  } catch (err) {
    throw new Error(`${unconfirmed}; deleting collection ${created.feedId} failed: ${(err as Error).message}`, { cause: err });
  }
  throw new Error(unconfirmed);
}

/** Deletes collection `feedId` as GS-CO-13's delete-local does; throws unless legacy stops answering its RSS read 200. */
export async function deleteFeedCollection(deps: FeedDeps, feedId: string): Promise<void> {
  // cFeed.list links each Local collection's edit form with type=Local, which edit.cfm:78 reads.
  const editPath = `/admin/?muraAction=cFeed.edit&siteid=${SEED_SITE}&feedID=${encodeURIComponent(feedId)}&type=Local`;
  const page = await deps.admin.get(editPath);
  const form = formTokensFrom(deps.admin, page);
  await deps.admin.post(form.action, { form: submittedForm(page, form, { feedID: feedId, siteid: SEED_SITE, action: 'delete' }) });
  const readPath = feedReadPath(feedId);
  const goneAt = await pollUntil(async (timeoutMs) => (await deps.readers.legacy.get(readPath, { timeoutMs })).status !== 200, deps);
  if (goneAt === null) {
    throw new Error(`GET ${readPath} still answered 200 on legacy ${POLL_LIMIT_MS} ms after deleting collection ${feedId}`);
  }
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
    `- Source \`catalogue\` rows are the ${CATALOGUE_SCENARIO} scenario's own requests, one per session and path of its matrix, named \`<scenario>:<session> <route>\` with seed placeholders kept; source \`read-set\` rows are the fixed findMany, feed, \`cusers.listusers\`, \`csettings.list\` and timesheet sheet reads. The feed row reads a Local collection the run creates through the gateway just before the set and deletes just after it.`,
    '- Served by is the side the active cut-over version routes the row\'s route key to. On a `legacy` row the target columns measure the gateway proxying to legacy, and a `legacy-served` finding says so.',
    `- The request sets no latency threshold: a target p95 above ${RATIO_FINDING_THRESHOLD}x legacy and a write window over ${WINDOW_THRESHOLD_MS / 1000} s are flags, not failures.`,
    "- The legacy-direct admin and timesheet sessions log in on legacy itself, which updates that user's `tusers.LastLogin` on the legacy side.",
    `- Cold start is measured locally (process start to the first \`/healthz\` 200); scale to zero and back is derived (stopped service, restart, first successful request through the gateway), and \`unavailable\` where no such request was timed. Each poll is bounded at ${POLL_LIMIT_MS} ms.`,
    "- Each service is probed only by identity's admin login or by a request that leaves the compared state unchanged: a read, or a view whose writes are idempotent. A service none of whose probe candidates the active version routes to target has an `unavailable` row and a `probe-not-target` finding naming the candidates' route keys; one whose target-routed candidates all need the absent fixtures has an `unavailable` row and a `scale-probe-skipped` finding.",
    `- Cloud measurement: ${report.cloudMeasurement}.`,
    '',
    '## Latency',
    '',
    ...table(
      [
        'Set',
        'Source',
        'Served by',
        'Requests',
        'Target p50 (ms)',
        'Target p95 (ms)',
        'Legacy p50 (ms)',
        'Legacy p95 (ms)',
        'Ratio p95',
        'Finding',
      ],
      report.latency.map((row) => [
        row.set,
        row.source,
        row.servedBy,
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
      ['Service', 'Stop to first success through the gateway (ms)', 'Label'],
      report.scaleToZero.map((row) => [row.service, row.stopToFirstSuccessMs, row.label]),
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
  /** Operator credentials for the gateway's cut-over status; else the local `operator` invoker. */
  invoker?: HarnessInvoker;
}

const USAGE = 'usage: tsx src/performance/run.ts';
const HELP = `${USAGE}

Measures legacy and gateway latency over the ${CATALOGUE_SCENARIO} catalogue reads and the fixed read set
(${String(REQUESTS_PER_SET)} requests per set and side), labelling each set with the side the gateway's active cut-over version
serves it from. The feed set reads a Local collection the run creates through the gateway and deletes again.
Then restarts each target service recorded in up.json once to time its cold start and scale-to-zero recovery,
and writes the performance report. Needs the stack harness/repro/up.sh started.

Options:
  --help  print this help and exit 0

Environment:
  OPT2_STATE_DIR       state directory (default: $HOME/.opt2/state) holding up.json, fixtures.json,
                       seed/dataset.json, secrets/seed-credentials.json and the operator signing keys
  LEGACY_ORIGIN        legacy ColdFusion origin (default: http://127.0.0.1:\${PORT})
  PORT                 legacy ColdFusion port, used when LEGACY_ORIGIN is unset
  OPT2_GATEWAY_URL     gateway base URL (default: http://127.0.0.1:${String(GATEWAY_PORT)})
  OPT2_CUTOVER_DIR     cut-over directory the active version's file is read from (default: gateway/cutover)
  MURA_ADMIN_USERNAME  admin login on both sides (default: admin)
  MURA_ADMIN_PASSWORD  its password (secret)
  OPT2_REPORTS_DIR     report directory, relative to the repository root (default: opt2/reports); reads
                       terraform-plan.json and windows.json, writes performance.json and performance.md

Output: one JSON summary line on stdout with the report path, measured sets, finding count and health.
Exit: 0 report written; 1 up.json missing, the feed collection not deleted, a restarted service not back, or a
failure (no active cut-over version, the feed collection not served on both sides); 2 usage error.

Example (from harness/): npm run performance`;

/** GS-CO-05's folder seed row, the content the feed collection lists. */
const FEED_CONTENT_ID = '${seed.feed.contentID}';

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
  secrets: SecretStore;
  asOf: string;
  version: string;
}

function probePlan(service: RestartService, choice: ProbeChoice, ctx: ProbeContext): ProbePlan {
  if (choice.kind === 'skipped') return { skipped: choice.reason };
  if (choice.kind === 'not-target') return { notTarget: notTargetDetail(service, choice.routeKeys, ctx.version) };
  const { spec } = choice;
  const fresh = (timeoutMs: number): HttpSession => createHttpSession({ baseUrl: ctx.gatewayUrl, fetch: ctx.fetch, timeoutMs });
  if ('login' in spec) {
    return { describe: 'admin login', attempt: async (timeoutMs) => (await adminLogin(fresh(timeoutMs), ctx.admin)).ok };
  }
  const probePath = spec.path.replace('{asOf}', encodeURIComponent(ctx.asOf));
  if (choice.kind === 'own') {
    const s = sessionOf(ctx.sessions, spec.session);
    return {
      describe: `GET ${probePath} as ${spec.session}`,
      attempt: async (timeoutMs) => (await s.get(probePath, { timeoutMs })).status === 200,
    };
  }
  return {
    describe: `GET ${probePath} (${choice.via}) as ${spec.session} in a fresh gateway session, resolved through ${service}`,
    attempt: async (timeoutMs) => {
      const s = fresh(timeoutMs);
      if (spec.session !== 'anonymous') {
        const credentials = spec.session === 'admin' ? ctx.admin : roleCredentials(ctx.secrets, spec.session);
        if (!(await adminLogin(s, credentials)).ok) return false;
      }
      return (await s.get(probePath)).status === 200;
    },
  };
}

/** Seeded roles the long-lived gateway sessions of the chosen own probes log in as. */
function probeRoles(choices: readonly ProbeChoice[]): string[] {
  const roles = choices.flatMap((choice) => (choice.kind === 'own' && 'session' in choice.spec ? [choice.spec.session] : []));
  return [...new Set(roles)].filter((role) => role !== 'admin' && role !== 'anonymous');
}

/**
 * CLI entry; takes no flags. Measures latency, then restarts each service once, reads the plan and window reports,
 * and writes `performance.json` and `performance.md` to the reports directory. Exit 1 when up.json is missing, the
 * feed collection was not deleted, or a restarted service did not come back.
 */
export async function main(argv: string[], deps: MainDeps = {}): Promise<CliOutcome> {
  parseFlags(argv, { options: {}, usage: USAGE, help: HELP });
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
  const seed = loadSeedStore(env);
  const admin = adminCredentials(env, secrets);
  const gatewayUrl = originBaseUrl('gateway', env);
  const version = await activeTableVersion({ env, fetch: fetchFn, invoker: deps.invoker });
  if (version === null) throw new Error('the gateway has no active cut-over version');
  const table = await loadCutoverTable(version, env);
  const scenario = scenarioById(await loadCatalogue(), CATALOGUE_SCENARIO);
  const catalogueReads = expandCatalogueReads(scenario);
  const probes = RESTART_SERVICES.map((service) => ({ service, choice: chooseProbe(service, table, fixturesAvailable) }));
  const readSetRoles = fixturesAvailable ? [TIMESHEETS_ROLE] : [];
  const legacySessions = await openSessions('legacy', originBaseUrl('legacy', env), fetchFn, admin, readSetRoles, secrets);
  const gatewaySessions = await openSessions(
    'gateway',
    gatewayUrl,
    fetchFn,
    admin,
    [...new Set([...readSetRoles, ...probeRoles(probes.map((probe) => probe.choice))])],
    secrets,
  );
  const contexts = {
    legacy: createScenarioContext(scenario, { origin: 'legacy', env, fetch: fetchFn, secrets, seed }),
    target: createScenarioContext(scenario, { origin: 'gateway', env, fetch: fetchFn, secrets, seed }),
  };
  await loginSessions(contexts.legacy, scenario);
  await loginSessions(contexts.target, scenario);

  const findings: Finding[] = [];
  const latency: LatencyRow[] = [];
  let unhealthy = false;
  const timing = { requests: REQUESTS_PER_SET, now };
  const record = (measured: LatencyMeasurement): void => {
    latency.push(measured.row);
    findings.push(...measured.findings, ...legacyServedFindings(measured.row, version));
  };
  const labelled = (read: Pick<ReadLabels, 'set' | 'source' | 'session'>, readPath: string) => ({
    ...read,
    path: readPath,
    ...servingSide(table, { method: 'GET', route: readPath }),
  });
  for (const read of catalogueReads) {
    // Both contexts share one seed store and one secret store, so the legacy resolution is the gateway's too.
    const readPath = resolvePlaceholders(read.route, contexts.legacy);
    const pair = { legacy: session(contexts.legacy, read.session), target: session(contexts.target, read.session) };
    const labels = labelled({ set: read.set, source: read.source, session: read.session }, readPath);
    record(await measureLatencySet(labels, pair, timing));
  }

  const values: ReadSetValues = { asOf: businessDate, ids: seededPageIds(seed) };
  const feedDeps: FeedDeps = {
    admin: sessionOf(gatewaySessions, 'admin'),
    readers: { legacy: sessionOf(legacySessions, 'anonymous'), target: sessionOf(gatewaySessions, 'anonymous') },
    now,
    sleep: processDeps.sleep,
  };
  for (const entry of READ_SET) {
    const key = readSetSessionKey(entry.session);
    const read = { set: entry.set, source: 'read-set' as const, session: key };
    if (entry.fixtures === true && !fixturesAvailable) {
      record(skippedLatency(labelled(read, resolveReadPath(entry, values)), FIXTURES_UNAVAILABLE));
      continue;
    }
    const pair = { legacy: sessionOf(legacySessions, key), target: sessionOf(gatewaySessions, key) };
    if (entry.needs !== 'feedId') {
      record(await measureLatencySet(labelled(read, resolveReadPath(entry, values)), pair, timing));
      continue;
    }
    const feedId = await createFeedCollection(feedDeps, resolvePlaceholders(FEED_CONTENT_ID, contexts.legacy));
    try {
      record(await measureLatencySet(labelled(read, resolveReadPath(entry, { ...values, feedId })), pair, timing));
    } finally {
      try {
        await deleteFeedCollection(feedDeps, feedId);
      } catch (err) {
        findings.push({ kind: 'feed-cleanup-failed', subject: entry.set, detail: (err as Error).message });
        unhealthy = true;
      }
    }
  }

  const probeContext: ProbeContext = {
    gatewayUrl,
    sessions: gatewaySessions,
    fetch: fetchFn,
    admin,
    secrets,
    asOf: businessDate,
    version,
  };
  const coldStart: ColdStartRow[] = [];
  const scaleToZero: ScaleToZeroRow[] = [];
  for (const { service, choice } of probes) {
    const cycle = await restartAndMeasure(service, processDeps, probePlan(service, choice, probeContext));
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
