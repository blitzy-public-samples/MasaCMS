#!/usr/bin/env node
// `opt2-migrate` CLI: serves the migration service, or runs one orchestration command and prints its JSON summary line.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import { shutdownTracing, startTracing } from '@opt2/platform/tracing';

import type { MigrationContext } from './context.js';
import type { SnapshotKind } from './snapshot/index.js';

type WindowsModule = typeof import('./windows/index.js');

/** The writers' keyScope values, or the whole table, as `windowOpen` takes them. */
export type WindowScope = NonNullable<Parameters<WindowsModule['openWindowViaService']>[1]['scope']>;

/** A parsed `opt2-migrate` invocation; `help.topic` is a command or group name, `null` for the whole CLI. */
export type MigrateCommand =
  | { kind: 'help'; topic: string | null }
  | { kind: 'serve' }
  | { kind: 'init-legacy' }
  | { kind: 'snapshot'; snapshotKind: SnapshotKind }
  | { kind: 'snapshot restore'; seq: number }
  | { kind: 'snapshot drop'; seq: number }
  | { kind: 'backfill'; snapshotSeq: number }
  | { kind: 'feed'; snapshotSeq?: number }
  | { kind: 'transition'; to: string; pollMs: number }
  | { kind: 'reconcile'; point: string; units?: string[] }
  | { kind: 'rollback-set' }
  | { kind: 'rollback report' }
  | { kind: 'rollback rebaseline' }
  | { kind: 'fault'; name: string; params?: unknown }
  | { kind: 'resolve-window'; windowId: string }
  | { kind: 'window open'; units: string[]; routeKey?: string; scope?: WindowScope }
  | { kind: 'window complete'; windowId: string; forwarded: boolean }
  | { kind: 'scheduler import'; file: string }
  | { kind: 'scheduler status' }
  | { kind: 'files manifest'; snapshotSeq: number }
  | { kind: 'files transfer'; snapshotSeq: number };

type RunCommand = Exclude<MigrateCommand, { kind: 'help' }>;
type CommandName = RunCommand['kind'];
type ContextCommand = Exclude<RunCommand, { kind: 'serve' }>;

/** Invalid command line; `main` answers it on stderr with `usage` and exit code 2. */
export class MigrateUsageError extends Error {
  override readonly name: string = 'MigrateUsageError';

  constructor(
    message: string,
    readonly usage: string = USAGE,
  ) {
    super(message);
  }
}

/** Streams `main` writes its output to. */
export interface MigrateIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const CLI_NAME = 'opt2-migrate';
const TRACING = { serviceName: 'migration', version: '1.0.0' } as const;

// The migration config has no transition poll interval, so the CLI keeps its own default; `--poll-ms` overrides it.
export const DEFAULT_TRANSITION_POLL_MS = 1_000;

// Snapshot kinds as the migration.snapshot CHECK constraint allows them; `satisfies` fails the build if they drift from
// SnapshotKind. Listed here because parsing runs before tracing starts, when snapshot/ must not be loaded yet.
// `--kind` is required: no stored kind is a neutral default, and readers such as after-backfill select by kind.
const SNAPSHOT_KIND_SET = {
  seed: true,
  workload: true,
  transition: true,
  rebaseline: true,
  checkpoint: true,
  feed: true,
} as const satisfies Record<SnapshotKind, true>;
const SNAPSHOT_KINDS = Object.keys(SNAPSHOT_KIND_SET) as SnapshotKind[];

// Module errors their modules document as usage errors of this CLI.
const MODULE_USAGE_ERRORS: ReadonlySet<string> = new Set(['FaultUsageError', 'ReconcileUsageError']);

// Secret values never written to stdout or stderr.
const SECRET_VARIABLES = ['MURA_DBPASSWORD', 'OPT2_BRIDGE_HMAC_KEY', 'PG_PASSWORD'] as const;
const REDACTED = '[redacted]';
// Task URLs carry opt2TaskToken and local push endpoints the push key in their query, so no URL keeps its query or fragment.
const URL_QUERY = /(\bhttps?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/g;

const VERSION_ID = /^v\d{4}$/;
const NON_NEGATIVE_INT = /^\d+$/;
const POSITIVE_INT = /^[1-9]\d*$/;

type Values = Readonly<Record<string, string | boolean | undefined>>;

/** How one command is parsed: its usage arguments, flags, required positionals and the command it builds. */
interface CommandSpec {
  args: string;
  options: ParseArgsOptionsConfig;
  positionals: readonly string[];
  build(values: Values, positionals: readonly string[]): RunCommand;
}

/** A flag value that does not parse; `parseCommand` turns it into a usage error with the command's usage. */
class InvalidArgument extends Error {}

const STRING = { type: 'string' } as const;
const BOOLEAN = { type: 'boolean' } as const;
const HELP_OPTION = { help: { type: 'boolean', short: 'h' } } as const satisfies ParseArgsOptionsConfig;

function required(values: Values, flag: string): string {
  const value = values[flag];
  if (typeof value !== 'string' || value === '') throw new InvalidArgument(`--${flag} <value> is required`);
  return value;
}

function optional(values: Values, flag: string): string | undefined {
  const value = values[flag];
  if (value === '') throw new InvalidArgument(`--${flag} must not be empty`);
  return typeof value === 'string' ? value : undefined;
}

/** A snapshot sequence; S0 is sequence 0. */
function seqOf(flag: string, value: string): number {
  const seq = Number(value);
  if (!NON_NEGATIVE_INT.test(value) || !Number.isSafeInteger(seq)) {
    throw new InvalidArgument(`--${flag} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return seq;
}

function positiveIntOf(flag: string, value: string): number {
  const parsed = Number(value);
  if (!POSITIVE_INT.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgument(`--${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function versionOf(value: string): string {
  if (!VERSION_ID.test(value)) throw new InvalidArgument(`--to must name a cut-over version vNNNN, got ${JSON.stringify(value)}`);
  return value;
}

function snapshotKindOf(value: string): SnapshotKind {
  if (!Object.hasOwn(SNAPSHOT_KIND_SET, value)) {
    throw new InvalidArgument(`--kind must be one of ${SNAPSHOT_KINDS.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value as SnapshotKind;
}

/** Comma-separated, trimmed, non-empty items. */
function listOf(flag: string, value: string): string[] {
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => item === '')) throw new InvalidArgument(`--${flag} must be a comma-separated list without empty items`);
  return items;
}

function jsonOf(flag: string, value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new InvalidArgument(`--${flag} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `table`, `{"table":true}` or `{"keys":{"<name>":"<value>",...}}`. */
function scopeOf(value: string): WindowScope {
  if (value === 'table') return { table: true };
  const scope = jsonOf('scope', value) as { table?: unknown; keys?: unknown } | null;
  const only = (key: string): boolean => typeof scope === 'object' && scope !== null && Object.keys(scope).join() === key;
  if (only('table') && scope?.table === true) return { table: true };
  const keys = scope?.keys;
  const isKeyMap = typeof keys === 'object' && keys !== null && !Array.isArray(keys) && Object.keys(keys).length > 0;
  if (only('keys') && isKeyMap && Object.values(keys).every((item) => typeof item === 'string')) return { keys: keys as Record<string, string> };
  throw new InvalidArgument('--scope must be table, {"table":true} or {"keys":{"<name>":"<value>"}}');
}

const SPECS = {
  serve: { args: '', options: {}, positionals: [], build: () => ({ kind: 'serve' }) },
  'init-legacy': { args: '', options: {}, positionals: [], build: () => ({ kind: 'init-legacy' }) },
  snapshot: {
    args: `--kind <${SNAPSHOT_KINDS.join('|')}>`,
    options: { kind: STRING },
    positionals: [],
    build: (values) => ({ kind: 'snapshot', snapshotKind: snapshotKindOf(required(values, 'kind')) }),
  },
  'snapshot restore': {
    args: '--seq <n>',
    options: { seq: STRING },
    positionals: [],
    build: (values) => ({ kind: 'snapshot restore', seq: seqOf('seq', required(values, 'seq')) }),
  },
  'snapshot drop': {
    args: '--seq <n>',
    options: { seq: STRING },
    positionals: [],
    build: (values) => ({ kind: 'snapshot drop', seq: seqOf('seq', required(values, 'seq')) }),
  },
  backfill: {
    args: '--snapshot <n>',
    options: { snapshot: STRING },
    positionals: [],
    build: (values) => ({ kind: 'backfill', snapshotSeq: seqOf('snapshot', required(values, 'snapshot')) }),
  },
  feed: {
    args: '[--snapshot <n>]',
    options: { snapshot: STRING },
    positionals: [],
    build: (values) => {
      const snapshot = optional(values, 'snapshot');
      return snapshot === undefined ? { kind: 'feed' } : { kind: 'feed', snapshotSeq: seqOf('snapshot', snapshot) };
    },
  },
  transition: {
    args: '--to <vNNNN> [--poll-ms <ms>]',
    options: { to: STRING, 'poll-ms': STRING },
    positionals: [],
    build: (values) => {
      const pollMs = optional(values, 'poll-ms');
      const to = versionOf(required(values, 'to'));
      return { kind: 'transition', to, pollMs: pollMs === undefined ? DEFAULT_TRANSITION_POLL_MS : positiveIntOf('poll-ms', pollMs) };
    },
  },
  reconcile: {
    args: '--point <name> [--units <unit,...>]',
    options: { point: STRING, units: STRING },
    positionals: [],
    build: (values) => {
      const units = optional(values, 'units');
      const point = required(values, 'point');
      return units === undefined ? { kind: 'reconcile', point } : { kind: 'reconcile', point, units: listOf('units', units) };
    },
  },
  'rollback-set': { args: '', options: {}, positionals: [], build: () => ({ kind: 'rollback-set' }) },
  'rollback report': { args: '', options: {}, positionals: [], build: () => ({ kind: 'rollback report' }) },
  'rollback rebaseline': { args: '', options: {}, positionals: [], build: () => ({ kind: 'rollback rebaseline' }) },
  fault: {
    args: '<name> [--params <json>]',
    options: { params: STRING },
    positionals: ['name'],
    build: (values, [name = '']) => {
      const params = optional(values, 'params');
      return params === undefined ? { kind: 'fault', name } : { kind: 'fault', name, params: jsonOf('params', params) };
    },
  },
  'resolve-window': {
    args: '<windowId>',
    options: {},
    positionals: ['windowId'],
    build: (_values, [windowId = '']) => ({ kind: 'resolve-window', windowId }),
  },
  'window open': {
    args: '--units <unit,...> [--route <key>] [--scope <table|json>]',
    options: { units: STRING, route: STRING, scope: STRING },
    positionals: [],
    build: (values) => {
      const routeKey = optional(values, 'route');
      const scope = optional(values, 'scope');
      return {
        kind: 'window open',
        units: listOf('units', required(values, 'units')),
        ...(routeKey === undefined ? {} : { routeKey }),
        ...(scope === undefined ? {} : { scope: scopeOf(scope) }),
      };
    },
  },
  'window complete': {
    args: '<windowId> [--forwarded]',
    options: { forwarded: BOOLEAN },
    positionals: ['windowId'],
    build: (values, [windowId = '']) => ({ kind: 'window complete', windowId, forwarded: values.forwarded === true }),
  },
  'scheduler import': {
    args: '--file <path>',
    options: { file: STRING },
    positionals: [],
    build: (values) => ({ kind: 'scheduler import', file: required(values, 'file') }),
  },
  'scheduler status': { args: '', options: {}, positionals: [], build: () => ({ kind: 'scheduler status' }) },
  'files manifest': {
    args: '--snapshot <n>',
    options: { snapshot: STRING },
    positionals: [],
    build: (values) => ({ kind: 'files manifest', snapshotSeq: seqOf('snapshot', required(values, 'snapshot')) }),
  },
  'files transfer': {
    args: '--snapshot <n>',
    options: { snapshot: STRING },
    positionals: [],
    build: (values) => ({ kind: 'files transfer', snapshotSeq: seqOf('snapshot', required(values, 'snapshot')) }),
  },
} as const satisfies Record<CommandName, CommandSpec>;

const COMMAND_NAMES = Object.keys(SPECS) as CommandName[];

/** Words that only lead a subcommand, such as `rollback` in `rollback report`. */
const GROUPS: ReadonlySet<string> = new Set(
  COMMAND_NAMES.filter((name) => name.includes(' ')).map((name) => name.slice(0, name.indexOf(' '))),
);

function usageLine(name: CommandName): string {
  const { args } = SPECS[name];
  return `${CLI_NAME} ${name}${args === '' ? '' : ` ${args}`}`;
}

/** Usage text of every command. */
export const USAGE = [
  ...COMMAND_NAMES.map(usageLine),
  `${CLI_NAME} [<command>] --help`,
  '',
  'Each command except serve prints one JSON summary line on stdout.',
  'Exit codes: 0 success, 1 failure or reconciliation difference, 2 usage error.',
  '',
].join('\n');

/** Usage text of `topic`, a command or a group such as `window`, or of the whole CLI for `null`. */
export function usageFor(topic: string | null): string {
  if (topic === null) return USAGE;
  const names = COMMAND_NAMES.filter((name) => name === topic || name.startsWith(`${topic} `));
  return names.length === 0 ? USAGE : `${names.map(usageLine).join('\n')}\n`;
}

function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(SPECS, value);
}

function isHelpFlag(value: string | undefined): boolean {
  return value === '--help' || value === '-h';
}

/**
 * Parses the arguments after the script path; the only validation of the command line.
 * @throws MigrateUsageError on a missing or unknown command, an unknown flag, a missing or extra argument, or a malformed value.
 */
export function parseCommand(argv: readonly string[]): MigrateCommand {
  const [first, second] = argv;
  if (first === undefined) throw new MigrateUsageError('missing command');
  if (isHelpFlag(first)) return { kind: 'help', topic: null };
  const pair = `${first} ${second ?? ''}`;
  const name = isCommandName(pair) ? pair : isCommandName(first) ? first : undefined;
  if (name === undefined) {
    if (!GROUPS.has(first)) throw new MigrateUsageError(`unknown command ${JSON.stringify(first)}`);
    if (isHelpFlag(second)) return { kind: 'help', topic: first };
    const message =
      second === undefined || second.startsWith('-') ? `${first} needs a subcommand` : `unknown command ${JSON.stringify(pair)}`;
    throw new MigrateUsageError(message, usageFor(first));
  }
  const spec: CommandSpec = SPECS[name];
  const usage = usageFor(name);
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv.slice(name.split(' ').length),
      options: { ...spec.options, ...HELP_OPTION },
      strict: true,
      allowPositionals: true,
    }) as { values: Values; positionals: string[] };
  } catch (error) {
    throw new MigrateUsageError(error instanceof Error ? error.message : String(error), usage);
  }
  if (parsed.values.help === true) return { kind: 'help', topic: name };
  const { positionals } = parsed;
  const missing = spec.positionals[positionals.length];
  if (missing !== undefined) throw new MigrateUsageError(`${name} needs <${missing}>`, usage);
  const extra = positionals.slice(spec.positionals.length);
  if (extra.length > 0) throw new MigrateUsageError(`unexpected argument ${JSON.stringify(extra.join(' '))}`, usage);
  if (positionals.some((value) => value === '')) throw new MigrateUsageError(`<${spec.positionals.join('>, <')}> must not be empty`, usage);
  try {
    return spec.build(parsed.values, positionals);
  } catch (error) {
    if (error instanceof InvalidArgument) throw new MigrateUsageError(error.message, usage);
    throw error;
  }
}

/** Runs `opt2-migrate` with the arguments after the script path; resolves to 0 on success or help, 1 on failure, 2 on a usage error. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: MigrateIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let command: MigrateCommand;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof MigrateUsageError)) throw error;
    io.stderr.write(`${CLI_NAME}: ${error.message}\n${error.usage}`);
    return 2;
  }
  if (command.kind === 'help') {
    io.stdout.write(usageFor(command.topic));
    return 0;
  }
  return command.kind === 'serve' ? serve(io) : execute(command, io);
}

/** Starts the migration service and resolves once it listens; the process keeps running until service-kit shuts it down. */
async function serve(io: MigrateIo): Promise<number> {
  try {
    await startTracing(TRACING);
    // Loaded after tracing starts, so fastify, pg, http and undici are instrumented when they load.
    const { startServer } = await import('./server.js');
    await startServer();
    return 0;
  } catch (error) {
    writeFailure(io, 'serve', error);
    await stopTracing(io);
    return exitCodeOf(error);
  }
}

type Completed = { result: object; code: 0 | 1 };
type Outcome = ({ ok: true } & Completed) | { ok: false; error: unknown };

/** Builds the context, runs `command`, closes the context and writes the one summary line; resolves to its exit code. */
async function execute(command: ContextCommand, io: MigrateIo): Promise<number> {
  let ctx: MigrationContext | undefined;
  let outcome: Outcome;
  try {
    await startTracing(TRACING);
    // Loaded after tracing starts, as every command module is in `dispatch`.
    const { createMigrationContext } = await import('./context.js');
    ctx = await createMigrationContext();
    outcome = { ok: true, ...(await dispatch(command, ctx)) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await ctx?.close();
  } catch (error) {
    // A close failure becomes the outcome only when the command succeeded; otherwise the command's error is reported.
    if (outcome.ok) outcome = { ok: false, error };
    else writeStack(io, error);
  }

  let code: number;
  if (outcome.ok) {
    code = outcome.code;
    const line: Record<string, unknown> = { command: command.kind, ok: code === 0, ...outcome.result };
    // Reassigned, so a result field of the same name can neither replace them nor move them from the front.
    line.command = command.kind;
    line.ok = code === 0;
    writeLine(io, line);
  } else {
    code = exitCodeOf(outcome.error);
    writeFailure(io, command.kind, outcome.error);
  }
  await stopTracing(io);
  return code;
}

/** A result's own verdict: `exitCode` 1 where the module returns one, otherwise success. */
function completed(result: object): Completed {
  return { result, code: (result as { exitCode?: unknown }).exitCode === 1 ? 1 : 0 };
}

/** Loads the command's module after tracing has started and runs it against `ctx`. */
async function dispatch(command: ContextCommand, ctx: MigrationContext): Promise<Completed> {
  switch (command.kind) {
    case 'init-legacy':
      return completed(await (await import('./legacy/init-legacy.js')).initLegacy(ctx));
    case 'snapshot':
      return completed(await (await import('./snapshot/index.js')).takeSnapshot(ctx, { kind: command.snapshotKind }));
    case 'snapshot restore':
      return completed(await (await import('./snapshot/index.js')).restoreLiveFromSnapshot(ctx, command.seq));
    case 'snapshot drop':
      return completed(await (await import('./snapshot/index.js')).dropSnapshot(ctx, command.seq));
    case 'backfill':
      return completed(await (await import('./apply/index.js')).runBackfill(ctx, { snapshotSeq: command.snapshotSeq }));
    case 'feed': {
      const options = command.snapshotSeq === undefined ? {} : { snapshotSeq: command.snapshotSeq };
      return completed(await (await import('./apply/index.js')).runFeed(ctx, options));
    }
    case 'transition': {
      const { requestTransition } = await import('./transition/index.js');
      const transition = await requestTransition(ctx, { to: command.to, pollMs: command.pollMs });
      return { result: transition, code: transition.state === 'completed' ? 0 : 1 };
    }
    case 'reconcile': {
      const options = command.units === undefined ? { point: command.point } : { point: command.point, units: command.units };
      return completed(await (await import('./reconcile/index.js')).runReconcile(ctx, options));
    }
    case 'rollback-set':
      return completed((await import('./rollback/index.js')).computeRollbackSet(ctx));
    case 'rollback report':
      return completed(await (await import('./rollback/index.js')).writeRollbackReport(ctx));
    case 'rollback rebaseline':
      return completed(await (await import('./rollback/index.js')).rebaselineRollbackSet(ctx));
    case 'fault':
      return completed(await (await import('./faults/index.js')).runFault(ctx, command.name, command.params));
    case 'resolve-window':
      return completed(await (await import('./windows/index.js')).resolveWindowViaService(ctx, command.windowId));
    case 'window open': {
      const input = { units: command.units, routeKey: command.routeKey, scope: command.scope };
      return completed(await (await import('./windows/index.js')).openWindowViaService(ctx, input));
    }
    case 'window complete':
      return completed(
        await (await import('./windows/index.js')).completeWindowViaService(ctx, command.windowId, { forwarded: command.forwarded }),
      );
    case 'scheduler import':
      return completed(await (await import('./scheduler/index.js')).importSchedulerState(ctx, command.file));
    case 'scheduler status':
      return completed(await (await import('./scheduler/index.js')).schedulerStatus(ctx));
    case 'files manifest':
      return completed(await (await import('./files/index.js')).buildFileManifest(ctx, command.snapshotSeq));
    case 'files transfer':
      return completed(await (await import('./files/index.js')).transferFiles(ctx, command.snapshotSeq));
  }
}

/** 2 for the errors their modules document as usage errors of this CLI, else 1. */
function exitCodeOf(error: unknown): 1 | 2 {
  return error instanceof Error && MODULE_USAGE_ERRORS.has(error.name) ? 2 : 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `text` with every secret value replaced and every URL query or fragment removed. */
function redact(text: string): string {
  let out = text;
  for (const name of SECRET_VARIABLES) {
    const secret = process.env[name];
    if (secret !== undefined && secret !== '') out = out.split(secret).join(REDACTED);
  }
  return out.replace(URL_QUERY, '$1');
}

/** Writes `value` as one JSON line on stdout, every string redacted and every bigint as its decimal string. */
function writeLine(io: MigrateIo, value: object): void {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'string') return redact(item);
    return typeof item === 'bigint' ? item.toString() : item;
  });
  io.stdout.write(`${json}\n`);
}

/** Writes the stack of `error`, redacted, to stderr. */
function writeStack(io: MigrateIo, error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  io.stderr.write(`${redact(text)}\n`);
}

/** Writes the stack to stderr and `{command, ok: false, error: {type, message}}` to stdout. */
function writeFailure(io: MigrateIo, command: CommandName, error: unknown): void {
  writeStack(io, error);
  const type = error instanceof Error ? error.name : typeof error;
  writeLine(io, { command, ok: false, error: { type, message: messageOf(error) } });
}

/** Flushes and stops tracing; a failed final export is noted on stderr and leaves the exit code unchanged. */
async function stopTracing(io: MigrateIo): Promise<void> {
  try {
    await shutdownTracing();
  } catch (error) {
    io.stderr.write(`${CLI_NAME}: exporting traces failed: ${redact(messageOf(error))}\n`);
  }
}

// npm links bins as symlinks and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
