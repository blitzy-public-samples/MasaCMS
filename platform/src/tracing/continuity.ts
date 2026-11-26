// Checks that expected spans form one parent-linked trace, from in-memory spans or OTLP-JSON export lines.
import { SpanKind } from '@opentelemetry/api';
import type { ReadableSpan } from './sdk.js';

/** Span fields the continuity check reads. */
export interface ContinuitySpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind?: SpanKind;
  service?: string;
}

/** Exact span name, name pattern, or any combination of name, `service.name` and kind. */
export type SpanSelector = string | RegExp | { name?: string | RegExp; service?: string; kind?: SpanKind };

/** Selectors of the spans that must share one trace; the first selects the chain root. */
export interface ContinuityOptions {
  expectedSpanNames: SpanSelector[];
}

/** Outcome of a continuity check; when `ok`, `matched` holds one span per selector, in selector order. */
export interface ContinuityResult {
  ok: boolean;
  traceId?: string;
  matched: ContinuitySpan[];
  problems: string[];
}

/** Thrown by {@link assertTraceContinuity}; carries the failed result. */
export class TraceContinuityError extends Error {
  readonly result: ContinuityResult;

  constructor(result: ContinuityResult) {
    super(`trace continuity broken: ${result.problems.join('; ')}`);
    this.name = 'TraceContinuityError';
    this.result = result;
  }
}

function isReadableSpan(span: ReadableSpan | ContinuitySpan): span is ReadableSpan {
  return typeof (span as { spanContext?: unknown }).spanContext === 'function';
}

/** Maps an SDK span to its continuity fields; a span already in that shape is returned as is. */
export function toContinuitySpan(span: ReadableSpan | ContinuitySpan): ContinuitySpan {
  if (!isReadableSpan(span)) {
    return span;
  }
  const { traceId, spanId } = span.spanContext();
  const result: ContinuitySpan = { name: span.name, traceId, spanId, kind: span.kind };
  const parentSpanId = span.parentSpanContext?.spanId;
  if (parentSpanId !== undefined) {
    result.parentSpanId = parentSpanId;
  }
  const service = span.resource.attributes['service.name'];
  if (service !== undefined) {
    result.service = String(service);
  }
  return result;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
}

interface OtlpScopeSpans {
  spans?: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource?: { attributes?: { key: string; value?: { stringValue?: string } }[] };
  scopeSpans?: OtlpScopeSpans[];
  instrumentationLibrarySpans?: OtlpScopeSpans[];
}

// Index = OTLP enum value; the API's SpanKind is that value minus one, and UNSPECIFIED has no API equivalent.
const OTLP_KIND_NAMES = [
  'SPAN_KIND_UNSPECIFIED',
  'SPAN_KIND_INTERNAL',
  'SPAN_KIND_SERVER',
  'SPAN_KIND_CLIENT',
  'SPAN_KIND_PRODUCER',
  'SPAN_KIND_CONSUMER',
];

function kindFromOtlp(kind: number | string | undefined): SpanKind | undefined {
  const value = typeof kind === 'string' ? OTLP_KIND_NAMES.indexOf(kind) : kind;
  return value === undefined || value < 1 || value >= OTLP_KIND_NAMES.length ? undefined : ((value - 1) as SpanKind);
}

/**
 * Parses OTLP-JSON `ExportTraceServiceRequest` lines, as the collector's file exporter writes them.
 * Blank lines are skipped; a malformed line throws an error naming its 1-based line number.
 */
export function spansFromOtlpJsonLines(text: string): ContinuitySpan[] {
  const spans: ContinuitySpan[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    let request: { resourceSpans?: OtlpResourceSpans[] } | null;
    try {
      request = JSON.parse(line) as { resourceSpans?: OtlpResourceSpans[] } | null;
    } catch (err) {
      throw new Error(`malformed OTLP JSON on line ${index + 1}: ${(err as Error).message}`, { cause: err });
    }
    for (const resourceSpans of request?.resourceSpans ?? []) {
      const service = resourceSpans.resource?.attributes?.find((attribute) => attribute.key === 'service.name')
        ?.value?.stringValue;
      for (const scope of resourceSpans.scopeSpans ?? resourceSpans.instrumentationLibrarySpans ?? []) {
        for (const otlp of scope.spans ?? []) {
          const span: ContinuitySpan = { name: otlp.name ?? '', traceId: otlp.traceId, spanId: otlp.spanId };
          if (otlp.parentSpanId) {
            span.parentSpanId = otlp.parentSpanId;
          }
          const kind = kindFromOtlp(otlp.kind);
          if (kind !== undefined) {
            span.kind = kind;
          }
          if (service !== undefined) {
            span.service = service;
          }
          spans.push(span);
        }
      }
    }
  });
  return spans;
}

function nameMatches(name: string, pattern: string | RegExp): boolean {
  // search() ignores and restores lastIndex, so a global or sticky pattern matches the same way on every span.
  return typeof pattern === 'string' ? name === pattern : name.search(pattern) >= 0;
}

function matchesSelector(span: ContinuitySpan, selector: SpanSelector): boolean {
  if (typeof selector === 'string' || selector instanceof RegExp) {
    return nameMatches(span.name, selector);
  }
  return (
    (selector.name === undefined || nameMatches(span.name, selector.name)) &&
    (selector.service === undefined || span.service === selector.service) &&
    (selector.kind === undefined || span.kind === selector.kind)
  );
}

function describeSelector(selector: SpanSelector): string {
  if (typeof selector === 'string') {
    return selector;
  }
  if (selector instanceof RegExp) {
    return selector.source;
  }
  const name = selector.name === undefined ? '' : describeSelector(selector.name);
  const service = selector.service === undefined ? '' : `@${selector.service}`;
  const kind = selector.kind === undefined ? '' : `(${SpanKind[selector.kind]})`;
  return `${name}${service}${kind}` || '*';
}

/** Walks parent links from `span` within one trace to `rootId`; returns the problem, or undefined when reached. */
function descend(
  span: ContinuitySpan,
  label: string,
  rootLabel: string,
  byId: ReadonlyMap<string, ContinuitySpan>,
  rootId: string,
): string | undefined {
  if (span.parentSpanId === undefined) {
    return `no parent link: ${label}`;
  }
  const visited = new Set<string>([span.spanId]);
  let parentId: string | undefined = span.parentSpanId;
  while (parentId !== undefined && !visited.has(parentId)) {
    if (parentId === rootId) {
      return undefined;
    }
    const parent = byId.get(parentId);
    if (parent === undefined) {
      return `dangling parent ${parentId} of ${label}`;
    }
    visited.add(parentId);
    parentId = parent.parentSpanId;
  }
  return `${label} does not descend from ${rootLabel}`;
}

interface Evaluation {
  present: number;
  matched: ContinuitySpan[];
  problems: string[];
}

/**
 * Tests the chain inside trace `traceId`, trying each root match in turn; `present` counts selectors matched there.
 * Returns the first intact root's chain, else the problems of the root that reached the most selectors.
 */
function evaluateTrace(
  traceId: string,
  spans: readonly ContinuitySpan[],
  matches: readonly ContinuitySpan[][],
  labels: readonly string[],
): Evaluation {
  const byId = new Map<string, ContinuitySpan>();
  for (const span of spans) {
    if (span.traceId === traceId) {
      byId.set(span.spanId, span);
    }
  }
  const inTrace = matches.map((list) => list.filter((span) => span.traceId === traceId));
  const rootLabel = labels[0] ?? '';
  const present = inTrace.filter((list) => list.length > 0).length;
  let best: Evaluation | undefined;
  for (const root of inTrace[0] ?? []) {
    const matched: ContinuitySpan[] = [root];
    const problems = new Set<string>();
    for (let i = 1; i < inTrace.length; i += 1) {
      const failures: string[] = [];
      for (const span of inTrace[i] ?? []) {
        const problem = descend(span, labels[i] ?? '', rootLabel, byId, root.spanId);
        if (problem === undefined) {
          matched.push(span);
          failures.length = 0;
          break;
        }
        failures.push(problem);
      }
      for (const problem of failures) {
        problems.add(problem);
      }
    }
    if (best === undefined || matched.length > best.matched.length) {
      best = { present, matched, problems: [...problems] };
    }
    if (matched.length === inTrace.length) {
      break;
    }
  }
  return best ?? { present, matched: [], problems: [] };
}

/** Checks that one trace holds a span per selector, each later one descending from the same root-selector span. */
export function checkTraceContinuity(
  spans: ReadonlyArray<ReadableSpan | ContinuitySpan>,
  options: ContinuityOptions,
): ContinuityResult {
  const selectors = options.expectedSpanNames;
  if (selectors.length === 0) {
    return { ok: false, matched: [], problems: ['no expected spans given'] };
  }
  const all = spans.map(toContinuitySpan);
  const labels = selectors.map(describeSelector);
  const matches = selectors.map((selector) => all.filter((span) => matchesSelector(span, selector)));
  const missing = labels.filter((_, i) => matches[i]?.length === 0).map((label) => `missing span: ${label}`);
  if (missing.length > 0) {
    return { ok: false, matched: [], problems: missing };
  }

  const candidates = [...new Set((matches[0] ?? []).map((span) => span.traceId))];
  let best: Evaluation | undefined;
  for (const traceId of candidates) {
    const evaluation = evaluateTrace(traceId, all, matches, labels);
    if (evaluation.present === selectors.length && evaluation.problems.length === 0) {
      return { ok: true, traceId, matched: evaluation.matched, problems: [] };
    }
    if (best === undefined || evaluation.present > best.present) {
      best = evaluation;
    }
  }

  const problems = best?.problems ?? [];
  if ((best?.present ?? 0) < selectors.length) {
    const traces = labels.map(
      (label, i) => `${label} -> [${[...new Set((matches[i] ?? []).map((span) => span.traceId))].join(', ')}]`,
    );
    problems.unshift(`broken chain: expected spans do not share one traceId (${traces.join(', ')})`);
  }
  return { ok: false, matched: [], problems };
}

/** Returns the result of {@link checkTraceContinuity}, or throws {@link TraceContinuityError} when it is not `ok`. */
export function assertTraceContinuity(
  spans: ReadonlyArray<ReadableSpan | ContinuitySpan>,
  options: ContinuityOptions,
): ContinuityResult {
  const result = checkTraceContinuity(spans, options);
  if (!result.ok) {
    throw new TraceContinuityError(result);
  }
  return result;
}
