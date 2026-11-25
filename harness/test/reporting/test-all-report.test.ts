import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_UNAVAILABLE, readFixtureStatus } from '../../src/golden/catalogue.js';
import { runCli } from '../../src/lib/cli.js';
import { isInsideRepo, opt2Path } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';
import { SERVICES, type ServiceName } from '../../src/reporting/check-reviewability.js';
import { vitestResultPath } from '../../src/reporting/speed.js';
import {
  BASELINE_UNMET_ITEM,
  CLOUD_PATHS_UNTESTED,
  FIXTURE_UNMET_ITEMS,
  MATRIX_COLUMNS,
  STAGE_NAMES,
  buildServiceMatrix,
  buildTestAllReport,
  deriveExitCode,
  eventsInputSchema,
  isolationInputSchema,
  main,
  parityInputSchema,
  readTestAllInputs,
  renderTestAllMarkdown,
  resolveStages,
  securityInputSchema,
  stageRecordPath,
  stageRecordSchema,
  vitestInputSchema,
} from '../../src/reporting/test-all.js';
import type {
  FixtureReport,
  MatrixInputs,
  ParityInput,
  ServiceMatrixRow,
  Source,
  StageRecord,
  StageResult,
  TestAllInputs,
  VitestInput,
} from '../../src/reporting/test-all.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/reporting/', import.meta.url));
const UNAVAILABLE_FIXTURE = path.join(FIXTURE_DIR, 'fixtures-unavailable.json');
const VITEST_SAMPLE = path.join(FIXTURE_DIR, 'vitest-results.sample.json');
const UNAVAILABLE_REASON = (JSON.parse(readFileSync(UNAVAILABLE_FIXTURE, 'utf8')) as { reason: string }).reason;

const AT = '2026-06-30T05:00:00.000Z';
const STAGES = STAGE_NAMES.map((_, n) => n);
const CATEGORIES = MATRIX_COLUMNS.filter((column) => column !== 'parity');
const AVAILABLE: FixtureReport = { available: true, reason: null };
const EVIDENCE: TestAllInputs['evidence'] = {
  fixtures: '${OPT2_STATE_DIR}/fixtures.json',
  rollback: 'opt2/reports/rollback-rehearsal.md',
  baseline: 'opt2/reports/baseline.json',
};
const WITHHELD_REF = 'opt2/decision-list.json#actionVariants/admin:cusers.update{type=2,action=delete}';
const SCENARIO: Readonly<Record<ServiceName, string>> = {
  identity: 'GS-ID-01',
  people: 'GS-PE-01',
  'programs-sites': 'GS-PS-72',
  'strategies-content': 'GS-CO-75',
};
const SCHEMA: Partial<Record<ServiceName, string>> = {
  'programs-sites': 'programs_sites',
  'strategies-content': 'content',
};

type ScenarioResult = 'pass' | 'fail' | 'withheld' | typeof FIXTURES_UNAVAILABLE;
const FIXTURES_OFF: Partial<Record<ServiceName, ScenarioResult>> = { people: FIXTURES_UNAVAILABLE };

function stageFixture(n: number): string {
  return path.join(FIXTURE_DIR, 'stage-records', `stage-${n}.json`);
}

function loadStage(n: number): StageRecord {
  return stageRecordSchema.parse(JSON.parse(readFileSync(stageFixture(n), 'utf8')));
}

/** The ten committed stage records, a fixtures-unavailable run. */
function loadStages(): StageRecord[] {
  return STAGES.map(loadStage);
}

/** The committed records with every result `pass` and no unmet items or reasons. */
function allPass(): StageRecord[] {
  return loadStages().map((record) => {
    const passed: StageRecord = { ...record, result: 'pass' };
    delete passed.unmet;
    delete passed.reason;
    return passed;
  });
}

function withResult(stages: readonly StageRecord[], n: number, result: StageResult): StageRecord[] {
  return stages.map((record) => (record.stage === n ? { ...record, result } : record));
}

/** A `parity.json` body in the shape golden/compare.ts writes; services not in `results` pass. */
function parityBody(results: Partial<Record<ServiceName, ScenarioResult>> = {}) {
  const scenarios = SERVICES.map((service) => {
    const id = SCENARIO[service];
    const result = results[service] ?? 'pass';
    return {
      id,
      service,
      result,
      reason: result === FIXTURES_UNAVAILABLE ? 'legacy fixtures unavailable' : null,
      differences: [],
      exceptionId: null,
      decisionListRef: result === 'withheld' ? [WITHHELD_REF] : null,
      evidence: { golden: `harness/golden/sets/${id}.json`, replay: `\${OPT2_STATE_DIR}/golden/replay/${id}.json` },
    };
  });
  const count = (result: ScenarioResult) => scenarios.filter((scenario) => scenario.result === result).length;
  return {
    generatedBy: 'harness/src/golden/compare.ts',
    generatedAt: AT,
    status: 'complete',
    summary: {
      total: scenarios.length,
      pass: count('pass'),
      fail: count('fail'),
      excepted: 0,
      halted: 0,
      knownIssue: 0,
      withheld: count('withheld'),
      skipped: count(FIXTURES_UNAVAILABLE),
    },
    scenarios,
    unmetWithheld: scenarios
      .filter((scenario) => scenario.result === 'withheld')
      .map((scenario) => ({ id: scenario.id, decisionListRef: WITHHELD_REF, proposal: 'People owns the delete' })),
  };
}

/** A clean `isolation.json` body in the shape isolation/report.ts writes. */
function isolationBody() {
  return {
    generatedBy: 'harness/src/isolation/report.ts',
    generatedAt: AT,
    status: 'generated',
    services: SERVICES.map((service) => ({
      service,
      schema: SCHEMA[service] ?? service,
      crossTenantReads: 0,
      crossTenantWrites: 0,
      pooledConnectionReuse: { rowsSeen: 0, writeBlocked: true },
      rlsCatalog: { tables: 3, enabled: 3, forced: 3, usingAndWithCheck: 3 },
      source: `\${OPT2_STATE_DIR}/test-all/vitest/services-${service}.json`,
      result: 'pass',
    })),
    consumers: [],
    roles: { rolbypassrls: [], rolsuper: [], membershipViolations: [] },
    result: 'pass',
  };
}

/** A passing `events.json` body in the shape events/report.ts writes. */
function eventsBody() {
  return {
    generatedBy: 'harness/src/events/report.ts',
    generatedAt: AT,
    status: 'generated',
    topics: [
      { topic: 'people.person.archived.v1', producer: 'people', consumers: [] },
      { topic: 'programs-sites.site.changed.v1', producer: 'programs-sites', consumers: ['identity'] },
    ],
    result: 'pass',
  };
}

const SECURITY_BODY = { verdict: 'clean', exitCode: 0 };

/** vitest JSON reporter output of `service` with one passing file per matrix category. */
function vitestBody(service: ServiceName) {
  return {
    success: true,
    testResults: CATEGORIES.map((category) => ({
      name: `/workspace/opt2/services/${service}/test/${category}/${category}.test.ts`,
      status: 'passed',
      assertionResults: [{ status: 'passed' }, { status: 'passed' }],
    })),
  };
}

function parity(results: Partial<Record<ServiceName, ScenarioResult>> = {}): Source<ParityInput> {
  return { path: 'opt2/reports/parity.json', data: parityInputSchema.parse(parityBody(results)) };
}

type Sources = Omit<MatrixInputs, 'packages'>;

/** Every matrix source present and passing, with `over` replacing whole sources. */
function matrixSources(over: Partial<Sources> = {}): Sources {
  const vitest = Object.fromEntries(
    SERVICES.map((service) => [
      service,
      { path: `\${OPT2_STATE_DIR}/test-all/vitest/services-${service}.json`, data: vitestInputSchema.parse(vitestBody(service)) },
    ]),
  ) as Record<ServiceName, Source<VitestInput>>;
  return {
    parity: parity(),
    vitest,
    isolation: { path: 'opt2/reports/isolation.json', data: isolationInputSchema.parse(isolationBody()) },
    events: { path: 'opt2/reports/events.json', data: eventsInputSchema.parse(eventsBody()) },
    security: { path: '${OPT2_STATE_DIR}/security/summary.json', data: securityInputSchema.parse(SECURITY_BODY) },
    ...over,
  };
}

function reportInputs(records: readonly StageRecord[], fixtures: FixtureReport, over: Partial<Sources> = {}): TestAllInputs {
  return { ...matrixSources(over), records, fixtures, generatedAt: AT, evidence: EVIDENCE };
}

function row(matrix: readonly ServiceMatrixRow[], service: ServiceName): ServiceMatrixRow {
  const found = matrix.find((entry) => entry.service === service);
  if (found === undefined) throw new Error(`no matrix row for ${service}`);
  return found;
}

/** Arguments of the `record` subcommand that write `record` back. */
function recordArgv(record: StageRecord): string[] {
  return [
    'record',
    ...['--stage', String(record.stage), '--result', record.result],
    ...['--started-at', record.startedAt, '--finished-at', record.finishedAt],
    ...(record.exitCode === undefined ? [] : ['--exit-code', String(record.exitCode)]),
    ...record.evidence.flatMap((evidence) => ['--evidence', evidence]),
    ...(record.reason === undefined ? [] : ['--reason', record.reason]),
    ...(record.unmet ?? []).flatMap(({ item, reason }) => ['--unmet', `${item}=${reason}`]),
    ...(record.packages ?? []).flatMap((entry) => ['--package', `${entry.package}=${entry.exitCode}`]),
  ];
}

let stateDirectory: string;
let reportsDirectory: string;
let env: { OPT2_STATE_DIR: string; OPT2_REPORTS_DIR: string };

beforeEach(async () => {
  stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'opt2-test-all-'));
  reportsDirectory = await mkdtemp(path.join(os.tmpdir(), 'opt2-test-all-'));
  expect(isInsideRepo(stateDirectory)).toBe(false);
  expect(isInsideRepo(reportsDirectory)).toBe(false);
  env = { OPT2_STATE_DIR: stateDirectory, OPT2_REPORTS_DIR: reportsDirectory };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(reportsDirectory, { recursive: true, force: true });
});

/** The fixture status of `fixtures-unavailable.json` installed as `${OPT2_STATE_DIR}/fixtures.json`. */
async function unavailableFixtures(): Promise<FixtureReport> {
  await copyFile(UNAVAILABLE_FIXTURE, path.join(stateDirectory, 'fixtures.json'));
  const { available, reason } = readFixtureStatus(env);
  return { available, reason };
}

/** Runs the CLI as `npm run report:test-all` does, with the temp directories in `process.env`. */
async function cli(argv: string[]): Promise<{ code: number; summary: Record<string, unknown>; exit: ReturnType<typeof vi.fn> }> {
  vi.stubEnv('OPT2_STATE_DIR', env.OPT2_STATE_DIR);
  vi.stubEnv('OPT2_REPORTS_DIR', env.OPT2_REPORTS_DIR);
  let out = '';
  const exit = vi.fn();
  const stdout = {
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  };
  const code = await runCli(main, { argv, stdout, exit, command: 'harness/src/reporting/test-all.ts' });
  return { code, summary: JSON.parse(out) as Record<string, unknown>, exit };
}

describe('committed stage records', () => {
  it.each(STAGES)('stage-%i.json is a valid record named after its stage', (n) => {
    const record = loadStage(n);
    expect(record.stage).toBe(n);
    expect(record.name).toBe(STAGE_NAMES[n]);
  });

  it('model a fixtures-unavailable run with a timing-variance baseline and an unmet rollback', () => {
    const stages = loadStages();
    expect(stages.map((record) => record.result)).toEqual([
      'pass',
      'timing-variance',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'unmet',
      'pass',
    ]);
    for (const n of [3, 7]) {
      expect(stages[n]?.unmet?.every((item) => item.reason === FIXTURES_UNAVAILABLE)).toBe(true);
    }
  });

  it.each<[string, (record: StageRecord) => unknown]>([
    ['an unknown result', (record) => ({ ...record, result: 'green' })],
    [
      'a missing stage number',
      (record) => {
        const copy: Partial<StageRecord> = { ...record };
        delete copy.stage;
        return copy;
      },
    ],
    ['a stage number above 9', (record) => ({ ...record, stage: STAGE_NAMES.length })],
  ])('rejects a record with %s', (_, mutate) => {
    expect(stageRecordSchema.safeParse(mutate(loadStage(5))).success).toBe(false);
  });

  it.each([0, 3, 9])('places the record of stage %i in the test-all folder of the state directory', (n) => {
    expect(stageRecordPath(n, env)).toBe(path.join(env.OPT2_STATE_DIR, 'test-all', `stage-${n}.json`));
  });
});

describe('deriveExitCode', () => {
  const stopped = (stages: StageRecord[], failed: number) =>
    STAGES.filter((n) => n > failed).reduce((acc, n) => withResult(acc, n, 'not-run'), withResult(stages, failed, 'fail'));

  it.each<[string, () => Promise<TestAllInputs> | TestAllInputs, 0 | 1 | 2]>([
    ['0 when every stage and cell passes and nothing is unmet', () => reportInputs(allPass(), AVAILABLE), 0],
    [
      '2 for the committed run with fixtures unavailable',
      async () => reportInputs(loadStages(), await unavailableFixtures(), { parity: parity(FIXTURES_OFF) }),
      2,
    ],
    [
      '2 when a withheld people scenario leaves its parity cell unmet',
      () => reportInputs(allPass(), AVAILABLE, { parity: parity({ people: 'withheld' }) }),
      2,
    ],
    [
      '1 when a stage of the committed run fails alongside unmet items',
      async () => reportInputs(withResult(loadStages(), 4, 'fail'), await unavailableFixtures(), { parity: parity(FIXTURES_OFF) }),
      1,
    ],
    ['1 when a stage fails and nothing is unmet', () => reportInputs(withResult(allPass(), 6, 'fail'), AVAILABLE), 1],
    ['1 when the stages after a failure are recorded not-run', () => reportInputs(stopped(allPass(), 6), AVAILABLE), 1],
    [
      '1 when a stage-3 package exited non-zero and left its cells without vitest results',
      () => {
        const records = allPass().map((record) =>
          record.stage === 3
            ? { ...record, packages: (record.packages ?? []).map((entry) => (entry.package === 'services/people' ? { ...entry, exitCode: 1 } : entry)) }
            : record,
        );
        const sources = matrixSources();
        return reportInputs(records, AVAILABLE, { vitest: { ...sources.vitest, people: { path: 'vitest/people.json', data: null } } });
      },
      1,
    ],
  ])('returns %s', async (_, build, code) => {
    const report = buildTestAllReport(await build());
    expect(deriveExitCode(report.stages, report.serviceMatrix, report.unmet)).toBe(code);
    expect(report.exitCode).toBe(code);
  });

  it('returns 2 for a timing-variance baseline, listing the baseline item after its own item', () => {
    const records = allPass().map((record) => (record.stage === 1 ? loadStage(1) : record));
    const report = buildTestAllReport(reportInputs(records, AVAILABLE));
    expect(report.stages[1]?.result).toBe('timing-variance');
    expect(deriveExitCode(report.stages, report.serviceMatrix, report.unmet)).toBe(2);
    expect(report.unmet).toEqual([
      { item: 'baseline:beanFeedSecurity.repeated-sanitization', reason: expect.any(String), evidence: ['opt2/reports/baseline.json'] },
      { item: BASELINE_UNMET_ITEM, reason: expect.stringContaining('timing-variance'), evidence: ['opt2/reports/baseline.json'] },
    ]);
  });
});

describe('buildServiceMatrix', () => {
  it('has one row per service with the parity, contract, isolation, events and security columns', () => {
    const matrix = buildServiceMatrix({ ...matrixSources(), packages: [] });
    expect(matrix.map((entry) => entry.service)).toEqual([...SERVICES]);
    for (const entry of matrix) {
      expect(Object.keys(entry)).toEqual(['service', 'parity', 'contract', 'isolation', 'events', 'security']);
      for (const column of MATRIX_COLUMNS) expect(entry[column].state).toBe('pass');
    }
  });

  it('marks the people parity cell unmet, naming the withheld scenario and its decision-list entry', () => {
    const matrix = buildServiceMatrix({ ...matrixSources({ parity: parity({ people: 'withheld' }) }), packages: [] });
    expect(row(matrix, 'people').parity).toEqual({ state: 'unmet', reason: `withheld: GS-PE-01 (${WITHHELD_REF})` });
    expect(row(matrix, 'identity').parity.state).toBe('pass');
  });

  it('marks the parity cell of the fixture-dependent service unmet when the fixtures are unavailable', () => {
    const matrix = buildServiceMatrix({ ...matrixSources({ parity: parity(FIXTURES_OFF) }), packages: [] });
    expect(row(matrix, 'people').parity).toEqual({ state: 'unmet', reason: `${FIXTURES_UNAVAILABLE}: ${SCENARIO.people}` });
    for (const service of SERVICES.filter((name) => name !== 'people')) {
      expect(row(matrix, service).parity).toEqual({ state: 'pass', reason: '1 scenarios: 1 pass' });
    }
  });

  it('reads every cell as pending-run when the state and reports directories hold no evidence', async () => {
    const matrix = buildServiceMatrix({ ...(await readTestAllInputs(env, AT)), packages: [] });
    for (const entry of matrix) {
      for (const column of MATRIX_COLUMNS) {
        expect(entry[column]).toEqual({ state: 'pending-run', reason: expect.stringContaining('absent') });
      }
    }
  });

  it('reads parity, isolation and events reports written without entries as pending-run', () => {
    const matrix = buildServiceMatrix({
      ...matrixSources({
        parity: { path: 'p.json', data: parityInputSchema.parse({ status: 'complete' }) },
        isolation: { path: 'i.json', data: isolationInputSchema.parse({ status: 'generated' }) },
        events: { path: 'e.json', data: eventsInputSchema.parse({ status: 'generated' }) },
      }),
      packages: [],
    });
    expect(row(matrix, 'people')).toMatchObject({
      parity: { state: 'pending-run', reason: 'no parity scenarios for people in p.json' },
      isolation: { state: 'pending-run', reason: 'no people entry in i.json' },
      events: { state: 'pending-run', reason: 'e.json result unset' },
    });
  });

  it('fails the people events cell for the failed assertion of the vitest sample', () => {
    const sample = vitestInputSchema.parse(JSON.parse(readFileSync(VITEST_SAMPLE, 'utf8')));
    const sources = matrixSources();
    const vitest = { ...sources.vitest, people: { path: 'vitest-results.sample.json', data: sample } };
    const matrix = buildServiceMatrix({ ...sources, vitest, packages: [] });
    const people = row(matrix, 'people');
    expect(people.events).toEqual({ state: 'fail', reason: '1 of 1 events files failed: test/events/archive-events.test.ts' });
    expect(people.isolation.state).toBe('pass');
    expect(people.contract).toEqual({ state: 'unmet', reason: 'no contract suites' });
    expect(row(matrix, 'identity').events.state).toBe('pass');
    expect(deriveExitCode(resolveStages(allPass()), matrix, [])).toBe(1);
  });

  it('lists the suites missing from the vitest sample as unmet items citing its results file', () => {
    const sources = matrixSources();
    const sample = vitestInputSchema.parse(JSON.parse(readFileSync(VITEST_SAMPLE, 'utf8')));
    const vitest = { ...sources.vitest, people: { path: 'vitest-results.sample.json', data: sample } };
    const report = buildTestAllReport(reportInputs(allPass(), AVAILABLE, { vitest }));
    expect(report.exitCode).toBe(1);
    expect(report.unmet).toEqual([
      { item: 'Done: services: people contract', reason: 'unmet: no contract suites', evidence: ['vitest-results.sample.json'] },
      {
        item: 'Done: services: people security',
        reason: 'unmet: no security suites',
        evidence: ['vitest-results.sample.json', '${OPT2_STATE_DIR}/security/summary.json'],
      },
    ]);
  });
});

describe('buildTestAllReport and renderTestAllMarkdown', () => {
  async function committedReport() {
    return buildTestAllReport(reportInputs(loadStages(), await unavailableFixtures(), { parity: parity(FIXTURES_OFF) }));
  }

  it('reports the committed run as exit code 2 with the fixture-dependent parity unmet', async () => {
    const report = await committedReport();
    expect(report).toMatchObject({ exitCode: 2, result: 'unmet', fixtures: { available: false, reason: UNAVAILABLE_REASON } });
    expect(report.stages.map((stage) => stage.result)).toEqual(loadStages().map((record) => record.result));
    const own = (n: number) => (loadStage(n).unmet ?? []).map((entry) => entry.item);
    expect(report.unmet.map((entry) => entry.item)).toEqual([
      ...own(1),
      BASELINE_UNMET_ITEM,
      ...own(3),
      ...own(7),
      ...own(8),
      'Done: services: people parity',
      'all services pass parity',
      FIXTURE_UNMET_ITEMS[1],
    ]);
    const parityItem = report.unmet.find((entry) => entry.item === 'all services pass parity');
    expect(parityItem?.reason).toMatch(/fixture-dependent/i);
    expect(parityItem?.reason).toContain(UNAVAILABLE_REASON);
    expect(report.unmet.find((entry) => entry.item === 'rollback:archive')).toEqual({
      item: 'rollback:archive',
      reason: 'fixtures unavailable',
      evidence: ['opt2/reports/rollback-rehearsal.md'],
    });
    expect(CLOUD_PATHS_UNTESTED.length).toBeGreaterThan(0);
    for (const cloudPath of CLOUD_PATHS_UNTESTED) expect(report.cloudPathsUntested).toContain(cloudPath);
  });

  it('renders the exit code, the fixture sentence, the matrix, the unmet items and the untested cloud paths', async () => {
    const report = await committedReport();
    const lines = renderTestAllMarkdown(report);
    expect(lines).toContain('Exit code: 2 (unmet: completed with acceptance items unmet)');
    expect(lines.some((line) => /fixture-dependent/i.test(line))).toBe(true);
    for (const service of SERVICES) expect(lines.some((line) => line.startsWith(`| ${service} | `))).toBe(true);
    for (const entry of report.unmet) expect(lines.some((line) => line.startsWith(`- **${entry.item}**: `))).toBe(true);
    const cloud = lines.slice(lines.indexOf('## Cloud paths')).join('\n');
    for (const cloudPath of CLOUD_PATHS_UNTESTED) expect(cloud).toContain(cloudPath);
  });
});

describe('main', () => {
  it.each(STAGES)('record writes the committed stage-%i.json from its flags and exits 0', async (n) => {
    const committed = await readFile(stageFixture(n), 'utf8');
    const { code, summary, exit } = await cli(recordArgv(loadStage(n)));
    expect(code).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(summary).toMatchObject({ ok: true, code: 0, stage: n, path: `\${OPT2_STATE_DIR}/test-all/stage-${n}.json` });
    const written = await readFile(stageRecordPath(n, env), 'utf8');
    expect(stageRecordSchema.safeParse(JSON.parse(written)).success).toBe(true);
    expect(written).toBe(committed);
  });

  it('assembles the committed run into exit code 2, writing only to the temp reports directory', async () => {
    await mkdir(path.join(stateDirectory, 'test-all'), { recursive: true });
    await Promise.all(STAGES.map((n) => copyFile(stageFixture(n), stageRecordPath(n, env))));
    await copyFile(UNAVAILABLE_FIXTURE, path.join(stateDirectory, 'fixtures.json'));
    await mkdir(path.join(stateDirectory, 'security'), { recursive: true });
    await writeFile(path.join(stateDirectory, 'security', 'summary.json'), JSON.stringify(SECURITY_BODY));
    for (const service of SERVICES) {
      const file = vitestResultPath(`services/${service}`, env);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(vitestBody(service)));
    }
    await writeFile(path.join(reportsDirectory, 'parity.json'), JSON.stringify(parityBody(FIXTURES_OFF)));
    await writeFile(path.join(reportsDirectory, 'isolation.json'), JSON.stringify(isolationBody()));
    await writeFile(path.join(reportsDirectory, 'events.json'), JSON.stringify(eventsBody()));
    const checkout = opt2Path('reports');
    const snapshot = async () =>
      Promise.all((await readdir(checkout)).sort().map(async (name) => [name, (await stat(path.join(checkout, name))).mtimeMs]));
    const before = await snapshot();

    const { code, summary, exit } = await cli(['--exit-code']);

    expect(code).toBe(2);
    expect(exit).toHaveBeenCalledWith(2);
    const jsonFile = path.join(reportsDirectory, 'test-all.json');
    const mdFile = path.join(reportsDirectory, 'test-all.md');
    expect(summary).toMatchObject({ code: 2, exitCode: 2, result: 'unmet', failingStages: [], written: true, json: jsonFile, md: mdFile });
    const json = JSON.parse(await readFile(jsonFile, 'utf8')) as {
      sourceSha: string;
      exitCode: number;
      fixtures: unknown;
      serviceMatrix: ServiceMatrixRow[];
      unmet: { item: string }[];
    };
    expect(json.sourceSha).toBe(pinnedSha());
    expect(json.exitCode).toBe(2);
    expect(json.fixtures).toEqual({ available: false, reason: UNAVAILABLE_REASON, source: '${OPT2_STATE_DIR}/fixtures.json' });
    expect(json.serviceMatrix.filter((entry) => entry.parity.state === 'unmet').map((entry) => entry.service)).toEqual(['people']);
    expect(json.unmet.map((entry) => entry.item)).toEqual(expect.arrayContaining([...FIXTURE_UNMET_ITEMS, 'rollback:archive']));
    const md = (await readFile(mdFile, 'utf8')).split('\n');
    expect(md.slice(0, 2)).toEqual(['# Test-all report', `Source SHA: ${pinnedSha()}`]);
    expect(md.some((line) => /fixture-dependent/i.test(line))).toBe(true);
    expect((await readdir(reportsDirectory)).sort()).toEqual(['events.json', 'isolation.json', 'parity.json', 'test-all.json', 'test-all.md']);
    expect(await snapshot()).toEqual(before);
  });
});
