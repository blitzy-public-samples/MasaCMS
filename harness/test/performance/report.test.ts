// Performance report over the committed terraform-plan.json and windows.json producer samples; the unit cases of
// each run.ts function live in run.test.ts and are not repeated here.
import { existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { CATALOGUE_PATH, loadCatalogue, scenarioById } from '../../src/golden/catalogue.js';
import type { FetchLike } from '../../src/lib/http.js';
import { opt2Path, type EnvLike } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';
import {
  CATALOGUE_SCENARIO,
  CLOUD_MEASUREMENT,
  EXPECTED_MIN_INSTANCES,
  GATEWAY_PROBES,
  READ_SET,
  REQUESTS_PER_SET,
  RESTART_SERVICES,
  WINDOW_THRESHOLD_MS,
  checkMinInstanceCounts,
  expandCatalogueReads,
  main,
  parseMinInstanceCounts,
  terraformPlanReportSchema,
  windowsOverThreshold,
  windowsReportSchema,
  type KillLike,
  type PerformanceReport,
  type RestartService,
  type SpawnLike,
  type SpawnedProcess,
} from '../../src/performance/run.js';
import { portFor } from '../../src/repro/ports.js';
import { writeUpState, type UpProcessEntry } from '../../src/repro/up-state.js';

interface PlanSample {
  minInstanceCounts: Record<string, number>;
  expected: { cloudRunServices: string[] };
  [key: string]: unknown;
}

interface WindowsSample {
  flagThresholdMs: number;
  windows: Record<string, unknown>[];
  summary: { overThreshold: number };
  [key: string]: unknown;
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/performance/${name}`, import.meta.url));
}

const PLAN_SAMPLE = JSON.parse(readFileSync(fixturePath('terraform-plan.sample.json'), 'utf8')) as PlanSample;
const WINDOWS_SAMPLE = JSON.parse(readFileSync(fixturePath('windows.sample.json'), 'utf8')) as WindowsSample;
const SITE_DELETE_WINDOW = {
  windowId: '6F0A2C1E-5B7D-4E8A-9C3F0D1E2F3A4B02',
  routeKey: 'admin:csettings.updatesite{action=delete}',
  durationMs: 7500,
};

// Above Linux pid_max (at most 4194304), so no signal a test sends can reach a real process.
const PID_BASE = 1_000_000_000;
const LEGACY_PORT = '8500';
const LEGACY = `http://127.0.0.1:${LEGACY_PORT}`;
const GATEWAY = 'http://127.0.0.1:8100';
const LOGIN_PAGE = '/admin/?muraAction=clogin.main';
const LOGIN_POST = '/admin/?muraAction=cLogin.login';
const CUTOVER_STATUS = '/internal/v1/cutover/status';
const CSRF_TOKEN = 'FIXTURE-CSRF-REPORT';
const FEED_ID = 'F0000000-0000-0000-0000000000000001';
/** Cut-over version the fake gateway reports active, written to OPT2_CUTOVER_DIR. */
const ACTIVE_VERSION = 'v9101';
/** The fixture reads ACTIVE_VERSION routes to target, by path; every other route key is legacy. */
const TARGET_READS: readonly { path: string; route: string; owningService: RestartService }[] = [
  { path: '/legacy-fixtures/cfml/api.cfm/surveys/surveys', route: 'fixture:surveys/surveys@get', owningService: 'surveys' },
  { path: '/legacy-fixtures/cfml/api.cfm/finance/records', route: 'fixture:finance/records@get', owningService: 'finance' },
  { path: '/legacy-fixtures/cfml/api.cfm/esignature/requests', route: 'fixture:esignature/requests@get', owningService: 'e-signature' },
];
/** Services whose gateway probe ACTIVE_VERSION routes to target; identity's is a fresh-session surveys read. */
const TARGET_PROBED: readonly RestartService[] = ['identity', 'surveys', 'finance', 'e-signature'];
const LEGACY_MS = 4;
const TARGET_MS = 5;
const COLD_START_MS = 100;
const SEED_ROLES: readonly string[] = [
  ...new Set(
    Object.values(GATEWAY_PROBES)
      .flat()
      .flatMap((spec) => ('session' in spec && spec.session !== 'admin' && spec.session !== 'anonymous' ? [spec.session] : [])),
  ),
];

let tmp: string;
let globalFetch: Mock<typeof fetch>;
let processKill: MockInstance<typeof process.kill>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-perf-'));
  globalFetch = vi.fn<typeof fetch>(() => {
    throw new Error('network disabled');
  });
  vi.stubGlobal('fetch', globalFetch);
  processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('process.kill disabled');
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Placeholder password for `label`, assembled at run time so no credential-shaped literal sits in the source. */
function credential(label: string): string {
  return ['fixture', label, 'pw'].join('-');
}

function seedUsername(role: string): string {
  return `fixture-${role}`;
}

/** The sample's counts as `terraform show -json` plans them: one module instance per service, plus a job and a topic. */
function showJsonPlan(counts: Readonly<Record<string, number>>): unknown {
  const instance = (module: string, key: string, type: string, values: Record<string, unknown>) => ({
    address: `module.${module}["${key}"]`,
    resources: [{ address: `module.${module}["${key}"].${type}.this`, type, values }],
  });
  return {
    format_version: '1.2',
    planned_values: {
      root_module: {
        child_modules: [
          ...Object.entries(counts).map(([name, min]) =>
            instance('cloud_run_service', name, 'google_cloud_run_v2_service', {
              name,
              template: [{ scaling: [{ min_instance_count: min }] }],
            }),
          ),
          instance('cloud_run_job', 'db-bootstrap', 'google_cloud_run_v2_job', { name: 'db-bootstrap', template: [{ task_count: 1 }] }),
          instance('pubsub_topic', 'people.person.archived.v1', 'google_pubsub_topic', { name: 'people.person.archived.v1' }),
        ],
      },
    },
  };
}

describe('terraform-plan.json sample', () => {
  const { minInstanceCounts, ...wrapper } = PLAN_SAMPLE;

  it.each([
    ['the minInstanceCounts summary', 'minInstanceCounts', PLAN_SAMPLE],
    ['terraform show -json planned_values', 'plan.planned_values', { ...wrapper, plan: showJsonPlan(minInstanceCounts) }],
  ])('plans min_instance_count 0 for every deployed service but migration from %s, with no finding', (_label, source, sample) => {
    const parsed = parseMinInstanceCounts(terraformPlanReportSchema.parse(sample));

    expect(parsed).toStrictEqual({ source, values: EXPECTED_MIN_INSTANCES });
    expect(Object.keys(parsed.values).sort()).toStrictEqual([...PLAN_SAMPLE.expected.cloudRunServices].sort());
    expect(Object.entries(parsed.values).filter(([, count]) => count !== 0)).toStrictEqual([['migration', 1]]);
    expect(checkMinInstanceCounts(parsed.values)).toStrictEqual([]);
  });

  it('flags a scale-to-zero service the plan keeps warm', () => {
    const warmGateway = terraformPlanReportSchema.parse({ ...PLAN_SAMPLE, minInstanceCounts: { ...minInstanceCounts, gateway: 1 } });

    expect(checkMinInstanceCounts(parseMinInstanceCounts(warmGateway).values)).toStrictEqual([
      { kind: 'min-instance-count', subject: 'gateway', detail: 'expected 0, planned 1' },
    ]);
  });
});

describe('windows.json sample', () => {
  const withoutDuration = (window: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(window).filter(([key]) => key !== 'durationMs'));

  it.each([
    ['the recorded durationMs', (window: Record<string, unknown>) => window],
    ['the first-to-last phase span', withoutDuration],
  ])('flags only the site-delete window from %s, as the producer summary counts', (_label, shape) => {
    const flagged = windowsOverThreshold(windowsReportSchema.parse({ ...WINDOWS_SAMPLE, windows: WINDOWS_SAMPLE.windows.map(shape) }));

    expect(flagged).toStrictEqual([SITE_DELETE_WINDOW]);
    expect(flagged).toHaveLength(WINDOWS_SAMPLE.summary.overThreshold);
    expect(WINDOWS_SAMPLE.flagThresholdMs).toBe(WINDOW_THRESHOLD_MS);
  });
});

describe('main over the samples', () => {
  const LOGIN_FORM = `
<form id="loginForm" name="frmLogin" method="post" action="./?muraAction=cLogin.login">
  <input id="username" name="username" type="text">
  <input id="password" type="password" name="password">
  <input type="hidden" name="isAdminLogin" value="true">
  <input type="hidden" name="csrf_token" value="${CSRF_TOKEN}">
  <input type="hidden" name="csrf_token_expires" value="260630120000000">
</form>`;

  function html(markup: string, setCookie?: string): Response {
    const headers: [string, string][] = [['content-type', 'text/html; charset=utf-8']];
    if (setCookie !== undefined) headers.push(['set-cookie', setCookie]);
    return new Response(`<!DOCTYPE html><html><body>${markup}</body></html>`, { headers });
  }

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: fixture`), { code });
  }

  /** Owner of a GET ACTIVE_VERSION routes to target; the gateway proxies every other request to legacy. */
  function targetOwnerOf(method: string, url: URL): RestartService | undefined {
    return method === 'GET' ? TARGET_READS.find((read) => read.path === url.pathname)?.owningService : undefined;
  }

  /**
   * Legacy's collection admin as the run drives it: list, a Local edit form with its unfilled advanced-filter row
   * (edit.cfm:512-533), save and delete, and the feed read. An edit without type (edit.cfm:78), or a save whose
   * `param` lists a row without its paramField (admin/Application.cfc:474-488), answers 500.
   */
  function feedAnswer(feeds: Map<string, string>, method: string, url: URL, body: string): Response | undefined {
    if (url.pathname === '/_api/feed/v1/') {
      return feeds.has(url.searchParams.get('feedid') ?? '') ? new Response('<rss/>') : new Response(null, { status: 404 });
    }
    const action = url.pathname === '/admin/' ? url.searchParams.get('muraAction')?.toLowerCase() : undefined;
    if (method === 'GET' && action === 'cfeed.list') {
      const links = [...feeds].map(([id, name]) => `<a href="./?muraAction=cFeed.edit&amp;feedID=${id}&amp;type=Local">${name}</a>`);
      return html(links.join(''));
    }
    if (method === 'GET' && action === 'cfeed.edit') {
      if (!url.searchParams.has('type')) return new Response(null, { status: 500 });
      const id = url.searchParams.get('feedID') ?? '';
      return html(`<form action="./?muraAction=cFeed.update&amp;siteid=tenant-a" method="post"><input type="hidden" name="feedID" value="${id}">
        <select name="paramRelationship1" style="display:none;"><option value="and">And</option><option value="or">Or</option></select>
        <input type="hidden" name="param" value="1"><select name="paramField1"><option value="">Select Field</option></select>
        <select name="paramCondition1"><option value="Equals">Equals</option></select><input type="text" name="paramCriteria1">
        <input type="hidden" name="csrf_token" value="${CSRF_TOKEN}"><input type="hidden" name="csrf_token_expires" value="260630120000000"></form>`);
    }
    if (method !== 'POST' || action !== 'cfeed.update') return undefined;
    const form = new URLSearchParams(body);
    const rows = form.getAll('param').flatMap((list) => list.split(',')).filter((n) => n !== '');
    if (rows.some((n) => !form.has(`paramField${n}`))) return new Response(null, { status: 500 });
    if (form.get('action') === 'add') feeds.set(FEED_ID, form.get('name') ?? '');
    if (form.get('action') === 'delete') feeds.delete(form.get('feedID') ?? '');
    return new Response(null, { status: 302, headers: { location: './?muraAction=cFeed.list&siteid=tenant-a' } });
  }

  /**
   * Legacy origin, gateway and the ten service processes on one fake clock: each legacy request takes LEGACY_MS,
   * each gateway request TARGET_MS, a started service answers /healthz 200 after COLD_START_MS, and the gateway
   * answers 502 for a target-routed read while its owner or identity is stopped.
   */
  function fakeStack(stateDir: string) {
    let t = 0;
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
    const passwords = new Map<string, string>([
      ['admin', credential('admin')],
      ...SEED_ROLES.map((role): [string, string] => [seedUsername(role), credential(role)]),
    ]);
    const running = new Map<RestartService, number>();
    const readyAt = new Map<RestartService, number>();
    const byPort = new Map<number, RestartService>();
    const byCwd = new Map<string, RestartService>();
    const entries: Record<string, UpProcessEntry> = {};
    let nextPid = PID_BASE;
    let loginPages = 0;
    const feeds = new Map<string, string>();
    for (const service of RESTART_SERVICES) {
      nextPid += 1;
      const cwd = path.join(stateDir, 'processes', service);
      entries[service] = { pid: nextPid, port: portFor(service), cwd, command: ['node', 'dist/main.js'] };
      running.set(service, nextPid);
      byPort.set(portFor(service), service);
      byCwd.set(cwd, service);
    }

    const kill = vi.fn<KillLike>((pid, signal) => {
      const service = [...running].find(([, live]) => live === Math.abs(pid))?.[0];
      if (service === undefined) throw errno('ESRCH');
      if (signal !== 0) running.delete(service);
      return true;
    });

    const spawn = vi.fn<SpawnLike>((_command, _args, options) => {
      const service = byCwd.get(String(options.cwd));
      if (service === undefined) throw new Error(`unscripted spawn in ${String(options.cwd)}`);
      nextPid += 1;
      running.set(service, nextPid);
      readyAt.set(service, t + COLD_START_MS);
      const child: SpawnedProcess = { pid: nextPid, unref: () => undefined, once: () => child };
      return child;
    });

    function health(url: URL): Response {
      const service = byPort.get(Number(url.port));
      if (service === undefined || !running.has(service)) throw errno('ECONNREFUSED');
      return new Response(null, { status: t >= (readyAt.get(service) ?? 0) ? 200 : 503 });
    }

    function answer(side: 'legacy' | 'gateway', method: string, target: string, body: string): Response {
      if (method === 'GET' && target === LOGIN_PAGE) {
        loginPages += 1;
        return html(LOGIN_FORM, `CFID=${side}-${loginPages}; Path=/; HttpOnly`);
      }
      if (method === 'POST' && target === LOGIN_POST) {
        const form = new URLSearchParams(body);
        const accepted = form.get('csrf_token') === CSRF_TOKEN && passwords.get(form.get('username') ?? '') === form.get('password');
        return new Response(null, { status: 302, headers: { location: accepted ? './' : './?muraAction=clogin.main' } });
      }
      if (method === 'GET' && target === '/admin/') return html('<h1>Masa CMS - Site Content</h1>');
      return feedAnswer(feeds, method, new URL(target, LEGACY), body) ?? json({ data: {} });
    }

    const fetch = vi.fn<FetchLike>(async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? 'GET';
      if (url.pathname === '/healthz') return health(url);
      if (url.origin === GATEWAY && url.pathname === CUTOVER_STATUS) return json({ tableVersion: ACTIVE_VERSION });
      const side = url.origin === LEGACY ? 'legacy' : url.origin === GATEWAY ? 'gateway' : undefined;
      if (side === undefined) throw new Error(`unscripted request ${method} ${input}`);
      t += side === 'legacy' ? LEGACY_MS : TARGET_MS;
      const owner = side === 'gateway' ? targetOwnerOf(method, url) : undefined;
      if (owner !== undefined && !(running.has(owner) && running.has('identity'))) return new Response('Bad Gateway', { status: 502 });
      return answer(side, method, `${url.pathname}${url.search}`, typeof init.body === 'string' ? init.body : '');
    });

    return { entries, clock, kill, spawn, fetch, feeds };
  }

  /** GS-CO-05's seed rows (tenant-a Pages, the umbrella png, the tenant-a Folder) as the seed generator writes them. */
  function seedDataset(): unknown {
    const id = (tag: string, n: number) => `${tag}-0000-0000-${String(n).padStart(16, '0')}`;
    return {
      businessDate: '2026-06-30',
      masa: {
        content: [
          ...[1, 2, 3, 4, 5].map((n) => ({ contentID: id('0000PAGE', n), siteID: 'tenant-a', type: 'Page' })),
          { contentID: id('00FOLDER', 1), siteID: 'tenant-a', type: 'Folder' },
        ],
        files: [{ fileID: id('000IMAGE', 1), siteID: 'umbrella', fileExt: 'png' }],
      },
    };
  }

  /** mtime of `file`, or null when it does not exist. */
  function fileState(file: string): number | null {
    return existsSync(file) ? statSync(file).mtimeMs : null;
  }

  async function writeJson(file: string, body: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(body));
  }

  it('writes performance.json and performance.md from the sample plan and windows to the reports directory only', async () => {
    const stateDir = path.join(tmp, 'state');
    const reportsDir = path.join(tmp, 'reports');
    const cutoverDir = path.join(tmp, 'cutover');
    const env: EnvLike = {
      OPT2_STATE_DIR: stateDir,
      OPT2_REPORTS_DIR: reportsDir,
      OPT2_CUTOVER_DIR: cutoverDir,
      PORT: LEGACY_PORT,
      MURA_ADMIN_PASSWORD: credential('admin'),
    };
    const stack = fakeStack(stateDir);
    writeUpState({ processes: stack.entries }, { env });
    await writeJson(path.join(cutoverDir, 'versions', `${ACTIVE_VERSION}.json`), {
      tableVersion: ACTIVE_VERSION,
      entries: TARGET_READS.map(({ route, owningService }) => ({ route, owningService, state: 'target', kind: 'read' })),
    });
    await writeJson(path.join(stateDir, 'fixtures.json'), { available: true, reason: null, checkedAt: '2026-06-30T09:00:00.000Z' });
    await writeJson(path.join(stateDir, 'secrets', 'seed-credentials.json'), {
      roles: { 'tenant-a': Object.fromEntries(SEED_ROLES.map((role) => [role, seedUsername(role)])) },
      users: { 'tenant-a': Object.fromEntries(SEED_ROLES.map((role) => [seedUsername(role), credential(role)])) },
    });
    await writeJson(path.join(stateDir, 'seed', 'dataset.json'), seedDataset());
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.copyFile(fixturePath('terraform-plan.sample.json'), path.join(reportsDir, 'terraform-plan.json'));
    await fs.copyFile(fixturePath('windows.sample.json'), path.join(reportsDir, 'windows.json'));
    const repoReports = ['performance.json', 'performance.md'].map((name) => opt2Path('reports', name));
    const repoBefore = repoReports.map(fileState);

    const outcome = await main([], {
      env,
      fetch: stack.fetch,
      kill: stack.kill,
      spawn: stack.spawn,
      now: stack.clock.now,
      sleep: stack.clock.sleep,
      invoker: { headersFor: async () => ({}) },
    });

    const sets = [
      ...expandCatalogueReads(scenarioById(await loadCatalogue(CATALOGUE_PATH), CATALOGUE_SCENARIO)).map((read) => read.set),
      ...READ_SET.map((entry) => entry.set),
    ];
    const report = JSON.parse(await fs.readFile(path.join(reportsDir, 'performance.json'), 'utf8')) as PerformanceReport & {
      sourceSha: string;
    };
    expect(outcome).toStrictEqual({
      code: 0,
      summary: { report: path.join(reportsDir, 'performance.json'), latencySets: sets.length, findings: report.findings.length, unhealthy: false },
    });
    expect(report.sourceSha).toBe(pinnedSha());
    expect(report.minInstanceCount).toStrictEqual({ source: 'minInstanceCounts', values: PLAN_SAMPLE.minInstanceCounts, label: 'measured' });
    expect(report.windowsOverThreshold).toStrictEqual([SITE_DELETE_WINDOW]);
    // ACTIVE_VERSION leaves every latency route on legacy and routes no gateway read to six of the services.
    expect(report.findings.filter((finding) => finding.kind === 'legacy-served')).toHaveLength(sets.length);
    expect(report.findings.filter((finding) => finding.kind === 'probe-not-target').map((finding) => finding.subject).sort()).toStrictEqual(
      RESTART_SERVICES.filter((service) => !TARGET_PROBED.includes(service)).sort(),
    );
    expect(report.findings.filter((finding) => finding.kind !== 'legacy-served' && finding.kind !== 'probe-not-target')).toStrictEqual([
      { kind: 'window-over-threshold', subject: SITE_DELETE_WINDOW.windowId, detail: `${SITE_DELETE_WINDOW.routeKey} 7500 ms` },
    ]);
    expect(report.cloudMeasurement).toBe(CLOUD_MEASUREMENT);
    expect(report.latency.map((row) => [row.set, row.requests, row.servedBy])).toStrictEqual(sets.map((set) => [set, REQUESTS_PER_SET, 'legacy']));
    // The run deleted the collection it created for the feed set.
    expect(stack.feeds.size).toBe(0);
    expect(report.coldStart.map((row) => [row.service, row.startToFirst200Ms])).toStrictEqual(
      RESTART_SERVICES.map((service) => [service, COLD_START_MS]),
    );
    expect(report.scaleToZero.map((row) => [row.service, row.stopToFirstSuccessMs !== null, row.label])).toStrictEqual(
      RESTART_SERVICES.map((service) => [service, TARGET_PROBED.includes(service), TARGET_PROBED.includes(service) ? 'derived' : 'unavailable']),
    );

    const markdown = await fs.readFile(path.join(reportsDir, 'performance.md'), 'utf8');
    expect(markdown.split('\n').slice(0, 2)).toStrictEqual(['# Performance report', `Source SHA: ${pinnedSha()}`]);
    expect(markdown).toContain('Source: `minInstanceCounts`.');
    expect(markdown).toContain('| migration | 1 | 1 |');
    expect(markdown).toContain(`| ${SITE_DELETE_WINDOW.windowId} | ${SITE_DELETE_WINDOW.routeKey} | 7500 |`);
    expect(markdown).toContain('| Service | Stop to first success through the gateway (ms) | Label |');
    expect(markdown).toContain('| people | n/a | unavailable |');
    expect(markdown).toContain(`- Cloud measurement: ${CLOUD_MEASUREMENT}.`);

    expect(repoReports.map(fileState)).toStrictEqual(repoBefore);
    expect(stack.spawn).toHaveBeenCalledTimes(RESTART_SERVICES.length);
    expect(processKill).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
