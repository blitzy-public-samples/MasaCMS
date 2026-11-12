// Generates the performance report through run.ts against the running stack and checks what it records.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHttpSession, type FetchLike, type HttpSession } from '../../src/lib/http.js';
import { reportsDir } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';
import { readJson } from '../../src/lib/report.js';
import {
  EXPECTED_MIN_INSTANCES,
  GATEWAY_PROBES,
  GENERATED_BY,
  RATIO_FINDING_THRESHOLD,
  READ_SET,
  REQUESTS_PER_SET,
  RESTART_SERVICES,
  WINDOW_THRESHOLD_MS,
  checkMinInstanceCounts,
  main,
  measureLatencySet,
  parseMinInstanceCounts,
  ratioFinding,
  resolveReadPath,
  skippedLatency,
  terraformPlanReportSchema,
  windowsOverThreshold,
  windowsReportSchema,
  type Finding,
  type LatencyRow,
  type LatencySummary,
  type PerformanceReport,
  type ReadSetEntry,
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

/** Whether the gateway probe run.ts uses for `service` needs the legacy fixtures. */
function probeNeedsFixtures(service: RestartService): boolean {
  const probe = GATEWAY_PROBES[service];
  return 'path' in probe && probe.fixtures === true;
}

/** The latency row run.ts writes for a fixtures-backed set when the fixtures are unavailable. */
function fixturesSkippedRow(entry: ReadSetEntry): LatencyRow {
  const resolved = resolveReadPath(entry, { asOf: '', ids: [], feedId: undefined }, false);
  if (!('skipped' in resolved)) throw new Error(`${entry.set} resolves without the fixtures`);
  return skippedLatency(entry.set, resolved.skipped).row;
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

  beforeAll(async () => {
    // Read first, so a stack that is not up fails with StackNotUpError rather than a refused gateway call.
    const stack = readStack();
    await requireTableVersion('v0002');
    stackBefore = stack;
    fixturesAvailable = fixtureStatus().available;
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

  it('records target and legacy p50 and p95 for 200 requests of every read set', () => {
    expect(REQUESTS_PER_SET).toBe(200);
    expect(report.latency.map((row) => row.set)).toEqual(READ_SET.map((entry) => entry.set));
    for (const [index, entry] of READ_SET.entries()) {
      const row = report.latency[index];
      if (entry.fixtures === true && !fixturesAvailable) {
        expect(row, entry.set).toEqual(fixturesSkippedRow(entry));
        continue;
      }
      expect(row?.requests, entry.set).toBe(REQUESTS_PER_SET);
      expectSummary(row?.target ?? null, `${entry.set} target`);
      expectSummary(row?.legacy ?? null, `${entry.set} legacy`);
      expect(nonOkFindings(report.findings, entry.set), `${entry.set} answers 200 on both sides`).toEqual([]);
    }
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

  it('records derived scale-to-zero-and-back timings', () => {
    expect(report.scaleToZero.length).toBeGreaterThan(0);
    for (const row of report.scaleToZero) {
      expect(RESTART_SERVICES).toContain(row.service);
      expect(row.label, row.service).toBe('derived');
      if (!fixturesAvailable && isRestartService(row.service) && probeNeedsFixtures(row.service)) {
        expect(row.stopToFirstSuccessMs, row.service).toBeNull();
        expect(report.findings).toContainEqual(
          expect.objectContaining({ kind: 'scale-probe-skipped', subject: row.service }),
        );
        continue;
      }
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
  const entry = READ_SET.find((candidate) => candidate.set === 'gs-co-05.content.findOne');

  it.each<{ legacy: number; target: number; failing: ('legacy' | 'target')[] }>([
    { legacy: 400, target: 400, failing: ['legacy', 'target'] },
    { legacy: 400, target: 200, failing: ['legacy'] },
    { legacy: 200, target: 400, failing: ['target'] },
    { legacy: 200, target: 200, failing: [] },
  ])('reports non-ok reads on $failing for legacy $legacy and target $target', async ({ legacy, target, failing }) => {
    if (entry === undefined) throw new Error('gs-co-05.content.findOne is not in READ_SET');
    const clock = { t: 0 };
    const measured = await measureLatencySet(
      entry,
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
  });
});
