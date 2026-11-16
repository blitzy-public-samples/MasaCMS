import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  EXIT_CODES,
  EXPECTED_BASELINE_PATH,
  MASA_BASELINE_PATH,
  REPORT_TITLE,
  buildBaselineReport,
  compareBaseline,
  diffBaseline,
  flattenTestBox,
  groupId,
  isTimingOnly,
  main,
  renderBaselineMarkdown,
  type BaselineReport,
  type CompareDeps,
  type Difference,
  type ExpectedBaseline,
  type ExpectedFailureGroup,
  type FlatSpec,
  type ObservedBaseline,
} from '../../src/baseline/compare.js';
import { DIAGNOSTIC_RUNNER_PATH, lowerKeysDeep, type SavedRunnerResponse } from '../../src/baseline/run.js';
import { runCli } from '../../src/lib/cli.js';
import { repoPath, type EnvLike } from '../../src/lib/paths.js';
import { stableStringify } from '../../src/lib/report.js';

interface SpecNode {
  name: string;
  status: string;
  failMessage?: string;
}
interface SuiteNode {
  name: string;
  specStats: SpecNode[];
  suiteStats: SuiteNode[];
}
interface BundleNode {
  name: string;
  path: string;
  globalException: unknown;
  suiteStats: SuiteNode[];
}
interface TestBoxBody {
  totalSpecs: number;
  bundleStats: BundleNode[];
}

type DiagnosticFixture = 'match' | 'timing-only' | 'mismatch';
type RunDiagnostic = NonNullable<CompareDeps['runDiagnostic']>;

async function loadJson<T>(rel: string): Promise<T> {
  return JSON.parse(await fs.readFile(new URL(rel, import.meta.url), 'utf8')) as T;
}

const OFFICIAL_500 = await loadJson<SavedRunnerResponse>('../fixtures/testbox/official-500.json');
const BODIES: Record<DiagnosticFixture, TestBoxBody> = {
  match: await loadJson<TestBoxBody>('../fixtures/testbox/diagnostic-match.json'),
  'timing-only': await loadJson<TestBoxBody>('../fixtures/testbox/diagnostic-timing-only.json'),
  mismatch: await loadJson<TestBoxBody>('../fixtures/testbox/diagnostic-mismatch.json'),
};
const EXPECTED = await loadJson<ExpectedBaseline>('../../legacy-baseline/expected-baseline.json');
const COMMITTED_REPORT = await loadJson<Record<string, Record<string, unknown>>>('../../../opt2/reports/baseline.json');
const PIN_SHA = (await loadJson<{ sha: string }>('../../../opt2/source-pin.json')).sha;

const COMMAND = 'harness/src/baseline/compare.ts';
const USAGE = 'usage: npm run baseline:compare (takes no flags)';
const GENERATED_AT = '2026-06-30T01:00:00.000Z';
const DIAGNOSTIC_STARTED = '2026-06-30T00:01:00.000Z';
const RERUN_STARTED = '2026-06-30T00:40:00.000Z';
const ENTITY_SUITE = 'Testing Entity Schema Creation and Persistence';
const ENTITIES_PATTERN = '^.+ should match schema datatype (VARCHAR|FLOAT)$';
const TIMING_TITLE = 'should handle repeated sanitization efficiently';
const UTILITY_TITLE = 'should reject an alttheme traversal path outside the webroot';

function failureGroup(bundle: string): ExpectedFailureGroup {
  const found = EXPECTED.failures.find((group) => group.bundle === bundle);
  if (found === undefined) throw new Error(`expected-baseline.json has no ${bundle} failure group`);
  return found;
}

const ENTITIES_ID = groupId(failureGroup('entities'));
const TIMING_ID = groupId(failureGroup('beanFeedSecurity'));
const UTILITY_ID = groupId(failureGroup('utility'));

const TIMING_DIFFERENCES: Difference[] = [
  { kind: 'totals', field: 'passed', expected: 662, observed: 663 },
  { kind: 'totals', field: 'failed', expected: 21, observed: 20 },
  {
    kind: 'expected-failure-not-observed',
    group: TIMING_ID,
    bundle: 'beanFeedSecurity',
    spec: TIMING_TITLE,
    timingSensitive: true,
    expected: 1,
    observed: 0,
    actual: [{ fullName: `Bean Feed Security - Base Feed Class > ${TIMING_TITLE}`, status: 'Passed' }],
  },
];

const CONTENT_FAILURE: Difference = {
  kind: 'unexpected-failure',
  bundle: 'content',
  spec: 'spec 016',
  fullName: 'Testing persistence > spec 016',
  status: 'Failed',
  failMessage: 'Expected [false] to be true',
  group: null,
};

const MISMATCH_DIFFERENCES: Difference[] = [
  { kind: 'totals', field: 'passed', expected: 662, observed: 661 },
  { kind: 'totals', field: 'failed', expected: 21, observed: 22 },
  CONTENT_FAILURE,
];

/** Wraps a raw TestBox body the way `run.ts` saves the diagnostic response. */
function diagnosticResponse(body: TestBoxBody, startedAt = DIAGNOSTIC_STARTED): SavedRunnerResponse {
  return {
    runner: 'diagnostic',
    url: `http://127.0.0.1:8500${DIAGNOSTIC_RUNNER_PATH}`,
    httpStatus: 200,
    contentType: 'application/json;charset=UTF-8',
    startedAt,
    durationMs: 1878,
    bodyKind: 'json',
    specs: body.totalSpecs,
    body: structuredClone(body),
  };
}

function findSuite(suites: readonly SuiteNode[], name: string): SuiteNode | undefined {
  for (const suite of suites) {
    const found = suite.name === name ? suite : findSuite(suite.suiteStats, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

function sortedKeys(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

async function probe(file: string): Promise<{ exists: boolean; mtimeMs: number | null }> {
  try {
    return { exists: true, mtimeMs: (await fs.stat(file)).mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, mtimeMs: null };
    throw err;
  }
}

async function exists(file: string): Promise<boolean> {
  return (await probe(file)).exists;
}

function reportWith(differences: Difference[]): BaselineReport {
  return buildBaselineReport({
    expected: EXPECTED,
    expectedPath: repoPath(EXPECTED_BASELINE_PATH),
    masaBaselinePath: '/elsewhere/masa-baseline.json',
    official: OFFICIAL_500,
    observed: flattenTestBox(BODIES.match),
    differences,
    rerun: null,
    result: differences.length === 0 ? 'match' : 'mismatch',
    generatedAt: new Date(GENERATED_AT),
  });
}

let realMasaBaseline: Awaited<ReturnType<typeof probe>>;
let tmp: string;
let stateDir: string;
let reportsDir: string;
let masaPath: string;
let env: EnvLike;

beforeAll(async () => {
  realMasaBaseline = await probe(MASA_BASELINE_PATH);
});

afterAll(async () => {
  expect(await probe(MASA_BASELINE_PATH)).toEqual(realMasaBaseline);
});

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-baseline-compare-'));
  stateDir = path.join(tmp, 'state');
  reportsDir = path.join(tmp, 'reports');
  masaPath = path.join(tmp, 'masa', 'masa-baseline.json');
  await fs.mkdir(path.join(stateDir, 'baseline'), { recursive: true });
  env = { OPT2_STATE_DIR: stateDir, OPT2_REPORTS_DIR: reportsDir };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function stage(official: SavedRunnerResponse, diagnostic: SavedRunnerResponse): Promise<void> {
  await fs.writeFile(path.join(stateDir, 'baseline', 'official.json'), stableStringify(official), 'utf8');
  await fs.writeFile(path.join(stateDir, 'baseline', 'diagnostic.json'), stableStringify(diagnostic), 'utf8');
}

/** Stages matching runner responses, then overwrites one saved response with `value` as JSON. */
async function stageSaved(file: 'official.json' | 'diagnostic.json', value: unknown): Promise<Partial<CompareDeps>> {
  await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));
  await fs.writeFile(path.join(stateDir, 'baseline', file), JSON.stringify(value), 'utf8');
  return {};
}

/** Stages matching runner responses and an expected baseline holding `value` as JSON. */
async function stageExpected(value: unknown): Promise<Partial<CompareDeps>> {
  await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));
  const expectedPath = path.join(tmp, 'expected-baseline.json');
  await fs.writeFile(expectedPath, JSON.stringify(value), 'utf8');
  return { expectedPath };
}

/** Fake re-run that saves `diagnostic-rerun.json` and resolves with the saved response, as the real runner does. */
function fakeRunDiagnostic(body: TestBoxBody = BODIES.match): Mock<RunDiagnostic> {
  return vi.fn<RunDiagnostic>(async () => {
    const saved = diagnosticResponse(body, RERUN_STARTED);
    await fs.writeFile(path.join(stateDir, 'baseline', 'diagnostic-rerun.json'), stableStringify(saved), 'utf8');
    return saved;
  });
}

function deps(runDiagnostic: RunDiagnostic, overrides: Partial<CompareDeps> = {}): CompareDeps {
  return { env, masaBaselinePath: masaPath, runDiagnostic, now: () => new Date(GENERATED_AT), ...overrides };
}

describe('constants', () => {
  it('copies the report to the setup-mandated path outside the repository', () => {
    expect(MASA_BASELINE_PATH).toBe('/tmp/masa-baseline.json');
  });

  it('maps each result to its exit code', () => {
    expect(EXIT_CODES).toEqual({ match: 0, 'timing-variance': 3, mismatch: 1 });
  });
});

describe('expected-baseline.json', () => {
  it('declares 22 unique bundles, three failure groups totalling 21 and the official runner abort', () => {
    expect(EXPECTED.sourceSha).toBe(PIN_SHA);
    expect(EXPECTED.totals).toEqual({ bundles: 22, specs: 683, passed: 662, failed: 21, errored: 0 });
    expect(new Set(EXPECTED.bundles).size).toBe(22);
    expect(EXPECTED.bundles).toHaveLength(22);
    expect(EXPECTED.bundles).not.toContain('bundleValidatorSecurity');
    expect(EXPECTED.excludedBundles.map((entry) => entry.bundle)).toContain('bundleValidatorSecurity');
    expect(EXPECTED.failures).toHaveLength(3);
    expect(EXPECTED.failures.reduce((sum, group) => sum + group.count, 0)).toBe(21);
    expect(EXPECTED.failures.every((group) => EXPECTED.bundles.includes(group.bundle))).toBe(true);
    expect(failureGroup('entities')).toMatchObject({ titlePattern: ENTITIES_PATTERN, count: 19 });
    expect(failureGroup('beanFeedSecurity')).toMatchObject({ title: TIMING_TITLE, count: 1, timingSensitive: true });
    expect(failureGroup('utility')).toMatchObject({ title: UTILITY_TITLE, count: 1 });
    expect(EXPECTED.officialRunner).toMatchObject({ expectedHttpStatus: 500, expectedSpecs: 0 });
  });

  it('names exactly the spec bundles on disk except the excluded one', async () => {
    const files = await fs.readdir(new URL('../../../core/tests/specs/mura/core/', import.meta.url));
    const onDisk = files.filter((file) => path.extname(file).toLowerCase() === '.cfc').map((file) => path.parse(file).name);
    const excluded = EXPECTED.excludedBundles.map((entry) => entry.bundle.toLowerCase());
    const lower = (names: readonly string[]): string[] => names.map((name) => name.toLowerCase()).sort();

    expect(lower(onDisk)).toEqual(expect.arrayContaining(excluded));
    expect(lower(EXPECTED.bundles)).toEqual(lower(onDisk.filter((name) => !excluded.includes(name.toLowerCase()))));
  });
});

describe('flattenTestBox', () => {
  it('flattens nested suites in report order with bundle, suite path, title and status', () => {
    const tree = {
      totalBundles: 1,
      totalSpecs: 4,
      totalPass: 2,
      totalFail: 1,
      totalError: 1,
      bundleStats: [
        {
          path: 'muraWRM.core.tests.specs.mura.core.sample',
          globalException: '',
          suiteStats: [
            {
              name: 'Outer',
              specStats: [{ name: 'direct spec', status: 'Passed' }],
              suiteStats: [
                {
                  name: 'Inner',
                  specStats: [
                    { name: 'nested pass', status: 'Passed' },
                    { name: 'nested fail', status: 'Failed', failMessage: 'boom' },
                  ],
                  suiteStats: [],
                },
              ],
            },
            { name: 'Second', specStats: [{ name: 'errored', status: 'Error', failMessage: 'oops' }], suiteStats: [] },
          ],
        },
      ],
    };
    const specs: FlatSpec[] = [
      { bundle: 'sample', suitePath: ['Outer'], spec: 'direct spec', fullName: 'Outer > direct spec', status: 'Passed', failMessage: '' },
      {
        bundle: 'sample',
        suitePath: ['Outer', 'Inner'],
        spec: 'nested pass',
        fullName: 'Outer > Inner > nested pass',
        status: 'Passed',
        failMessage: '',
      },
      {
        bundle: 'sample',
        suitePath: ['Outer', 'Inner'],
        spec: 'nested fail',
        fullName: 'Outer > Inner > nested fail',
        status: 'Failed',
        failMessage: 'boom',
      },
      { bundle: 'sample', suitePath: ['Second'], spec: 'errored', fullName: 'Second > errored', status: 'Error', failMessage: 'oops' },
    ];

    expect(flattenTestBox(tree)).toEqual({
      testBox: true,
      totals: { bundles: 1, specs: 4, passed: 2, failed: 1, errored: 1 },
      bundles: ['sample'],
      specs,
      bundleExceptions: [],
    });
  });

  it.each([
    ['an empty string', '', null],
    ['null', null, null],
    ['an empty struct', {}, null],
    ['a message string', 'Parse error', 'Parse error'],
    ['an exception struct in any key case', { TYPE: 'Expression', Message: 'Bad call', detail: 'line 36' }, 'Expression: Bad call: line 36'],
    ['a struct without type, message or detail', { Code: 7 }, '{"code":7}'],
    ['a non-string scalar', 42, '42'],
  ])('reads a bundle globalException given as %s', (_label, globalException, message) => {
    const tree = {
      totalBundles: 1,
      totalSpecs: 0,
      bundleStats: [{ path: 'muraWRM.core.tests.specs.mura.core.plugins', globalException, suiteStats: [] }],
    };

    expect(flattenTestBox(tree).bundleExceptions).toEqual(message === null ? [] : [{ bundle: 'plugins', message }]);
  });

  it.each([
    ['the official runner error text', OFFICIAL_500.body],
    ['JSON without TestBox totals', { error: 'Access Restricted' }],
    ['null', null],
  ])('yields zero totals and no specs for %s', (_label, body) => {
    const empty: ObservedBaseline = {
      testBox: false,
      totals: { bundles: 0, specs: 0, passed: 0, failed: 0, errored: 0 },
      bundles: [],
      specs: [],
      bundleExceptions: [],
    };

    expect(flattenTestBox(body)).toEqual(empty);
  });

  it('reads the matching diagnostic as 683 specs with 21 failed and none errored, in any key case', () => {
    const observed = flattenTestBox(lowerKeysDeep(BODIES.match));

    expect(observed.testBox).toBe(true);
    expect(observed.totals).toEqual(EXPECTED.totals);
    expect(observed.specs).toHaveLength(683);
    expect(observed.specs.filter((spec) => spec.status === 'Failed')).toHaveLength(21);
    expect(observed.specs.filter((spec) => spec.status === 'Error')).toHaveLength(0);
    expect(observed.bundles).toEqual(EXPECTED.bundles);
    expect(observed.bundleExceptions).toEqual([]);
    expect(flattenTestBox(BODIES.match)).toEqual(observed);
  });

  it('keeps the nested suite path of every failing entities spec', () => {
    const failing = flattenTestBox(BODIES.match).specs.filter((spec) => spec.bundle === 'entities' && spec.status === 'Failed');

    expect(failing).toHaveLength(19);
    for (const spec of failing) {
      expect(spec.suitePath).toHaveLength(2);
      expect(spec.suitePath[0]).toBe(ENTITY_SUITE);
      expect(spec.suitePath[1]).toMatch(/^Testing \S+ entity$/);
      expect(spec.fullName).toBe([...spec.suitePath, spec.spec].join(' > '));
    }
  });
});

describe('diffBaseline and isTimingOnly', () => {
  const diff = (body: TestBoxBody): Difference[] =>
    diffBaseline(EXPECTED, flattenTestBox(body), OFFICIAL_500, diagnosticResponse(body));

  it('finds no difference for the matching diagnostic', () => {
    expect(diff(BODIES.match)).toEqual([]);
    expect(isTimingOnly([], EXPECTED)).toBe(false);
  });

  it('reports a passing timing-sensitive spec with its shifted totals as timing-only', () => {
    const differences = diff(BODIES['timing-only']);

    expect(differences).toEqual(TIMING_DIFFERENCES);
    expect(isTimingOnly(differences, EXPECTED)).toBe(true);
  });

  it('reports an unexpected failure with its shifted totals as more than timing', () => {
    const differences = diff(BODIES.mismatch);

    expect(differences).toEqual(MISMATCH_DIFFERENCES);
    expect(isTimingOnly(differences, EXPECTED)).toBe(false);
  });

  it('lists every kind of difference in report order, sorted by subject within a kind', () => {
    const tree = structuredClone(BODIES.match);
    tree.bundleStats = tree.bundleStats.filter((bundle) => !/\.(modules|plugins)$/.test(bundle.path));
    for (const [suiteName, title] of [
      ['Bean Feed Security - Base Feed Class', TIMING_TITLE],
      ['Testing Utilities', UTILITY_TITLE],
    ] as const) {
      const suites = tree.bundleStats.flatMap((bundle) => bundle.suiteStats);
      const spec = findSuite(suites, suiteName)?.specStats.find((candidate) => candidate.name === title);
      if (spec === undefined) throw new Error(`diagnostic-match.json has no "${title}" spec`);
      spec.status = 'Passed';
    }
    tree.bundleStats.push({
      name: 'muraWRM.core.tests.specs.mura.core.bundleValidatorSecurity',
      path: 'muraWRM.core.tests.specs.mura.core.bundleValidatorSecurity',
      globalException: { type: 'Expression', message: 'Parameter validation error for the DIRECTORYCREATE function.' },
      suiteStats: [],
    });
    const entities = tree.bundleStats.find((bundle) => bundle.path.endsWith('.entities'));
    const widget = findSuite(entities?.suiteStats ?? [], 'Testing testWidget entity');
    if (widget === undefined) throw new Error('diagnostic-match.json has no testWidget entity suite');
    widget.specStats.push(
      { name: 'zzzVar should match schema datatype FLOAT', status: 'Failed', failMessage: 'Expected [false] to be true' },
      { name: 'errVar should match schema datatype FLOAT', status: 'Error', failMessage: 'boom' },
    );
    const official: SavedRunnerResponse = { ...OFFICIAL_500, httpStatus: 200, specs: 683 };
    const diagnostic: SavedRunnerResponse = { ...diagnosticResponse(tree), httpStatus: 500 };
    const widgetSpec = (name: string): string => `${ENTITY_SUITE} > Testing testWidget entity > ${name}`;

    const differences = diffBaseline(EXPECTED, flattenTestBox(tree), official, diagnostic);

    expect(differences).toEqual([
      { kind: 'diagnostic-runner', field: 'httpStatus', expected: 200, observed: 500 },
      { kind: 'official-runner', field: 'httpStatus', expected: 500, observed: 200 },
      { kind: 'official-runner', field: 'specs', expected: 0, observed: 683 },
      { kind: 'missing-bundle', bundle: 'modules' },
      { kind: 'missing-bundle', bundle: 'plugins' },
      { kind: 'unexpected-bundle', bundle: 'bundleValidatorSecurity', excluded: true },
      {
        kind: 'bundle-exception',
        bundle: 'bundleValidatorSecurity',
        message: 'Expression: Parameter validation error for the DIRECTORYCREATE function.',
      },
      {
        kind: 'unexpected-failure',
        bundle: 'entities',
        spec: 'errVar should match schema datatype FLOAT',
        fullName: widgetSpec('errVar should match schema datatype FLOAT'),
        status: 'Error',
        failMessage: 'boom',
        group: null,
      },
      {
        kind: 'unexpected-failure',
        bundle: 'entities',
        spec: 'zzzVar should match schema datatype FLOAT',
        fullName: widgetSpec('zzzVar should match schema datatype FLOAT'),
        status: 'Failed',
        failMessage: 'Expected [false] to be true',
        group: ENTITIES_ID,
      },
      TIMING_DIFFERENCES[2],
      {
        kind: 'expected-failure-not-observed',
        group: UTILITY_ID,
        bundle: 'utility',
        spec: UTILITY_TITLE,
        timingSensitive: false,
        expected: 1,
        observed: 0,
        actual: [{ fullName: `Testing Utilities > ${UTILITY_TITLE}`, status: 'Passed' }],
      },
    ]);
    expect(isTimingOnly(differences, EXPECTED)).toBe(false);
  });

  const notObserved = (group: string, status: string): Difference => ({
    kind: 'expected-failure-not-observed',
    group,
    bundle: group.split(':')[0] ?? '',
    spec: group.slice(group.indexOf(': ') + 2),
    timingSensitive: group === TIMING_ID,
    expected: 1,
    observed: 0,
    actual: [{ fullName: `suite > ${group}`, status }],
  });
  const shifted: Difference[] = [
    { kind: 'totals', field: 'passed', expected: 662, observed: 663 },
    { kind: 'totals', field: 'failed', expected: 21, observed: 20 },
  ];

  it.each([
    ['a timing-sensitive spec that was skipped rather than passed', [...shifted, notObserved(TIMING_ID, 'Skipped')]],
    ['a missing failure of a group that is not timing-sensitive', [...shifted, notObserved(UTILITY_ID, 'Passed')]],
    ['totals that do not shift by the flipped count', [shifted[0]!, notObserved(TIMING_ID, 'Passed')]],
    ['a bundles total', [{ kind: 'totals', field: 'bundles', expected: 22, observed: 21 } satisfies Difference]],
    ['totals alone', shifted],
  ])('does not treat %s as timing-only', (_label, differences: Difference[]) => {
    expect(isTimingOnly(differences, EXPECTED)).toBe(false);
  });
});

describe('buildBaselineReport', () => {
  it('carries the expected baseline, both runners, the diagnostic and the result, without a sourceSha', () => {
    const report = reportWith([]);

    expect(report).not.toHaveProperty('sourceSha');
    expect(report).toMatchObject({
      generatedBy: COMMAND,
      generatedAt: GENERATED_AT,
      status: 'generated',
      alsoWrittenTo: '/elsewhere/masa-baseline.json',
      officialRunner: {
        url: '/core/tests/runner.cfm?reporter=json',
        expectedHttpStatus: 500,
        expectedSpecs: 0,
        httpStatus: 500,
        specs: 0,
      },
      diagnostic: { url: DIAGNOSTIC_RUNNER_PATH, bundles: EXPECTED.bundles, totals: EXPECTED.totals, rerun: null },
      differences: [],
      result: 'match',
    });
    expect(report.diagnostic.failures).toHaveLength(21);
    expect(report.expected).toEqual({
      provenance: 'request',
      source: EXPECTED_BASELINE_PATH,
      totals: EXPECTED.totals,
      failures: [
        {
          bundle: 'entities',
          suite: null,
          specPattern: ENTITIES_PATTERN,
          count: 19,
          cause: 'data-driven loop over entity properties',
          source: { path: 'core/tests/specs/mura/core/entities.cfc', lines: '460' },
        },
        {
          bundle: 'beanFeedSecurity',
          suite: 'Performance and Stress Tests',
          spec: TIMING_TITLE,
          count: 1,
          cause: '1,000 ms timing threshold; ran at 1,177-1,387 ms',
          timingSensitive: true,
          source: { path: 'core/tests/specs/mura/core/beanFeedSecurity.cfc', lines: '38-47' },
        },
        {
          bundle: 'utility',
          suite: 'Testing isPathLegal',
          spec: UTILITY_TITLE,
          count: 1,
          cause: 'Lucee-specific expectation',
          source: { path: 'core/tests/specs/mura/core/utility.cfc', lines: '906' },
        },
      ],
      excludedBundles: [
        {
          bundle: 'bundleValidatorSecurity',
          reason: 'two-argument directoryCreate does not compile on ACF',
          source: { path: 'core/tests/specs/mura/core/bundleValidatorSecurity.cfc', lines: '36' },
        },
      ],
    });
  });

  it.each([
    ['inside the repository as a repository-relative path', repoPath(EXPECTED_BASELINE_PATH), EXPECTED_BASELINE_PATH],
    ['outside the repository as an absolute path', '/opt2-elsewhere/expected-baseline.json', '/opt2-elsewhere/expected-baseline.json'],
  ])('records an expected baseline %s', (_label, expectedPath, source) => {
    const report = buildBaselineReport({
      expected: EXPECTED,
      expectedPath,
      masaBaselinePath: masaPath,
      official: OFFICIAL_500,
      observed: flattenTestBox(BODIES.match),
      differences: [],
      rerun: null,
      result: 'match',
      generatedAt: new Date(GENERATED_AT),
    });

    expect(report.expected.source).toBe(source);
  });
});

describe('renderBaselineMarkdown', () => {
  it('returns body lines with the totals, the result and no differences for a match', () => {
    const lines = renderBaselineMarkdown(reportWith([]));

    expect(lines.some((line) => line.startsWith('# ') || line.startsWith('Source SHA:'))).toBe(false);
    expect(lines).toContain('Result: `match` (exit 0)');
    expect(lines).toContain('| Measure | Expected (request) | Observed | Re-run |');
    expect(lines).toEqual(
      expect.arrayContaining([
        '| Bundles | 22 | 22 | not run |',
        '| Specs | 683 | 683 | not run |',
        '| Passed | 662 | 662 | not run |',
        '| Failed | 21 | 21 | not run |',
        '| Errored | 0 | 0 | not run |',
      ]),
    );
    expect(lines.find((line) => line.startsWith('| `entities` |'))).toContain('| 19 | 19 | not run |');
    expect(lines.slice(lines.indexOf('## Differences') + 1, lines.indexOf('## Differences') + 3)).toEqual(['', 'none']);
  });

  it.each<[string, Difference, string]>([
    ['a total', TIMING_DIFFERENCES[0]!, '| first | `totals` | passed | 662 | 663 |  |'],
    [
      'a diagnostic body',
      { kind: 'diagnostic-runner', field: 'body', expected: 'TestBox JSON', observed: 'text (text/html;charset=UTF-8)' },
      '| first | `diagnostic-runner` | diagnostic body | TestBox JSON | text (text/html;charset=UTF-8) |  |',
    ],
    [
      'an official runner status',
      { kind: 'official-runner', field: 'httpStatus', expected: 500, observed: 200 },
      '| first | `official-runner` | official httpStatus | 500 | 200 |  |',
    ],
    ['a missing bundle', { kind: 'missing-bundle', bundle: 'modules' }, '| first | `missing-bundle` | modules | reported | not reported |  |'],
    [
      'an excluded bundle reported',
      { kind: 'unexpected-bundle', bundle: 'bundleValidatorSecurity', excluded: true },
      '| first | `unexpected-bundle` | bundleValidatorSecurity | not reported | reported | an excluded bundle |',
    ],
    [
      'a multi-line bundle exception',
      { kind: 'bundle-exception', bundle: 'plugins', message: 'line one\nline two' },
      '| first | `bundle-exception` | plugins | no bundle exception | bundle exception | line one line two |',
    ],
    [
      'an unexpected failure outside every group',
      CONTENT_FAILURE,
      '| first | `unexpected-failure` | content: Testing persistence > spec 016 | no failure | Failed | Expected [false] to be true |',
    ],
    [
      'a failure beyond its group count, escaping the pattern pipe',
      {
        kind: 'unexpected-failure',
        bundle: 'entities',
        spec: 'zzzVar should match schema datatype FLOAT',
        fullName: 'Testing testWidget entity > zzzVar should match schema datatype FLOAT',
        status: 'Failed',
        failMessage: 'Expected [false] to be true',
        group: ENTITIES_ID,
      },
      '| first | `unexpected-failure` | entities: Testing testWidget entity > zzzVar should match schema datatype FLOAT | within the count of entities: /^.+ should match schema datatype (VARCHAR\\|FLOAT)$/ | Failed | Expected [false] to be true |',
    ],
    [
      'a missing expected failure with the status that replaced it',
      TIMING_DIFFERENCES[2]!,
      `| first | \`expected-failure-not-observed\` | ${TIMING_ID} | 1 failed | 0 failed | Bean Feed Security - Base Feed Class > ${TIMING_TITLE}: Passed |`,
    ],
    [
      'a missing expected failure with no matching spec',
      {
        kind: 'expected-failure-not-observed',
        group: UTILITY_ID,
        bundle: 'utility',
        spec: UTILITY_TITLE,
        timingSensitive: false,
        expected: 1,
        observed: 0,
        actual: [],
      },
      `| first | \`expected-failure-not-observed\` | ${UTILITY_ID} | 1 failed | 0 failed | no other matching spec reported |`,
    ],
  ])('renders %s as a differences row', (_label, difference, row) => {
    const lines = renderBaselineMarkdown(reportWith([difference]));

    expect(lines).toContain('| Run | Kind | Subject | Expected | Observed | Detail |');
    expect(lines).toContain(row);
  });
});

describe('compareBaseline', () => {
  it('matches the expected baseline without a re-run', async () => {
    await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));
    const runDiagnostic = fakeRunDiagnostic();

    const outcome = await compareBaseline(deps(runDiagnostic));

    expect(outcome.code).toBe(0);
    expect(outcome.summary).toEqual({ result: 'match', totals: EXPECTED.totals, differences: 0, rerun: false, doneWhenMet: true });
    expect(outcome.report.result).toBe('match');
    expect(outcome.report.differences).toEqual([]);
    expect(outcome.report.alsoWrittenTo).toBe(masaPath);
    expect(outcome.report.officialRunner).toMatchObject({ httpStatus: 500, specs: 0 });
    expect(outcome.report.diagnostic.totals).toEqual({ bundles: 22, specs: 683, passed: 662, failed: 21, errored: 0 });
    expect(outcome.report.diagnostic.rerun).toBeNull();
    expect(runDiagnostic).not.toHaveBeenCalled();

    const failures = outcome.report.diagnostic.failures;
    const inGroup = (id: string): string[] => failures.filter((failure) => failure.group === id).map((failure) => failure.spec);
    expect(failures).toHaveLength(21);
    expect(failures.every((failure) => failure.group !== null)).toBe(true);
    expect(ENTITIES_ID).toBe(`entities: /${ENTITIES_PATTERN}/`);
    expect(inGroup(ENTITIES_ID)).toHaveLength(19);
    for (const title of inGroup(ENTITIES_ID)) expect(title).toMatch(new RegExp(ENTITIES_PATTERN));
    expect(inGroup(TIMING_ID)).toEqual([TIMING_TITLE]);
    expect(inGroup(UTILITY_ID)).toEqual([UTILITY_TITLE]);
  });

  it('writes baseline.json with the committed key set and the pinned SHA, and a byte-identical setup copy', async () => {
    await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));

    const outcome = await compareBaseline(deps(fakeRunDiagnostic()));
    const reportFile = path.join(reportsDir, 'baseline.json');
    const bytes = await fs.readFile(reportFile);
    const written = JSON.parse(bytes.toString('utf8')) as Record<string, Record<string, unknown>> & { expected: { failures: unknown[] } };

    expect(sortedKeys(written)).toEqual(sortedKeys(COMMITTED_REPORT));
    for (const key of ['expected', 'officialRunner', 'diagnostic']) {
      expect(sortedKeys(written[key]), key).toEqual(sortedKeys(COMMITTED_REPORT[key]));
    }
    const committedFailures = COMMITTED_REPORT.expected?.failures as unknown[];
    expect(written.expected.failures.map(sortedKeys)).toEqual(committedFailures.map(sortedKeys));
    expect(written.sourceSha).toBe(PIN_SHA);
    expect(written.sourceSha).toBe('696383140578f8dea3ece26f80cd7bfb370ddf0f');
    expect(written).toMatchObject({ generatedBy: COMMAND, generatedAt: GENERATED_AT, status: 'generated', result: 'match' });
    expect(written).toEqual(outcome.report);
    expect(bytes.equals(await fs.readFile(masaPath))).toBe(true);
  });

  it('writes baseline.md as the title, the Source SHA line and the rendered body', async () => {
    await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));

    const outcome = await compareBaseline(deps(fakeRunDiagnostic()));
    const text = await fs.readFile(path.join(reportsDir, 'baseline.md'), 'utf8');
    const lines = text.split('\n');

    expect(lines[0]).toBe(`# ${REPORT_TITLE}`);
    expect(lines[1]).toBe(`Source SHA: ${PIN_SHA}`);
    expect(text).toBe(`${[`# ${REPORT_TITLE}`, `Source SHA: ${PIN_SHA}`, '', ...renderBaselineMarkdown(outcome.report)].join('\n')}\n`);
  });

  it.each([
    ['timing-only', 'timing-variance', 3, { passed: 663, failed: 20 }, TIMING_DIFFERENCES],
    ['match', 'match', 0, { passed: 662, failed: 21 }, []],
    ['mismatch', 'mismatch', 1, { passed: 661, failed: 22 }, MISMATCH_DIFFERENCES],
  ] as const)(
    're-runs the diagnostic once after a timing-only difference; a %s re-run gives %s',
    async (rerunFixture, result, exitCode, rerunCounts, rerunDifferences) => {
      await stage(OFFICIAL_500, diagnosticResponse(BODIES['timing-only']));
      const runDiagnostic = fakeRunDiagnostic(BODIES[rerunFixture]);
      const rerunTotals = { ...EXPECTED.totals, ...rerunCounts };

      const outcome = await compareBaseline(deps(runDiagnostic));

      expect(runDiagnostic).toHaveBeenCalledTimes(1);
      expect(runDiagnostic.mock.calls[0]?.[0]).toEqual({ rerun: true });
      expect(runDiagnostic.mock.calls[0]?.[1]).toEqual({ env });
      expect(outcome.code).toBe(exitCode);
      expect(outcome.summary).toEqual({
        result,
        totals: rerunTotals,
        differences: rerunDifferences.length,
        rerun: true,
        doneWhenMet: result === 'match',
      });
      expect(outcome.report.result).toBe(result);
      expect(outcome.report.differences).toEqual(TIMING_DIFFERENCES);
      expect(outcome.report.diagnostic.totals).toEqual({ ...EXPECTED.totals, passed: 663, failed: 20 });
      expect(outcome.report.diagnostic.rerun).toMatchObject({
        startedAt: RERUN_STARTED,
        totals: rerunTotals,
        differences: rerunDifferences,
        result,
      });
      expect(outcome.report.diagnostic.rerun?.reason).toMatch(/timing/);
      expect(outcome.report.diagnostic.rerun?.failures).toHaveLength(rerunCounts.failed);
    },
  );

  it('renders the re-run column and re-run differences for a timing variance', async () => {
    await stage(OFFICIAL_500, diagnosticResponse(BODIES['timing-only']));

    await compareBaseline(deps(fakeRunDiagnostic(BODIES['timing-only'])));
    const lines = (await fs.readFile(path.join(reportsDir, 'baseline.md'), 'utf8')).split('\n');

    expect(lines).toContain('Result: `timing-variance` (exit 3), after one re-run whose result was `timing-variance`');
    expect(lines).toContain('| Passed | 662 | 663 | 663 |');
    expect(lines.find((line) => line.startsWith('| `beanFeedSecurity` |'))).toContain('| 1 | 0 | 0 |');
    expect(lines).toContain('| first | `totals` | failed | 21 | 20 |  |');
    expect(lines).toContain('| re-run | `totals` | failed | 21 | 20 |  |');
  });

  it('reports an unexpected failure as a mismatch without a re-run', async () => {
    await stage(OFFICIAL_500, diagnosticResponse(BODIES.mismatch));
    const runDiagnostic = fakeRunDiagnostic();

    const outcome = await compareBaseline(deps(runDiagnostic));

    expect(outcome.code).toBe(1);
    expect(outcome.summary).toEqual({
      result: 'mismatch',
      totals: { ...EXPECTED.totals, passed: 661, failed: 22 },
      differences: 3,
      rerun: false,
      doneWhenMet: false,
    });
    expect(outcome.report.differences).toEqual(MISMATCH_DIFFERENCES);
    expect(isTimingOnly(outcome.report.differences, EXPECTED)).toBe(false);
    expect(outcome.report.diagnostic.failures).toContainEqual({
      bundle: 'content',
      spec: 'spec 016',
      fullName: 'Testing persistence > spec 016',
      status: 'Failed',
      failMessage: 'Expected [false] to be true',
      group: null,
    });
    expect(runDiagnostic).not.toHaveBeenCalled();
  });

  it('reports an official runner that answers 200 with specs as a mismatch', async () => {
    const official: SavedRunnerResponse = {
      ...structuredClone(OFFICIAL_500),
      httpStatus: 200,
      contentType: 'application/json;charset=UTF-8',
      bodyKind: 'json',
      specs: 683,
      body: structuredClone(BODIES.match),
    };
    await stage(official, diagnosticResponse(BODIES.match));
    const runDiagnostic = fakeRunDiagnostic();

    const outcome = await compareBaseline(deps(runDiagnostic));

    expect(outcome.code).toBe(1);
    expect(outcome.summary.result).toBe('mismatch');
    expect(outcome.report.differences).toEqual([
      { kind: 'official-runner', field: 'httpStatus', expected: 500, observed: 200 },
      { kind: 'official-runner', field: 'specs', expected: 0, observed: 683 },
    ]);
    expect(outcome.report.officialRunner).toMatchObject({ httpStatus: 200, specs: 683 });
    expect(runDiagnostic).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<SavedRunnerResponse>, Difference[]]>([
    [
      'a text error page',
      { httpStatus: 500, bodyKind: 'text', contentType: 'text/html;charset=UTF-8', specs: 0, body: 'Internal error' },
      [
        { kind: 'diagnostic-runner', field: 'body', expected: 'TestBox JSON', observed: 'text (text/html;charset=UTF-8)' },
        { kind: 'diagnostic-runner', field: 'httpStatus', expected: 200, observed: 500 },
      ],
    ],
    [
      'JSON that is not a TestBox result',
      { bodyKind: 'json', specs: 0, body: { error: 'Access Restricted' } },
      [{ kind: 'diagnostic-runner', field: 'body', expected: 'TestBox JSON', observed: 'JSON that is not a TestBox result' }],
    ],
    [
      'text without a content type',
      { bodyKind: 'text', contentType: null, specs: 0, body: '<h1>Access Restricted.</h1>' },
      [{ kind: 'diagnostic-runner', field: 'body', expected: 'TestBox JSON', observed: 'text (no content type)' }],
    ],
  ])('reports a diagnostic answering %s as a runner mismatch only', async (_label, change, differences) => {
    await stage(OFFICIAL_500, { ...diagnosticResponse(BODIES.match), ...change });

    const outcome = await compareBaseline(deps(fakeRunDiagnostic()));

    expect(outcome.code).toBe(1);
    expect(outcome.report.result).toBe('mismatch');
    expect(outcome.report.differences).toEqual(differences);
    expect(outcome.report.diagnostic.totals).toEqual({ bundles: 0, specs: 0, passed: 0, failed: 0, errored: 0 });
    expect(outcome.report.diagnostic.bundles).toEqual([]);
  });

  it.each<[string, () => Promise<Partial<CompareDeps>>, RegExp]>([
    ['no saved runner responses', async () => ({}), /official\.json is missing: run baseline:run first/],
    [
      'a saved diagnostic that is not JSON',
      async () => {
        await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));
        await fs.writeFile(path.join(stateDir, 'baseline', 'diagnostic.json'), 'not json', 'utf8');
        return {};
      },
      /diagnostic\.json: is not valid JSON/,
    ],
    [
      'an expected baseline of the wrong shape',
      async () => {
        await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));
        const expectedPath = path.join(tmp, 'expected-baseline.json');
        await fs.writeFile(expectedPath, JSON.stringify({ totals: EXPECTED.totals, failures: [{ bundle: 'entities' }] }), 'utf8');
        return { expectedPath };
      },
      /expected-baseline\.json: does not match its schema:\n[\s\S]*→ at failures\[0\]\.count\n/,
    ],
    [
      'a saved diagnostic of null',
      () => stageSaved('diagnostic.json', null),
      /diagnostic\.json: does not match its schema:\n✖ Invalid input: expected object, received null$/,
    ],
    [
      'a saved diagnostic that is an array',
      () => stageSaved('diagnostic.json', [diagnosticResponse(BODIES.match)]),
      /diagnostic\.json: does not match its schema:\n✖ Invalid input: expected object, received array$/,
    ],
    [
      'an empty saved official response',
      () => stageSaved('official.json', {}),
      /official\.json: does not match its schema:\n[\s\S]*→ at runner\n[\s\S]*→ at httpStatus\n[\s\S]*→ at body$/,
    ],
    [
      'a saved official httpStatus given as a string',
      () => stageSaved('official.json', { ...OFFICIAL_500, httpStatus: '500' }),
      /official\.json: does not match its schema:\n✖ Invalid input: expected number, received string\n\s+→ at httpStatus$/,
    ],
    [
      'an expected baseline of null',
      () => stageExpected(null),
      /expected-baseline\.json: does not match its schema:\n✖ Invalid input: expected object, received null$/,
    ],
    [
      'an expected failure group of null',
      () => stageExpected({ ...EXPECTED, failures: [failureGroup('entities'), null] }),
      /expected-baseline\.json: does not match its schema:\n✖ Invalid input: expected object, received null\n\s+→ at failures\[1\]$/,
    ],
    [
      'an expected failure group with neither title nor titlePattern',
      () => stageExpected({ ...EXPECTED, failures: [{ ...failureGroup('utility'), title: undefined }] }),
      /expected-baseline\.json: does not match its schema:\n✖ needs exactly one of title and titlePattern\n\s+→ at failures\[0\]$/,
    ],
  ])('rejects %s and writes nothing', async (_label, prepare, message) => {
    const overrides = await prepare();
    const outcome = compareBaseline(deps(fakeRunDiagnostic(), overrides));

    await expect(outcome).rejects.toThrow(message);
    await expect(outcome).rejects.not.toBeInstanceOf(TypeError);
    expect(await exists(path.join(reportsDir, 'baseline.json'))).toBe(false);
    expect(await exists(masaPath)).toBe(false);
  });
});

describe('main', () => {
  const run = async (argv: string[]): Promise<{ code: number; lines: string[]; exit: Mock<(code: number) => void> }> => {
    const chunks: string[] = [];
    const exit = vi.fn<(code: number) => void>();
    const runDiagnostic = fakeRunDiagnostic();
    const code = await runCli((args) => main(args, deps(runDiagnostic)), {
      argv,
      command: COMMAND,
      exit,
      stdout: { write: (chunk: string) => chunks.push(chunk) },
    });
    return { code, lines: chunks.join('').split('\n').filter((line) => line !== ''), exit };
  };

  it('prints one JSON summary line and exits 0 on a match', async () => {
    await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));

    const { code, lines, exit } = await run([]);

    expect(code).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      command: COMMAND,
      ok: true,
      code: 0,
      result: 'match',
      totals: EXPECTED.totals,
      differences: 0,
      rerun: false,
      doneWhenMet: true,
    });
  });

  it('rejects any flag with its usage and exit code 2 before comparing', async () => {
    await stage(OFFICIAL_500, diagnosticResponse(BODIES.match));

    const { code, lines } = await run(['--force']);

    expect(code).toBe(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ command: COMMAND, ok: false, code: 2, usage: USAGE });
    expect(await exists(path.join(reportsDir, 'baseline.json'))).toBe(false);
  });
});
