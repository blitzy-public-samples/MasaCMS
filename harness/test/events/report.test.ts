// Events report over temp contract trees and temp state directories: nothing is dialled and nothing is written in the checkout.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DlqEvidence } from '../../src/events/dlq.js';
import type { OutboxReplayResult } from '../../src/events/outbox-replay.js';
import {
  CHECK_TAG,
  E2E_KEYS,
  EVENT_CHECK_IDS,
  EVENT_PACKAGES,
  EVENT_TOPICS,
  GENERATED_BY,
  NOT_RUN_REASON,
  OUTBOX_REPLAY_COMMAND,
  SEAM_IDS,
  SEAM_TOPICS,
  buildEventsReport,
  e2eResultPath,
  eventsOutcome,
  main,
  packageResultPath,
  readEventResults,
  readEventsReportInputs,
  readPackageResults,
  recordEventResult,
  seamRecordResult,
  topicsFromContracts,
  type CheckResult,
  type EventE2EKey,
  type EventResultRecord,
  type EventsReport,
  type EventsReportInputs,
  type TopicRow,
  type VitestJson,
} from '../../src/events/report.js';
import type { SeamResult } from '../../src/events/seams.js';
import { FIXTURES_UNAVAILABLE } from '../../src/golden/catalogue.js';
import { repoPath, type EnvLike } from '../../src/lib/paths.js';
import { vitestResultPath } from '../../src/reporting/speed.js';

const SAMPLES = fileURLToPath(new URL('../fixtures/contract-samples/', import.meta.url));
const REPORTING = fileURLToPath(new URL('../fixtures/reporting/', import.meta.url));
const SAMPLE_RESULTS = readFileSync(path.join(REPORTING, 'vitest-results.sample.json'), 'utf8');
const FIXTURES_UNAVAILABLE_STATUS = readFileSync(path.join(REPORTING, 'fixtures-unavailable.json'), 'utf8');
const FIXTURES_AVAILABLE_STATUS = JSON.stringify({ available: true, reason: null, checkedAt: '2026-06-30T00:00:00Z' });
const UNAVAILABLE_REASON = 'CREATE SCHEMA permission denied in the legacy database';

const COMMITTED_REPORT = repoPath('opt2', 'reports', 'events.json');
const PIN_SHA = (JSON.parse(readFileSync(repoPath('opt2', 'source-pin.json'), 'utf8')) as { sha: string }).sha;
const CLOCK = (): Date => new Date('2026-06-30T00:00:00.000Z');

const SOURCE = 'harness/e2e/events/report.fixture';
const PEOPLE = 'services/people';
const PEOPLE_EVENTS_FILE = 'services/people/test/events/archive-events.test.ts';

const ARCHIVED = 'people.person.archived.v1';
const CHANGED = 'people.person.changed.v1';
const STUB_NOTE = 'stub.note.created.v1';
const TREE_TOPICS: readonly string[] = [ARCHIVED, CHANGED, STUB_NOTE];

const SAMPLE_OPENAPI = ['people', 'timesheets', 'stub', 'identity'] as const;
const SKELETON_CONTRACTS = [
  'gateway/contracts/openapi.yaml',
  'migration/contracts/openapi.yaml',
  'services/programs-sites/contracts/openapi.yaml',
  'services/strategies-content/contracts/openapi.yaml',
  'services/communications/contracts/openapi.yaml',
  'services/reporting/contracts/openapi.yaml',
  'services/surveys/contracts/openapi.yaml',
  'services/finance/contracts/openapi.yaml',
  'services/e-signature/contracts/openapi.yaml',
] as const;

const SNAPSHOT: OutboxReplayResult['before'] = {
  inboxCounts: { 'timesheets/timesheets.people.person.archived.v1': 3 },
  aggregateChecksums: { 'timesheets/timesheets.blackout/7d4f3c1e-0000-5000-8000-000000000001': { rows: 3, checksum: 'a1b2c3' } },
};

const OUTBOX_EVIDENCE: OutboxReplayResult = {
  since: '2026-06-30T00:00:00.000Z',
  before: SNAPSHOT,
  after: structuredClone(SNAPSHOT),
  unchanged: true,
  replays: [{ service: 'people', exitCode: 0, summary: { republished: 3 } }],
  differences: [],
};

const DLQ_EVIDENCE: DlqEvidence = {
  subscription: 'stub.stub.note.created.v1',
  dlqTopic: 'stub.stub.note.created.v1.dlq',
  eventId: '0b9f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4',
  aggregateId: '6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9',
  rejection: { reason: 'tenant-mismatch', effectAfter: 0 },
  correction: { discardedOriginal: true },
  replay: { exitCode: 0, summary: { republished: 1 }, republished: 1 },
  effect: { before: 0, after: 1 },
  secondReplay: { exitCode: 0, summary: { republished: 0 }, republished: 0, effectAfter: 1 },
  failures: [],
};

type RecordEntry = readonly [EventE2EKey, EventResultRecord];

const passed = (evidence: unknown): EventResultRecord => ({ result: 'pass', evidence, source: SOURCE });

const MERGE_RECORDS: readonly RecordEntry[] = [
  ['dlqReplayOnce', passed(DLQ_EVIDENCE)],
  ['unpublishedRowSwept', passed({ sweptRows: 1 })],
  ['sweepChainRecreated', { result: FIXTURES_UNAVAILABLE, evidence: { reason: UNAVAILABLE_REASON }, source: SOURCE }],
  ['outboxReplay', passed(OUTBOX_EVIDENCE)],
  ['seams.archiveToBlackout', passed({ blackouts: 2 })],
  ['seams.surveyToCloudTasks', passed({ tasks: 3 })],
];

const COMPLETE_RECORDS: readonly RecordEntry[] = [
  ...MERGE_RECORDS.filter(([key]) => key !== 'sweepChainRecreated'),
  ['sweepChainRecreated', passed({ recreated: true })],
  ['outOfOrderState', passed({ staleIgnored: true })],
  ['outOfOrderProcess', passed({ effects: 2 })],
  ['droppedDeliveryRecovered', passed({ recovered: true })],
];

const temps: string[] = [];

/** A fresh directory under the OS temp folder, removed after the suite. */
async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `opt2-events-report-${label}-`));
  temps.push(dir);
  return dir;
}

/** Writes `text` to `file`, creating its parent folders. */
async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/** Copies `from` to `to`, creating the parent folders of `to`. */
async function copy(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

/** The contract-sample tree: three event schemas, four sample contracts and an empty contract for every other package. */
async function buildContractTree(root: string): Promise<void> {
  for (const schema of [ARCHIVED, CHANGED]) {
    await copy(path.join(SAMPLES, 'events', `${schema}.json`), path.join(root, 'services/people/contracts/events', `${schema}.json`));
  }
  await copy(path.join(SAMPLES, 'events', `${STUB_NOTE}.json`), path.join(root, 'services/stub/contracts/events', `${STUB_NOTE}.json`));
  for (const name of SAMPLE_OPENAPI) {
    await copy(path.join(SAMPLES, 'openapi', `${name}.yaml`), path.join(root, 'services', name, 'contracts/openapi.yaml'));
  }
  for (const contract of SKELETON_CONTRACTS) {
    await put(path.join(root, contract), `openapi: 3.1.0\ninfo:\n  title: ${contract.split('/').at(-3)}\n  version: 1.0.0\npaths: {}\n`);
  }
}

interface StateSetup {
  results?: string;
  resultsAt?: 'test-all' | 'fallback';
  /** Further packages' vitest JSON, by package folder. */
  otherResults?: Readonly<Record<string, string>>;
  fixtures?: string;
  records?: readonly RecordEntry[];
}

/** Environment naming a state directory. */
type StateEnv = EnvLike & { OPT2_STATE_DIR: string };

/** A fresh state directory holding the people package's vitest JSON, the fixture status and the e2e records. */
async function seedState(setup: StateSetup): Promise<StateEnv> {
  const state = await tempDir('state');
  const env: StateEnv = { OPT2_STATE_DIR: state };
  if (setup.results !== undefined) {
    const file = setup.resultsAt === 'fallback' ? path.join(state, 'results', 'services-people.json') : vitestResultPath(PEOPLE, env);
    await put(file, setup.results);
  }
  for (const [pkg, text] of Object.entries(setup.otherResults ?? {})) await put(vitestResultPath(pkg, env), text);
  if (setup.fixtures !== undefined) await put(path.join(state, 'fixtures.json'), setup.fixtures);
  for (const [key, record] of setup.records ?? []) {
    await expect(recordEventResult<string>(key, record, env)).resolves.toBe(e2eResultPath(key, env));
  }
  return env;
}

/** The sample results without their failed assertions. */
function withoutFailures(text: string): string {
  const json = JSON.parse(text) as VitestJson;
  const testResults = json.testResults.map((file) => ({
    ...file,
    assertionResults: file.assertionResults.filter((assertion) => assertion.status !== 'failed'),
  }));
  return JSON.stringify({ ...json, testResults });
}

/** Tree rows with each unreadable schema stood in by a `state` declaration. */
function evidencedTopics(rows: readonly TopicRow[]): TopicRow[] {
  return rows.map(({ error, ...row }) => (error === undefined ? row : { ...row, kind: 'state' }));
}

/** Size and mtime of every file under `dir`, keyed by relative path. */
function treeStamp(dir: string): Record<string, string> {
  const stamp: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const { size, mtimeMs } = statSync(file);
    stamp[path.relative(dir, file)] = `${size}:${mtimeMs}`;
  }
  return stamp;
}

/** The package assertion of the sample tagged with `id`. */
function packageSource(id: (typeof EVENT_CHECK_IDS)[number], title: string, status: string): CheckResult['sources'][number] {
  return { origin: 'package', package: PEOPLE, file: PEOPLE_EVENTS_FILE, test: `${CHECK_TAG(id)} ${title}`, status };
}

const e2eSource = (status: string): CheckResult['sources'][number] => ({ origin: 'e2e', file: SOURCE, status });

let root: string;
let treeTopics: TopicRow[];
let completeTopics: TopicRow[];

beforeAll(async () => {
  root = await tempDir('tree');
  await buildContractTree(root);
  treeTopics = await topicsFromContracts(root);
  completeTopics = evidencedTopics(treeTopics);
});

afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('report constants', () => {
  it('lists the eight delivery checks in report order', () => {
    expect(EVENT_CHECK_IDS).toEqual([
      'duplicateDelivery',
      'outOfOrderState',
      'outOfOrderProcess',
      'droppedDeliveryRecovered',
      'unpublishedRowSwept',
      'sweepChainRecreated',
      'fanoutRedelivery',
      'dlqReplayOnce',
    ]);
  });

  it('lists the ten contract topics in report order', () => {
    expect(EVENT_TOPICS).toEqual([
      'programs-sites.site.changed.v1',
      'identity.group.changed.v1',
      'identity.permission.changed.v1',
      'identity.membership.changed.v1',
      'identity.login-mail.requested.v1',
      'people.person.changed.v1',
      'people.person.archived.v1',
      'surveys.survey.scheduled.v1',
      'communications.message.delivery-status-changed.v1',
      'stub.note.created.v1',
    ]);
  });

  it.each(EVENT_CHECK_IDS)('tags %s assertions as [events:<id>]', (id) => {
    expect(CHECK_TAG(id)).toBe(`[events:${id}]`);
  });

  it('keys e2e records by check, seam and outbox replay', () => {
    expect(E2E_KEYS).toEqual([...EVENT_CHECK_IDS, 'seams.archiveToBlackout', 'seams.surveyToCloudTasks', 'outboxReplay']);
    expect(SEAM_TOPICS).toEqual({ archiveToBlackout: ARCHIVED, surveyToCloudTasks: 'surveys.survey.scheduled.v1' });
  });

  it.each<[string, string, SeamResult]>([
    ['a passed seam', 'pass', { passed: true, evidence: {} }],
    ['a failed seam', 'fail', { passed: false, evidence: {} }],
    ['a skipped seam', FIXTURES_UNAVAILABLE, { passed: false, skipped: FIXTURES_UNAVAILABLE, evidence: { reason: UNAVAILABLE_REASON } }],
  ])('records %s as %s', (_title, expected, seam) => {
    expect(seamRecordResult(seam)).toBe(expected);
  });
});

describe('topicsFromContracts', () => {
  it('returns one row per contract topic in report order', () => {
    expect(treeTopics.map((row) => row.topic)).toEqual([...EVENT_TOPICS]);
  });

  it.each<[string, TopicRow]>([
    [
      ARCHIVED,
      {
        topic: ARCHIVED,
        producer: 'people',
        consumers: ['timesheets'],
        kind: 'process',
        fanout: 'userPool',
        schema: `services/people/contracts/events/${ARCHIVED}.json`,
      },
    ],
    [
      CHANGED,
      {
        topic: CHANGED,
        producer: 'people',
        consumers: ['identity'],
        kind: 'state',
        fanout: null,
        schema: `services/people/contracts/events/${CHANGED}.json`,
      },
    ],
    [
      STUB_NOTE,
      {
        topic: STUB_NOTE,
        producer: 'stub',
        consumers: ['stub'],
        kind: 'state',
        fanout: null,
        schema: `services/stub/contracts/events/${STUB_NOTE}.json`,
      },
    ],
  ])('reads producer, consumers, kind and fan-out of %s from the tree', (topic, expected) => {
    expect(treeTopics.find((row) => row.topic === topic)).toStrictEqual(expected);
  });

  it('reports a topic without a schema as not found, with no kind and no checkout path', () => {
    const missing = treeTopics.filter((row) => !TREE_TOPICS.includes(row.topic));
    expect(missing).toHaveLength(7);
    for (const row of missing) {
      expect(row).toMatchObject({ kind: null, fanout: null, consumers: [], error: `${row.schema}: event schema not found` });
      expect(row.error).not.toContain(root);
    }
  });

  it('names a malformed schema and marks the readable rows with the topology error', async () => {
    const broken = await tempDir('broken-tree');
    await buildContractTree(broken);
    const survey = 'services/surveys/contracts/events/surveys.survey.scheduled.v1.json';
    await put(path.join(broken, survey), JSON.stringify({ $id: 'surveys.survey.scheduled.v1', 'x-opt2-kind': 'bogus' }));

    const rows = await topicsFromContracts(broken);

    const surveyRow = rows.find((row) => row.topic === 'surveys.survey.scheduled.v1');
    expect(surveyRow?.kind).toBeNull();
    expect(surveyRow?.error).toMatch(new RegExp(`^${survey}: .*x-opt2-kind must be one of`));
    const changedRow = rows.find((row) => row.topic === CHANGED);
    expect(changedRow).toMatchObject({ kind: 'state', consumers: [] });
    expect(changedRow?.error).toMatch(/^local topology: /);
  });

  it('rethrows a filesystem error that is not a topology error', async () => {
    const unreadable = await tempDir('file-tree');
    await put(path.join(unreadable, 'services'), 'not a folder\n');
    await expect(topicsFromContracts(unreadable)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('e2e result records', () => {
  it('writes each record to its key file and reads it back unchanged', async () => {
    const env = await seedState({ records: MERGE_RECORDS });
    for (const [key] of MERGE_RECORDS) {
      expect(statSync(e2eResultPath(key, env)).isFile()).toBe(true);
    }
    expect(await readEventResults(env)).toEqual(Object.fromEntries(MERGE_RECORDS));
  });

  it('places records under the state directory events/e2e folder', () => {
    const env: EnvLike = { OPT2_STATE_DIR: path.join(os.tmpdir(), 'opt2-events-report-path') };
    expect(e2eResultPath('dlqReplayOnce', env)).toBe(path.join(os.tmpdir(), 'opt2-events-report-path', 'events', 'e2e', 'dlqReplayOnce.json'));
  });

  it('rejects a key outside the e2e keys', async () => {
    const env = await seedState({});
    await expect(recordEventResult('inconclusiveCheck', passed({}), env)).rejects.toThrow(/unknown events result key "inconclusiveCheck"/);
  });

  it('rejects a stored result other than pass, fail or skipped', async () => {
    const env = await seedState({});
    await put(e2eResultPath('sweepChainRecreated', env), JSON.stringify({ result: 'inconclusive', evidence: {}, source: SOURCE }));
    await expect(readEventResults(env)).rejects.toThrow(/sweepChainRecreated\.json: does not match its schema/);
  });

  it('rejects an outbox replay record without before, after and unchanged', async () => {
    const env = await seedState({});
    await recordEventResult<string>('outboxReplay', passed({ unchanged: true }), env);
    await expect(readEventResults(env)).rejects.toThrow(/outboxReplay\.json: evidence is not an outbox replay result/);
  });
});

describe('merging package results with e2e records', () => {
  let env: EnvLike;
  let inputs: EventsReportInputs;
  let report: EventsReport;

  beforeAll(async () => {
    env = await seedState({ results: SAMPLE_RESULTS, fixtures: FIXTURES_AVAILABLE_STATUS, records: MERGE_RECORDS });
    inputs = await readEventsReportInputs({ env, repoRoot: root, clock: CLOCK });
    report = buildEventsReport({ ...inputs, topics: completeTopics });
  });

  it('reads the people results from the test-all vitest file and no other package', () => {
    expect(packageResultPath(PEOPLE, env)).toBe(vitestResultPath(PEOPLE, env));
    expect(inputs.packages.map((entry) => entry.package)).toEqual([...EVENT_PACKAGES]);
    expect(inputs.packages.filter((entry) => entry.file !== null).map((entry) => entry.package)).toEqual([PEOPLE]);
  });

  it('loads the pin, clock, fixture status, e2e records and tree topics', async () => {
    expect(inputs.sourceSha).toBe(PIN_SHA);
    expect(inputs.generatedAt).toBe('2026-06-30T00:00:00.000Z');
    expect(inputs.fixtures).toMatchObject({ available: true, reason: null });
    expect(inputs.results).toEqual(Object.fromEntries(MERGE_RECORDS));
    expect(inputs.topics).toEqual(await topicsFromContracts(root));
  });

  it.each<[string, (typeof EVENT_CHECK_IDS)[number], string]>([
    ['duplicateDelivery', 'duplicateDelivery', 'duplicate delivery causes one effect'],
    ['fanoutRedelivery', 'fanoutRedelivery', 'interrupted fan-out redelivered applies once per destination'],
  ])('passes %s on its tagged package assertion', (_title, id, title) => {
    expect(report.checks[id]).toStrictEqual({ result: 'pass', sources: [packageSource(id, title, 'passed')] });
  });

  it('fails outOfOrderProcess and names the failing package test', () => {
    expect(report.checks.outOfOrderProcess).toStrictEqual({
      result: 'fail',
      sources: [packageSource('outOfOrderProcess', 'no process effect is lost out of order', 'failed')],
    });
  });

  it('passes dlqReplayOnce on its e2e record', () => {
    expect(report.checks.dlqReplayOnce).toStrictEqual({ result: 'pass', sources: [e2eSource('pass')] });
  });

  it('counts package and e2e sources together for unpublishedRowSwept', () => {
    expect(report.checks.unpublishedRowSwept).toStrictEqual({
      result: 'pass',
      sources: [
        packageSource('unpublishedRowSwept', 'a committed unpublished outbox row is published by the next sweep', 'passed'),
        e2eSource('pass'),
      ],
    });
  });

  it.each(['outOfOrderState', 'droppedDeliveryRecovered'] as const)('reports %s without any source as not-run', (id) => {
    expect(report.checks[id]).toStrictEqual({ result: 'not-run', sources: [], reason: NOT_RUN_REASON });
  });

  it('reports a check whose only record neither passed nor failed as not-run', () => {
    expect(report.checks.sweepChainRecreated).toStrictEqual({
      result: 'not-run',
      sources: [e2eSource(FIXTURES_UNAVAILABLE)],
      reason: `no tagged source passed or failed; statuses: ${FIXTURES_UNAVAILABLE}`,
    });
  });

  it('carries the recorded outbox replay snapshots with unchanged true', () => {
    expect(report.outboxReplay).toStrictEqual({
      command: OUTBOX_REPLAY_COMMAND,
      before: { inboxCounts: SNAPSHOT.inboxCounts, aggregateChecksums: SNAPSHOT.aggregateChecksums },
      after: { inboxCounts: SNAPSHOT.inboxCounts, aggregateChecksums: SNAPSHOT.aggregateChecksums },
      unchanged: true,
    });
  });

  it('passes both seams on their e2e records', () => {
    expect(report.seams).toStrictEqual({
      archiveToBlackout: { topic: ARCHIVED, result: 'pass', evidence: { blackouts: 2 }, source: SOURCE },
      surveyToCloudTasks: { topic: 'surveys.survey.scheduled.v1', result: 'pass', evidence: { tasks: 3 }, source: SOURCE },
    });
  });

  it('fails the report on the one failed check and leaves the unevidenced checks unmet', () => {
    expect(report.result).toBe('fail');
    expect(eventsOutcome(report)).toEqual({
      result: 'fail',
      failed: ['checks.outOfOrderProcess'],
      unmet: ['checks.outOfOrderState', 'checks.droppedDeliveryRecovered', 'checks.sweepChainRecreated'],
    });
  });

  it('stamps the report with the pin, generator and clock', () => {
    expect(report).toMatchObject({ sourceSha: PIN_SHA, generatedBy: GENERATED_BY, generatedAt: '2026-06-30T00:00:00.000Z', status: 'generated' });
  });

  it('keeps the outbox replay fields null and the seams not-run when nothing was recorded', () => {
    const empty = buildEventsReport({ ...inputs, results: {} });
    expect(empty.outboxReplay).toStrictEqual({
      command: OUTBOX_REPLAY_COMMAND,
      before: { inboxCounts: null, aggregateChecksums: null },
      after: { inboxCounts: null, aggregateChecksums: null },
      unchanged: null,
    });
    for (const id of SEAM_IDS) expect(empty.seams[id]).toStrictEqual({ topic: SEAM_TOPICS[id], result: 'not-run' });
  });
});

describe('package result fallback', () => {
  it('reads results/<package-slug>.json when test-all wrote no vitest file', async () => {
    const env = await seedState({ results: SAMPLE_RESULTS, resultsAt: 'fallback', fixtures: FIXTURES_AVAILABLE_STATUS });
    const fallback = path.join(env.OPT2_STATE_DIR, 'results', 'services-people.json');

    expect(packageResultPath(PEOPLE, env)).toBe(fallback);
    expect(packageResultPath('services/identity', env)).toBeNull();
    const packages = await readPackageResults(env, [PEOPLE, 'services/identity']);
    expect(packages.map(({ package: pkg, file }) => [pkg, file])).toEqual([
      [PEOPLE, fallback],
      ['services/identity', null],
    ]);
    expect(packages[1]?.results).toBeNull();

    const inputs = await readEventsReportInputs({ env, repoRoot: root });
    expect(new Date(inputs.generatedAt).toISOString()).toBe(inputs.generatedAt);
    const report = buildEventsReport({ ...inputs, topics: completeTopics });
    expect(report.checks.duplicateDelivery.result).toBe('pass');
    expect(report.checks.outOfOrderProcess.result).toBe('fail');
  });
});

describe('check sources', () => {
  it('orders sources by package, file and test and ignores tagged tests outside test/events', async () => {
    const identity: VitestJson = {
      testResults: [
        {
          name: '/w/services/identity/test/events/b.test.ts',
          assertionResults: [
            { fullName: '[events:duplicateDelivery] b second', status: 'passed' },
            { fullName: '[events:duplicateDelivery] a first', status: 'passed' },
          ],
        },
        {
          name: 'C:\\w\\services\\identity\\test\\events\\a.test.ts',
          assertionResults: [{ fullName: '[events:duplicateDelivery] windows path', status: 'passed' }],
        },
        {
          name: '/w/services/identity/test/unit/c.test.ts',
          assertionResults: [{ fullName: '[events:duplicateDelivery] outside the events folder', status: 'failed' }],
        },
      ],
    };
    const env = await seedState({ results: SAMPLE_RESULTS, otherResults: { 'services/identity': JSON.stringify(identity) } });
    const report = buildEventsReport(await readEventsReportInputs({ env, repoRoot: root, clock: CLOCK }));

    const identitySource = (file: string, test: string): CheckResult['sources'][number] => ({
      origin: 'package',
      package: 'services/identity',
      file: `services/identity/test/events/${file}`,
      test,
      status: 'passed',
    });
    expect(report.checks.duplicateDelivery).toStrictEqual({
      result: 'pass',
      sources: [
        identitySource('a.test.ts', '[events:duplicateDelivery] windows path'),
        identitySource('b.test.ts', '[events:duplicateDelivery] a first'),
        identitySource('b.test.ts', '[events:duplicateDelivery] b second'),
        packageSource('duplicateDelivery', 'duplicate delivery causes one effect', 'passed'),
      ],
    });
  });
});

describe('a fully evidenced report', () => {
  let report: EventsReport;

  beforeAll(async () => {
    const cleaned = withoutFailures(SAMPLE_RESULTS);
    const before = (JSON.parse(SAMPLE_RESULTS) as VitestJson).testResults.flatMap((file) => file.assertionResults);
    const after = (JSON.parse(cleaned) as VitestJson).testResults.flatMap((file) => file.assertionResults);
    expect(before.length - after.length).toBe(1);
    const env = await seedState({ results: cleaned, fixtures: FIXTURES_AVAILABLE_STATUS, records: COMPLETE_RECORDS });
    report = buildEventsReport({ ...(await readEventsReportInputs({ env, repoRoot: root, clock: CLOCK })), topics: completeTopics });
  });

  it('passes once no assertion fails and every check, seam, replay and topic is evidenced', () => {
    for (const id of EVENT_CHECK_IDS) expect(report.checks[id].result, id).toBe('pass');
    expect(report.result).toBe('pass');
    expect(eventsOutcome(report)).toEqual({ result: 'pass', failed: [], unmet: [] });
  });

  it.each<[string, (draft: EventsReport) => void, 'fail' | 'unmet', string]>([
    ['a changed outbox replay', (draft) => void (draft.outboxReplay.unchanged = false), 'fail', 'outboxReplay'],
    ['no recorded outbox replay', (draft) => void (draft.outboxReplay.unchanged = null), 'unmet', 'outboxReplay'],
    ['a failed seam', (draft) => void (draft.seams.archiveToBlackout.result = 'fail'), 'fail', 'seams.archiveToBlackout'],
    ['a skipped seam', (draft) => void (draft.seams.surveyToCloudTasks.result = FIXTURES_UNAVAILABLE), 'unmet', 'seams.surveyToCloudTasks'],
    ['a not-run check', (draft) => void (draft.checks.dlqReplayOnce.result = 'not-run'), 'unmet', 'checks.dlqReplayOnce'],
    ['an unreadable topic', (draft) => void (draft.topics[0]!.error = 'local topology: unreadable'), 'fail', `topics.${EVENT_TOPICS[0]}`],
    ['a topic without a declared kind', (draft) => void (draft.topics[9]!.kind = null), 'unmet', `topics.${EVENT_TOPICS[9]}`],
  ])('with %s the outcome is %s', (_title, change, result, id) => {
    const draft = structuredClone(report);
    change(draft);
    expect(eventsOutcome(draft)).toEqual(
      result === 'fail' ? { result, failed: [id], unmet: [] } : { result, failed: [], unmet: [id] },
    );
  });
});

describe('fixtures unavailable', () => {
  it('marks both seams skipped even when e2e seam results exist', async () => {
    const env = await seedState({ results: SAMPLE_RESULTS, fixtures: FIXTURES_UNAVAILABLE_STATUS, records: MERGE_RECORDS });
    const report = buildEventsReport(await readEventsReportInputs({ env, repoRoot: root, clock: CLOCK }));

    expect(report.seams).toStrictEqual({
      archiveToBlackout: { topic: ARCHIVED, result: FIXTURES_UNAVAILABLE, reason: UNAVAILABLE_REASON },
      surveyToCloudTasks: { topic: 'surveys.survey.scheduled.v1', result: FIXTURES_UNAVAILABLE, reason: UNAVAILABLE_REASON },
    });
    expect(eventsOutcome(report).unmet).toEqual(expect.arrayContaining(['seams.archiveToBlackout', 'seams.surveyToCloudTasks']));
  });

  it('treats a state directory without fixtures.json as unavailable', async () => {
    const env = await seedState({ records: MERGE_RECORDS });
    const report = buildEventsReport(await readEventsReportInputs({ env, repoRoot: root, clock: CLOCK }));
    for (const id of SEAM_IDS) {
      expect(report.seams[id]).toStrictEqual({ topic: SEAM_TOPICS[id], result: FIXTURES_UNAVAILABLE, reason: 'fixtures.json not found' });
    }
  });
});

describe('report shape and entry point', () => {
  let env: StateEnv;

  beforeAll(async () => {
    env = await seedState({ results: SAMPLE_RESULTS, fixtures: FIXTURES_AVAILABLE_STATUS, records: MERGE_RECORDS });
  });

  it('keeps the top-level, check and seam keys of the committed report', async () => {
    const committed = JSON.parse(readFileSync(COMMITTED_REPORT, 'utf8')) as Record<string, unknown> & { checks: object };
    const report = buildEventsReport(await readEventsReportInputs({ env, repoRoot: root, clock: CLOCK }));

    expect(Object.keys(report).sort()).toEqual(Object.keys(committed).sort());
    expect(Object.keys(report.checks).sort()).toEqual(Object.keys(committed.checks).sort());
    expect(Object.keys(report.seams)).toEqual(['archiveToBlackout', 'surveyToCloudTasks']);
    expect(report.topics).toHaveLength(10);
  });

  it('writes events.json to OPT2_REPORTS_DIR with the pinned SHA and leaves the checkout reports untouched', async () => {
    const reports = await tempDir('reports');
    const checkoutReports = path.dirname(COMMITTED_REPORT);
    const stampBefore = treeStamp(checkoutReports);
    const committedBefore = readFileSync(COMMITTED_REPORT, 'utf8');

    const outcome = await main([], { env: { ...env, OPT2_REPORTS_DIR: reports }, repoRoot: root, clock: CLOCK });

    const written = JSON.parse(await readFile(path.join(reports, 'events.json'), 'utf8')) as EventsReport;
    expect(written.sourceSha).toBe(PIN_SHA);
    expect(written).toEqual(buildEventsReport(await readEventsReportInputs({ env, repoRoot: root, clock: CLOCK })));
    expect(outcome).toEqual({ code: 1, summary: eventsOutcome(written) });
    expect(outcome.summary).toMatchObject({ result: 'fail', failed: expect.arrayContaining(['checks.outOfOrderProcess']) });
    expect(treeStamp(checkoutReports)).toEqual(stampBefore);
    expect(readFileSync(COMMITTED_REPORT, 'utf8')).toBe(committedBefore);
  });

  it('writes to the --out file instead of the reports directory', async () => {
    const out = path.join(await tempDir('out'), 'nested', 'events-copy.json');
    const outcome = await main(['--out', out], { env, repoRoot: root, clock: CLOCK });

    const written = JSON.parse(await readFile(out, 'utf8')) as EventsReport;
    expect(written).toMatchObject({ sourceSha: PIN_SHA, generatedBy: GENERATED_BY, status: 'generated' });
    expect(outcome.code).toBe(1);
  });

  it('rejects an empty --out as a usage error', async () => {
    await expect(main(['--out', ''], { env, repoRoot: root })).rejects.toMatchObject({
      name: 'UsageError',
      message: '--out needs a file',
    });
  });
});
