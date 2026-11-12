// Platform proof on services/stub through the gateway under cut-over table v0001; writes opt2/reports/platform-proof.json.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { MIGRATION_PATH_PREFIX, type PositionResponse, type PublishedEvent } from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import {
  SpanKind,
  checkTraceContinuity,
  spansFromOtlpJsonLines,
  type ContinuityResult,
  type ContinuitySpan,
  type SpanSelector,
} from '@opt2/platform/tracing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  STUB_EFFECT_UNIT,
  STUB_NOTE_TOPIC,
  defaultReplayExec,
  parseReplaySummary,
  runDlqCheck,
  stubDlqTarget,
  type ReplayRun,
} from '../../src/events/dlq.js';
import { pollUntil, readOwnerExport, type PollBounds, type SeamDeps } from '../../src/events/seams.js';
import {
  mintTraceparent,
  readCapturedLogLines,
  readTraceLines,
  traceExportOffset,
  validateLogLines,
  type MintedTraceparent,
} from '../../src/events/traces.js';
import { runCatalogChecks, type CatalogRunResult } from '../../src/isolation/catalog.js';
import { createHttpSession, type HttpResult, type HttpSession } from '../../src/lib/http.js';
import { reportsDir, type EnvLike } from '../../src/lib/paths.js';
import { createCatalogClient } from '../../src/lib/pg.js';
import { writeJsonReport } from '../../src/lib/report.js';
import type { UpProcessEntry } from '../../src/repro/up-state.js';
import { gatewaySession, legacySession, sessionForSubject, type SubjectSession } from '../helpers/admin-login.js';
import {
  legacyUrl,
  migrationInvoker,
  readStack,
  requireTableVersion,
  serviceUrl,
  stopService,
  waitHealthy,
  withRestoredServices,
} from '../helpers/stack.js';

const CHECK_IDS = [
  'dispatch',
  'unmoved-to-legacy',
  'fail-closed-write',
  'outbox-pubsub-idempotent-consumer',
  'dlq-replay',
  'rls-isolation',
  'log-schema',
  'trace',
] as const;

type CheckId = (typeof CHECK_IDS)[number];

// `topic` is part of the committed report's target, which test-all.json and the executive deck read.
const TARGET = Object.freeze({
  service: 'services/stub',
  port: 8199,
  tableVersion: 'v0001',
  routes: '/opt2/stub/**',
  topic: STUB_NOTE_TOPIC,
});

const SUBSCRIPTION = 'stub.stub.note.created.v1';
const CONSUME_SPAN = `events.consume ${SUBSCRIPTION}`;
const CONSUMED_PREFIX = `event consumed on ${SUBSCRIPTION}: `;
const GENERATED_BY = 'harness/e2e/isolation/platform-proof.e2e.test.ts';
const NOTES_PATH = '/opt2/stub/notes';
const STATIC_PATH = '/admin/assets/js/admin.min.js';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
/** `PositiveDigits` of the stub contract. */
const POSITIVE_DIGITS = /^[1-9][0-9]*$/;
/** Canonical text of a non-negative `i` value in a migration export row. */
const CANONICAL_UNSIGNED = /^(0|[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Statuses of a denial: no qualifying identity (401) or no qualifying role or site (403). */
const DENIALS: readonly number[] = [401, 403];
const LIST_PAGE_SIZE = '1000';

/** The collector's file exporter flushes asynchronously. */
const TRACE_POLL: Required<PollBounds> = { timeoutMs: 30_000, intervalMs: 1_000 };
/** Push delivery and its consume span, or the projection a delivery writes. */
const DELIVERY_POLL: Required<PollBounds> = { timeoutMs: 60_000, intervalMs: 1_000 };

const GATEWAY_SERVER: SpanSelector = { service: 'gateway', kind: SpanKind.SERVER };
const STUB_SERVER: SpanSelector = { service: 'stub', kind: SpanKind.SERVER };
const OUTBOX_PUBLISH: SpanSelector = { name: 'outbox.publish', service: 'stub', kind: SpanKind.PRODUCER };
const STUB_CONSUME: SpanSelector = { name: CONSUME_SPAN, service: 'stub', kind: SpanKind.CONSUMER };
/** Root first: every later span must descend from the gateway SERVER span of the note create. */
const TRACE_CHAIN: SpanSelector[] = [GATEWAY_SERVER, STUB_SERVER, OUTBOX_PUBLISH, STUB_CONSUME];

type Evidence = Record<string, unknown>;
type Invoker = NonNullable<SeamDeps['invoker']>;
type CatalogFinding = CatalogRunResult['findings'][number];

/** One check as the report records it. */
interface CheckRecord {
  id: CheckId;
  title: string;
  result: 'pass' | 'fail';
  evidence: Evidence;
}

/** The legacy JSON API envelope, success or error. */
interface Envelope {
  apiversion?: unknown;
  method?: unknown;
  params?: unknown;
  data?: unknown;
  error?: unknown;
}

/** `Note` of the stub contract, keys lower-cased by the legacy serializer. */
interface NoteData {
  noteid: string;
  title: string;
  rowversion: string;
}

/** `NoteList` of the stub contract. */
interface NoteListData {
  items: NoteData[];
  next: string | null;
}

/** A tenant-a note one check creates for itself; `createdAt` precedes the create by one second. */
interface CreatedNote {
  noteId: string;
  title: string;
  rowVersion: number;
  createdAt: string;
  trace: MintedTraceparent;
}

/** Projection columns a redelivery must leave unchanged, parsed from the export's canonical text. */
interface ProjectionState {
  apply_count: number;
  aggregate_version: number;
  last_event_id: string;
}

/** One `event consumed on <subscription>` log record of the stub; `outcome` is the delivery's destination result. */
interface ConsumeRecord {
  eventId: string;
  outcome: string;
}

/** What the stub's migration position reports for one event. */
interface StubPosition {
  /** Published note events of every registered tenant. */
  published: PublishedEvent[];
  /** Tenants holding an inbox receipt of the event. */
  receipts: string[];
  /** Inbox receipts of the note subscription over every registered tenant. */
  subscription: number;
}

/** CLIENT spans of one trace by destination; `unresolved` spans name no port or URL. */
interface ClientSpanCounts {
  legacy: number;
  stub: number;
  other: number;
  unresolved: number;
}

interface OtlpAttribute {
  key?: unknown;
  value?: { stringValue?: unknown; intValue?: unknown } | null;
}

interface OtlpSpan {
  traceId?: unknown;
  kind?: unknown;
  attributes?: OtlpAttribute[];
}

interface OtlpScopeSpans {
  spans?: OtlpSpan[];
}

interface OtlpRequest {
  resourceSpans?: { scopeSpans?: OtlpScopeSpans[]; instrumentationLibrarySpans?: OtlpScopeSpans[] }[];
}

// OTLP numbers span kinds one above the API's SpanKind; the JSON exporter may also write the enum name.
const OTLP_CLIENT_KINDS: ReadonlySet<unknown> = new Set([SpanKind.CLIENT + 1, 'SPAN_KIND_CLIENT']);
const PORT_ATTRIBUTES = ['server.port', 'net.peer.port'] as const;
const URL_ATTRIBUTES = ['url.full', 'http.url'] as const;

const checks: CheckRecord[] = [];
let traceOffset = 0;
let tenantA: SubjectSession | undefined;
let tenantB: SubjectSession | undefined;

/**
 * Runs `fn` for the test named `<id>: <title>`; records its evidence as a pass, or its error as a fail and rethrows.
 * The report title is the test name after its id, so the two cannot drift.
 */
async function record(id: CheckId, name: string, fn: () => Promise<Evidence>): Promise<void> {
  const prefix = `${id}: `;
  if (!name.startsWith(prefix)) throw new Error(`test "${name}" does not start with "${prefix}"`);
  const title = name.slice(prefix.length);
  let evidence: Evidence;
  try {
    evidence = await fn();
  } catch (err) {
    checks.push({ id, title, result: 'fail', evidence: { error: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
  checks.push({ id, title, result: 'pass', evidence });
}

function gatewayOf(subject: SubjectSession | undefined): HttpSession {
  if (subject === undefined) throw new Error('beforeAll opened no gateway session');
  return subject.session;
}

/** Creates a tenant-a note for `check` through the gateway in a fresh trace and asserts its save envelope. */
async function createTenantANote(check: CheckId): Promise<CreatedNote> {
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const trace = mintTraceparent();
  const title = `Platform proof note ${check} ${trace.traceId}`;
  const created = await gatewayOf(tenantA).post(NOTES_PATH, {
    query: { siteid: TENANT_A.siteId },
    json: { title, body: `Platform proof evidence of the ${check} check.` },
    headers: { traceparent: trace.traceparent },
  });
  expect(created.status, created.text).toBe(200);
  const body = created.json<Envelope>();
  expect(body).toMatchObject({ apiversion: 'v1', method: 'save', data: { title } });
  const { noteid: noteId, rowversion } = body.data as NoteData;
  expect(noteId).toMatch(CF_UUID);
  expect(rowversion, 'created note rowversion').toMatch(POSITIVE_DIGITS);
  return { noteId, title, rowVersion: Number(rowversion), createdAt, trace };
}

function headerOf(result: HttpResult, name: string): string | undefined {
  const value = result.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Port of `url`, the scheme's default when it names none. */
function portOfUrl(url: string): number {
  const { port, protocol } = new URL(url);
  return Number(port || (protocol === 'https:' ? 443 : 80));
}

/** Spans of trace `traceId` exported since the suite started. */
function spansOf(traceId: string): ContinuitySpan[] {
  const spans: ContinuitySpan[] = [];
  for (const line of readTraceLines(undefined, { fromOffset: traceOffset })) {
    if (line.includes(traceId)) spans.push(...spansFromOtlpJsonLines(line).filter((span) => span.traceId === traceId));
  }
  return spans;
}

function describeSpans(spans: readonly ContinuitySpan[]): string {
  return spans.map((span) => `${span.name}@${span.service ?? '?'}`).join(', ') || 'none';
}

/** Polls {@link spansOf} until `done` holds; throws naming `what` and the spans seen once `bounds` runs out. */
async function awaitSpans(
  traceId: string,
  what: string,
  done: (spans: ContinuitySpan[]) => boolean,
  bounds: Required<PollBounds> = TRACE_POLL,
): Promise<ContinuitySpan[]> {
  const outcome = await pollUntil(async () => spansOf(traceId), done, { poll: bounds });
  if (outcome.timedOut) {
    const seen = describeSpans(outcome.value);
    throw new Error(`${what} not exported in trace ${traceId} within ${bounds.timeoutMs} ms; spans: ${seen}`);
  }
  return outcome.value;
}

/** Polls until `selectors` form one parent-linked chain in trace `traceId`; throws with the last problems otherwise. */
async function awaitContinuity(
  traceId: string,
  selectors: SpanSelector[],
  bounds: Required<PollBounds> = TRACE_POLL,
): Promise<ContinuityResult> {
  const outcome = await pollUntil(
    async () => checkTraceContinuity(spansOf(traceId), { expectedSpanNames: selectors }),
    (result) => result.ok,
    { poll: bounds },
  );
  if (!outcome.value.ok) {
    const problems = outcome.value.problems.join('; ');
    throw new Error(`trace ${traceId} is no connected chain after ${bounds.timeoutMs} ms: ${problems}`);
  }
  return outcome.value;
}

function spanEvidence(span: ContinuitySpan): Evidence {
  const { name, spanId } = span;
  return { name, service: span.service ?? null, spanId, parentSpanId: span.parentSpanId ?? null };
}

function isConsumeSpan(span: ContinuitySpan): boolean {
  return span.name === CONSUME_SPAN && span.service === 'stub' && span.kind === SpanKind.CONSUMER;
}

function attributeText(attributes: readonly OtlpAttribute[], keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attributes.find((attribute) => attribute.key === key)?.value;
    const raw = value?.intValue ?? value?.stringValue;
    if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  }
  return undefined;
}

/** Destination port of a CLIENT span from its port attributes, else its URL; null when it names neither. */
function destinationPort(attributes: readonly OtlpAttribute[]): number | null {
  const port = attributeText(attributes, PORT_ATTRIBUTES);
  if (port !== undefined && /^[0-9]+$/.test(port)) return Number(port);
  const url = attributeText(attributes, URL_ATTRIBUTES);
  return url !== undefined && URL.canParse(url) ? portOfUrl(url) : null;
}

// ContinuitySpan keeps no attributes, so the destinations of CLIENT spans are read from the export lines directly.
/** CLIENT spans of trace `traceId` counted by destination: legacy ColdFusion, the stub, anything else, or unknown. */
function clientSpanCounts(traceId: string): ClientSpanCounts {
  const legacyPort = portOfUrl(legacyUrl());
  const stubPort = portOfUrl(serviceUrl('stub'));
  const counts: ClientSpanCounts = { legacy: 0, stub: 0, other: 0, unresolved: 0 };
  for (const line of readTraceLines(undefined, { fromOffset: traceOffset })) {
    if (!line.includes(traceId)) continue;
    const request = JSON.parse(line) as OtlpRequest | null;
    for (const resourceSpans of request?.resourceSpans ?? []) {
      for (const scope of resourceSpans.scopeSpans ?? resourceSpans.instrumentationLibrarySpans ?? []) {
        for (const span of scope.spans ?? []) {
          if (span.traceId !== traceId || !OTLP_CLIENT_KINDS.has(span.kind)) continue;
          const port = destinationPort(span.attributes ?? []);
          if (port === null) counts.unresolved += 1;
          else if (port === legacyPort) counts.legacy += 1;
          else if (port === stubPort) counts.stub += 1;
          else counts.other += 1;
        }
      }
    }
  }
  return counts;
}

function stubProcess(): UpProcessEntry {
  const entry = readStack().processes.stub;
  if (entry === undefined) throw new Error('up.json records no stub process');
  return entry;
}

/** The stub's recorded environment over the runner's, so its tools use the stub's role, project and emulator. */
function stubEnv(): EnvLike {
  return { ...process.env, ...stubProcess().env };
}

/** Republishes the stub's tenant-a outbox rows created since `since`, with their original event ids. */
function replayStubOutbox(since: string): Promise<ReplayRun> {
  // The opt2-outbox bin reads only its environment, so the dlq runner's working directory does not matter.
  const bin = join(stubProcess().cwd, 'node_modules', '.bin', 'opt2-outbox');
  return defaultReplayExec(bin, ['replay', '--since', since, '--tenant', TENANT_A.tenantId], stubEnv());
}

// The stub owns no legacy table, so opt2/table-ownership.json assigns it no unit and unitFor cannot name this one.
/** Tenant-a `stub.note_projection` rows of `noteId`, through the stub's migration export. */
async function projectionRows(noteId: string, invoker: Invoker): Promise<Record<string, unknown>[]> {
  const { rows } = await readOwnerExport(
    { service: 'stub', unit: STUB_EFFECT_UNIT, tenantId: TENANT_A.tenantId },
    { invoker },
  );
  const wanted = noteId.toUpperCase();
  return rows.filter((row) => typeof row.note_id === 'string' && row.note_id.toUpperCase() === wanted);
}

/** `column` of a `stub.note_projection` export row as a number; throws unless it is canonical integer text. */
function integerColumn(row: Record<string, unknown>, column: 'apply_count' | 'aggregate_version'): number {
  const value = row[column];
  if (typeof value !== 'string' || !CANONICAL_UNSIGNED.test(value)) {
    throw new Error(`stub.note_projection ${column} is not canonical integer text: ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/** Parses the idempotency columns of a `stub.note_projection` export row; throws on a missing or malformed one. */
function projectionState(row: Record<string, unknown> | undefined): ProjectionState {
  if (row === undefined) throw new Error('no stub.note_projection row to read');
  const eventId = row.last_event_id;
  if (typeof eventId !== 'string' || !UUID.test(eventId)) {
    throw new Error(`stub.note_projection last_event_id is not a UUID: ${JSON.stringify(eventId)}`);
  }
  return {
    apply_count: integerColumn(row, 'apply_count'),
    aggregate_version: integerColumn(row, 'aggregate_version'),
    last_event_id: eventId.toLowerCase(),
  };
}

/** The stub's consume log records in trace `traceId`, in log order; event ids lower-cased. */
function consumeRecords(traceId: string): ConsumeRecord[] {
  const records: ConsumeRecord[] = [];
  for (const { line } of readCapturedLogLines({ packages: ['stub'] })) {
    if (!line.includes(traceId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.traceId !== traceId) continue;
    const { message, eventId } = parsed;
    if (typeof message !== 'string' || !message.startsWith(CONSUMED_PREFIX) || typeof eventId !== 'string') continue;
    const summary = message.trimEnd();
    records.push({ eventId: eventId.toLowerCase(), outcome: summary.slice(summary.search(/\S+$/)) });
  }
  return records;
}

function describeConsumes(records: readonly ConsumeRecord[]): string {
  return records.map(({ eventId, outcome }) => `${eventId} ${outcome}`).join(', ') || 'none';
}

function describeTenants(tenantIds: readonly string[]): string {
  return tenantIds.join(', ') || 'none';
}

/** Polls {@link consumeRecords} until trace `traceId` has `count` of them; throws naming those seen otherwise. */
async function awaitConsumeRecords(traceId: string, count: number): Promise<ConsumeRecord[]> {
  const outcome = await pollUntil(async () => consumeRecords(traceId), (records) => records.length >= count, {
    poll: DELIVERY_POLL,
  });
  if (outcome.timedOut) {
    const seen = describeConsumes(outcome.value);
    const bound = DELIVERY_POLL.timeoutMs;
    throw new Error(`${count} consume records not logged in trace ${traceId} within ${bound} ms; seen: ${seen}`);
  }
  return outcome.value;
}

/** The stub's migration position for `eventId` and its note topic; ids and tenants lower-cased, receipts sorted. */
async function stubPosition(invoker: Invoker, eventId: string): Promise<StubPosition> {
  const base = serviceUrl('stub');
  const url = `${base}${MIGRATION_PATH_PREFIX}/position`;
  const headers = await invoker.headersFor({ callee: 'stub', url });
  const query = { eventIds: eventId, publishedTopics: STUB_NOTE_TOPIC };
  const result = await createHttpSession({ baseUrl: base }).get(url, { query, headers });
  if (result.status !== 200) throw new Error(`stub migration position answered ${result.status}: ${result.text}`);
  const { inbox, published } = result.json<PositionResponse>();
  const subscription = inbox?.bySubscription[SUBSCRIPTION];
  const receipts = inbox?.receipts?.[eventId.toLowerCase()];
  if (subscription === undefined || receipts === undefined || published === undefined) {
    const lacking = `the ${SUBSCRIPTION} count, receipts of ${eventId} or published ${STUB_NOTE_TOPIC} events`;
    throw new Error(`stub migration position lacks ${lacking}: ${result.text}`);
  }
  return {
    published: published.map(({ eventId: id, topic, tenantId }) => ({
      eventId: id.toLowerCase(),
      topic,
      tenantId: tenantId.toLowerCase(),
    })),
    receipts: receipts.map((tenantId) => tenantId.toLowerCase()).sort(),
    subscription,
  };
}

/** Every note id `session` lists on `siteid`, page by page. */
async function listNoteIds(session: HttpSession, siteid: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const query: Record<string, string> = { siteid, limit: LIST_PAGE_SIZE, ...(after === null ? {} : { after }) };
    const result = await session.get(NOTES_PATH, { query });
    expect(result.status, result.text).toBe(200);
    const page = result.json<Envelope>().data as NoteListData;
    ids.push(...page.items.map((item) => item.noteid));
    after = page.next;
  } while (after !== null);
  return ids;
}

/** Asserts an error envelope with one of `statuses`, no `data` and no trace of `title`. */
function expectNoNote(result: HttpResult, statuses: readonly number[], title: string): void {
  expect(statuses, `HTTP ${result.status}: ${result.text}`).toContain(result.status);
  const body = result.json<Envelope>();
  expect(body.data).toBeUndefined();
  expect(body.error).toBeDefined();
  expect(result.text.includes(title), 'response body names the tenant-a note title').toBe(false);
}

async function catalogChecks(): Promise<CatalogRunResult> {
  const client = await createCatalogClient();
  try {
    return await runCatalogChecks(client);
  } finally {
    await client.close();
  }
}

function isStubObject(finding: CatalogFinding): boolean {
  return finding.object === 'stub' || finding.object.startsWith('stub.') || finding.object.startsWith('stub_');
}

describe('platform proof on the stub', () => {
  beforeAll(async () => {
    traceOffset = traceExportOffset();
    await requireTableVersion(TARGET.tableVersion);
    tenantA = await sessionForSubject('system-user', { origin: 'gateway', site: TENANT_A.siteId });
    // sessionForSubject applies `site` to member logins only, so a system-user session is always tenant-a's; the
    // other-tenant subject is tenant-b's site admin, a system user privileged in tenant-b alone.
    tenantB = await sessionForSubject('other-tenant', { origin: 'gateway' });
    expect(tenantA.site, 'tenant-a session site').toBe(TENANT_A.siteId);
    expect(tenantB.site, 'tenant-b session site').toBe(TENANT_B.siteId);
  });

  afterAll(async () => {
    const ordered = [...checks].sort((a, b) => CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id));
    const passed = CHECK_IDS.every((id) => {
      const own = checks.filter((check) => check.id === id);
      return own.length === 1 && own[0]?.result === 'pass';
    });
    await writeJsonReport(join(reportsDir(), 'platform-proof.json'), {
      generatedBy: GENERATED_BY,
      status: 'generated',
      target: TARGET,
      checks: ordered,
      result: passed ? 'pass' : 'fail',
    });
  });

  it('dispatch: gateway dispatches /opt2/stub/** to the stub', ({ task }) =>
    record('dispatch', task.name, async () => {
      const trace = mintTraceparent();
      const result = await gatewayOf(tenantA).get(NOTES_PATH, {
        query: { siteid: TENANT_A.siteId },
        headers: { traceparent: trace.traceparent },
      });
      expect(result.status, result.text).toBe(200);
      const body = result.json<Envelope>();
      expect(body).toMatchObject({ apiversion: 'v1', method: 'findMany', data: { items: expect.any(Array) } });
      expect(body.data).toHaveProperty('next');
      const continuity = await awaitContinuity(trace.traceId, [GATEWAY_SERVER, STUB_SERVER]);
      const [gateway, stub] = continuity.matched;
      return {
        route: NOTES_PATH,
        status: result.status,
        envelopeKeys: Object.keys(body).sort(),
        traceId: trace.traceId,
        gatewaySpanId: gateway?.spanId ?? null,
        stubSpanId: stub?.spanId ?? null,
        stubParentSpanId: stub?.parentSpanId ?? null,
      };
    }),
  );

  it('unmoved-to-legacy: unmoved route proxied to legacy unchanged', ({ task }) =>
    record('unmoved-to-legacy', task.name, async () => {
      const viaGateway = await gatewaySession().get(STATIC_PATH);
      const direct = await legacySession().get(STATIC_PATH);
      expect(viaGateway.status, 'status through the gateway').toBe(200);
      expect(direct.status, 'status at legacy').toBe(200);
      const contentType = headerOf(direct, 'content-type');
      expect(contentType, 'legacy content type').toBeDefined();
      expect(headerOf(viaGateway, 'content-type'), 'content type through the gateway').toBe(contentType);
      expect(viaGateway.bytes.length, 'body size').toBeGreaterThan(0);
      const gatewaySha256 = sha256(viaGateway.bytes);
      const legacySha256 = sha256(direct.bytes);
      expect(gatewaySha256, 'body digest through the gateway').toBe(legacySha256);
      const { status, bytes } = viaGateway;
      return { path: STATIC_PATH, status, contentType, bytes: bytes.length, gatewaySha256, legacySha256 };
    }),
  );

  it('fail-closed-write: write fails closed with legacy-shaped 503 when the stub is down', ({ task }) =>
    record('fail-closed-write', task.name, async () => {
      const trace = mintTraceparent();
      const evidence = await withRestoredServices(['stub'], async () => {
        await stopService('stub');
        const result = await gatewayOf(tenantA).post(NOTES_PATH, {
          query: { siteid: TENANT_A.siteId },
          json: { title: 'Fail-closed probe', body: 'Written while the stub is stopped.' },
          headers: { traceparent: trace.traceparent },
        });
        expect(result.status, result.text).toBe(503);
        expect(headerOf(result, 'content-type'), 'content type').toMatch(/^application\/json/i);
        const body = result.json<Envelope>();
        const expected = JSON.parse(
          apiUnavailableResponse({
            method: typeof body.method === 'string' ? body.method : undefined,
            params: isRecord(body.params) ? body.params : undefined,
          }).body,
        ) as Envelope;
        expect({ apiversion: body.apiversion, error: body.error }).toEqual({
          apiversion: expected.apiversion,
          error: expected.error,
        });
        await awaitSpans(trace.traceId, 'the gateway SERVER span', (spans) =>
          spans.some((span) => span.service === 'gateway' && span.kind === SpanKind.SERVER),
        );
        const clientSpans = clientSpanCounts(trace.traceId);
        expect(clientSpans.legacy, 'CLIENT spans towards legacy').toBe(0);
        expect(clientSpans.stub, 'CLIENT spans towards the stub').toBeLessThanOrEqual(1);
        expect(clientSpans.unresolved, 'CLIENT spans naming no destination').toBe(0);
        return {
          status: result.status,
          apiversion: body.apiversion,
          method: body.method ?? null,
          error: body.error,
          traceId: trace.traceId,
          clientSpans,
        };
      });
      await waitHealthy('stub');
      return evidence;
    }),
  );

  it('outbox-pubsub-idempotent-consumer: outbox -> Pub/Sub -> idempotent consumer (stub.note_projection)', ({ task }) =>
    record('outbox-pubsub-idempotent-consumer', task.name, async () => {
      const { noteId, rowVersion, createdAt, trace } = await createTenantANote('outbox-pubsub-idempotent-consumer');

      const invoker = await migrationInvoker();
      const projected = await pollUntil(() => projectionRows(noteId, invoker), (rows) => rows.length === 1, {
        poll: DELIVERY_POLL,
      });
      expect(projected.value, `stub.note_projection rows of ${noteId}`).toHaveLength(1);
      const delivered = await awaitConsumeRecords(trace.traceId, 1);
      const applied = delivered.filter(({ outcome }) => outcome === 'applied');
      const original = applied.length === 1 ? applied[0] : undefined;
      if (original === undefined || delivered.some(({ eventId }) => eventId !== original.eventId)) {
        const logged = describeConsumes(delivered);
        throw new Error(`expected deliveries of one event, one of them applied, before the replay; logged: ${logged}`);
      }
      const { eventId: originalEventId } = original;
      const expected: ProjectionState = {
        apply_count: 1,
        aggregate_version: rowVersion,
        last_event_id: originalEventId,
      };
      const first = projectionState(projected.value[0]);
      expect(first, `projection after the first delivery: ${JSON.stringify(first)}`).toEqual(expected);
      const tenantAId = TENANT_A.tenantId.toLowerCase();
      const positionBefore = await stubPosition(invoker, originalEventId);
      const outboxEntries = positionBefore.published.filter(({ eventId }) => eventId === originalEventId);
      const entriesSeen = JSON.stringify(outboxEntries);
      expect(outboxEntries, `published stub outbox entries of ${originalEventId}: ${entriesSeen}`).toEqual([
        { eventId: originalEventId, topic: STUB_NOTE_TOPIC, tenantId: tenantAId },
      ]);
      const receiptsBefore = positionBefore.receipts;
      const tenantsBefore = describeTenants(receiptsBefore);
      expect(receiptsBefore, `inbox receipt tenants of ${originalEventId}: ${tenantsBefore}`).toEqual([tenantAId]);

      const replay = await replayStubOutbox(createdAt);
      expect(replay.exitCode, replay.stderr).toBe(0);
      const summary = parseReplaySummary(replay.stdout);
      expect(summary?.replayed, `opt2-outbox summary ${replay.stdout.trim()}`).toBeGreaterThanOrEqual(1);

      const deliveries = delivered.length + 1;
      const spans = await awaitSpans(
        trace.traceId,
        `${deliveries} ${CONSUME_SPAN} spans`,
        (seen) => seen.filter(isConsumeSpan).length >= deliveries,
        DELIVERY_POLL,
      );
      const consumes = await awaitConsumeRecords(trace.traceId, deliveries);
      const consumeOutcomes = consumes.map(({ outcome }) => outcome);
      const logged = describeConsumes(consumes);
      expect(consumes.every(({ eventId }) => eventId === originalEventId), `consumed event ids: ${logged}`).toBe(true);
      expect(consumeOutcomes.filter((outcome) => outcome === 'applied'), `consume outcomes: ${logged}`).toHaveLength(1);
      const after = await projectionRows(noteId, invoker);
      expect(after, `stub.note_projection rows of ${noteId} after the redelivery`).toHaveLength(1);
      const redelivered = projectionState(after[0]);
      expect(redelivered, `projection after the redelivery: ${JSON.stringify(redelivered)}`).toEqual(expected);
      const positionAfter = await stubPosition(invoker, originalEventId);
      const receiptsAfter = positionAfter.receipts;
      const tenantsAfter = describeTenants(receiptsAfter);
      const afterWhat = `inbox receipt tenants of ${originalEventId} after the redelivery`;
      expect(receiptsAfter, `${afterWhat}: ${tenantsAfter}`).toEqual([tenantAId]);
      return {
        noteId,
        eventId: originalEventId,
        projection: expected,
        replay: summary,
        inbox: {
          subscriptionBefore: positionBefore.subscription,
          subscriptionAfter: positionAfter.subscription,
          receiptsBefore,
          receiptsAfter,
        },
        consumeSpans: spans.filter(isConsumeSpan).length,
        consumeOutcomes,
        traceId: trace.traceId,
      };
    }),
  );

  it('dlq-replay: dead-lettered message replays once', ({ task }) =>
    record('dlq-replay', task.name, async () => {
      const result = await runDlqCheck({
        target: stubDlqTarget({ tenantId: TENANT_A.tenantId }),
        env: stubEnv(),
        invoker: await migrationInvoker(),
      });
      expect(result.passed, result.evidence.failures.join('; ')).toBe(true);
      return { ...result.evidence };
    }),
  );

  it('rls-isolation: RLS isolates tenant A from B', ({ task }) =>
    record('rls-isolation', task.name, async () => {
      const { noteId, title } = await createTenantANote('rls-isolation');
      const other = gatewayOf(tenantB);
      const notePath = `${NOTES_PATH}/${encodeURIComponent(noteId)}`;

      const read = await other.get(notePath, { query: { siteid: TENANT_B.siteId } });
      expectNoNote(read, [...DENIALS, 404], title);
      const listed = await listNoteIds(other, TENANT_B.siteId);
      expect(listed, 'tenant-b note list').not.toContain(noteId);
      const crossSite = await other.get(notePath, { query: { siteid: TENANT_A.siteId } });
      expectNoNote(crossSite, DENIALS, title);

      const catalog = await catalogChecks();
      const stubFindings = catalog.findings.filter(isStubObject);
      const findingList = stubFindings.map((finding) => `${finding.kind} ${finding.object}`).join(', ');
      expect(stubFindings, `catalog findings on the stub schema and roles: ${findingList}`).toEqual([]);
      const summary = catalog.rlsCatalog.stub;
      expect(summary?.tables, 'stub tenant-owned tables').toBeGreaterThan(0);
      const tables = summary?.tables;
      expect(summary).toEqual({ tables, enabled: tables, forced: tables, usingAndWithCheck: tables });
      return {
        noteId,
        tenantBRead: read.status,
        tenantBListed: listed.length,
        tenantBOnTenantA: crossSite.status,
        rlsCatalog: summary,
        stubFindings: stubFindings.length,
      };
    }),
  );

  it('log-schema: log lines validate against log-record.v1', ({ task }) =>
    record('log-schema', task.name, async () => {
      const summary = validateLogLines(readCapturedLogLines({ packages: ['stub', 'gateway'] }));
      const samples = summary.invalidSamples.slice(0, 3);
      expect(summary.linesChecked, 'stub and gateway log lines').toBeGreaterThan(0);
      const reasons = samples.map((sample) => `${sample.source ?? '?'}: ${sample.errors.join(', ')}`).join(' | ');
      expect(summary.invalid, `invalid log lines (${reasons})`).toBe(0);
      return { ...summary, invalidSamples: samples };
    }),
  );

  it('trace: one traceId across gateway, stub and consumer', ({ task }) =>
    record('trace', task.name, async () => {
      const { noteId, trace } = await createTenantANote('trace');
      const continuity = await awaitContinuity(trace.traceId, TRACE_CHAIN, DELIVERY_POLL);
      expect(continuity.traceId).toBe(trace.traceId);
      expect(continuity.matched).toHaveLength(TRACE_CHAIN.length);
      expect(continuity.matched.slice(1).every((span) => span.parentSpanId !== undefined), 'parent links').toBe(true);
      return { noteId, traceId: continuity.traceId, requiredSpans: continuity.matched.map(spanEvidence) };
    }),
  );
});
