// Parity classification of the sample golden set and replay, the parity report, its Markdown and the compare CLI.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readGoldenSet, type GoldenSet, type GoldenStep } from '../../src/golden/capture.js';
import {
  FIXTURES_UNAVAILABLE,
  fixtureStatusSchema,
  loadCatalogue,
  scenarioById,
  type Catalogue,
  type FixtureStatus,
  type Scenario,
} from '../../src/golden/catalogue.js';
import {
  EXCEPTIONS_TITLE,
  PARITY_RESULTS,
  PARITY_TITLE,
  buildParityReport,
  classifyScenario,
  exceptionEntries,
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
  type ParityReport,
  type ParityResult,
  type ScenarioVerdict,
} from '../../src/golden/compare.js';
import { GoldenConfigError, type ExceptionEntry } from '../../src/golden/errors.js';
import type { CookieRotation, NormalisedStep } from '../../src/golden/normalise/index.js';
import { masksFor, pathMasks } from '../../src/golden/normalise/masks.js';
import { RULES_PATH, loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import { replayOutputSchema, type ReplayOutput } from '../../src/golden/replay.js';
import { opt2Path } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const fixture = (relative: string): string => fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url));
const GOLDEN_SAMPLE = fixture('golden/golden-set.sample.json');
const REPLAY_SAMPLE = fixture('golden/replay-output.sample.json');
const CATALOGUE_FIXTURE = fixture('golden/catalogue.valid.yaml');
const EXCEPTIONS_FIXTURE = fixture('inventory/mini-exceptions-list.json');
const DECISIONS_FIXTURE = fixture('inventory/mini-decision-list.json');
const UNAVAILABLE_FIXTURE = fixture('reporting/fixtures-unavailable.json');

const SHA = pinnedSha();
const CLOCK = (): Date => new Date('2026-06-30T14:00:00.000Z');
const RULES_ENV = { PORT: '8500' };
const FIXTURES_SOURCE = '${OPT2_STATE_DIR}/fixtures.json';
const AVAILABLE = { available: true, reason: null };
const READ_KEY = 'api:content.findone';
const LOGIN_KEY = 'admin:clogin.login';
const HALTED_KEY = 'admin:carch.update{upload=image}';
const WITHHELD_KEY = 'admin:cusers.update{type=2,action=delete}';
const WITHHELD_REF = `opt2/decision-list.json#actionVariants/${WITHHELD_KEY}`;
const UNKNOWN_KEY = 'admin:cusers.update{type=2,action=purge}';
const RENDITION_ID = 'EX-FILE-RENDITION';
const TITLE_ENTRY_ID = 'EX-CO-TITLE';
const DECISION_LINK = '[decision-list.md](../decision-list.md)';
const EXCEPTIONS_LINK = '[exceptions-list.md](../exceptions-list.md)';
const CHANGED_TITLE = 'About Them';
const TITLE_DIFFERENCE = {
  step: 'findone',
  path: 'envelope.data.title',
  kind: 'changed',
  expected: 'About Us',
  actual: CHANGED_TITLE,
  classification: 'difference',
} as const;

/** Committed outputs compare must not touch, and the read-only inputs of this suite. */
const GUARDED = [
  opt2Path('reports', 'parity.json'),
  opt2Path('reports', 'parity.md'),
  opt2Path('exceptions-list.json'),
  opt2Path('exceptions-list.md'),
  RULES_PATH,
  GOLDEN_SAMPLE,
  REPLAY_SAMPLE,
  CATALOGUE_FIXTURE,
  EXCEPTIONS_FIXTURE,
  DECISIONS_FIXTURE,
  UNAVAILABLE_FIXTURE,
];

/** One scenario with its compared sides and the options it overrides. */
interface Case {
  scenario: Scenario;
  golden: GoldenSet | null;
  replay: ReplayOutput | null;
  opts?: Partial<Pick<ClassifyOptions, 'exceptions' | 'fixtures'>>;
}

type Side = GoldenSet | ReplayOutput;
type StepFields = Partial<Pick<GoldenStep, 'name' | 'routeKey' | 'expected' | 'decisionListRef'>>;

let guarded: Record<string, string | null>;
let catalogue: Catalogue;
let rules: NormaliseRules;
let golden: GoldenSet;
let replay: ReplayOutput;
let exceptionsList: ExceptionsList;
let exceptions: ExceptionEntry[];
let decisionList: DecisionList;
let unavailable: FixtureStatus;
/** One case per parity result, each under its own scenario id. */
let cases: Record<ParityResult, Case>;

/** SHA-256 of `file`, or `null` when it does not exist. */
async function digest(file: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function digests(files: readonly string[]): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await digest(file)] as const)));
}

function entryById(id: string): ExceptionEntry {
  const entry = exceptions.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`mini exceptions list has no entry ${id}`);
  return entry;
}

function proposalOf(routeKey: string): string {
  const variant = decisionList.actionVariants.find((candidate) => candidate.routeKey === routeKey);
  if (variant === undefined) throw new Error(`mini decision list has no action variant ${routeKey}`);
  return variant.proposal;
}

/** GS-CO-75 of the catalogue fixture under another id. */
function derive(id: string, over: Partial<Scenario> = {}): Scenario {
  return { ...structuredClone(scenarioById(catalogue, 'GS-CO-75')), id, ...over };
}

/** Copy of `side` as scenario `id`'s evidence, every step taking `fields` on both its record and normalised form. */
function retarget<T extends Side>(side: T, id: string, fields: StepFields = {}): T {
  const copy: Side = structuredClone(side);
  copy.scenarioId = id;
  for (const step of copy.steps) {
    Object.assign(step, fields);
    step.normalised.name = step.name;
    step.normalised.routeKey = step.routeKey;
  }
  return copy as T;
}

/** Copy of `side` whose normalised envelopes carry `title`. */
function retitled(side: ReplayOutput, title: string): ReplayOutput {
  const copy = structuredClone(side);
  for (const step of copy.steps) (step.normalised.envelope as { data: { title: string } }).data.title = title;
  return copy;
}

/** `side` as GS-CO-77's replay of the image upload, halted under the rendition entry. */
function halt(side: ReplayOutput): ReplayOutput {
  const copy = retarget(side, 'GS-CO-77', { routeKey: HALTED_KEY });
  const { reason } = entryById(RENDITION_ID);
  copy.halted = [{ step: 'findone', routeKey: HALTED_KEY, reason, exceptionId: RENDITION_ID }];
  return copy;
}

/** The rendition entry's shape, rewritten to cover the title difference of `scenarioId` in `state`. */
function titleEntry(scenarioId: string, state: Pick<ExceptionEntry, 'decision' | 'status'>): ExceptionEntry {
  return {
    ...structuredClone(entryById(RENDITION_ID)),
    id: TITLE_ENTRY_ID,
    scenario: scenarioId,
    routeKey: READ_KEY,
    appliesTo: [],
    difference: 'The replayed content title differs from the captured one.',
    matches: [{ step: 'findone', path: 'envelope.data.title', kind: ['changed'] }],
    reason: 'Accepted after review.',
    evidence: { golden: `harness/golden/sets/${scenarioId}.json`, replay: `opt2/reports/parity.json#${scenarioId}` },
    ...state,
  };
}

/** GS-ID-01 with its login step flagged for the session-rotation known issue. */
function knownIssueScenario(): Scenario {
  const scenario = structuredClone(scenarioById(catalogue, 'GS-ID-01'));
  scenario.steps = scenario.steps.map((step) =>
    step.name === 'login' ? { ...step, knownIssue: 'session-rotation' } : step,
  );
  return scenario;
}

/** `side` reduced to `scenario`'s login exchange, its CFID cookie at `rotation` and masked by the committed rules. */
function loginSide<T extends Side>(side: T, scenario: Scenario, rotation: CookieRotation): T {
  const copy: Side = retarget(side, scenario.id);
  const normalised: NormalisedStep = {
    name: 'login',
    index: 1,
    routeKey: LOGIN_KEY,
    status: 302,
    auth: {
      cookies: [
        {
          name: 'CFID',
          value: '<token>',
          path: '/',
          httpOnly: true,
          secure: false,
          persistence: 'session',
          hop: 0,
          rotation,
        },
      ],
      wwwAuthenticate: [],
      redirectTargets: [{ status: 302, location: '/admin/' }],
    },
    maskedPaths: {},
  };
  const flagged = scenario.steps.find((step) => step.name === 'login');
  normalised.maskedPaths = pathMasks(normalised, masksFor(scenario.id, LOGIN_KEY, rules, flagged));
  copy.steps = [
    {
      name: 'login',
      index: 1,
      routeKey: LOGIN_KEY,
      request: { method: 'POST', url: '/admin/index.cfm', headers: {}, body: { kind: 'none' } },
      response: { status: 302, headers: {}, rawSha256: '0'.repeat(64) },
      normalised,
    },
  ];
  return copy as T;
}

/** Step of GS-ID-09 that submits a carried form to the withheld user delete. */
const WITHHELD_STEP = 'carried-form-to-withheld';

/** GS-ID-09's carried form submitted to a legacy-served action, withheld under decision-list route key `ref`. */
function withheldCase(ref: string): Case {
  const scenario = derive('GS-ID-09', { service: 'identity', role: 'admin', covers: [ref] });
  scenario.steps = scenario.steps.map((step) => ({
    ...step,
    name: WITHHELD_STEP,
    method: 'POST',
    route: '/admin/?muraAction=cUsers.update',
    expected: 'withheld',
    decisionListRef: ref,
  }));
  const fields: StepFields = { name: WITHHELD_STEP, routeKey: ref, expected: 'withheld', decisionListRef: ref };
  return { scenario, golden: retarget(golden, scenario.id, fields), replay: retarget(replay, scenario.id, fields) };
}

function classify(c: Case): ScenarioVerdict {
  return classifyScenario(c.golden, c.replay, { scenario: c.scenario, exceptions, rules, decisionList, ...c.opts });
}

/** The parity report of every case, handed over in reverse catalogue order. */
function build(fixtures: Pick<FixtureStatus, 'available' | 'reason'>): ParityReport {
  const scenarios = PARITY_RESULTS.map((result) => cases[result].scenario);
  const rows = PARITY_RESULTS.map((result) => toScenarioParity(cases[result].scenario, classify(cases[result])));
  return buildParityReport({
    catalogue: { scenarios },
    scenarios: rows.reverse(),
    fixtures,
    decisionList,
    exceptions,
    clock: CLOCK,
  });
}

/** Cells of one Markdown table row; an escaped `\|` stays inside its cell. */
function cells(row: string): string[] {
  return row
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** Table rows of `lines` keyed by their first cell, for rows whose first cell matches `first`. */
function rowsBy(lines: readonly string[], first: RegExp): Map<string, string[]> {
  const rows = lines.filter((line) => line.startsWith('| ')).map(cells);
  return new Map(rows.filter((row) => first.test(row[0] ?? '')).map((row) => [row[0] ?? '', row]));
}

beforeAll(async () => {
  guarded = await digests(GUARDED);
  catalogue = await loadCatalogue(CATALOGUE_FIXTURE);
  rules = loadRules(RULES_PATH, RULES_ENV);
  golden = await readGoldenSet('GS-CO-75', GOLDEN_SAMPLE);
  replay = replayOutputSchema.parse(JSON.parse(await readFile(REPLAY_SAMPLE, 'utf8')));
  exceptionsList = await loadExceptionsList(EXCEPTIONS_FIXTURE);
  exceptions = exceptionEntries(exceptionsList);
  decisionList = await loadDecisionList(DECISIONS_FIXTURE);
  unavailable = fixtureStatusSchema.parse(JSON.parse(await readFile(UNAVAILABLE_FIXTURE, 'utf8')));

  const known = knownIssueScenario();
  cases = {
    pass: { scenario: scenarioById(catalogue, 'GS-CO-75'), golden, replay },
    fail: {
      scenario: derive('GS-CO-73'),
      golden: retarget(golden, 'GS-CO-73'),
      replay: retitled(retarget(replay, 'GS-CO-73'), CHANGED_TITLE),
    },
    excepted: {
      scenario: derive('GS-CO-04'),
      golden: retarget(golden, 'GS-CO-04'),
      replay: retitled(retarget(replay, 'GS-CO-04'), CHANGED_TITLE),
      opts: { exceptions: [...exceptions, titleEntry('GS-CO-04', { decision: 'preserve', status: 'accepted' })] },
    },
    halted: {
      scenario: derive('GS-CO-77', { covers: [HALTED_KEY] }),
      golden: retarget(golden, 'GS-CO-77', { routeKey: HALTED_KEY }),
      replay: halt(replay),
    },
    'known-issue': {
      scenario: known,
      golden: loginSide(golden, known, 'same'),
      replay: loginSide(replay, known, 'changed'),
    },
    withheld: withheldCase(WITHHELD_KEY),
    [FIXTURES_UNAVAILABLE]: {
      scenario: derive('GS-CO-06', { fixtures: 'required' }),
      golden: null,
      replay: null,
      opts: { fixtures: unavailable },
    },
  };
});

afterAll(async () => {
  expect(await digests(GUARDED)).toStrictEqual(guarded);
});

describe('classifyScenario', () => {
  it('passes the sample replay whose normalised steps equal the golden set', () => {
    expect(classify(cases.pass)).toStrictEqual({
      result: 'pass',
      reason: null,
      differences: [],
      exceptionId: null,
      decisionListRef: null,
    });
  });

  it('fails a replay whose envelope title differs, naming the step and path', () => {
    expect(classify(cases.fail)).toStrictEqual({
      result: 'fail',
      reason: '1 unlisted difference',
      differences: [TITLE_DIFFERENCE],
      exceptionId: null,
      decisionListRef: null,
    });
  });

  it('excepts the same difference under an accepted entry for its scenario and route key', () => {
    expect(classify(cases.excepted)).toStrictEqual({
      result: 'excepted',
      reason: null,
      differences: [{ ...TITLE_DIFFERENCE, exceptionId: TITLE_ENTRY_ID }],
      exceptionId: TITLE_ENTRY_ID,
      decisionListRef: null,
    });
  });

  it.each<[ExceptionEntry['status'], ExceptionEntry['decision'], ParityResult]>([
    ['accepted', 'preserve', 'excepted'],
    ['accepted', 'fix', 'excepted'],
    ['open', 'preserve', 'excepted'],
    ['open', 'fix', 'fail'],
    ['halted', 'preserve', 'fail'],
  ])('an entry %s with decision %s leaves the title difference %s', (status, decision, result) => {
    const verdict = classify({
      ...cases.excepted,
      opts: { exceptions: [...exceptions, titleEntry('GS-CO-04', { decision, status })] },
    });
    expect(verdict.result).toBe(result);
    expect(verdict.exceptionId).toBe(result === 'excepted' ? TITLE_ENTRY_ID : null);
  });

  it('halts a replay recording an EquivalenceImpossible case, linked to its halted entry', () => {
    const verdict = classify(cases.halted);
    expect(verdict).toStrictEqual({
      result: 'halted',
      reason: entryById(RENDITION_ID).reason,
      differences: [],
      exceptionId: RENDITION_ID,
      decisionListRef: null,
    });
    expect(entryById(verdict.exceptionId ?? '')).toMatchObject({
      scenario: 'GS-CO-77',
      routeKey: HALTED_KEY,
      status: 'halted',
    });
  });

  it('still compares a halted replay with its golden set and fails an unlisted difference', () => {
    expect(classify({ ...cases.halted, replay: halt(retitled(replay, CHANGED_TITLE)) })).toStrictEqual({
      result: 'fail',
      reason: '1 unlisted difference',
      differences: [TITLE_DIFFERENCE],
      exceptionId: RENDITION_ID,
      decisionListRef: null,
    });
  });

  it('reports a difference only at a masked location as a known issue', () => {
    const { golden: captured } = cases['known-issue'];
    expect(captured?.steps.map((step) => step.normalised.maskedPaths)).toStrictEqual([
      { 'auth.cookies[0].rotation': 'session-rotation' },
    ]);
    const verdict = classify(cases['known-issue']);
    expect(verdict).toStrictEqual({
      result: 'known-issue',
      reason: null,
      differences: [
        {
          step: 'login',
          path: 'auth.cookies[0].rotation',
          kind: 'changed',
          expected: 'same',
          actual: 'changed',
          classification: 'known-issue',
          maskId: 'session-rotation',
        },
      ],
      exceptionId: null,
      decisionListRef: null,
    });
    expect(verdict.differences.every((d) => d.classification === 'known-issue' && d.maskId !== undefined)).toBe(true);
  });

  it('withholds a scenario exercising a decision-list variant, resolving its reference', () => {
    expect(classify(cases.withheld)).toStrictEqual({
      result: 'withheld',
      reason: null,
      differences: [],
      exceptionId: null,
      decisionListRef: [WITHHELD_REF],
    });
    expect(decisionList.actionVariants.map((variant) => variant.routeKey)).toContain(WITHHELD_KEY);
  });

  it.each<[string, () => Case, string, string | null]>([
    [
      'declared on the scenario',
      () => {
        const scenario = derive('GS-ID-09', {
          service: 'identity',
          role: 'admin',
          covers: [WITHHELD_KEY],
          expected: 'withheld',
          decisionListRef: WITHHELD_KEY,
        });
        return { scenario, golden: retarget(golden, scenario.id), replay: retarget(replay, scenario.id) };
      },
      '1 unlisted difference',
      null,
    ],
    ['declared on a step', () => withheldCase(WITHHELD_KEY), '1 unlisted difference', null],
    [
      'declared on a step that also halts',
      () => {
        const withheld = withheldCase(WITHHELD_KEY);
        const halted = { step: WITHHELD_STEP, routeKey: WITHHELD_KEY, reason: 'session-managed', exceptionId: 'EX-ID-HALT' };
        return { ...withheld, replay: withheld.replay === null ? null : { ...withheld.replay, halted: [halted] } };
      },
      '1 unlisted difference; session-managed',
      'EX-ID-HALT',
    ],
  ])(
    'withholds a scenario %s despite an unlisted difference, still reporting it',
    (_title, build, reason, exceptionId) => {
      const withheld = build();
      if (withheld.replay === null) throw new Error('case has no replay');
      const verdict = classify({ ...withheld, replay: retitled(withheld.replay, CHANGED_TITLE) });
      expect(verdict).toStrictEqual({
        result: 'withheld',
        reason,
        differences: [{ ...TITLE_DIFFERENCE, step: withheld.replay.steps[0]?.name }],
        exceptionId,
        decisionListRef: [WITHHELD_REF],
      });
    },
  );

  it.each<[string, (side: ReplayOutput) => ReplayOutput | null, string]>([
    [
      'whose replay run failed',
      (side) => ({ ...side, error: { message: 'gateway answered 502', step: WITHHELD_STEP } }),
      `replay failed at ${WITHHELD_STEP}: gateway answered 502`,
    ],
    ['without replay output', () => null, 'no replay output at ${OPT2_STATE_DIR}/golden/replay/GS-ID-09.json'],
  ])('fails a withheld scenario %s, leaving nothing to compare', (_title, replayOf, reason) => {
    const withheld = withheldCase(WITHHELD_KEY);
    if (withheld.replay === null) throw new Error('case has no replay');
    expect(classify({ ...withheld, replay: replayOf(withheld.replay) })).toStrictEqual({
      result: 'fail',
      reason,
      differences: [],
      exceptionId: null,
      decisionListRef: [WITHHELD_REF],
    });
  });

  it.each<[string, string, DecisionList | undefined]>([
    ['the decision list does not hold', UNKNOWN_KEY, undefined],
    [
      'only a decision-list table withholds',
      WITHHELD_KEY,
      { actionVariants: [], tables: [{ table: 'tusers', withheldEntryPoints: [{ routeKey: WITHHELD_KEY }] }] },
    ],
  ])('throws GoldenConfigError for a withheld route key %s', (_title, key, list) => {
    const { scenario, golden: captured, replay: replayed } = withheldCase(key);
    const opts = { scenario, exceptions, rules, decisionList: list ?? decisionList };
    const run = (): ScenarioVerdict => classifyScenario(captured, replayed, opts);
    expect(run).toThrow(GoldenConfigError);
    expect(run).toThrow(`GS-ID-09: decisionListRef ${key} names no action variant of opt2/decision-list.json`);
  });

  it('skips a fixture-dependent scenario while the legacy fixtures are unavailable', () => {
    expect(classify(cases[FIXTURES_UNAVAILABLE])).toStrictEqual({
      result: 'skipped: fixtures unavailable',
      reason: unavailable.reason,
      differences: [],
      exceptionId: null,
      decisionListRef: null,
    });
  });
});

describe('buildParityReport', () => {
  it('counts one scenario per result and lists them in catalogue order', () => {
    const report = build(AVAILABLE);
    expect(report.summary).toStrictEqual({
      total: 7,
      pass: 1,
      fail: 1,
      excepted: 1,
      halted: 1,
      knownIssue: 1,
      withheld: 1,
      skipped: 1,
    });
    // The report's status is always complete; whether parity passes is main's exit code.
    expect(report.status).toBe('complete');
    expect(report.scenarios.map((s) => [s.id, s.result])).toStrictEqual([
      ['GS-CO-75', 'pass'],
      ['GS-CO-73', 'fail'],
      ['GS-CO-04', 'excepted'],
      ['GS-CO-77', 'halted'],
      ['GS-ID-01', 'known-issue'],
      ['GS-ID-09', 'withheld'],
      ['GS-CO-06', FIXTURES_UNAVAILABLE],
    ]);
    expect(report.scenarios[0]?.evidence).toStrictEqual({
      golden: 'harness/golden/sets/GS-CO-75.json',
      replay: '${OPT2_STATE_DIR}/golden/replay/GS-CO-75.json',
    });
    expect(() => parityReportSchema.parse(JSON.parse(JSON.stringify(report)))).not.toThrow();
  });

  it('lists the withheld scenario as unmet with its decision-list entry and proposal', () => {
    const report = build(AVAILABLE);
    expect(report.unmetWithheld).toStrictEqual([
      { id: 'GS-ID-09', decisionListRef: WITHHELD_REF, proposal: proposalOf(WITHHELD_KEY) },
    ]);
    expect(report.planned).toStrictEqual({
      provenance: 'planning',
      withheld: [{ scenario: 'GS-ID-09', routeKeys: [WITHHELD_KEY], decisionListRef: [WITHHELD_REF] }],
      halted: [],
    });
  });

  it('stamps the pinned SHA and the fixture status while fixtures are available', () => {
    const report = build(AVAILABLE);
    expect(report.sourceSha).toBe(pinnedSha());
    expect(report.generatedAt).toBe(CLOCK().toISOString());
    expect(report.fixtures).toStrictEqual({ available: true, reason: null, source: FIXTURES_SOURCE });
  });

  it('stamps and renders the fixture status while fixtures are unavailable', () => {
    const report = build(unavailable);
    expect(report.fixtures).toStrictEqual({ available: false, reason: unavailable.reason, source: FIXTURES_SOURCE });
    const markdown = renderParityMarkdown(report);
    expect(markdown).toContain(`Fixtures: unavailable (${unavailable.reason}) (from \`${FIXTURES_SOURCE}\`)`);
  });
});

describe('Markdown renderers', () => {
  it('renders the parity body with one row per scenario, its result and its references', () => {
    const report = build(AVAILABLE);
    const lines = renderParityMarkdown(report);
    // The title and Source SHA lines are added on write; main's test reads them from the written files.
    expect(lines[0]).toBe(`Status: ${report.status}`);
    expect(lines.filter((line) => line.startsWith('# ') || line.startsWith('Source SHA:'))).toStrictEqual([]);
    expect(lines).toContain('| total | 7 |');
    for (const result of PARITY_RESULTS) expect(lines).toContain(`| \`${result}\` | 1 |`);

    const rows = rowsBy(lines, /^<a id="GS-/);
    expect([...rows.keys()]).toStrictEqual(report.scenarios.map((s) => `<a id="${s.id}"></a>${s.id}`));
    for (const scenario of report.scenarios) {
      const row = rows.get(`<a id="${scenario.id}"></a>${scenario.id}`) ?? [];
      expect(row[1]).toBe(scenario.service);
      expect(row[2]?.startsWith(`\`${scenario.result}\``)).toBe(true);
    }
    expect(rows.get('<a id="GS-ID-09"></a>GS-ID-09')?.[4]).toContain(`${DECISION_LINK}: \`${WITHHELD_REF}\``);
    expect(rows.get('<a id="GS-CO-77"></a>GS-CO-77')?.[4]).toContain(`${EXCEPTIONS_LINK}: \`${RENDITION_ID}\``);
    expect(rows.get('<a id="GS-CO-04"></a>GS-CO-04')?.[3]).toBe('1 (1 excepted)');
    expect(lines).toContain(`| GS-ID-09 | ${DECISION_LINK}: \`${WITHHELD_REF}\` | ${proposalOf(WITHHELD_KEY)} |`);
  });

  it('renders every exceptions entry with its decision and status, pending a run', () => {
    const lines = renderExceptionsMarkdown(exceptionsList);
    expect(lines.filter((line) => line.startsWith('# ') || line.startsWith('Source SHA:'))).toStrictEqual([]);
    const rows = rowsBy(lines, /^EX-/);
    expect([...rows.keys()]).toStrictEqual([RENDITION_ID, 'EX-SEC-APPRELOAD']);
    const rendition = rows.get(RENDITION_ID) ?? [];
    expect([rendition[1], rendition[2], rendition[4], rendition[5]]).toStrictEqual([
      'GS-CO-77',
      `\`${HALTED_KEY}\`, \`api:file.save{upload=image}\`, \`rest:file.save{upload=image}\``,
      '`preserve`',
      '`halted`',
    ]);
    expect(rendition[6]).toBe(
      'golden `harness/golden/sets/GS-CO-77.json` (pending-run), ' +
        'parity `opt2/reports/parity.md#GS-CO-77` (pending-run)',
    );
    const reload = rows.get('EX-SEC-APPRELOAD') ?? [];
    expect([reload[1], reload[2], reload[4], reload[5]]).toStrictEqual([
      'GS-PS-74',
      '`reload:application`',
      '`fix`',
      '`open`',
    ]);
  });
});

describe('main', () => {
  let root: string;
  let reports: string;
  let goldens: string;
  let exceptionsPath: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'compare-test-'));
    const state = path.join(root, 'state');
    reports = path.join(root, 'reports');
    goldens = path.join(root, 'sets');
    exceptionsPath = path.join(root, 'exceptions-list.json');
    env = { OPT2_STATE_DIR: state, OPT2_REPORTS_DIR: reports, ...RULES_ENV };
    await mkdir(path.join(state, 'golden', 'replay'), { recursive: true });
    await mkdir(goldens);
    await copyFile(REPLAY_SAMPLE, path.join(state, 'golden', 'replay', 'GS-CO-75.json'));
    await copyFile(GOLDEN_SAMPLE, path.join(goldens, 'GS-CO-75.json'));
    await copyFile(EXCEPTIONS_FIXTURE, exceptionsPath);
    const status: FixtureStatus = { ...AVAILABLE, checkedAt: '2026-06-30T00:00:00Z' };
    await writeFile(path.join(state, 'fixtures.json'), JSON.stringify(status), 'utf8');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  /** Runs the CLI over `catalogueFile`, the temp exceptions copy and the mini decision list. */
  function run(catalogueFile: string): ReturnType<typeof main> {
    const flags = ['--catalogue', catalogueFile, '--exceptions', exceptionsPath, '--decision-list', DECISIONS_FIXTURE];
    return main(flags, env, { readGolden: (id) => readGoldenSet(id, path.join(goldens, `${id}.json`)), clock: CLOCK });
  }

  it('writes parity.json and parity.md only under OPT2_REPORTS_DIR and exits 1 for uncaptured scenarios', async () => {
    const outcome = await run(CATALOGUE_FIXTURE);
    expect(outcome).toStrictEqual({
      code: 1,
      summary: {
        total: 3,
        pass: 1,
        fail: 2,
        excepted: 0,
        halted: 0,
        knownIssue: 0,
        withheld: 0,
        skipped: 0,
        parityJson: path.join(reports, 'parity.json'),
        parityMarkdown: path.join(reports, 'parity.md'),
        exceptionsMarkdown: path.join(reports, 'exceptions-list.md'),
      },
    });
    expect((await readdir(reports)).sort()).toStrictEqual(['exceptions-list.md', 'parity.json', 'parity.md']);
    expect(await readdir(root)).not.toContain('exceptions-list.md');

    const report = parityReportSchema.parse(JSON.parse(await readFile(path.join(reports, 'parity.json'), 'utf8')));
    expect(report.sourceSha).toBe(SHA);
    expect(report.generatedAt).toBe(CLOCK().toISOString());
    expect(report.fixtures).toStrictEqual({ ...AVAILABLE, source: FIXTURES_SOURCE });
    expect(report.scenarios.map((s) => [s.id, s.result, s.reason])).toStrictEqual([
      ['GS-ID-01', 'fail', 'no golden set at harness/golden/sets/GS-ID-01.json'],
      ['GS-CO-75', 'pass', null],
      ['GS-PE-01', 'fail', 'no golden set at harness/golden/sets/GS-PE-01.json'],
    ]);

    const parityLines = (await readFile(path.join(reports, 'parity.md'), 'utf8')).split('\n');
    expect(parityLines.slice(0, 3)).toStrictEqual([`# ${PARITY_TITLE}`, `Source SHA: ${SHA}`, '']);

    const exceptionLines = (await readFile(path.join(reports, 'exceptions-list.md'), 'utf8')).split('\n');
    expect(exceptionLines.slice(0, 2)).toStrictEqual([`# ${EXCEPTIONS_TITLE}`, `Source SHA: ${SHA}`]);
    const rows = rowsBy(exceptionLines, /^EX-/);
    expect([...rows].map(([id, row]) => [id, row[4], row[5]])).toStrictEqual([
      [RENDITION_ID, '`preserve`', '`halted`'],
      ['EX-SEC-APPRELOAD', '`fix`', '`open`'],
    ]);
    for (const row of rows.values()) expect(row[6]).toMatch(/\(not in this run\)$/);
    expect(await readFile(exceptionsPath, 'utf8')).toBe(await readFile(EXCEPTIONS_FIXTURE, 'utf8'));
  });

  it('renders the default opt2/exceptions-list.json under OPT2_REPORTS_DIR, leaving opt2/exceptions-list.md unchanged', async () => {
    const flags = ['--catalogue', CATALOGUE_FIXTURE, '--decision-list', DECISIONS_FIXTURE];
    const readGolden = (id: string): Promise<GoldenSet> => readGoldenSet(id, path.join(goldens, `${id}.json`));
    const outcome = await main(flags, env, { readGolden, clock: CLOCK });
    const rendered = path.join(reports, 'exceptions-list.md');
    expect(outcome.summary).toMatchObject({ exceptionsMarkdown: rendered });
    expect((await readFile(rendered, 'utf8')).split('\n').slice(0, 2)).toStrictEqual([
      `# ${EXCEPTIONS_TITLE}`,
      `Source SHA: ${SHA}`,
    ]);
    const committed = opt2Path('exceptions-list.md');
    expect(await digest(committed)).toBe(guarded[committed]);
  });

  it('exits 0 when every compared scenario passes', async () => {
    const catalogueFile = path.join(root, 'catalogue.yaml');
    const doc = { sourceSha: SHA, scenarios: [scenarioById(catalogue, 'GS-CO-75')] };
    await writeFile(catalogueFile, JSON.stringify(doc), 'utf8');
    const outcome = await run(catalogueFile);
    expect(outcome.code).toBe(0);
    expect(outcome.summary).toMatchObject({ total: 1, pass: 1, fail: 0 });
  });
});
