// Platform proof on services/stub through the gateway under cut-over table v0001; writes opt2/reports/platform-proof.json.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { MIGRATION_PATH_PREFIX, type PositionResponse } from '@opt2/platform/migration-kit';
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
const GENERATED_BY = 'harness/e2e/isolation/platform-proof.e2e.test.ts';
const NOTES_PATH = '/opt2/stub/notes';
const STATIC_PATH = '/admin/assets/js/admin.min.js';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
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
}

/** `NoteList` of the stub contract. */
interface NoteListData {
  items: NoteData[];
  next: string | null;
}

/** The tenant-a note the outbox check creates, which the isolation and trace checks reuse. */
interface SharedNote {
  noteId: string;
  title: string;
  createdAt: string;
  trace: MintedTraceparent;
}

/** Projection columns a redelivery must leave unchanged. */
interface ProjectionState {
  apply_count: unknown;
  last_event_id: unknown;
  aggregate_version: unknown;
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
let sharedNote: SharedNote | undefined;

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

function requireNote(): SharedNote {
  if (sharedNote === undefined) {
    throw new Error('no tenant-a note: the outbox-pubsub-idempotent-consumer check did not create one');
  }
  return sharedNote;
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
async function awaitContinuity(traceId: string, selectors: SpanSelector[]): Promise<ContinuityResult> {
  const outcome = await pollUntil(
    async () => checkTraceContinuity(spansOf(traceId), { expectedSpanNames: selectors }),
    (result) => result.ok,
    { poll: TRACE_POLL },
  );
  if (!outcome.value.ok) {
    const problems = outcome.value.problems.join('; ');
    throw new Error(`trace ${traceId} is no connected chain after ${TRACE_POLL.timeoutMs} ms: ${problems}`);
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

function projectionState(row: Record<string, unknown> | undefined): ProjectionState {
  if (row === undefined) throw new Error('no stub.note_projection row to read');
  return { apply_count: row.apply_count, last_event_id: row.last_event_id, aggregate_version: row.aggregate_version };
}

/** Inbox receipts the stub reports for its note subscription, summed over its registered tenants. */
async function stubInboxCount(invoker: Invoker): Promise<number> {
  const base = serviceUrl('stub');
  const url = `${base}${MIGRATION_PATH_PREFIX}/position`;
  const headers = await invoker.headersFor({ callee: 'stub', url });
  const result = await createHttpSession({ baseUrl: base }).get(url, { headers });
  if (result.status !== 200) throw new Error(`stub migration position answered ${result.status}: ${result.text}`);
  const count = result.json<PositionResponse>().inbox?.bySubscription[SUBSCRIPTION];
  if (count === undefined) throw new Error(`stub migration position reports no inbox count for ${SUBSCRIPTION}`);
  return count;
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
    const passed =
      checks.length === CHECK_IDS.length &&
      checks.every((check, index) => check.id === CHECK_IDS[index] && check.result === 'pass');
    await writeJsonReport(join(reportsDir(), 'platform-proof.json'), {
      generatedBy: GENERATED_BY,
      status: 'generated',
      target: TARGET,
      checks,
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
      const createdAt = new Date(Date.now() - 1000).toISOString();
      const trace = mintTraceparent();
      const title = `Platform proof note ${trace.traceId}`;
      const created = await gatewayOf(tenantA).post(NOTES_PATH, {
        query: { siteid: TENANT_A.siteId },
        json: { title, body: 'Outbox, Pub/Sub push and idempotent consumer evidence.' },
        headers: { traceparent: trace.traceparent },
      });
      expect(created.status, created.text).toBe(200);
      const createdBody = created.json<Envelope>();
      expect(createdBody).toMatchObject({ apiversion: 'v1', method: 'save', data: { title } });
      const { noteid: noteId } = createdBody.data as NoteData;
      expect(noteId).toMatch(CF_UUID);
      sharedNote = { noteId, title, createdAt, trace };

      const invoker = await migrationInvoker();
      const projected = await pollUntil(() => projectionRows(noteId, invoker), (rows) => rows.length === 1, {
        poll: DELIVERY_POLL,
      });
      expect(projected.value, `stub.note_projection rows of ${noteId}`).toHaveLength(1);
      const before = projectionState(projected.value[0]);
      const inboxBefore = await stubInboxCount(invoker);

      const replay = await replayStubOutbox(createdAt);
      expect(replay.exitCode, replay.stderr).toBe(0);
      const summary = parseReplaySummary(replay.stdout);
      expect(summary?.replayed, `opt2-outbox summary ${replay.stdout.trim()}`).toBeGreaterThanOrEqual(1);

      const spans = await awaitSpans(
        trace.traceId,
        `a second ${CONSUME_SPAN} span`,
        (seen) => seen.filter(isConsumeSpan).length >= 2,
        DELIVERY_POLL,
      );
      const after = await projectionRows(noteId, invoker);
      expect(after, `stub.note_projection rows of ${noteId} after the redelivery`).toHaveLength(1);
      expect(projectionState(after[0]), 'projection after the redelivery').toEqual(before);
      const inboxAfter = await stubInboxCount(invoker);
      expect(inboxAfter - inboxBefore, `${SUBSCRIPTION} inbox receipts added by the redelivery`).toBe(0);
      return {
        noteId,
        eventId: before.last_event_id,
        projection: before,
        replay: summary,
        inbox: { before: inboxBefore, after: inboxAfter },
        consumeSpans: spans.filter(isConsumeSpan).length,
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
      const { noteId, title } = requireNote();
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
      const { trace } = requireNote();
      const continuity = await awaitContinuity(trace.traceId, TRACE_CHAIN);
      expect(continuity.traceId).toBe(trace.traceId);
      expect(continuity.matched).toHaveLength(TRACE_CHAIN.length);
      expect(continuity.matched.slice(1).every((span) => span.parentSpanId !== undefined), 'parent links').toBe(true);
      return { traceId: continuity.traceId, requiredSpans: continuity.matched.map(spanEvidence) };
    }),
  );
});
