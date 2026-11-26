import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CFML_LANGUAGES, runCloc } from '../../src/inventory/cloc.js';
import { gitArchiveExtract } from '../../src/lib/git.js';
import type { ProcessRunner } from '../../src/lib/git.js';
import { REPO_ROOT, isInsideRepo } from '../../src/lib/paths.js';
import { pinnedSha, readPin } from '../../src/lib/pin.js';
import { SERVICES, inventorySchema, traceabilityRowCount } from '../../src/reporting/check-reviewability.js';
import type { Inventory, ServiceName } from '../../src/reporting/check-reviewability.js';
import {
  ACTIVITY_PATH,
  FIXTURE_MODULE,
  GENERATED_BY,
  GENERATED_NOT_MATCH_D,
  HOURS_APPORTIONMENT,
  METRIC_KEYS,
  METRIC_LABELS,
  REVIEW_MINUTES_PER_ROW,
  SERVICE_REFERENCE_SOURCES,
  activitySchema,
  buildSpeedReport,
  computeBlitzyHours,
  expandBraces,
  inventoryCounts,
  languageCode,
  measuredMetric,
  missingMetrics,
  packageSlug,
  rateMetric,
  renderSpeedMarkdown,
  reviewHours,
  spanHours,
  unavailableMetric,
  vitestResultPath,
} from '../../src/reporting/speed.js';
import type { Activity, Metric, ServiceMeasurements, SpeedInputs, SpeedReport } from '../../src/reporting/speed.js';

type SpeedModule = typeof import('../../src/reporting/speed.js');
type PathsModule = typeof import('../../src/lib/paths.js');
type CliModule = typeof import('../../src/lib/cli.js');

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixtureText = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const ACTIVITY_FILE = 'reporting/blitzy-activity.sample.json';
const CLOC_FILE = 'reporting/cloc.sample.json';
const COVERAGE_FILE = 'reporting/coverage-summary.sample.json';
const VITEST_FILE = 'reporting/vitest-results.sample.json';
const TRACEABILITY_FILE = 'reporting/traceability-identity.md.txt';
const INVENTORY_FILE = 'inventory/mini-inventory.json';

const SHA = pinnedSha();
const AT = '2026-06-30T05:00:00.000Z';
const ACTIVITY: Activity = activitySchema.parse(JSON.parse(fixtureText(ACTIVITY_FILE)));
const CLOC_STDOUT = fixtureText(CLOC_FILE);
const TRACEABILITY = fixtureText(TRACEABILITY_FILE);
const MINI_JSON = JSON.parse(fixtureText(INVENTORY_FILE)) as Record<string, unknown[] | undefined>;
const MINI_INVENTORY: Inventory = inventorySchema.parse(MINI_JSON);
const miniList = (key: string): unknown[] => MINI_JSON[key] ?? [];

// Figures hand-computed from the fixtures.
const SAMPLE_CFML = 95_807 + 51_044;
const SAMPLE_SQL = 4_504;
const SAMPLE_TS = 1_840;
const SAMPLE_COVERAGE = 92;
const SAMPLE_TESTS = 14;
const IDENTITY_ROWS = 3;
const RUN_TOTAL_HOURS = 12;
const RUN_TOTAL_SOURCE = 'runTotal 2026-06-01T08:00:00Z to 2026-06-01T20:00:00Z';
const MEASURED_HOURS: Readonly<Partial<Record<ServiceName, number>>> = { identity: 2.5, 'programs-sites': 1 };

const TS_LINES: Readonly<Record<ServiceName, number>> = {
  identity: 200,
  people: 100,
  'programs-sites': 300,
  'strategies-content': 600,
};
const TS_TOTAL = 1_200;
// 12 h × lines / 1,200 lines.
const ESTIMATED_HOURS: Readonly<Partial<Record<ServiceName, number>>> = {
  people: 1,
  'strategies-content': 6,
};

const INPUTS: SpeedInputs = {
  activity: { path: ACTIVITY_PATH, present: true },
  cloc: { path: 'opt2/inventory/cloc.json', present: true, sourceSha: SHA, matchesPin: true },
  inventory: { path: 'opt2/inventory/legacy-inventory.json', present: true },
  vitest: { path: '${OPT2_STATE_DIR}/test-all/vitest', present: true },
};

const AUGMENTED_INVENTORY: Inventory = inventorySchema.parse({
  ...MINI_JSON,
  entities: [
    ...miniList('entities'),
    { id: 'ent:userRedirectBean', owningService: 'identity', class: 'orm-entity' },
    { id: 'ent:userDeviceBean', owningService: 'identity', class: 'orm-entity' },
    { id: 'ent:formBuilderManager', owningService: 'identity', class: 'not-entity' },
  ],
  tables: [
    ...miniList('tables'),
    { id: 'tbl:tsettings', table: 'tsettings', owningService: 'programs-sites', origin: 'bootstrap' },
  ],
  controllers: [...miniList('controllers'), { id: 'ctl:cperm', actions: [{ id: 'ctl:cperm.main', owningService: 'identity' }] }],
  frontEnd: [...miniList('frontEnd'), { id: 'fe:oauth.token', owningService: 'identity' }],
  scheduledJobs: [
    ...miniList('scheduledJobs'),
    {
      id: 'job:sitemonitor-content',
      owningService: 'strategies-content',
      steps: [{ id: 'job:sitemonitor.publish-scheduled-changesets', owningService: 'strategies-content' }],
    },
  ],
});

interface RunnerCall {
  file: string;
  args: readonly string[];
  cwd: string;
}

interface FakeRunner {
  run: ProcessRunner;
  calls: RunnerCall[];
}

/** Every pin REFERENCE path of the services, created as an empty file or directory under `target`. */
async function writePinTree(target: string): Promise<void> {
  const entries = [...new Set(SERVICES.flatMap((service) => SERVICE_REFERENCE_SOURCES[service].pin))];
  for (const entry of entries) {
    const full = path.join(target, entry);
    if (entry.endsWith('/')) {
      await mkdir(full, { recursive: true });
    } else {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, '<cfcomponent></cfcomponent>\n', 'utf8');
    }
  }
}

/**
 * Recording runner: `cloc` prints the sample JSON, `git archive` succeeds, `tar -xf … -C <dir>` writes the pin tree
 * into `<dir>`; `git log` and anything else reject.
 */
function fakeRunner(opts: { clocFails?: boolean } = {}): FakeRunner {
  const calls: RunnerCall[] = [];
  const run: ProcessRunner = async (file, args, { cwd }) => {
    calls.push({ file, args: [...args], cwd });
    if (file === 'git' && args.includes('log')) throw new Error(`commit timestamps are never read: git ${args.join(' ')}`);
    if (file === 'cloc') {
      if (opts.clocFails === true) throw new Error(`cloc crashed in ${cwd}`);
      return { stdout: CLOC_STDOUT, stderr: '' };
    }
    if (file === 'git' && args[0] === 'archive') return { stdout: '', stderr: '' };
    const target = args[args.indexOf('-C') + 1];
    if (file === 'tar' && args[0] === '-xf' && target !== undefined) {
      await writePinTree(target);
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
  return { run, calls };
}

const logCalls = (calls: readonly RunnerCall[]): RunnerCall[] => calls.filter((call) => call.args.includes('log'));

function tsMetrics(lines: Readonly<Partial<Record<ServiceName, number>>> = TS_LINES): Partial<Record<ServiceName, Metric>> {
  return Object.fromEntries(
    SERVICES.flatMap((service) => {
      const value = lines[service];
      return value === undefined ? [] : [[service, measuredMetric(value, `cloc TypeScript code lines in services/${service}/src/`)]];
    }),
  );
}

function sampleMeasurements(service: ServiceName, cfml: number, sql: number, inventory: Inventory): ServiceMeasurements {
  const module = FIXTURE_MODULE[service];
  return {
    service,
    cfmlLines: measuredMetric(cfml, `cloc ${CFML_LANGUAGES.join(' + ')} code lines`),
    fixtureSqlLines:
      module === undefined
        ? unavailableMetric('no fixture SQL: the service has no legacy fixture module')
        : measuredMetric(sql, `cloc SQL code lines in legacy-fixtures/sql/${module}/`),
    ...inventoryCounts(service, inventory),
    typescriptLines: measuredMetric(TS_LINES[service], `cloc TypeScript code lines in services/${service}/src/`),
    tests: measuredMetric(SAMPLE_TESTS, 'numTotalTests of vitest JSON'),
    coverage: measuredMetric(SAMPLE_COVERAGE, 'total.statements.pct'),
    traceabilityRows:
      service === 'identity'
        ? measuredMetric(traceabilityRowCount(TRACEABILITY), 'data rows of services/identity/TRACEABILITY.md')
        : unavailableMetric(`services/${service}/TRACEABILITY.md absent`),
  };
}

function rowOf(report: Pick<SpeedReport, 'services'>, service: ServiceName): SpeedReport['services'][number] {
  const row = report.services.find((candidate) => candidate.service === service);
  if (row === undefined) throw new Error(`no row for ${service}`);
  return row;
}

async function put(root: string, rel: string, text: string): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

const mtimeOrNull = (file: string): number | null => (existsSync(file) ? statSync(file).mtimeMs : null);

let work: string;
let env: { OPT2_STATE_DIR: string; OPT2_REPORTS_DIR: string };

beforeEach(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'opt2-speed-'));
  env = { OPT2_STATE_DIR: path.join(work, 'state'), OPT2_REPORTS_DIR: path.join(work, 'reports') };
  await mkdir(env.OPT2_STATE_DIR, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
});

it('keeps the state and reports directories outside the checkout', () => {
  expect(isInsideRepo(env.OPT2_STATE_DIR)).toBe(false);
  expect(isInsideRepo(env.OPT2_REPORTS_DIR)).toBe(false);
});

describe('computeBlitzyHours', () => {
  it('measures hours from recorded per-service bounds', () => {
    const hours = computeBlitzyHours(ACTIVITY, tsMetrics());
    expect(hours.identity).toEqual({
      value: 2.5,
      label: 'measured',
      basis: `services.identity end − start in ${ACTIVITY_PATH} (2026-06-01T09:00:00Z to 2026-06-01T11:30:00Z)`,
    });
    expect(hours['programs-sites']).toMatchObject({ value: 1, label: 'measured' });
  });

  it('labels apportioned hours estimated with a TypeScript-line basis', () => {
    const hours = computeBlitzyHours(ACTIVITY, tsMetrics());
    for (const [service, value] of Object.entries(ESTIMATED_HOURS) as [ServiceName, number][]) {
      expect(hours[service]).toEqual({
        value,
        label: 'estimated',
        basis:
          `run total apportioned by share of output TypeScript lines: ${RUN_TOTAL_HOURS} h (${RUN_TOTAL_SOURCE}) × ` +
          `${TS_LINES[service]} / ${TS_TOTAL} lines`,
      });
    }
    expect(Object.keys(ESTIMATED_HOURS).length + Object.keys(MEASURED_HOURS).length).toBe(SERVICES.length);
  });

  it('apportions the run total over all services by TypeScript-line share', () => {
    const hours = computeBlitzyHours(ACTIVITY, tsMetrics());
    const estimated = SERVICES.filter((service) => hours[service].label === 'estimated');
    const estimatedSum = estimated.reduce((sum, service) => sum + (hours[service].value ?? 0), 0);
    const estimatedLines = estimated.reduce((sum, service) => sum + TS_LINES[service], 0);
    expect(estimatedSum).toBeCloseTo((RUN_TOTAL_HOURS * estimatedLines) / TS_TOTAL, 9);
    expect(estimatedSum).toBeCloseTo(7, 9);
  });

  it('falls back to the sum of measured spans when runTotal has no bounds', () => {
    const hours = computeBlitzyHours(activitySchema.parse({ ...ACTIVITY, runTotal: null }), tsMetrics());
    expect(hours.people).toMatchObject({ value: 0.29, label: 'estimated' });
    expect(hours['strategies-content']).toMatchObject({ value: 1.75, label: 'estimated' });
    expect(hours.people.basis).toContain('3.5 h (sum of measured service spans) × 100 / 1200 lines');
    expect(hours.identity).toMatchObject({ value: 2.5, label: 'measured' });
  });

  it.each([
    ['the activity file is absent', null, 'absent or unreadable'],
    ['no runTotal and no service bounds', { runTotal: { start: null, end: null }, services: {} }, 'no recorded hours'],
    ['every end precedes its start', { runTotal: { start: '2026-06-01T20:00:00Z', end: '2026-06-01T08:00:00Z' } }, 'no recorded hours'],
    ['bounds that are not timestamps', { runTotal: { start: 'monday', end: 'friday' }, services: { identity: { start: 'x', end: 'y' } } }, 'no recorded hours'],
  ])('leaves every service unavailable when %s', (_case, raw, reason) => {
    const activity = raw === null ? null : activitySchema.parse(raw);
    const hours = computeBlitzyHours(activity, tsMetrics());
    for (const service of SERVICES) {
      expect(hours[service]).toMatchObject({ value: null, label: 'unavailable' });
      expect(hours[service].basis).toContain(reason);
      expect(hours[service].basis).toContain('rates not computed');
    }
  });

  it('cannot apportion without every service’s TypeScript lines or with a zero total', () => {
    const { people: _people, ...withoutPeople } = TS_LINES;
    const incomplete = computeBlitzyHours(ACTIVITY, tsMetrics(withoutPeople));
    expect(incomplete.people).toMatchObject({ value: null, label: 'unavailable' });
    expect(incomplete.people.basis).toContain('output TypeScript lines are unavailable');
    expect(incomplete['strategies-content'].basis).toContain('output TypeScript total is incomplete');
    expect(incomplete.identity).toMatchObject({ value: 2.5, label: 'measured' });

    const zero = computeBlitzyHours(ACTIVITY, tsMetrics(Object.fromEntries(SERVICES.map((s) => [s, 0]))));
    expect(zero['strategies-content']).toMatchObject({ value: null, label: 'unavailable' });
    expect(zero['strategies-content'].basis).toContain('output TypeScript total is zero');
  });

  it('never bases hours on commit timestamps', () => {
    const hours = computeBlitzyHours(ACTIVITY, tsMetrics());
    for (const service of SERVICES) expect(hours[service].basis).not.toMatch(/commit/i);
  });
});

describe('spanHours', () => {
  it.each([
    [{ start: '2026-06-01T09:00:00Z', end: '2026-06-01T11:30:00Z' }, 2.5],
    [{ start: '2026-06-01T09:00:00Z', end: '2026-06-01T09:00:00Z' }, 0],
    [null, null],
    [{ start: null, end: '2026-06-01T11:30:00Z' }, null],
    [{ start: '2026-06-01T11:30:00Z', end: '2026-06-01T09:00:00Z' }, null],
    [{ start: 'not a time', end: '2026-06-01T09:00:00Z' }, null],
  ])('spans %j as %s hours', (bounds, hours) => {
    expect(spanHours(bounds)?.hours ?? null).toBe(hours);
  });
});

describe('speed report helpers', () => {
  it('maps only people to a fixture module', () => {
    expect(FIXTURE_MODULE).toEqual({ people: 'people' });
    const withModule = SERVICES.filter((service) => FIXTURE_MODULE[service] !== undefined);
    expect(withModule).toEqual(['people']);
  });

  it('lists expanded pin paths for every service', () => {
    for (const service of SERVICES) {
      const { pin, fixture } = SERVICE_REFERENCE_SOURCES[service];
      expect([...pin, ...fixture].some((entry) => entry.includes('{'))).toBe(false);
      expect(pin.length).toBeGreaterThan(0);
    }
    expect(SERVICE_REFERENCE_SOURCES.identity.pin).toEqual(
      expect.arrayContaining(['admin/core/controllers/clogin.cfc', 'admin/core/views/cmessage/', 'core/mura/client/api/oauth/']),
    );
    expect(SERVICE_REFERENCE_SOURCES.people.fixture).toEqual(['legacy-fixtures/cfml/modules/people.cfc']);
  });

  it.each([
    ['a/{b,c}/{d,e}.cfc', ['a/b/d.cfc', 'a/b/e.cfc', 'a/c/d.cfc', 'a/c/e.cfc']],
    ['core/mura/permission.cfc', ['core/mura/permission.cfc']],
  ])('expands %s', (pattern, expected) => {
    expect(expandBraces(pattern)).toEqual(expected);
  });

  it.each([
    ['services/people', 'services-people'],
    ['services\\strategies-content', 'services-strategies-content'],
    ['/harness/', 'harness'],
    ['legacy-fixtures//seed', 'legacy-fixtures-seed'],
  ])('slugs %s as %s', (pkg, slug) => {
    expect(packageSlug(pkg)).toBe(slug);
  });

  it('places vitest results under ${OPT2_STATE_DIR}/test-all/vitest by package slug', () => {
    const base = path.join(env.OPT2_STATE_DIR, 'test-all', 'vitest');
    const people = vitestResultPath('services/people', env);
    expect(people.startsWith(base)).toBe(true);
    expect(people.endsWith('.json')).toBe(true);
    expect(people).toBe(path.join(base, `${packageSlug('services/people')}.json`));
    expect(vitestResultPath('services/identity', env)).not.toBe(people);
    expect(vitestResultPath('services/people', env, path.join(work, 'vitest'))).toBe(path.join(work, 'vitest', 'services-people.json'));
  });

  it('reads OPT2_STATE_DIR from process.env by default and refuses one inside the checkout', () => {
    vi.stubEnv('OPT2_STATE_DIR', env.OPT2_STATE_DIR);
    expect(vitestResultPath('services/people')).toBe(path.join(env.OPT2_STATE_DIR, 'test-all', 'vitest', 'services-people.json'));
    expect(() => vitestResultPath('services/people', { OPT2_STATE_DIR: path.join(REPO_ROOT, 'state') })).toThrow(
      /must be outside the repository checkout/,
    );
  });

  it.each([
    // identity endpoints: ctl:clogin.login (variant owner) and fe:doaction=login.
    ['identity', 0, 2],
    ['people', 0, 2],
    ['programs-sites', 0, 0],
    ['strategies-content', 0, 1],
  ] as const)('counts %s entities and endpoints owned in the mini inventory', (service, entities, endpoints) => {
    const counts = inventoryCounts(service, MINI_INVENTORY);
    expect(counts.entities).toMatchObject({ value: entities, label: 'measured' });
    expect(counts.endpoints).toMatchObject({ value: endpoints, label: 'measured' });
  });

  it.each([
    // identity endpoints: the mini inventory's two plus ctl:cperm.main and fe:oauth.token.
    ['identity', 2, 4, 'class other than not-entity'],
    ['programs-sites', 0, 0, 'class other than not-entity'],
    ['strategies-content', 0, 2, 'class other than not-entity'],
  ] as const)('counts %s from owned entities, actions, front-end entries and job steps', (service, entities, endpoints, basis) => {
    const counts = inventoryCounts(service, AUGMENTED_INVENTORY);
    expect(counts.entities).toMatchObject({ value: entities, label: 'measured' });
    expect(counts.entities.basis).toContain(basis);
    expect(counts.endpoints).toMatchObject({ value: endpoints, label: 'measured' });
  });

  it('states review hours as rows × minutes per row / 60', () => {
    expect(REVIEW_MINUTES_PER_ROW).toBe(5);
    expect(reviewHours(measuredMetric(12, 'rows'), 10)).toEqual({
      value: 2,
      label: 'estimated',
      basis: '12 traceability rows × 10 min per row / 60 (rows)',
    });
    expect(reviewHours(unavailableMetric('absent'))).toEqual({
      value: null,
      label: 'unavailable',
      basis: 'traceability rows unavailable: absent',
    });
  });

  it.each([
    ['measured hours', measuredMetric(3, 'h'), measuredMetric(1500, 'cloc'), { value: 2, label: 'derived' }],
    ['estimated hours', { value: 3, label: 'estimated', basis: 'share' } as Metric, measuredMetric(1500, 'cloc'), { value: 2, label: 'estimated' }],
    ['unavailable hours', unavailableMetric('none'), measuredMetric(1500, 'cloc'), { value: null, label: 'unavailable', basis: 'Blitzy hours unavailable; rate not computed' }],
    ['an unavailable denominator', measuredMetric(3, 'h'), unavailableMetric('none'), { value: null, label: 'unavailable', basis: 'CFML lines unavailable; rate not computed' }],
    ['a zero denominator', measuredMetric(3, 'h'), measuredMetric(0, 'cloc'), { value: null, label: 'unavailable', basis: 'zero CFML lines; rate not computed' }],
  ])('rates hours per 1,000 CFML lines from %s', (_case, hours, denominator, expected) => {
    expect(rateMetric(hours, denominator, 1000, 'CFML lines')).toMatchObject(expected);
  });
});


describe('buildSpeedReport', () => {
  let cloc: Awaited<ReturnType<typeof runCloc>>;
  let calls: RunnerCall[];

  beforeEach(async () => {
    const fake = fakeRunner();
    calls = fake.calls;
    cloc = await runCloc(work, { runner: fake.run });
  });

  const build = (
    activity: Activity | null = ACTIVITY,
    services: readonly ServiceName[] = SERVICES,
    inventory: Inventory = AUGMENTED_INVENTORY,
  ): SpeedReport =>
    buildSpeedReport({
      sha: SHA,
      generatedAt: AT,
      activity,
      inputs: INPUTS,
      services: services.map((service) =>
        sampleMeasurements(service, languageCode(cloc, CFML_LANGUAGES), languageCode(cloc, ['SQL']), inventory),
      ),
    });

  it('counts CFML as ColdFusion plus CFScript code only, with SQL apart', () => {
    expect(languageCode(cloc, CFML_LANGUAGES)).toBe(SAMPLE_CFML);
    expect(languageCode(cloc, ['SQL'])).toBe(SAMPLE_SQL);
    expect(languageCode(cloc, ['TypeScript'])).toBe(SAMPLE_TS);
    expect(languageCode(cloc, CFML_LANGUAGES)).not.toBe(SAMPLE_CFML + SAMPLE_SQL);
    expect(calls).toEqual([{ file: 'cloc', args: ['--json', '--fullpath', '--quiet', '.'], cwd: work }]);
  });

  it('builds one row per service in SERVICES order with every metric labelled', () => {
    const report = build();
    expect(report).toMatchObject({
      sourceSha: SHA,
      generatedBy: GENERATED_BY,
      generatedAt: AT,
      status: 'generated',
      inputs: INPUTS,
      bases: { reviewMinutesPerRow: REVIEW_MINUTES_PER_ROW, hoursApportionment: HOURS_APPORTIONMENT },
      labels: [...METRIC_LABELS],
    });
    expect(report.services.map((row) => row.service)).toEqual([...SERVICES]);
    for (const row of report.services) {
      expect(row).toMatchObject({
        folder: `services/${row.service}`,
        fixtureModule: FIXTURE_MODULE[row.service] ?? null,
      });
      for (const key of METRIC_KEYS) expect(METRIC_LABELS).toContain(row[key].label);
    }
    expect(missingMetrics(report)).toEqual([]);
  });

  it('estimates review hours from traceability rows × minutes per row', () => {
    expect(traceabilityRowCount(TRACEABILITY)).toBe(IDENTITY_ROWS);
    const report = build();
    expect(rowOf(report, 'identity').humanReviewHours).toEqual({
      value: (IDENTITY_ROWS * REVIEW_MINUTES_PER_ROW) / 60,
      label: 'estimated',
      basis: `${IDENTITY_ROWS} traceability rows × ${REVIEW_MINUTES_PER_ROW} min per row / 60 (data rows of services/identity/TRACEABILITY.md)`,
    });
    expect(rowOf(report, 'people').humanReviewHours).toMatchObject({ value: null, label: 'unavailable' });
  });

  it('keeps fixture SQL lines measured in their own field', () => {
    const report = build();
    const people = rowOf(report, 'people');
    expect(people.cfmlLines).toMatchObject({ value: SAMPLE_CFML, label: 'measured' });
    expect(people.fixtureSqlLines).toMatchObject({ value: SAMPLE_SQL, label: 'measured' });
    expect(people.fixtureSqlLines.basis).toContain('legacy-fixtures/sql/people/');
    expect(rowOf(report, 'identity').fixtureSqlLines).toMatchObject({ value: null, label: 'unavailable' });
  });

  it('carries owned entities, endpoints, TypeScript lines, tests and coverage as measured', () => {
    const report = build();
    expect(rowOf(report, 'identity')).toMatchObject({
      entities: { value: 2, label: 'measured' },
      endpoints: { value: 4, label: 'measured' },
      typescriptLines: { value: TS_LINES.identity, label: 'measured' },
    });
    expect(rowOf(report, 'people')).toMatchObject({
      tests: { value: SAMPLE_TESTS, label: 'measured' },
      coverage: { value: SAMPLE_COVERAGE, label: 'measured' },
    });
  });

  it('derives rates from measured hours and estimates them from estimated hours', () => {
    const report = build();
    const identity = rowOf(report, 'identity');
    expect(identity.blitzyElapsedHours).toMatchObject({ value: 2.5, label: 'measured' });
    expect(identity.hoursPer1000CfmlLines).toEqual({
      value: 0.02,
      label: 'derived',
      basis: `2.5 h (measured) / (${SAMPLE_CFML} CFML lines / 1000)`,
    });
    expect(identity.hoursPer1000CfmlLines.value).toBeCloseTo(2.5 / (SAMPLE_CFML / 1000), 2);
    expect(identity.hoursPerEntity).toMatchObject({ value: 1.25, label: 'derived' });
    expect(rowOf(report, 'people').hoursPer1000CfmlLines).toMatchObject({ value: 0.01, label: 'estimated' });
    expect(rowOf(report, 'people').hoursPerEntity).toEqual({
      value: null,
      label: 'unavailable',
      basis: 'zero entities; rate not computed',
    });
  });

  it('computes no rates without recorded hours', () => {
    for (const row of build(null).services) {
      expect(row.blitzyElapsedHours).toMatchObject({ value: null, label: 'unavailable' });
      for (const rate of [row.hoursPer1000CfmlLines, row.hoursPerEntity]) {
        expect(rate).toEqual({ value: null, label: 'unavailable', basis: 'Blitzy hours unavailable; rate not computed' });
      }
    }
  });

  it('fills services missing from the input as not measured', () => {
    const report = build(ACTIVITY, ['identity']);
    expect(report.services.map((row) => row.service)).toEqual([...SERVICES]);
    expect(rowOf(report, 'identity').blitzyElapsedHours).toMatchObject({ value: 2.5, label: 'measured' });
    expect(rowOf(report, 'people').cfmlLines).toEqual({ value: null, label: 'unavailable', basis: 'not measured' });
    expect(rowOf(report, 'people').blitzyElapsedHours).toMatchObject({ value: null, label: 'unavailable' });
    expect(missingMetrics(report)).toEqual([]);
  });

  it('names every absent or malformed metric', () => {
    expect(missingMetrics({ services: [] })).toHaveLength(SERVICES.length * METRIC_KEYS.length);
    const report = build();
    const broken = {
      services: report.services.map((row) =>
        row.service === 'strategies-content'
          ? { ...row, coverage: { value: null, label: 'measured' as const, basis: 'x' }, tests: { value: 3, label: 'measured' as const, basis: '' } }
          : row,
      ),
    };
    expect(missingMetrics(broken)).toEqual(['strategies-content.tests', 'strategies-content.coverage']);
  });
});

describe('renderSpeedMarkdown', () => {
  const report = (inputs: SpeedInputs = INPUTS): SpeedReport =>
    buildSpeedReport({
      sha: SHA,
      generatedAt: AT,
      activity: ACTIVITY,
      inputs,
      services: SERVICES.map((service) => sampleMeasurements(service, SAMPLE_CFML, SAMPLE_SQL, AUGMENTED_INVENTORY)),
    });

  it('renders a legend naming all four labels and one metrics row per service', () => {
    const lines = renderSpeedMarkdown(report());
    for (const label of METRIC_LABELS) expect(lines.some((line) => line.startsWith(`- ${label}: `))).toBe(true);
    const metrics = lines.slice(lines.indexOf('## Metrics'), lines.indexOf('## Basis of each metric'));
    const rows = metrics.filter((line) => SERVICES.some((service) => line.startsWith(`| ${service} |`)));
    expect(rows.map((line) => line.split(' | ')[0])).toEqual(SERVICES.map((service) => `| ${service}`));
    expect(rows).toContain(
      '| identity | 2.5 (measured) | 0.25 (estimated) | 146,851 (measured) | — (unavailable) | 2 (measured) | ' +
        '4 (measured) | 200 (measured) | 14 (measured) | 92% (measured) | 0.02 (derived) | 1.25 (derived) |',
    );
    expect(lines).toContain('| Commit timestamps | never used |');
    expect(lines).toContain(`| cloc | \`opt2/inventory/cloc.json\` | yes | sourceSha ${SHA}; matches the pin: true |`);
    expect(lines).toContain('### identity');
    expect(lines.some((line) => line.startsWith('- Blitzy hours (measured): services.identity end − start'))).toBe(true);
  });

  it('escapes pipes and line breaks in input notes', () => {
    const lines = renderSpeedMarkdown(
      report({ ...INPUTS, activity: { path: ACTIVITY_PATH, present: true, error: 'bad | json\nat line 2' } }),
    );
    expect(lines).toContain(`| activity | \`${ACTIVITY_PATH}\` | yes | bad \\| json at line 2 |`);
  });
});


describe('main and collectSpeedInputs over a temp checkout', () => {
  const FIXTURE_MODULES = SERVICES.flatMap((service) => {
    const module = FIXTURE_MODULE[service];
    return module === undefined ? [] : [module];
  });
  let root: string;
  let speed: SpeedModule;
  let cli: CliModule;

  beforeEach(async () => {
    root = path.join(work, 'repo');
    await mkdir(root, { recursive: true });
    vi.resetModules();
    vi.doMock('../../src/lib/paths.js', async (importOriginal) => {
      const actual = await importOriginal<PathsModule>();
      const repoPath = (...segments: string[]): string => path.resolve(root, ...segments);
      return {
        ...actual,
        REPO_ROOT: root,
        HARNESS_ROOT: path.join(root, 'harness'),
        repoPath,
        opt2Path: (...segments: string[]): string => repoPath('opt2', ...segments),
      };
    });
    speed = await import('../../src/reporting/speed.js');
    cli = await import('../../src/lib/cli.js');
  });

  afterEach(() => {
    vi.doUnmock('../../src/lib/paths.js');
    vi.resetModules();
  });

  interface TreeOptions {
    activity?: string | null;
    clocSha?: string | null;
    inventory?: boolean;
    sources?: boolean;
    vitest?: string | null;
    coverage?: string;
  }

  async function buildTree(opts: TreeOptions = {}): Promise<void> {
    await put(root, 'opt2/source-pin.json', readFileSync(path.join(REPO_ROOT, 'opt2', 'source-pin.json'), 'utf8'));
    if (opts.activity !== null) await put(root, ACTIVITY_PATH, opts.activity ?? fixtureText(ACTIVITY_FILE));
    if (opts.clocSha !== null) await put(root, 'opt2/inventory/cloc.json', JSON.stringify({ sourceSha: opts.clocSha ?? SHA }));
    if (opts.inventory !== false) await put(root, 'opt2/inventory/legacy-inventory.json', fixtureText(INVENTORY_FILE));
    if (opts.sources !== false) {
      for (const service of SERVICES) await put(root, `services/${service}/src/main.ts`, 'export {};\n');
      for (const module of FIXTURE_MODULES) {
        await put(root, `legacy-fixtures/sql/${module}/100_${module}.sql`, `-- SYNTHETIC: ${module}\n`);
        await put(root, `legacy-fixtures/cfml/modules/${module}.cfc`, `// SYNTHETIC: ${module}\n`);
      }
      await put(root, 'services/identity/TRACEABILITY.md', TRACEABILITY);
    }
    await put(root, 'services/people/coverage/coverage-summary.json', opts.coverage ?? fixtureText(COVERAGE_FILE));
    if (opts.vitest !== null) {
      await put(env.OPT2_STATE_DIR, 'test-all/vitest/services-people.json', opts.vitest ?? fixtureText(VITEST_FILE));
    }
  }

  const extractVia =
    (fake: FakeRunner) =>
    (sha: string, scratch: string): Promise<string> =>
      gitArchiveExtract(sha, path.join(scratch, 'tree'), { run: fake.run });

  const measurementsOf = (services: readonly ServiceMeasurements[], service: ServiceName): ServiceMeasurements => {
    const found = services.find((m) => m.service === service);
    if (found === undefined) throw new Error(`no measurements for ${service}`);
    return found;
  };

  it('writes speed.json and speed.md only to the temp reports dir', async () => {
    await buildTree();
    const fake = fakeRunner();
    const realReport = path.join(REPO_ROOT, 'opt2', 'reports', 'speed.json');
    const before = mtimeOrNull(realReport);
    const out: string[] = [];
    const exits: number[] = [];
    const code = await cli.runCli(
      (argv) => speed.main(argv, { env, runner: fake.run, extract: extractVia(fake), clock: () => new Date(AT) }),
      { argv: [], stdout: { write: (chunk: string) => out.push(chunk) }, exit: (n) => exits.push(n), command: 'speed' },
    );

    expect(code).toBe(0);
    expect(exits).toEqual([0]);
    const summary = JSON.parse(out.join('')) as { ok: boolean; written: boolean; missing: string[]; labels: Record<string, number> };
    expect(summary).toMatchObject({ ok: true, written: true, missing: [] });
    expect(Object.values(summary.labels).reduce((sum, n) => sum + n, 0)).toBe(SERVICES.length * METRIC_KEYS.length);

    expect((await readdir(env.OPT2_REPORTS_DIR)).sort()).toEqual(['speed.json', 'speed.md']);
    expect(existsSync(path.join(root, 'opt2', 'reports'))).toBe(false);
    expect(mtimeOrNull(realReport)).toBe(before);

    const report = JSON.parse(await readFile(path.join(env.OPT2_REPORTS_DIR, 'speed.json'), 'utf8')) as SpeedReport;
    expect(report.sourceSha).toBe(pinnedSha());
    expect(report.generatedAt).toBe(AT);
    expect(report.services.map((row) => row.service)).toEqual([...SERVICES]);
    expect(report.inputs).toMatchObject({
      activity: { path: ACTIVITY_PATH, present: true },
      cloc: { present: true, sourceSha: SHA, matchesPin: true, extractedFrom: `git archive ${SHA}` },
      inventory: { present: true },
      vitest: { path: '${OPT2_STATE_DIR}/test-all/vitest', present: true },
    });

    const identity = rowOf(report, 'identity');
    expect(identity).toMatchObject({
      blitzyElapsedHours: { value: 2.5, label: 'measured' },
      humanReviewHours: { value: 0.25, label: 'estimated' },
      cfmlLines: { value: SAMPLE_CFML, label: 'measured' },
      fixtureSqlLines: { value: null, label: 'unavailable' },
      entities: { value: 0, label: 'measured' },
      endpoints: { value: 2, label: 'measured' },
      typescriptLines: { value: SAMPLE_TS, label: 'measured' },
      hoursPer1000CfmlLines: { value: 0.02, label: 'derived' },
      hoursPerEntity: { value: null, label: 'unavailable' },
    });
    expect(identity.cfmlLines.basis).toContain(`REFERENCE paths in git archive ${SHA}`);
    expect(identity.typescriptLines.basis).toContain('excluding src/generated/');

    const people = rowOf(report, 'people');
    expect(people).toMatchObject({
      blitzyElapsedHours: { value: 3, label: 'estimated' },
      cfmlLines: { value: 2 * SAMPLE_CFML, label: 'measured' },
      fixtureSqlLines: { value: SAMPLE_SQL, label: 'measured' },
      endpoints: { value: 2, label: 'measured' },
      tests: { value: SAMPLE_TESTS, label: 'measured' },
      coverage: { value: SAMPLE_COVERAGE, label: 'measured' },
    });
    expect(people.tests.basis).toContain('13 passed, 1 failed, 0 skipped or todo');
    expect(people.coverage.basis).toContain('(184/200 statements)');
    expect(rowOf(report, 'programs-sites').blitzyElapsedHours).toMatchObject({ value: 1, label: 'measured' });
    expect(rowOf(report, 'strategies-content').tests).toMatchObject({ value: null, label: 'unavailable' });

    const md = (await readFile(path.join(env.OPT2_REPORTS_DIR, 'speed.md'), 'utf8')).split('\n');
    expect(md.slice(0, 2)).toEqual(['# Speed report', `Source SHA: ${pinnedSha()}`]);
    for (const service of SERVICES) expect(md.filter((line) => line.startsWith(`| ${service} |`))).toHaveLength(1);

    expect(logCalls(fake.calls)).toEqual([]);
    const archive = fake.calls.find((call) => call.file === 'git' && call.args[0] === 'archive');
    expect(archive?.args.at(-1)).toBe(SHA);
    const tarCall = fake.calls.find((call) => call.file === 'tar');
    const extraction = tarCall?.args[3] ?? '';
    expect(isInsideRepo(extraction)).toBe(false);
    expect(existsSync(path.dirname(extraction))).toBe(false);
    expect(fake.calls).toContainEqual({
      file: 'cloc',
      args: ['--json', '--fullpath', '--quiet', `--not-match-d=${GENERATED_NOT_MATCH_D}`, '.'],
      cwd: path.join(root, 'services', 'identity', 'src'),
    });
    const pinCalls = fake.calls.filter((call) => call.file === 'cloc' && call.cwd === extraction);
    expect(pinCalls).toHaveLength(SERVICES.length);
    expect(pinCalls.every((call) => call.args.at(-1)?.startsWith('--list-file='))).toBe(true);
  });

  it('refuses pin CFML when opt2/inventory/cloc.json names another commit', async () => {
    const other = 'f'.repeat(40);
    await buildTree({ clocSha: other });
    const fake = fakeRunner();
    const extract = vi.fn(extractVia(fake));
    const collected = await speed.collectSpeedInputs({ pin: readPin(), env, runner: fake.run, extract });
    expect(extract).not.toHaveBeenCalled();
    expect(collected.inputs.cloc).toMatchObject({ present: true, sourceSha: other, matchesPin: false });
    for (const service of SERVICES) {
      expect(measurementsOf(collected.services, service).cfmlLines).toEqual(
        unavailableMetric(`opt2/inventory/cloc.json sourceSha ${other} differs from the pin ${SHA}`),
      );
    }
    expect(logCalls(fake.calls)).toEqual([]);
  });

  it.each([
    [
      'a failed extraction',
      async (_sha: string, scratch: string): Promise<string> => {
        throw new Error(`cannot extract into ${scratch}`);
      },
      'pin extraction failed: cannot extract into <scratch>',
    ],
    [
      'an extraction without the REFERENCE paths',
      async (_sha: string, scratch: string): Promise<string> => {
        const dir = path.join(scratch, 'empty');
        await mkdir(dir);
        return dir;
      },
      'REFERENCE paths absent at the pin: admin/core/controllers/clogin.cfc',
    ],
  ])('leaves pin CFML unavailable after %s', async (_case, extract, basis) => {
    await buildTree();
    const fake = fakeRunner();
    const collected = await speed.collectSpeedInputs({ pin: readPin(), env, runner: fake.run, extract });
    const identity = measurementsOf(collected.services, 'identity').cfmlLines;
    expect(identity).toMatchObject({ value: null, label: 'unavailable' });
    expect(identity.basis.startsWith(basis)).toBe(true);
    expect(identity.basis).not.toContain(work);
  });

  it('records absent and unreadable inputs as unavailable without machine paths', async () => {
    await buildTree({
      activity: '{not json',
      clocSha: null,
      inventory: false,
      sources: false,
      vitest: '{"numTotalTests": -1}',
      coverage: '{"total": {}}',
    });
    const fake = fakeRunner();
    const collected = await speed.collectSpeedInputs({ pin: readPin(), env, runner: fake.run, extract: extractVia(fake) });
    expect(collected.activity).toBeNull();
    expect(collected.inputs.activity.error).toMatch(/^opt2\/speed\/blitzy-activity\.json: is not valid JSON/);
    expect(collected.inputs.activity.error).not.toContain(root);
    expect(collected.inputs.inventory).toEqual({ path: 'opt2/inventory/legacy-inventory.json', present: false });
    expect(collected.inputs.cloc).toMatchObject({ present: false, sourceSha: null, matchesPin: false });

    const identity = measurementsOf(collected.services, 'identity');
    expect(identity.cfmlLines).toMatchObject({ value: SAMPLE_CFML, label: 'measured' });
    expect(identity.entities).toEqual(unavailableMetric('opt2/inventory/legacy-inventory.json absent'));
    expect(identity.fixtureSqlLines).toEqual(unavailableMetric('no fixture SQL: the service has no legacy fixture module'));
    expect(identity.typescriptLines).toEqual(unavailableMetric('services/identity/src/ absent'));
    expect(identity.traceabilityRows).toEqual(unavailableMetric('services/identity/TRACEABILITY.md absent'));
    expect(identity.coverage.basis).toContain('services/identity/coverage/coverage-summary.json absent');
    expect(identity.tests.basis).toContain('absent; harness/repro/test-all.sh stage 3 writes it');

    const people = measurementsOf(collected.services, 'people');
    expect(people.cfmlLines).toEqual(unavailableMetric('fixture CFML absent: legacy-fixtures/cfml/modules/people.cfc'));
    expect(people.fixtureSqlLines).toEqual(unavailableMetric('no fixture SQL: legacy-fixtures/sql/people/ absent'));
    expect(people.tests).toMatchObject({ value: null, label: 'unavailable' });
    expect(people.tests.basis).toContain('${OPT2_STATE_DIR}/test-all/vitest/services-people.json unreadable');
    expect(people.tests.basis).not.toContain(env.OPT2_STATE_DIR);
    expect(people.coverage.basis).toContain('services/people/coverage/coverage-summary.json unreadable');

    const report = buildSpeedReport({ ...collected, generatedAt: AT });
    expect(rowOf(report, 'identity').blitzyElapsedHours.basis).toContain('absent or unreadable');
    expect(missingMetrics(report)).toEqual([]);
  });

  it('reports cloc failures per metric with paths replaced', async () => {
    await buildTree();
    const fake = fakeRunner({ clocFails: true });
    const collected = await speed.collectSpeedInputs({ pin: readPin(), env, runner: fake.run, extract: extractVia(fake) });
    expect(measurementsOf(collected.services, 'identity').cfmlLines).toEqual(
      unavailableMetric('cloc failed: cloc crashed in <pin extraction>'),
    );
    expect(measurementsOf(collected.services, 'identity').typescriptLines).toEqual(
      unavailableMetric('cloc failed in services/identity/src/: cloc crashed in services/identity/src'),
    );
    expect(measurementsOf(collected.services, 'people').fixtureSqlLines).toEqual(
      unavailableMetric('cloc failed in legacy-fixtures/sql/people/: cloc crashed in legacy-fixtures/sql/people'),
    );
  });

  it('reads vitest results from --vitest-dir and writes nothing with --no-write', async () => {
    await buildTree({ vitest: null });
    const dir = path.join(work, 'vitest-out');
    await put(dir, 'services-people.json', fixtureText(VITEST_FILE));
    const fake = fakeRunner();

    const collected = await speed.collectSpeedInputs({ pin: readPin(), env, runner: fake.run, extract: extractVia(fake), vitestDir: dir });
    expect(collected.inputs.vitest).toMatchObject({ path: dir, present: true });
    expect(measurementsOf(collected.services, 'people').tests).toMatchObject({ value: SAMPLE_TESTS, label: 'measured' });
    expect(measurementsOf(collected.services, 'people').tests.basis).toContain(`${dir}/services-people.json`);

    const outcome = await speed.main(['--no-write', '--vitest-dir', dir], { env, runner: fake.run, extract: extractVia(fake) });
    expect(outcome).toMatchObject({ code: 0, summary: { written: false, missing: [] } });
    expect(existsSync(env.OPT2_REPORTS_DIR)).toBe(false);
    expect(logCalls(fake.calls)).toEqual([]);
  });

  it.each([
    [['--vitest-dir', ''], 2, '"type":"UsageError"'],
    [['--unknown'], 2, '"type":"UsageError"'],
    [['--help'], 0, 'speed [--vitest-dir <dir>] [--no-write] [--help]'],
  ])('answers %j with exit %i', async (argv, expected, text) => {
    const out: string[] = [];
    const exits: number[] = [];
    const code = await cli.runCli((args) => speed.main(args, { env }), {
      argv,
      stdout: { write: (chunk: string) => out.push(chunk) },
      exit: (n) => exits.push(n),
      command: 'speed',
    });
    expect(code).toBe(expected);
    expect(exits).toEqual([expected]);
    expect(out.join('')).toContain(text);
    expect(existsSync(env.OPT2_REPORTS_DIR)).toBe(false);
  });
});

