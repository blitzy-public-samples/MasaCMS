// Writes `rollback-rehearsal.md`, the evidence of the people-roster rollback rehearsal, from the run's reports and state.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveReportsDir } from '../config.js';
import type { MigrationContext } from '../context.js';
import { stateDirPath } from '../paths.js';
import {
  readJsonReport,
  readLogEntries,
  resolveReportTarget,
  writeMarkdownReport,
  type TransitionLogEntry,
  type TransitionStepName,
} from '../reports/index.js';

import { readRebaselineRecord, type RebaselineRecord } from './rebaseline.js';
import { ROLLBACK_FROM_VERSION, ROLLBACK_VERSION, computeRollbackSet, type RollbackSet } from './set.js';

/** Report file, relative to the reports directory. */
export const ROLLBACK_REPORT_PATH = 'rollback-rehearsal.md';

/** Reconciliation reports taken before and after the rollback, relative to the reports directory. */
export const RECONCILIATION_REPORTS = {
  before: 'reconciliation/rollback-before.json',
  after: 'reconciliation/rollback-after.json',
} as const;

/** Rehearsal scenarios, replayed through the gateway once the rollback version is active. */
export const REHEARSAL_SCENARIOS = ['GS-PE-RH-01', 'GS-PE-RH-02', 'GS-PE-RH-03'] as const;

/** Scenario whose session step runs across the rollback version's activation. */
export const SESSION_SCENARIO = 'GS-ID-09';

/** Rehearsal verdict; `incomplete` when evidence is missing and nothing failed. */
export type RollbackResult = 'pass' | 'fail' | 'incomplete';

/** One reconciliation report as the rehearsal cites it; `result` is `not-run` when the file is absent. */
export interface ReconciliationRef {
  /** Relative to the reports directory. */
  path: string;
  result: string;
  generatedAt?: string;
  tableVersion?: string;
  /** Units compared. */
  units?: number;
  /** Units with at least one difference. */
  differences?: number;
}

/** Parity outcome of one scenario; `result` is `not-run` when `parity.json` does not list it. */
export interface ScenarioOutcome {
  id: string;
  result: string;
  golden?: string;
  replay?: string;
}

/** Fixture capability recorded in `${OPT2_STATE_DIR}/fixtures.json`. */
export interface FixtureStatus {
  available: boolean;
  reason?: string;
}

/** Entry points and units of one group of `R`, as the groups file records them. */
export interface RollbackGroupDetail {
  id: string;
  entryPoints: string[];
  units: string[];
}

/** Everything the report renders; an optional field is absent when its source does not exist. */
export interface RollbackReportInput {
  sourceSha: string;
  generatedAt: string;
  set: RollbackSet;
  groupDetails?: RollbackGroupDetail[];
  transition?: TransitionLogEntry;
  rebaseline?: RebaselineRecord;
  reconciliation: { before: ReconciliationRef; after: ReconciliationRef };
  /** `generatedAt` of `parity.json`. */
  parityGeneratedAt?: string;
  scenarios: ScenarioOutcome[];
  session: ScenarioOutcome;
  fixtures?: FixtureStatus;
}

/** The written report's absolute path, its verdict and the exit code `opt2-migrate rollback report` ends with. */
export interface WriteRollbackReportResult {
  reportPath: string;
  result: RollbackResult;
  exitCode: 0 | 1;
}

/** `parity.json` fields the report reads. */
interface StoredParity {
  generatedAt?: string | null;
  scenarios?: { id: string; result: string; evidence?: { golden?: string; replay?: string } }[];
}

/** Reconciliation report fields the report reads; the committed placeholders hold `null` until a run. */
interface StoredReconciliation {
  result: string;
  generatedAt?: string | null;
  tableVersion?: string | null;
  summary?: { units?: number | null; unitsWithDifferences?: number | null } | null;
}

/** `${OPT2_STATE_DIR}/fixtures.json` as `legacy-fixtures/load-fixtures.sh` writes it. */
interface StoredFixtures {
  available: boolean;
  reason?: string | null;
}

/** `gateway/cutover/groups.json` fields the report reads. */
interface StoredGroups {
  groups: { id: string; units: string[]; writeEntries: string[] }[];
}

type StepCells = [started: string, finished: string, result: string];

const GENERATED_BY = 'migration/src/rollback/';
const RUNBOOK = 'migration/runbooks/people-roster-rollback.md';
const TRANSITIONS_LOG = 'transitions.json';
const PARITY_REPORT = 'parity.json';
const RECONCILIATION_SUMMARY = 'reconciliation/summary.md';
const FIXTURES_FILE = 'fixtures.json';
const NOT_RUN = 'not-run';
const UNFINISHED = 'unfinished';
const UNTRACKED = '—';
const ZERO_DIFFERENCE = 'zero-difference';
const DIFFERENCE = 'difference';
const ACCEPTED: ReadonlySet<string> = new Set(['pass', 'excepted', 'known-issue']);
const SCENARIO_LABELS: Readonly<Record<string, string>> = {
  'GS-PE-RH-01': 'roster create',
  'GS-PE-RH-02': 'roster edit',
  'GS-PE-RH-03': 'archive → blackout',
  [SESSION_SCENARIO]: `session step across \`${ROLLBACK_VERSION}\` activation`,
};
const UNMET_ARCHIVE_LEG =
  'the rehearsal covers create and edit only; the archive-to-blackout leg (GS-PE-RH-03) is unmet (AAP 0.7.6).';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Table cell text: whitespace runs collapsed and pipes escaped, so a value cannot split its row. */
function cell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|');
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(' | ')} |`;
}

function code(text: string): string {
  return `\`${text}\``;
}

function codeList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : [...values].sort().map(code).join(', ');
}

/** Started, finished and result of the transition steps `names`, which run in this order. */
function transitionCells(transition: TransitionLogEntry | undefined, names: readonly TransitionStepName[]): StepCells {
  const logged = names.map((name) => transition?.steps.find((step) => step.name === name));
  const first = logged[0];
  if (first === undefined) return [NOT_RUN, NOT_RUN, NOT_RUN];
  const failure = logged.find((step) => step?.result !== undefined && step.result !== 'ok');
  if (failure?.result !== undefined) {
    const result = names.length === 1 ? failure.result : `${failure.result} at ${code(failure.name)}`;
    return [first.startedAt, failure.finishedAt ?? UNFINISHED, result];
  }
  const done = logged.every((step) => step?.result === 'ok');
  return [first.startedAt, logged.at(-1)?.finishedAt ?? UNFINISHED, done ? 'ok' : UNFINISHED];
}

/** Text for a value a reconciliation report lacks: `none` once it ran, otherwise its state, such as `not-run`. */
function absentValue(ref: ReconciliationRef): string {
  return ref.result === ZERO_DIFFERENCE || ref.result === DIFFERENCE ? 'none' : ref.result;
}

function reconciliationCells(ref: ReconciliationRef): StepCells {
  const ran = absentValue(ref) === 'none';
  return [ran ? UNTRACKED : ref.result, ref.generatedAt ?? absentValue(ref), ref.result];
}

function rebaselineCells(record: RebaselineRecord | undefined): StepCells {
  if (record === undefined) return [NOT_RUN, NOT_RUN, NOT_RUN];
  return [record.startedAt, record.finishedAt, `ok (snapshot ${String(record.snapshotSeq)})`];
}

/** `not-run` when no scenario ran, `fail` on any failure, `pass` when every outcome is accepted, else `incomplete`. */
function rehearsalVerdict(outcomes: readonly ScenarioOutcome[]): string {
  if (outcomes.every((outcome) => outcome.result === NOT_RUN)) return NOT_RUN;
  if (outcomes.some((outcome) => outcome.result === 'fail')) return 'fail';
  return outcomes.every((outcome) => ACCEPTED.has(outcome.result)) ? 'pass' : 'incomplete';
}

function verdictOf(input: RollbackReportInput): RollbackResult {
  const { transition, reconciliation, fixtures } = input;
  const refs = [reconciliation.before, reconciliation.after];
  const outcomes = [...input.scenarios, input.session];
  if (
    transition?.outcome === 'aborted' ||
    refs.some((ref) => ref.result === DIFFERENCE) ||
    outcomes.some((outcome) => outcome.result === 'fail')
  ) {
    return 'fail';
  }
  const complete =
    transition?.outcome === 'activated' &&
    input.rebaseline !== undefined &&
    refs.every((ref) => ref.result === ZERO_DIFFERENCE) &&
    fixtures?.available !== false &&
    outcomes.every((outcome) => ACCEPTED.has(outcome.result));
  return complete ? 'pass' : 'incomplete';
}

function groupSection({ set, groupDetails }: RollbackReportInput): string[] {
  const details = new Map((groupDetails ?? []).map((detail) => [detail.id, detail]));
  const rows = [...set.groups].sort().map((id) => {
    const detail = details.get(id);
    return row([
      code(id),
      detail === undefined ? UNTRACKED : codeList(detail.entryPoints),
      detail === undefined ? UNTRACKED : codeList(detail.units),
    ]);
  });
  return [
    '## Roster group set `R`',
    '',
    '| Group | Entry points | Units |',
    '|---|---|---|',
    ...(rows.length === 0 ? [row(['none', UNTRACKED, UNTRACKED])] : rows),
    '',
    `Units of \`R\` (${String(set.units.length)}): ${codeList(set.units)}.`,
    '',
    'Computed by `opt2-migrate rollback-set` from `gateway/cutover/groups.json`: every group containing ' +
      '`cusers.update{type=2,action=Add}`, `cusers.update{type=2,action=Update}`, the fixture archive route ' +
      '`people/persons/{userId}/archive`, or the units `people.person_archive`, `timesheets.blackout`. Also recorded in ' +
      `\`gateway/cutover/versions/${ROLLBACK_VERSION}.json\` \`rollbackRefs\`.`,
  ];
}

function sessionSection(set: RollbackSet): string[] {
  return [
    '## Session mode',
    '',
    `| Before (\`${ROLLBACK_FROM_VERSION}\`) | After (\`${ROLLBACK_VERSION}\`) | \`R\` contains the \`clogin.login\` group |`,
    '|---|---|---|',
    row([set.sessionModeBefore, set.sessionModeAfter, set.containsLoginGroup ? 'yes' : 'no']),
    '',
    'Values are `target-primary` or `legacy-primary`; the mode changes only if `R` contains the group of `clogin.login`.',
  ];
}

function transitionLine(transition: TransitionLogEntry | undefined): string {
  if (transition === undefined) return `Transition to \`${ROLLBACK_VERSION}\`: ${NOT_RUN}.`;
  const outcome = transition.outcome ?? UNFINISHED;
  const reason =
    transition.outcome === 'aborted' && transition.abortReason !== undefined ? ` (${oneLine(transition.abortReason)})` : '';
  return (
    `Transition ${code(transition.transitionId)} \`${transition.from}\` → \`${transition.to}\`, started ` +
    `${transition.startedAt}, finished ${transition.finishedAt ?? UNFINISHED}: ${outcome}${reason}`
  );
}

function stepsSection(input: RollbackReportInput): string[] {
  const { transition, reconciliation } = input;
  const rehearsed = input.parityGeneratedAt;
  // Rows keep the committed report's runbook steps; each transition step folds into the row whose work it performs.
  const steps: [label: string, cells: StepCells][] = [
    ["Quiesce writers of `R`'s units", transitionCells(transition, ['transition-set', 'stop-new-work', 'confirm-inflight-finished'])],
    [
      'Drain the people outbox and the timesheets consumer (`people.person.archived.v1`)',
      transitionCells(transition, ['drain-effects']),
    ],
    [
      "Project `R`'s units to completion, including `timesheets.blackout` → `Program_N.blackout` and " +
        '`identity.credential` → `tusers.Password`',
      transitionCells(transition, ['close-gates', 'final-state-and-reconcile']),
    ],
    [`Reconcile \`R\` → \`${RECONCILIATION_REPORTS.before}\``, reconciliationCells(reconciliation.before)],
    [`Activate \`${ROLLBACK_VERSION}\` and unfreeze`, transitionCells(transition, ['activate', 'hand-off-and-reopen'])],
    ["Re-baseline: fresh snapshot, forward feed restarted for `R`'s units", rebaselineCells(input.rebaseline)],
    [
      `Rehearse GS-PE-RH-01/02/03 through the gateway (served by legacy) and the ${SESSION_SCENARIO} session step across activation`,
      [
        rehearsed === undefined ? NOT_RUN : UNTRACKED,
        rehearsed ?? NOT_RUN,
        rehearsalVerdict([...input.scenarios, input.session]),
      ],
    ],
    ['Feed pass', [UNTRACKED, UNTRACKED, `[${RECONCILIATION_SUMMARY}](${RECONCILIATION_SUMMARY})`]],
    [`Reconcile → \`${RECONCILIATION_REPORTS.after}\``, reconciliationCells(reconciliation.after)],
  ];
  return [
    '## Steps',
    '',
    '| # | Step | Started | Finished | Result |',
    '|---|---|---|---|---|',
    ...steps.map(([label, cells], index) => row([String(index + 1), label, ...cells])),
    '',
    transitionLine(transition),
  ];
}

function reconciliationRow(ref: ReconciliationRef): string {
  const absent = absentValue(ref);
  const count = (value: number | undefined): string => (value === undefined ? absent : String(value));
  return row([
    path.posix.basename(ref.path, '.json'),
    `[${ref.path}](${ref.path})`,
    ref.tableVersion ?? absent,
    count(ref.units),
    count(ref.differences),
    ref.result,
  ]);
}

function reconciliationSection({ before, after }: RollbackReportInput['reconciliation']): string[] {
  return [
    '## Reconciliation',
    '',
    '| Point | Report | Table version | Units | Differences | Result |',
    '|---|---|---|---|---|---|',
    reconciliationRow(before),
    reconciliationRow(after),
  ];
}

function replayRow(outcome: ScenarioOutcome): string {
  const label = SCENARIO_LABELS[outcome.id];
  return row([
    label === undefined ? outcome.id : `${outcome.id} (${label})`,
    code(outcome.golden ?? `harness/golden/sets/${outcome.id}.json`),
    outcome.replay === undefined ? NOT_RUN : code(outcome.replay),
    outcome.result,
  ]);
}

function fixturesLine(fixtures: FixtureStatus | undefined): string {
  if (fixtures === undefined) {
    return `Fixture status not recorded (\`${FIXTURES_FILE}\` absent from the state directory); with fixtures unavailable, ${UNMET_ARCHIVE_LEG}`;
  }
  if (!fixtures.available) {
    const reason = fixtures.reason === undefined ? '' : ` (${oneLine(fixtures.reason)})`;
    return `Fixtures unavailable${reason}: ${UNMET_ARCHIVE_LEG}`;
  }
  return 'Fixtures available: the rehearsal covers create, edit and the archive-to-blackout leg (GS-PE-RH-03).';
}

function replaySection(input: RollbackReportInput): string[] {
  return [
    '## Replay',
    '',
    '| Scenario | Golden set | Replay | Result |',
    '|---|---|---|---|',
    ...[...input.scenarios, input.session].map(replayRow),
    '',
    'GS-PE-RH-01/02/03 golden sets are captured at `harness/repro/test-all.sh` stage 5 from the same seeded state, on the ' +
      'reserved rehearsal identities (`legacy-fixtures/seed/seed.config.json` `reserved.rehearsal`), which no other scenario ' +
      `may reference. ${SESSION_SCENARIO} is the session-continuity case: its session step runs across the ` +
      `\`${ROLLBACK_VERSION}\` activation and uses no reserved identity.`,
    '',
    fixturesLine(input.fixtures),
  ];
}

/** Renders the rehearsal report and its verdict; pure, so the same input gives the same Markdown. */
export function renderRollbackReport(input: RollbackReportInput): { markdown: string; result: RollbackResult } {
  const result = verdictOf(input);
  const lines = [
    '# People-roster rollback rehearsal',
    '',
    `Source SHA: ${input.sourceSha}`,
    `Status: ${result}`,
    `Generated by: ${GENERATED_BY} (\`opt2-migrate rollback report\`)`,
    `Runbook: ${code(RUNBOOK)}`,
    `Generated at: ${input.generatedAt}`,
    '',
    ...groupSection(input),
    '',
    ...sessionSection(input.set),
    '',
    ...stepsSection(input),
    '',
    ...reconciliationSection(input.reconciliation),
    '',
    ...replaySection(input),
  ];
  return { markdown: `${lines.join('\n')}\n`, result };
}

async function readReconciliation(reportsDir: string, relPath: string): Promise<ReconciliationRef> {
  const doc = await readJsonReport<StoredReconciliation>(reportsDir, relPath);
  if (doc === undefined) return { path: relPath, result: NOT_RUN };
  return {
    path: relPath,
    result: doc.result,
    generatedAt: doc.generatedAt ?? undefined,
    tableVersion: doc.tableVersion ?? undefined,
    units: doc.summary?.units ?? undefined,
    differences: doc.summary?.unitsWithDifferences ?? undefined,
  };
}

function scenarioOutcome(id: string, parity: StoredParity | undefined): ScenarioOutcome {
  const found = parity?.scenarios?.find((scenario) => scenario.id === id);
  if (found === undefined) return { id, result: NOT_RUN };
  return { id, result: found.result, golden: found.evidence?.golden, replay: found.evidence?.replay };
}

/** The recorded fixture capability, or `undefined` when `fixtures.json` does not exist; other errors propagate. */
async function readFixtures(stateDir: string): Promise<FixtureStatus | undefined> {
  let text: string;
  try {
    text = await readFile(stateDirPath(stateDir, FIXTURES_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const doc = JSON.parse(text) as StoredFixtures;
  return { available: doc.available, reason: doc.reason ?? undefined };
}

/** Entry points and units of the groups `ids`, from the groups file `computeRollbackSet` derived them from. */
async function readGroupDetails(groupsFile: string, ids: readonly string[]): Promise<RollbackGroupDetail[]> {
  const { groups } = JSON.parse(await readFile(groupsFile, 'utf8')) as StoredGroups;
  const members = new Set(ids);
  return groups
    .filter((group) => members.has(group.id))
    .map((group) => ({ id: group.id, entryPoints: group.writeEntries, units: group.units }));
}

/**
 * Gathers the rollback evidence from the reports directory and `OPT2_STATE_DIR`, writes {@link ROLLBACK_REPORT_PATH}
 * and returns exit code 1 only for a `fail` verdict.
 * @throws RollbackSetMismatchError when the rollback version disagrees with the recomputed `R`.
 */
export async function writeRollbackReport(
  ctx: Pick<MigrationContext, 'env' | 'config' | 'clock'>,
): Promise<WriteRollbackReportResult> {
  const target = resolveReportTarget({
    reportsDir: resolveReportsDir(ctx.config, ctx.env),
    sourceShaFile: ctx.config.paths.sourcePin,
  });
  const set = computeRollbackSet(ctx);
  const stateDir = ctx.env.OPT2_STATE_DIR;
  const transitions = await readLogEntries<TransitionLogEntry>(target.reportsDir, TRANSITIONS_LOG);
  const parity = await readJsonReport<StoredParity>(target.reportsDir, PARITY_REPORT);

  const { markdown, result } = renderRollbackReport({
    sourceSha: target.sourceSha,
    generatedAt: ctx.clock.now().toISOString(),
    set,
    groupDetails: await readGroupDetails(ctx.config.paths.groupsFile, set.groups),
    transition: transitions.filter((entry) => entry.to === ROLLBACK_VERSION).at(-1),
    rebaseline: readRebaselineRecord(stateDir),
    reconciliation: {
      before: await readReconciliation(target.reportsDir, RECONCILIATION_REPORTS.before),
      after: await readReconciliation(target.reportsDir, RECONCILIATION_REPORTS.after),
    },
    parityGeneratedAt: parity?.generatedAt ?? undefined,
    scenarios: REHEARSAL_SCENARIOS.map((id) => scenarioOutcome(id, parity)),
    session: scenarioOutcome(SESSION_SCENARIO, parity),
    fixtures: await readFixtures(stateDir),
  });
  // writeMarkdownReport redacts the Markdown and ensures its Source SHA line from the same pin.
  const written = await writeMarkdownReport(target, ROLLBACK_REPORT_PATH, markdown);
  return { reportPath: written.path, result, exitCode: result === 'fail' ? 1 : 0 };
}
