import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { redactText } from '@opt2/platform/logging';
import { z } from '@opt2/platform/service-kit';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { jsonSyntaxDetail } from '../lib/diagnostics.js';
import { stateDir, type EnvLike } from '../lib/paths.js';
import { stableStringify } from '../lib/report.js';

const portSchema = z.number().int().min(1).max(65_535);

// Constraints match migration's fault process control (`upJsonSchema`), so every entry written here can be
// respawned by it: an absolute `cwd`, a non-empty command or argv[0], and unknown entry keys kept on rewrite.
/** One process `up.sh` started; an array `command` is an argv, a string runs through a shell. */
export const upProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    port: portSchema.optional(),
    cwd: z.string().refine((value) => path.isAbsolute(value), 'must be an absolute path'),
    command: z.union([z.string().min(1), z.tuple([z.string().min(1)], z.string())]),
    env: z.record(z.string(), z.string()).optional(),
    log: z.string().min(1).optional(),
  })
  .loose();

const upStateShape = z.object({
  processes: z.record(z.string(), upProcessSchema),
  ports: z.record(z.string(), portSchema).optional(),
  snapshot: z.unknown().optional(),
  fixtures: z
    .object({ available: z.boolean(), reason: z.string().nullable().optional(), checkedAt: z.string().optional() })
    .loose()
    .nullable()
    .optional(),
  startedAt: z.string().optional(),
});

/** Schema of `${OPT2_STATE_DIR}/up.json`; processes are keyed by name and unknown keys are kept. */
export const upStateSchema = upStateShape.loose();

const upStatePatchSchema = upStateShape.partial().loose();

/** A recorded process. */
export type UpProcessEntry = z.infer<typeof upProcessSchema>;

/** A parsed `up.json`. */
export type UpState = z.infer<typeof upStateSchema>;

/** Top-level keys to set, and process entries to replace whole by name. */
export type UpStatePatch = Partial<Omit<z.infer<typeof upStateShape>, 'processes'>> & {
  processes?: Record<string, UpProcessEntry>;
  [key: string]: unknown;
};

/** Location of `up.json`: `path` when given, else under the state directory of `env`. */
export interface UpStateOptions {
  env?: EnvLike;
  path?: string;
}

/** Path of `up.json` in the runtime state directory, outside the checkout. */
export function upStatePath(env: EnvLike = process.env): string {
  return path.join(stateDir(env), 'up.json');
}

/** Raised when `up.json` does not exist, meaning `up.sh` has not recorded a stack. */
export class UpStateMissingError extends Error {
  override name = 'UpStateMissingError';
  readonly path: string;

  constructor(file: string, options?: ErrorOptions) {
    super(`${file} does not exist; run harness/repro/up.sh first`, options);
    this.path = file;
  }
}

/** Reads and validates `up.json`; throws `UpStateMissingError` when it is absent. */
export function readUpState(opts: UpStateOptions = {}): UpState {
  const file = opts.path ?? upStatePath(opts.env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new UpStateMissingError(file, { cause: err });
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: is not valid JSON: ${jsonSyntaxDetail(err)}`, { cause: err });
  }
  const parsed = upStateSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file}: does not match the up.json schema:\n${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** `current` with the patch's defined top-level keys set and its process entries replaced by name; validated. */
export function mergeUpState(current: UpState | undefined, patch: UpStatePatch): UpState {
  const base = current ?? { processes: {} };
  const updates = Object.entries(patch).filter(([key, value]) => key !== 'processes' && value !== undefined);
  // fromEntries and spread define own properties, so a `__proto__` key stays data.
  return upStateSchema.parse({
    ...Object.fromEntries([...Object.entries(base), ...updates]),
    processes: { ...base.processes, ...patch.processes },
  });
}

/** Merges `patch` into `up.json` and atomically replaces the file with mode 0600; returns the path and new state. */
export function writeUpState(patch: UpStatePatch, opts: UpStateOptions = {}): { path: string; state: UpState } {
  const file = opts.path ?? upStatePath(opts.env);
  let current: UpState | undefined;
  try {
    current = readUpState({ path: file });
  } catch (err) {
    if (!(err instanceof UpStateMissingError)) throw err;
  }
  const state = mergeUpState(current, patch);

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // Removed first so `mode` applies to a fresh file: process env entries may carry role passwords.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, stableStringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { path: file, state };
}

const SNAPSHOT_FIELDS = ['seq', 'kind', 'name'] as const;

/** The part of `up.json` that `read` prints; a process's env and command, and every unlisted key, stay private. */
export interface PublicUpState {
  processes: Record<string, Pick<UpProcessEntry, 'pid' | 'port' | 'cwd' | 'log'>>;
  ports?: Record<string, number>;
  startedAt?: string;
  fixtures?: { available: boolean; reason?: string | null; checkedAt?: string } | null;
  snapshot?: Partial<Record<(typeof SNAPSHOT_FIELDS)[number], number | string>>;
}

/** `value` without its undefined properties, so `read --field` reports an absent one as not present. */
function definedFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** The scalar `seq`, `kind` and `name` of a plain-object snapshot; undefined for any other snapshot. */
function publicSnapshot(snapshot: unknown): PublicUpState['snapshot'] {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
  const fields = snapshot as Record<string, unknown>;
  return Object.fromEntries(
    SNAPSHOT_FIELDS.map((key): [string, unknown] => [key, fields[key]]).filter(
      ([, value]) => typeof value === 'number' || typeof value === 'string',
    ),
  );
}

/** Public projection of `state`, built from allowlisted fields; the fixture reason is passed through `redactText`. */
export function redactUpState(state: UpState): PublicUpState {
  const { fixtures } = state;
  return definedFields<PublicUpState>({
    processes: Object.fromEntries(
      Object.entries(state.processes).map(([name, entry]) => [
        name,
        definedFields({ pid: entry.pid, port: entry.port, cwd: entry.cwd, log: entry.log }),
      ]),
    ),
    ports: state.ports === undefined ? undefined : Object.fromEntries(Object.entries(state.ports)),
    startedAt: state.startedAt,
    fixtures:
      fixtures === undefined || fixtures === null
        ? fixtures
        : definedFields({
            available: fixtures.available,
            reason: typeof fixtures.reason === 'string' ? redactText(fixtures.reason) : fixtures.reason,
            checkedAt: fixtures.checkedAt,
          }),
    snapshot: publicSnapshot(state.snapshot),
  });
}

const USAGE = [
  'usage: tsx src/repro/up-state.ts write (--patch <json> | --patch-file <path> | --process <name> --pid <n> --cwd <dir>',
  '         (--command <string> | --command-json <argv json>) [--port <n>] [--env-json <json>] [--log <path>])',
  '         [--started-at <iso>] [--fixtures-file <path>] [--snapshot-json <json>] [--ports-json <json>]',
  '       tsx src/repro/up-state.ts read [--field <dot.path>]',
].join('\n');

const PROCESS_FLAGS = ['process', 'pid', 'cwd', 'command', 'command-json', 'port', 'env-json', 'log'] as const;

function parseJson(label: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${label} is not valid JSON: ${jsonSyntaxDetail(err)}`, USAGE);
  }
}

function readJsonFile(flag: string, file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`--${flag} ${file} cannot be read: ${(err as Error).message}`, { cause: err });
  }
  return parseJson(`--${flag} ${file}`, text);
}

function integerFlag(flag: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`--${flag} must be a decimal integer, got '${value}'`, USAGE);
  return Number(value);
}

function validated<T>(label: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UsageError(`${label} is invalid:\n${z.prettifyError(parsed.error)}`, USAGE);
  return parsed.data;
}

type WriteFlags = Partial<Record<(typeof PROCESS_FLAGS)[number], string>>;

function processPatch(values: WriteFlags): Record<string, UpProcessEntry> {
  const name = values.process;
  if (name === undefined || name === '') throw new UsageError('process flags need a non-empty --process <name>', USAGE);
  if (values.pid === undefined || values.cwd === undefined) throw new UsageError('--process needs --pid and --cwd', USAGE);
  if ((values.command === undefined) === (values['command-json'] === undefined)) {
    throw new UsageError('--process needs exactly one of --command or --command-json', USAGE);
  }
  const entry = {
    pid: integerFlag('pid', values.pid),
    port: values.port === undefined ? undefined : integerFlag('port', values.port),
    cwd: path.resolve(values.cwd),
    command: values['command-json'] === undefined ? values.command : parseJson('--command-json', values['command-json']),
    env: values['env-json'] === undefined ? undefined : parseJson('--env-json', values['env-json']),
    log: values.log,
  };
  return { [name]: validated(`process ${name}`, upProcessSchema, entry) };
}

function writeCommand(argv: string[], env: EnvLike): CliOutcome {
  const { values } = parseFlags(argv, {
    options: {
      patch: { type: 'string' },
      'patch-file': { type: 'string' },
      process: { type: 'string' },
      pid: { type: 'string' },
      cwd: { type: 'string' },
      command: { type: 'string' },
      'command-json': { type: 'string' },
      port: { type: 'string' },
      'env-json': { type: 'string' },
      log: { type: 'string' },
      'started-at': { type: 'string' },
      'fixtures-file': { type: 'string' },
      'snapshot-json': { type: 'string' },
      'ports-json': { type: 'string' },
    },
    usage: USAGE,
  });

  const usesProcessFlags = PROCESS_FLAGS.some((flag) => values[flag] !== undefined);
  const sources = [values.patch !== undefined, values['patch-file'] !== undefined, usesProcessFlags];
  if (sources.filter(Boolean).length > 1) {
    throw new UsageError('--patch, --patch-file and the --process flags are mutually exclusive', USAGE);
  }

  let patch: UpStatePatch = {};
  if (values.patch !== undefined) {
    patch = validated('--patch', upStatePatchSchema, parseJson('--patch', values.patch));
  } else if (values['patch-file'] !== undefined) {
    patch = validated('--patch-file', upStatePatchSchema, readJsonFile('patch-file', values['patch-file']));
  } else if (usesProcessFlags) {
    patch = { processes: processPatch(values) };
  }

  const flagged: [key: string, flag: string, value: unknown][] = [];
  const startedAt = values['started-at'];
  const fixturesFile = values['fixtures-file'];
  const snapshot = values['snapshot-json'];
  const ports = values['ports-json'];
  if (startedAt !== undefined) flagged.push(['startedAt', 'started-at', startedAt]);
  if (fixturesFile !== undefined) flagged.push(['fixtures', 'fixtures-file', readJsonFile('fixtures-file', fixturesFile)]);
  if (snapshot !== undefined) flagged.push(['snapshot', 'snapshot-json', parseJson('--snapshot-json', snapshot)]);
  if (ports !== undefined) flagged.push(['ports', 'ports-json', parseJson('--ports-json', ports)]);

  for (const [key, flag] of flagged) {
    if (Object.hasOwn(patch, key)) throw new UsageError(`--${flag} conflicts with the patch's ${key}`, USAGE);
  }
  if (Object.keys(patch).length === 0 && flagged.length === 0) {
    throw new UsageError('write needs --patch, --patch-file, --process or a top-level flag', USAGE);
  }
  const topLevel = Object.fromEntries(flagged.map(([key, , value]) => [key, value]));
  patch = { ...patch, ...validated('top-level flags', upStatePatchSchema, topLevel) };

  const written = writeUpState(patch, { env });
  return { summary: { path: written.path, processes: Object.keys(written.state.processes).sort() } };
}

function fieldValue(value: unknown, field: string, file: string): unknown {
  const segments = field.split('.');
  if (segments.includes('')) throw new UsageError(`--field '${field}' has an empty segment`, USAGE);
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      throw new Error(`field '${field}' is not present in ${file}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readCommand(argv: string[], env: EnvLike): CliOutcome {
  const { values } = parseFlags(argv, { options: { field: { type: 'string' } }, usage: USAGE });
  const file = upStatePath(env);
  const state = redactUpState(readUpState({ path: file }));
  return { summary: { path: file, value: values.field === undefined ? state : fieldValue(state, values.field, file) } };
}

/** CLI entry: `write` merges a patch into up.json, `read` prints its public projection (or one field of it). */
export function main(argv: string[], env: EnvLike = process.env): CliOutcome {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'write') return writeCommand(rest, env);
  if (subcommand === 'read') return readCommand(rest, env);
  throw new UsageError(
    subcommand === undefined ? 'a subcommand is required' : `unknown subcommand '${subcommand}'`,
    USAGE,
  );
}

if (isMainModule(import.meta.url)) {
  await runCli(main);
}
