import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoPath } from '../../src/lib/paths.js';

/** Physical checkout root, as common.sh resolves REPO with `pwd -P`. */
const REPO = realpathSync(repoPath());
const CONFIG = path.join(REPO, 'harness', 'repro', 'otelcol-config.yaml');
const ENDPOINT_FLAG = '--set=receivers::otlp::protocols::http::endpoint=';
/** Sources the real libraries, points the collector port at $1 and runs ensure_otelcol. */
const ENSURE =
  'source "$0/harness/repro/lib/common.sh"; source "$0/harness/repro/lib/processes.sh"; OPT2_TOOL_PORT_OTLP_HTTP=$1; ensure_otelcol';
/** Listens on the host:port of the receiver endpoint flag. */
const LISTEN_JS = [
  `const arg = process.argv.find((a) => a.startsWith("${ENDPOINT_FLAG}"));`,
  'const endpoint = arg.slice(arg.lastIndexOf("=") + 1);',
  'const colon = endpoint.lastIndexOf(":");',
  'require("node:net").createServer().listen(Number(endpoint.slice(colon + 1)), endpoint.slice(0, colon));',
].join(' ');
/** Stand-in otelcol-contrib: logs its pid, then execs node under its own name, keeping its argv and environment. */
const FAKE_OTELCOL = [
  '#!/usr/bin/env bash',
  'printf "%s\\n" "$$" >>"${0%/*}/starts.log"',
  `exec -a "$0" node -e '${LISTEN_JS}' -- "$@"`,
  '',
].join('\n');
const RUN_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 60_000;
const HAS_SS = spawnSync('ss', ['-V'], { stdio: 'ignore' }).status === 0;

interface StateDirs {
  state: string;
  pristine: string;
}

interface ToolingEntry {
  state: string;
  pid: number;
  recordedAt: string;
}

const tempDirs: string[] = [];
const binDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const bin of binDirs.splice(0)) killFakes(bin);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opt2-otelcol-test-'));
  tempDirs.push(dir);
  return dir;
}

/** A PATH directory holding the fake otelcol-contrib; every process it starts is killed after the test. */
function fakeBin(): string {
  const bin = path.join(tempDir(), 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'otelcol-contrib'), FAKE_OTELCOL);
  chmodSync(path.join(bin, 'otelcol-contrib'), 0o755);
  binDirs.push(bin);
  return bin;
}

/** Absolute OPT2_STATE_DIR and OPT2_PRISTINE_DIR paths outside the checkout, not yet created. */
function stateDirs(): StateDirs {
  const root = tempDir();
  return { state: path.join(root, 'state'), pristine: path.join(root, 'pristine') };
}

/** The pids the fake otelcol-contrib in <bin> has logged, in start order. */
function fakeStarts(bin: string): number[] {
  const log = path.join(bin, 'starts.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(Number) : [];
}

/** The argv of <pid> from /proc; empty once it has exited. */
function cmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, -1);
  } catch {
    return [];
  }
}

/** SIGKILLs each logged fake that still runs as <bin>/otelcol-contrib, so a reused pid is never signalled. */
function killFakes(bin: string): void {
  for (const pid of fakeStarts(bin)) {
    if (cmdline(pid)[0] !== path.join(bin, 'otelcol-contrib')) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
}

/** A loopback port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The distinct pids ss reports listening on TCP <port>. */
function listenerPids(port: number): number[] {
  const out = execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
  return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])))];
}

/** The otelcol entry of <state>/tooling.json; undefined when the file or the entry is absent. */
function toolingEntry(state: string): ToolingEntry | undefined {
  const file = path.join(state, 'tooling.json');
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, 'utf8')) as Record<string, ToolingEntry>).otelcol;
}

/** Runs ensure_otelcol from the real libraries with the collector port at <port> and the fake first on PATH. */
function ensureOtelcol(port: number, bin: string, dirs: StateDirs): { status: number | null; stderr: string } {
  const run = spawnSync('bash', ['-c', ENSURE, REPO, String(port)], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: path.dirname(dirs.state),
      OPT2_STATE_DIR: dirs.state,
      OPT2_PRISTINE_DIR: dirs.pristine,
    },
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { status: run.status, stderr: run.stderr };
}

/** Runs ensure_otelcol on <port> and returns the started entry, failing the test unless it exits 0. */
function startCollector(port: number, bin: string, dirs: StateDirs): ToolingEntry {
  const run = ensureOtelcol(port, bin, dirs);
  expect(run.status, run.stderr).toBe(0);
  const entry = toolingEntry(dirs.state);
  expect(entry).toMatchObject({ state: 'started', pid: expect.any(Number) });
  return entry as ToolingEntry;
}

/** Holds <port> with a plain node server the test spawns; resolves to its pid once it listens. */
async function holdWithForeignListener(port: number): Promise<number> {
  const child = spawn(
    process.execPath,
    ['-e', 'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1", () => console.log("ready"))', String(port)],
    { stdio: ['ignore', 'pipe', 'inherit'], timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve());
    child.once('exit', (code, signal) => reject(new Error(`foreign listener exited (${code ?? signal})`)));
  });
  return child.pid as number;
}

/** Holds <port> with the repro collector started for a different OPT2_STATE_DIR; resolves to its pid. */
async function holdWithOtherStateCollector(port: number): Promise<number> {
  return startCollector(port, fakeBin(), stateDirs()).pid;
}

describe.skipIf(!HAS_SS)('ensure_otelcol (harness/repro/lib/processes.sh)', () => {
  it(
    'starts otelcol-contrib with the repro config on a free port and records it started',
    async () => {
      const port = await freePort();
      const bin = fakeBin();
      const dirs = stateDirs();

      const entry = startCollector(port, bin, dirs);

      expect(listenerPids(port)).toEqual([entry.pid]);
      expect(fakeStarts(bin)).toEqual([entry.pid]);
      expect(statSync(path.join(dirs.state, 'otel')).isDirectory()).toBe(true);
      const argv = cmdline(entry.pid);
      expect(argv).toContain('--config');
      expect(argv[argv.indexOf('--config') + 1]).toBe(CONFIG);
      expect(argv).toContain(`${ENDPOINT_FLAG}127.0.0.1:${port}`);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reuses its own running collector without starting a second one, keeping the started entry',
    async () => {
      const port = await freePort();
      const bin = fakeBin();
      const dirs = stateDirs();
      const entry = startCollector(port, bin, dirs);

      const again = ensureOtelcol(port, bin, dirs);

      expect(again.status, again.stderr).toBe(0);
      expect(toolingEntry(dirs.state)).toEqual(entry);
      expect(fakeStarts(bin)).toEqual([entry.pid]);
      expect(listenerPids(port)).toEqual([entry.pid]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<[string, (port: number) => Promise<number>]>([
    ['a foreign listener', holdWithForeignListener],
    ['the repro collector of a different OPT2_STATE_DIR', holdWithOtherStateCollector],
  ])(
    'exits 1 naming the port and pid when %s holds the port, starting and recording nothing',
    async (_label, hold) => {
      const port = await freePort();
      const holder = await hold(port);
      const bin = fakeBin();
      const dirs = stateDirs();

      const run = ensureOtelcol(port, bin, dirs);

      expect(run.status).toBe(1);
      const lines = run.stderr.trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`opt2: port ${port} (OPT2_TOOL_PORT_OTLP_HTTP) is held by pid ${holder} (`);
      expect(lines[0]).toContain(`${dirs.state}/otel/traces.jsonl`);
      expect(toolingEntry(dirs.state)).toBeUndefined();
      expect(fakeStarts(bin)).toEqual([]);
      expect(listenerPids(port)).toEqual([holder]);
    },
    TEST_TIMEOUT_MS,
  );
});
