// Events report: merges the tagged test/events assertions of each package, the e2e results and the event contracts into opt2/reports/events.json.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  consumerOfSubscription,
  parseTopic,
  readTopicSchema,
  topicMeta,
  topicOfSubscription,
  topicSchemaRelativePath,
  type EventKind,
} from '@opt2/platform/events';
import { z } from '@opt2/platform/service-kit';

import { FIXTURES_UNAVAILABLE } from '../golden/catalogue.js';
import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { REPO_ROOT, reportsDir, stateDir, type EnvLike } from '../lib/paths.js';
import { readPin, type Pin } from '../lib/pin.js';
import { readJson, stableStringify, writeJsonReport } from '../lib/report.js';
import { packageSlug, vitestResultPath } from '../reporting/speed.js';
import { deriveTopology, TopologyError } from '../repro/pubsub-topology.js';
import type { DlqEvidence } from './dlq.js';
import type { OutboxReplayResult } from './outbox-replay.js';
import type { SeamResult } from './seams.js';

/** The report's `generatedBy`. */
export const GENERATED_BY = 'harness/src/events/report.ts';

/** Event-delivery check ids, in report order. */
export const EVENT_CHECK_IDS = [
  'duplicateDelivery',
  'outOfOrderState',
  'outOfOrderProcess',
  'droppedDeliveryRecovered',
  'unpublishedRowSwept',
  'sweepChainRecreated',
  'fanoutRedelivery',
  'dlqReplayOnce',
] as const;

/** One event-delivery check id. */
export type EventCheckId = (typeof EVENT_CHECK_IDS)[number];

/** Seam ids, in report order. */
export const SEAM_IDS = ['noteToProjection'] as const;

/** One seam id. */
export type SeamId = (typeof SEAM_IDS)[number];

/** Topic whose delivery each seam carries. */
export const SEAM_TOPICS: Readonly<Record<SeamId, string>> = Object.freeze({
  noteToProjection: 'stub.note.created.v1',
});

/** Every topic of the event contracts, in report order. */
export const EVENT_TOPICS = [
  'programs-sites.site.changed.v1',
  'identity.group.changed.v1',
  'identity.permission.changed.v1',
  'identity.membership.changed.v1',
  'identity.login-mail.requested.v1',
  'people.person.changed.v1',
  'people.person.archived.v1',
  'stub.note.created.v1',
  'stub.note.commented.v1',
] as const;

/** Keys of the e2e result store: the checks, the seam and the full outbox replay. */
export const E2E_KEYS = [...EVENT_CHECK_IDS, 'seams.noteToProjection', 'outboxReplay'] as const;

/** One e2e result key. */
export type EventE2EKey = (typeof E2E_KEYS)[number];

/** Packages whose `test/events/` suites may carry tagged check assertions. */
export const EVENT_PACKAGES = [
  'platform',
  'services/stub',
  'services/identity',
  'services/people',
  'services/programs-sites',
  'services/strategies-content',
] as const;

/** Replay command the report names as `outboxReplay.command`. */
export const OUTBOX_REPLAY_COMMAND = 'opt2-outbox replay --since <ts>';

/** Reason of a check that has no source. */
export const NOT_RUN_REASON = 'no tagged test/events assertion or e2e result';

const RECORD_RESULTS = ['pass', 'fail', FIXTURES_UNAVAILABLE] as const;

/** Outcome an e2e suite records. */
export type EventRecordResult = (typeof RECORD_RESULTS)[number];

/** One e2e result record; `source` names the suite that produced it. */
export interface EventResultRecord<E = unknown> {
  result: EventRecordResult;
  evidence: E;
  source: string;
}

/** Evidence of the e2e keys whose producers return a typed result; other keys record any value. */
export interface EventEvidenceMap {
  outboxReplay: OutboxReplayResult;
  dlqReplayOnce: DlqEvidence;
}

/** Evidence recorded under `K`. */
export type EventEvidence<K extends string> = K extends keyof EventEvidenceMap ? EventEvidenceMap[K] : unknown;

/** The outbox-replay fields the report reads back from a record. */
export type OutboxReplayEvidence = Pick<OutboxReplayResult, 'before' | 'after' | 'unchanged'>;

/** Recorded e2e results by key; an absent key was not recorded. */
export type EventResults = Partial<Record<Exclude<EventE2EKey, 'outboxReplay'>, EventResultRecord>> & {
  outboxReplay?: EventResultRecord<OutboxReplayEvidence>;
};

const recordSchema = z.looseObject({
  result: z.enum(RECORD_RESULTS),
  evidence: z.unknown(),
  source: z.string().min(1),
});

const snapshotSchema = z.looseObject({
  inboxCounts: z.record(z.string(), z.number()),
  aggregateChecksums: z.record(z.string(), z.looseObject({ rows: z.number(), checksum: z.string() })),
});

const outboxEvidenceSchema: z.ZodType<OutboxReplayEvidence> = z.looseObject({
  before: snapshotSchema,
  after: snapshotSchema,
  unchanged: z.boolean(),
});

const E2E_KEY_SET: ReadonlySet<string> = new Set(E2E_KEYS);

function isE2EKey(key: string): key is EventE2EKey {
  return E2E_KEY_SET.has(key);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Record result of a seam check's outcome. */
export function seamRecordResult(seam: SeamResult): EventRecordResult {
  return seam.passed ? 'pass' : 'fail';
}

/** File of the e2e record under `key`: `<state>/events/e2e/<key>.json`. */
export function e2eResultPath(key: EventE2EKey, env: EnvLike = process.env): string {
  return path.join(stateDir(env), 'events', 'e2e', `${key}.json`);
}

/** Writes an e2e suite's result under `key` and resolves to the file; throws for a key outside {@link E2E_KEYS}. */
export async function recordEventResult<K extends string>(
  key: K,
  value: EventResultRecord<EventEvidence<K>>,
  env: EnvLike = process.env,
): Promise<string> {
  if (!isE2EKey(key)) {
    throw new Error(`unknown events result key ${JSON.stringify(key)}; expected one of ${E2E_KEYS.join(', ')}`);
  }
  const file = e2eResultPath(key, env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stableStringify(value), 'utf8');
  return file;
}

/** Reads every e2e record present in the state directory; an outbox-replay record must hold its before, after and unchanged fields. */
export async function readEventResults(env: EnvLike = process.env): Promise<EventResults> {
  const results: EventResults = {};
  for (const key of E2E_KEYS) {
    const file = e2eResultPath(key, env);
    if (!existsSync(file)) continue;
    const record = await readJson(file, recordSchema);
    if (key === 'outboxReplay') {
      const evidence = outboxEvidenceSchema.safeParse(record.evidence);
      if (!evidence.success) {
        throw new Error(`${file}: evidence is not an outbox replay result:\n${z.prettifyError(evidence.error)}`);
      }
      results.outboxReplay = { ...record, evidence: evidence.data };
    } else {
      results[key] = record;
    }
  }
  return results;
}

/** vitest JSON of `pkg`: test-all's result file, else `<state>/results/<pkg-slug>.json`, else null when neither exists. */
export function packageResultPath(pkg: string, env: EnvLike = process.env): string | null {
  const primary = vitestResultPath(pkg, env);
  if (existsSync(primary)) return primary;
  const fallback = path.join(stateDir(env), 'results', `${packageSlug(pkg)}.json`);
  return existsSync(fallback) ? fallback : null;
}

/** Fields of the vitest JSON reporter output the report reads; other keys pass through. */
export const vitestJsonSchema = z.looseObject({
  testResults: z.array(
    z.looseObject({
      name: z.string(),
      assertionResults: z.array(
        z.looseObject({
          fullName: z.string(),
          title: z.string().optional(),
          ancestorTitles: z.array(z.string()).optional(),
          status: z.string(),
        }),
      ),
    }),
  ),
});

/** Parsed vitest JSON reporter output. */
export type VitestJson = z.infer<typeof vitestJsonSchema>;

/** One package's vitest JSON and the file it came from; both null when the package has no result file. */
export interface PackageResults {
  package: string;
  file: string | null;
  results: VitestJson | null;
}

/** Reads the vitest JSON of each of `packages`. */
export async function readPackageResults(
  env: EnvLike = process.env,
  packages: readonly string[] = EVENT_PACKAGES,
): Promise<PackageResults[]> {
  const read: PackageResults[] = [];
  for (const pkg of packages) {
    const file = packageResultPath(pkg, env);
    read.push({ package: pkg, file, results: file === null ? null : await readJson(file, vitestJsonSchema) });
  }
  return read;
}

/** Tag an assertion's full name carries to count for check `id`. */
export function CHECK_TAG(id: EventCheckId): string {
  return `[events:${id}]`;
}

/** One assertion or e2e record counted for a check. */
export interface CheckSource {
  origin: 'package' | 'e2e';
  package?: string;
  file?: string;
  test?: string;
  status: string;
}

/** Verdict of one check with the sources it rests on. */
export interface CheckResult {
  result: 'pass' | 'fail' | 'not-run';
  sources: CheckSource[];
  reason?: string;
}

const EVENTS_DIR = '/test/events/';
const PASSED: ReadonlySet<string> = new Set(['passed', 'pass']);
const FAILED: ReadonlySet<string> = new Set(['failed', 'fail']);

/** `<pkg>/test/events/<rest>` of a vitest file name, or null when the file is not under a `test/events/` folder. */
function eventsTestFile(pkg: string, name: string): string | null {
  const normalized = `/${name.replace(/\\/g, '/')}`;
  const at = normalized.lastIndexOf(EVENTS_DIR);
  return at < 0 ? null : `${pkg}${normalized.slice(at)}`;
}

function compareSources(a: CheckSource, b: CheckSource): number {
  return (
    compareCodeUnits(a.package ?? '', b.package ?? '') ||
    compareCodeUnits(a.file ?? '', b.file ?? '') ||
    compareCodeUnits(a.test ?? '', b.test ?? '')
  );
}

function packageSources(packages: readonly PackageResults[], id: EventCheckId): CheckSource[] {
  const tag = CHECK_TAG(id);
  const sources: CheckSource[] = [];
  for (const { package: pkg, results } of packages) {
    for (const testFile of results?.testResults ?? []) {
      const file = eventsTestFile(pkg, testFile.name);
      if (file === null) continue;
      for (const assertion of testFile.assertionResults) {
        if (assertion.fullName.includes(tag)) {
          sources.push({ origin: 'package', package: pkg, file, test: assertion.fullName, status: assertion.status });
        }
      }
    }
  }
  return sources.sort(compareSources);
}

function checkResult(id: EventCheckId, packages: readonly PackageResults[], record: EventResultRecord | undefined): CheckResult {
  const sources = packageSources(packages, id);
  if (record !== undefined) sources.push({ origin: 'e2e', file: record.source, status: record.result });
  if (sources.some((source) => FAILED.has(source.status))) return { result: 'fail', sources };
  if (sources.some((source) => PASSED.has(source.status))) return { result: 'pass', sources };
  const reason =
    sources.length === 0
      ? NOT_RUN_REASON
      : `no tagged source passed or failed; statuses: ${[...new Set(sources.map((source) => source.status))].join(', ')}`;
  return { result: 'not-run', sources, reason };
}

/** One topic of the event contracts; `error` names a schema or topology that cannot be read. */
export interface TopicRow {
  topic: string;
  producer: string;
  consumers: string[];
  kind: EventKind | null;
  fanout: string | null;
  schema: string;
  error?: string;
}

/** One row per {@link EVENT_TOPICS} entry, from the event schemas and the local topology under `repoRoot`. */
export async function topicsFromContracts(repoRoot: string = REPO_ROOT): Promise<TopicRow[]> {
  const consumers = new Map<string, string[]>();
  let topologyError: string | undefined;
  try {
    for (const subscription of Object.keys(deriveTopology('local', repoRoot).subscriptions)) {
      const topic = topicOfSubscription(subscription);
      consumers.set(topic, [...(consumers.get(topic) ?? []), consumerOfSubscription(subscription)]);
    }
  } catch (err) {
    if (!(err instanceof TopologyError)) throw err;
    topologyError = `local topology: ${err.message}`;
  }
  return EVENT_TOPICS.map((topic): TopicRow => {
    const schema = topicSchemaRelativePath(topic);
    const row: TopicRow = {
      topic,
      producer: parseTopic(topic).service,
      consumers: (consumers.get(topic) ?? []).sort(compareCodeUnits),
      kind: null,
      fanout: null,
      schema,
    };
    try {
      const meta = topicMeta(readTopicSchema(path.join(repoRoot, schema)));
      row.kind = meta.kind;
      row.fanout = meta.fanout ?? null;
    } catch (err) {
      // A missing file's message would carry this checkout's absolute path into the committed report.
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      row.error = `${schema}: ${missing ? 'event schema not found' : messageOf(err)}`;
      return row;
    }
    if (topologyError !== undefined) row.error = topologyError;
    return row;
  });
}

/** Outcome of one seam. */
export type SeamOutcome = EventRecordResult | 'not-run';

/** One seam: its topic and the recorded outcome, evidence and source. */
export interface SeamEntry {
  topic: string;
  result: SeamOutcome;
  evidence?: unknown;
  source?: string;
}

function seamEntry(id: SeamId, record: EventResultRecord | undefined): SeamEntry {
  const topic = SEAM_TOPICS[id];
  if (record === undefined) return { topic, result: 'not-run' };
  return { topic, result: record.result, evidence: record.evidence, source: record.source };
}

/** Inbox counts and effect checksums of one side of the replay; null when no replay was recorded. */
export interface ReplaySnapshotSection {
  inboxCounts: Record<string, number> | null;
  aggregateChecksums: OutboxReplayResult['before']['aggregateChecksums'] | null;
}

/** The full outbox replay: consumer state before and after, and whether it stayed unchanged. */
export interface OutboxReplaySection {
  command: string;
  before: ReplaySnapshotSection;
  after: ReplaySnapshotSection;
  unchanged: boolean | null;
}

// `command` and both sides' field set stay present without a recorded replay, as in the committed pending-run
// report, because readers of opt2/reports/events.json key on them.
function outboxSection(record: EventResultRecord<OutboxReplayEvidence> | undefined): OutboxReplaySection {
  if (record === undefined) {
    const none: ReplaySnapshotSection = { inboxCounts: null, aggregateChecksums: null };
    return { command: OUTBOX_REPLAY_COMMAND, before: none, after: { ...none }, unchanged: null };
  }
  const { before, after, unchanged } = record.evidence;
  return {
    command: OUTBOX_REPLAY_COMMAND,
    before: { inboxCounts: before.inboxCounts, aggregateChecksums: before.aggregateChecksums },
    after: { inboxCounts: after.inboxCounts, aggregateChecksums: after.aggregateChecksums },
    unchanged,
  };
}

/** Everything {@link buildEventsReport} reads, already loaded. */
export interface EventsReportInputs {
  sourceSha: string;
  generatedAt: string;
  packages: readonly PackageResults[];
  results: EventResults;
  topics: readonly TopicRow[];
}

/** Overall result of the report. */
export type EventsResult = 'pass' | 'fail' | 'unmet';

/** Body of `opt2/reports/events.json`. */
export interface EventsReport {
  sourceSha: string;
  generatedBy: typeof GENERATED_BY;
  generatedAt: string;
  status: 'generated';
  outboxReplay: OutboxReplaySection;
  checks: Record<EventCheckId, CheckResult>;
  seams: Record<SeamId, SeamEntry>;
  topics: TopicRow[];
  result: EventsResult;
}

/** Result of a report with the ids that failed and the ids left unmet (`checks.<id>`, `seams.<id>`, `outboxReplay`, `topics.<topic>`). */
export interface EventsOutcome {
  result: EventsResult;
  failed: string[];
  unmet: string[];
}

/** Fails on any failed check or seam, a changed replay or an unreadable topic; otherwise unmet while anything did not run. */
export function eventsOutcome(report: Pick<EventsReport, 'outboxReplay' | 'checks' | 'seams' | 'topics'>): EventsOutcome {
  const failed: string[] = [];
  const unmet: string[] = [];
  for (const id of EVENT_CHECK_IDS) {
    const { result } = report.checks[id];
    if (result === 'fail') failed.push(`checks.${id}`);
    else if (result !== 'pass') unmet.push(`checks.${id}`);
  }
  for (const id of SEAM_IDS) {
    const { result } = report.seams[id];
    if (result === 'fail') failed.push(`seams.${id}`);
    else if (result !== 'pass') unmet.push(`seams.${id}`);
  }
  if (report.outboxReplay.unchanged === false) failed.push('outboxReplay');
  else if (report.outboxReplay.unchanged === null) unmet.push('outboxReplay');
  for (const row of report.topics) {
    if (row.error !== undefined) failed.push(`topics.${row.topic}`);
    else if (row.kind === null) unmet.push(`topics.${row.topic}`);
  }
  const result: EventsResult = failed.length > 0 ? 'fail' : unmet.length > 0 ? 'unmet' : 'pass';
  return { result, failed, unmet };
}

/** The report from already-loaded inputs; reads nothing. */
export function buildEventsReport(inputs: EventsReportInputs): EventsReport {
  const { packages, results } = inputs;
  const checks = Object.fromEntries(
    EVENT_CHECK_IDS.map((id) => [id, checkResult(id, packages, results[id])]),
  ) as Record<EventCheckId, CheckResult>;
  const seams: Record<SeamId, SeamEntry> = {
    noteToProjection: seamEntry('noteToProjection', results['seams.noteToProjection']),
  };
  const outboxReplay = outboxSection(results.outboxReplay);
  const topics = inputs.topics.map((row) => ({ ...row, consumers: [...row.consumers] }));
  return {
    sourceSha: inputs.sourceSha,
    generatedBy: GENERATED_BY,
    generatedAt: inputs.generatedAt,
    status: 'generated',
    outboxReplay,
    checks,
    seams,
    topics,
    result: eventsOutcome({ outboxReplay, checks, seams, topics }).result,
  };
}

/** Injectable inputs of {@link readEventsReportInputs} and {@link main}; each defaults to the real process, clock, pin and checkout. */
export interface EventsReportDeps {
  env?: EnvLike;
  clock?: () => Date;
  pin?: () => Pin;
  /** Checkout whose event contracts and API contracts give the topic rows. */
  repoRoot?: string;
}

/** Loads every input of the report: package vitest JSON, e2e records and contracts. */
export async function readEventsReportInputs(deps: EventsReportDeps = {}): Promise<EventsReportInputs> {
  const env = deps.env ?? process.env;
  return {
    sourceSha: (deps.pin ?? readPin)().sha,
    generatedAt: (deps.clock ?? (() => new Date()))().toISOString(),
    packages: await readPackageResults(env),
    results: await readEventResults(env),
    topics: await topicsFromContracts(deps.repoRoot ?? REPO_ROOT),
  };
}

const USAGE = 'usage: tsx src/events/report.ts [--out <file>]';
const HELP = `${USAGE} [--help]

Writes the events report from the [events:<check>]-tagged assertions under test/events/ in each package's vitest
JSON, the e2e results under \${OPT2_STATE_DIR}/events/e2e/ and the event contracts.

Options:
  --out <file>  report file; a relative path resolves against the working directory
                (default: events.json in OPT2_REPORTS_DIR, else opt2/reports)
  --help        print this help and exit 0

Package results are read from \${OPT2_STATE_DIR}/test-all/vitest/<pkg-slug>.json, written by harness/repro/test-all.sh,
else from \${OPT2_STATE_DIR}/results/<pkg-slug>.json.

Output: one JSON summary line on stdout with result, failed and unmet. Exit: 0 result pass or unmet, 1 result fail or
an unreadable input, 2 usage error.

Examples (from harness/):
  npm run report:events`;

/** CLI entry: writes the report and summarises its result; exits 1 only when the result is `fail`. */
export async function main(argv: string[], deps: EventsReportDeps = {}): Promise<CliOutcome> {
  const { values } = parseFlags(argv, { options: { out: { type: 'string' } }, usage: USAGE, help: HELP });
  if (values.out === '') throw new UsageError('--out needs a file', USAGE);
  const out = values.out === undefined ? path.join(reportsDir(deps.env ?? process.env), 'events.json') : path.resolve(values.out);
  const report = buildEventsReport(await readEventsReportInputs(deps));
  await writeJsonReport(out, { ...report }, { generatedBy: GENERATED_BY, pin: deps.pin });
  const { result, failed, unmet } = eventsOutcome(report);
  return { code: result === 'fail' ? 1 : 0, summary: { result, failed, unmet } };
}

if (isMainModule(import.meta.url)) void runCli(main);
