import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findSeamTrace,
  readCapturedLogLines,
  readTraceLines,
  traceExportOffset,
  tracesPath,
  validateLogLines,
} from '../../src/events/traces.js';
import type { CapturedLogLine } from '../../src/events/traces.js';
import type { EnvLike } from '../../src/lib/paths.js';
import { upStatePath, writeUpState } from '../../src/repro/up-state.js';

const CHUNK = 64 * 1024;
const TARGET_TRACE = '0af7651916cd43dd8448eb211c80319c';
const ADMIN_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const ARCHIVE_PATH = '/legacy-fixtures/cfml/api.cfm/people/persons/5E2C1A90-3B7D-4F21-8C6A4D9E0B1F2A37/archive';
const FIXTURE_GATEWAY_START = '"startTimeUnixNano":"1782810000000000000"';
const ONE_SHOT_MESSAGE =
  'findSeamTrace without opts.traceId reads its lines twice: pass an array or the result of readTraceLines, or set opts.traceId';
const HARNESS_ROOT = fileURLToPath(new URL('../..', import.meta.url));

let stateDir: string;
let env: EnvLike;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-trace-stream-'));
  env = { OPT2_STATE_DIR: stateDir };
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

async function fixtureLines(name: string): Promise<string[]> {
  return (await fs.readFile(new URL(`../fixtures/observability/${name}`, import.meta.url), 'utf8')).split('\n');
}

async function writeExport(content: string): Promise<void> {
  const file = tracesPath(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function* oneShot(lines: readonly string[]): Generator<string> {
  yield* lines;
}

/** Re-iterable input yielding `first` on the first iteration read and `later` on every further one. */
function changing(first: readonly string[], later: readonly string[]): Iterable<string> {
  let reads = 0;
  return {
    *[Symbol.iterator]() {
      reads += 1;
      yield* reads === 1 ? first : later;
    },
  };
}

/** The fixture seam trace's lines under another trace id, its gateway span starting at `gatewayStart`. */
function chainCopy(fixture: readonly string[], traceId: string, gatewayStart: bigint): string[] {
  return fixture
    .filter((line) => line.includes(TARGET_TRACE))
    .map((line) =>
      line.replaceAll(TARGET_TRACE, traceId).replace(FIXTURE_GATEWAY_START, `"startTimeUnixNano":"${gatewayStart}"`),
    );
}

/** One export line holding the resource spans of every given line, as a batching collector writes them. */
function batched(...lines: string[]): string {
  return JSON.stringify({
    resourceSpans: lines.flatMap((line) => (JSON.parse(line) as { resourceSpans: unknown[] }).resourceSpans),
  });
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a throw');
}

function distractorTrace(index: number): string {
  return `d${(index + 1).toString(16).padStart(31, '0')}`;
}

/** Script running archive-mode findSeamTrace over lazily regenerated `/admin/` history with the fixture chain halfway. */
function historyScript(tracesModule: string, fixtureFile: string, history: number): string {
  return `import { readFileSync } from 'node:fs';
import { findSeamTrace } from ${JSON.stringify(pathToFileURL(tracesModule).href)};

const fixture = readFileSync(${JSON.stringify(fixtureFile)}, 'utf8').split('\\n');
const history = ${history};

function adminLine(index: number): string {
  const id = (index + 1).toString(16);
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gateway' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'a' + id.padStart(31, '0'),
                spanId: id.padStart(16, '0'),
                name: 'GET',
                kind: 2,
                startTimeUnixNano: String(1782820000000000000n + BigInt(index)),
                attributes: [{ key: 'url.path', value: { stringValue: '/admin/' } }],
              },
            ],
          },
        ],
      },
    ],
  });
}

const lines = {
  *[Symbol.iterator]() {
    for (let index = 0; index < history; index += 1) {
      if (index === history / 2) {
        yield* fixture;
      }
      yield adminLine(index);
    }
  },
};

process.stdout.write(JSON.stringify(findSeamTrace(lines)));
`;
}

function gatewayLine(traceId: string, index: number, urlPath: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gateway' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: `e${(index + 1).toString(16).padStart(15, '0')}`,
                name: 'POST',
                kind: 2,
                startTimeUnixNano: String(1782820000000000000n + BigInt(index)),
                attributes: [{ key: 'url.path', value: { stringValue: urlPath } }],
              },
            ],
          },
        ],
      },
    ],
  });
}

describe('readTraceLines', () => {
  it.each([
    ['a two-byte', 1, 'é'],
    ['a three-byte', 1, '€'],
    ['a three-byte', 2, '€'],
    ['a four-byte', 1, '😀'],
    ['a four-byte', 3, '😀'],
  ])(
    'yields CRLF, over-long and unterminated lines whole, skipping blanks, when %s character has %i byte(s) in chunk one',
    async (_label, before, char) => {
      const head = 'first\r\n\r\n   \n';
      const straddling = `${'x'.repeat(CHUNK - Buffer.byteLength(head) - before)}${char}tail`;
      const long = 'y'.repeat(3 * CHUNK + 17);
      await writeExport(`${head}${straddling}\r\n${long}\n\t\r\nlast`);

      expect([...readTraceLines(env)]).toEqual(['first', straddling, long, 'last']);
    },
  );

  it('streams the file afresh on every iteration', async () => {
    await writeExport('one\ntwo\n');
    const lines = readTraceLines(env);

    expect([...lines]).toEqual(['one', 'two']);
    expect([...lines]).toEqual(['one', 'two']);
    await fs.appendFile(tracesPath(env), 'three\n');
    expect([...lines]).toEqual(['one', 'two', 'three']);
  });

  it('throws naming the export path until the collector writes it, while its offset reads 0 and then its size', async () => {
    const error = thrown(() => readTraceLines(env));

    expect(error.message).toBe(`${tracesPath(env)} does not exist; the OpenTelemetry Collector has exported no traces`);
    expect((error.cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(traceExportOffset(env)).toBe(0);
    await writeExport('line\n');
    expect(traceExportOffset(env)).toBe(5);
  });

  it.each([
    ['traceExportOffset', (blocked: EnvLike) => traceExportOffset(blocked)],
    ['readTraceLines', (blocked: EnvLike) => readTraceLines(blocked)],
  ])('%s propagates a failure other than a missing export', async (_name, call) => {
    const notADirectory = path.join(stateDir, 'state-file');
    await fs.writeFile(notADirectory, '');

    expect((thrown(() => call({ OPT2_STATE_DIR: notADirectory })) as NodeJS.ErrnoException).code).toBe('ENOTDIR');
  });

  it.each([
    ['at a line boundary', 'old-1\nold-2\n', 'new-1\r\nnew-2\n', ['new-1', 'new-2']],
    ['inside a partly flushed line', 'old-1\n{"partial', '-rest"}\nnew-1\n', ['new-1']],
    ['inside a line still unterminated', 'old-1\nold-', '2', []],
    ['inside a line past the first chunk', `${'z'.repeat(CHUNK + 5)}\ncut`, '-off\nnew-1', ['new-1']],
  ])('yields only lines appended after an offset taken %s', async (_label, before, appended, expected) => {
    await writeExport(before);
    const offset = traceExportOffset(env);
    await fs.appendFile(tracesPath(env), appended);

    expect(offset).toBe(Buffer.byteLength(before));
    expect([...readTraceLines(env, { fromOffset: offset })]).toEqual(expected);
  });
});

describe('findSeamTrace', () => {
  it('refuses a one-shot generator without a trace id before reading it, and reads one in a single pass by trace id', async () => {
    const fixture = await fixtureLines('traces.sample.jsonl');
    let pulled = 0;
    function* counted(): Generator<string> {
      for (const line of fixture) {
        pulled += 1;
        yield line;
      }
    }

    const error = thrown(() => findSeamTrace(counted()));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe(ONE_SHOT_MESSAGE);
    expect(pulled).toBe(0);
    expect(findSeamTrace(counted(), { traceId: TARGET_TRACE })).toMatchObject({
      trace: { traceId: TARGET_TRACE, singleTrace: true },
      candidates: 1,
      problems: [],
    });
    expect(pulled).toBe(fixture.length);
  });

  it.each([
    ['an array', async () => fixtureLines('traces.sample.jsonl')],
    [
      'the readTraceLines result',
      async () => {
        await writeExport((await fixtureLines('traces.sample.jsonl')).join('\n'));
        return readTraceLines(env);
      },
    ],
  ])('finds the fixture seam trace without a trace id over %s', async (_label, input) => {
    const result = findSeamTrace(await input());

    expect(result.trace.traceId).toBe(TARGET_TRACE);
    expect(result.trace.singleTrace).toBe(true);
    expect(result.trace.requiredSpans.every((span) => span.found)).toBe(true);
    expect(result.candidates).toBe(1);
    expect(result.problems).toEqual([]);
  });

  it('keeps a candidate open until its last line, past other traffic and another candidate that closes first', async () => {
    const [gateway = '', admin = '', people = '', consumer = ''] = await fixtureLines('traces.sample.jsonl');
    const other = distractorTrace(0);
    const traffic = (from: number): string[] =>
      Array.from({ length: 200 }, (_, i) => gatewayLine(distractorTrace(from + i), from + i, '/admin/'));
    const lines = [gateway, ...traffic(1), gatewayLine(other, 0, ARCHIVE_PATH), people, admin, ...traffic(201), consumer];

    const result = findSeamTrace(lines);

    expect(result).toMatchObject({ trace: { traceId: TARGET_TRACE, singleTrace: true }, candidates: 2, problems: [] });
    expect(result.trace.requiredSpans.every((span) => span.found)).toBe(true);
  });

  it.each<[string, (older: string[], newer: string[]) => string[]]>([
    ['the older first', (older, newer) => [...older, ...newer]],
    ['the newer first', (older, newer) => [...newer, ...older]],
    ['both batched into the same lines', (older, newer) => older.map((line, i) => batched(line, newer[i] ?? ''))],
  ])('chooses the complete archive trace with the later gateway start, with %s', async (_label, arrange) => {
    const fixture = await fixtureLines('traces.sample.jsonl');
    const older = chainCopy(fixture, distractorTrace(1), 1782810000000000000n);
    const newer = chainCopy(fixture, distractorTrace(2), 1782810060000000000n);

    const result = findSeamTrace(arrange(older, newer));

    expect(result).toMatchObject({ trace: { traceId: distractorTrace(2), singleTrace: true }, candidates: 2, problems: [] });
  });

  it.each<[string, (fixture: string[]) => string[], { traceId: string | null; singleTrace: boolean }, number]>([
    ['grows', (fixture) => [...fixture, 'not json'], { traceId: TARGET_TRACE, singleTrace: true }, 1],
    ['shrinks', (fixture) => fixture.slice(0, 3), { traceId: TARGET_TRACE, singleTrace: false }, 1],
    ['loses the seam trace', (fixture) => fixture.map(() => fixture[1] ?? ''), { traceId: null, singleTrace: false }, 0],
  ])(
    'keeps to the line count and candidates of the first pass when the input %s between passes',
    async (_label, rewrite, trace, candidates) => {
      const fixture = await fixtureLines('traces.sample.jsonl');

      const result = findSeamTrace(changing(fixture, rewrite(fixture)));

      expect(result).toMatchObject({ trace, candidates });
      expect(result.problems.filter((problem) => problem.startsWith('malformed'))).toEqual([]);
    },
  );

  it('finds the seam trace without a trace id amid 250,000 unrelated gateway traces under a 128 MB heap', async () => {
    const script = path.join(stateDir, 'history.mts');
    await fs.writeFile(
      script,
      historyScript(
        path.join(HARNESS_ROOT, 'src/events/traces.ts'),
        path.join(HARNESS_ROOT, 'test/fixtures/observability/traces.sample.jsonl'),
        250_000,
      ),
    );

    const run = spawnSync(
      '/bin/sh',
      ['-c', 'ulimit -c 0 && exec "$0" "$@"', process.execPath, '--max-old-space-size=128', '--import', 'tsx', script],
      { cwd: HARNESS_ROOT, encoding: 'utf8' },
    );

    expect(run.signal, run.stderr).toBeNull();
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      trace: { traceId: TARGET_TRACE, singleTrace: true },
      candidates: 1,
      problems: [],
    });
  });

  it('finds the requested trace by id amid many distractor archive traces, considering only that trace', async () => {
    const distractors = Array.from({ length: 300 }, (_, i) => gatewayLine(distractorTrace(i), i, ARCHIVE_PATH));
    const lines = [
      ...distractors.slice(0, 150),
      ...(await fixtureLines('traces.sample.jsonl')),
      ...distractors.slice(150),
    ];

    const byId = findSeamTrace(oneShot(lines), { traceId: TARGET_TRACE });
    const byPath = findSeamTrace(lines);

    expect(byId).toMatchObject({ trace: { traceId: TARGET_TRACE, singleTrace: true }, candidates: 1, problems: [] });
    expect(byPath).toMatchObject({ trace: { traceId: TARGET_TRACE, singleTrace: true }, candidates: 301, problems: [] });
  });

  it.each([
    [20, 20, []],
    [21, 20, ['1 further malformed OTLP JSON lines not listed']],
    [25, 20, ['5 further malformed OTLP JSON lines not listed']],
  ])(
    'lists %i malformed lines as %i by 1-based number, then a summary, ahead of other problems',
    (bad, listed, summary) => {
      const result = findSeamTrace(['', ...Array.from({ length: bad }, () => 'not json')]);
      const onLine = (line: number): unknown => expect.stringMatching(new RegExp(`^malformed OTLP JSON on line ${line}: `));

      expect(result.problems).toEqual([
        ...Array.from({ length: listed }, (_, i) => onLine(i + 2)),
        ...summary,
        'no seam trace found',
      ]);
    },
  );

  it.each([
    [0, 1, false],
    [19, 20, false],
    [20, 20, true],
    [45, 20, true],
  ])(
    'reports %i further gateway traces as %i split samples in first-seen order, with an overflow problem: %s',
    async (extra, listed, overflow) => {
      const [targetGateway, ...rest] = await fixtureLines('traces.sample.jsonl');
      expect(targetGateway).toContain(TARGET_TRACE);
      const others = Array.from({ length: extra }, (_, i) => gatewayLine(distractorTrace(i), i, '/admin/'));

      const result = findSeamTrace(oneShot([...rest, ...others]), { traceId: TARGET_TRACE });
      const splits = result.problems.filter((problem) => problem.startsWith('split across'));

      expect(result.trace.traceId).toBe(TARGET_TRACE);
      expect(result.trace.singleTrace).toBe(false);
      expect(result.trace.requiredSpans[0]?.found).toBe(false);
      expect(splits).toEqual([
        ...[ADMIN_TRACE, ...Array.from({ length: extra }, (_, i) => distractorTrace(i))]
          .slice(0, listed)
          .map((traceId) => `split across traces: ${traceId}`),
        ...(overflow ? ['split across further traces not listed (more than 20)'] : []),
      ]);
      expect(result.problems.slice(-splits.length)).toEqual(splits);
    },
  );
});

describe('readCapturedLogLines', () => {
  it('streams multi-chunk logs of the listed packages in order, and every line is validated', async () => {
    const [valid = ''] = await fixtureLines('log-lines.sample.jsonl');
    const gatewayLines = Array.from({ length: 300 }, (_, i) => (i % 60 === 0 ? `not json ${i}` : valid));
    const peopleLines = [
      ...Array.from({ length: 25 }, (_, i) => `{"severity":"INFO","requestId":"bad-${i}"}`),
      ...Array.from({ length: 200 }, () => valid),
    ];
    const gatewayLog = path.join(stateDir, 'gateway.out');
    const peopleCwd = path.join(stateDir, 'people');
    await fs.writeFile(gatewayLog, `${gatewayLines.join('\r\n')}\r\n`);
    await fs.mkdir(path.join(peopleCwd, 'logs'), { recursive: true });
    await fs.writeFile(path.join(peopleCwd, 'logs', 'people.out'), peopleLines.join('\n\n'));
    expect((await fs.stat(gatewayLog)).size).toBeGreaterThan(CHUNK);
    expect((await fs.stat(path.join(peopleCwd, 'logs', 'people.out'))).size).toBeGreaterThan(CHUNK);
    writeUpState(
      {
        processes: {
          gateway: { pid: 4101, cwd: stateDir, command: ['node', 'dist/main.js'], log: gatewayLog },
          people: { pid: 4112, cwd: peopleCwd, command: 'node dist/main.js', log: 'logs/people.out' },
        },
      },
      { env },
    );
    const expected: CapturedLogLine[] = [
      ...gatewayLines.map((line) => ({ source: 'gateway', line })),
      ...peopleLines.map((line) => ({ source: 'people', line })),
    ];

    const lines = readCapturedLogLines({ env, packages: ['gateway', 'people'] });
    const summary = validateLogLines(lines);

    expect([...lines]).toEqual(expected);
    expect([...lines]).toEqual(expected);
    expect(summary.linesChecked).toBe(525);
    expect(summary.invalid).toBe(30);
    expect(summary.invalidSamples).toHaveLength(20);
    expect(summary.invalidSamples.map((sample) => sample.source)).toEqual([
      ...Array.from({ length: 5 }, () => 'gateway'),
      ...Array.from({ length: 15 }, () => 'people'),
    ]);
  });

  it('throws at call time naming the package whose process recorded no log file', () => {
    writeUpState(
      {
        processes: {
          gateway: { pid: 4101, cwd: stateDir, command: 'node dist/main.js', log: 'gateway.out' },
          people: { pid: 4112, cwd: stateDir, command: 'node dist/main.js' },
        },
      },
      { env },
    );

    expect(() => readCapturedLogLines({ env, packages: ['gateway', 'people'] })).toThrow(
      `${upStatePath(env)} records no log file for package people`,
    );
  });
});
