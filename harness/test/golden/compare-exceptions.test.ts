// Exceptions entries excuse only the differences their selectors describe.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldenSet } from '../../src/golden/capture.js';
import { loadCatalogue, scenarioById, type Scenario } from '../../src/golden/catalogue.js';
import {
  classifyScenario,
  exceptionEntries,
  loadExceptionsList,
  type ParityResult,
  type ScenarioVerdict,
} from '../../src/golden/compare.js';
import type { DifferenceSelector, ExceptionEntry } from '../../src/golden/errors.js';
import type { NormalisedTable } from '../../src/golden/normalise/rows.js';
import { loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import type { ReplayOutput } from '../../src/golden/replay.js';
import { pinnedSha } from '../../src/lib/pin.js';

const CATALOGUE_FIXTURE = fileURLToPath(new URL('../fixtures/golden/catalogue.valid.yaml', import.meta.url));
const SHA = pinnedSha();
const ROUTE_KEY = 'api:content.findone';
const STATUS_SELECTOR: DifferenceSelector = { step: 'findone', path: 'status', kind: ['status'], actual: 500 };
const DECISIONS = { actionVariants: [], tables: [] };

let rules: NormaliseRules;
/** `GS-CO-05`, comparing stored rows as well. */
let scenario: Scenario;

beforeAll(async () => {
  const catalogue = await loadCatalogue(CATALOGUE_FIXTURE);
  rules = loadRules(undefined, { PORT: '8500' });
  const co05 = scenarioById(catalogue, 'GS-CO-05');
  scenario = { ...co05, compare: [...co05.compare, 'rows'] };
});

/** What the replay changes against a golden `findone` answering 200 with no stored rows. */
interface Change {
  status?: number;
  /** Golden and replayed normalised body. */
  body?: [unknown, unknown];
  /** Units the replay stores one row in. */
  rows?: string[];
}

function table(unit: string): NormalisedTable {
  const entries = [{ encoding: `["${unit}"]`, count: 1 }];
  return { unit, legacyTable: unit, columns: [], entries, checksum: '0'.repeat(64) };
}

/** Classifies the replay of `change` against its golden set under `exceptions`. */
function classify(change: Change, exceptions: ExceptionEntry[]): ScenarioVerdict {
  const [goldenBody, replayBody] = change.body ?? [undefined, undefined];
  const golden: GoldenSet = {
    sourceSha: SHA,
    scenarioId: scenario.id,
    capturedAt: '2026-01-01T00:00:00.000Z',
    origin: 'legacy',
    tableVersion: null,
    fixtures: { available: true, reason: null },
    steps: [
      {
        name: 'findone',
        index: 0,
        routeKey: ROUTE_KEY,
        request: { method: 'GET', url: '/_api/json/v1/tenant-a/content/1', headers: {}, body: { kind: 'none' } },
        response: { status: 200, headers: {}, body: '', rawSha256: '0'.repeat(64) },
        normalised: { name: 'findone', index: 0, routeKey: ROUTE_KEY, status: 200, body: goldenBody, maskedPaths: {} },
      },
    ],
    sideEffects: { mail: [], rows: {}, tasks: [], files: [] },
  };
  const steps = structuredClone(golden.steps);
  for (const step of steps) {
    step.response.status = change.status ?? 200;
    step.normalised.status = change.status ?? 200;
    step.normalised.body = replayBody;
  }
  const replay: ReplayOutput = {
    sourceSha: SHA,
    scenarioId: scenario.id,
    replayedAt: '2026-01-01T00:00:01.000Z',
    origin: 'gateway',
    tableVersion: 'v0002',
    steps,
    sideEffects: {
      ...structuredClone(golden.sideEffects),
      rows: Object.fromEntries((change.rows ?? []).map((unit) => [unit, table(unit)])),
    },
    halted: [],
  };
  return classifyScenario(golden, replay, { scenario, exceptions, rules, decisionList: DECISIONS });
}

function entry(matches: DifferenceSelector[] | undefined, over: Partial<ExceptionEntry> = {}): ExceptionEntry {
  return {
    id: 'EX-CO-05',
    scenario: 'GS-CO-05',
    routeKey: ROUTE_KEY,
    difference: 'status',
    ...(matches === undefined ? {} : { matches }),
    decision: 'preserve',
    reason: 'legacy answers 200',
    status: 'open',
    evidence: { golden: 'harness/golden/sets/GS-CO-05.json', replay: 'opt2/reports/parity.json#GS-CO-05' },
    sourceSha: SHA,
    ...over,
  };
}

/** Each difference's path and the entry excusing it, in report order. */
function excuses(verdict: ScenarioVerdict): [string, string | undefined][] {
  return verdict.differences.map((difference) => [difference.path, difference.exceptionId]);
}

describe('exceptions entry selectors', () => {
  it('excuses the declared difference and fails an unrelated one on the same step', () => {
    const verdict = classify({ status: 500, body: [{ title: 'a' }, { title: 'b' }] }, [entry([STATUS_SELECTOR])]);
    expect(verdict).toMatchObject({ result: 'fail', reason: '1 unlisted difference', exceptionId: 'EX-CO-05' });
    expect(excuses(verdict)).toStrictEqual([
      ['body.title', undefined],
      ['status', 'EX-CO-05'],
    ]);
  });

  it('fails a side-effect difference under an entry selecting only a step difference', () => {
    const verdict = classify({ status: 500, rows: ['tusers'] }, [entry([STATUS_SELECTOR])]);
    expect(verdict).toMatchObject({ result: 'fail', reason: '1 unlisted difference' });
    expect(excuses(verdict)).toStrictEqual([
      ['status', 'EX-CO-05'],
      ['sideEffects.rows.tusers', undefined],
    ]);
  });

  it.each<[string, ParityResult, string[], [string, string | undefined][]]>([
    ['its own unit', 'excepted', ['tusers'], [['sideEffects.rows.tusers', 'EX-CO-05']]],
    [
      'its own and another unit',
      'fail',
      ['tusers', 'tusers_history'],
      [
        ['sideEffects.rows.tusers', 'EX-CO-05'],
        ['sideEffects.rows.tusers_history', undefined],
      ],
    ],
  ])('under a stored-row selector an extra row in %s is %s', (_title, result, rows, expected) => {
    const selector: DifferenceSelector = { step: 'sideEffects', path: 'sideEffects.rows.tusers', kind: ['extra'] };
    const verdict = classify({ rows }, [entry([selector])]);
    expect(verdict.result).toBe(result);
    expect(excuses(verdict)).toStrictEqual(expected);
  });

  it.each<[string, Partial<ExceptionEntry>]>([
    ['an open preserve entry', { decision: 'preserve', status: 'open' }],
    ['an accepted entry', { decision: 'fix', status: 'accepted' }],
  ])('%s without selectors excuses nothing', (_title, over) => {
    const verdict = classify({ status: 500 }, [entry(undefined, over)]);
    expect(verdict).toMatchObject({ result: 'fail', exceptionId: null });
    expect(excuses(verdict)).toStrictEqual([['status', undefined]]);
  });

  it('takes each difference from the entry whose selector describes it', () => {
    const exceptions = [
      entry([STATUS_SELECTOR], { id: 'EX-CO-05-STATUS' }),
      entry([{ step: 'findone', path: 'body.title' }], { id: 'EX-CO-05-BODY' }),
    ];
    const verdict = classify({ status: 500, body: [{ title: 'a' }, { title: 'b' }] }, exceptions);
    expect(verdict).toMatchObject({ result: 'excepted', exceptionId: 'EX-CO-05-BODY' });
    expect(excuses(verdict)).toStrictEqual([
      ['body.title', 'EX-CO-05-BODY'],
      ['status', 'EX-CO-05-STATUS'],
    ]);
  });

  it.each<[string, ParityResult, [unknown, unknown], string, string]>([
    ['its own path', 'excepted', [{ title: 'a' }, { title: 'b' }], 'body.title', 'body.title'],
    ['a child key', 'excepted', [{ title: { x: 1 } }, { title: { x: 2 } }], 'body.title', 'body.title.x'],
    ['an array element', 'excepted', [{ title: ['a'] }, { title: ['b'] }], 'body.title', 'body.title[0]'],
    ['a sibling sharing its prefix', 'fail', [{ titles: 'a' }, { titles: 'b' }], 'body.title', 'body.titles'],
    ['its parent', 'fail', [{ title: 'a' }, { title: 'b' }], 'body.title.x', 'body.title'],
  ])('under a path selector a difference at %s is %s', (_title, result, body, selectorPath, differencePath) => {
    const verdict = classify({ body }, [entry([{ step: 'findone', path: selectorPath }])]);
    expect(verdict.result).toBe(result);
    expect(verdict.differences.map((difference) => difference.path)).toStrictEqual([differencePath]);
  });

  it.each<[string, ParityResult, Partial<DifferenceSelector>]>([
    ['a listed kind', 'excepted', { kind: ['changed', 'status'] }],
    ['an unlisted kind', 'fail', { kind: ['changed'] }],
    ['the golden value', 'excepted', { expected: 200 }],
    ['another golden value', 'fail', { expected: 201 }],
    ['the replayed value', 'excepted', { actual: 500 }],
    ['another replayed value', 'fail', { actual: 503 }],
    ['both values', 'excepted', { expected: 200, actual: 500 }],
    ['another step', 'fail', { step: 'list' }],
  ])('a status difference under a selector naming %s is %s', (_title, result, over) => {
    const verdict = classify({ status: 500 }, [entry([{ step: 'findone', path: 'status', ...over }])]);
    expect(verdict.result).toBe(result);
  });

  it.each<[string, ParityResult, unknown, unknown]>([
    ['a subset of an object', 'excepted', { name: 'x', id: '1' }, { name: 'x' }],
    ['another value of a key', 'fail', { name: 'x' }, { name: 'y' }],
    ['a key the object lacks', 'fail', { name: 'x' }, { name: 'x', id: '1' }],
    ['the same array', 'excepted', ['a', 'b'], ['a', 'b']],
    ['a shorter array', 'fail', ['a', 'b'], ['a']],
    ['array elements as subsets', 'excepted', [{ name: 'x', id: '1' }], [{ name: 'x' }]],
    ['an object for a string', 'fail', 'x', { name: 'x' }],
    ['a string for an object', 'fail', { name: 'x' }, 'x'],
    ['an object for an array', 'fail', ['a'], { 0: 'a' }],
  ])('an extra body matched against %s is %s', (_title, result, replayed, actual) => {
    const selector: DifferenceSelector = { step: 'findone', path: 'body', kind: ['extra'], actual };
    expect(classify({ body: [undefined, replayed] }, [entry([selector])]).result).toBe(result);
  });
});

describe('exceptions list selectors', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'compare-exceptions-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each<[string, unknown]>([
    ['an empty selector list', []],
    ['an empty path', [{ step: 'findone', path: '' }]],
    ['an empty step', [{ step: '', path: 'status' }]],
    ['an empty kind list', [{ step: 'findone', path: 'status', kind: [] }]],
    ['an unknown kind', [{ step: 'findone', path: 'status', kind: ['moved'] }]],
    ['an unknown selector field', [{ step: 'findone', path: 'status', value: 500 }]],
  ])('rejects an entry with %s', async (_title, matches) => {
    const file = path.join(dir, 'exceptions-list.json');
    await writeFile(file, JSON.stringify({ entries: [{ ...entry(undefined), matches }] }), 'utf8');
    await expect(loadExceptionsList(file)).rejects.toThrow(/does not match its schema/);
  });

  it('loads the committed list with EX-ROSTER-POOLMOVE selecting the refused update', async () => {
    const entries = exceptionEntries(await loadExceptionsList());
    const poolMove = entries.find((candidate) => candidate.id === 'EX-ROSTER-POOLMOVE');
    expect(poolMove).toMatchObject({ scenario: 'GS-PE-02', decision: 'preserve', status: 'open' });
    expect(poolMove?.matches).toStrictEqual([{ step: 'update', path: 'status', kind: ['status'], actual: 503 }]);
  });
});
