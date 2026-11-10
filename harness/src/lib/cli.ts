import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { inspect, parseArgs, type ParseArgsConfig } from 'node:util';

import { REPO_ROOT } from './paths.js';

/** Invalid command-line usage, carrying the command's optional usage text. */
export class UsageError extends Error {
  override name = 'UsageError';
  readonly usage?: string;

  constructor(message: string, usage?: string) {
    super(message);
    this.usage = usage;
  }
}

/** What a command's `main` returns: its exit code and the fields merged into the summary line. */
export interface CliOutcome {
  code?: number;
  summary?: Record<string, unknown>;
}

/** A command's entry point, given the arguments after the script path. */
export type CliMain = (argv: string[]) => Promise<CliOutcome | void> | CliOutcome | void;

/** Injectable process boundary of {@link runCli}; every field defaults to the real process. */
export interface CliIo {
  argv?: string[];
  stdout?: { write(chunk: string): unknown };
  exit?: (code: number) => void;
  command?: string;
}

type OptionsConfig = ParseArgsConfig['options'];
type FlagConfig<T extends OptionsConfig, P extends boolean> = {
  args: string[];
  options: T;
  strict: true;
  allowPositionals: P;
};

/** Flag spec for {@link parseFlags}; `usage` is attached to the `UsageError` a bad argument raises. */
export interface FlagSpec<T extends OptionsConfig, P extends boolean = false> {
  options: T;
  allowPositionals?: P;
  usage?: string;
}

/** `{ values, positionals }` exactly as `parseArgs` types them for a strict parse of `T`. */
export type ParsedFlags<T extends OptionsConfig, P extends boolean = false> = ReturnType<
  typeof parseArgs<FlagConfig<T, P>>
>;

/**
 * Runs `main`, writes exactly one JSON summary line to stdout (commands write progress to stderr only), calls `exit` and returns the code.
 * Exit code: `main`'s `code` (default 0); 2 for a `UsageError`; 1 for any other throw or a code outside 0–255.
 */
export async function runCli(main: CliMain, io: CliIo = {}): Promise<number> {
  const argv = io.argv ?? process.argv.slice(2);
  const stdout = io.stdout ?? process.stdout;
  const exit = io.exit ?? ((code: number) => process.exit(code));
  const command = io.command ?? defaultCommand(process.argv[1]);

  let code: number;
  let line: string;
  try {
    const result = await main(argv);
    const outcome: CliOutcome = typeof result === 'object' ? result : {};
    code = outcome.code ?? 0;
    if (!Number.isInteger(code) || code < 0 || code > 255) {
      throw new RangeError(`exit code ${String(code)} is not an integer from 0 to 255`);
    }
    const head = { command, ok: code === 0, code };
    // Re-applied after the summary so a summary field can never contradict the exit status.
    line = JSON.stringify(Object.assign({ ...head }, outcome.summary, head));
  } catch (err) {
    ({ code, line } = failureLine(command, err));
  }

  await writeLine(stdout, `${line}\n`);
  exit(code);
  return code;
}

/** Strict `parseArgs` over `argv`; any argument error is rethrown as a `UsageError` carrying `spec.usage`. */
export function parseFlags<T extends OptionsConfig, P extends boolean = false>(
  argv: string[],
  spec: FlagSpec<T, P>,
): ParsedFlags<T, P> {
  const config: FlagConfig<T, P> = {
    args: argv,
    options: spec.options,
    strict: true,
    // `P` is inferred from the literal passed, so an omitted value means `P = false`.
    allowPositionals: (spec.allowPositionals ?? false) as P,
  };
  try {
    return parseArgs(config);
  } catch (err) {
    const errCode = (err as NodeJS.ErrnoException | null)?.code;
    if (err instanceof Error && typeof errCode === 'string' && errCode.startsWith('ERR_PARSE_ARGS_')) {
      throw new UsageError(err.message, spec.usage);
    }
    throw err;
  }
}

/** Whether the module at `metaUrl` is the script node was started with (`argv1`, default `process.argv[1]`). */
export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  const script = path.resolve(argv1);
  if (!existsSync(script)) return false;
  return realpathSync(fileURLToPath(metaUrl)) === realpathSync(script);
}

function defaultCommand(argv1: string | undefined): string {
  if (argv1 === undefined) return '';
  return path.relative(REPO_ROOT, path.resolve(argv1)).split(path.sep).join('/');
}

function failureLine(command: string, err: unknown): { code: number; line: string } {
  if (err instanceof UsageError) {
    const error = { type: 'UsageError', message: err.message };
    return { code: 2, line: JSON.stringify({ command, ok: false, code: 2, error, usage: err.usage }) };
  }
  const error =
    err instanceof Error
      ? { type: err.name, message: err.message }
      : { type: typeof err, message: typeof err === 'string' ? err : inspect(err) };
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : error.message}\n`);
  return { code: 1, line: JSON.stringify({ command, ok: false, code: 1, error }) };
}

function writeLine(stdout: NonNullable<CliIo['stdout']>, line: string): Promise<void> {
  if (stdout instanceof Writable) {
    // Resolves once the line is handed to the OS, so a following `process.exit` cannot truncate it.
    return new Promise((resolve) => {
      stdout.write(line, () => resolve());
    });
  }
  stdout.write(line);
  return Promise.resolve();
}
