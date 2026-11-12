// Finds the people-archive seam trace in the collector's OTLP-JSON export and validates captured log lines.
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { subscriptionName } from '@opt2/platform/events';
import { validateLogRecord } from '@opt2/platform/logging';
import {
  checkTraceContinuity,
  spansFromOtlpJsonLines,
  SpanKind,
  type ContinuityResult,
  type ContinuitySpan,
  type SpanSelector,
} from '@opt2/platform/tracing';

import { stateDir, type EnvLike } from '../lib/paths.js';
import { PACKAGE_NAMES } from '../repro/ports.js';
import { readUpState, upStatePath } from '../repro/up-state.js';

/** Path of the collector's trace export, `<state>/otel/traces.jsonl`. */
export function tracesPath(env?: EnvLike): string {
  return path.join(stateDir(env), 'otel', 'traces.jsonl');
}

const CHUNK_BYTES = 64 * 1024;
const NEWLINE_BYTE = 0x0a;

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Non-blank lines of `file` from byte `start`, read in fixed chunks; a line `start` cuts is skipped. */
function* fileLines(file: string, start = 0): Generator<string> {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let skipHead = start > 0 && readSync(fd, buffer, 0, 1, start - 1) === 1 && buffer[0] !== NEWLINE_BYTE;
    let position = start;
    let pending = '';
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, position);
      if (read === 0) {
        break;
      }
      position += read;
      const chunk = decoder.write(buffer.subarray(0, read));
      let from = 0;
      for (let newline = chunk.indexOf('\n'); newline >= 0; newline = chunk.indexOf('\n', from)) {
        const line = stripCarriageReturn(pending + chunk.slice(from, newline));
        pending = '';
        from = newline + 1;
        if (skipHead) {
          skipHead = false;
        } else if (line.trim() !== '') {
          yield line;
        }
      }
      pending += chunk.slice(from);
    }
    const last = pending + decoder.end();
    if (!skipHead && last.trim() !== '') {
      yield last;
    }
  } finally {
    closeSync(fd);
  }
}

/** Current byte size of the trace export, 0 when absent; record it before a run and pass it as `fromOffset`. */
export function traceExportOffset(env?: EnvLike): number {
  try {
    return statSync(tracesPath(env)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw err;
  }
}

/** Where reading of the trace export starts. */
export interface ReadTraceLinesOptions {
  /** Byte offset from {@link traceExportOffset}; a line it cuts is skipped. */
  fromOffset?: number;
}

/** Non-blank lines of the trace export, streamed afresh on each iteration; throws naming the path when it does not exist. */
export function readTraceLines(env?: EnvLike, opts: ReadTraceLinesOptions = {}): Iterable<string> {
  const file = tracesPath(env);
  try {
    statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${file} does not exist; the OpenTelemetry Collector has exported no traces`, { cause: err });
    }
    throw err;
  }
  return { [Symbol.iterator]: () => fileLines(file, opts.fromOffset ?? 0) };
}

/** A W3C `traceparent` header value and the trace id it starts. */
export interface MintedTraceparent {
  traceparent: string;
  traceId: string;
}

function nonZeroHex(bytes: number): string {
  let hex: string;
  do {
    hex = randomBytes(bytes).toString('hex');
  } while (/^0+$/.test(hex));
  return hex;
}

/** Fresh sampled `traceparent` (`00-<trace>-<parent>-01`), so a request's trace can be found by id. */
export function mintTraceparent(): MintedTraceparent {
  const traceId = nonZeroHex(16);
  return { traceparent: `00-${traceId}-${nonZeroHex(8)}-01`, traceId };
}

/** Push subscription through which timesheets consumes person archives. */
export const SEAM_SUBSCRIPTION: string = subscriptionName('timesheets', 'people.person.archived.v1');

/** Gateway request path of the people archive route, the default selector of candidate traces. */
export const DEFAULT_ARCHIVE_PATH = /\/legacy-fixtures\/cfml\/api\.cfm\/people\/persons\/[^/]+\/archive/;

/** Identifier of a required seam span. */
export type SeamSpanId = 'gateway-server' | 'people-server' | 'outbox-publish' | 'timesheets-consume';

/** A span the seam trace must hold: its report label, emitting service and continuity selector. */
export interface SeamRequiredSpan {
  readonly id: SeamSpanId;
  readonly name: string;
  readonly service: string;
  readonly selector: SpanSelector;
}

const GATEWAY_SERVER: SpanSelector = { service: 'gateway', kind: SpanKind.SERVER };
const CONSUME_SPAN = `events.consume ${SEAM_SUBSCRIPTION}`;

/** Required seam spans in chain order; the first is the root every later one must descend from. */
export const SEAM_REQUIRED_SPANS: readonly SeamRequiredSpan[] = Object.freeze([
  { id: 'gateway-server', name: 'gateway server', service: 'gateway', selector: GATEWAY_SERVER },
  {
    id: 'people-server',
    name: 'people server (archive)',
    service: 'people',
    selector: { service: 'people', kind: SpanKind.SERVER },
  },
  {
    id: 'outbox-publish',
    name: 'outbox.publish',
    service: 'people',
    selector: { name: 'outbox.publish', service: 'people', kind: SpanKind.PRODUCER },
  },
  {
    id: 'timesheets-consume',
    name: CONSUME_SPAN,
    service: 'timesheets',
    selector: { name: CONSUME_SPAN, service: 'timesheets', kind: SpanKind.CONSUMER },
  },
]);

const SELECTORS: SpanSelector[] = SEAM_REQUIRED_SPANS.map((span) => span.selector);

/** One required span as reported, with the matched span's ids when found. */
export interface SeamTraceSpan {
  name: string;
  service: string;
  found: boolean;
  spanId: string | null;
  parentSpanId: string | null;
}

/** The reported seam trace; `singleTrace` holds when every required span descends from its gateway span. */
export interface SeamTrace {
  traceId: string | null;
  requiredSpans: SeamTraceSpan[];
  singleTrace: boolean;
}

/** Outcome of {@link findSeamTrace}; `candidates` counts the traces considered. */
export interface SeamTraceResult {
  trace: SeamTrace;
  candidates: number;
  problems: string[];
}

/** Candidate selection: one trace by id, else every trace whose gateway server span path matches `archivePath`. */
export interface FindSeamTraceOptions {
  traceId?: string;
  archivePath?: RegExp;
}

// spansFromOtlpJsonLines keeps neither span attributes nor start times, so only those two fields are read here.
interface OtlpAttribute {
  key?: unknown;
  value?: { stringValue?: unknown } | null;
}

interface OtlpSpanFields {
  traceId?: unknown;
  spanId?: unknown;
  startTimeUnixNano?: unknown;
  attributes?: unknown;
}

interface OtlpScopeSpans {
  spans?: OtlpSpanFields[];
}

interface OtlpRequest {
  resourceSpans?: { scopeSpans?: OtlpScopeSpans[]; instrumentationLibrarySpans?: OtlpScopeSpans[] }[];
}

interface SpanDetail {
  start: bigint;
  paths: string[];
}

const PATH_ATTRIBUTES = new Set(['url.path', 'http.target', 'http.route']);
const NO_START = -1n;

function spanKey(traceId: string, spanId: string): string {
  return `${traceId}/${spanId}`;
}

/** Start time and path attributes of each span in one export line, keyed by trace and span id. */
function lineDetails(request: OtlpRequest | null): Map<string, SpanDetail> {
  const details = new Map<string, SpanDetail>();
  for (const resourceSpans of request?.resourceSpans ?? []) {
    for (const scope of resourceSpans.scopeSpans ?? resourceSpans.instrumentationLibrarySpans ?? []) {
      for (const span of scope.spans ?? []) {
        const rawStart = String(span.startTimeUnixNano ?? '');
        const paths = Array.isArray(span.attributes)
          ? span.attributes.flatMap((attribute: OtlpAttribute | null) => {
              const value = attribute?.value?.stringValue;
              return PATH_ATTRIBUTES.has(String(attribute?.key)) && typeof value === 'string' ? [value] : [];
            })
          : [];
        details.set(spanKey(String(span.traceId), String(span.spanId)), {
          start: /^[0-9]+$/.test(rawStart) ? BigInt(rawStart) : NO_START,
          paths,
        });
      }
    }
  }
  return details;
}

function failureDetail(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  return cause instanceof Error ? cause.message : String(cause);
}

type ParsedLine = { spans: ContinuitySpan[]; details: Map<string, SpanDetail> } | { failure: unknown };

/** Spans of one export line with their details, none for a blank line, or the failure that made the line unreadable. */
function parseLine(line: string): ParsedLine {
  if (line.trim() === '') {
    return { spans: [], details: new Map() };
  }
  let spans: ContinuitySpan[];
  try {
    spans = spansFromOtlpJsonLines(line);
  } catch (err) {
    return { failure: err };
  }
  return { spans, details: lineDetails(JSON.parse(line) as OtlpRequest | null) };
}

function servesArchive(span: ContinuitySpan, details: ReadonlyMap<string, SpanDetail>, archivePath: RegExp): boolean {
  const paths = details.get(spanKey(span.traceId, span.spanId))?.paths ?? [];
  return paths.some((p) => p.search(archivePath) >= 0) && firstMatch([span], GATEWAY_SERVER) !== undefined;
}

/** First span matching `selector`, by the platform's selector rules. */
function firstMatch(spans: readonly ContinuitySpan[], selector: SpanSelector): ContinuitySpan | undefined {
  const result = checkTraceContinuity(spans, { expectedSpanNames: [selector] });
  return result.ok ? result.matched[0] : undefined;
}

interface Evaluation {
  traceId: string;
  /** Per required span, in order: the matched span, or undefined when the trace holds none. */
  found: (ContinuitySpan | undefined)[];
  continuity: ContinuityResult;
  gatewayStart: bigint;
}

function evaluate(traceId: string, spans: readonly ContinuitySpan[], starts: ReadonlyMap<string, bigint>): Evaluation {
  const continuity = checkTraceContinuity(spans, { expectedSpanNames: SELECTORS });
  const found = continuity.ok ? continuity.matched : SELECTORS.map((selector) => firstMatch(spans, selector));
  const gateway = found[0];
  return {
    traceId,
    found,
    continuity,
    gatewayStart: gateway === undefined ? NO_START : (starts.get(spanKey(traceId, gateway.spanId)) ?? NO_START),
  };
}

function foundCount(evaluation: Evaluation): number {
  return evaluation.found.filter((span) => span !== undefined).length;
}

/** Complete before incomplete, then more required spans found, then the later gateway start; ties go to `next`. */
function outranks(next: Evaluation, chosen: Evaluation): boolean {
  if (next.continuity.ok !== chosen.continuity.ok) {
    return next.continuity.ok;
  }
  const difference = foundCount(next) - foundCount(chosen);
  return difference !== 0 ? difference > 0 : next.gatewayStart >= chosen.gatewayStart;
}

function reportSpans(found: readonly (ContinuitySpan | undefined)[]): SeamTraceSpan[] {
  return SEAM_REQUIRED_SPANS.map((required, index) => {
    const span = found[index];
    return {
      name: required.name,
      service: required.service,
      found: span !== undefined,
      spanId: span?.spanId ?? null,
      parentSpanId: span?.parentSpanId ?? null,
    };
  });
}

/** Most problems of one kind listed one by one; any further ones are summarised in a single problem. */
const MAX_PROBLEM_SAMPLES = 20;

/** First-seen ids of traces holding a span that matches `selector`, at most one more than the sample limit. */
interface TraceSample {
  selector: SpanSelector;
  ids: Set<string>;
  overflow: boolean;
}

function noteTrace(sample: TraceSample, span: ContinuitySpan): void {
  if (sample.overflow || sample.ids.has(span.traceId) || firstMatch([span], sample.selector) === undefined) {
    return;
  }
  if (sample.ids.size > MAX_PROBLEM_SAMPLES) {
    sample.overflow = true;
  } else {
    sample.ids.add(span.traceId);
  }
}

/** Archive candidates mapped to the line number of their last span, and the number of lines read. */
interface ArchiveScan {
  lastLines: Map<string, number>;
  lineCount: number;
}

function scanArchiveCandidates(lines: Iterable<string>, archivePath: RegExp): ArchiveScan {
  const lastLines = new Map<string, number>();
  let lineCount = 0;
  for (const line of lines) {
    lineCount += 1;
    const parsed = parseLine(line);
    if ('failure' in parsed) {
      continue;
    }
    for (const span of parsed.spans) {
      if (lastLines.has(span.traceId) || servesArchive(span, parsed.details, archivePath)) {
        lastLines.set(span.traceId, lineCount);
      }
    }
  }
  return { lastLines, lineCount };
}

/** Spans collected so far for a trace not yet evaluated, and the start time of each of its gateway server spans. */
interface OpenTrace {
  spans: ContinuitySpan[];
  starts: Map<string, bigint>;
}

const ONE_SHOT_INPUT =
  'findSeamTrace without opts.traceId reads its lines twice: pass an array or the result of readTraceLines, or set opts.traceId';

/** With `opts.traceId`, one pass keeping that trace; otherwise two passes over a re-iterable input keeping only open archive candidates. */
export function findSeamTrace(lines: Iterable<string>, opts: FindSeamTraceOptions = {}): SeamTraceResult {
  if (opts.traceId === undefined && (lines[Symbol.iterator]() as unknown) === lines) {
    throw new TypeError(ONE_SHOT_INPUT);
  }
  const scan = opts.traceId === undefined ? scanArchiveCandidates(lines, opts.archivePath ?? DEFAULT_ARCHIVE_PATH) : undefined;
  const lineLimit = scan?.lineCount ?? Number.POSITIVE_INFINITY;
  const keeps = (id: string): boolean => (scan === undefined ? id === opts.traceId : scan.lastLines.has(id));
  const open = new Map<string, OpenTrace>();
  const tally: { best?: Evaluation; evaluated: number } = { evaluated: 0 };
  const settle = (id: string, trace: OpenTrace): void => {
    scan?.lastLines.delete(id);
    open.delete(id);
    const evaluation = evaluate(id, trace.spans, trace.starts);
    tally.evaluated += 1;
    if (tally.best === undefined || outranks(evaluation, tally.best)) {
      tally.best = evaluation;
    }
  };

  const problems: string[] = [];
  const samples: TraceSample[] = SELECTORS.map((selector) => ({ selector, ids: new Set<string>(), overflow: false }));
  let lineNumber = 0;
  let unlistedMalformed = 0;
  for (const line of lines) {
    if (lineNumber === lineLimit) {
      break;
    }
    lineNumber += 1;
    const parsed = parseLine(line);
    if ('failure' in parsed) {
      if (problems.length < MAX_PROBLEM_SAMPLES) {
        problems.push(`malformed OTLP JSON on line ${lineNumber}: ${failureDetail(parsed.failure)}`);
      } else {
        unlistedMalformed += 1;
      }
    } else {
      for (const span of parsed.spans) {
        for (const sample of samples) {
          noteTrace(sample, span);
        }
        if (!keeps(span.traceId)) {
          continue;
        }
        let trace = open.get(span.traceId);
        if (trace === undefined) {
          trace = { spans: [], starts: new Map() };
          open.set(span.traceId, trace);
        }
        trace.spans.push(span);
        if (firstMatch([span], GATEWAY_SERVER) !== undefined) {
          const key = spanKey(span.traceId, span.spanId);
          trace.starts.set(key, parsed.details.get(key)?.start ?? NO_START);
        }
      }
      for (const span of parsed.spans) {
        const trace = open.get(span.traceId);
        if (trace !== undefined && scan?.lastLines.get(span.traceId) === lineNumber) {
          settle(span.traceId, trace);
        }
      }
    }
  }
  for (const [id, trace] of [...open]) {
    settle(id, trace);
  }
  if (unlistedMalformed > 0) {
    problems.push(`${unlistedMalformed} further malformed OTLP JSON lines not listed`);
  }

  const { best } = tally;
  if (best === undefined) {
    return {
      trace: { traceId: null, requiredSpans: reportSpans([]), singleTrace: false },
      candidates: 0,
      problems: [...problems, 'no seam trace found'],
    };
  }

  if (!best.continuity.ok) {
    problems.push(...best.continuity.problems);
    const elsewhere = new Set<string>();
    let unlistedSplit = false;
    samples.forEach((sample, index) => {
      if (best.found[index] !== undefined) {
        return;
      }
      unlistedSplit ||= sample.overflow;
      for (const traceId of sample.ids) {
        if (traceId !== best.traceId) {
          elsewhere.add(traceId);
        }
      }
    });
    for (const traceId of [...elsewhere].slice(0, MAX_PROBLEM_SAMPLES)) {
      problems.push(`split across traces: ${traceId}`);
    }
    if (unlistedSplit || elsewhere.size > MAX_PROBLEM_SAMPLES) {
      problems.push(`split across further traces not listed (more than ${MAX_PROBLEM_SAMPLES})`);
    }
  }

  return {
    trace: { traceId: best.traceId, requiredSpans: reportSpans(best.found), singleTrace: best.continuity.ok },
    candidates: tally.evaluated,
    problems,
  };
}

const LOG_RECORD_SCHEMA = 'platform/contracts/log-record.v1.json';
const MAX_INVALID_SAMPLES = 20;
const MAX_SAMPLE_LENGTH = 500;

/** An invalid log line, cut to 500 characters, with its validation errors. */
export interface InvalidLogSample {
  source: string | null;
  line: string;
  errors: string[];
}

/** Result of validating captured log lines against log-record.v1. */
export interface LogValidationSummary {
  schema: typeof LOG_RECORD_SCHEMA;
  linesChecked: number;
  invalid: number;
  invalidSamples: InvalidLogSample[];
}

/** A log line and the package whose process wrote it. */
export interface CapturedLogLine {
  source: string;
  line: string;
}

function logLineErrors(line: string): string[] | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return ['not JSON'];
  }
  const result = validateLogRecord(record);
  return result.valid ? null : result.errors;
}

/** Validates each non-blank line against log-record.v1, keeping at most 20 invalid samples. */
export function validateLogLines(lines: Iterable<string | CapturedLogLine>): LogValidationSummary {
  const summary: LogValidationSummary = { schema: LOG_RECORD_SCHEMA, linesChecked: 0, invalid: 0, invalidSamples: [] };
  for (const entry of lines) {
    const { source, line } = typeof entry === 'string' ? { source: null, line: entry } : entry;
    if (line.trim() === '') {
      continue;
    }
    summary.linesChecked += 1;
    const errors = logLineErrors(line);
    if (errors === null) {
      continue;
    }
    summary.invalid += 1;
    if (summary.invalidSamples.length < MAX_INVALID_SAMPLES) {
      summary.invalidSamples.push({ source, line: line.slice(0, MAX_SAMPLE_LENGTH), errors });
    }
  }
  return summary;
}

/** Which up.json processes to read: `packages` defaults to every target package, never legacy ColdFusion. */
export interface ReadCapturedLogLinesOptions {
  env?: EnvLike;
  packages?: readonly string[];
  /** Byte offset per package from {@link capturedLogOffsets}; a line it cuts is skipped. */
  fromOffsets?: Readonly<Record<string, number>>;
}

/** Each listed package's up.json log file; throws naming a package with no log path. */
function capturedLogFiles(opts: ReadCapturedLogLinesOptions): { source: string; file: string }[] {
  const { processes } = readUpState({ env: opts.env });
  return (opts.packages ?? PACKAGE_NAMES).map((name) => {
    const entry = processes[name];
    if (entry?.log === undefined) {
      throw new Error(`${upStatePath(opts.env)} records no log file for package ${name}`);
    }
    return { source: name, file: path.resolve(entry.cwd, entry.log) };
  });
}

/** Current byte size of each listed package's up.json log, 0 when absent; pass it as `fromOffsets` to read later lines only. */
export function capturedLogOffsets(opts: Omit<ReadCapturedLogLinesOptions, 'fromOffsets'> = {}): Record<string, number> {
  const offsets: Record<string, number> = {};
  for (const { source, file } of capturedLogFiles(opts)) {
    try {
      offsets[source] = statSync(file).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      offsets[source] = 0;
    }
  }
  return offsets;
}

/** Non-blank lines of each listed package's up.json log, streamed per iteration; throws naming a package with no log path. */
export function readCapturedLogLines(opts: ReadCapturedLogLinesOptions = {}): Iterable<CapturedLogLine> {
  const logs = capturedLogFiles(opts);
  return {
    *[Symbol.iterator]() {
      for (const { source, file } of logs) {
        for (const line of fileLines(file, opts.fromOffsets?.[source] ?? 0)) {
          yield { source, line };
        }
      }
    },
  };
}
