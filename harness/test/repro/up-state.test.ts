import { renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/lib/cli.js';
import { REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';
import {
  UpStateMissingError,
  main,
  mergeUpState,
  readUpState,
  redactUpState,
  upProcessSchema,
  upStatePath,
  upStateSchema,
  writeUpState,
  type UpProcessEntry,
  type UpState,
  type UpStatePatch,
} from '../../src/repro/up-state.js';

// The unit writes through the synchronous `node:fs` API; wrapping renameSync lets a test observe the atomic swap.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const COMMAND = 'repro:up-state';
const USAGE_HEAD = 'usage: tsx src/repro/up-state.ts write';
const WIN32 = process.platform === 'win32';

let stateDir: string;
let env: EnvLike;
let file: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-upstate-'));
  env = { OPT2_STATE_DIR: stateDir };
  file = path.join(stateDir, 'up.json');
  // Clears calls and any one-off implementation a failed test left queued; the pass-through stays.
  vi.mocked(renameSync).mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

const GATEWAY: UpProcessEntry = {
  pid: 4101,
  port: 8100,
  cwd: '/x/gateway',
  command: ['node', 'dist/main.js'],
  env: { PORT: '8100' },
  log: '/x/gateway.out',
};

const PEOPLE: UpProcessEntry = { pid: 4112, port: 8112, cwd: '/x/services/people', command: 'node dist/main.js' };

/** A full up.json as up.sh records it, with one key the schema does not name. */
function sampleState(): UpState {
  return {
    processes: { gateway: structuredClone(GATEWAY), people: structuredClone(PEOPLE) },
    ports: { gateway: 8100, people: 8112 },
    snapshot: 'S0',
    fixtures: { available: true },
    startedAt: '2026-06-30T08:00:00.000Z',
    harnessNote: 'kept as written',
  };
}

/**
 * What migration's fault process control parses (`upJsonSchema`, `UpProcessEntry`): no port, env or log.
 * Mirrored, not imported: harness depends on no other package's `src`.
 */
const processControlShaped = {
  processes: {
    people: { pid: 4112, cwd: '/x/services/people', command: 'node dist/main.js' },
    timesheets: { pid: 4118, cwd: '/x/services/timesheets', command: ['node', 'dist/main.js'] },
  },
  restartedBy: 'migration-faults',
};

/** Process-control's minimal reading of up.json: each entry's pid, cwd and command. */
function readAsProcessControl(text: string): Record<string, Pick<UpProcessEntry, 'pid' | 'cwd' | 'command'>> {
  const doc = JSON.parse(text) as { processes: Record<string, Record<string, unknown>> };
  return Object.fromEntries(
    Object.entries(doc.processes).map(([name, entry]) => {
      const { pid, cwd, command } = entry;
      expect(Number.isInteger(pid) && (pid as number) > 0).toBe(true);
      expect(typeof cwd === 'string' && path.isAbsolute(cwd)).toBe(true);
      const commandOk =
        typeof command === 'string' || (Array.isArray(command) && command.every((arg) => typeof arg === 'string'));
      expect(commandOk).toBe(true);
      return [name, { pid, cwd, command } as Pick<UpProcessEntry, 'pid' | 'cwd' | 'command'>];
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysDeep);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeysDeep(child)]));
}

function expectKeysSortedDeep(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectKeysSortedDeep);
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    expect(keys).toEqual([...keys].sort());
    Object.values(value).forEach(expectKeysSortedDeep);
  }
}

/** The error `call` throws; fails the test when it returns. */
function thrown(call: () => unknown): Error & { code?: string } {
  try {
    call();
  } catch (err) {
    return err as Error & { code?: string };
  }
  return expect.fail('expected the call to throw');
}

async function modeOf(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777;
}

describe('upStatePath', () => {
  it('is up.json in OPT2_STATE_DIR', () => {
    expect(upStatePath({ OPT2_STATE_DIR: stateDir })).toBe(path.join(stateDir, 'up.json'));
  });

  it('rejects a state directory inside the checkout', () => {
    expect(() => upStatePath({ OPT2_STATE_DIR: path.join(REPO_ROOT, 'harness') })).toThrow(
      /OPT2_STATE_DIR must be outside the repository checkout/,
    );
  });
});

describe('readUpState', () => {
  it('throws UpStateMissingError naming the file when up.json is absent', () => {
    const err = thrown(() => readUpState({ env }));
    expect(err).toBeInstanceOf(UpStateMissingError);
    expect(err.name).toBe('UpStateMissingError');
    expect((err as UpStateMissingError).path).toBe(file);
    expect(err.message).toBe(`${file} does not exist; run harness/repro/up.sh first`);
    expect((err.cause as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it.each<[string, string, RegExp]>([
    ['text that is not JSON', '{', /up\.json: is not valid JSON: /],
    ['JSON without processes', '{}', /up\.json: does not match the up\.json schema:\n/],
    [
      'a process entry with pid 0',
      JSON.stringify({ processes: { gateway: { pid: 0, cwd: '/x', command: 'node' } } }),
      /does not match the up\.json schema:[\s\S]*pid/,
    ],
  ])('rejects %s with an error naming the file', async (_label, text, message) => {
    await fs.writeFile(file, text);
    const err = thrown(() => readUpState({ env }));
    expect(err).not.toBeInstanceOf(UpStateMissingError);
    expect(err.message).toMatch(message);
    expect(err.message.startsWith(file)).toBe(true);
  });

  it('rethrows read errors other than a missing file', async () => {
    await fs.mkdir(file);
    const err = thrown(() => readUpState({ env }));
    expect(err).not.toBeInstanceOf(UpStateMissingError);
    expect(err.code).toBe('EISDIR');
  });

  it('reads an explicit path instead of the state directory', async () => {
    const other = path.join(stateDir, 'elsewhere.json');
    await fs.writeFile(other, JSON.stringify(processControlShaped));
    expect(readUpState({ path: other, env: { OPT2_STATE_DIR: path.join(stateDir, 'unused') } })).toEqual(
      processControlShaped,
    );
  });
});

describe('writeUpState', () => {
  it.skipIf(WIN32)('creates up.json with mode 0600 and leaves no temporary sibling', async () => {
    const written = writeUpState(sampleState(), { env });
    expect(written).toEqual({ path: file, state: sampleState() });
    expect(await modeOf(file)).toBe(0o600);
    expect(await fs.readdir(stateDir)).toEqual(['up.json']);
  });

  it('writes a temporary sibling first and renames it onto up.json, leaving the old file whole until then', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    writeUpState(sampleState(), { env });
    const before = await fs.readFile(file, 'utf8');
    const seen: { from: string; to: string; destination: string; source: string }[] = [];
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      seen.push({
        from: String(from),
        to: String(to),
        destination: actualFs.readFileSync(to, 'utf8'),
        source: actualFs.readFileSync(from, 'utf8'),
      });
      actualFs.renameSync(from, to);
    });

    const { state } = writeUpState({ snapshot: 'S1' }, { env });

    expect(seen).toHaveLength(1);
    const [swap] = seen;
    expect(swap?.to).toBe(file);
    expect(swap?.from).not.toBe(file);
    expect(path.dirname(swap?.from ?? '')).toBe(stateDir);
    expect(path.basename(swap?.from ?? '')).toMatch(/^up\.json\..+\.tmp$/);
    expect(swap?.destination).toBe(before);
    expect(JSON.parse(swap?.source ?? '')).toEqual(state);
    expect(await fs.readFile(file, 'utf8')).toBe(swap?.source);
    expect(await fs.readdir(stateDir)).toEqual(['up.json']);
  });

  it('removes the temporary file and keeps the previous up.json when the rename fails', async () => {
    writeUpState(sampleState(), { env });
    const before = await fs.readFile(file, 'utf8');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('rename refused'), { code: 'EXDEV' });
    });

    expect(thrown(() => writeUpState({ snapshot: 'S1' }, { env })).code).toBe('EXDEV');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readdir(stateDir)).toEqual(['up.json']);
  });

  it.skipIf(WIN32)('replaces a world-readable up.json left by another writer with a 0600 file', async () => {
    await fs.writeFile(file, `${JSON.stringify(sampleState(), null, 2)}\n`);
    await fs.chmod(file, 0o644);
    const inodeBefore = (await fs.stat(file)).ino;

    writeUpState({ snapshot: 'S1' }, { env });

    expect(await modeOf(file)).toBe(0o600);
    expect((await fs.stat(file)).ino).not.toBe(inodeBefore);
    expect(readUpState({ env })).toEqual({ ...sampleState(), snapshot: 'S1' });
  });

  it.skipIf(WIN32)('replaces a stale temporary file of the same pid instead of failing on it', async () => {
    const stale = `${file}.${process.pid}.tmp`;
    await fs.writeFile(stale, 'partial');
    await fs.chmod(stale, 0o644);

    writeUpState(sampleState(), { env });

    expect(await modeOf(file)).toBe(0o600);
    expect(readUpState({ env })).toEqual(sampleState());
    expect(await fs.readdir(stateDir)).toEqual(['up.json']);
  });

  it.skipIf(WIN32)('creates a missing state directory with mode 0700', async () => {
    const nested = path.join(stateDir, 'nested', 'state');
    const written = writeUpState(sampleState(), { env: { OPT2_STATE_DIR: nested } });
    expect(written.path).toBe(path.join(nested, 'up.json'));
    expect(await modeOf(nested)).toBe(0o700);
    expect(await modeOf(written.path)).toBe(0o600);
  });

  it('writes an explicit path instead of the state directory', async () => {
    const other = path.join(stateDir, 'custom', 'up-copy.json');
    expect(writeUpState(sampleState(), { path: other, env }).path).toBe(other);
    expect(readUpState({ path: other })).toEqual(sampleState());
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips through readUpState, keeping keys the schema does not name', () => {
    writeUpState(sampleState(), { env });
    const read = readUpState({ env });
    expect(read).toEqual(sampleState());
    expect(read.harnessNote).toBe('kept as written');
  });

  it('writes key-sorted, two-space JSON ending in one newline, byte-identical whatever the key order', async () => {
    writeUpState(sampleState(), { env });
    const first = await fs.readFile(file, 'utf8');
    writeUpState(sampleState(), { env });
    const rewritten = await fs.readFile(file, 'utf8');
    const other = path.join(stateDir, 'reordered.json');
    writeUpState(reverseKeysDeep(sampleState()) as UpStatePatch, { path: other });

    expect(rewritten).toBe(first);
    expect(await fs.readFile(other, 'utf8')).toBe(first);
    expect(first).toBe(`${JSON.stringify(JSON.parse(first), null, 2)}\n`);
    expectKeysSortedDeep(JSON.parse(first));
  });

  it('merges into the existing file: a second write adds a process and keeps the first', () => {
    writeUpState({ processes: { gateway: GATEWAY } }, { env });
    const { state } = writeUpState(
      { processes: { web: { pid: 4102, port: 8101, cwd: '/x/web', command: 'npm run start' } } },
      { env },
    );
    expect(Object.keys(state.processes).sort()).toEqual(['gateway', 'web']);
    expect(state.processes.gateway).toEqual(GATEWAY);
    expect(readUpState({ env })).toEqual(state);
  });

  it('rejects an invalid patch without touching up.json', async () => {
    writeUpState(sampleState(), { env });
    const before = await fs.readFile(file, 'utf8');
    const err = thrown(() =>
      writeUpState({ processes: { web: { pid: 4102, cwd: 'relative/web', command: 'npm run start' } } }, { env }),
    );
    expect(err.message).toMatch(/must be an absolute path/);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readdir(stateDir)).toEqual(['up.json']);
  });

  it('refuses to overwrite an up.json it cannot parse', async () => {
    await fs.writeFile(file, '{');
    expect(thrown(() => writeUpState({ snapshot: 'S1' }, { env })).message).toMatch(/is not valid JSON/);
    expect(await fs.readFile(file, 'utf8')).toBe('{');
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });
});

describe('mergeUpState', () => {
  it('replaces a process entry whole by name and keeps the other entries and unpatched top-level fields', () => {
    const replacement: UpProcessEntry = { pid: 5000, cwd: '/y', command: 'node x' };
    const merged = mergeUpState(sampleState(), { processes: { gateway: replacement } });
    expect(merged).toEqual({ ...sampleState(), processes: { gateway: replacement, people: PEOPLE } });
    expect(Object.keys(merged.processes.gateway ?? {}).sort()).toEqual(['command', 'cwd', 'pid']);
  });

  it('sets defined top-level patch fields, skips undefined ones and never mutates its inputs', () => {
    const current = deepFreeze(sampleState());
    const patch = deepFreeze<UpStatePatch>({
      snapshot: 'S1',
      fixtures: { available: false, reason: 'CREATE SCHEMA denied' },
      startedAt: undefined,
      processes: { web: { pid: 4102, cwd: '/x/web', command: ['npm', 'run', 'start'] } },
    });

    const merged = mergeUpState(current, patch);

    expect(merged.snapshot).toBe('S1');
    expect(merged.fixtures).toEqual({ available: false, reason: 'CREATE SCHEMA denied' });
    expect(merged.startedAt).toBe(current.startedAt);
    expect(Object.keys(merged.processes).sort()).toEqual(['gateway', 'people', 'web']);
    expect(current).toEqual(sampleState());
    expect(patch.processes).toEqual({ web: { pid: 4102, cwd: '/x/web', command: ['npm', 'run', 'start'] } });
    expect(merged).not.toBe(current);
    expect(merged.processes).not.toBe(current.processes);
  });

  it('starts from an empty process map when there is no current state', () => {
    expect(mergeUpState(undefined, { snapshot: 'S0' })).toEqual({ processes: {}, snapshot: 'S0' });
  });

  it('validates the merged state', () => {
    expect(() => mergeUpState(sampleState(), { ports: { gateway: 70_000 } })).toThrow();
  });
});


describe('schemas shared with the fault process control', () => {
  it('upStateSchema accepts the process-control shape: string and argv commands, no port, env or log', () => {
    expect(upStateSchema.parse(processControlShaped)).toEqual(processControlShaped);
  });

  it('upProcessSchema keeps entry keys it does not name', () => {
    const entry = { ...PEOPLE, restarts: 2 };
    expect(upProcessSchema.parse(entry)).toEqual(entry);
  });

  it.each<[string, Record<string, unknown>]>([
    ['no pid', { cwd: '/x/gateway', command: 'node' }],
    ['no cwd', { pid: 4101, command: 'node' }],
    ['a non-integer pid', { pid: 4101.5, cwd: '/x/gateway', command: 'node' }],
    ['a zero pid', { pid: 0, cwd: '/x/gateway', command: 'node' }],
    ['a relative cwd', { pid: 4101, cwd: 'x/gateway', command: 'node' }],
    ['an empty command string', { pid: 4101, cwd: '/x/gateway', command: '' }],
    ['an empty argv', { pid: 4101, cwd: '/x/gateway', command: [] }],
    ['a port above 65535', { pid: 4101, port: 65_536, cwd: '/x/gateway', command: 'node' }],
    ['a non-string env value', { pid: 4101, cwd: '/x/gateway', command: 'node', env: { PORT: 8100 } }],
  ])('upProcessSchema rejects an entry with %s', (_label, entry) => {
    expect(upProcessSchema.safeParse(entry).success).toBe(false);
  });

  it('writes files process control can read: integer pid, absolute cwd, string or argv command', async () => {
    writeUpState(sampleState(), { env });
    expect(readAsProcessControl(await fs.readFile(file, 'utf8'))).toEqual({
      gateway: { pid: 4101, cwd: '/x/gateway', command: ['node', 'dist/main.js'] },
      people: { pid: 4112, cwd: '/x/services/people', command: 'node dist/main.js' },
    });
  });

  it('reads back, and keeps on the next write, a pid process control rewrote in its own format', async () => {
    writeUpState(sampleState(), { env });
    const doc = JSON.parse(await fs.readFile(file, 'utf8')) as UpState;
    const next = { ...doc, processes: { ...doc.processes, gateway: { ...doc.processes.gateway, pid: 4999 } } };
    await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    const restarted = { ...sampleState(), processes: { gateway: { ...GATEWAY, pid: 4999 }, people: PEOPLE } };

    expect(readUpState({ env })).toEqual(restarted);
    expect(writeUpState({ snapshot: 'S1' }, { env }).state).toEqual({ ...restarted, snapshot: 'S1' });
  });
});

describe('redactUpState', () => {
  it('masks env values whose names contain PASSWORD, SECRET, KEY or TOKEN, without changing its input', () => {
    const state = deepFreeze<UpState>({
      ...sampleState(),
      processes: {
        gateway: structuredClone(GATEWAY),
        people: { ...PEOPLE, env: { PORT: '8112', PG_PASSWORD: 'x', CLIENT_SECRET: 'x', OPT2_PUSH_KEY: 'x', sessionToken: 'x' } },
        timesheets: { pid: 4118, cwd: '/x/services/timesheets', command: 'node dist/main.js' },
      },
    });

    const redacted = redactUpState(state);

    expect(redacted.processes.people?.env).toEqual({
      PORT: '8112',
      PG_PASSWORD: '<redacted>',
      CLIENT_SECRET: '<redacted>',
      OPT2_PUSH_KEY: '<redacted>',
      sessionToken: '<redacted>',
    });
    expect(redacted.processes.gateway).toEqual(GATEWAY);
    expect(redacted.processes.timesheets).toEqual(state.processes.timesheets);
    expect(redacted.harnessNote).toBe('kept as written');
    expect(state.processes.people?.env?.PG_PASSWORD).toBe('x');
  });
});

interface CliRun {
  code: number;
  exits: number[];
  line: Record<string, unknown>;
}

/** Runs the up-state CLI through runCli against the temporary state directory; asserts one stdout line. */
async function cli(argv: string[]): Promise<CliRun> {
  const chunks: string[] = [];
  const exits: number[] = [];
  const code = await runCli((args) => main(args, env), {
    argv,
    command: COMMAND,
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    exit: (exitCode) => exits.push(exitCode),
  });
  const output = chunks.join('');
  expect(output.endsWith('\n')).toBe(true);
  expect(output.slice(0, -1)).not.toContain('\n');
  return { code, exits, line: JSON.parse(output) as Record<string, unknown> };
}

describe('repro:up-state CLI', () => {
  it('write records a process from flags, and read prints the stored state on one JSON line', async () => {
    const wrote = await cli([
      'write',
      '--process', 'gateway',
      '--pid', '4101',
      '--port', '8100',
      '--cwd', '/x/gateway',
      '--command-json', '["node","dist/main.js"]',
      '--env-json', '{"PORT":"8100"}',
      '--log', '/x/gateway.out',
    ]);
    expect(wrote).toEqual({
      code: 0,
      exits: [0],
      line: { command: COMMAND, ok: true, code: 0, path: file, processes: ['gateway'] },
    });
    expect(readUpState({ env })).toEqual({ processes: { gateway: GATEWAY } });

    const read = await cli(['read']);
    expect(read).toEqual({
      code: 0,
      exits: [0],
      line: { command: COMMAND, ok: true, code: 0, path: file, value: readUpState({ env }) },
    });
  });

  it('write --command records a shell string and resolves a relative --cwd against the working directory', async () => {
    expect((await cli(['write', '--process', 'people', '--pid', '4112', '--cwd', 'services/people', '--command', 'node dist/main.js'])).code).toBe(0);
    expect(readUpState({ env }).processes).toEqual({
      people: { pid: 4112, cwd: path.resolve('services/people'), command: 'node dist/main.js' },
    });
  });

  it('write --patch merges a JSON patch, and the top-level flags add fields while keeping its processes', async () => {
    const patch = { processes: { gateway: GATEWAY }, harnessNote: 'kept as written' };
    expect((await cli(['write', '--patch', JSON.stringify(patch)])).code).toBe(0);
    const fixtures = { available: false, reason: 'CREATE SCHEMA denied', checkedAt: '2026-06-30T08:00:00.000Z' };
    const fixturesFile = path.join(stateDir, 'fixtures.json');
    await fs.writeFile(fixturesFile, JSON.stringify(fixtures));

    const flags = await cli([
      'write',
      '--started-at', '2026-06-30T08:00:00.000Z',
      '--fixtures-file', fixturesFile,
      '--snapshot-json', '{"seq":0,"name":"S0"}',
      '--ports-json', '{"gateway":8100}',
    ]);

    expect(flags.code).toBe(0);
    expect(flags.line.processes).toEqual(['gateway']);
    expect(readUpState({ env })).toEqual({
      ...patch,
      startedAt: '2026-06-30T08:00:00.000Z',
      fixtures,
      snapshot: { seq: 0, name: 'S0' },
      ports: { gateway: 8100 },
    });
  });

  it('write --patch-file reads the patch from a file', async () => {
    const patchFile = path.join(stateDir, 'patch.json');
    await fs.writeFile(patchFile, JSON.stringify(sampleState()));
    const result = await cli(['write', '--patch-file', patchFile]);
    expect(result.code).toBe(0);
    expect(result.line.processes).toEqual(['gateway', 'people']);
    expect(readUpState({ env })).toEqual(sampleState());
  });

  it('read --field prints one nested value', async () => {
    writeUpState(sampleState(), { env });
    const result = await cli(['read', '--field', 'processes.gateway.command']);
    expect(result.code).toBe(0);
    expect(result.line.value).toEqual(['node', 'dist/main.js']);
  });

  it('read redacts secret-looking env values in its output and leaves the file as written', async () => {
    writeUpState({ processes: { people: { ...PEOPLE, env: { PORT: '8112', PG_PASSWORD: 'x' } } } }, { env });
    const result = await cli(['read', '--field', 'processes.people.env']);
    expect(result.line.value).toEqual({ PORT: '8112', PG_PASSWORD: '<redacted>' });
    expect(readUpState({ env }).processes.people?.env?.PG_PASSWORD).toBe('x');
  });

  it.each<[string, boolean, (dir: string) => string[], string, RegExp]>([
    ['read without up.json', false, () => ['read'], 'UpStateMissingError', /does not exist; run harness\/repro\/up\.sh first$/],
    ['read of an absent field', true, () => ['read', '--field', 'processes.web'], 'Error', /^field 'processes\.web' is not present in /],
    [
      'write with an unreadable --patch-file',
      false,
      (dir) => ['write', '--patch-file', path.join(dir, 'absent.json')],
      'Error',
      /^--patch-file .*absent\.json cannot be read: /,
    ],
  ])('exits 1 on %s', async (_label, seed, argv, type, message) => {
    if (seed) writeUpState(sampleState(), { env });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await cli(argv(stateDir));
    expect(result.code).toBe(1);
    expect(result.exits).toEqual([1]);
    expect(result.line).toMatchObject({ command: COMMAND, ok: false, code: 1, error: { type } });
    expect((result.line.error as { message: string }).message).toMatch(message);
  });

  it.each<[string, string[], RegExp]>([
    ['no subcommand', [], /^a subcommand is required$/],
    ['an unknown subcommand', ['status'], /^unknown subcommand 'status'$/],
    ['write without input', ['write'], /^write needs --patch, --patch-file, --process or a top-level flag$/],
    ['an unknown flag', ['write', '--bogus', 'x'], /--bogus/],
    ['a positional argument to read', ['read', 'extra'], /extra/],
    ['a --patch that is not JSON', ['write', '--patch', '{'], /^--patch is not valid JSON: /],
    ['a --patch that fails the schema', ['write', '--patch', '{"processes":{"gateway":{"pid":-1}}}'], /^--patch is invalid:/],
    ['--patch with process flags', ['write', '--patch', '{}', '--process', 'gateway'], /are mutually exclusive$/],
    ['a top-level flag the patch also sets', ['write', '--patch', '{"snapshot":"S0"}', '--snapshot-json', '"S1"'], /--snapshot-json conflicts with the patch's snapshot$/],
    ['a --snapshot-json that is not JSON', ['write', '--snapshot-json', '{'], /^--snapshot-json is not valid JSON: /],
    ['an out-of-range --ports-json', ['write', '--ports-json', '{"gateway":0}'], /^top-level flags is invalid:/],
    ['process flags without --process', ['write', '--pid', '1', '--cwd', '/x', '--command', 'node'], /non-empty --process <name>$/],
    ['an empty --process', ['write', '--process', '', '--pid', '1', '--cwd', '/x', '--command', 'node'], /non-empty --process <name>$/],
    ['--process without --pid', ['write', '--process', 'gateway', '--cwd', '/x', '--command', 'node'], /^--process needs --pid and --cwd$/],
    ['--process without a command', ['write', '--process', 'gateway', '--pid', '1', '--cwd', '/x'], /exactly one of --command or --command-json$/],
    [
      'both --command and --command-json',
      ['write', '--process', 'gateway', '--pid', '1', '--cwd', '/x', '--command', 'node', '--command-json', '["node"]'],
      /exactly one of --command or --command-json$/,
    ],
    ['a fractional --pid', ['write', '--process', 'gateway', '--pid', '41.5', '--cwd', '/x', '--command', 'node'], /^--pid must be a decimal integer, got '41\.5'$/],
    ['a non-numeric --port', ['write', '--process', 'gateway', '--pid', '1', '--port', '80a', '--cwd', '/x', '--command', 'node'], /^--port must be a decimal integer/],
    ['an empty --command-json argv', ['write', '--process', 'gateway', '--pid', '1', '--cwd', '/x', '--command-json', '[]'], /^process gateway is invalid:/],
    ['an empty --field segment', ['read', '--field', 'processes..pid'], /has an empty segment$/],
  ])('exits 2 with the usage on %s, leaving up.json unchanged', async (_label, argv, message) => {
    writeUpState(sampleState(), { env });
    const before = await fs.readFile(file, 'utf8');

    const result = await cli(argv);

    expect(result.code).toBe(2);
    expect(result.exits).toEqual([2]);
    expect(result.line).toMatchObject({ command: COMMAND, ok: false, code: 2, error: { type: 'UsageError' } });
    expect((result.line.error as { message: string }).message).toMatch(message);
    expect(String(result.line.usage).startsWith(USAGE_HEAD)).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readdir(stateDir)).toEqual(['up.json']);
  });
});

