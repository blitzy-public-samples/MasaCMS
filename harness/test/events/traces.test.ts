import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  capturedLogOffsets,
  classifyClientSpans,
  findSeamTrace,
  mintTraceparent,
  readCapturedLogLines,
  readTraceLines,
  SEAM_REQUIRED_SPANS,
  SEAM_SUBSCRIPTION,
  tracesPath,
  validateLogLines,
} from '../../src/events/traces.js';
import { repoPath } from '../../src/lib/paths.js';
import type { EnvLike } from '../../src/lib/paths.js';

const SEAM_TRACE = '0af7651916cd43dd8448eb211c80319c';
const DISTRACTOR_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const LOG_SCHEMA = 'platform/contracts/log-record.v1.json';
const CLIENT_TRACE = '5b8efff798038103d269b633813fc60c';
const PORTS = { legacyPort: 25080, stubPort: 25199 };
const LEGACY = 'http://127.0.0.1:25080';
const DESCRIBE_PATH = '/gateway/legacy-bridge/cfml/session.cfm';

interface CommittedReport {
  trace: { requiredSpans: Record<string, unknown>[] } & Record<string, unknown>;
  logs: Record<string, unknown>;
}

type OtlpTestAttribute = { key: string; value: { stringValue: string } | { intValue: string | number } };

interface OtlpTestSpan {
  traceId?: string;
  kind?: number | string;
  attributes: OtlpTestAttribute[];
}

function text(key: string, value: string): OtlpTestAttribute {
  return { key, value: { stringValue: value } };
}

function int(key: string, value: string | number): OtlpTestAttribute {
  return { key, value: { intValue: value } };
}

/** One gateway export line holding `spans`, CLIENT spans of {@link CLIENT_TRACE} unless they say otherwise. */
function gatewayExportLine(spans: OtlpTestSpan[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [text('service.name', 'gateway')] },
        scopeSpans: [
          {
            scope: { name: '@opentelemetry/instrumentation-undici', version: '0.34.0' },
            spans: spans.map((span, index) => ({
              traceId: span.traceId ?? CLIENT_TRACE,
              spanId: `c1d2e3f4a5b6c7${String(index).padStart(2, '0')}`,
              parentSpanId: 'e457b5a2e4d86bd1',
              name: 'GET',
              kind: span.kind ?? 3,
              startTimeUnixNano: '1782810005001000000',
              endTimeUnixNano: '1782810005004000000',
              attributes: span.attributes,
              status: {},
            })),
          },
        ],
      },
    ],
  });
}

/** Undici CLIENT span attributes of a request to `url`. */
function undiciAttributes(url: string): OtlpTestAttribute[] {
  const parsed = new URL(url);
  return [
    text('http.request.method', 'GET'),
    text('url.full', url),
    text('url.path', parsed.pathname),
    text('url.query', parsed.search),
    int('server.port', Number(parsed.port)),
  ];
}

let stateRoot: string;
let env: EnvLike;

beforeEach(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-traces-'));
  env = { OPT2_STATE_DIR: stateRoot };
});

afterEach(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
});

function fixtureUrl(name: string): URL {
  return new URL(`../fixtures/observability/${name}`, import.meta.url);
}

async function fixtureLines(name: string): Promise<string[]> {
  return (await fs.readFile(fixtureUrl(name), 'utf8')).split('\n').filter((line) => line.trim() !== '');
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

describe('findSeamTrace', () => {
  it('finds one trace spanning the four seam spans, each parented by the one before', async () => {
    const result = findSeamTrace(await fixtureLines('traces.sample.jsonl'));
    const spans = result.trace.requiredSpans;

    expect(result.trace.traceId).toBe(SEAM_TRACE);
    expect(result.trace.singleTrace).toBe(true);
    expect(result.candidates).toBe(1);
    expect(result.problems).toEqual([]);
    expect(spans.map(({ name, service, found }) => ({ name, service, found }))).toEqual(
      SEAM_REQUIRED_SPANS.map(({ name, service }) => ({ name, service, found: true })),
    );
    expect(spans.map((span) => span.service)).toEqual(['gateway', 'people', 'people', 'timesheets']);
    expect(SEAM_SUBSCRIPTION).toBe('timesheets.people.person.archived.v1');
    expect(spans.at(-1)?.name).toBe(`events.consume ${SEAM_SUBSCRIPTION}`);
    for (const span of spans) {
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(spans[0]?.parentSpanId).toBeNull();
    spans.slice(1).forEach((span, index) => {
      expect(span.parentSpanId).toBe(spans[index]?.spanId);
    });
  });

  it('never selects the gateway-only distractor trace', async () => {
    const lines = await fixtureLines('traces.sample.jsonl');
    const distractor = lines.filter((line) => line.includes(DISTRACTOR_TRACE));
    const seam = lines.filter((line) => !line.includes(DISTRACTOR_TRACE));

    expect(distractor).toHaveLength(1);
    expect(findSeamTrace([...seam, ...distractor])).toMatchObject({ trace: { traceId: SEAM_TRACE }, candidates: 1 });
    expect(findSeamTrace([...distractor, ...seam])).toMatchObject({ trace: { traceId: SEAM_TRACE }, candidates: 1 });
    expect(findSeamTrace(distractor)).toMatchObject({
      trace: { traceId: null, singleTrace: false },
      candidates: 0,
      problems: ['no seam trace found'],
    });
  });

  it.each([
    [`events.consume ${SEAM_SUBSCRIPTION}`, [true, true, true, false]],
    ['outbox.publish', [true, false, false, true]],
  ])('reports the %s span missing and the trace broken without the line that carries it', async (name, found) => {
    const lines = await fixtureLines('traces.sample.jsonl');
    const kept = lines.filter((line) => !line.includes(`"name":"${name}"`));
    expect(kept).toHaveLength(lines.length - 1);

    const result = findSeamTrace(kept);

    expect(result.trace.traceId).toBe(SEAM_TRACE);
    expect(result.trace.singleTrace).toBe(false);
    expect(result.trace.requiredSpans.map((span) => span.found)).toEqual(found);
    for (const span of result.trace.requiredSpans.filter((required) => !required.found)) {
      expect(span).toMatchObject({ spanId: null, parentSpanId: null });
    }
    expect(result.problems).toContainEqual(expect.stringContaining(`missing span: ${name}@`));
  });

  it('reports no trace for empty input instead of throwing', () => {
    expect(findSeamTrace([])).toEqual({
      trace: {
        traceId: null,
        requiredSpans: SEAM_REQUIRED_SPANS.map(({ name, service }) => ({
          name,
          service,
          found: false,
          spanId: null,
          parentSpanId: null,
        })),
        singleTrace: false,
      },
      candidates: 0,
      problems: ['no seam trace found'],
    });
  });
});

describe('classifyClientSpans', () => {
  it.each([
    [
      'a bridge describe call on the legacy port',
      'bridge',
      undiciAttributes(`${LEGACY}${DESCRIBE_PATH}?op=describe`),
      [`${DESCRIBE_PATH}?op=describe`],
    ],
    [
      'a bridge call named only by its URL',
      'bridge',
      [text('http.url', `${LEGACY}/Gateway/Legacy-Bridge/cfml/session.cfm?op=usedSince&since=261116155900000`)],
      ['/Gateway/Legacy-Bridge/cfml/session.cfm?op=usedSince'],
    ],
    [
      'a bridge call without its full URL',
      'bridge',
      [text('url.path', DESCRIBE_PATH), text('url.query', '?op=markUsed'), int('server.port', '25080')],
      [`${DESCRIBE_PATH}?op=markUsed`],
    ],
    [
      'a bridge call whose op the exporter masked',
      'bridge',
      undiciAttributes(`${LEGACY}${DESCRIBE_PATH}?op=[REDACTED]`),
      [DESCRIBE_PATH],
    ],
    ['a write forwarded to legacy', 'legacy', undiciAttributes(`${LEGACY}/opt2/stub/notes?siteid=tenant-a`), []],
    ['a legacy-port span without URL attributes', 'legacy', [int('net.peer.port', '25080')], []],
    ['a call to the stub', 'stub', undiciAttributes('http://127.0.0.1:25199/opt2/stub/notes'), []],
    ['a call to identity', 'other', undiciAttributes('http://127.0.0.1:25111/internal/v1/csrf/consume'), []],
    ['a URL naming no port', 'other', [text('url.full', 'https://pubsub.googleapis.com/v1/topics')], []],
    [
      'a span naming neither port nor URL',
      'unresolved',
      [text('http.request.method', 'GET'), text('url.full', 'not a url')],
      [],
    ],
  ] as const)('counts %s as %s', (_label, destination, attributes, bridgeCalls) => {
    const result = classifyClientSpans([gatewayExportLine([{ attributes: [...attributes] }])], CLIENT_TRACE, PORTS);

    expect(result).toEqual({
      counts: { legacy: 0, bridge: 0, stub: 0, other: 0, unresolved: 0, [destination]: 1 },
      bridgeCalls,
    });
  });

  it('counts only CLIENT spans of the asked trace and skips lines that do not name it', async () => {
    const forwarded = undiciAttributes(`${LEGACY}/opt2/stub/notes`);
    const lines = [
      'not json',
      gatewayExportLine([
        { kind: 2, attributes: forwarded },
        { traceId: DISTRACTOR_TRACE, attributes: forwarded },
        { kind: 'SPAN_KIND_CLIENT', attributes: undiciAttributes(`${LEGACY}${DESCRIBE_PATH}?op=describe`) },
        { attributes: undiciAttributes('http://127.0.0.1:25199/opt2/stub/notes') },
      ]),
      gatewayExportLine([{ traceId: DISTRACTOR_TRACE, attributes: forwarded }]),
    ];

    expect(classifyClientSpans(lines, CLIENT_TRACE, PORTS)).toEqual({
      counts: { legacy: 0, bridge: 1, stub: 1, other: 0, unresolved: 0 },
      bridgeCalls: [`${DESCRIBE_PATH}?op=describe`],
    });
    expect(classifyClientSpans(lines, DISTRACTOR_TRACE, PORTS).counts).toMatchObject({ legacy: 2, bridge: 0 });
    expect(classifyClientSpans(await fixtureLines('traces.sample.jsonl'), SEAM_TRACE, PORTS)).toEqual({
      counts: { legacy: 0, bridge: 0, stub: 0, other: 0, unresolved: 0 },
      bridgeCalls: [],
    });
  });

  it('throws on a malformed line that names the trace', () => {
    expect(() => classifyClientSpans([`{"traceId":"${CLIENT_TRACE}"`], CLIENT_TRACE, PORTS)).toThrow(SyntaxError);
  });
});

describe('trace export location', () => {
  it('places the export at otel/traces.jsonl under OPT2_STATE_DIR', () => {
    expect(tracesPath({ OPT2_STATE_DIR: stateRoot })).toBe(path.join(stateRoot, 'otel', 'traces.jsonl'));
  });

  it('reads the four fixture lines back from a state directory copy', async () => {
    await fs.mkdir(path.dirname(tracesPath(env)), { recursive: true });
    await fs.copyFile(fixtureUrl('traces.sample.jsonl'), tracesPath(env));

    const lines = [...readTraceLines(env)];

    expect(lines).toHaveLength(4);
    expect(lines).toEqual(await fixtureLines('traces.sample.jsonl'));
  });
});

describe('mintTraceparent', () => {
  it('mints distinct sampled W3C traceparents with non-zero ids', () => {
    const first = mintTraceparent();
    const second = mintTraceparent();

    for (const minted of [first, second]) {
      const [, traceId, parentId] = minted.traceparent.split('-');
      expect(minted.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(traceId).toBe(minted.traceId);
      expect(traceId).not.toMatch(/^0+$/);
      expect(parentId).not.toMatch(/^0+$/);
    }
    expect(second.traceparent).not.toBe(first.traceparent);
    expect(second.traceId).not.toBe(first.traceId);
  });
});

describe('validateLogLines', () => {
  it('checks every fixture line and keeps the two invalid ones with their failing fields', async () => {
    const lines = await fixtureLines('log-lines.sample.jsonl');

    expect(validateLogLines(lines)).toEqual({
      schema: LOG_SCHEMA,
      linesChecked: 5,
      invalid: 2,
      invalidSamples: [
        { source: null, line: lines[3], errors: [expect.stringMatching(/^\/ .*'severity'/)] },
        { source: null, line: lines[4], errors: [expect.stringMatching(/^\/latencyMs /)] },
      ],
    });
  });

  it('names the log-record.v1 contract as its schema', async () => {
    const summary = validateLogLines([]);
    const contract = JSON.parse(await fs.readFile(repoPath(summary.schema), 'utf8')) as { $id: string };

    expect(summary).toEqual({ schema: LOG_SCHEMA, linesChecked: 0, invalid: 0, invalidSamples: [] });
    expect(contract.$id).toBe('urn:opt2:platform:log-record:v1');
  });

  it.each([
    ['a short', 'not json'],
    ['an over-long', `{${'x'.repeat(600)}`],
  ])('counts %s non-JSON line as invalid, skipping blank lines', (_label, line) => {
    expect(validateLogLines([line, '', '   '])).toEqual({
      schema: LOG_SCHEMA,
      linesChecked: 1,
      invalid: 1,
      invalidSamples: [{ source: null, line: line.slice(0, 500), errors: ['not JSON'] }],
    });
  });
});

describe('readCapturedLogLines', () => {
  it('attributes invalid fixture log lines to the package whose up.json log holds them', async () => {
    await fs.copyFile(fixtureUrl('log-lines.sample.jsonl'), path.join(stateRoot, 'people.log'));
    await fs.writeFile(
      path.join(stateRoot, 'up.json'),
      JSON.stringify({ processes: { people: { pid: 4112, cwd: stateRoot, command: 'node dist/main.js', log: 'people.log' } } }),
    );

    const summary = validateLogLines(readCapturedLogLines({ env, packages: ['people'] }));

    expect(summary).toMatchObject({ linesChecked: 5, invalid: 2 });
    expect(summary.invalidSamples.map((sample) => sample.source)).toEqual(['people', 'people']);
  });

  it('reads only the lines each package logged after capturedLogOffsets, and counts an absent log as empty', async () => {
    await fs.writeFile(path.join(stateRoot, 'people.log'), 'before-1\nbefore-2\n');
    await fs.writeFile(
      path.join(stateRoot, 'up.json'),
      JSON.stringify({
        processes: {
          people: { pid: 4112, cwd: stateRoot, command: 'node dist/main.js', log: 'people.log' },
          gateway: { pid: 4101, cwd: stateRoot, command: 'node dist/main.js', log: 'gateway.log' },
        },
      }),
    );

    const fromOffsets = capturedLogOffsets({ env, packages: ['people', 'gateway'] });
    await fs.appendFile(path.join(stateRoot, 'people.log'), 'after-1\n');
    await fs.writeFile(path.join(stateRoot, 'gateway.log'), 'after-2\n');

    expect(fromOffsets).toEqual({ people: 18, gateway: 0 });
    expect([...readCapturedLogLines({ env, packages: ['people', 'gateway'], fromOffsets })]).toEqual([
      { source: 'people', line: 'after-1' },
      { source: 'gateway', line: 'after-2' },
    ]);
    expect([...readCapturedLogLines({ env, packages: ['people'] })].map((entry) => entry.line)).toEqual([
      'before-1',
      'before-2',
      'after-1',
    ]);
  });
});

describe('observability report shape', () => {
  it('yields trace and logs blocks keyed like the committed report', async () => {
    const committed = JSON.parse(
      await fs.readFile(repoPath('opt2', 'reports', 'observability.json'), 'utf8'),
    ) as CommittedReport;
    const { trace } = findSeamTrace(await fixtureLines('traces.sample.jsonl'));
    const logs = validateLogLines(await fixtureLines('log-lines.sample.jsonl'));
    const [committedSpan] = committed.trace.requiredSpans;

    expect(sortedKeys(trace)).toEqual(sortedKeys(committed.trace));
    expect(sortedKeys(trace.requiredSpans[0] ?? {})).toEqual(
      committedSpan === undefined ? ['found', 'name', 'parentSpanId', 'service', 'spanId'] : sortedKeys(committedSpan),
    );
    expect(sortedKeys(logs)).toEqual(sortedKeys(committed.logs));
    expect(logs.schema).toBe(committed.logs.schema);
  });
});
