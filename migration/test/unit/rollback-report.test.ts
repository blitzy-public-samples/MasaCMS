// Unit tests for the rehearsal report's Steps section over transitions whose steps ran more than once.
import { describe, expect, it } from 'vitest';

import type { TransitionLogEntry, TransitionStepName } from '../../src/reports/index.js';
import {
  REHEARSAL_SCENARIOS,
  SESSION_SCENARIO,
  renderRollbackReport,
  type RollbackReportInput,
} from '../../src/rollback/index.js';
import { TEST_SOURCE_SHA } from '../helpers/env.js';

type Step = TransitionLogEntry['steps'][number];
type Cells = [started: string, finished: string, result: string];

const STEP_LABELS = [
  "Quiesce writers of `R`'s units",
  'Drain the people outbox and the timesheets consumer (`people.person.archived.v1`)',
  "Project `R`'s units to completion, including `timesheets.blackout` → `Program_N.blackout` and " +
    '`identity.credential` → `tusers.Password`',
  'Reconcile `R` → `reconciliation/rollback-before.json`',
  'Activate `v0003` and unfreeze',
  "Re-baseline: fresh snapshot, forward feed restarted for `R`'s units",
  'Rehearse GS-PE-RH-01/02/03 through the gateway (served by legacy) and the GS-ID-09 session step across activation',
  'Feed pass',
  'Reconcile → `reconciliation/rollback-after.json`',
];
const NOT_RUN: Cells = ['not-run', 'not-run', 'not-run'];
const FEED_PASS: Cells = ['—', '—', '[reconciliation/summary.md](reconciliation/summary.md)'];

/** Minute `minute` of the transition's hour. */
function t(minute: number): string {
  return `2026-06-30T10:${String(minute).padStart(2, '0')}:00.000Z`;
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
  const cells = [quiesce, drain, project, NOT_RUN, activate, NOT_RUN, NOT_RUN, FEED_PASS, NOT_RUN];
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
