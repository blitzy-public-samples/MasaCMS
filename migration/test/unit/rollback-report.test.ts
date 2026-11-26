// Unit tests for the rehearsal report's Steps section: transitions whose steps ran more than once, and the run order of a whole rehearsal.
import { describe, expect, it } from 'vitest';

import type { TransitionLogEntry, TransitionStepName } from '../../src/reports/index.js';
import {
  REHEARSAL_SCENARIOS,
  SESSION_SCENARIO,
  renderRollbackReport,
  type FeedRun,
  type RebaselineRecord,
  type ReconciliationRef,
  type ReplayRun,
  type RollbackReportInput,
} from '../../src/rollback/index.js';
import { TEST_SOURCE_SHA } from '../helpers/env.js';

type Step = TransitionLogEntry['steps'][number];
type Cells = [started: string, finished: string, result: string];

const STEP_LABELS = [
  "Quiesce writers of `R`'s units",
  'Drain the people outbox (`people.person.archived.v1`)',
  "Project `R`'s units to completion, including `identity.credential` → `tusers.Password`",
  'Reconcile `R` → `reconciliation/rollback-before.json`',
  'Activate `v0003` and unfreeze',
  "Re-baseline: fresh snapshot, forward feed restarted for `R`'s units",
  'Rehearse GS-PE-RH-01/02/03 through the gateway (served by legacy) and the GS-ID-09 session step across activation',
  'Feed pass',
  'Reconcile → `reconciliation/rollback-after.json`',
];
const NOT_RUN: Cells = ['not-run', 'not-run', 'not-run'];

/** Minute `minute`, second `second` of the transition's hour. */
function t(minute: number, second = 0): string {
  return `2026-06-30T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
}

function attempt(step: number, name: TransitionStepName, started: number, finished?: number, result?: string): Step {
  return {
    step,
    name,
    startedAt: t(started),
    ...(finished === undefined ? {} : { finishedAt: t(finished) }),
    ...(result === undefined ? {} : { result }),
  };
}

/** Steps 1–6 run once and succeed, step `n` from minute `n` to `n + 1`. */
const BEFORE_ACTIVATE: Step[] = [
  attempt(1, 'transition-set', 1, 2, 'ok'),
  attempt(2, 'stop-new-work', 2, 3, 'ok'),
  attempt(3, 'confirm-inflight-finished', 3, 4, 'ok'),
  attempt(4, 'drain-effects', 4, 5, 'ok'),
  attempt(5, 'close-gates', 5, 6, 'ok'),
  attempt(6, 'final-state-and-reconcile', 6, 7, 'ok'),
];

interface TransitionEnd {
  finishedAt: number;
  outcome: 'activated' | 'aborted';
  abortReason?: string;
}

function transition(steps: Step[], end?: TransitionEnd): TransitionLogEntry {
  return {
    transitionId: 'tr-rollback-1',
    from: 'v0002',
    to: 'v0003',
    startedAt: t(0),
    setT: ['people.person'],
    entriesChanged: [],
    legacyWriteEntries: [],
    steps,
    ...(end === undefined ? {} : { finishedAt: t(end.finishedAt), outcome: end.outcome }),
    ...(end?.abortReason === undefined ? {} : { abortReason: end.abortReason }),
  };
}

function reportInput(entry: TransitionLogEntry): RollbackReportInput {
  return {
    sourceSha: TEST_SOURCE_SHA,
    generatedAt: '2026-06-30T12:00:00.000Z',
    set: {
      groups: ['g-roster'],
      units: ['people.person'],
      containsLoginGroup: false,
      sessionModeBefore: 'target-primary',
      sessionModeAfter: 'target-primary',
    },
    transition: entry,
    reconciliation: {
      before: { path: 'reconciliation/rollback-before.json', result: 'not-run' },
      after: { path: 'reconciliation/rollback-after.json', result: 'not-run' },
    },
    scenarios: REHEARSAL_SCENARIOS.map((id) => ({ id, result: 'not-run' })),
    session: { id: SESSION_SCENARIO, result: 'not-run' },
  };
}

/** The lines of the Steps section, from its heading up to the next section's heading. */
function stepsSection(markdown: string): string[] {
  const lines = markdown.split('\n');
  return lines.slice(lines.indexOf('## Steps'), lines.indexOf('## Reconciliation'));
}

/** The Steps section expected for transition rows 1, 2, 3 and 5 and the paragraphs after the table. */
function expectedSection(transitionRows: [Cells, Cells, Cells, Cells], paragraphs: string[]): string[] {
  const [quiesce, drain, project, activate] = transitionRows;
  const cells = [quiesce, drain, project, NOT_RUN, activate, NOT_RUN, NOT_RUN, NOT_RUN, NOT_RUN];
  return [
    '## Steps',
    '',
    '| # | Step | Started | Finished | Result |',
    '|---|---|---|---|---|',
    ...cells.map((row, index) => `| ${String(index + 1)} | ${STEP_LABELS[index] ?? ''} | ${row.join(' | ')} |`),
    '',
    ...paragraphs,
    '',
  ];
}

const QUIESCED: Cells = [t(1), t(4), 'ok'];
const PROJECTED: Cells = [t(5), t(7), 'ok'];

describe('renderRollbackReport Steps section', () => {
  it.each<{ name: string; entry: TransitionLogEntry; rows: [Cells, Cells, Cells, Cells]; paragraphs: string[] }>([
    {
      name: 'activate failed once and succeeded on resume',
      entry: transition(
        [
          ...BEFORE_ACTIVATE,
          attempt(7, 'activate', 7, 8, 'error'),
          attempt(7, 'activate', 20, 21, 'ok'),
          attempt(8, 'hand-off-and-reopen', 21, 22, 'ok'),
        ],
        { finishedAt: 22, outcome: 'activated' },
      ),
      rows: [QUIESCED, [t(4), t(5), 'ok'], PROJECTED, [t(20), t(22), 'ok']],
      paragraphs: [
        `Transition \`tr-rollback-1\` \`v0002\` → \`v0003\`, started ${t(0)}, finished ${t(22)}: activated`,
        '',
        `Superseded step attempts: \`activate\` (step 7) started ${t(7)}, finished ${t(8)}: error.`,
      ],
    },
    {
      name: 'drain-effects was interrupted and ran again',
      entry: transition(
        [
          ...BEFORE_ACTIVATE.slice(0, 3),
          attempt(4, 'drain-effects', 4, 10, 'error'),
          attempt(4, 'drain-effects', 10, 11, 'ok'),
          attempt(5, 'close-gates', 11, 12, 'ok'),
          attempt(6, 'final-state-and-reconcile', 12, 13, 'ok'),
          attempt(7, 'activate', 13, 14, 'ok'),
          attempt(8, 'hand-off-and-reopen', 14, 15, 'ok'),
        ],
        { finishedAt: 15, outcome: 'activated' },
      ),
      rows: [QUIESCED, [t(10), t(11), 'ok'], [t(11), t(13), 'ok'], [t(13), t(15), 'ok']],
      paragraphs: [
        `Transition \`tr-rollback-1\` \`v0002\` → \`v0003\`, started ${t(0)}, finished ${t(15)}: activated`,
        '',
        `Superseded step attempts: \`drain-effects\` (step 4) started ${t(4)}, finished ${t(10)}: error.`,
      ],
    },
    {
      name: 'two steps ran again, listed in log order',
      entry: transition(
        [
          ...BEFORE_ACTIVATE.slice(0, 3),
          attempt(4, 'drain-effects', 4, 10, 'error'),
          attempt(4, 'drain-effects', 10, 11, 'ok'),
          attempt(5, 'close-gates', 11, 12, 'ok'),
          attempt(6, 'final-state-and-reconcile', 12, 13, 'ok'),
          attempt(7, 'activate', 13, 14, 'error'),
          attempt(7, 'activate', 30, 31, 'ok'),
          attempt(8, 'hand-off-and-reopen', 31, 32, 'ok'),
        ],
        { finishedAt: 32, outcome: 'activated' },
      ),
      rows: [QUIESCED, [t(10), t(11), 'ok'], [t(11), t(13), 'ok'], [t(30), t(32), 'ok']],
      paragraphs: [
        `Transition \`tr-rollback-1\` \`v0002\` → \`v0003\`, started ${t(0)}, finished ${t(32)}: activated`,
        '',
        `Superseded step attempts: \`drain-effects\` (step 4) started ${t(4)}, finished ${t(10)}: error; ` +
          `\`activate\` (step 7) started ${t(13)}, finished ${t(14)}: error.`,
      ],
    },
    {
      name: 'activate failed again on resume',
      entry: transition([
        ...BEFORE_ACTIVATE,
        attempt(7, 'activate', 7, 8, 'error'),
        attempt(7, 'activate', 20, 21, 'error'),
      ]),
      rows: [QUIESCED, [t(4), t(5), 'ok'], PROJECTED, [t(20), t(21), 'error at `activate`']],
      paragraphs: [
        `Transition \`tr-rollback-1\` \`v0002\` → \`v0003\`, started ${t(0)}, finished unfinished: unfinished`,
        '',
        `Superseded step attempts: \`activate\` (step 7) started ${t(7)}, finished ${t(8)}: error.`,
      ],
    },
    {
      name: 'drain-effects was interrupted and its rerun aborted the transition',
      entry: transition(
        [
          ...BEFORE_ACTIVATE.slice(0, 3),
          attempt(4, 'drain-effects', 4, 10, 'error'),
          attempt(4, 'drain-effects', 10, 11, 'aborted'),
        ],
        { finishedAt: 12, outcome: 'aborted', abortReason: 'outbox not drained' },
      ),
      rows: [QUIESCED, [t(10), t(11), 'aborted'], NOT_RUN, NOT_RUN],
      paragraphs: [
        `Transition \`tr-rollback-1\` \`v0002\` → \`v0003\`, started ${t(0)}, finished ${t(12)}: aborted (outbox not drained)`,
        '',
        `Superseded step attempts: \`drain-effects\` (step 4) started ${t(4)}, finished ${t(10)}: error.`,
      ],
    },
    {
      name: 'activate is running again after a failure',
      entry: transition([...BEFORE_ACTIVATE, attempt(7, 'activate', 7, 8, 'error'), attempt(7, 'activate', 20)]),
      rows: [QUIESCED, [t(4), t(5), 'ok'], PROJECTED, [t(20), 'unfinished', 'unfinished']],
      paragraphs: [
        `Transition \`tr-rollback-1\` \`v0002\` → \`v0003\`, started ${t(0)}, finished unfinished: unfinished`,
        '',
        `Superseded step attempts: \`activate\` (step 7) started ${t(7)}, finished ${t(8)}: error.`,
      ],
    },
    {
      name: 'every step ran once',
      entry: transition(
        [...BEFORE_ACTIVATE, attempt(7, 'activate', 7, 8, 'ok'), attempt(8, 'hand-off-and-reopen', 8, 9, 'ok')],
        { finishedAt: 9, outcome: 'activated' },
      ),
      rows: [QUIESCED, [t(4), t(5), 'ok'], PROJECTED, [t(7), t(9), 'ok']],
      paragraphs: [`Transition \`tr-rollback-1\` \`v0002\` → \`v0003\`, started ${t(0)}, finished ${t(9)}: activated`],
    },
  ])('renders the latest attempt of each step when $name', ({ entry, rows, paragraphs }) => {
    const { markdown } = renderRollbackReport(reportInput(entry));

    expect(stepsSection(markdown)).toEqual(expectedSection(rows, paragraphs));
  });
});

/** Started, finished and result of each Steps table row, in table order. */
function stepRows(markdown: string): Cells[] {
  return stepsSection(markdown)
    .filter((line) => /^\| \d+ \| /.test(line))
    .map((line): Cells => {
      const [, , started = '', finished = '', result = ''] = line.slice(2, -2).split(' | ');
      return [started, finished, result];
    });
}

const BEFORE: ReconciliationRef = {
  path: 'reconciliation/rollback-before.json',
  result: 'zero-difference',
  startedAt: t(6, 30),
  generatedAt: t(6, 50),
  tableVersion: 'v0002',
  units: 1,
  differences: 0,
};
const AFTER: ReconciliationRef = {
  path: 'reconciliation/rollback-after.json',
  result: 'zero-difference',
  startedAt: t(18),
  generatedAt: t(19),
  tableVersion: 'v0003',
  units: 1,
  differences: 0,
};
const REBASELINE: RebaselineRecord = {
  tableVersion: 'v0003',
  groups: ['g-roster'],
  units: ['people.person'],
  snapshotSeq: 42,
  startedAt: t(10),
  finishedAt: t(11),
  feed: { snapshotSeq: 42, units: ['people.person'], tables: [] },
};

function replay(id: string, started: string, finished: string, tableVersion = 'v0003'): ReplayRun {
  return { id, tableVersion, startedAt: started, finishedAt: finished };
}

function feedRun(seq: number, started: string, finished: string): FeedRun {
  return { path: `reconciliation/after-feed-${String(seq)}.json`, result: 'zero-difference', startedAt: started, finishedAt: finished };
}

const REPLAYS = [replay('GS-PE-RH-01', t(12), t(13)), replay('GS-PE-RH-02', t(13), t(14)), replay('GS-PE-RH-03', t(14), t(15))];
const EARLIER_FEED = feedRun(41, t(2), t(3));
const FEED_PASS = feedRun(43, t(16), t(17));
const LATER_FEED = feedRun(44, t(20), t(21));
const FEED_PASS_CELLS: Cells = [t(16), t(17), 'zero-difference ([reconciliation/after-feed-43.json](reconciliation/after-feed-43.json))'];

/** A whole rehearsal: steps 1–8, the reconciliations, the re-baseline, the replays and three feed runs, one between rehearsal and rollback-after. */
function rehearsalInput(): RollbackReportInput {
  return {
    ...reportInput(
      transition([...BEFORE_ACTIVATE, attempt(7, 'activate', 7, 8, 'ok'), attempt(8, 'hand-off-and-reopen', 8, 9, 'ok')], {
        finishedAt: 9,
        outcome: 'activated',
      }),
    ),
    rebaseline: REBASELINE,
    reconciliation: { before: BEFORE, after: AFTER },
    replays: REPLAYS,
    feeds: [LATER_FEED, EARLIER_FEED, FEED_PASS],
    scenarios: REHEARSAL_SCENARIOS.map((id) => ({ id, result: 'pass' })),
    session: { id: SESSION_SCENARIO, result: 'pass' },
  };
}

describe('renderRollbackReport Steps section over a whole rehearsal', () => {
  it('gives every step its start, finish and result, in run order', () => {
    const rows = stepRows(renderRollbackReport(rehearsalInput()).markdown);

    expect(rows).toEqual([
      [t(1), t(4), 'ok'],
      [t(4), t(5), 'ok'],
      [t(5), t(6, 30), 'ok'],
      [t(6, 30), t(6, 50), 'zero-difference'],
      [t(7), t(9), 'ok'],
      [t(10), t(11), 'ok (snapshot 42)'],
      [t(12), t(15), 'pass'],
      FEED_PASS_CELLS,
      [t(18), t(19), 'zero-difference'],
    ]);
    const times = rows.flatMap(([started, finished]) => [started, finished]);
    expect(times).toEqual([...times].sort());
  });

  it.each<{ name: string; edit: (input: RollbackReportInput) => RollbackReportInput; rows: [Cells, Cells, Cells, Cells, Cells] }>([
    {
      name: 'the reconciliation of R found a difference and aborted step 6',
      edit: (input) => ({
        ...input,
        transition: transition([...BEFORE_ACTIVATE.slice(0, 5), attempt(6, 'final-state-and-reconcile', 6, 7, 'aborted')], {
          finishedAt: 7,
          outcome: 'aborted',
        }),
        rebaseline: undefined,
        reconciliation: { before: { ...BEFORE, result: 'difference', differences: 1 }, after: { path: AFTER.path, result: 'not-run' } },
        replays: [],
        feeds: [],
        scenarios: REHEARSAL_SCENARIOS.map((id) => ({ id, result: 'not-run' })),
        session: { id: SESSION_SCENARIO, result: 'not-run' },
      }),
      rows: [[t(5), t(6, 30), 'ok'], [t(6, 30), t(6, 50), 'difference'], NOT_RUN, NOT_RUN, NOT_RUN],
    },
    {
      name: 'rollback-before.json predates the latest step 6',
      edit: (input) => ({ ...input, reconciliation: { ...input.reconciliation, before: { ...BEFORE, startedAt: t(0, 10), generatedAt: t(0, 20) } } }),
      rows: [[t(5), t(7), 'ok'], [t(0, 10), t(0, 20), 'zero-difference'], [t(12), t(15), 'pass'], FEED_PASS_CELLS, [t(18), t(19), 'zero-difference']],
    },
    {
      name: 'the reconciliation reports do not record their start',
      edit: (input) => ({
        ...input,
        reconciliation: { before: { ...BEFORE, startedAt: undefined }, after: { ...AFTER, startedAt: undefined } },
      }),
      rows: [[t(5), t(7), 'ok'], ['—', t(6, 50), 'zero-difference'], [t(12), t(15), 'pass'], FEED_PASS_CELLS, ['—', t(19), 'zero-difference']],
    },
    {
      name: 'the only replays predate the re-baseline or ran under another version',
      edit: (input) => ({ ...input, replays: [replay('GS-PE-RH-01', t(9, 30), t(9, 40)), replay('GS-PE-RH-02', t(12), t(13), 'v0002')] }),
      rows: [[t(5), t(6, 30), 'ok'], [t(6, 30), t(6, 50), 'zero-difference'], ['—', '—', 'pass'], FEED_PASS_CELLS, [t(18), t(19), 'zero-difference']],
    },
    {
      name: 'no feed ran between the rehearsal and rollback-after',
      edit: (input) => ({ ...input, feeds: [EARLIER_FEED, LATER_FEED] }),
      rows: [[t(5), t(6, 30), 'ok'], [t(6, 30), t(6, 50), 'zero-difference'], [t(12), t(15), 'pass'], NOT_RUN, [t(18), t(19), 'zero-difference']],
    },
    {
      name: 'rollback-after has not run, so the last feed after the rehearsal is the pass',
      edit: (input) => ({ ...input, reconciliation: { ...input.reconciliation, after: { path: AFTER.path, result: 'not-run' } } }),
      rows: [
        [t(5), t(6, 30), 'ok'],
        [t(6, 30), t(6, 50), 'zero-difference'],
        [t(12), t(15), 'pass'],
        [t(20), t(21), 'zero-difference ([reconciliation/after-feed-44.json](reconciliation/after-feed-44.json))'],
        NOT_RUN,
      ],
    },
  ])('renders the projection, both reconciliations, the rehearsal and the feed pass when $name', ({ edit, rows }) => {
    const [, , project, before, , , rehearse, feed, after] = stepRows(renderRollbackReport(edit(rehearsalInput())).markdown);

    expect([project, before, rehearse, feed, after]).toEqual(rows);
  });
});
