// CLI diagnostics of @opt2/platform/logging: parseArgs problem texts, log-record.v1 lines, env selection and flushing.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { DestinationStream } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliDiagnostics, parseArgsProblem, type CliDiagnosticsOptions } from '../../src/logging/cli.js';
import { emitDiagnostic, setDiagnosticLogger } from '../../src/logging/diagnostics.js';
import { REDACTED } from '../../src/logging/redact.js';
import { validateLogRecord } from '../../src/logging/validate.js';
import { EnvValidationError } from '../../src/service-kit/env.js';

type LogLine = Record<string, unknown>;
type WriteCallback = (err?: Error | null) => void;

const USAGE = 'usage: opt2-test run --name <name> [--count <n>]';
// Assembled at run time, so no literal credential appears in source.
const SECRET = ['s3cr3t', 'logging', 'cli', 'value'].join('-');
const OPTIONS = { name: { type: 'string' }, count: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const;

/** A memory destination and the raw and parsed lines written to it. */
function memoryDestination(): { destination: DestinationStream; lines: LogLine[]; raw: string[] } {
  const lines: LogLine[] = [];
  const raw: string[] = [];
  const destination: DestinationStream = {
    write: (line: string) => {
      raw.push(line);
      lines.push(JSON.parse(line) as LogLine);
    },
  };
  return { destination, lines, raw };
}

/** Diagnostics of `opt2-test` writing to memory, with `overrides` applied. */
function memoryDiagnostics(overrides: Partial<CliDiagnosticsOptions> = {}) {
  const memory = memoryDestination();
  const diagnostics = createCliDiagnostics({ cli: 'opt2-test', usage: USAGE, source: {}, destination: memory.destination, ...overrides });
  return { diagnostics, ...memory };
}

/** The error node:util parseArgs throws for `args`. */
function parseArgsFailure(args: string[], allowPositionals = true): unknown {
  try {
    parseArgs({ args, options: OPTIONS, strict: true, allowPositionals });
  } catch (err) {
    return err;
  }
  throw new Error(`expected parseArgs to reject ${JSON.stringify(args)}`);
}

function expectValid(lines: readonly LogLine[]): void {
  for (const line of lines) expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
}

afterEach(() => {
  vi.restoreAllMocks();
  setDiagnosticLogger(undefined);
});

describe('parseArgsProblem', () => {
  it.each<[string, string[], boolean, string]>([
    ['an unknown long option', [`--${SECRET}=x`], true, 'unknown option'],
    ['an unknown short option', ['-z'], true, 'unknown option'],
    ['a string option without its value', ['--name'], true, 'an option is missing its value or was given one it does not take'],
    ['a boolean option given a value', [`--help=${SECRET}`], true, 'an option is missing its value or was given one it does not take'],
    ['a string option followed by an option', ['--name', `--${SECRET}`], true, 'an option is missing its value or was given one it does not take'],
    ['a positional the command does not take', [SECRET], false, 'unexpected argument'],
  ])('answers %s with a fixed text from the error code alone', (_label, args, allowPositionals, problem) => {
    const err = parseArgsFailure(args, allowPositionals);
    expect((err as Error).message).toContain(args[0]?.replace(/=.*$/, '') ?? '');
    expect(parseArgsProblem(err)).toBe(problem);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['a string', `--${SECRET}`],
    ['an Error without a code', new Error(`Unknown option '--${SECRET}'`)],
    ['an Error with another code', Object.assign(new Error(SECRET), { code: 'ERR_INVALID_ARG_TYPE' })],
    ['an Error with a non-string code', Object.assign(new Error(SECRET), { code: 7 })],
  ])('answers %s with the generic text', (_label, err) => {
    expect(parseArgsProblem(err)).toBe('invalid arguments');
  });
});

describe('createCliDiagnostics', () => {
  it('writes usage, error and fatal lines that validate, naming the command and carrying only safe error records', async () => {
    const { diagnostics, lines, raw } = memoryDiagnostics({ version: '9.8.7' });
    const leaky = new Error(`connect postgres://svc:${SECRET}@db/x refused`);

    diagnostics.usage('missing --name');
    diagnostics.error('no tenant holds the record');
    diagnostics.error('invalid environment', new EnvValidationError([`PG_HOST: ${SECRET}`], 'opt2-test'));
    diagnostics.fatal('run failed', leaky);
    await diagnostics.flush();

    expectValid(lines);
    const base = { service: 'opt2-test', version: '9.8.7', env: 'local' };
    expect(lines).toEqual([
      expect.objectContaining({ ...base, severity: 'ERROR', message: `opt2-test: missing --name; ${USAGE}` }),
      expect.objectContaining({ ...base, severity: 'ERROR', message: 'opt2-test: no tenant holds the record' }),
      expect.objectContaining({
        ...base,
        severity: 'ERROR',
        message: 'opt2-test: invalid environment',
        error: expect.objectContaining({ type: 'EnvValidationError', message: 'opt2-test: invalid environment (PG_HOST: is invalid)' }),
      }),
      expect.objectContaining({
        ...base,
        severity: 'CRITICAL',
        message: 'opt2-test: run failed',
        error: expect.objectContaining({ type: 'Error', message: REDACTED }),
      }),
    ]);
    expect(lines[0]).not.toHaveProperty('error');
    expect(lines[1]).not.toHaveProperty('error');
    expect(raw.join('')).not.toContain(SECRET);
  });

  it('defaults the service to the command and the version to the @opt2/platform version', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    const { diagnostics, lines } = memoryDiagnostics();
    diagnostics.usage('missing subcommand');
    expect(lines).toEqual([expect.objectContaining({ service: 'opt2-test', version: manifest.version })]);

    const named = memoryDiagnostics({ service: 'people', version: '2.0.0' });
    named.diagnostics.usage('missing subcommand');
    expect(named.lines).toEqual([expect.objectContaining({ service: 'people', version: '2.0.0', message: `opt2-test: missing subcommand; ${USAGE}` })]);
  });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    ['OPT2_ENV unset', {}, 'local'],
    ['OPT2_ENV=local', { OPT2_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'opt2-test' }, 'local'],
    ['OPT2_ENV=cloud with GOOGLE_CLOUD_PROJECT', { OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: 'opt2-test' }, 'cloud'],
    ['OPT2_ENV=cloud without GOOGLE_CLOUD_PROJECT', { OPT2_ENV: 'cloud' }, 'local'],
    ['OPT2_ENV=cloud with an unusable GOOGLE_CLOUD_PROJECT', { OPT2_ENV: 'cloud', GOOGLE_CLOUD_PROJECT: 'org/project' }, 'local'],
    ['an invalid OPT2_ENV', { OPT2_ENV: SECRET }, 'local'],
  ])('writes env %s as %s, before the environment is validated', (_label, source, env) => {
    const { diagnostics, lines, raw } = memoryDiagnostics({ source });
    diagnostics.usage('missing subcommand');
    expectValid(lines);
    expect(lines).toEqual([expect.objectContaining({ env, severity: 'ERROR' })]);
    expect(raw.join('')).not.toContain(SECRET);
  });

  it('registers its logger as the process diagnostic logger', () => {
    const { lines } = memoryDiagnostics();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    emitDiagnostic('OPT2_TEST', 'cache miss', new Error(SECRET));
    expectValid(lines);
    expect(lines).toEqual([expect.objectContaining({ severity: 'WARNING', message: 'OPT2_TEST: cache miss', error: expect.objectContaining({ message: REDACTED }) })]);
    expect(warning).not.toHaveBeenCalled();
  });

  it('resolves flush only after the destination flush callback ran', async () => {
    const { destination, lines } = memoryDestination();
    let finishFlush: (() => void) | undefined;
    const flushing: DestinationStream & { flush(cb: (err?: Error) => void): void } = {
      write: (line: string) => destination.write(line),
      flush: (cb) => {
        finishFlush = () => cb();
      },
    };
    const diagnostics = createCliDiagnostics({ cli: 'opt2-test', usage: USAGE, source: {}, destination: flushing });
    let resolved = false;

    diagnostics.fatal('run failed', new Error('boom'));
    const done = diagnostics.flush().then(() => {
      resolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lines).toHaveLength(1);
    expect(resolved).toBe(false);
    finishFlush?.();
    await done;
    expect(resolved).toBe(true);
  });
});

describe('createCliDiagnostics on stderr', () => {
  /** Replaces process.stderr.write with a recorder that keeps every write's callback uncalled. */
  function recordStderr(): { chunks: string[]; callbacks: WriteCallback[] } {
    const chunks: string[] = [];
    const callbacks: WriteCallback[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const callback = rest.find((arg): arg is WriteCallback => typeof arg === 'function');
      if (callback !== undefined) callbacks.push(callback);
      return true;
    }) as typeof process.stderr.write);
    return { chunks, callbacks };
  }

  it('writes each line to process.stderr and resolves flush at once when stderr buffers nothing', async () => {
    const { chunks, callbacks } = recordStderr();
    const diagnostics = createCliDiagnostics({ cli: 'opt2-test', usage: USAGE, source: {} });

    diagnostics.usage('missing --name');
    await diagnostics.flush();

    expect(chunks).toHaveLength(1);
    expect(callbacks).toEqual([]);
    const line = JSON.parse(chunks[0] as string) as LogLine;
    expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
    expect(line).toMatchObject({ severity: 'ERROR', message: `opt2-test: missing --name; ${USAGE}` });
  });

  it('waits for stderr to hand off what it still buffers before flush resolves', async () => {
    const { chunks, callbacks } = recordStderr();
    vi.spyOn(process.stderr, 'writableLength', 'get').mockReturnValue(64);
    const diagnostics = createCliDiagnostics({ cli: 'opt2-test', usage: USAGE, source: {} });
    let resolved = false;

    diagnostics.fatal('run failed', new Error('boom'));
    const done = diagnostics.flush().then(() => {
      resolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe('');
    expect(resolved).toBe(false);
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    await done;
    expect(resolved).toBe(true);
  });
});
