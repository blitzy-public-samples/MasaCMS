// GS-ID-09's rehearsal crossing is judged against its own legacy set: any unlisted difference fails it and compare.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createLogger } from '@opt2/platform/logging';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoldenSet, GoldenStep } from '../../src/golden/capture.js';
import { loadCatalogue, scenarioById, type Scenario } from '../../src/golden/catalogue.js';
import {
  DECISION_LIST_PATH,
  classifyScenario,
  exceptionEntries,
  loadDecisionList,
  loadExceptionsList,
  main,
  parityReportSchema,
  type DecisionList,
  type ParityResult,
} from '../../src/golden/compare.js';
import type { ExceptionEntry } from '../../src/golden/errors.js';
import type { NormalisedAuth, NormalisedStep } from '../../src/golden/normalise/index.js';
import { loadRules, type NormaliseRules } from '../../src/golden/normalise/rules.js';
import type { ReplayOutput } from '../../src/golden/replay.js';
import { pinnedSha } from '../../src/lib/pin.js';

const ID = 'GS-ID-09';
const SHA = pinnedSha();
const ADOPT_STEP = 'adopt-continue';
const ADOPT_KEY = 'admin:cusers.listusers';
const PAGE_STEP = 'legacy-login-page';
const ADOPTION_ENTRY = 'EX-ADOPT-SESSION-COOKIES';
const NO_AUTH: NormalisedAuth = { cookies: [], redirectTargets: [], wwwAuthenticate: [] };
const CROSSING_SET = `harness/golden/sets/rehearsal/${ID}.json`;

let rules: NormaliseRules;
let scenario: Scenario;
let decisionList: DecisionList;
let adoption: ExceptionEntry;

beforeAll(async () => {
  rules = loadRules(undefined, { PORT: '8500' });
  scenario = scenarioById(await loadCatalogue(), ID);
  decisionList = await loadDecisionList();
  const entry = exceptionEntries(await loadExceptionsList()).find((candidate) => candidate.id === ADOPTION_ENTRY);
  if (entry === undefined) throw new Error(`opt2/exceptions-list.json holds no ${ADOPTION_ENTRY}`);
  adoption = entry;
});

/** Site navigation of a legacy front-end page, one link per content node. */
function navigation(titles: readonly string[]): NonNullable<NormalisedStep['domModel']> {
  return {
    title: 'Home',
    headings: [],
    labels: [],
    forms: [],
    controls: [],
    buttons: [],
    links: titles.map((text) => ({ text, href: `/${text.toLowerCase().replaceAll(' ', '-')}/` })),
    tables: [],
    alerts: [],
    maskedText: [],
  };
}

/** A legacy capture of GS-ID-09, every step answering 200 without cookies; the page step renders `nav`'s links. */
function goldenOf(nav: readonly string[]): GoldenSet {
  const steps = scenario.steps.map((step, index): GoldenStep => {
    const routeKey = step.decisionListRef ?? (step.name === ADOPT_STEP ? ADOPT_KEY : `admin:${step.name}`);
    const normalised: NormalisedStep = { name: step.name, index, routeKey, status: 200, auth: NO_AUTH, maskedPaths: {} };
    if (step.name === PAGE_STEP) normalised.domModel = navigation(nav);
    return {
      name: step.name,
      index,
      routeKey,
      request: { method: 'GET', url: '/admin/', headers: {}, body: { kind: 'none' } },
      response: { status: 200, headers: {}, body: '', rawSha256: '0'.repeat(64) },
      normalised,
    };
  });
  return {
    sourceSha: SHA,
    scenarioId: ID,
    capturedAt: '2026-01-01T00:00:00.000Z',
    origin: 'legacy',
    tableVersion: null,
    fixtures: { available: true, reason: null },
    steps,
    sideEffects: { mail: [], rows: {}, files: [] },
  };
}

/** The gateway replay of `golden` under `tableVersion`, `edit` applied to a copy of its exchanges. */
function replayOf(golden: GoldenSet, tableVersion: string, edit: (steps: GoldenStep[]) => void = () => {}): ReplayOutput {
  const steps = structuredClone(golden.steps);
  edit(steps);
  return {
    sourceSha: SHA,
    scenarioId: ID,
    replayedAt: '2026-01-01T00:00:01.000Z',
    origin: 'gateway',
    tableVersion,
    steps,
    sideEffects: structuredClone(golden.sideEffects),
    halted: [],
  };
}

function step(steps: GoldenStep[], name: string): GoldenStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no step ${name}`);
  return found;
}

/** adopt-continue answering `status` through the gateway. */
const answering =
  (status: number) =>
  (steps: GoldenStep[]): void => {
    const adopt = step(steps, ADOPT_STEP);
    adopt.response.status = status;
    adopt.normalised.status = status;
  };

/** adopt-continue re-emitting the adopted session's CFID and CFTOKEN, as identity's adoption does. */
function adoptedCookies(steps: GoldenStep[]): void {
  const cookie = (name: string): NormalisedAuth['cookies'][number] => ({
    hop: 0,
    httpOnly: true,
    name,
    path: '/',
    persistence: 'persistent',
    rotation: 'changed',
    secure: false,
    value: '<token>',
  });
  step(steps, ADOPT_STEP).normalised.auth = { ...NO_AUTH, cookies: [cookie('CFID'), cookie('CFTOKEN')] };
}

/** The legacy page rendering `nav` through the gateway. */
const rendering =
  (nav: readonly string[]) =>
  (steps: GoldenStep[]): void => {
    step(steps, PAGE_STEP).normalised.domModel = navigation(nav);
  };

const NAV = ['Home', 'About Us', 'News'];
const DECISION_REFS = [
  'opt2/decision-list.json#actionVariants/admin:cusers.update{type=2,action=delete}',
  'opt2/decision-list.json#actionVariants/page:render',
  'opt2/decision-list.json#actionVariants/admin:ceditprofile.update{extdata}',
];

describe('classifyScenario on a rehearsal crossing', () => {
  it.each<{
    title: string;
    edit: (steps: GoldenStep[]) => void;
    result: ParityResult;
    reason: string | null;
    exceptionId: string | null;
  }>([
    { title: 'matches its capture', edit: () => {}, result: 'pass', reason: null, exceptionId: null },
    {
      title: 're-emits the adopted session cookies the exceptions list excuses',
      edit: adoptedCookies,
      result: 'excepted',
      reason: null,
      exceptionId: ADOPTION_ENTRY,
    },
    {
      title: 'answers 503 at adopt-continue where legacy answered 200',
      edit: answering(503),
      result: 'fail',
      reason: '1 unlisted difference',
      exceptionId: null,
    },
    {
      title: 'renders site navigation the capture did not see on a withheld step',
      edit: rendering([...NAV, 'sample.pdf']),
      result: 'fail',
      reason: '1 unlisted difference',
      exceptionId: null,
    },
  ])('$title: $result under v0003, its withheld variants informational', ({ edit, result, reason, exceptionId }) => {
    const golden = goldenOf(NAV);
    const opts = { scenario, exceptions: [adoption], rules, decisionList };

    const crossing = classifyScenario(golden, replayOf(golden, 'v0003', edit), {
      ...opts,
      expected: { tableVersion: 'v0003' },
      crossing: true,
    });
    const v0002 = classifyScenario(golden, replayOf(golden, 'v0002', edit), opts);

    expect(crossing).toMatchObject({ result, reason, exceptionId, decisionListRef: DECISION_REFS });
    expect(crossing.differences.every((d) => (d.exceptionId === undefined) === (result !== 'excepted'))).toBe(true);
    expect(v0002.result).toBe('withheld');
  });
});

describe('main on a rehearsal crossing', () => {
  let root: string;
  let env: Record<string, string>;
  let flags: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'compare-crossing-'));
    env = { OPT2_STATE_DIR: path.join(root, 'state'), OPT2_REPORTS_DIR: path.join(root, 'reports'), PORT: '8500' };
    const catalogue = path.join(root, 'catalogue.yaml');
    const exceptions = path.join(root, 'exceptions-list.json');
    await writeJson(catalogue, { sourceSha: SHA, scenarios: [scenario] });
    await writeJson(exceptions, { entries: [adoption] });
    flags = ['--catalogue', catalogue, '--exceptions', exceptions, '--decision-list', DECISION_LIST_PATH];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), 'utf8');
  }

  const silent = createLogger({
    service: 'test',
    version: '1',
    env: 'local',
    destination: new Writable({ write: (_chunk, _encoding, done) => done() }),
  });

  it.each<{ title: string; edit: (steps: GoldenStep[]) => void; code: number; result: ParityResult }>([
    { title: 'its adopt-continue answers 503', edit: answering(503), code: 1, result: 'fail' },
    { title: 'only the excused adopted session cookies differ', edit: adoptedCookies, code: 0, result: 'excepted' },
  ])('compares the crossing with its own set when $title: exit $code, $result', async ({ edit, code, result }) => {
    // Captured at its catalogue position, before later scenarios added content to the site navigation.
    const own = goldenOf(NAV);
    // Captured again just before the GS-PE-RH sets, as the stage 8 crossing sees legacy.
    const crossingSet = goldenOf([...NAV, 'sample.pdf', 'sample.png']);
    const read: [string, boolean][] = [];
    const readGolden = async (id: string, crossing: boolean): Promise<GoldenSet> => {
      read.push([id, crossing]);
      return crossing ? crossingSet : own;
    };
    const replayDir = path.join(env.OPT2_STATE_DIR ?? '', 'golden', 'replay');
    await writeJson(path.join(replayDir, `${ID}.json`), replayOf(own, 'v0002'));
    await writeJson(path.join(replayDir, 'rehearsal', `${ID}.json`), replayOf(crossingSet, 'v0003', edit));

    const outcome = await main(flags, env, { readGolden, logger: silent });

    expect(read).toEqual([
      [ID, false],
      [ID, true],
    ]);
    expect(outcome).toMatchObject({
      code,
      summary: { total: 1, withheld: 1, fail: 0, rehearsalCrossings: { total: 1, fail: code, excepted: 1 - code } },
    });
    const report = parityReportSchema.parse(
      JSON.parse(await readFile(path.join(env.OPT2_REPORTS_DIR ?? '', 'parity.json'), 'utf8')),
    );
    expect(report.scenarios.map((row) => [row.id, row.result])).toEqual([[ID, 'withheld']]);
    expect(report.rehearsalCrossings).toMatchObject([
      {
        id: ID,
        tableVersion: 'v0003',
        result,
        decisionListRef: DECISION_REFS,
        evidence: { golden: CROSSING_SET, replay: `\${OPT2_STATE_DIR}/golden/replay/rehearsal/${ID}.json` },
      },
    ]);
  });

  it('fails the crossing when its own set was never captured, even though the scenario set matches', async () => {
    const own = goldenOf(NAV);
    const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const readGolden = async (_id: string, crossing: boolean): Promise<GoldenSet> => {
      if (crossing) throw missing;
      return own;
    };
    const replayDir = path.join(env.OPT2_STATE_DIR ?? '', 'golden', 'replay');
    await writeJson(path.join(replayDir, `${ID}.json`), replayOf(own, 'v0002'));
    await writeJson(path.join(replayDir, 'rehearsal', `${ID}.json`), replayOf(own, 'v0003'));

    const outcome = await main(flags, env, { readGolden, logger: silent });

    expect(outcome).toMatchObject({ code: 1, summary: { rehearsalCrossings: { total: 1, fail: 1 } } });
    const report = parityReportSchema.parse(
      JSON.parse(await readFile(path.join(env.OPT2_REPORTS_DIR ?? '', 'parity.json'), 'utf8')),
    );
    expect(report.rehearsalCrossings?.[0]).toMatchObject({ result: 'fail', reason: `no golden set at ${CROSSING_SET}` });
  });
});
