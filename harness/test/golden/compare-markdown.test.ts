// Parity classification, the parity report, its Markdown renderings and the compare CLI over temp directories.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoldenSet, GoldenStep } from '../../src/golden/capture.js';
import {
  FIXTURES_UNAVAILABLE,
  loadCatalogue,
  scenarioById,
  type Catalogue,
  type Scenario,
} from '../../src/golden/catalogue.js';
import {
  DECISION_LIST_PATH,
  GENERATED_BY,
  MIGRATED_SERVICES,
  PARITY_RESULTS,
  UNMET_WITHOUT_FIXTURES,
  browserRecordSchema,
  browserResultPath,
  buildParityReport,
  classifyScenario,
  exceptionEntries,
  exceptionsMarkdownPath,
  loadDecisionList,
  loadExceptionsList,
  main,
  parityReportSchema,
  renderExceptionsMarkdown,
  renderParityMarkdown,
  toScenarioParity,
  type ClassifyOptions,
  type DecisionList,
  type ExceptionsList,
  type ParityDifference,
  type ParityReport,
  type ParityResult,
  type ScenarioParity,
  type ScenarioVerdict,
} from '../../src/golden/compare.js';
import { GoldenConfigError, type ExceptionEntry } from '../../src/golden/errors.js';
import { loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import type { ReplayOutput } from '../../src/golden/replay.js';
import { UsageError } from '../../src/lib/cli.js';
import { REPO_ROOT } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const CATALOGUE_FIXTURE = fileURLToPath(new URL('../fixtures/golden/catalogue.valid.yaml', import.meta.url));
const SHA = pinnedSha();
const CLOCK = (): Date => new Date('2026-01-02T03:04:05.000Z');
const WITHHELD_KEY = 'admin:cusers.update{type=2,action=add}';
const ACTION_REF = `opt2/decision-list.json#actionVariants/${WITHHELD_KEY}`;
const TABLE_REF = 'opt2/decision-list.json#tables/tusers';
const PROPOSAL = 'Carry the add variant.';
const TABLE_PROPOSAL = 'Proposed owner: people. Shared by two services.';
const STATE = '${OPT2_STATE_DIR}';
const BROWSER = { flow: 'admin-login', console: 'no-new-errors' } as const;
const DECISION_LINK = '[decision-list.md](../decision-list.md)';
const EXCEPTIONS_LINK = '[exceptions-list.md](../exceptions-list.md)';
const NO_FIXTURES = { available: false, reason: 'no CREATE SCHEMA' };
const FIXTURES = { available: true, reason: null };
const MASKED_DIFFERENCE = {
  step: 'home',
  path: 'dom.date',
  kind: 'changed',
  expected: 'a',
  actual: 'b',
  classification: 'known-issue',
  maskId: 'date-mask',
} as const;
const DECISIONS: DecisionList = {
  actionVariants: [{ routeKey: WITHHELD_KEY, proposal: PROPOSAL }],
  tables: [
    {
      table: 'tusers',
      proposedOwner: 'people',
      reason: 'Shared by two services.',
      withheldEntryPoints: [{ routeKey: WITHHELD_KEY }, { routeKey: null }],
    },
  ],
};

let catalogue: Catalogue;
let rules: NormaliseRules;
let id01: Scenario;
let co05: Scenario;
let pe01: Scenario;

beforeAll(async () => {
  catalogue = await loadCatalogue(CATALOGUE_FIXTURE);
  rules = loadRules(undefined, { PORT: '8500' });
  id01 = scenarioById(catalogue, 'GS-ID-01');
  co05 = scenarioById(catalogue, 'GS-CO-05');
  pe01 = scenarioById(catalogue, 'GS-PE-01');
});

/** One normalised exchange answering 200. */
function exchange(name: string, index: number, routeKey: string): GoldenStep {
  return {
    name,
    index,
    routeKey,
    request: { method: 'GET', url: '/admin/', headers: {}, body: { kind: 'none' } },
    response: { status: 200, headers: {}, body: '', rawSha256: '0'.repeat(64) },
    normalised: { name, index, routeKey, status: 200, maskedPaths: {} },
  };
}

/** A golden set of `scenario`, one exchange per step. */
function goldenOf(scenario: Scenario): GoldenSet {
  const fallback = scenario.covers[0] ?? 'api:unknown';
  return {
    sourceSha: SHA,
    scenarioId: scenario.id,
    capturedAt: '2026-01-01T00:00:00.000Z',
    origin: 'legacy',
    tableVersion: null,
    fixtures: FIXTURES,
    steps: scenario.steps.map((step, i) => exchange(step.name, i, scenario.covers[i] ?? fallback)),
    sideEffects: { mail: [], rows: {}, tasks: [], files: [] },
  };
}

/** The replay of `golden`, identical until `edit` changes it. */
function replayOf(golden: GoldenSet, edit: (output: ReplayOutput) => void = () => undefined): ReplayOutput {
  const output: ReplayOutput = {
    sourceSha: SHA,
    scenarioId: golden.scenarioId,
    replayedAt: '2026-01-01T00:00:01.000Z',
    origin: 'gateway',
    tableVersion: 'v0002',
    steps: structuredClone(golden.steps),
    sideEffects: structuredClone(golden.sideEffects),
    halted: [],
  };
  edit(output);
  return output;
}

function setStatus(step: GoldenStep | undefined, status: number): void {
  if (step === undefined) throw new Error('no such step');
  step.normalised.status = status;
  step.response.status = status;
}

function entry(over: Partial<ExceptionEntry> = {}): ExceptionEntry {
  return {
    id: 'EX-CO-05',
    scenario: 'GS-CO-05',
    routeKey: 'api:content.findone',
    difference: 'status',
    decision: 'preserve',
    reason: 'legacy answers 200',
    status: 'accepted',
    evidence: { golden: 'harness/golden/sets/GS-CO-05.json', replay: `${STATE}/golden/replay/GS-CO-05.json` },
    sourceSha: SHA,
    ...over,
  };
}

function classify(
  golden: GoldenSet | null,
  replay: ReplayOutput | null,
  over: Partial<ClassifyOptions> & Pick<ClassifyOptions, 'scenario'>,
): ScenarioVerdict {
  return classifyScenario(golden, replay, { exceptions: [], rules, decisionList: DECISIONS, ...over });
}

function verdictOf(result: ParityResult, over: Partial<ScenarioVerdict> = {}): ScenarioVerdict {
  return { result, reason: null, differences: [], exceptionId: null, decisionListRef: null, ...over };
}

/** `co05` as scenario `GS-CO-0<n>`. */
function coScenario(n: number, over: Partial<Scenario> = {}): Scenario {
  return { ...co05, id: `GS-CO-0${n}`, ...over };
}

/** `pe01` with its create step withheld under {@link WITHHELD_KEY}. */
function withheldScenario(): Scenario {
  return {
    ...pe01,
    steps: pe01.steps.map((step) =>
      step.name === 'create' ? { ...step, expected: 'withheld' as const, decisionListRef: WITHHELD_KEY } : step,
    ),
  };
}

function browserScenario(id: string): Scenario {
  return { ...id01, id, steps: [], browser: BROWSER };
}

function diff(over: Partial<ParityDifference> = {}): ParityDifference {
  return {
    step: 'findone',
    path: 'status',
    kind: 'status',
    expected: 200,
    actual: 500,
    classification: 'difference',
    ...over,
  };
}

type Sides = [GoldenSet | null, ReplayOutput | null, Partial<ClassifyOptions>];

describe('classifyScenario', () => {
  it('passes when the replay matches the golden set', () => {
    const golden = goldenOf(co05);
    expect(classify(golden, replayOf(golden), { scenario: co05 })).toEqual(verdictOf('pass'));
  });

  it('fails on an unlisted status difference', () => {
    const golden = goldenOf(co05);
    const verdict = classify(golden, replayOf(golden, (r) => setStatus(r.steps[0], 500)), { scenario: co05 });
    expect(verdict).toEqual(verdictOf('fail', { reason: '1 unlisted difference', differences: [diff()] }));
  });

  it('counts every unlisted difference in the reason', () => {
    const golden = goldenOf(id01);
    const replay = replayOf(golden, (r) => {
      setStatus(r.steps[1], 403);
      setStatus(r.steps[2], 404);
    });
    expect(classify(golden, replay, { scenario: id01 }).reason).toBe('2 unlisted differences');
  });

  it.each<[string, ParityResult, Partial<ExceptionEntry>]>([
    ['an accepted entry', 'excepted', { decision: 'fix', status: 'accepted' }],
    ['an open preserve entry', 'excepted', { decision: 'preserve', status: 'open' }],
    ['an appliesTo match', 'excepted', { routeKey: 'api:content.find', appliesTo: ['api:content.findone'] }],
    ['an open fix entry', 'fail', { decision: 'fix', status: 'open' }],
    ['a halted entry', 'fail', { status: 'halted' }],
    ['an entry of another scenario', 'fail', { scenario: 'GS-CO-99' }],
    ['an entry of another route key', 'fail', { routeKey: 'api:content.find' }],
  ])('with %s a status difference is %s', (_title, result, over) => {
    const golden = goldenOf(co05);
    const replay = replayOf(golden, (r) => setStatus(r.steps[0], 500));
    const verdict = classify(golden, replay, { scenario: co05, exceptions: [entry(over)] });
    const excused = result === 'excepted' ? 'EX-CO-05' : undefined;
    expect(verdict.result).toBe(result);
    expect(verdict.exceptionId).toBe(excused ?? null);
    expect(verdict.differences[0]?.exceptionId).toBe(excused);
  });

  it.each<[string, (s: Scenario) => Scenario, (g: GoldenSet) => void, (r: ReplayOutput) => void, string, string]>([
    [
      'a replay halt',
      (s) => s,
      () => undefined,
      (r) => {
        r.halted.push({
          step: 'findone',
          routeKey: 'api:content.findone',
          reason: 'renditions differ',
          exceptionId: 'EX-FILE-RENDITION',
        });
      },
      'renditions differ',
      'EX-FILE-RENDITION',
    ],
    [
      'a declared halt',
      (s) => ({ ...s, expected: 'halted', exceptionId: 'EX-CO-HALT' }),
      () => undefined,
      () => undefined,
      'declared halted; served by legacy',
      'EX-CO-HALT',
    ],
    [
      'a capture gap',
      (s) => s,
      (g) => {
        const step = g.steps[0];
        if (step === undefined) throw new Error('no step');
        step.gap = { reason: 'no candidate answered', candidatesTried: 2 };
        step.exceptionId = 'EX-CO-GAP';
      },
      () => undefined,
      'no candidate answered',
      'EX-CO-GAP',
    ],
  ])('halts on %s', (_title, scenarioEdit, goldenEdit, replayEdit, reason, exceptionId) => {
    const golden = goldenOf(co05);
    goldenEdit(golden);
    const verdict = classify(golden, replayOf(golden, replayEdit), { scenario: scenarioEdit(co05) });
    expect(verdict).toMatchObject({ result: 'halted', reason, exceptionId });
  });

  it('reports a withheld variant with its decision-list references', () => {
    const scenario = withheldScenario();
    const golden = goldenOf(scenario);
    expect(classify(golden, replayOf(golden), { scenario })).toEqual(
      verdictOf('withheld', { decisionListRef: [ACTION_REF, TABLE_REF] }),
    );
  });

  it('throws for a withheld route key the decision list does not hold', () => {
    const scenario = withheldScenario();
    const golden = goldenOf(scenario);
    const decisionList = { actionVariants: [], tables: [] };
    expect(() => classify(golden, replayOf(golden), { scenario, decisionList })).toThrow(GoldenConfigError);
  });

  it('reports a masked browser difference as known-issue', () => {
    const browser = browserRecordSchema.parse({
      differences: [MASKED_DIFFERENCE],
      steps: [{ name: 'home', routeKey: 'admin:home.redirect' }],
    });
    const verdict = classify(null, null, { scenario: browserScenario('GS-ID-02'), browser });
    expect(verdict.result).toBe('known-issue');
    expect(verdict.differences[0]?.maskId).toBe('date-mask');
  });

  it('excuses a browser console difference through the scenario route keys', () => {
    const consoleError = { step: 'console', path: 'console[0]', kind: 'extra', actual: 'TypeError' };
    const browser = browserRecordSchema.parse({
      differences: [{ ...consoleError, classification: 'difference' }],
      steps: [{ name: 'login', routeKey: 'admin:clogin.login' }],
    });
    const exceptions = [entry({ id: 'EX-ID-02', scenario: 'GS-ID-02', routeKey: 'admin:clogin.login' })];
    const verdict = classify(null, null, { scenario: browserScenario('GS-ID-02'), browser, exceptions });
    expect(verdict).toMatchObject({ result: 'excepted', exceptionId: 'EX-ID-02' });
  });

  it.each<[string, () => Sides, string]>([
    ['a browser flow not run', () => [null, null, { scenario: browserScenario('GS-ID-02') }], 'browser flow not run'],
    [
      'an unreadable browser record',
      () => [null, null, { scenario: browserScenario('GS-ID-02'), readErrors: { replay: 'record is not JSON' } }],
      'record is not JSON',
    ],
    [
      'a failed browser flow',
      () => {
        const browser = browserRecordSchema.parse({ error: { message: 'timed out', step: 'login' } });
        return [null, null, { scenario: browserScenario('GS-ID-02'), browser }];
      },
      'browser flow failed at login: timed out',
    ],
    ['a missing golden set', () => [null, null, {}], 'no golden set at harness/golden/sets/GS-CO-05.json'],
    ['an unreadable golden set', () => [null, null, { readErrors: { golden: 'off-schema' } }], 'off-schema'],
    ['a missing replay', () => [goldenOf(co05), null, {}], `no replay output at ${STATE}/golden/replay/GS-CO-05.json`],
    [
      'a failed replay',
      () => {
        const golden = goldenOf(co05);
        return [golden, replayOf(golden, (r) => (r.error = { message: 'gateway down' })), {}];
      },
      'replay failed: gateway down',
    ],
  ])('fails on %s', (_title, build, reason) => {
    const [golden, replay, over] = build();
    expect(classify(golden, replay, { scenario: co05, ...over })).toMatchObject({ result: 'fail', reason });
  });

  it.each<[string, () => Sides, string]>([
    [
      'unavailable fixtures',
      () => [null, null, { scenario: { ...co05, fixtures: 'required' }, fixtures: NO_FIXTURES }],
      'no CREATE SCHEMA',
    ],
    [
      'unavailable fixtures without a reason',
      () => [null, null, { scenario: { ...co05, fixtures: 'required' }, fixtures: { available: false, reason: null } }],
      'the legacy fixtures are unavailable',
    ],
    [
      'a skipped golden set',
      () => [{ ...goldenOf(co05), steps: [], skipped: FIXTURES_UNAVAILABLE }, null, {}],
      'the golden set was captured without the legacy fixtures',
    ],
    [
      'a skipped replay',
      () => {
        const golden = goldenOf(co05);
        return [golden, replayOf(golden, (r) => Object.assign(r, { steps: [], skipped: FIXTURES_UNAVAILABLE })), {}];
      },
      'the replay ran without the legacy fixtures',
    ],
  ])('skips on %s', (_title, build, reason) => {
    const [golden, replay, over] = build();
    expect(classify(golden, replay, { scenario: co05, ...over })).toMatchObject({
      result: FIXTURES_UNAVAILABLE,
      reason,
    });
  });
});

describe('toScenarioParity', () => {
  it.each([
    ['GS-CO-05', undefined, `${STATE}/golden/replay/GS-CO-05.json`],
    ['GS-ID-02', BROWSER, `${STATE}/golden/browser/GS-ID-02.json`],
  ] as const)('points %s evidence at its compared sides', (id, browser, replay) => {
    const verdict = verdictOf('pass');
    expect(toScenarioParity({ id, service: 'identity', browser }, verdict)).toEqual({
      id,
      service: 'identity',
      ...verdict,
      evidence: { golden: `harness/golden/sets/${id}.json`, replay },
    });
  });
});

/** Catalogue scenarios and one report row per result, the rows out of catalogue order. */
function reportInputs(): { scenarios: Scenario[]; rows: ScenarioParity[] } {
  const halted = coScenario(6, { expected: 'halted', exceptionId: 'EX-CO-06' });
  const excepted = coScenario(7, { expected: 'halted', exceptionId: 'EX-CO-07' });
  const known = coScenario(8);
  const skipped = coScenario(9, { fixtures: 'required' });
  const withheld = withheldScenario();
  const row = (scenario: Scenario, result: ParityResult, over: Partial<ScenarioVerdict> = {}): ScenarioParity =>
    toScenarioParity(scenario, verdictOf(result, over));
  const rows = [
    row(skipped, FIXTURES_UNAVAILABLE, { reason: 'no CREATE SCHEMA' }),
    row(known, 'known-issue', { differences: [diff({ classification: 'known-issue', maskId: 'date-mask' })] }),
    row(withheld, 'withheld', { decisionListRef: [ACTION_REF, TABLE_REF] }),
    row(co05, 'fail', {
      reason: 'status 200 | 500',
      differences: [
        diff(),
        diff({ path: 'headers.etag', exceptionId: 'EX-CO-05' }),
        diff({ classification: 'known-issue' }),
      ],
      exceptionId: 'EX-CO-05',
    }),
    row(halted, 'halted', { reason: 'renditions\ndiffer', exceptionId: 'EX-CO-06' }),
    row(excepted, 'excepted', { differences: [diff({ exceptionId: 'EX-CO-07' })], exceptionId: 'EX-CO-07' }),
    row(id01, 'pass'),
  ];
  return { scenarios: [id01, co05, withheld, halted, excepted, known, skipped], rows };
}

function fullReport(): ParityReport {
  const { scenarios, rows } = reportInputs();
  return buildParityReport({
    catalogue: { scenarios },
    scenarios: rows,
    fixtures: NO_FIXTURES,
    decisionList: DECISIONS,
    exceptions: [entry({ id: 'EX-CO-06', scenario: 'GS-CO-06', status: 'halted', appliesTo: ['api:content.find'] })],
    clock: CLOCK,
  });
}

describe('buildParityReport', () => {
  it('orders rows by catalogue and counts each result', () => {
    const report = fullReport();
    expect(parityReportSchema.parse(report)).toEqual(report);
    expect(report.scenarios.map((s) => s.id)).toEqual([
      'GS-ID-01',
      'GS-CO-05',
      'GS-PE-01',
      'GS-CO-06',
      'GS-CO-07',
      'GS-CO-08',
      'GS-CO-09',
    ]);
    expect(report.summary).toEqual({
      total: 7,
      pass: 1,
      fail: 1,
      excepted: 1,
      halted: 1,
      knownIssue: 1,
      withheld: 1,
      skipped: 1,
    });
    expect(report).toMatchObject({ sourceSha: SHA, generatedBy: GENERATED_BY, generatedAt: CLOCK().toISOString() });
  });

  it('lists withheld proposals, planned outcomes and the coverage left without fixtures', () => {
    const report = fullReport();
    expect(report.unmetWithheld).toEqual([
      { id: 'GS-PE-01', decisionListRef: ACTION_REF, proposal: PROPOSAL },
      { id: 'GS-PE-01', decisionListRef: TABLE_REF, proposal: TABLE_PROPOSAL },
    ]);
    expect(report.planned).toEqual({
      provenance: 'planning',
      withheld: [{ scenario: 'GS-PE-01', routeKeys: [WITHHELD_KEY], decisionListRef: [ACTION_REF, TABLE_REF] }],
      halted: [
        { scenario: 'GS-CO-06', exceptionId: 'EX-CO-06', routeKeys: ['api:content.findone', 'api:content.find'] },
        { scenario: 'GS-CO-07', exceptionId: 'EX-CO-07', routeKeys: [] },
      ],
    });
    expect(report.coverage).toEqual({
      servicesCovered: MIGRATED_SERVICES.length,
      servicesTotal: 10,
      unmet: [UNMET_WITHOUT_FIXTURES],
    });
  });

  it('records withheld rows without a known reference, and omits coverage when fixtures are available', () => {
    const row = toScenarioParity(co05, verdictOf('withheld'));
    const otherRef = 'opt2/decision-list.json#tables/tother';
    const report = buildParityReport({
      catalogue,
      scenarios: [row, { ...row, id: 'GS-ID-01', decisionListRef: [otherRef] }],
      fixtures: FIXTURES,
      decisionList: DECISIONS,
      exceptions: [],
      sourceSha: 'a'.repeat(40),
    });
    expect(report.sourceSha).toBe('a'.repeat(40));
    expect(report.coverage).toBeUndefined();
    expect(report.unmetWithheld).toEqual([
      { id: 'GS-ID-01', decisionListRef: otherRef, proposal: null },
      { id: 'GS-CO-05', decisionListRef: null, proposal: null },
    ]);
  });

  it('throws for a row the catalogue does not hold', () => {
    const row = toScenarioParity(coScenario(1, { id: 'GS-ZZ-01' }), verdictOf('pass'));
    const inputs = { catalogue, scenarios: [row], fixtures: FIXTURES, decisionList: DECISIONS, exceptions: [] };
    expect(() => buildParityReport(inputs)).toThrow(/catalogue has no scenario GS-ZZ-01/);
  });
});

describe('renderParityMarkdown', () => {
  it('renders the header, legend, summary and one row per scenario', () => {
    const lines = renderParityMarkdown(fullReport());
    expect(lines.slice(0, 6)).toEqual([
      'Status: complete',
      `Generated by: ${GENERATED_BY}`,
      'Generated at: 2026-01-02T03:04:05.000Z',
      'Replayed by: harness/src/golden/replay.ts',
      'Table version: v0002 (GS-PE-RH-*: v0003)',
      `Fixtures: unavailable (no CREATE SCHEMA) (from \`${STATE}/fixtures.json\`)`,
    ]);
    expect(lines).toContain('| total | 7 |');
    for (const result of PARITY_RESULTS) expect(lines).toContain(`| \`${result}\` | 1 |`);
    expect(lines).toContain(
      '| <a id="GS-CO-05"></a>GS-CO-05 | strategies-content | `fail`: status 200 \\| 500 | ' +
        '3 (1 unlisted, 1 excepted, 1 known-issue) | ' +
        `golden \`harness/golden/sets/GS-CO-05.json\`, replay \`${STATE}/golden/replay/GS-CO-05.json\`; ` +
        `${EXCEPTIONS_LINK}: \`EX-CO-05\` |`,
    );
    expect(lines.find((line) => line.includes('GS-CO-06'))).toContain('`halted`: renditions differ | 0 |');
    expect(lines.find((line) => line.startsWith('| <a id="GS-PE-01">'))).toContain(
      `${DECISION_LINK}: \`${ACTION_REF}\`, \`${TABLE_REF}\``,
    );
  });

  it('renders the unmet, planned and coverage sections', () => {
    const lines = renderParityMarkdown(fullReport());
    expect(lines).toContain(`| GS-PE-01 | ${DECISION_LINK}: \`${TABLE_REF}\` | ${TABLE_PROPOSAL} |`);
    expect(lines).toContain(
      `| GS-PE-01 | \`withheld\` | \`${WITHHELD_KEY}\` | ${DECISION_LINK}: \`${ACTION_REF}\`, \`${TABLE_REF}\` |`,
    );
    expect(lines).toContain(`| GS-CO-07 | \`halted\` |  | ${EXCEPTIONS_LINK}: \`EX-CO-07\` |`);
    expect(lines.at(-1)).toBe(
      'The legacy fixtures are unavailable, so parity covers four of ten services, and ' +
        `"${UNMET_WITHOUT_FIXTURES}" is unmet.`,
    );
  });

  it('states when nothing was compared or withheld', () => {
    const report = buildParityReport({
      catalogue,
      scenarios: [],
      fixtures: FIXTURES,
      decisionList: { actionVariants: [], tables: [] },
      exceptions: [],
      clock: CLOCK,
    });
    const lines = renderParityMarkdown(report);
    expect(lines).toContain(`Fixtures: available (from \`${STATE}/fixtures.json\`)`);
    expect(lines).toContain('No scenario was compared.');
    expect(lines).toContain('None: no scenario is withheld.');
    expect(lines.some((line) => line.startsWith('The legacy fixtures are unavailable'))).toBe(false);
    const unreferenced = { ...report, unmetWithheld: [{ id: 'GS-CO-05', decisionListRef: null, proposal: null }] };
    expect(renderParityMarkdown(unreferenced)).toContain('| GS-CO-05 | none recorded | none recorded |');
  });
});

describe('renderExceptionsMarkdown', () => {
  const parityEvidence = { golden: 'harness/golden/sets/GS-CO-15.json', replay: 'opt2/reports/parity.json#GS-CO-15' };
  const entries = [
    entry({ appliesTo: ['api:content.find'] }),
    entry({ id: 'EX-CO-15', scenario: 'GS-CO-15', evidence: parityEvidence }),
  ];

  it.each<[string, ExceptionsList]>([
    ['a bare array', entries],
    ['an entries object', { sourceSha: SHA, entries }],
  ])('renders %s with pending evidence states', (_title, list) => {
    expect(exceptionEntries(list)).toEqual(entries);
    const lines = renderExceptionsMarkdown(list);
    expect(lines[0]).toBe('| Value | Field | Meaning |');
    expect(lines).toContain(
      '| EX-CO-05 | GS-CO-05 | `api:content.findone`, `api:content.find` | status | `preserve` | `accepted` | ' +
        'golden `harness/golden/sets/GS-CO-05.json` (pending-run), ' +
        `replay \`${STATE}/golden/replay/GS-CO-05.json\` (pending-run) |`,
    );
    expect(lines.at(-1)).toContain('[pre-existing-defects.md](reports/pre-existing-defects.md)');
  });

  it('shows the run state and points parity evidence at parity.md', () => {
    const run = { results: new Map<string, ParityResult>([['GS-CO-05', 'fail']]), captured: new Set(['GS-CO-05']) };
    const lines = renderExceptionsMarkdown(entries, run);
    expect(lines.find((line) => line.startsWith('| EX-CO-05 '))).toContain(
      `(captured), replay \`${STATE}/golden/replay/GS-CO-05.json\` (fail) |`,
    );
    expect(lines.find((line) => line.startsWith('| EX-CO-15 '))).toContain(
      '(not captured), parity `opt2/reports/parity.md#GS-CO-15` (not in this run) |',
    );
  });

  it.each([
    ['/r/opt2/exceptions-list.json', '/r/opt2/exceptions-list.md'],
    ['/r/opt2/exceptions-list', '/r/opt2/exceptions-list.md'],
  ])('places the rendering of %s at %s', (from, to) => {
    expect(exceptionsMarkdownPath(from)).toBe(to);
  });
});

describe('list loaders', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'compare-lists-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults a decision list without variants or tables', async () => {
    const file = path.join(dir, 'decision-list.json');
    await writeFile(file, '{}', 'utf8');
    await expect(loadDecisionList(file)).resolves.toEqual({ actionVariants: [], tables: [] });
    expect(DECISION_LIST_PATH).toBe(path.join(REPO_ROOT, 'opt2', 'decision-list.json'));
  });

  it.each<[string, unknown]>([
    ['a bare array', [entry()]],
    ['an entries object', { entries: [entry()] }],
  ])('reads an exceptions list stored as %s', async (_title, json) => {
    const file = path.join(dir, 'exceptions-list.json');
    await writeFile(file, JSON.stringify(json), 'utf8');
    expect(exceptionEntries(await loadExceptionsList(file))).toEqual([entry()]);
  });

  it('rejects an exceptions entry with an unknown status', async () => {
    const file = path.join(dir, 'exceptions-list.json');
    await writeFile(file, JSON.stringify([{ ...entry(), status: 'closed' }]), 'utf8');
    await expect(loadExceptionsList(file)).rejects.toThrow(/does not match its schema/);
  });

  it('places browser records under the state directory', () => {
    expect(browserResultPath('GS-ID-02', { OPT2_STATE_DIR: dir })).toBe(
      path.join(dir, 'golden', 'browser', 'GS-ID-02.json'),
    );
  });
});

describe('main', () => {
  let root: string;
  let state: string;
  let reports: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'compare-main-'));
    state = path.join(root, 'state');
    reports = path.join(root, 'reports');
    env = { OPT2_STATE_DIR: state, OPT2_REPORTS_DIR: reports, PORT: '8500' };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), 'utf8');
  }

  /** Writes the catalogue, exceptions and decision lists; returns the CLI flags naming them. */
  async function inputs(scenarios: Scenario[], exceptions: ExceptionEntry[]): Promise<string[]> {
    const files = {
      catalogue: path.join(root, 'catalogue.yaml'),
      exceptions: path.join(root, 'exceptions-list.json'),
      decisions: path.join(root, 'decision-list.json'),
    };
    await writeJson(files.catalogue, { sourceSha: SHA, scenarios });
    await writeJson(files.exceptions, exceptions);
    await writeJson(files.decisions, DECISIONS);
    return ['--catalogue', files.catalogue, '--exceptions', files.exceptions, '--decision-list', files.decisions];
  }

  function stateFile(...segments: string[]): string {
    return path.join(state, 'golden', ...segments);
  }

  it('classifies every scenario, writes both reports and fails on any failing scenario', async () => {
    const scenarios = [
      id01,
      co05,
      withheldScenario(),
      scenarioById(catalogue, 'GS-PE-RH-01'),
      coScenario(6, { fixtures: 'required' }),
      coScenario(7),
      coScenario(8),
      coScenario(9),
      browserScenario('GS-ID-02'),
      browserScenario('GS-ID-03'),
      browserScenario('GS-ID-04'),
    ];
    const flags = await inputs(scenarios, [entry({ decision: 'fix', status: 'open' })]);
    const goldens = new Map(scenarios.map((s) => [s.id, goldenOf(s)]));
    const golden = (id: string): GoldenSet => {
      const set = goldens.get(id);
      if (set === undefined) throw new Error(`no golden ${id}`);
      return set;
    };
    for (const id of ['GS-ID-01', 'GS-PE-01', 'GS-CO-07', 'GS-CO-08']) {
      await writeJson(stateFile('replay', `${id}.json`), replayOf(golden(id)));
    }
    const failing = replayOf(golden('GS-CO-05'), (r) => setStatus(r.steps[0], 500));
    await writeJson(stateFile('replay', 'GS-CO-05.json'), failing);
    await writeFile(stateFile('replay', 'GS-CO-09.json'), '{', 'utf8');
    await writeJson(stateFile('browser', 'GS-ID-02.json'), { differences: [MASKED_DIFFERENCE] });
    await writeJson(stateFile('browser', 'GS-ID-04.json'), { differences: 'none' });

    const brokenGolden = path.join(REPO_ROOT, 'harness', 'golden', 'sets', 'GS-CO-08.json');
    const readGolden = async (id: string): Promise<GoldenSet> => {
      if (id === 'GS-CO-07') {
        throw new Error('golden set of GS-CO-07', { cause: Object.assign(new Error('absent'), { code: 'ENOENT' }) });
      }
      if (id === 'GS-CO-08') throw new Error(`${brokenGolden}: is not valid JSON`);
      return golden(id);
    };
    const logged: string[] = [];
    const outcome = await main(flags, env, { readGolden, clock: CLOCK, log: (line) => logged.push(line) });

    expect(outcome).toEqual({
      code: 1,
      summary: {
        total: 10,
        pass: 1,
        fail: 6,
        excepted: 0,
        halted: 0,
        knownIssue: 1,
        withheld: 1,
        skipped: 1,
        parityJson: path.join(reports, 'parity.json'),
        parityMarkdown: path.join(reports, 'parity.md'),
        exceptionsMarkdown: path.join(root, 'exceptions-list.md'),
      },
    });
    expect(logged).toContain('GS-PE-RH-01: not replayed yet; omitted');
    expect(logged).toContain('GS-CO-05: fail (1 unlisted difference)');

    const report = parityReportSchema.parse(JSON.parse(await readFile(path.join(reports, 'parity.json'), 'utf8')));
    const stateReason = (file: string, message: string): RegExp =>
      new RegExp(`^\\$\\{OPT2_STATE_DIR\\}/golden/${file.replaceAll('.', '\\.')}: ${message}`);
    expect(Object.fromEntries(report.scenarios.map((s) => [s.id, [s.result, s.reason]]))).toEqual({
      'GS-ID-01': ['pass', null],
      'GS-CO-05': ['fail', '1 unlisted difference'],
      'GS-PE-01': ['withheld', null],
      'GS-CO-06': [FIXTURES_UNAVAILABLE, 'fixtures.json not found'],
      'GS-CO-07': ['fail', 'no golden set at harness/golden/sets/GS-CO-07.json'],
      'GS-CO-08': ['fail', 'harness/golden/sets/GS-CO-08.json: is not valid JSON'],
      'GS-CO-09': ['fail', expect.stringMatching(stateReason('replay/GS-CO-09.json', 'is not valid JSON'))],
      'GS-ID-02': ['known-issue', null],
      'GS-ID-03': ['fail', 'browser flow not run'],
      'GS-ID-04': ['fail', expect.stringMatching(stateReason('browser/GS-ID-04.json', 'does not match its schema'))],
    });
    expect(report.coverage?.unmet).toEqual([UNMET_WITHOUT_FIXTURES]);

    const parityLines = (await readFile(path.join(reports, 'parity.md'), 'utf8')).split('\n');
    expect(parityLines.slice(0, 3)).toEqual(['# Parity report', `Source SHA: ${SHA}`, '']);
    const exceptionLines = (await readFile(path.join(root, 'exceptions-list.md'), 'utf8')).split('\n');
    expect(exceptionLines.slice(0, 2)).toEqual(['# Exceptions list', `Source SHA: ${SHA}`]);
    const entryLine = exceptionLines.find((line) => line.startsWith('| EX-CO-05 '));
    expect(entryLine).toMatch(/\(captured\), replay .* \(fail\) \|$/);
  });

  it('exits 0 and logs to stderr when every scenario passes', async () => {
    const flags = await inputs([id01], []);
    await writeJson(stateFile('replay', 'GS-ID-01.json'), replayOf(goldenOf(id01)));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const outcome = await main(flags, env, { readGolden: async () => goldenOf(id01), clock: CLOCK });
    expect(outcome.code).toBe(0);
    expect(outcome.summary).toMatchObject({ total: 1, pass: 1, fail: 0 });
    expect(stderr).toHaveBeenCalledWith('GS-ID-01: pass\n');
  });

  it.each(['catalogue', 'exceptions', 'decision-list'])('rejects an empty --%s path', async (flag) => {
    await expect(main([`--${flag}`, ''], env)).rejects.toThrow(UsageError);
  });
});
