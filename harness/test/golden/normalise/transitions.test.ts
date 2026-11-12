// Unit tests for per-aggregate state sequences, including steps that compare transitions but no body.
import { beforeAll, describe, expect, it } from 'vitest';
import type { CompareKind, Scenario } from '../../../src/golden/catalogue.js';
import {
  SIDE_EFFECTS_STEP,
  compareNormalised,
  createNormaliseState,
  loadRules,
  normaliseSideEffects,
  normaliseStep,
  type Difference,
  type DifferenceKind,
  type NormalisedRun,
  type NormalisedStep,
  type NormaliseRules,
} from '../../../src/golden/normalise/index.js';
import type { SideEffects } from '../../../src/golden/side-effects.js';
import type { StepRecord } from '../../../src/golden/steps.js';

const A = '2B3C4D5E-6F7A-4B8C-9D0E1F2A3B4C5D6E';
const B = '3C4D5E6F-7A8B-4C9D-8E0F1A2B3C4D5E6F';
const STEPS = ['submit', 'approve'] as const;
const JSON_TYPE = 'application/json';
const AGGREGATE_PATH = `${SIDE_EFFECTS_STEP}.transitions.<id:1>`;
const NO_EFFECTS: SideEffects = { mail: [], rows: {}, tasks: [], files: [] };

type StepName = (typeof STEPS)[number];

let rules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
});

/** A finance scenario of the `STEPS`; `stepCompare` sets a step's own `compare`. */
function scenario(compare: CompareKind[], stepCompare: Partial<Record<StepName, CompareKind[]>> = {}): Scenario {
  return {
    id: 'GS-FI-01',
    title: 'finance lifecycle',
    service: 'finance',
    role: 'admin',
    sessions: {},
    seedRefs: [],
    steps: STEPS.map((name) => ({
      name,
      method: 'POST',
      route: `/finance/records/x/${name}`,
      csrf: 'none',
      ...(stepCompare[name] === undefined ? {} : { compare: stepCompare[name] }),
    })),
    compare,
    normalisationOverrides: {},
    covers: [],
    tableVersion: 'v0002',
  } as unknown as Scenario;
}

function record(index: number, text: string, contentType = JSON_TYPE): StepRecord {
  const name = STEPS[index] ?? `step${index}`;
  return {
    name,
    index,
    routeKey: `finance:records.${name}`,
    request: { method: 'POST', url: `/finance/records/x/${name}`, headers: {}, body: { kind: 'none' } },
    response: {
      status: 200,
      headers: { 'content-type': contentType },
      contentType,
      sha256: '0'.repeat(64),
      hops: [],
      text,
    },
    extracted: {},
  };
}

/** One side of `scn`; each body is the JSON response of the step at its index. */
async function run(scn: Scenario, bodies: readonly unknown[]): Promise<NormalisedRun> {
  const ctx = { state: createNormaliseState(), rules, scenario: scn };
  const steps: NormalisedStep[] = [];
  for (const [index, body] of bodies.entries()) {
    steps.push(await normaliseStep(record(index, JSON.stringify(body)), ctx));
  }
  return { steps, sideEffects: await normaliseSideEffects(NO_EFFECTS, ctx, steps) };
}

const entity = (id: string, state: string): Record<string, unknown> => ({ id, state });
const envelope = (data: unknown): Record<string, unknown> => ({ apiversion: 'v1', method: 'save', params: {}, data });

const TRANSITIONS_ONLY: [string, Scenario][] = [
  ['the scenario compares status and transitions', scenario(['status', 'transitions'])],
  [
    'each step compares status and transitions',
    scenario(['status', 'envelope', 'transitions'], {
      submit: ['status', 'transitions'],
      approve: ['status', 'transitions'],
    }),
  ],
];

const LIFECYCLE = [entity(A, 'SUBMITTED'), entity(A, 'APPROVED')];

const SEQUENCE_CASES: [string, unknown[], unknown[], [DifferenceKind, unknown, unknown] | undefined][] = [
  [
    'a changed state',
    LIFECYCLE,
    [entity(B, 'SUBMITTED'), entity(B, 'REJECTED')],
    ['changed', ['SUBMITTED', 'APPROVED'], ['SUBMITTED', 'REJECTED']],
  ],
  [
    'a changed state inside envelopes',
    LIFECYCLE.map(envelope),
    [envelope(entity(B, 'SUBMITTED')), envelope(entity(B, 'REJECTED'))],
    ['changed', ['SUBMITTED', 'APPROVED'], ['SUBMITTED', 'REJECTED']],
  ],
  ['no state on replay', LIFECYCLE, [{ id: B }, { id: B }], ['missing', ['SUBMITTED', 'APPROVED'], undefined]],
  [
    'no aggregate id on replay',
    LIFECYCLE,
    [{ state: 'SUBMITTED' }, { state: 'APPROVED' }],
    ['missing', ['SUBMITTED', 'APPROVED'], undefined],
  ],
  [
    'the same states in another order',
    LIFECYCLE,
    [entity(B, 'APPROVED'), entity(B, 'SUBMITTED')],
    ['order', ['SUBMITTED', 'APPROVED'], ['APPROVED', 'SUBMITTED']],
  ],
  ['an equal sequence under other raw ids', LIFECYCLE, [entity(B, 'SUBMITTED'), entity(B, 'APPROVED')], undefined],
];

describe('state transitions of steps that compare no body', () => {
  describe.each(TRANSITIONS_ONLY)('when %s', (_label, scn) => {
    it.each(SEQUENCE_CASES)('reports %s', async (_case, golden, replay, want) => {
      const found = compareNormalised(await run(scn, golden), await run(scn, replay), { rules, scenario: scn });
      const expected: Difference[] =
        want === undefined
          ? []
          : [
              {
                step: SIDE_EFFECTS_STEP,
                path: AGGREGATE_PATH,
                kind: want[0],
                expected: want[1],
                actual: want[2],
                classification: 'difference',
              },
            ];
      expect(found).toEqual(expected);
    });

    it('compares no other body field and keeps no envelope or body', async () => {
      const golden = await run(scn, [{ ...entity(A, 'SUBMITTED'), amount: 10 }, envelope(entity(A, 'APPROVED'))]);
      const replay = await run(scn, [
        { ...entity(B, 'SUBMITTED'), amount: 99, note: 'changed' },
        { ...envelope(entity(B, 'APPROVED')), method: 'approve' },
      ]);

      expect(compareNormalised(golden, replay, { rules, scenario: scn })).toEqual([]);
      for (const step of [...golden.steps, ...replay.steps]) {
        expect(step).not.toHaveProperty('envelope');
        expect(step).not.toHaveProperty('body');
      }
      expect(golden.steps[0]?.transitionBody).toEqual({ amount: 10, id: '<id:1>', state: 'SUBMITTED' });
      expect(golden.sideEffects.transitions).toEqual([{ aggregate: '<id:1>', states: ['SUBMITTED', 'APPROVED'] }]);
    });

    it.each([
      ['an HTML response', 'text/html', `<html><body><p>${A} SUBMITTED</p></body></html>`],
      ['unparseable JSON', JSON_TYPE, `{"id":"${A}","state":`],
    ])('keeps no transition body for %s', async (_label, contentType, text) => {
      const step = await normaliseStep(record(0, text, contentType), {
        state: createNormaliseState(),
        rules,
        scenario: scn,
      });

      expect(step).not.toHaveProperty('transitionBody');
      expect(step).not.toHaveProperty('body');
    });
  });

  it('reads each body once when the scenario also compares the envelope', async () => {
    const bodies = [
      { from: entity(A, 'IN-PROGRESS'), to: entity(A, 'SUBMITTED') },
      envelope(entity(A, 'APPROVED')),
    ];
    const sequence = [{ aggregate: '<id:1>', states: ['IN-PROGRESS', 'SUBMITTED', 'APPROVED'] }];

    const transitionsOnly = await run(scenario(['status', 'transitions']), bodies);
    const withEnvelope = await run(scenario(['status', 'envelope', 'transitions']), bodies);

    expect(transitionsOnly.sideEffects.transitions).toEqual(sequence);
    expect(withEnvelope.sideEffects.transitions).toEqual(sequence);
    expect(withEnvelope.steps.map((step) => step.transitionBody)).toEqual([undefined, undefined]);
  });

  it('leaves steps that compare nothing out of the sequences', async () => {
    const scn = scenario(['status', 'transitions'], { approve: [] });
    const golden = await run(scn, LIFECYCLE);
    const replay = await run(scn, [entity(B, 'SUBMITTED'), entity(B, 'REJECTED')]);

    expect(golden.steps[1]).not.toHaveProperty('transitionBody');
    expect(golden.sideEffects.transitions).toEqual([{ aggregate: '<id:1>', states: ['SUBMITTED'] }]);
    expect(compareNormalised(golden, replay, { rules, scenario: scn })).toEqual([]);
  });
});
