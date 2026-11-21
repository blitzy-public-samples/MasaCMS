// Seam 1 traced through the gateway, captured log lines checked against log-record.v1 and the platform's
// dropped-context contract result read back; writes opt2/reports/observability.json.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { z } from '@opt2/platform/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  pollUntil,
  runSeam1,
  type Seam1Evidence,
  type SeamResult,
} from '../../src/events/seams.js';
import {
  SEAM_REQUIRED_SPANS,
  findSeamTrace,
  readCapturedLogLines,
  readTraceLines,
  traceExportOffset,
  validateLogLines,
  type InvalidLogSample,
  type SeamTrace,
} from '../../src/events/traces.js';
import { repoPath, reportsDir } from '../../src/lib/paths.js';
import { readJson, writeJsonReport } from '../../src/lib/report.js';
import { vitestResultPath } from '../../src/reporting/speed.js';
import { requireTableVersion } from '../helpers/stack.js';

const GENERATED_BY = 'harness/e2e/events/trace.e2e.test.ts';
const TABLE_VERSION = 'v0002';
const SCENARIO = 'people archive through the gateway (seam 1: archive -> blackout)';
// A label rather than tracesPath(), so the committed report names no machine-specific directory.
const TRACE_SOURCE = '${OPT2_STATE_DIR}/otel/traces.jsonl';
const DROPPED_CONTEXT_SOURCE = 'platform/test/contract/trace-propagation.test.ts';
const DROPPED_CONTEXT_TITLE = 'reports a broken trace when the producer drops context';

/** Collector batch export plus Pub/Sub push latency. */
const TRACE_POLL = Object.freeze({ timeoutMs: DEFAULT_POLL_TIMEOUT_MS, intervalMs: DEFAULT_POLL_INTERVAL_MS });
/** runSeam1's owner exports and its own blackout wait, then the trace wait. */
const SEAM_TEST_TIMEOUT_MS = 5 * 60_000 + TRACE_POLL.timeoutMs;
const LOGS_TEST_TIMEOUT_MS = 2 * 60_000;
const DROPPED_CONTEXT_TEST_TIMEOUT_MS = 30_000;

/** Schema path the log validator reports, taken from it so the two cannot drift. */
const LOG_SCHEMA = validateLogLines([]).schema;

type SeamSkipped = NonNullable<SeamResult['skipped']>;

interface LogsBlock {
  schema: string;
  linesChecked: number | null;
  invalid: number | null;
  invalidSamples: InvalidLogSample[];
}

/** Permissive shape of the vitest JSON reporter output, reduced to the fields read here. */
const vitestJsonSchema = z.looseObject({
  testResults: z.array(
    z.looseObject({
      name: z.string(),
      assertionResults: z.array(z.looseObject({ title: z.string(), status: z.string() })),
    }),
  ),
});

let evidence: Seam1Evidence | undefined;
let seamSkipped: SeamSkipped | undefined;
let trace: SeamTrace = unfoundTrace(null);
let logs: LogsBlock = { schema: LOG_SCHEMA, linesChecked: null, invalid: null, invalidSamples: [] };
let failsByDesign: boolean | null = null;

/** The seam trace with no required span found. */
function unfoundTrace(traceId: string | null): SeamTrace {
  return {
    traceId,
    requiredSpans: SEAM_REQUIRED_SPANS.map(({ name, service }) => ({
      name,
      service,
      found: false,
      spanId: null,
      parentSpanId: null,
    })),
    singleTrace: false,
  };
}

function scenario(): string {
  return evidence === undefined ? SCENARIO : `${SCENARIO}, person ${evidence.personId} of site ${evidence.siteId}`;
}

/** Overall verdict; a log or dropped-context failure is not hidden behind a skipped seam. */
function overallResult(): 'pass' | 'fail' | SeamSkipped {
  const logsValid = logs.invalid === 0 && (logs.linesChecked ?? 0) > 0;
  if (!logsValid || failsByDesign !== true) return 'fail';
  if (seamSkipped !== undefined) return seamSkipped;
  return trace.singleTrace && trace.requiredSpans.every((span) => span.found) ? 'pass' : 'fail';
}

describe('observability across the archive seam', () => {
  beforeAll(() => requireTableVersion(TABLE_VERSION));

  afterAll(async () => {
    await writeJsonReport(path.join(reportsDir(), 'observability.json'), {
      generatedBy: GENERATED_BY,
      status: 'generated',
      scenario: scenario(),
      traceSource: TRACE_SOURCE,
      trace,
      droppedContextTest: { source: DROPPED_CONTEXT_SOURCE, failsByDesign },
      logs,
      result: overallResult(),
    });
  });

  it(
    'one traceId spans gateway, people, outbox publish and timesheets consumer',
    async ({ skip }) => {
      const fromOffset = traceExportOffset();
      // runSeam1 mints the archive request's traceparent itself and reports its trace id in the evidence.
      const seam = await runSeam1();
      if (seam.skipped !== undefined) {
        seamSkipped = seam.skipped;
        return skip(`${seam.skipped}: ${seam.evidence.reason ?? 'no reason recorded'}`);
      }
      evidence = seam.evidence;
      const { traceId, archive } = seam.evidence;
      trace = unfoundTrace(traceId);

      const archived = archive.status >= 200 && archive.status < 300;
      const outcome = await pollUntil(
        async () => findSeamTrace(readTraceLines(undefined, { fromOffset }), { traceId }),
        (found) => found.trace.singleTrace,
        { poll: archived ? TRACE_POLL : { timeoutMs: 0 } },
      );
      trace = { ...outcome.value.trace, traceId };

      const detail = `archive answered ${archive.status}; ${outcome.value.problems.join('; ') || 'no problems reported'}`;
      const missing = trace.requiredSpans.filter((span) => !span.found).map((span) => span.name);
      expect(missing, `spans missing from trace ${traceId} after ${outcome.elapsedMs} ms (${detail})`).toEqual([]);
      expect(trace.singleTrace, `trace ${traceId} is not one parent-linked chain (${detail})`).toBe(true);
    },
    SEAM_TEST_TIMEOUT_MS,
  );

  it(
    'every captured target log line validates against log-record.v1',
    () => {
      logs = validateLogLines(readCapturedLogLines());
      const reasons = logs.invalidSamples
        .slice(0, 3)
        .map((sample) => `${sample.source ?? '?'}: ${sample.errors.join(', ')}`)
        .join(' | ');
      expect(logs.linesChecked, 'captured log lines').toBeGreaterThan(0);
      expect(logs.invalid, `invalid log lines (${reasons})`).toBe(0);
    },
    LOGS_TEST_TIMEOUT_MS,
  );

  it(
    'platform contract run reports a broken trace when the producer drops context',
    async () => {
      failsByDesign = false;
      const file = vitestResultPath('platform');
      if (!existsSync(file)) {
        throw new Error(`${file} is absent; harness/repro/test-all.sh stage 2 writes the platform vitest JSON`);
      }
      // Not destructured: vitest's static collector reads any call on a name starting with `test` as a test.
      const platformRun = await readJson(file, vitestJsonSchema);
      const source = repoPath(DROPPED_CONTEXT_SOURCE);
      const assertion = platformRun.testResults
        .find((entry) => path.resolve(entry.name) === source)
        ?.assertionResults.find((entry) => entry.title === DROPPED_CONTEXT_TITLE);
      if (assertion === undefined) {
        throw new Error(`${file} records no "${DROPPED_CONTEXT_TITLE}" result for ${DROPPED_CONTEXT_SOURCE}`);
      }
      failsByDesign = assertion.status === 'passed';
      expect(assertion.status, `"${DROPPED_CONTEXT_TITLE}" in ${file}`).toBe('passed');
    },
    DROPPED_CONTEXT_TEST_TIMEOUT_MS,
  );
});
