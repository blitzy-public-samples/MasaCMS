// Browser-scenario evidence: the browser record schema, its classification against the capture, and the compare CLI.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldenSet, GoldenStep } from '../../src/golden/capture.js';
import { loadCatalogue, scenarioById, type Scenario } from '../../src/golden/catalogue.js';
import {
  BROWSER_CONSOLE_STEP,
  BROWSER_FINAL_STEP,
  browserDifferences,
  browserRecordSchema,
  browserResultPath,
  classifyScenario,
  main,
  parityReportSchema,
  type ClassifyOptions,
  type ScenarioVerdict,
} from '../../src/golden/compare.js';
import { GoldenConfigError } from '../../src/golden/errors.js';
import type { DomModel } from '../../src/golden/normalise/dom-model.js';
import type { NormalisedStep } from '../../src/golden/normalise/index.js';
import { loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import { pinnedSha } from '../../src/lib/pin.js';

const CATALOGUE_FIXTURE = fileURLToPath(new URL('../fixtures/golden/catalogue.valid.yaml', import.meta.url));
const SHA = pinnedSha();
const OTHER_SHA = 'f'.repeat(40);
const ID = 'GS-ID-02';
const BROWSER = { flow: 'admin-login', console: 'no-new-errors' } as const;
const GATEWAY = 'http://127.0.0.1:8100';
const STRAY_ORIGIN = 'http://127.0.0.1:8500';
const CAPTURED_DATE = '11/317/2026';
const REPLAYED_DATE = '11/318/2026';
const MASKED_DIFFERENCE = {
  step: BROWSER_FINAL_STEP,
  path: 'domModel.maskedText[0].text',
  kind: 'changed',
  expected: CAPTURED_DATE,
  actual: REPLAYED_DATE,
  classification: 'known-issue',
  maskId: 'date-mask',
} as const;

let rules: NormaliseRules;
let base: Scenario;

beforeAll(async () => {
  rules = loadRules(undefined, { PORT: '8500' });
  base = scenarioById(await loadCatalogue(CATALOGUE_FIXTURE), 'GS-ID-01');
});

function browserScenario(id: string = ID): Scenario {
  return { ...base, id, steps: [], browser: BROWSER };
}

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

/** A capture of scenario `id`: one XHR, then the final DOM. */
function goldenOf(id: string = ID): GoldenSet {
  return {
    sourceSha: SHA,
    scenarioId: id,
    capturedAt: '2026-01-01T00:00:00.000Z',
    origin: 'legacy',
    tableVersion: null,
    fixtures: { available: true, reason: null },
    steps: [exchange('xhr-0', 0, 'admin:carch.loadsitemanager'), exchange(BROWSER_FINAL_STEP, 1, 'admin:carch.list')],
    sideEffects: { mail: [], rows: {}, tasks: [], files: [] },
  };
}

/** The complete browser record the interaction suite writes for `golden`, edited by `over`. */
function recordOf(golden: GoldenSet, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSha: SHA,
    scenarioId: golden.scenarioId,
    replayedAt: '2026-01-01T00:00:01.000Z',
    origin: 'gateway',
    tableVersion: 'v0002',
    steps: structuredClone(golden.steps),
    sideEffects: structuredClone(golden.sideEffects),
    halted: [],
    differences: [],
    console: [],
    notes: [],
    foreignOrigins: [],
    generatedBy: 'harness/e2e/ui/interactions.e2e.ts',
    generatedAt: '2026-01-01T00:00:02.000Z',
    ...over,
  };
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = record;
  return rest;
}

/** `steps` with the final DOM step's normalised form extended by `normalised`. */
function editFinalDom(
  steps: readonly GoldenStep[],
  normalised: Partial<NormalisedStep> & { console?: unknown },
): GoldenStep[] {
  return steps.map((step) =>
    step.name === BROWSER_FINAL_STEP ? { ...step, normalised: { ...step.normalised, ...normalised } } : step,
  );
}

/** A final DOM model whose one date-masked text reads `date`. */
function datedDom(date: string): DomModel {
  const empty = { headings: [], labels: [], forms: [], controls: [], buttons: [], links: [], tables: [], alerts: [] };
  return { title: 'Site Manager', ...empty, maskedText: [{ mask: 'date-mask', path: 'td.date', text: date }] };
}

/** `steps` whose final DOM shows `date` under the date mask. */
function withDate(steps: readonly GoldenStep[], date: string): GoldenStep[] {
  return editFinalDom(steps, { domModel: datedDom(date), maskedPaths: { 'domModel.maskedText[0]': 'date-mask' } });
}

/** `steps` with step `name` answering `status`. */
function answered(steps: readonly GoldenStep[], name: string, status: number): GoldenStep[] {
  return steps.map((step) =>
    step.name === name
      ? { ...step, response: { ...step.response, status }, normalised: { ...step.normalised, status } }
      : step,
  );
}

/** The final DOM alone, every captured XHR omitted. */
function finalDomOnly(steps: readonly GoldenStep[]): GoldenStep[] {
  return steps.filter((step) => step.name === BROWSER_FINAL_STEP);
}

function disagreement(recorded: number, recomputed: number): string {
  const counts = `${recorded} recorded, ${recomputed} recomputed`;
  return `browser record differences disagree with its exchanges against the capture (${counts})`;
}

function classify(
  golden: GoldenSet | null,
  record: Record<string, unknown>,
  over: Partial<ClassifyOptions> = {},
): ScenarioVerdict {
  return classifyScenario(golden, null, {
    scenario: browserScenario(),
    exceptions: [],
    rules,
    decisionList: { actionVariants: [], tables: [] },
    browser: browserRecordSchema.parse(record),
    ...over,
  });
}

describe('browserRecordSchema', () => {
  it.each<[string, () => unknown, string]>([
    ['{}', () => ({}), 'differences'],
    ["{result: 'fail'}", () => ({ result: 'fail' }), 'differences'],
    ['without differences', () => without(recordOf(goldenOf()), 'differences'), 'differences'],
    ['without console', () => without(recordOf(goldenOf()), 'console'), 'console'],
    ['without steps', () => without(recordOf(goldenOf()), 'steps'), 'steps'],
    ['without halted', () => without(recordOf(goldenOf()), 'halted'), 'halted'],
    ['without sourceSha', () => without(recordOf(goldenOf()), 'sourceSha'), 'sourceSha'],
    ['without tableVersion', () => without(recordOf(goldenOf()), 'tableVersion'), 'tableVersion'],
    ["of origin 'legacy'", () => recordOf(goldenOf(), { origin: 'legacy' }), 'origin'],
    ['with a step that is no exchange', () => recordOf(goldenOf(), { steps: [{ name: 'x', routeKey: 'y' }] }), 'steps'],
  ])('rejects a record %s', (_title, build, key) => {
    const parsed = browserRecordSchema.safeParse(build());
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path[0])).toContain(key);
  });

  it('keeps the replay output and the browser fields of a complete record', () => {
    const golden = goldenOf();
    const record = browserRecordSchema.parse(recordOf(golden, { result: 'pass', legacy: { steps: [] } }));
    expect(record).toMatchObject({ scenarioId: ID, origin: 'gateway', tableVersion: 'v0002', result: 'pass' });
    expect(record.steps.map((step) => step.name)).toEqual(['xhr-0', BROWSER_FINAL_STEP]);
    expect(record).not.toHaveProperty('legacy');
  });
});

describe('classifyScenario on a browser scenario', () => {
  it.each<[string, () => [GoldenSet | null, Record<string, unknown>, Partial<ClassifyOptions>?], string]>([
    ['a missing golden set', () => [null, recordOf(goldenOf())], `no golden set at harness/golden/sets/${ID}.json`],
    [
      'an unreadable golden set',
      () => [null, recordOf(goldenOf()), { readErrors: { golden: 'off-schema' } }],
      'off-schema',
    ],
    [
      'a golden set of another scenario',
      () => [goldenOf('GS-ID-03'), recordOf(goldenOf())],
      `golden set holds scenario GS-ID-03, not ${ID}`,
    ],
    [
      'a golden set without the final DOM',
      () => [{ ...goldenOf(), steps: [exchange('xhr-0', 0, 'admin:carch.list')] }, recordOf(goldenOf())],
      `golden set holds no ${BROWSER_FINAL_STEP} step`,
    ],
    [
      'a record of another scenario',
      () => [goldenOf(), recordOf(goldenOf(), { scenarioId: 'GS-ID-03' })],
      `browser record holds scenario GS-ID-03, not ${ID}`,
    ],
    [
      'a record of another source SHA',
      () => [goldenOf(), recordOf(goldenOf(), { sourceSha: OTHER_SHA })],
      `browser record was replayed at ${OTHER_SHA}, not the pinned ${SHA}`,
    ],
    [
      'a record of another table version',
      () => [goldenOf(), recordOf(goldenOf(), { tableVersion: 'v0001' })],
      'browser record was replayed under v0001, not v0002',
    ],
    [
      'a record of the default table version when another is expected',
      () => [goldenOf(), recordOf(goldenOf()), { expected: { tableVersion: 'v0001' } }],
      'browser record was replayed under v0002, not v0001',
    ],
    [
      'a record without steps',
      () => [goldenOf(), recordOf(goldenOf(), { steps: [] })],
      'browser record holds no steps',
    ],
    [
      'a record without the final DOM',
      () => [goldenOf(), recordOf(goldenOf(), { steps: [exchange('xhr-0', 0, 'admin:carch.list')] })],
      `browser record holds no ${BROWSER_FINAL_STEP} step`,
    ],
    [
      'a failed flow',
      () => [goldenOf(), recordOf(goldenOf(), { error: { message: 'timed out', step: BROWSER_FINAL_STEP } })],
      `browser flow failed at ${BROWSER_FINAL_STEP}: timed out`,
    ],
    [
      'a capture of another source SHA',
      () => [{ ...goldenOf(), sourceSha: OTHER_SHA }, recordOf(goldenOf())],
      `browser capture was taken at ${OTHER_SHA}, not the pinned ${SHA}`,
    ],
    [
      'a capture whose console is not a list of strings',
      () => {
        const golden = { ...goldenOf(), steps: editFinalDom(goldenOf().steps, { console: [404] }) };
        return [golden, recordOf(golden)];
      },
      `golden set's ${BROWSER_FINAL_STEP} console is not a list of strings`,
    ],
    [
      'a record omitting a captured XHR',
      () => [goldenOf(), recordOf(goldenOf(), { steps: finalDomOnly(goldenOf().steps) })],
      disagreement(0, 1),
    ],
    [
      'a record of a 500 its differences do not report',
      () => [goldenOf(), recordOf(goldenOf(), { steps: answered(goldenOf().steps, 'xhr-0', 500) })],
      disagreement(0, 1),
    ],
    [
      'a record of a console error its differences do not report',
      () => [goldenOf(), recordOf(goldenOf(), { console: ['TypeError: tree is undefined'] })],
      disagreement(0, 1),
    ],
    [
      'a record reporting a difference its exchanges do not show',
      () => [goldenOf(), recordOf(goldenOf(), { differences: [MASKED_DIFFERENCE] })],
      disagreement(1, 0),
    ],
  ])('fails on %s', (_title, build, reason) => {
    const [golden, record, over] = build();
    expect(classify(golden, record, over)).toMatchObject({ result: 'fail', reason });
  });

  it.each<[string, Partial<GoldenSet>, Record<string, unknown>, Partial<ClassifyOptions>]>([
    ['a complete record without differences', {}, {}, {}],
    ['a record of the expected version', {}, { tableVersion: 'v0001' }, { expected: { tableVersion: 'v0001' } }],
    [
      'a capture and record of the expected source SHA',
      { sourceSha: OTHER_SHA },
      { sourceSha: OTHER_SHA },
      { expected: { sourceSha: OTHER_SHA } },
    ],
  ])('passes %s', (_title, goldenEdit, edit, over) => {
    const golden = { ...goldenOf(), ...goldenEdit };
    expect(classify(golden, recordOf(golden, edit), over)).toEqual({
      result: 'pass',
      reason: null,
      differences: [],
      exceptionId: null,
      decisionListRef: null,
    });
  });

  it('reports a masked difference its exchanges show as known-issue', () => {
    const golden = { ...goldenOf(), steps: withDate(goldenOf().steps, CAPTURED_DATE) };
    const record = recordOf(golden, { steps: withDate(golden.steps, REPLAYED_DATE), differences: [MASKED_DIFFERENCE] });
    const verdict = classify(golden, record);
    expect(verdict).toMatchObject({ result: 'known-issue', reason: null, exceptionId: null });
    expect(verdict.differences).toEqual([{ ...MASKED_DIFFERENCE }]);
  });

  it.each<[string, string[] | undefined, (golden: GoldenSet) => Record<string, unknown>, Record<string, unknown>[]]>([
    [
      'console errors beyond the captured ones, counted as a multiset',
      ['Error: legacy'],
      () => ({ console: ['Error: legacy', 'Error: legacy', 'TypeError: tree is undefined'] }),
      [
        { step: BROWSER_CONSOLE_STEP, path: 'console[1]', kind: 'extra', actual: 'Error: legacy' },
        { step: BROWSER_CONSOLE_STEP, path: 'console[2]', kind: 'extra', actual: 'TypeError: tree is undefined' },
      ],
    ],
    [
      'an XHR to another origin',
      undefined,
      () => ({ foreignOrigins: [{ step: 'xhr-0', origin: STRAY_ORIGIN }] }),
      [{ step: 'xhr-0', path: 'request.origin', kind: 'changed', expected: GATEWAY, actual: STRAY_ORIGIN }],
    ],
    [
      'an XHR keyed to another route',
      undefined,
      (golden) => ({
        steps: golden.steps.map((step) => {
          const routeKey = 'admin:carch.list';
          return step.name === 'xhr-0' ? { ...step, routeKey, normalised: { ...step.normalised, routeKey } } : step;
        }),
      }),
      [
        {
          step: 'xhr-0',
          path: 'routeKey',
          kind: 'changed',
          expected: 'admin:carch.loadsitemanager',
          actual: 'admin:carch.list',
        },
      ],
    ],
  ])('recomputes %s and fails on them', (_title, captured, edit, found) => {
    const expected = found.map((d) => ({ ...d, classification: 'difference' }));
    const steps = captured === undefined ? goldenOf().steps : editFinalDom(goldenOf().steps, { console: captured });
    const golden = { ...goldenOf(), steps };
    // Recorded in reverse: the record and the recomputation are compared as multisets.
    const record = recordOf(golden, { ...edit(golden), differences: [...expected].reverse() });
    const opts = { scenario: browserScenario(), rules, gatewayOrigin: GATEWAY };

    expect(browserDifferences(golden, browserRecordSchema.parse(record), opts)).toEqual(expected);
    const verdict = classify(golden, record, { gatewayOrigin: GATEWAY });
    const reason = `${expected.length} unlisted difference${expected.length === 1 ? '' : 's'}`;
    expect(verdict).toMatchObject({ result: 'fail', reason, differences: expected });
  });

  it('throws GoldenConfigError for a capture console that is not a list of strings', () => {
    const golden = { ...goldenOf(), steps: editFinalDom(goldenOf().steps, { console: 'TypeError' }) };
    const record = browserRecordSchema.parse(recordOf(golden));
    const opts = { scenario: browserScenario(), rules, gatewayOrigin: GATEWAY };
    expect(() => browserDifferences(golden, record, opts)).toThrow(GoldenConfigError);
  });
});

describe('main over browser records', () => {
  let root: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'compare-browser-'));
    env = { OPT2_STATE_DIR: path.join(root, 'state'), OPT2_REPORTS_DIR: path.join(root, 'reports'), PORT: '8500' };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), 'utf8');
  }

  /** Writes a catalogue of browser scenarios `ids` and empty lists; returns the CLI flags naming them. */
  async function writeInputs(ids: readonly string[]): Promise<string[]> {
    const files = ['catalogue.yaml', 'exceptions-list.json', 'decision-list.json'].map((name) => path.join(root, name));
    const [catalogue = '', exceptions = '', decisions = ''] = files;
    await writeJson(catalogue, { sourceSha: SHA, scenarios: ids.map((id) => browserScenario(id)) });
    await writeJson(exceptions, []);
    await writeJson(decisions, {});
    return ['--catalogue', catalogue, '--exceptions', exceptions, '--decision-list', decisions];
  }

  async function readReport(): Promise<ReturnType<typeof parityReportSchema.parse>> {
    const file = path.join(env.OPT2_REPORTS_DIR ?? '', 'parity.json');
    return parityReportSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  }

  it('fails an empty record and a record without its capture, and passes a complete one', async () => {
    const flags = await writeInputs(['GS-ID-02', 'GS-ID-03', 'GS-ID-04']);
    await writeJson(browserResultPath('GS-ID-02', env), {});
    await writeJson(browserResultPath('GS-ID-03', env), recordOf(goldenOf('GS-ID-03')));
    await writeJson(browserResultPath('GS-ID-04', env), recordOf(goldenOf('GS-ID-04')));
    const readGolden = async (id: string): Promise<GoldenSet> => {
      if (id === 'GS-ID-04') {
        throw new Error(`golden set of ${id}`, { cause: Object.assign(new Error('absent'), { code: 'ENOENT' }) });
      }
      return goldenOf(id);
    };

    const outcome = await main(flags, env, { readGolden });

    expect(outcome.code).toBe(1);
    expect(outcome.summary).toMatchObject({ total: 3, pass: 1, fail: 2 });
    const report = await readReport();
    expect(Object.fromEntries(report.scenarios.map((s) => [s.id, [s.result, s.reason]]))).toEqual({
      'GS-ID-02': ['fail', expect.stringMatching(/^\$\{OPT2_STATE_DIR\}\/golden\/browser\/GS-ID-02\.json: does not/)],
      'GS-ID-03': ['pass', null],
      'GS-ID-04': ['fail', 'no golden set at harness/golden/sets/GS-ID-04.json'],
    });
  });

  it.each<[string, Record<string, string>, (golden: GoldenSet) => Record<string, unknown>, string]>([
    [
      'a record omitting a captured XHR',
      {},
      (golden) => recordOf(golden, { steps: finalDomOnly(golden.steps) }),
      disagreement(0, 1),
    ],
    [
      'an XHR off the gateway origin the environment names',
      { OPT2_GATEWAY_URL: 'http://127.0.0.1:20100/' },
      (golden) =>
        recordOf(golden, {
          foreignOrigins: [{ step: 'xhr-0', origin: STRAY_ORIGIN }],
          differences: [
            {
              step: 'xhr-0',
              path: 'request.origin',
              kind: 'changed',
              expected: 'http://127.0.0.1:20100',
              actual: STRAY_ORIGIN,
              classification: 'difference',
            },
          ],
        }),
      '1 unlisted difference',
    ],
  ])('exits 1 on %s', async (_title, extraEnv, build, reason) => {
    const flags = await writeInputs([ID]);
    const golden = goldenOf();
    await writeJson(browserResultPath(ID, env), build(golden));

    const outcome = await main(flags, { ...env, ...extraEnv }, { readGolden: async () => golden });

    expect(outcome.code).toBe(1);
    expect(outcome.summary).toMatchObject({ total: 1, pass: 0, fail: 1 });
    expect((await readReport()).scenarios).toEqual([expect.objectContaining({ id: ID, result: 'fail', reason })]);
  });
});
