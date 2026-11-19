// Generates the performance report through run.ts against the running stack and checks what it records.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FIXTURES_UNAVAILABLE, loadCatalogue, scenarioById } from '../../src/golden/catalogue.js';
import { createHttpSession, type FetchLike, type HttpSession } from '../../src/lib/http.js';
import { reportsDir } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';
import { readJson } from '../../src/lib/report.js';
import {
  CATALOGUE_SCENARIO,
  EXPECTED_MIN_INSTANCES,
  GENERATED_BY,
  RATIO_FINDING_THRESHOLD,
  READ_SET,
  REQUESTS_PER_SET,
  RESTART_SERVICES,
  WINDOW_THRESHOLD_MS,
  checkMinInstanceCounts,
  chooseProbe,
  expandCatalogueReads,
  loadCutoverTable,
  main,
  measureLatencySet,
  notTargetDetail,
  parseMinInstanceCounts,
  ratioFinding,
  skippedLatency,
  terraformPlanReportSchema,
  windowsOverThreshold,
  windowsReportSchema,
  type CutoverTable,
  type Finding,
  type LatencyRow,
  type LatencySummary,
  type PerformanceReport,
  type RestartService,
} from '../../src/performance/run.js';
import { PACKAGE_NAMES } from '../../src/repro/ports.js';
import type { UpProcessEntry, UpState } from '../../src/repro/up-state.js';
import {
  fixtureStatus,
  readStack,
  requireTableVersion,
  waitHealthy,
  withRestoredServices,
  type ServiceName,
} from '../helpers/stack.js';

const HOOK_TIMEOUT_MS = 45 * 60_000;
const HEALTH_TIMEOUT_MS = 60_000;

/** `performance.json` as `writeJsonReport` stamps it. */
type WrittenReport = PerformanceReport & { sourceSha: string; generatedBy: string; generatedAt: string };

/** Whether `name` is a locally started target package. */
function isServiceName(name: string): name is ServiceName {
  return (PACKAGE_NAMES as readonly string[]).includes(name);
}

/** Whether `name` is a service run.ts stops and restarts. */
function isRestartService(name: string): name is RestartService {
  return (RESTART_SERVICES as readonly string[]).includes(name);
}

/** The latency row run.ts writes for `row`'s fixtures-backed set when the fixtures are unavailable. */
function fixturesSkippedRow({ set, source, session, routeKey, servedBy }: LatencyRow): LatencyRow {
  return skippedLatency({ set, source, session, routeKey, servedBy }, FIXTURES_UNAVAILABLE).row;
}

/** The findings of `kind` recorded for `subject`. */
function findingsFor(findings: readonly Finding[], kind: string, subject: string): Finding[] {
  return findings.filter((finding) => finding.kind === kind && finding.subject === subject);
}

/** The recorded launch fields a restart must keep; the pid may change. */
function launchSpec(entry: UpProcessEntry | undefined): Pick<UpProcessEntry, 'env' | 'command' | 'cwd' | 'port'> | undefined {
  return entry === undefined ? undefined : { env: entry.env, command: entry.command, cwd: entry.cwd, port: entry.port };
}

/** Asserts a finite, non-negative p50 no greater than p95. */
function expectSummary(summary: LatencySummary | null, label: string): void {
  expect(summary, label).not.toBeNull();
  if (summary === null) return;
  expect(Number.isFinite(summary.p50Ms) && Number.isFinite(summary.p95Ms), `${label} is finite`).toBe(true);
  expect(summary.p50Ms, `${label} p50`).toBeGreaterThanOrEqual(0);
  expect(summary.p95Ms, `${label} p95`).toBeGreaterThanOrEqual(summary.p50Ms);
}

/** Asserts a finite duration above 0 ms. */
function expectPositiveMs(value: number | null, label: string): void {
  expect(value, label).not.toBeNull();
  expect(Number.isFinite(value), `${label} is finite`).toBe(true);
  expect(value, label).toBeGreaterThan(0);
}

/** The `non-ok-response` findings recorded for read set `set` on either side. */
function nonOkFindings(findings: readonly Finding[], set: string): Finding[] {
  const subjects = new Set([`${set}/legacy`, `${set}/target`]);
  return findings.filter((finding) => finding.kind === 'non-ok-response' && subjects.has(finding.subject));
}

/** Session at `baseUrl` whose every request takes `ms` on `clock` and answers `status`. */
function answeringSession(baseUrl: string, clock: { t: number }, ms: number, status: number): HttpSession {
  const fetch: FetchLike = async () => {
    clock.t += ms;
    return new Response('{}', { status });
  };
  return createHttpSession({ baseUrl, fetch });
}

describe('performance report', () => {
  let stackBefore: UpState | undefined;
  let fixturesAvailable = false;
  let outcome: Awaited<ReturnType<typeof main>>;
  let report: WrittenReport;
  let markdown: string[];
  let table: CutoverTable;
  let expectedSets: string[];

  beforeAll(async () => {
    // Read first, so a stack that is not up fails with StackNotUpError rather than a refused gateway call.
    const stack = readStack();
    await requireTableVersion('v0002');
    stackBefore = stack;
    fixturesAvailable = fixtureStatus().available;
    table = await loadCutoverTable('v0002');
    const scenario = scenarioById(await loadCatalogue(), CATALOGUE_SCENARIO);
    expectedSets = [...expandCatalogueReads(scenario).map((read) => read.set), ...READ_SET.map((entry) => entry.set)];
    // Only the services run.ts stops are restored; gateway, web, migration and stub keep running throughout.
    const restartable = Object.keys(stack.processes).filter(isRestartService);
    outcome = await withRestoredServices(restartable, () => main([]));
    const reports = reportsDir();
    report = await readJson<WrittenReport>(path.join(reports, 'performance.json'));
    markdown = (await readFile(path.join(reports, 'performance.md'), 'utf8')).split('\n');
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (stackBefore === undefined) return;
    const failures: unknown[] = [];
    for (const name of Object.keys(stackBefore.processes).filter(isServiceName)) {
      try {
        await waitHealthy(name, { timeoutMs: HEALTH_TIMEOUT_MS });
      } catch {
        try {
          await withRestoredServices([name], () => Promise.resolve());
        } catch (err) {
          failures.push(err);
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} service(s) could not be restored after the performance run`);
    }
  }, HOOK_TIMEOUT_MS);

  it('writes performance.json and performance.md stamped with the pinned SHA', () => {
    const sha = pinnedSha();
    expect(outcome.code ?? 0, JSON.stringify(outcome.summary)).toBe(0);
    expect(report.sourceSha).toBe(sha);
    expect(report.generatedBy).toBe(GENERATED_BY);
    expect(markdown[0]).toMatch(/^# /);
    expect(markdown[1]).toBe(`Source SHA: ${sha}`);
  });

  it('records target and legacy p50 and p95 for 200 requests of every GS-CO-05 catalogue read and read-set entry', () => {
    expect(REQUESTS_PER_SET).toBe(200);
    expect(report.latency.map((row) => row.set)).toEqual(expectedSets);
    const catalogueRows = expectedSets.length - READ_SET.length;
    for (const [index, row] of report.latency.entries()) {
      const entry = READ_SET[index - catalogueRows];
      expect(row.source, row.set).toBe(entry === undefined ? 'catalogue' : 'read-set');
      if (entry?.fixtures === true && !fixturesAvailable) {
        expect(row, row.set).toEqual(fixturesSkippedRow(row));
        continue;
      }
      expect(row.requests, row.set).toBe(REQUESTS_PER_SET);
      expectSummary(row.target, `${row.set} target`);
      expectSummary(row.legacy, `${row.set} legacy`);
      // Catalogue reads may answer non-200 on legacy itself; the read-set reads must answer 200 on both sides.
      if (entry === undefined) continue;
      expect(row.statuses, row.set).toEqual({ legacy: [200], target: [200] });
      expect(nonOkFindings(report.findings, row.set), `${row.set} answers 200 on both sides`).toEqual([]);
    }
  });

  it('answers each read with the same distinct statuses on target as on legacy', () => {
    expect(report.findings.filter((finding) => finding.kind === 'status-mismatch')).toEqual([]);
    for (const row of report.latency) expect(row.statuses.target, row.set).toEqual(row.statuses.legacy);
  });

  it('records the serving side of every row and a legacy-served finding for each legacy-served row', () => {
    for (const row of report.latency) {
      expect(['target', 'legacy'], row.set).toContain(row.servedBy);
      expect(row.routeKey, row.set).toMatch(/^[a-z][a-z0-9]*:/);
      const served = findingsFor(report.findings, 'legacy-served', row.set);
      expect(served, row.set).toEqual(
        row.servedBy === 'legacy'
          ? [
              {
                kind: 'legacy-served',
                subject: row.set,
                detail: `${row.routeKey} is legacy-routed in v0002: the target columns measure the gateway proxying to legacy`,
              },
            ]
          : [],
      );
    }
  });

  it('deletes the feed collection it created for the feed read set', () => {
    expect(report.latency.find((row) => row.set === 'gs-co-05.feed')?.requests).toBe(REQUESTS_PER_SET);
    expect(report.findings.filter((finding) => finding.kind === 'feed-cleanup-failed')).toEqual([]);
  });

  it('flags target p95 above 1.5 times legacy as a finding, not a failure', () => {
    expect(RATIO_FINDING_THRESHOLD).toBe(1.5);
    for (const row of report.latency) {
      if (row.target === null || row.legacy === null) continue;
      expect({ ratioP95: row.ratioP95, finding: row.finding }, row.set).toEqual(ratioFinding(row.target, row.legacy));
      if (row.finding !== null) {
        expect(report.findings).toContainEqual({ kind: 'latency-ratio', subject: row.set, detail: row.finding });
      }
    }
  });

  it('records a measured cold start for every restartable service', () => {
    expect(report.coldStart.map((row) => row.service).sort()).toEqual([...RESTART_SERVICES].sort());
    for (const row of report.coldStart) {
      expect(row.label, row.service).toBe('measured');
      expectPositiveMs(row.startToFirst200Ms, `${row.service} cold start`);
    }
  });

  it('records a derived scale-to-zero-and-back timing for every service a gateway read reaches, and flags the others unavailable', () => {
    expect(report.scaleToZero.map((row) => row.service).sort()).toEqual([...RESTART_SERVICES].sort());
    for (const row of report.scaleToZero) {
      if (!isRestartService(row.service)) throw new Error(`${row.service} is not a restartable service`);
      const choice = chooseProbe(row.service, table, fixturesAvailable);
      const unavailable = { service: row.service, stopToFirstSuccessMs: null, label: 'unavailable' };
      if (choice.kind === 'skipped') {
        expect(fixturesAvailable, `${row.service} probe skipped only without fixtures`).toBe(false);
        expect(choice.reason, row.service).toBe(FIXTURES_UNAVAILABLE);
        expect(row, row.service).toEqual(unavailable);
        expect(findingsFor(report.findings, 'scale-probe-skipped', row.service)).toEqual([
          { kind: 'scale-probe-skipped', subject: row.service, detail: FIXTURES_UNAVAILABLE },
        ]);
        continue;
      }
      if (choice.kind === 'not-target') {
        expect(row, row.service).toEqual(unavailable);
        expect(findingsFor(report.findings, 'probe-not-target', row.service)).toEqual([
          { kind: 'probe-not-target', subject: row.service, detail: notTargetDetail(row.service, choice.routeKeys, 'v0002') },
        ]);
        continue;
      }
      expect(row.label, row.service).toBe('derived');
      expect(findingsFor(report.findings, 'probe-not-routed', row.service), row.service).toEqual([]);
      expectPositiveMs(row.stopToFirstSuccessMs, `${row.service} scale to zero and back`);
    }
  });

  it('confirms min_instance_count 0 for gateway, web and the ten services and 1 for migration', async () => {
    expect(EXPECTED_MIN_INSTANCES).toEqual({
      gateway: 0,
      web: 0,
      identity: 0,
      people: 0,
      'programs-sites': 0,
      'strategies-content': 0,
      communications: 0,
      reporting: 0,
      surveys: 0,
      timesheets: 0,
      finance: 0,
      'e-signature': 0,
      migration: 1,
    });
    const plan = await readJson(path.join(reportsDir(), 'terraform-plan.json'), terraformPlanReportSchema);
    const planned = parseMinInstanceCounts(plan);
    expect(checkMinInstanceCounts(planned.values)).toEqual([]);
    expect(report.minInstanceCount).toEqual({ ...planned, label: 'measured' });
  });

  it('lists exactly the write windows longer than 5 s', async () => {
    expect(WINDOW_THRESHOLD_MS).toBe(5000);
    const windows = await readJson(path.join(reportsDir(), 'windows.json'), windowsReportSchema);
    expect(report.windowsOverThreshold).toEqual(windowsOverThreshold(windows));
    for (const window of report.windowsOverThreshold) {
      expect(window.durationMs, window.windowId).toBeGreaterThan(WINDOW_THRESHOLD_MS);
      expect(report.findings).toContainEqual(
        expect.objectContaining({ kind: 'window-over-threshold', subject: window.windowId }),
      );
    }
  });

  it('states that a cloud measurement is not possible without apply', () => {
    expect(report.cloudMeasurement).toBe('not possible without apply');
  });

  it('leaves every up.json process healthy with its original env', async () => {
    if (stackBefore === undefined) throw new Error('beforeAll recorded no stack');
    const recorded = stackBefore.processes;
    const names = Object.keys(recorded).filter(isServiceName);
    for (const name of names) await waitHealthy(name, { timeoutMs: HEALTH_TIMEOUT_MS });
    const after = readStack();
    for (const name of names) {
      expect(launchSpec(after.processes[name]), name).toEqual(launchSpec(recorded[name]));
    }
  }, PACKAGE_NAMES.length * HEALTH_TIMEOUT_MS + 60_000);
});

describe('performance read-set success check', () => {
  const REQUESTS = 3;
  const entry = READ_SET.find((candidate) => candidate.set === 'csettings.list');

  it.each<{ legacy: number; target: number; failing: ('legacy' | 'target')[] }>([
    { legacy: 400, target: 400, failing: ['legacy', 'target'] },
    { legacy: 400, target: 200, failing: ['legacy'] },
    { legacy: 200, target: 400, failing: ['target'] },
    { legacy: 200, target: 200, failing: [] },
  ])('reports non-ok reads on $failing for legacy $legacy and target $target', async ({ legacy, target, failing }) => {
    if (entry === undefined) throw new Error('csettings.list is not in READ_SET');
    const clock = { t: 0 };
    const measured = await measureLatencySet(
      { set: entry.set, source: 'read-set', session: entry.session, routeKey: 'admin:csettings.list', servedBy: 'legacy', path: entry.path },
      {
        legacy: answeringSession('http://legacy.invalid', clock, 1, legacy),
        target: answeringSession('http://gateway.invalid', clock, 3, target),
      },
      { requests: REQUESTS, now: () => clock.t },
    );
    // The slower target also raises a latency-ratio finding, which the check leaves out.
    expect(measured.findings).toContainEqual(expect.objectContaining({ kind: 'latency-ratio', subject: entry.set }));
    expect(nonOkFindings(measured.findings, entry.set)).toEqual(
      failing.map((side) => ({
        kind: 'non-ok-response',
        subject: `${entry.set}/${side}`,
        detail: `${REQUESTS} of ${REQUESTS}: 400`,
      })),
    );
    expect(measured.findings.some((finding) => finding.kind === 'status-mismatch')).toBe(legacy !== target);
  });
});
