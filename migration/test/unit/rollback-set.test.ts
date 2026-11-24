// Unit tests of the roster rollback set R over fixture and committed cut-over files, and of the rehearsal report built on it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type LoadedMigrationConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import {
  LOGIN_ROUTE_KEY,
  loadVersion,
  loginGroup,
  type Authority,
  type CutoverGroup,
  type CutoverVersion,
  type GroupsFile,
  type RollbackRef,
} from '../../src/cutover/index.js';
import { TRANSITION_STEP_NAMES, type TransitionLogEntry } from '../../src/reports/index.js';
import {
  RECONCILIATION_REPORTS,
  REHEARSAL_SCENARIOS,
  ROLLBACK_FROM_VERSION,
  ROLLBACK_REPORT_PATH,
  ROLLBACK_VERSION,
  RollbackSetMismatchError,
  SESSION_GOLDEN_SET,
  SESSION_SCENARIO,
  computeRollbackSet,
  deriveRollbackSet,
  rebaselineRecordPath,
  renderRollbackReport,
  writeRollbackReport,
  type FeedRun,
  type RebaselineRecord,
  type ReconciliationRef,
  type ReplayRun,
  type RollbackReportInput,
  type RollbackSet,
  type ScenarioOutcome,
} from '../../src/rollback/index.js';
import { TEST_SOURCE_SHA, createMutableClock, createTestDirs, testEnv, type TestDirs } from '../helpers/env.js';
import {
  FIXTURE_GROUP_IDS,
  FIXTURE_ROUTES,
  ROLLBACK_GROUPS,
  UNITS,
  V0002,
  V0003,
  fixtureGroups,
  fixtureVersion,
  writeCutoverDir,
} from '../helpers/fixtures.js';

const config = loadConfig();
const GENERATED_AT = '2026-06-30T12:00:00.000Z';
const R_GROUPS: string[] = [...ROLLBACK_GROUPS];
const R_UNITS = sorted([UNITS.credential, UNITS.userAccount, UNITS.person, UNITS.personArchive, UNITS.blackout]);
const UNMET_ARCHIVE_LEG =
  'the rehearsal covers create and edit only; the archive-to-blackout leg (GS-PE-RH-03) is unmet (AAP 0.7.6).';

const V0003_REF = firstRollbackRef(V0003);

function firstRollbackRef(version: CutoverVersion): RollbackRef {
  const [ref] = version.rollbackRefs;
  if (ref === undefined) throw new Error(`The fixture ${version.tableVersion} holds no rollbackRefs`);
  return ref;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function code(text: string): string {
  return `\`${text}\``;
}

function codeList(values: readonly string[]): string {
  return sorted(values).map(code).join(', ');
}

/** Minute `minute`, second `second` of the rehearsal's hour. */
function t(minute: number, second = 0): string {
  return `2026-06-30T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
}

/** `time` a day earlier, in a previous rehearsal. */
function dayBefore(time: string): string {
  return time.replace('2026-06-30T', '2026-06-29T');
}

/** R derived over the configured roster route keys and units. */
function derive(groups: GroupsFile, from: CutoverVersion = V0002, to: CutoverVersion = V0003): RollbackSet {
  return deriveRollbackSet({ groups, from, to, ...config.rollbackSet });
}

/** The fixture groups with group `id` patched. */
function editGroup(id: string, patch: Partial<CutoverGroup>): GroupsFile {
  const file = fixtureGroups();
  return { ...file, groups: file.groups.map((group) => (group.id === id ? { ...group, ...patch } : group)) };
}

/** The fixture groups with the login group folded into the roster create/edit group, as one carry entry writing both would build them. */
function rosterWithLogin(): GroupsFile {
  const file = fixtureGroups();
  const login = file.groups.find((group) => group.id === FIXTURE_GROUP_IDS.login);
  if (login === undefined) throw new Error('The fixture groups hold no login group');
  return {
    ...file,
    groups: file.groups
      .filter((group) => group !== login)
      .map((group) =>
        group.id === FIXTURE_GROUP_IDS.roster
          ? { ...group, units: sorted([...group.units, ...login.units]), writeEntries: sorted([...group.writeEntries, ...login.writeEntries]) }
          : group,
      ),
  };
}

/** `version` without an authority for group `id`. */
function withoutGroup(version: CutoverVersion, id: string): CutoverVersion {
  return { ...version, groupAuthority: Object.fromEntries(Object.entries(version.groupAuthority).filter(([group]) => group !== id)) };
}

/** A `v0003` over the fixture's v0003 authority with `authority` applied and rollbackRefs naming `refGroups`. */
function rollbackVersion(authority: Readonly<Record<string, Authority>>, refGroups: readonly string[]): CutoverVersion {
  return fixtureVersion(ROLLBACK_VERSION, { ...V0003.groupAuthority, ...authority }, undefined, {
    rollbackRefs: [{ ...V0003_REF, groups: [...refGroups], rollbackSet: [...refGroups] }],
  });
}

/** `config` reading groups.json and the versions from a written cut-over directory. */
function configFor(dir: { cutoverDir: string; groupsFile: string }): LoadedMigrationConfig {
  return { ...config, paths: { ...config.paths, cutoverDir: dir.cutoverDir, groupsFile: dir.groupsFile } };
}

const MERGED_FROM = withoutGroup(V0002, FIXTURE_GROUP_IDS.login);
const MERGED_TO = withoutGroup(V0003, FIXTURE_GROUP_IDS.login);
const LOGIN_LEGACY: Readonly<Record<string, Authority>> = { [FIXTURE_GROUP_IDS.login]: 'legacy' };

describe('deriveRollbackSet', () => {
  it('returns the roster create/edit group and the archive/blackout group of the fixture', () => {
    expect(config.rollbackSet.routeKeys).toEqual(
      expect.arrayContaining([FIXTURE_ROUTES.rosterAdd, FIXTURE_ROUTES.rosterUpdate, FIXTURE_ROUTES.archive]),
    );

    expect(derive(fixtureGroups()).groups).toEqual(sorted([FIXTURE_GROUP_IDS.roster, FIXTURE_GROUP_IDS.archive]));
  });

  it("takes the union of R's units and no unit of a group outside R", () => {
    const set = derive(fixtureGroups());

    expect(set.units).toEqual(R_UNITS);
    const outside = fixtureGroups().groups.filter((group) => !set.groups.includes(group.id));
    expect(outside.map((group) => group.id)).not.toHaveLength(0);
    for (const group of outside) for (const unit of group.units) expect(set.units).not.toContain(unit);
  });

  it("equals v0003's rollbackRefs groups and the groups v0002 → v0003 returns to legacy", () => {
    const refs = sorted(V0003.rollbackRefs.flatMap((ref) => ref.groups));
    const returned = sorted(
      Object.keys(V0003.groupAuthority).filter((id) => V0002.groupAuthority[id] === 'target' && V0003.groupAuthority[id] === 'legacy'),
    );

    const { groups } = derive(fixtureGroups());

    expect(groups).toEqual(refs);
    expect(groups).toEqual(returned);
  });

  it.each([
    {
      name: 'a roster route authored in mixed case with padding',
      groups: editGroup(FIXTURE_GROUP_IDS.roster, {
        writeEntries: [' Admin:cUsers.Update{type=2,action=Add} ', 'ADMIN:CUSERS.UPDATE{TYPE=2,ACTION=UPDATE}'],
      }),
    },
    { name: 'the archive group by its units alone', groups: editGroup(FIXTURE_GROUP_IDS.archive, { writeEntries: [] }) },
  ])('finds the same R from $name', ({ groups }) => {
    expect(derive(groups).groups).toEqual(R_GROUPS);
  });

  it('keeps an R group that v0002 already leaves legacy without requiring v0003 to return it', () => {
    const from = fixtureVersion(ROLLBACK_FROM_VERSION, { ...V0002.groupAuthority, [FIXTURE_GROUP_IDS.archive]: 'legacy' });

    expect(derive(fixtureGroups(), from, V0003).groups).toEqual(R_GROUPS);
  });
});

describe('RollbackSetMismatchError', () => {
  it.each([
    {
      name: "v0003's rollbackRefs omit the archive group",
      to: rollbackVersion({}, [FIXTURE_GROUP_IDS.roster]),
      refs: [FIXTURE_GROUP_IDS.roster],
      returned: R_GROUPS,
      problems: [`v0003 rollbackRefs groups: missing ${FIXTURE_GROUP_IDS.archive}; extra none`],
    },
    {
      name: 'v0003 also returns the content group to legacy',
      to: rollbackVersion({ [FIXTURE_GROUP_IDS.content]: 'legacy' }, R_GROUPS),
      refs: R_GROUPS,
      returned: sorted([...R_GROUPS, FIXTURE_GROUP_IDS.content]),
      problems: [`groups returned to legacy from v0002: missing none; extra ${FIXTURE_GROUP_IDS.content}`],
    },
    {
      name: 'v0003 keeps the archive group target',
      to: rollbackVersion({ [FIXTURE_GROUP_IDS.archive]: 'target' }, R_GROUPS),
      refs: R_GROUPS,
      returned: [FIXTURE_GROUP_IDS.roster],
      problems: [
        `groups returned to legacy from v0002: missing ${FIXTURE_GROUP_IDS.archive}; extra none`,
        `R groups not legacy-authoritative in v0003: ${FIXTURE_GROUP_IDS.archive}`,
      ],
    },
  ])('is thrown with exit code 1 and all three sets when $name', ({ to, refs, returned, problems }) => {
    let caught: unknown;
    try {
      derive(fixtureGroups(), V0002, to);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RollbackSetMismatchError);
    const error = caught as RollbackSetMismatchError;
    expect(error).toMatchObject({ name: 'RollbackSetMismatchError', exitCode: 1, computed: R_GROUPS, rollbackRefGroups: refs, returnedToLegacy: returned });
    expect(error.message.split('\n')).toEqual([
      `v0003 disagrees with the roster rollback set R (${R_GROUPS.join(', ')})`,
      ...problems.map((problem) => `  ${problem}`),
    ]);
  });
});

describe('session modes', () => {
  it.each<{ name: string; groups: GroupsFile; from: CutoverVersion; to: CutoverVersion; loginGroupId: string | undefined; expected: RollbackSet }>([
    {
      name: 'no group of R holds the login route and the login group stays target',
      groups: fixtureGroups(),
      from: V0002,
      to: V0003,
      loginGroupId: FIXTURE_GROUP_IDS.login,
      expected: { groups: R_GROUPS, units: R_UNITS, containsLoginGroup: false, sessionModeBefore: 'target-primary', sessionModeAfter: 'target-primary' },
    },
    {
      name: 'no group of R holds the login route and the login group stays legacy',
      groups: fixtureGroups(),
      from: fixtureVersion(ROLLBACK_FROM_VERSION, { ...V0002.groupAuthority, ...LOGIN_LEGACY }),
      to: rollbackVersion(LOGIN_LEGACY, R_GROUPS),
      loginGroupId: FIXTURE_GROUP_IDS.login,
      expected: { groups: R_GROUPS, units: R_UNITS, containsLoginGroup: false, sessionModeBefore: 'legacy-primary', sessionModeAfter: 'legacy-primary' },
    },
    {
      name: 'no group holds the login route',
      groups: editGroup(FIXTURE_GROUP_IDS.login, { writeEntries: [FIXTURE_ROUTES.groupUpdate] }),
      from: V0002,
      to: V0003,
      loginGroupId: undefined,
      expected: { groups: R_GROUPS, units: R_UNITS, containsLoginGroup: false, sessionModeBefore: 'legacy-primary', sessionModeAfter: 'legacy-primary' },
    },
    {
      name: 'the roster create group also holds the login route',
      groups: rosterWithLogin(),
      from: MERGED_FROM,
      to: MERGED_TO,
      loginGroupId: FIXTURE_GROUP_IDS.roster,
      expected: {
        groups: R_GROUPS,
        units: sorted([...R_UNITS, UNITS.groupAccount, UNITS.loginState]),
        containsLoginGroup: true,
        sessionModeBefore: 'target-primary',
        sessionModeAfter: 'legacy-primary',
      },
    },
  ])('follow the login group when $name', ({ groups, from, to, loginGroupId, expected }) => {
    expect(loginGroup(groups)?.id).toBe(loginGroupId);
    if (loginGroupId !== undefined) expect(groups.groups.find((group) => group.id === loginGroupId)?.writeEntries).toContain(LOGIN_ROUTE_KEY);

    expect(derive(groups, from, to)).toEqual(expected);
  });
});

describe('computeRollbackSet', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each([
    { name: 'the fixture groups', groups: fixtureGroups(), from: V0002, to: V0003 },
    { name: 'the roster group holding the login route', groups: rosterWithLogin(), from: MERGED_FROM, to: MERGED_TO },
  ])('derives R from groups.json, v0002 and v0003 of the configured cut-over directory for $name', async ({ groups, from, to }) => {
    const dir = await writeCutoverDir({ groups, versions: [from, to] });
    cleanups.push(dir.cleanup);

    expect(computeRollbackSet({ config: configFor(dir) })).toEqual(derive(groups, from, to));
  });

  it('rejects a written v0003 whose rollbackRefs omit a group of R', async () => {
    const dir = await writeCutoverDir({ versions: [V0002, rollbackVersion({}, [FIXTURE_GROUP_IDS.archive])] });
    cleanups.push(dir.cleanup);

    expect(() => computeRollbackSet({ config: configFor(dir) })).toThrow(RollbackSetMismatchError);
  });

  it("agrees with the committed groups.json and v0003's rollbackRefs", () => {
    const committed = loadVersion(config.paths.cutoverDir, ROLLBACK_VERSION);

    const set = computeRollbackSet({ config });

    expect(set.groups).not.toHaveLength(0);
    expect(sorted(new Set(committed.rollbackRefs.flatMap((ref) => ref.groups)))).toEqual(set.groups);
    for (const ref of committed.rollbackRefs) expect(sorted(ref.rollbackSet)).toEqual(set.groups);
  });
});

const FIXTURE_SET = derive(fixtureGroups());
const LOGIN_SET = derive(rosterWithLogin(), MERGED_FROM, MERGED_TO);
const LEGACY_LOGIN_SET = derive(
  rosterWithLogin(),
  { ...MERGED_FROM, groupAuthority: { ...MERGED_FROM.groupAuthority, [FIXTURE_GROUP_IDS.roster]: 'legacy' } },
  MERGED_TO,
);
const OUTCOME_IDS: string[] = [...REHEARSAL_SCENARIOS, SESSION_SCENARIO];
const SCENARIO_LABELS: Readonly<Record<string, string>> = {
  'GS-PE-RH-01': 'roster create',
  'GS-PE-RH-02': 'roster edit',
  'GS-PE-RH-03': 'archive → blackout',
  'GS-ID-09': 'session step across `v0003` activation',
};
const REBASELINE: RebaselineRecord = {
  tableVersion: ROLLBACK_VERSION,
  groups: R_GROUPS,
  units: R_UNITS,
  snapshotSeq: 42,
  startedAt: t(20),
  finishedAt: t(22),
  feed: { snapshotSeq: 42, units: R_UNITS, tables: [] },
};
/** The rehearsal scenarios' replays under v0003, one a minute from minute 23, after the re-baseline. */
const REPLAYS: ReplayRun[] = REHEARSAL_SCENARIOS.map((id, index) => ({
  id,
  tableVersion: ROLLBACK_VERSION,
  startedAt: t(23 + index),
  finishedAt: t(24 + index),
}));
/** The session crossing's replay, resumed under v0003 right after the transition. */
const SESSION_REPLAY: ReplayRun = { id: SESSION_SCENARIO, tableVersion: ROLLBACK_VERSION, startedAt: t(9), finishedAt: t(10) };
/** The feed pass between the rehearsal replays and rollback-after. */
const FEED_PASS: FeedRun = {
  path: 'reconciliation/after-feed-2.json',
  result: 'zero-difference',
  startedAt: t(27),
  finishedAt: t(28),
  tableVersion: ROLLBACK_VERSION,
};
const PARITY_AT = t(31);
/** When rollback-before is written: inside step 6, `final-state-and-reconcile`, which runs from minute 5 to minute 6. */
const BEFORE_AT = t(5, 50);
const GENERATED_BY_LINE = 'Generated by: migration/src/rollback/ (`opt2-migrate rollback report`)';

function evidenceLine(...labels: string[]): string {
  return `Evidence missing or not from this rehearsal: ${labels.join(', ')}.`;
}

function replayPath(id: string): string {
  return `harness/golden/replay/${id}.json`;
}

function outcome(id: string, result: string): ScenarioOutcome {
  const golden = id === SESSION_SCENARIO ? SESSION_GOLDEN_SET : `harness/golden/sets/${id}.json`;
  return { id, result, golden, replay: replayPath(id) };
}

/** Replay output of `id`'s rehearsal crossing, as `parity.json` `rehearsalCrossings` cites it. */
function crossingPath(id: string): string {
  return `\${OPT2_STATE_DIR}/golden/replay/rehearsal/${id}.json`;
}

/** `id`'s rehearsal crossing row with `result`, compared under the rollback version with its crossing's golden set. */
function crossingRow(id: string, result: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    result,
    tableVersion: ROLLBACK_VERSION,
    evidence: { golden: `harness/golden/sets/rehearsal/${id}.json`, replay: crossingPath(id) },
    ...over,
  };
}

/** A transition `from` → `to` whose eight steps each ran once and succeeded. */
function transition(transitionId: string, from = ROLLBACK_FROM_VERSION, to = ROLLBACK_VERSION): TransitionLogEntry {
  return {
    transitionId,
    from,
    to,
    startedAt: t(0),
    finishedAt: t(TRANSITION_STEP_NAMES.length),
    setT: R_UNITS,
    entriesChanged: [FIXTURE_ROUTES.archive, FIXTURE_ROUTES.rosterAdd, FIXTURE_ROUTES.rosterUpdate],
    legacyWriteEntries: [],
    steps: TRANSITION_STEP_NAMES.map((name, index) => ({ step: index + 1, name, startedAt: t(index), finishedAt: t(index + 1), result: 'ok' })),
    outcome: 'activated',
  };
}

/** The reconciliation report of `point` with `result`, `before` inside the transition's step 6; a ran report compares R's five units. */
function reconciliation(point: keyof typeof RECONCILIATION_REPORTS, result: string): ReconciliationRef {
  const ref = { path: RECONCILIATION_REPORTS[point], result };
  if (result === 'not-run') return ref;
  return {
    ...ref,
    generatedAt: point === 'before' ? BEFORE_AT : t(30),
    tableVersion: point === 'before' ? ROLLBACK_FROM_VERSION : ROLLBACK_VERSION,
    units: R_UNITS.length,
    differences: result === 'difference' ? 2 : 0,
  };
}

/** Every piece of rehearsal evidence present and accepted. */
function completeInput(): RollbackReportInput {
  return {
    sourceSha: TEST_SOURCE_SHA,
    generatedAt: GENERATED_AT,
    set: FIXTURE_SET,
    groupDetails: fixtureGroups()
      .groups.filter((group) => FIXTURE_SET.groups.includes(group.id))
      .map((group) => ({ id: group.id, entryPoints: group.writeEntries, units: group.units })),
    transition: transition('tr-rollback'),
    rebaseline: REBASELINE,
    reconciliation: { before: reconciliation('before', 'zero-difference'), after: reconciliation('after', 'zero-difference') },
    replays: REPLAYS,
    feeds: [FEED_PASS],
    scenarios: REHEARSAL_SCENARIOS.map((id) => outcome(id, 'pass')),
    session: { ...outcome(SESSION_SCENARIO, 'pass'), tableVersion: ROLLBACK_VERSION },
    sessionReplay: SESSION_REPLAY,
    parityGeneratedAt: PARITY_AT,
    fixtures: { available: true },
  };
}

/** Expected Groups table rows of the fixture R, with each group's entry points and units. */
function fixtureGroupRows(): string[] {
  return fixtureGroups()
    .groups.filter((group) => R_GROUPS.includes(group.id))
    .map((group) => `| ${code(group.id)} | ${codeList(group.writeEntries)} | ${codeList(group.units)} |`);
}

function reconciliationRow(ref: ReconciliationRef): string {
  const point = path.posix.basename(ref.path, '.json');
  const value = (cell: string | number | undefined): string => (cell === undefined ? ref.result : String(cell));
  return `| ${point} | [${ref.path}](${ref.path}) | ${value(ref.tableVersion)} | ${value(ref.units)} | ${value(ref.differences)} | ${ref.result} |`;
}

/** Replay row of `id`; the session scenario's golden set is its rehearsal crossing's. */
function replayRow(id: string, replay: string | undefined, result: string): string {
  const label = SCENARIO_LABELS[id] ?? '';
  const golden = id === SESSION_SCENARIO ? SESSION_GOLDEN_SET : `harness/golden/sets/${id}.json`;
  return `| ${id} (${label}) | ${code(golden)} | ${replay === undefined ? 'not-run' : code(replay)} | ${result} |`;
}

function shaLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith('Source SHA:'));
}

describe('renderRollbackReport', () => {
  it('renders R, both session modes, both reconciliations and every rehearsal scenario under one Source SHA line', () => {
    const input = completeInput();

    const { markdown, result } = renderRollbackReport(input);

    const lines = markdown.split('\n');
    expect(result).toBe('pass');
    expect(shaLines(lines)).toEqual([`Source SHA: ${TEST_SOURCE_SHA}`]);
    expect(lines[lines.indexOf('Status: pass') + 1]).toBe(GENERATED_BY_LINE);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Status: pass',
        ...fixtureGroupRows(),
        `Units of \`R\` (${String(R_UNITS.length)}): ${codeList(R_UNITS)}.`,
        '| target-primary | target-primary | no |',
        reconciliationRow(input.reconciliation.before),
        reconciliationRow(input.reconciliation.after),
        ...OUTCOME_IDS.map((id) => replayRow(id, replayPath(id), 'pass')),
        'Fixtures available: the rehearsal covers create, edit and the archive-to-blackout leg (GS-PE-RH-03).',
      ]),
    );
  });

  it.each([
    { name: 'R without the login group', set: FIXTURE_SET, row: '| target-primary | target-primary | no |' },
    { name: 'R holding the login group', set: LOGIN_SET, row: '| target-primary | legacy-primary | yes |' },
    {
      name: 'R holding a login group v0002 already keeps legacy',
      set: LEGACY_LOGIN_SET,
      row: '| legacy-primary | legacy-primary | yes; already `legacy` in `v0002`, no mode switch |',
    },
  ])('renders the session modes before and after the rollback for $name', ({ set, row }) => {
    const lines = renderRollbackReport({ ...completeInput(), set }).markdown.split('\n');

    expect(lines.slice(lines.indexOf('## Session mode'), lines.indexOf('## Steps'))).toEqual([
      '## Session mode',
      '',
      '| Before (`v0002`) | After (`v0003`) | `R` contains the `clogin.login` group |',
      '|---|---|---|',
      row,
      '',
      'Values are `target-primary` or `legacy-primary`; the mode changes only if `R` contains the group of `clogin.login` ' +
        'and `v0002` has that group `target`-authoritative.',
      '',
    ]);
  });

  it.each([
    { name: 'without recorded group details', edit: { groupDetails: undefined }, rows: R_GROUPS.map((id) => `| ${code(id)} | — | — |`) },
    {
      name: 'for an empty R',
      edit: { set: { ...FIXTURE_SET, groups: [], units: [] }, groupDetails: [] },
      rows: ['| none | — | — |', 'Units of `R` (0): none.'],
    },
  ])('renders the group table $name', ({ edit, rows }) => {
    const lines = renderRollbackReport({ ...completeInput(), ...edit }).markdown.split('\n');

    expect(lines).toEqual(expect.arrayContaining(rows));
  });

  const withScenario =
    (index: number, result: string) =>
    (input: RollbackReportInput): RollbackReportInput => ({
      ...input,
      scenarios: input.scenarios.map((scenario, at) => (at === index ? { ...scenario, result } : scenario)),
    });
  const withReconciliation =
    (point: keyof typeof RECONCILIATION_REPORTS, result: string) =>
    (input: RollbackReportInput): RollbackReportInput => ({
      ...input,
      reconciliation: { ...input.reconciliation, [point]: reconciliation(point, result) },
    });

  it.each<{ name: string; edit: (input: RollbackReportInput) => RollbackReportInput; result: 'pass' | 'fail' | 'incomplete' }>([
    { name: 'every piece of evidence is complete and accepted', edit: (input) => input, result: 'pass' },
    {
      name: 'the scenarios end excepted and known-issue',
      edit: (input) => withScenario(1, 'known-issue')(withScenario(0, 'excepted')(input)),
      result: 'pass',
    },
    { name: 'the fixture status is not recorded and every scenario passed', edit: (input) => ({ ...input, fixtures: undefined }), result: 'pass' },
    { name: 'a rehearsal scenario fails', edit: withScenario(2, 'fail'), result: 'fail' },
    {
      name: 'the session step fails',
      edit: (input) => ({ ...input, session: { ...outcome(SESSION_SCENARIO, 'fail'), tableVersion: ROLLBACK_VERSION } }),
      result: 'fail',
    },
    {
      name: 'the rollback transition aborted',
      edit: (input) => ({ ...input, transition: { ...transition('tr-rollback'), outcome: 'aborted', abortReason: 'reconciliation of R found differences' } }),
      result: 'fail',
    },
    {
      name: 'a difference coincides with an unrun scenario',
      edit: (input) => withScenario(0, 'not-run')(withReconciliation('after', 'difference')(input)),
      result: 'fail',
    },
    { name: 'the after reconciliation has not run', edit: withReconciliation('after', 'not-run'), result: 'incomplete' },
    { name: 'a rehearsal scenario has not run', edit: withScenario(1, 'not-run'), result: 'incomplete' },
    { name: 'a rehearsal scenario is withheld', edit: withScenario(0, 'withheld'), result: 'incomplete' },
    { name: 'no rollback transition is logged', edit: (input) => ({ ...input, transition: undefined }), result: 'incomplete' },
    {
      name: 'the rollback transition is unfinished',
      edit: (input) => ({ ...input, transition: { ...transition('tr-rollback'), finishedAt: undefined, outcome: undefined } }),
      result: 'incomplete',
    },
    { name: 'no re-baseline record exists', edit: (input) => ({ ...input, rebaseline: undefined }), result: 'incomplete' },
    {
      name: 'the fixtures are unavailable',
      edit: (input) => ({ ...input, fixtures: { available: false, reason: 'CREATE SCHEMA permission denied' } }),
      result: 'incomplete',
    },
  ])('returns $result when $name', ({ edit, result }) => {
    const rendered = renderRollbackReport(edit(completeInput()));

    expect(rendered.result).toBe(result);
    expect(rendered.markdown.split('\n')).toContain(`Status: ${result}`);
  });

  const BEFORE_FILE = code(RECONCILIATION_REPORTS.before);
  const AFTER_FILE = code(RECONCILIATION_REPORTS.after);
  const withRef =
    (point: keyof typeof RECONCILIATION_REPORTS, patch: Partial<ReconciliationRef>) =>
    (input: RollbackReportInput): RollbackReportInput => ({
      ...input,
      reconciliation: { ...input.reconciliation, [point]: { ...input.reconciliation[point], ...patch } },
    });

  it.each<{ name: string; edit: (input: RollbackReportInput) => RollbackReportInput; result: 'fail' | 'incomplete'; next: string }>([
    {
      name: 'rollback-before.json is from an earlier transition',
      edit: withRef('before', { generatedAt: dayBefore(BEFORE_AT) }),
      result: 'incomplete',
      next: evidenceLine(BEFORE_FILE),
    },
    {
      name: 'rollback-before.json was written after its final-state-and-reconcile step ended',
      edit: withRef('before', { startedAt: t(5, 30), generatedAt: t(6, 30) }),
      result: 'incomplete',
      next: evidenceLine(BEFORE_FILE),
    },
    { name: 'rollback-before.json was taken under v0003', edit: withRef('before', { tableVersion: ROLLBACK_VERSION }), result: 'incomplete', next: evidenceLine(BEFORE_FILE) },
    { name: 'rollback-before.json from step 6 shows a difference', edit: withReconciliation('before', 'difference'), result: 'fail', next: GENERATED_BY_LINE },
    {
      name: 'an earlier rollback-before.json shows a difference',
      edit: (input) => withRef('before', { generatedAt: dayBefore(BEFORE_AT) })(withReconciliation('before', 'difference')(input)),
      result: 'incomplete',
      next: evidenceLine(BEFORE_FILE),
    },
    {
      name: 'the re-baseline predates the transition, so the rehearsal replays after it are not bound',
      edit: (input) => ({ ...input, rebaseline: { ...REBASELINE, startedAt: dayBefore(t(20)), finishedAt: dayBefore(t(22)) } }),
      result: 'incomplete',
      next: evidenceLine('re-baseline', ...REHEARSAL_SCENARIOS.map((id) => `${id} replay`)),
    },
    {
      name: 'a rehearsal replay is missing',
      edit: (input) => ({ ...input, replays: REPLAYS.filter((run) => run.id !== 'GS-PE-RH-02') }),
      result: 'incomplete',
      next: evidenceLine('GS-PE-RH-02 replay'),
    },
    {
      name: 'the crossing replay predates the activation',
      edit: (input) => ({ ...input, sessionReplay: { ...SESSION_REPLAY, startedAt: t(5), finishedAt: t(6) } }),
      result: 'incomplete',
      next: evidenceLine('GS-ID-09 crossing replay'),
    },
    {
      name: 'the crossing replay ran under v0002',
      edit: (input) => ({ ...input, sessionReplay: { ...SESSION_REPLAY, tableVersion: ROLLBACK_FROM_VERSION } }),
      result: 'incomplete',
      next: evidenceLine('GS-ID-09 crossing replay'),
    },
    {
      name: 'the crossing replay ran after both the feed pass and rollback-after',
      edit: (input) => ({ ...input, sessionReplay: { ...SESSION_REPLAY, startedAt: t(40), finishedAt: t(41) } }),
      result: 'incomplete',
      next: evidenceLine('feed pass', AFTER_FILE, '`parity.json`'),
    },
    {
      name: 'the crossing parity row records no v0003',
      edit: (input) => ({ ...input, session: outcome(SESSION_SCENARIO, 'pass') }),
      result: 'incomplete',
      next: evidenceLine('GS-ID-09 crossing parity row'),
    },
    {
      name: 'the session step fails in a parity row that records no v0003',
      edit: (input) => ({ ...input, session: outcome(SESSION_SCENARIO, 'fail') }),
      result: 'incomplete',
      next: evidenceLine('GS-ID-09 crossing parity row'),
    },
    { name: 'no feed pass ran', edit: (input) => ({ ...input, feeds: [] }), result: 'incomplete', next: evidenceLine('feed pass', AFTER_FILE) },
    {
      name: 'the only feed pass ran under v0002',
      edit: (input) => ({ ...input, feeds: [{ ...FEED_PASS, tableVersion: ROLLBACK_FROM_VERSION }] }),
      result: 'incomplete',
      next: evidenceLine('feed pass', AFTER_FILE),
    },
    {
      name: "an earlier run's feed pass shows a difference",
      edit: (input) => ({ ...input, feeds: [{ ...FEED_PASS, result: 'difference', startedAt: dayBefore(t(27)), finishedAt: dayBefore(t(28)) }] }),
      result: 'incomplete',
      next: evidenceLine('feed pass', AFTER_FILE),
    },
    {
      name: 'rollback-after predates the feed pass',
      edit: withRef('after', { generatedAt: t(27, 30) }),
      result: 'incomplete',
      next: evidenceLine('feed pass', AFTER_FILE),
    },
    { name: 'rollback-after was taken under v0002', edit: withRef('after', { tableVersion: ROLLBACK_FROM_VERSION }), result: 'incomplete', next: evidenceLine(AFTER_FILE) },
    { name: 'a fresh rollback-after.json shows a difference', edit: withReconciliation('after', 'difference'), result: 'fail', next: GENERATED_BY_LINE },
    {
      name: "an earlier run's rollback-after.json shows a difference",
      edit: (input) => withRef('after', { generatedAt: dayBefore(t(30)) })(withReconciliation('after', 'difference')(input)),
      result: 'incomplete',
      next: evidenceLine(AFTER_FILE),
    },
    { name: 'parity.json predates the rehearsal replays', edit: (input) => ({ ...input, parityGeneratedAt: t(25) }), result: 'incomplete', next: evidenceLine('`parity.json`') },
    { name: 'parity.json records no generatedAt', edit: (input) => ({ ...input, parityGeneratedAt: undefined }), result: 'incomplete', next: evidenceLine('`parity.json`') },
    {
      name: 'an earlier parity.json records a rehearsal fail',
      edit: (input) => ({ ...withScenario(0, 'fail')(input), parityGeneratedAt: dayBefore(PARITY_AT) }),
      result: 'incomplete',
      next: evidenceLine('`parity.json`'),
    },
    {
      name: 'an earlier parity.json records a crossing fail',
      edit: (input) => ({ ...input, session: { ...input.session, result: 'fail' }, parityGeneratedAt: dayBefore(PARITY_AT) }),
      result: 'incomplete',
      next: evidenceLine('`parity.json`'),
    },
    {
      name: 'no rollback transition is logged',
      edit: (input) => ({ ...input, transition: undefined }),
      result: 'incomplete',
      next: evidenceLine(
        'activated `v0003` transition',
        BEFORE_FILE,
        're-baseline',
        ...REHEARSAL_SCENARIOS.map((id) => `${id} replay`),
        'GS-ID-09 crossing replay',
        'feed pass',
        AFTER_FILE,
        '`parity.json`',
      ),
    },
    {
      name: 'every link holds and the fixtures are unavailable',
      edit: (input) => ({ ...input, fixtures: { available: false } }),
      result: 'incomplete',
      next: GENERATED_BY_LINE,
    },
    {
      name: 'the feed pass shows a difference',
      edit: (input) => ({ ...input, feeds: [{ ...FEED_PASS, result: 'difference' }] }),
      result: 'fail',
      next: GENERATED_BY_LINE,
    },
  ])('binds the evidence to the latest rollback transition: $result when $name', ({ edit, result, next }) => {
    const rendered = renderRollbackReport(edit(completeInput()));

    const lines = rendered.markdown.split('\n');
    expect(rendered.result).toBe(result);
    expect(lines[lines.indexOf(`Status: ${result}`) + 1]).toBe(next);
  });

  it.each([
    {
      name: 'available',
      fixtures: { available: true },
      line: 'Fixtures available: the rehearsal covers create, edit and the archive-to-blackout leg (GS-PE-RH-03).',
    },
    {
      name: 'unavailable with a reason',
      fixtures: { available: false, reason: 'CREATE SCHEMA permission denied\nin muradb' },
      line: `Fixtures unavailable (CREATE SCHEMA permission denied in muradb): ${UNMET_ARCHIVE_LEG}`,
    },
    { name: 'unavailable without a reason', fixtures: { available: false }, line: `Fixtures unavailable: ${UNMET_ARCHIVE_LEG}` },
    {
      name: 'not recorded',
      fixtures: undefined,
      line: `Fixture status not recorded (\`fixtures.json\` absent from the state directory); with fixtures unavailable, ${UNMET_ARCHIVE_LEG}`,
    },
  ])('states the fixture status when fixtures are $name', ({ fixtures, line }) => {
    const lines = renderRollbackReport({ ...completeInput(), fixtures }).markdown.split('\n');

    expect(lines).toContain(line);
  });
});

describe('writeRollbackReport', () => {
  let dirs: TestDirs;
  let ctx: Pick<MigrationContext, 'env' | 'config' | 'clock'>;

  beforeEach(async () => {
    dirs = await createTestDirs();
    const cutover = await writeCutoverDir({ dir: path.join(dirs.stateDir, 'cutover') });
    ctx = { env: testEnv({ dirs }), config: configFor(cutover), clock: createMutableClock(GENERATED_AT) };
  });

  afterEach(async () => {
    await dirs.cleanup();
  });

  async function writeJson(file: string, doc: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }

  const reportFile = (relPath: string): string => path.join(dirs.reportsDir, relPath);

  async function readLines(file: string): Promise<string[]> {
    return (await readFile(file, 'utf8')).split('\n');
  }

  /** Writes `id`'s replay output from minute `minute` to the next, under `segments` of the state directory's replay directory. */
  const replayFile = (id: string, minute: number, tableVersion = ROLLBACK_VERSION, ...segments: string[]) =>
    writeJson(path.join(dirs.stateDir, 'golden', 'replay', ...segments, `${id}.json`), {
      sourceSha: TEST_SOURCE_SHA,
      scenarioId: id,
      replayedAt: t(minute),
      origin: 'gateway',
      tableVersion,
      steps: [],
      generatedAt: t(minute + 1),
    });

  /** Writes the replay outputs of {@link REPLAYS} and {@link SESSION_REPLAY}. */
  const rehearsalReplayFiles = (): Promise<void>[] => [
    ...REHEARSAL_SCENARIOS.map((id, index) => replayFile(id, 23 + index)),
    replayFile(SESSION_SCENARIO, 9, ROLLBACK_VERSION, 'rehearsal'),
  ];

  it('writes an incomplete report with every outcome not-run when no evidence exists', async () => {
    const written = await writeRollbackReport(ctx);

    expect(written).toEqual({ reportPath: reportFile(ROLLBACK_REPORT_PATH), result: 'incomplete', exitCode: 0 });
    const lines = await readLines(written.reportPath);
    expect(shaLines(lines)).toEqual([`Source SHA: ${TEST_SOURCE_SHA}`]);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Status: incomplete',
        `Generated at: ${GENERATED_AT}`,
        ...fixtureGroupRows(),
        '| target-primary | target-primary | no |',
        reconciliationRow(reconciliation('before', 'not-run')),
        reconciliationRow(reconciliation('after', 'not-run')),
        ...OUTCOME_IDS.map((id) => replayRow(id, undefined, 'not-run')),
        'Transition to `v0003`: not-run.',
        `Fixture status not recorded (\`fixtures.json\` absent from the state directory); with fixtures unavailable, ${UNMET_ARCHIVE_LEG}`,
      ]),
    );
  });

  it.each(['pass', 'excepted'])('reads the latest v0003 transition, parity outcomes, reconciliations, re-baseline and fixtures into a passing report (crossing %s)', async (crossing) => {
    await Promise.all([
      writeJson(reportFile('transitions.json'), {
        transitions: [
          { ...transition('tr-aborted'), outcome: 'aborted', abortReason: 'outbox not drained' },
          transition('tr-rollback'),
          transition('tr-forward', 'v0001', ROLLBACK_FROM_VERSION),
        ],
      }),
      writeJson(reportFile('parity.json'), {
        generatedAt: PARITY_AT,
        scenarios: [
          ...REHEARSAL_SCENARIOS.map((id) => ({ id, result: 'pass', evidence: { golden: `harness/golden/sets/${id}.json`, replay: replayPath(id) } })),
          { id: SESSION_SCENARIO, result: 'withheld', evidence: { golden: `harness/golden/sets/${SESSION_SCENARIO}.json`, replay: replayPath(SESSION_SCENARIO) } },
          { id: 'GS-CO-01', result: 'fail' },
        ],
        rehearsalCrossings: [crossingRow(SESSION_SCENARIO, crossing)],
      }),
      writeJson(reportFile(RECONCILIATION_REPORTS.before), {
        result: 'zero-difference',
        generatedAt: BEFORE_AT,
        tableVersion: ROLLBACK_FROM_VERSION,
        summary: { units: R_UNITS.length, unitsWithDifferences: 0 },
      }),
      writeJson(reportFile(RECONCILIATION_REPORTS.after), {
        result: 'zero-difference',
        generatedAt: t(30),
        tableVersion: ROLLBACK_VERSION,
        summary: { units: R_UNITS.length, unitsWithDifferences: 0 },
      }),
      writeJson(reportFile(FEED_PASS.path), {
        result: 'zero-difference',
        tableVersion: ROLLBACK_VERSION,
        feed: { startedAt: FEED_PASS.startedAt },
        generatedAt: FEED_PASS.finishedAt,
      }),
      writeJson(rebaselineRecordPath(dirs.stateDir), REBASELINE),
      ...rehearsalReplayFiles(),
      writeJson(path.join(dirs.stateDir, 'fixtures.json'), { available: true, reason: null }),
    ]);

    const written = await writeRollbackReport(ctx);

    expect(written).toMatchObject({ result: 'pass', exitCode: 0 });
    expect(await readLines(written.reportPath)).toEqual(
      expect.arrayContaining([
        'Status: pass',
        `Transition \`tr-rollback\` \`v0002\` → \`v0003\`, started ${t(0)}, finished ${t(8)}: activated`,
        reconciliationRow(reconciliation('before', 'zero-difference')),
        reconciliationRow(reconciliation('after', 'zero-difference')),
        ...REHEARSAL_SCENARIOS.map((id) => replayRow(id, replayPath(id), 'pass')),
        replayRow(SESSION_SCENARIO, crossingPath(SESSION_SCENARIO), crossing),
        'Fixtures available: the rehearsal covers create, edit and the archive-to-blackout leg (GS-PE-RH-03).',
      ]),
    );
  });

  const failedCrossing = crossingRow(SESSION_SCENARIO, 'fail', {
    reason: '1 unlisted difference',
    differences: [{ step: 'adopt-continue', path: 'status', kind: 'status', expected: 200, actual: 503, classification: 'difference' }],
    decisionListRef: ['opt2/decision-list.json#actionVariants/page:render'],
  });

  it.each([
    {
      name: 'only its v0002 parity row exists, which is not the crossing',
      parity: { generatedAt: PARITY_AT, scenarios: OUTCOME_IDS.map((id) => ({ id, result: 'pass' })) },
      row: replayRow(SESSION_SCENARIO, undefined, 'not-run'),
      result: 'incomplete',
      exitCode: 0,
    },
    {
      name: "its crossing's adopt-continue answers 503 under v0003 while its v0002 row passes",
      parity: { generatedAt: PARITY_AT, scenarios: OUTCOME_IDS.map((id) => ({ id, result: 'pass' })), rehearsalCrossings: [failedCrossing] },
      row: replayRow(SESSION_SCENARIO, crossingPath(SESSION_SCENARIO), 'fail'),
      result: 'fail',
      exitCode: 1,
    },
    {
      name: "an earlier run's parity.json records that failed crossing",
      parity: {
        generatedAt: dayBefore(PARITY_AT),
        scenarios: OUTCOME_IDS.map((id) => ({ id, result: 'pass' })),
        rehearsalCrossings: [failedCrossing],
      },
      row: replayRow(SESSION_SCENARIO, crossingPath(SESSION_SCENARIO), 'fail'),
      result: 'incomplete',
      exitCode: 0,
    },
  ])('reads the rollback session step from its rehearsal crossing when $name', async ({ parity, row, result, exitCode }) => {
    await Promise.all([
      writeJson(reportFile('transitions.json'), { transitions: [transition('tr-rollback')] }),
      writeJson(reportFile('parity.json'), parity),
    ]);

    const written = await writeRollbackReport(ctx);

    expect(written).toMatchObject({ result, exitCode });
    expect(await readLines(written.reportPath)).toEqual(
      expect.arrayContaining([...REHEARSAL_SCENARIOS.map((id) => replayRow(id, undefined, 'pass')), row]),
    );
  });

  it('times the reconciliations, the rehearsal replays and the feed run between them in run order', async () => {
    const reconciliationFile = (point: string, doc: object) => writeJson(reportFile(`reconciliation/${point}.json`), { result: 'zero-difference', ...doc });
    await Promise.all([
      writeJson(reportFile('transitions.json'), { transitions: [transition('tr-rollback')] }),
      writeJson(reportFile('parity.json'), {
        scenarios: OUTCOME_IDS.map((id) => ({ id, result: 'pass' })),
        rehearsalCrossings: [crossingRow(SESSION_SCENARIO, 'pass')],
      }),
      reconciliationFile('rollback-before', { startedAt: t(5, 30), generatedAt: t(5, 50), tableVersion: ROLLBACK_FROM_VERSION }),
      reconciliationFile('rollback-after', { startedAt: t(29), generatedAt: t(30), tableVersion: ROLLBACK_VERSION }),
      reconciliationFile('after-feed-1', { generatedAt: t(26) }),
      reconciliationFile('after-feed-3', { feed: { startedAt: t(10) }, generatedAt: t(11) }),
      reconciliationFile('after-feed-43', { feed: { startedAt: t(27) }, generatedAt: t(28) }),
      reconciliationFile('after-feed-44', { feed: { startedAt: t(31) }, generatedAt: t(32) }),
      writeJson(rebaselineRecordPath(dirs.stateDir), REBASELINE),
      ...REHEARSAL_SCENARIOS.map((id, index) => replayFile(id, 23 + index)),
      replayFile(SESSION_SCENARIO, 2, ROLLBACK_FROM_VERSION),
    ]);

    const written = await writeRollbackReport(ctx);

    const cells = (await readLines(written.reportPath))
      .filter((line) => /^\| \d \| /.test(line))
      .map((line) => line.slice(2, -2).split(' | ').slice(2));
    expect(cells.slice(2, 4)).toEqual([
      [t(4), t(5, 30), 'ok'],
      [t(5, 30), t(5, 50), 'zero-difference'],
    ]);
    expect(cells.slice(5)).toEqual([
      [t(20), t(22), 'ok (snapshot 42)'],
      [t(23), t(26), 'pass'],
      [t(27), t(28), 'zero-difference ([reconciliation/after-feed-43.json](reconciliation/after-feed-43.json))'],
      [t(29), t(30), 'zero-difference'],
    ]);
    const times = cells.flatMap(([started = '', finished = '']) => [started, finished]);
    expect(times).toEqual([...times].sort());
  });

  it('reports incomplete when parity.json, rollback-after.json and the feed run predate a fresh rollback transition', async () => {
    const zero = { result: 'zero-difference', summary: { units: R_UNITS.length, unitsWithDifferences: 0 } };
    await Promise.all([
      writeJson(reportFile('transitions.json'), {
        transitions: [{ ...transition('tr-previous'), startedAt: dayBefore(t(0)), finishedAt: dayBefore(t(8)), steps: [] }, transition('tr-rollback')],
      }),
      writeJson(reportFile('parity.json'), {
        generatedAt: dayBefore(PARITY_AT),
        scenarios: REHEARSAL_SCENARIOS.map((id) => ({ id, result: 'pass' })),
        rehearsalCrossings: [crossingRow(SESSION_SCENARIO, 'pass')],
      }),
      writeJson(reportFile(RECONCILIATION_REPORTS.before), { ...zero, startedAt: t(5, 30), generatedAt: BEFORE_AT, tableVersion: ROLLBACK_FROM_VERSION }),
      writeJson(reportFile(RECONCILIATION_REPORTS.after), { ...zero, startedAt: dayBefore(t(29)), generatedAt: dayBefore(t(30)), tableVersion: ROLLBACK_VERSION }),
      writeJson(reportFile('reconciliation/after-feed-8.json'), {
        ...zero,
        tableVersion: ROLLBACK_VERSION,
        feed: { startedAt: dayBefore(t(27)) },
        generatedAt: dayBefore(t(28)),
      }),
      writeJson(rebaselineRecordPath(dirs.stateDir), REBASELINE),
      ...rehearsalReplayFiles(),
      writeJson(path.join(dirs.stateDir, 'fixtures.json'), { available: true, reason: null }),
    ]);

    const written = await writeRollbackReport(ctx);

    expect(written).toMatchObject({ result: 'incomplete', exitCode: 0 });
    const lines = await readLines(written.reportPath);
    expect(lines[lines.indexOf('Status: incomplete') + 1]).toBe(evidenceLine('feed pass', code(RECONCILIATION_REPORTS.after), '`parity.json`'));
  });

  it.each([
    { name: 'this rehearsal', generatedAt: t(30), result: 'fail', exitCode: 1 },
    { name: 'an earlier run', generatedAt: dayBefore(t(30)), result: 'incomplete', exitCode: 0 },
  ])('states unavailable fixtures and exits $exitCode when a rollback-after.json from $name shows a difference', async ({ generatedAt, result, exitCode }) => {
    await Promise.all([
      writeJson(reportFile('transitions.json'), { transitions: [transition('tr-rollback')] }),
      writeJson(reportFile(RECONCILIATION_REPORTS.after), {
        result: 'difference',
        generatedAt,
        tableVersion: ROLLBACK_VERSION,
        summary: { units: R_UNITS.length, unitsWithDifferences: 2 },
      }),
      writeJson(path.join(dirs.stateDir, 'fixtures.json'), { available: false, reason: 'CREATE SCHEMA permission denied' }),
    ]);

    const written = await writeRollbackReport(ctx);

    expect(written).toMatchObject({ result, exitCode });
    expect(await readLines(written.reportPath)).toEqual(
      expect.arrayContaining([
        `Status: ${result}`,
        reconciliationRow(reconciliation('after', 'difference')),
        `Fixtures unavailable (CREATE SCHEMA permission denied): ${UNMET_ARCHIVE_LEG}`,
      ]),
    );
  });
});
