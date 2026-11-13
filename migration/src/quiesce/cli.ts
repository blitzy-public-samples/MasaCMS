#!/usr/bin/env node
// `opt2-ops` CLI: drains and suspends background work before checkpoint `Ck`, seeks the consumer subscriptions to its time, and resumes.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { shutdownTracing, startTracing } from '@opt2/platform/tracing';

import type { MigrationContext } from '../context.js';
import type { DrainAndSuspendResult, ResumeResult, SeekResult } from './index.js';

/** Usage text, written on `--help` and after a usage error. */
export const USAGE = [
  'opt2-ops drain-and-suspend',
  'opt2-ops resume',
  'opt2-ops seek-subscriptions --to <ISO-8601 time>',
  'opt2-ops --help',
  '',
].join('\n');

/** A parsed `opt2-ops` invocation; `to` is in `Date.prototype.toISOString` form. */
export type OpsCommand =
  | { kind: 'drain-and-suspend' }
  | { kind: 'resume' }
  | { kind: 'seek-subscriptions'; to: string }
  | { kind: 'help' };

/** Invalid command line; `main` answers it on stderr with the usage and exit code 2. */
export class OpsUsageError extends Error {
  override readonly name: string = 'OpsUsageError';
}

/** Streams `main` writes its output to. */
export interface OpsIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const SERVICE_NAME = 'opt2-ops';
const SERVICE_VERSION = '1.0.0';

const COMMANDS = ['drain-and-suspend', 'resume', 'seek-subscriptions'] as const;

type RunCommand = Exclude<OpsCommand, { kind: 'help' }>;

type QuiesceModule = typeof import('./index.js');

type CommandResult = DrainAndSuspendResult | ResumeResult | SeekResult;

type Outcome = { ok: true; result: CommandResult } | { ok: false; error: unknown };

// A local push endpoint carries the push key in its query string, so no URL in the output keeps its query or fragment.
const URL_QUERY = /(\bhttps?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/g;

function isCommand(value: string): value is (typeof COMMANDS)[number] {
  return (COMMANDS as readonly string[]).includes(value);
}

/**
 * Parses the arguments after the script path; the only validation of `--to`.
 * @throws OpsUsageError on a missing or unknown command, an unknown flag or extra argument, or a missing or unparsable `--to`.
 */
export function parseOpsCommand(argv: readonly string[]): OpsCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: { to: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
    });
  } catch (err) {
    throw new OpsUsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  const [kind, ...extra] = positionals;
  if (kind === undefined) throw new OpsUsageError('missing command');
  if (!isCommand(kind)) throw new OpsUsageError(`unknown command ${JSON.stringify(kind)}`);
  if (extra.length > 0) throw new OpsUsageError(`unexpected argument ${JSON.stringify(extra.join(' '))}`);
  if (kind !== 'seek-subscriptions') {
    if (values.to !== undefined) throw new OpsUsageError(`--to applies only to seek-subscriptions`);
    return { kind };
  }
  if (values.to === undefined) throw new OpsUsageError('seek-subscriptions needs --to <ISO-8601 time>');
  if (Number.isNaN(Date.parse(values.to))) throw new OpsUsageError(`--to is not a time: ${JSON.stringify(values.to)}`);
  return { kind, to: new Date(values.to).toISOString() };
}

/** Runs `opt2-ops` with the arguments after the script path; resolves to 0 on success or help, 1 when the command fails, 2 on a usage error. */
export async function main(
  argv: readonly string[],
  io: OpsIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let command: OpsCommand;
  try {
    command = parseOpsCommand(argv);
  } catch (err) {
    if (!(err instanceof OpsUsageError)) throw err;
    io.stderr.write(`${SERVICE_NAME}: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (command.kind === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  return run(command, io);
}

/** Builds the context, runs `command`, closes the context and writes the one summary line; resolves to its exit code. */
async function run(command: RunCommand, io: OpsIo): Promise<number> {
  let quiesce: QuiesceModule | undefined;
  let ctx: MigrationContext | undefined;
  let outcome: Outcome;
  try {
    await startTracing({ serviceName: SERVICE_NAME, version: SERVICE_VERSION });
    // Loaded after tracing starts, so pg, http and undici are instrumented when they load.
    const { createMigrationContext } = await import('../context.js');
    quiesce = await import('./index.js');
    ctx = await createMigrationContext();
    outcome = { ok: true, result: await dispatch(command, ctx, quiesce) };
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
    writeLine(io, { command: command.kind, ok: true, ...outcome.result });
    code = 0;
  } else {
    writeStack(io, outcome.error);
    writeLine(io, { command: command.kind, ok: false, error: errorSummary(outcome.error, quiesce) });
    code = 1;
  }

  try {
    await shutdownTracing();
  } catch (error) {
    // The command has finished and its line is written; a failed final span export does not change its exit code.
    io.stderr.write(`${SERVICE_NAME}: exporting traces failed: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  }
  return code;
}

/** Runs `command` with the module functions' default ports, so background record writes go through `remoteBackgroundState(ctx)`. */
function dispatch(command: RunCommand, ctx: MigrationContext, quiesce: QuiesceModule): Promise<CommandResult> {
  switch (command.kind) {
    case 'drain-and-suspend':
      return quiesce.drainAndSuspend(ctx);
    case 'resume':
      return quiesce.resume(ctx);
    case 'seek-subscriptions':
      return quiesce.seekSubscriptions(ctx, command.to);
  }
}

/** `{type, message}` of `error` plus the fields naming what failed; response bodies are left out. */
function errorSummary(error: unknown, quiesce: QuiesceModule | undefined): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: typeof error, message: String(error) };
  const summary = { type: error.name, message: error.message };
  if (quiesce !== undefined) {
    if (error instanceof quiesce.DrainTimeoutError) return { ...summary, timeoutMs: error.timeoutMs, owners: error.owners };
    if (error instanceof quiesce.SeekVerificationError) return { ...summary, nonEmpty: error.nonEmpty };
    if (error instanceof quiesce.MissingSubscriptionError || error instanceof quiesce.UnlistedProducerError) {
      return { ...summary, subscriptions: error.subscriptions };
    }
    if (error instanceof quiesce.ResumeReconcileError) return { ...summary, failed: error.failed };
    if (error instanceof quiesce.BackgroundCallError) return { ...summary, operation: error.operation, status: error.status };
  }
  if (isOwnerCallError(error)) return { ...summary, owner: error.owner, status: error.status };
  return summary;
}

/** Matches `OwnerCallError` of `owners/client.ts` and its subclasses by their `owner` and `status` fields, without importing the owners module. */
function isOwnerCallError(error: Error): error is Error & { owner: string; status: number } {
  const { owner, status } = error as { owner?: unknown; status?: unknown };
  return typeof owner === 'string' && typeof status === 'number';
}

function redact(text: string): string {
  return text.replace(URL_QUERY, '$1');
}

/** Writes `value` as one JSON line on stdout, every string value without URL queries. */
function writeLine(io: OpsIo, value: object): void {
  io.stdout.write(`${JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? redact(item) : item))}\n`);
}

/** Writes the stack of `error`, without URL queries, to stderr. */
function writeStack(io: OpsIo, error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  io.stderr.write(`${redact(text)}\n`);
}

// npm links bins as symlinks and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
