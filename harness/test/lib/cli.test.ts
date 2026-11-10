import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageError, isMainModule, parseFlags, runCli, type CliIo, type CliMain } from '../../src/lib/cli.js';
import { REPO_ROOT } from '../../src/lib/paths.js';

const COMMAND = 'harness/src/example.ts';
const USAGE = 'usage: example [--name <value>] [-v] [--tag <value>]...';
const OPTIONS = {
  name: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  tag: { type: 'string', multiple: true },
} as const;

type ThrownError = Error & { code?: string; usage?: string };

interface Run {
  code: number;
  chunks: string[];
  exits: number[];
  line: Record<string, unknown>;
}

/** Runs `main` through runCli with a capturing stdout and exit; `io` overrides those defaults. */
async function run(main: CliMain, io: CliIo = {}): Promise<Run> {
  const chunks: string[] = [];
  const exits: number[] = [];
  const code = await runCli(main, {
    argv: [],
    command: COMMAND,
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    exit: (exitCode) => exits.push(exitCode),
    ...io,
  });
  return { code, chunks, exits, line: JSON.parse(chunks.join('')) as Record<string, unknown> };
}

/** The serialised stdout line runCli writes for `fields`. */
function lineOf(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

/** The error `call` throws; fails the test when it returns. */
function thrown(call: () => unknown): ThrownError {
  try {
    call();
  } catch (err) {
    return err as ThrownError;
  }
  throw new Error('expected the call to throw');
}

function silenceStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

const savedArgv = process.argv;

afterEach(() => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
});

describe('UsageError', () => {
  it.each([
    ['with usage text', USAGE],
    ['without usage text', undefined],
  ])('is an Error named UsageError carrying the message, %s', (_label, usage) => {
    const err = new UsageError('bad flag', usage);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UsageError');
    expect(err.message).toBe('bad flag');
    expect(err.usage).toBe(usage);
  });
});

describe('runCli', () => {
  let stderr: ReturnType<typeof silenceStderr>;

  beforeEach(() => {
    stderr = silenceStderr();
  });

  function stderrText(): string {
    return stderr.mock.calls.map((call) => String(call[0])).join('');
  }

  describe('success', () => {
    it.each<[string, CliMain]>([
      ['returns nothing', () => undefined],
      ['resolves to nothing', async () => undefined],
      ['returns an empty outcome', () => ({})],
      ['returns code 0 without a summary', () => ({ code: 0 })],
    ])('exits 0 with a command/ok/code line when main %s', async (_label, main) => {
      const result = await run(main);
      expect(result.code).toBe(0);
      expect(result.exits).toEqual([0]);
      expect(result.chunks).toEqual([lineOf({ command: COMMAND, ok: true, code: 0 })]);
      expect(stderr).not.toHaveBeenCalled();
    });

    it.each([
      [0, true],
      [3, false],
      [255, false],
    ])('exits %i with ok %s and the summary fields after command, ok and code', async (code, ok) => {
      const summary = { files: 2, nested: { list: [1, 'two'] } };
      const result = await run(() => ({ code, summary }));
      expect(result.code).toBe(code);
      expect(result.exits).toEqual([code]);
      expect(result.chunks).toEqual([lineOf({ command: COMMAND, ok, code, ...summary })]);
    });

    it('keeps command, ok and code from the exit status when the summary names them', async () => {
      const result = await run(() => ({ summary: { command: 'other', ok: false, code: 7, extra: true } }));
      expect(result.code).toBe(0);
      expect(result.chunks).toEqual([lineOf({ command: COMMAND, ok: true, code: 0, extra: true })]);
    });

    it('awaits an asynchronous main before writing its outcome', async () => {
      const main: CliMain = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ code: 4, summary: { done: true } }), 10);
        });
      const result = await run(main);
      expect(result.code).toBe(4);
      expect(result.chunks).toEqual([lineOf({ command: COMMAND, ok: false, code: 4, done: true })]);
    });

    it('passes the injected argv to main', async () => {
      const main = vi.fn<CliMain>(() => undefined);
      await run(main, { argv: ['--name', 'alpha', 'rest'] });
      expect(main).toHaveBeenCalledTimes(1);
      expect(main).toHaveBeenCalledWith(['--name', 'alpha', 'rest']);
    });

    it('passes the arguments after the script path to main when no argv is injected', async () => {
      process.argv = ['node', path.join(REPO_ROOT, 'harness', 'src', 'tool.ts'), '--check', 'value'];
      const main = vi.fn<CliMain>(() => undefined);
      await run(main, { argv: undefined });
      expect(main).toHaveBeenCalledWith(['--check', 'value']);
    });
  });

  describe('failure', () => {
    it.each([
      { how: 'throws', usage: USAGE, label: 'and its usage text' },
      { how: 'rejects with', usage: USAGE, label: 'and its usage text' },
      { how: 'throws', usage: undefined, label: 'and no usage field' },
    ])('exits 2 with the error $label when main $how a UsageError', async ({ how, usage }) => {
      const err = new UsageError("Unknown option '--x'", usage);
      const main: CliMain =
        how === 'throws'
          ? () => {
              throw err;
            }
          : () => Promise.reject(err);
      const result = await run(main);
      expect(result.code).toBe(2);
      expect(result.exits).toEqual([2]);
      expect(result.chunks).toEqual([
        lineOf({ command: COMMAND, ok: false, code: 2, error: { type: 'UsageError', message: err.message }, usage }),
      ]);
      expect(Object.hasOwn(result.line, 'usage')).toBe(usage !== undefined);
      expect(stderr).not.toHaveBeenCalled();
    });

    class ProbeError extends Error {
      override name = 'ProbeError';
    }

    it.each([
      { how: 'throws', type: 'TypeError', make: () => new TypeError('bad input') },
      { how: 'rejects with', type: 'Error', make: () => new Error('lost connection') },
      { how: 'throws', type: 'ProbeError', make: () => new ProbeError('probe failed') },
    ])('exits 1 naming the $type and its message when main $how it, with the stack on stderr only', async ({ how, type, make }) => {
      const err = make();
      const main: CliMain =
        how === 'throws'
          ? () => {
              throw err;
            }
          : () => Promise.reject(err);
      const result = await run(main);
      expect(result.code).toBe(1);
      expect(result.exits).toEqual([1]);
      expect(result.chunks).toEqual([lineOf({ command: COMMAND, ok: false, code: 1, error: { type, message: err.message } })]);
      expect(stderrText()).toBe(`${err.stack}\n`);
      expect(result.chunks.join('')).not.toContain(err.stack);
    });

    it('writes the message to stderr when the thrown Error has no stack', async () => {
      const err = new Error('no trace');
      err.stack = undefined;
      const result = await run(() => {
        throw err;
      });
      expect(result.chunks).toEqual([lineOf({ command: COMMAND, ok: false, code: 1, error: { type: 'Error', message: 'no trace' } })]);
      expect(stderrText()).toBe('no trace\n');
    });

    it.each<[string, unknown, string, string]>([
      ['a string', 'plain failure', 'string', 'plain failure'],
      ['a number', 42, 'number', '42'],
      ['an object', { reason: 'x', n: 1 }, 'object', "{ reason: 'x', n: 1 }"],
      ['null', null, 'object', 'null'],
      ['undefined', undefined, 'undefined', 'undefined'],
    ])('exits 1 with the typeof as the error type when main throws %s', async (_label, value, type, message) => {
      const result = await run(() => {
        throw value;
      });
      expect(result.code).toBe(1);
      expect(result.exits).toEqual([1]);
      expect(result.chunks).toEqual([lineOf({ command: COMMAND, ok: false, code: 1, error: { type, message } })]);
      expect(stderrText()).toBe(`${message}\n`);
    });

    it.each([-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'exits 1 with a RangeError and no summary fields when main returns code %s',
      async (code) => {
        const result = await run(() => ({ code, summary: { files: 2 } }));
        expect(result.code).toBe(1);
        expect(result.exits).toEqual([1]);
        expect(result.chunks).toEqual([
          lineOf({
            command: COMMAND,
            ok: false,
            code: 1,
            error: { type: 'RangeError', message: `exit code ${String(code)} is not an integer from 0 to 255` },
          }),
        ]);
      },
    );

    it('exits 1 with the TypeError JSON.stringify raises for a summary it cannot serialise', async () => {
      const summary = { big: 1n };
      const native = thrown(() => JSON.stringify(summary));
      const result = await run(() => ({ summary }));
      expect(result.code).toBe(1);
      expect(result.chunks).toEqual([
        lineOf({ command: COMMAND, ok: false, code: 1, error: { type: 'TypeError', message: native.message } }),
      ]);
    });
  });

  describe('output and exit', () => {
    it('writes the single line to the injected stdout before calling exit', async () => {
      const events: string[] = [];
      const pending = runCli(() => ({ summary: { n: 1 } }), {
        argv: [],
        command: COMMAND,
        stdout: { write: (chunk: string) => events.push(`write:${chunk}`) },
        exit: (exitCode) => events.push(`exit:${exitCode}`),
      });
      expect(pending).toBeInstanceOf(Promise);
      expect(await pending).toBe(0);
      expect(events).toEqual([`write:${lineOf({ command: COMMAND, ok: true, code: 0, n: 1 })}`, 'exit:0']);
    });

    it('waits for a Writable stdout to flush the line before calling exit', async () => {
      const events: string[] = [];
      const stdout = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          events.push(`write:${chunk.toString()}`);
          setImmediate(() => {
            events.push('flushed');
            callback();
          });
        },
      });
      const code = await runCli(() => ({ code: 5 }), {
        argv: [],
        command: COMMAND,
        stdout,
        exit: (exitCode) => events.push(`exit:${exitCode}`),
      });
      expect(code).toBe(5);
      expect(events).toEqual([`write:${lineOf({ command: COMMAND, ok: false, code: 5 })}`, 'flushed', 'exit:5']);
    });

    it('writes to process.stdout when no stdout is injected', async () => {
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
        written.push(String(chunk));
        const callback = rest.find((arg): arg is () => void => typeof arg === 'function');
        callback?.();
        return true;
      }) as typeof process.stdout.write);
      const exits: number[] = [];
      const code = await runCli(() => ({ summary: { n: 1 } }), {
        argv: [],
        command: COMMAND,
        exit: (exitCode) => exits.push(exitCode),
      });
      expect(code).toBe(0);
      expect(exits).toEqual([0]);
      expect(written).toEqual([lineOf({ command: COMMAND, ok: true, code: 0, n: 1 })]);
    });
  });

  describe('command name', () => {
    it.each([
      ['a script under the checkout', path.join(REPO_ROOT, 'harness', 'src', 'repro', 'ports.ts'), 'harness/src/repro/ports.ts'],
      [
        'a script relative to the working directory',
        path.relative(process.cwd(), path.join(REPO_ROOT, 'opt2', 'tool.ts')),
        'opt2/tool.ts',
      ],
      ['the checkout root', REPO_ROOT, ''],
      ['a script outside the checkout', path.join(path.dirname(REPO_ROOT), 'elsewhere', 'tool.ts'), '../elsewhere/tool.ts'],
    ])('is process.argv[1] relative to the repository root with / separators for %s', async (_label, script, expected) => {
      process.argv = ['node', script];
      const result = await run(() => undefined, { command: undefined });
      expect(result.line.command).toBe(expected);
    });

    it('is empty when node has no script argument', async () => {
      process.argv = ['node'];
      const result = await run(() => undefined, { command: undefined });
      expect(result.line).toEqual({ command: '', ok: true, code: 0 });
    });
  });
});

describe('parseFlags', () => {
  it('returns typed values and no positionals for valid flags', () => {
    const parsed = parseFlags(['--name', 'alpha', '-v', '--tag', 'x', '--tag=y'], { options: OPTIONS });
    expect(parsed.values).toEqual({ name: 'alpha', verbose: true, tag: ['x', 'y'] });
    expect(parsed.positionals).toEqual([]);
  });

  it('returns positionals when allowPositionals is true', () => {
    const parsed = parseFlags(['first', '--name', 'alpha', 'second'], { options: OPTIONS, allowPositionals: true });
    expect(parsed.values).toEqual({ name: 'alpha' });
    expect(parsed.positionals).toEqual(['first', 'second']);
  });

  it.each([
    ['an unknown option', ['--unknown'], 'ERR_PARSE_ARGS_UNKNOWN_OPTION'],
    ['a positional when none are allowed', ['stray'], 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL'],
    ['a string option without a value', ['--name'], 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'],
    ['a boolean option given a value', ['--verbose=yes'], 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'],
  ])('throws a UsageError with parseArgs message and the usage text for %s', (_label, argv, nodeCode) => {
    const native = thrown(() => parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
    expect(native.code).toBe(nodeCode);
    const err = thrown(() => parseFlags(argv, { options: OPTIONS, usage: USAGE }));
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toBe(native.message);
    expect(err.usage).toBe(USAGE);
  });

  it('throws a UsageError without usage text when the spec has none', () => {
    const err = thrown(() => parseFlags(['--unknown'], { options: OPTIONS }));
    expect(err).toBeInstanceOf(UsageError);
    expect(err.usage).toBeUndefined();
  });

  it.each([
    ['argv that is not an array', () => parseFlags(42 as unknown as string[], { options: OPTIONS, usage: USAGE })],
    [
      'an option of an unsupported type',
      () => parseFlags([], { options: { count: { type: 'number' } } as unknown as typeof OPTIONS, usage: USAGE }),
    ],
  ])('rethrows the parseArgs configuration error rather than a UsageError for %s', (_label, call) => {
    const err = thrown(call);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
  });
});

describe('isMainModule', () => {
  let dir: string;
  let script: string;
  let moduleUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-cli-test-'));
    script = path.join(dir, 'entry.mjs');
    await writeFile(script, '');
    moduleUrl = pathToFileURL(script).href;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is true when argv1 is the module path', () => {
    expect(isMainModule(moduleUrl, script)).toBe(true);
  });

  it('is true when argv1 is the module path relative to the working directory', () => {
    expect(isMainModule(moduleUrl, path.relative(process.cwd(), script))).toBe(true);
  });

  it('is true when argv1 is a symlink to the module', async () => {
    const link = path.join(dir, 'link.mjs');
    await symlink(script, link);
    expect(isMainModule(moduleUrl, link)).toBe(true);
  });

  it('is true when the module URL passes through a symlinked directory', async () => {
    const linkedDir = path.join(dir, 'linked');
    await symlink(dir, linkedDir);
    expect(isMainModule(pathToFileURL(path.join(linkedDir, 'entry.mjs')).href, script)).toBe(true);
  });

  it('is false when argv1 is a different existing file', async () => {
    const other = path.join(dir, 'sub', 'other.mjs');
    await mkdir(path.dirname(other));
    await writeFile(other, '');
    expect(isMainModule(moduleUrl, other)).toBe(false);
  });

  it('is false when argv1 does not exist', () => {
    expect(isMainModule(moduleUrl, path.join(dir, 'missing.mjs'))).toBe(false);
  });

  it('reads process.argv[1] when argv1 is omitted', () => {
    process.argv = ['node', script];
    expect(isMainModule(moduleUrl)).toBe(true);
    process.argv = ['node', path.join(dir, 'missing.mjs')];
    expect(isMainModule(moduleUrl)).toBe(false);
  });

  it('is false when node has no script argument', () => {
    process.argv = ['node'];
    expect(isMainModule(moduleUrl)).toBe(false);
  });
});

// The same API driven through a `test-cmd` boundary with its own flag spec, argv capture and summary-line checks.
describe('cli through an injected test-cmd boundary', () => {
  const USAGE = 'usage: test-cmd [--confirm] [--out <file>] [pos]';
  const OPTIONS = { confirm: { type: 'boolean', short: 'c' }, out: { type: 'string' } } as const;

  /** Injected process boundary: stdout chunks land in `lines`, exit codes in `codes`, and nothing exits. */
  function captureIo(argv: string[] = []): { io: CliIo; lines: string[]; codes: number[] } {
    const lines: string[] = [];
    const codes: number[] = [];
    const io: CliIo = {
      argv,
      stdout: { write: (chunk: string) => lines.push(chunk) },
      exit: (code) => {
        codes.push(code);
      },
      command: 'test-cmd',
    };
    return { io, lines, codes };
  }

  /** Parsed summary line; fails unless exactly one newline-terminated single-line chunk was written. */
  function summaryOf(lines: string[]): Record<string, unknown> {
    expect(lines).toHaveLength(1);
    const chunk = lines[0] ?? '';
    expect(chunk.endsWith('\n')).toBe(true);
    expect(chunk.indexOf('\n')).toBe(chunk.length - 1);
    return JSON.parse(chunk) as Record<string, unknown>;
  }

  /** What `run` throws, or `undefined` when it returns. */
  function thrownBy(run: () => unknown): unknown {
    try {
      run();
    } catch (err) {
      return err;
    }
    return undefined;
  }

  /** Runs `run` synchronously while `process.argv` holds no script path, as under `node -e`. */
  function withoutScript<T>(run: () => T): T {
    const saved = process.argv;
    process.argv = saved.slice(0, 1);
    try {
      return run();
    } finally {
      process.argv = saved;
    }
  }

  function muteStderr() {
    return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('UsageError', () => {
    it('is an Error named UsageError with optional usage text', () => {
      const err = new UsageError('bad flag', USAGE);
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({ name: 'UsageError', message: 'bad flag', usage: USAGE });
      expect(new UsageError('bad flag').usage).toBeUndefined();
    });
  });

  describe('runCli success', () => {
    it('writes one JSON line with the command, status and summary fields, then exits 0', async () => {
      const { io, lines, codes } = captureIo();
      await expect(runCli(() => ({ summary: { n: 1 } }), io)).resolves.toBe(0);
      expect(summaryOf(lines)).toEqual({ command: 'test-cmd', ok: true, code: 0, n: 1 });
      expect(lines[0]).toBe('{"command":"test-cmd","ok":true,"code":0,"n":1}\n');
      expect(codes).toEqual([0]);
    });

    it('exits 0 with a bare status line when main resolves undefined', async () => {
      const { io, lines, codes } = captureIo();
      await expect(runCli(async () => undefined, io)).resolves.toBe(0);
      expect(summaryOf(lines)).toEqual({ command: 'test-cmd', ok: true, code: 0 });
      expect(codes).toEqual([0]);
    });

    it.each([3, 4, 255])('exits %i when main returns that code, still printing one line', async (code) => {
      const { io, lines, codes } = captureIo();
      await expect(runCli(() => ({ code, summary: { n: 1 } }), io)).resolves.toBe(code);
      expect(summaryOf(lines)).toEqual({ command: 'test-cmd', ok: false, code, n: 1 });
      expect(codes).toEqual([code]);
    });

    it('keeps command, ok and code authoritative over summary fields of the same name', async () => {
      const { io, lines } = captureIo();
      await runCli(() => ({ code: 3, summary: { command: 'other', ok: true, code: 0, n: 1 } }), io);
      expect(summaryOf(lines)).toEqual({ command: 'test-cmd', ok: false, code: 3, n: 1 });
    });

    it('passes io.argv to main', async () => {
      const argv = ['--confirm', '--out', '/x', 'pos'];
      const seen: string[][] = [];
      const { io } = captureIo(argv);
      await runCli((received) => {
        seen.push(received);
      }, io);
      expect(seen).toEqual([argv]);
    });

    it('writes the line before calling exit', async () => {
      const events: string[] = [];
      await runCli(() => undefined, {
        argv: [],
        stdout: { write: (chunk: string) => events.push(`write ${chunk}`) },
        exit: (code) => {
          events.push(`exit ${code}`);
        },
        command: 'test-cmd',
      });
      expect(events).toEqual(['write {"command":"test-cmd","ok":true,"code":0}\n', 'exit 0']);
    });

    it('exits only after a Writable sink has flushed the line', async () => {
      const events: string[] = [];
      const stdout = new Writable({
        write(chunk: Buffer, _encoding, done) {
          events.push(`write ${chunk.toString()}`);
          setImmediate(() => {
            events.push('flushed');
            done();
          });
        },
      });
      const code = await runCli(() => ({ summary: { n: 1 } }), {
        argv: [],
        stdout,
        exit: (exitCode) => {
          events.push(`exit ${exitCode}`);
        },
        command: 'test-cmd',
      });
      expect(code).toBe(0);
      expect(events).toEqual(['write {"command":"test-cmd","ok":true,"code":0,"n":1}\n', 'flushed', 'exit 0']);
    });

    it('defaults argv and command to the running script, relative to the repository root', async () => {
      const { io, lines } = captureIo();
      const seen: string[][] = [];
      await runCli(
        (received) => {
          seen.push(received);
        },
        { stdout: io.stdout, exit: io.exit },
      );
      expect(seen).toEqual([process.argv.slice(2)]);
      const { command } = summaryOf(lines);
      expect(typeof command).toBe('string');
      expect(path.isAbsolute(command as string)).toBe(false);
      expect(command).not.toContain('\\');
      expect(path.resolve(REPO_ROOT, command as string)).toBe(path.resolve(process.argv[1] ?? ''));
    });

    it('names an empty command when the process has no script path', async () => {
      const { io, lines, codes } = captureIo();
      const seen: string[][] = [];
      const pending = withoutScript(() =>
        runCli(
          (received) => {
            seen.push(received);
          },
          { stdout: io.stdout, exit: io.exit },
        ),
      );
      await expect(pending).resolves.toBe(0);
      expect(seen).toEqual([[]]);
      expect(summaryOf(lines)).toEqual({ command: '', ok: true, code: 0 });
      expect(codes).toEqual([0]);
    });
  });

  describe('runCli failures', () => {
    it('exits 1 on a thrown Error, with its message on the line and its stack on stderr only', async () => {
      const stderr = muteStderr();
      const err = new Error('boom');
      const { io, lines, codes } = captureIo();
      await expect(
        runCli(() => {
          throw err;
        }, io),
      ).resolves.toBe(1);
      expect(summaryOf(lines)).toEqual({
        command: 'test-cmd',
        ok: false,
        code: 1,
        error: { type: 'Error', message: 'boom' },
      });
      expect(lines[0]).not.toContain(' at ');
      expect(stderr).toHaveBeenCalledWith(`${err.stack ?? ''}\n`);
      expect(codes).toEqual([1]);
    });

    it.each<[string, CliMain]>([
      [
        'a synchronous throw',
        () => {
          throw new TypeError('sync failure');
        },
      ],
      [
        'an async rejection',
        async () => {
          await Promise.resolve();
          throw new TypeError('async failure');
        },
      ],
      ['a rejected promise', () => Promise.reject(new TypeError('rejected failure'))],
    ])('exits 1 on %s', async (_label, main) => {
      muteStderr();
      const { io, lines, codes } = captureIo();
      await expect(runCli(main, io)).resolves.toBe(1);
      expect(summaryOf(lines)).toMatchObject({
        command: 'test-cmd',
        ok: false,
        code: 1,
        error: { type: 'TypeError', message: expect.stringContaining('failure') },
      });
      expect(codes).toEqual([1]);
    });

    it.each([
      { label: 'a string', thrown: 'nope' as unknown, error: { type: 'string', message: 'nope' } },
      { label: 'an object', thrown: { reason: 'x' }, error: { type: 'object', message: "{ reason: 'x' }" } },
      { label: 'a number', thrown: 42, error: { type: 'number', message: '42' } },
      { label: 'undefined', thrown: undefined, error: { type: 'undefined', message: 'undefined' } },
    ])('exits 1 and describes a thrown non-Error ($label)', async ({ thrown, error }) => {
      const stderr = muteStderr();
      const { io, lines, codes } = captureIo();
      await expect(
        runCli(() => {
          throw thrown;
        }, io),
      ).resolves.toBe(1);
      expect(summaryOf(lines)).toEqual({ command: 'test-cmd', ok: false, code: 1, error });
      expect(stderr).toHaveBeenCalledWith(`${error.message}\n`);
      expect(codes).toEqual([1]);
    });

    it.each([-1, 256, 1.5, Number.NaN])('exits 1 with a RangeError when main returns exit code %s', async (code) => {
      muteStderr();
      const { io, lines, codes } = captureIo();
      await expect(runCli(() => ({ code, summary: { n: 1 } }), io)).resolves.toBe(1);
      expect(summaryOf(lines)).toEqual({
        command: 'test-cmd',
        ok: false,
        code: 1,
        error: { type: 'RangeError', message: `exit code ${String(code)} is not an integer from 0 to 255` },
      });
      expect(codes).toEqual([1]);
    });

    it.each([
      { label: 'with usage text', usage: USAGE as string | undefined, extra: { usage: USAGE } },
      { label: 'without usage text', usage: undefined, extra: {} },
    ])('exits 2 on a UsageError $label, writing nothing to stderr', async ({ usage, extra }) => {
      const stderr = muteStderr();
      const { io, lines, codes } = captureIo();
      await expect(
        runCli(() => {
          throw new UsageError('missing --out', usage);
        }, io),
      ).resolves.toBe(2);
      const parsed = summaryOf(lines);
      expect(parsed).toEqual({
        command: 'test-cmd',
        ok: false,
        code: 2,
        error: { type: 'UsageError', message: 'missing --out' },
        ...extra,
      });
      expect(Object.keys(parsed)).toHaveLength(usage === undefined ? 4 : 5);
      expect(stderr).not.toHaveBeenCalled();
      expect(codes).toEqual([2]);
    });

    it('exits 2 when parseFlags rejects the arguments main receives', async () => {
      const { io, lines, codes } = captureIo(['--bogus']);
      await expect(
        runCli((argv) => {
          parseFlags(argv, { options: OPTIONS, usage: USAGE });
        }, io),
      ).resolves.toBe(2);
      expect(summaryOf(lines)).toMatchObject({
        ok: false,
        code: 2,
        error: { type: 'UsageError', message: expect.stringContaining('--bogus') },
        usage: USAGE,
      });
      expect(codes).toEqual([2]);
    });
  });

  describe('parseFlags', () => {
    it('parses booleans, strings and positionals', () => {
      const { values, positionals } = parseFlags(['--confirm', '--out', '/x', 'pos'], {
        options: { confirm: { type: 'boolean' }, out: { type: 'string' } },
        allowPositionals: true,
      });
      expect(values.confirm).toBe(true);
      expect(values.out).toBe('/x');
      expect({ ...values }).toEqual({ confirm: true, out: '/x' });
      expect(positionals).toEqual(['pos']);
    });

    it.each([
      [['-c', '--out=/x']],
      [['--out', '/x', '--confirm']],
    ])('accepts short aliases and inline values in any order (%j)', (argv) => {
      const { values, positionals } = parseFlags(argv, { options: OPTIONS });
      expect({ ...values }).toEqual({ confirm: true, out: '/x' });
      expect(positionals).toEqual([]);
    });

    it('leaves absent flags undefined', () => {
      const { values } = parseFlags([], { options: OPTIONS });
      expect(values.confirm).toBeUndefined();
      expect(values.out).toBeUndefined();
      expect({ ...values }).toEqual({});
    });

    it('applies declared defaults unless the flag is given', () => {
      const options = {
        confirm: { type: 'boolean', default: false },
        out: { type: 'string', default: '/default' },
      } as const;
      expect({ ...parseFlags([], { options }).values }).toEqual({ confirm: false, out: '/default' });
      expect({ ...parseFlags(['--confirm', '--out', '/x'], { options }).values }).toEqual({ confirm: true, out: '/x' });
    });

    it('collects repeated values of a multiple flag', () => {
      const { values } = parseFlags(['--tag', 'a', '--tag', 'b'], { options: { tag: { type: 'string', multiple: true } } });
      expect(values.tag).toEqual(['a', 'b']);
    });

    it.each([
      { label: 'an unknown flag', argv: ['--unknown'], names: '--unknown' },
      { label: 'a string flag without a value', argv: ['--out'], names: '--out' },
      { label: 'a value on a boolean flag', argv: ['--confirm=yes'], names: '--confirm' },
      { label: 'a positional when none are allowed', argv: ['pos'], names: 'pos' },
    ])('raises a UsageError carrying spec.usage for $label', ({ argv, names }) => {
      const err = thrownBy(() => parseFlags(argv, { options: OPTIONS, usage: USAGE }));
      expect(err).toBeInstanceOf(UsageError);
      expect(err).toMatchObject({ name: 'UsageError', message: expect.stringContaining(names), usage: USAGE });
    });

    it('raises a UsageError without usage text when the spec has none', () => {
      const err = thrownBy(() => parseFlags(['--unknown'], { options: OPTIONS }));
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).usage).toBeUndefined();
    });

    it('rethrows an invalid flag spec unchanged instead of as a UsageError', () => {
      const err = thrownBy(() => parseFlags([], { options: { out: { type: 'string', short: 'xy' } } }));
      expect(err).toBeInstanceOf(TypeError);
      expect(err).not.toBeInstanceOf(UsageError);
      expect(err).toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
    });
  });

  describe('isMainModule', () => {
    let dir = '';
    let script = '';

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-cli-test-'));
      script = path.join(dir, 'main.ts');
      await writeFile(script, '');
      await writeFile(path.join(dir, 'other.ts'), '');
      await symlink(script, path.join(dir, 'link.ts'));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it.each<[string, (dir: string) => string, boolean]>([
      ['the script itself', (d) => path.join(d, 'main.ts'), true],
      ['a relative path to the script', (d) => path.relative(process.cwd(), path.join(d, 'main.ts')), true],
      ['a symlink to the script', (d) => path.join(d, 'link.ts'), true],
      ['a different file', (d) => path.join(d, 'other.ts'), false],
      ['a path that does not exist', (d) => path.join(d, 'missing.ts'), false],
    ])('given %s as argv1, returns %s', (_label, argv1, expected) => {
      expect(isMainModule(pathToFileURL(script).href, argv1(dir))).toBe(expected);
    });

    it('defaults argv1 to process.argv[1]', () => {
      expect(isMainModule(pathToFileURL(process.argv[1] ?? '').href)).toBe(true);
      expect(isMainModule(pathToFileURL(script).href)).toBe(false);
      expect(isMainModule(pathToFileURL(script).href, undefined)).toBe(false);
    });

    it('returns false when the process has no script path', () => {
      expect(withoutScript(() => isMainModule(pathToFileURL(script).href))).toBe(false);
    });
  });
});
