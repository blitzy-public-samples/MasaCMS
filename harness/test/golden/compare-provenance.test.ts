// HTTP parity evidence counts only as the scenario's legacy capture and gateway replay at the pin and version.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@opt2/platform/logging';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldenSet, GoldenStep } from '../../src/golden/capture.js';
import { FIXTURES_UNAVAILABLE, loadCatalogue, scenarioById, type Scenario } from '../../src/golden/catalogue.js';
import {
  classifyScenario,
  main,
  parityReportSchema,
  type ClassifyOptions,
  type DecisionList,
  type ParityResult,
  type ScenarioVerdict,
} from '../../src/golden/compare.js';
import type { ExceptionEntry } from '../../src/golden/errors.js';
import { loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import type { ReplayOutput } from '../../src/golden/replay.js';
import { pinnedSha } from '../../src/lib/pin.js';

const CATALOGUE_FIXTURE = fileURLToPath(new URL('../fixtures/golden/catalogue.valid.yaml', import.meta.url));
const SHA = pinnedSha();
const OTHER_SHA = 'f'.repeat(40);
const ID = 'GS-CO-05';
const ROUTE_KEY = 'api:content.findone';
const WITHHELD_KEY = 'admin:cusers.update{type=2,action=add}';
const NO_DECISIONS: DecisionList = { actionVariants: [], tables: [] };
const WITHHELD_DECISIONS: DecisionList = {
  actionVariants: [{ routeKey: WITHHELD_KEY, proposal: 'Carry the add variant.' }],
  tables: [],
};
const HALT = { step: 'findone', routeKey: ROUTE_KEY, reason: 'renditions differ', exceptionId: 'EX-FILE-RENDITION' };
const STALE_REPLAY = `replay output was replayed at ${OTHER_SHA}, not the pinned ${SHA}`;
const SKIPPED: Pick<GoldenSet, 'steps' | 'skipped'> = { steps: [], skipped: FIXTURES_UNAVAILABLE };

let rules: NormaliseRules;
let co05: Scenario;
let pe01: Scenario;
let rh01: Scenario;

beforeAll(async () => {
  const catalogue = await loadCatalogue(CATALOGUE_FIXTURE);
  rules = loadRules(undefined, { PORT: '8500' });
  co05 = scenarioById(catalogue, ID);
  pe01 = scenarioById(catalogue, 'GS-PE-01');
  rh01 = scenarioById(catalogue, 'GS-PE-RH-01');
});

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

/** A legacy capture of `scenario` at the pin, one exchange per step. */
function goldenOf(scenario: Scenario): GoldenSet {
  return {
    sourceSha: SHA,
    scenarioId: scenario.id,
    capturedAt: '2026-01-01T00:00:00.000Z',
    origin: 'legacy',
    tableVersion: null,
    fixtures: { available: true, reason: null },
    steps: scenario.steps.map((step, i) => exchange(step.name, i, scenario.covers[i] ?? ROUTE_KEY)),
    sideEffects: { mail: [], rows: {}, tasks: [], files: [] },
  };
}

/** The gateway replay of `golden` under the scenario's version, its exchanges identical to the capture's. */
function replayOf(golden: GoldenSet, tableVersion = 'v0002'): ReplayOutput {
  return {
    sourceSha: SHA,
    scenarioId: golden.scenarioId,
    replayedAt: '2026-01-01T00:00:01.000Z',
    origin: 'gateway',
    tableVersion,
    steps: structuredClone(golden.steps),
    sideEffects: structuredClone(golden.sideEffects),
    halted: [],
  };
}

/** `value` with `over` merged in and the `drop` keys removed, as a reader that skipped its schema would hold it. */
function forged<T extends object>(value: T, over: Record<string, unknown>, drop: string[] = []): T {
  const merged: Record<string, unknown> = { ...value, ...over };
  for (const key of drop) delete merged[key];
  return merged as T;
}

/** `golden`'s replay with its first step answering `status`. */
function answering(golden: GoldenSet, status: number): ReplayOutput {
  const replay = replayOf(golden);
  const [step] = replay.steps;
  if (step === undefined) throw new Error('no step');
  step.response.status = status;
  step.normalised.status = status;
  return replay;
}

function classify(
  golden: GoldenSet | null,
  replay: ReplayOutput | null,
  over: Partial<ClassifyOptions> = {},
): ScenarioVerdict {
  return classifyScenario(golden, replay, {
    scenario: co05,
    exceptions: [],
    rules,
    decisionList: NO_DECISIONS,
    ...over,
  });
}

function entry(over: Partial<ExceptionEntry> = {}): ExceptionEntry {
  return {
    id: 'EX-CO-05',
    scenario: ID,
    routeKey: ROUTE_KEY,
    difference: 'status',
    matches: [{ step: 'findone', path: 'status', kind: ['status'], actual: 500 }],
    decision: 'preserve',
    reason: 'legacy answers 200',
    status: 'open',
    evidence: { golden: `harness/golden/sets/${ID}.json`, replay: `opt2/reports/parity.json#${ID}` },
    sourceSha: SHA,
    ...over,
  };
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

function failed(reason: string): ScenarioVerdict {
  return { result: 'fail', reason, differences: [], exceptionId: null, decisionListRef: null };
}

type Sides = () => [GoldenSet | null, ReplayOutput | null, Partial<ClassifyOptions>?];

describe('classifyScenario on HTTP evidence provenance', () => {
  it.each<[string, Sides]>([
    ['a rehearsal replay under v0003', () => [goldenOf(rh01), replayOf(goldenOf(rh01), 'v0003'), { scenario: rh01 }]],
    [
      'evidence at the expected source SHA',
      () => {
        const golden = { ...goldenOf(co05), sourceSha: OTHER_SHA };
        return [golden, { ...replayOf(golden), sourceSha: OTHER_SHA }, { expected: { sourceSha: OTHER_SHA } }];
      },
    ],
    [
      'a replay under the expected version',
      () => [goldenOf(co05), replayOf(goldenOf(co05), 'v0001'), { expected: { tableVersion: 'v0001' } }],
    ],
  ])('passes %s', (_title, build) => {
    const [golden, replay, over] = build();
    expect(classify(golden, replay, over)).toEqual({
      result: 'pass',
      reason: null,
      differences: [],
      exceptionId: null,
      decisionListRef: null,
    });
  });

  it.each<[string, Sides, string]>([
    [
      'a capture of another scenario',
      () => [{ ...goldenOf(co05), scenarioId: 'GS-CO-06' }, replayOf(goldenOf(co05))],
      `golden set holds scenario GS-CO-06, not ${ID}`,
    ],
    [
      'a capture at another source SHA',
      () => [{ ...goldenOf(co05), sourceSha: OTHER_SHA }, replayOf(goldenOf(co05))],
      `capture was taken at ${OTHER_SHA}, not the pinned ${SHA}`,
    ],
    [
      'a capture without a source SHA',
      () => [forged(goldenOf(co05), {}, ['sourceSha']), replayOf(goldenOf(co05))],
      `capture was taken at undefined, not the pinned ${SHA}`,
    ],
    [
      'a replay output standing in for the capture',
      () => [forged(goldenOf(co05), { origin: 'gateway', tableVersion: 'v0002' }), replayOf(goldenOf(co05))],
      'golden set is not a legacy capture (origin gateway, tableVersion v0002)',
    ],
    [
      'a capture at the pin when another SHA is expected',
      () => [goldenOf(co05), replayOf(goldenOf(co05)), { expected: { sourceSha: OTHER_SHA } }],
      `capture was taken at ${SHA}, not the pinned ${OTHER_SHA}`,
    ],
    [
      'a replay of another scenario',
      () => [goldenOf(co05), { ...replayOf(goldenOf(co05)), scenarioId: 'GS-CO-06' }],
      `replay output holds scenario GS-CO-06, not ${ID}`,
    ],
    [
      'a replay at another source SHA',
      () => [goldenOf(co05), { ...replayOf(goldenOf(co05)), sourceSha: OTHER_SHA }],
      STALE_REPLAY,
    ],
    [
      'a replay without a source SHA',
      () => [goldenOf(co05), forged(replayOf(goldenOf(co05)), {}, ['sourceSha'])],
      `replay output was replayed at undefined, not the pinned ${SHA}`,
    ],
    [
      'a capture standing in for the replay',
      () => [goldenOf(co05), forged(replayOf(goldenOf(co05)), { origin: 'legacy' })],
      'replay output was not replayed through the gateway (origin legacy)',
    ],
    [
      'a replay under v0001',
      () => [goldenOf(co05), replayOf(goldenOf(co05), 'v0001')],
      'replay output was replayed under v0001, not v0002',
    ],
    [
      'a replay under the rehearsal version',
      () => [goldenOf(co05), replayOf(goldenOf(co05), 'v0003')],
      'replay output was replayed under v0003, not v0002',
    ],
    [
      'a rehearsal replay under v0002',
      () => [goldenOf(rh01), replayOf(goldenOf(rh01)), { scenario: rh01 }],
      'replay output was replayed under v0002, not v0003',
    ],
    [
      'a replay under the default version when another is expected',
      () => [goldenOf(co05), replayOf(goldenOf(co05)), { expected: { tableVersion: 'v0001' } }],
      'replay output was replayed under v0002, not v0001',
    ],
  ])('fails on %s although every exchange matches', (_title, build, reason) => {
    const [golden, replay, over] = build();
    expect(classify(golden, replay, over)).toEqual(failed(reason));
  });

  it.each<[string, () => Scenario, (golden: GoldenSet) => ReplayOutput, Partial<ClassifyOptions>, ParityResult]>([
    ['excepted', () => co05, (golden) => answering(golden, 500), { exceptions: [entry()] }, 'excepted'],
    ['halted on a replay halt', () => co05, (golden) => ({ ...replayOf(golden), halted: [HALT] }), {}, 'halted'],
    [
      'halted when declared',
      () => ({ ...co05, expected: 'halted', exceptionId: 'EX-CO-HALT' }),
      (golden) => replayOf(golden),
      {},
      'halted',
    ],
    ['withheld', withheldScenario, (golden) => replayOf(golden), { decisionList: WITHHELD_DECISIONS }, 'withheld'],
  ])('reports %s on valid evidence and fails the same replay at another SHA', (_t, scenarioOf, build, over, result) => {
    const scenario = scenarioOf();
    const golden = goldenOf(scenario);
    expect(classify(golden, build(golden), { scenario, ...over }).result).toBe(result);
    const stale = classify(golden, { ...build(golden), sourceSha: OTHER_SHA }, { scenario, ...over });
    expect(stale).toMatchObject({ result: 'fail', reason: STALE_REPLAY, differences: [], exceptionId: null });
  });

  it.each<[string, Partial<GoldenSet>, Partial<ReplayOutput>, string]>([
    ['a skipped replay at another source SHA', {}, { ...SKIPPED, sourceSha: OTHER_SHA }, STALE_REPLAY],
    [
      'a skipped replay of another scenario',
      {},
      { ...SKIPPED, scenarioId: 'GS-CO-06' },
      `replay output holds scenario GS-CO-06, not ${ID}`,
    ],
    [
      'a skipped replay under another version',
      {},
      { ...SKIPPED, tableVersion: 'v0003' },
      'replay output was replayed under v0003, not v0002',
    ],
    [
      'a skipped capture at another source SHA',
      { ...SKIPPED, sourceSha: OTHER_SHA },
      {},
      `capture was taken at ${OTHER_SHA}, not the pinned ${SHA}`,
    ],
  ])('fails on %s instead of skipping', (_title, goldenEdit, replayEdit, reason) => {
    const golden = goldenOf(co05);
    expect(classify({ ...golden, ...goldenEdit }, { ...replayOf(golden), ...replayEdit })).toEqual(failed(reason));
  });

  it('skips a scenario whose fixtures this run lacks, whatever evidence is present', () => {
    const scenario: Scenario = { ...co05, fixtures: 'required' };
    const golden = goldenOf(scenario);
    const fixtures = { available: false, reason: 'no CREATE SCHEMA' };
    const verdict = classify(golden, { ...replayOf(golden), sourceSha: OTHER_SHA }, { scenario, fixtures });
    expect(verdict).toMatchObject({ result: FIXTURES_UNAVAILABLE, reason: 'no CREATE SCHEMA' });
  });
});

describe('main on HTTP evidence provenance', () => {
  let root: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'compare-provenance-'));
    env = { OPT2_STATE_DIR: path.join(root, 'state'), OPT2_REPORTS_DIR: path.join(root, 'reports'), PORT: '8500' };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), 'utf8');
  }

  it('fails every scenario whose committed capture or replay output is stale', async () => {
    const scenarios = [5, 6, 7, 8].map((n) => ({ ...co05, id: `GS-CO-0${n}` }));
    const catalogue = path.join(root, 'catalogue.yaml');
    const exceptions = path.join(root, 'exceptions-list.json');
    const decisions = path.join(root, 'decision-list.json');
    await writeJson(catalogue, { sourceSha: SHA, scenarios });
    await writeJson(exceptions, []);
    await writeJson(decisions, NO_DECISIONS);
    const goldens = new Map(scenarios.map((scenario) => [scenario.id, goldenOf(scenario)]));
    const golden = (id: string): GoldenSet => {
      const set = goldens.get(id);
      if (set === undefined) throw new Error(`no golden ${id}`);
      return set;
    };
    const replays: Record<string, ReplayOutput> = {
      'GS-CO-05': replayOf(golden('GS-CO-05')),
      'GS-CO-06': { ...replayOf(golden('GS-CO-06')), sourceSha: OTHER_SHA },
      'GS-CO-07': replayOf(golden('GS-CO-07'), 'v0003'),
      'GS-CO-08': replayOf(golden('GS-CO-08')),
    };
    for (const [id, replay] of Object.entries(replays)) {
      await writeJson(path.join(root, 'state', 'golden', 'replay', `${id}.json`), replay);
    }
    const readGolden = async (id: string): Promise<GoldenSet> =>
      id === 'GS-CO-08' ? { ...golden(id), sourceSha: OTHER_SHA } : golden(id);
    const destination = new Writable({ write: (_chunk, _encoding, done) => done() });
    const logger = createLogger({ service: 'test', version: '1', env: 'local', destination });
    const flags = ['--catalogue', catalogue, '--exceptions', exceptions, '--decision-list', decisions];

    const outcome = await main(flags, env, { readGolden, logger });

    expect(outcome).toMatchObject({ code: 1, summary: { total: 4, pass: 1, fail: 3 } });
    const written = await readFile(path.join(root, 'reports', 'parity.json'), 'utf8');
    const report = parityReportSchema.parse(JSON.parse(written));
    expect(Object.fromEntries(report.scenarios.map((s) => [s.id, [s.result, s.reason]]))).toEqual({
      'GS-CO-05': ['pass', null],
      'GS-CO-06': ['fail', STALE_REPLAY],
      'GS-CO-07': ['fail', 'replay output was replayed under v0003, not v0002'],
      'GS-CO-08': ['fail', `capture was taken at ${OTHER_SHA}, not the pinned ${SHA}`],
    });
  });
});
