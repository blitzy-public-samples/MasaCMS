// Finds the people-archive seam trace in the collector's OTLP-JSON export and validates captured log lines.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

function nonBlankLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/** Non-blank lines of the trace export; throws an error naming the path when the file does not exist. */
export function readTraceLines(env?: EnvLike): string[] {
  const file = tracesPath(env);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${file} does not exist; the OpenTelemetry Collector has exported no traces`, { cause: err });
    }
    throw err;
  }
  return nonBlankLines(text);
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

function recordDetails(request: OtlpRequest | null, details: Map<string, SpanDetail>): void {
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
}

function failureDetail(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  return cause instanceof Error ? cause.message : String(cause);
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

function evaluate(traceId: string, spans: readonly ContinuitySpan[], details: ReadonlyMap<string, SpanDetail>): Evaluation {
  const continuity = checkTraceContinuity(spans, { expectedSpanNames: SELECTORS });
  const found = continuity.ok ? continuity.matched : SELECTORS.map((selector) => firstMatch(spans, selector));
  const gateway = found[0];
  return {
    traceId,
    found,
    continuity,
    gatewayStart: gateway === undefined ? NO_START : (details.get(spanKey(traceId, gateway.spanId))?.start ?? NO_START),
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

/** Picks the seam trace from OTLP-JSON export lines; unparseable lines are reported in `problems` by 1-based number. */
export function findSeamTrace(lines: string[], opts: FindSeamTraceOptions = {}): SeamTraceResult {
  const problems: string[] = [];
  const details = new Map<string, SpanDetail>();
  const byTrace = new Map<string, ContinuitySpan[]>();
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    let spans: ContinuitySpan[];
    try {
      spans = spansFromOtlpJsonLines(line);
    } catch (err) {
      problems.push(`malformed OTLP JSON on line ${index + 1}: ${failureDetail(err)}`);
      return;
    }
    recordDetails(JSON.parse(line) as OtlpRequest | null, details);
    for (const span of spans) {
      const traceSpans = byTrace.get(span.traceId);
      if (traceSpans === undefined) {
        byTrace.set(span.traceId, [span]);
      } else {
        traceSpans.push(span);
      }
    }
  });

  const archivePath = opts.archivePath ?? DEFAULT_ARCHIVE_PATH;
  const servesArchive = (spans: readonly ContinuitySpan[]): boolean =>
    firstMatch(
      spans.filter((span) => details.get(spanKey(span.traceId, span.spanId))?.paths.some((p) => p.search(archivePath) >= 0)),
      GATEWAY_SERVER,
    ) !== undefined;
  const evaluations = [...byTrace]
    .filter(([traceId, spans]) => (opts.traceId === undefined ? servesArchive(spans) : traceId === opts.traceId))
    .map(([traceId, spans]) => evaluate(traceId, spans, details));

  if (evaluations.length === 0) {
    return {
      trace: { traceId: null, requiredSpans: reportSpans([]), singleTrace: false },
      candidates: 0,
      problems: [...problems, 'no seam trace found'],
    };
  }

  const best = evaluations.reduce((chosen, next) => (outranks(next, chosen) ? next : chosen));
  if (!best.continuity.ok) {
    problems.push(...best.continuity.problems);
    const elsewhere = new Set<string>();
    SELECTORS.forEach((selector, index) => {
      if (best.found[index] !== undefined) {
        return;
      }
      for (const [traceId, spans] of byTrace) {
        if (traceId !== best.traceId && firstMatch(spans, selector) !== undefined) {
          elsewhere.add(traceId);
        }
      }
    });
    for (const traceId of elsewhere) {
      problems.push(`split across traces: ${traceId}`);
    }
  }

  return {
    trace: { traceId: best.traceId, requiredSpans: reportSpans(best.found), singleTrace: best.continuity.ok },
    candidates: evaluations.length,
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
export function validateLogLines(lines: ReadonlyArray<string | CapturedLogLine>): LogValidationSummary {
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
}

/** Non-blank lines of each listed package's process log in up.json; throws naming a package with no log path. */
export function readCapturedLogLines(opts: ReadCapturedLogLinesOptions = {}): CapturedLogLine[] {
  const { processes } = readUpState({ env: opts.env });
  return (opts.packages ?? PACKAGE_NAMES).flatMap((name) => {
    const entry = processes[name];
    if (entry?.log === undefined) {
      throw new Error(`${upStatePath(opts.env)} records no log file for package ${name}`);
    }
    return nonBlankLines(readFileSync(path.resolve(entry.cwd, entry.log), 'utf8')).map((line) => ({ source: name, line }));
  });
}
