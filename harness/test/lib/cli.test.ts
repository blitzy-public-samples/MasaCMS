import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { REDACTED } from '@opt2/platform/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { UsageError, isMainModule, parseFlags, runCli, type CliIo, type CliMain, type CliOutcome } from '../../src/lib/cli.js';
import { UNEXPECTED_TOKEN } from '../../src/lib/diagnostics.js';
import { REPO_ROOT } from '../../src/lib/paths.js';

const COMMAND = 'harness/src/example.ts';
const USAGE = 'usage: example [--name <value>] [-v] [--tag <value>]...';
const OPTIONS = {
  name: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  tag: { type: 'string', multiple: true },
} as const;
// Synthetic values, assembled at run time so no credential-shaped literal sits in the source.
const SECRET = ['Qz', 'r7', 'Wv', 'k3', 'Jx', 'p9'].join('');
const OTHER_SECRET = ['Lm', '4t', 'Ys', '8d', 'Hb', '2n'].join('');

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

/** A main that fails with `err` the way `how` names. */
function failingMain(how: 'throws' | 'rejects with' | 'throws after an await in', err: unknown): CliMain {
  if (how === 'throws') {
    return () => {
      throw err;
    };
  }
  if (how === 'rejects with') return () => Promise.reject(err);
  return async () => {
    await Promise.resolve();
    throw err;
  };
}

function silenceStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

const savedArgv = process.argv;

afterEach(() => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    ] as const)('exits 2 with the error $label when main $how a UsageError', async ({ how, usage }) => {
      const err = new UsageError("Unknown option '--x'", usage);
      const result = await run(failingMain(how, err));
      expect(result.code).toBe(2);
      expect(result.exits).toEqual([2]);
      expect(result.chunks).toEqual([
        lineOf({ command: COMMAND, ok: false, code: 2, error: { type: 'UsageError', message: err.message }, usage }),
      ]);
      expect(Object.hasOwn(result.line, 'usage')).toBe(usage !== undefined);
      expect(stderr).not.toHaveBeenCalled();
    });

    it('exits 2 with the usage text when parseFlags inside main rejects the injected argv', async () => {
      const native = thrown(() => parseArgs({ args: ['--bogus'], options: OPTIONS, strict: true, allowPositionals: false }));
      const result = await run(
        (argv) => {
          parseFlags(argv, { options: OPTIONS, usage: USAGE });
        },
        { argv: ['--bogus'] },
      );
      expect(result.code).toBe(2);
      expect(result.exits).toEqual([2]);
      expect(result.chunks).toEqual([
        lineOf({ command: COMMAND, ok: false, code: 2, error: { type: 'UsageError', message: native.message }, usage: USAGE }),
      ]);
      expect(stderr).not.toHaveBeenCalled();
    });

    class ProbeError extends Error {
      override name = 'ProbeError';
    }

    it.each([
      { how: 'throws', type: 'TypeError', make: () => new TypeError('bad input') },
      { how: 'rejects with', type: 'Error', make: () => new Error('lost connection') },
      { how: 'throws', type: 'ProbeError', make: () => new ProbeError('probe failed') },
      { how: 'throws after an await in', type: 'TypeError', make: () => new TypeError('async failure') },
    ] as const)('exits 1 naming the $type and its message when main $how it, with the stack on stderr only', async ({ how, type, make }) => {
      const err = make();
      const result = await run(failingMain(how, err));
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

  describe('secret masking', () => {
    const YAML_DOC = `key: [unclosed ${OTHER_SECRET}\n`;
    const YAML_LOCATION = 'Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1';

    /** The error JSON.parse raises for `text`. */
    function parseError(text: string): Error {
      return thrown(() => JSON.parse(text));
    }

    /** The YAMLParseError yaml raises for `text`, its message ending in a code frame that quotes it. */
    function yamlError(text: string): Error {
      return thrown(() => parseYaml(text));
    }

    /** 4-code-unit slices of the synthetic secrets that occur in `text`. */
    function leaked(text: string): string[] {
      return [SECRET, OTHER_SECRET].flatMap((secret) =>
        Array.from({ length: secret.length - 3 }, (_, i) => secret.slice(i, i + 4)).filter((slice) => text.includes(slice)),
      );
    }

    it.each<[string, CliMain, number, Record<string, unknown>]>([
      [
        'an Error carrying an env secret',
        () => {
          throw new Error(`login failed for ${SECRET}`);
        },
        1,
        { error: { type: 'Error', message: `login failed for ${REDACTED}` } },
      ],
      [
        'a UsageError carrying an env secret',
        () => {
          throw new UsageError(`unknown user ${SECRET}`, USAGE);
        },
        2,
        { error: { type: 'UsageError', message: `unknown user ${REDACTED}` }, usage: USAGE },
      ],
      [
        'a UsageError quoting a --password value',
        () => {
          throw new UsageError(`rejected --password ${OTHER_SECRET}`);
        },
        2,
        { error: { type: 'UsageError', message: `rejected --password ${REDACTED}` } },
      ],
      [
        'a thrown object with a password field',
        () => {
          throw { password: OTHER_SECRET };
        },
        1,
        { error: { type: 'object', message: `{ password: '${REDACTED}' }` } },
      ],
      [
        'the SyntaxError JSON.parse raises for its input',
        () => JSON.parse(`{"token": ${OTHER_SECRET}}`) as CliOutcome,
        1,
        { error: { type: 'SyntaxError', message: UNEXPECTED_TOKEN } },
      ],
      [
        'a summary carrying an env secret, by value only',
        () => ({ summary: { dsn: `postgres://app:${SECRET}@db`, nested: [{ note: SECRET }], routeKey: 'GET /x' } }),
        0,
        { dsn: `postgres://app:${REDACTED}@db`, nested: [{ note: REDACTED }], routeKey: 'GET /x' },
      ],
      [
        'a returned finding quoting a V8 excerpt of an env secret',
        () => ({ code: 1, summary: { findings: [{ kind: 'unparseable', path: 'opt2/x.json', error: parseError(`{"token": ${SECRET}}`).message }] } }),
        1,
        { findings: [{ kind: 'unparseable', path: 'opt2/x.json', error: UNEXPECTED_TOKEN }] },
      ],
      [
        'a returned finding quoting a yaml code frame',
        () => ({ code: 1, summary: { findings: [{ kind: 'unparseable', path: 'opt2/x.yaml', error: yamlError(YAML_DOC).message }] } }),
        1,
        { findings: [{ kind: 'unparseable', path: 'opt2/x.yaml', error: YAML_LOCATION }] },
      ],
      [
        'a thrown YAMLParseError',
        () => parseYaml(YAML_DOC) as CliOutcome,
        1,
        { error: { type: 'YAMLParseError', message: YAML_LOCATION } },
      ],
    ])('masks %s on stdout and stderr', async (_label, main, code, fields) => {
      vi.stubEnv('OPT2_TEST_PASSWORD', SECRET);
      const result = await run(main);
      expect(result.code).toBe(code);
      expect(result.exits).toEqual([code]);
      expect(result.chunks).toEqual([lineOf({ command: COMMAND, ok: code === 0, code, ...fields })]);
      expect(leaked(result.chunks.join('') + stderrText())).toEqual([]);
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
  it.each([
    [['--name', 'alpha', '-v', '--tag', 'x', '--tag=y']],
    [['-v', '--tag=x', '--name=alpha', '--tag', 'y']],
  ])('returns typed values and no positionals for long, short and inline flags in any order (%j)', (argv) => {
    const parsed = parseFlags(argv, { options: OPTIONS });
    expect(parsed.values).toEqual({ name: 'alpha', verbose: true, tag: ['x', 'y'] });
    expect(parsed.positionals).toEqual([]);
  });

  it('leaves absent flags undefined', () => {
    const { values } = parseFlags([], { options: OPTIONS });
    expect([values.name, values.verbose, values.tag]).toEqual([undefined, undefined, undefined]);
    expect({ ...values }).toEqual({});
  });

  it.each([
    [[], { name: 'none', verbose: false }],
    [['-v', '--name', 'alpha'], { name: 'alpha', verbose: true }],
  ])('applies declared defaults unless the flag is given (%j)', (argv, expected) => {
    const options = { name: { type: 'string', default: 'none' }, verbose: { type: 'boolean', short: 'v', default: false } } as const;
    expect({ ...parseFlags(argv, { options }).values }).toEqual(expected);
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

  it.each<[string, () => unknown, string]>([
    ['argv that is not an array', () => parseFlags(42 as unknown as string[], { options: OPTIONS, usage: USAGE }), 'ERR_INVALID_ARG_TYPE'],
    [
      'an option of an unsupported type',
      () => parseFlags([], { options: { count: { type: 'number' } } as unknown as typeof OPTIONS, usage: USAGE }),
      'ERR_INVALID_ARG_TYPE',
    ],
    ['a short alias longer than one character', () => parseFlags([], { options: { out: { type: 'string', short: 'xy' } } }), 'ERR_INVALID_ARG_VALUE'],
  ])('rethrows the parseArgs configuration error rather than a UsageError for %s', (_label, call, nodeCode) => {
    const err = thrown(call);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.code).toBe(nodeCode);
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

  it.each<[boolean, string, () => Promise<{ url: string; argv1: string }>]>([
    [true, 'argv1 is the module path', async () => ({ url: moduleUrl, argv1: script })],
    [
      true,
      'argv1 is the module path relative to the working directory',
      async () => ({ url: moduleUrl, argv1: path.relative(process.cwd(), script) }),
    ],
    [
      true,
      'argv1 is a symlink to the module',
      async () => {
        const link = path.join(dir, 'link.mjs');
        await symlink(script, link);
        return { url: moduleUrl, argv1: link };
      },
    ],
    [
      true,
      'the module URL passes through a symlinked directory',
      async () => {
        const linkedDir = path.join(dir, 'linked');
        await symlink(dir, linkedDir);
        return { url: pathToFileURL(path.join(linkedDir, 'entry.mjs')).href, argv1: script };
      },
    ],
    [
      false,
      'argv1 is a different existing file',
      async () => {
        const other = path.join(dir, 'sub', 'other.mjs');
        await mkdir(path.dirname(other));
        await writeFile(other, '');
        return { url: moduleUrl, argv1: other };
      },
    ],
    [false, 'argv1 does not exist', async () => ({ url: moduleUrl, argv1: path.join(dir, 'missing.mjs') })],
  ])('is %s when %s', async (expected, _label, setup) => {
    const { url, argv1 } = await setup();
    expect(isMainModule(url, argv1)).toBe(expected);
  });

  it.each<[string, (url: string) => boolean]>([
    ['omitted', (url) => isMainModule(url)],
    ['explicitly undefined', (url) => isMainModule(url, undefined)],
  ])('reads process.argv[1] when argv1 is %s', (_label, check) => {
    process.argv = ['node', script];
    expect(check(moduleUrl)).toBe(true);
    process.argv = ['node', path.join(dir, 'missing.mjs')];
    expect(check(moduleUrl)).toBe(false);
  });

  it('is true for the running script and false for this test module under the real process.argv', () => {
    expect(isMainModule(pathToFileURL(process.argv[1] ?? '').href)).toBe(true);
    expect(isMainModule(import.meta.url)).toBe(false);
  });

  it('is false when node has no script argument', () => {
    process.argv = ['node'];
    expect(isMainModule(moduleUrl)).toBe(false);
  });
});
