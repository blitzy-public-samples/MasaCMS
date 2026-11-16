#!/usr/bin/env node
// `opt2-ops` CLI: drains and suspends background work before checkpoint `Ck`, seeks the consumer subscriptions to its time, and resumes.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { Logger } from '@opt2/platform/logging';
import { shutdownTracing, startTracing } from '@opt2/platform/tracing';

import { logFailure, safeFailure, stderrLogger, withSafeErrors, writeLine } from '../cli-diagnostics.js';
import type { MigrationContext } from '../context.js';
import { MIGRATION_ENVIRONMENT_HELP } from '../env-help.js';
import type { DrainAndSuspendResult, ResumeResult, SeekResult } from './index.js';

// The logging barrel loads Fastify, so it is imported only once tracing has started or failed.
type LoggingModule = typeof import('@opt2/platform/logging');

/** Usage text, written after a usage error. */
export const USAGE = [
  'opt2-ops drain-and-suspend',
  'opt2-ops resume',
  'opt2-ops seek-subscriptions --to <ISO-8601 time>',
  'opt2-ops --help',
  '',
].join('\n');

/** Help, written on `--help`: usage, environment, exit codes, documentation and an example. */
export const HELP = [
  USAGE,
  'Drains and suspends background work before checkpoint Ck, seeks the consumer subscriptions to its time, and resumes.',
  'Each command prints one JSON summary line on stdout.',
  `${MIGRATION_ENVIRONMENT_HELP}Exit codes: 0 success, 1 failure (an invalid environment included), 2 usage error.`,
  'Documentation: migration/README.md, sections "Runtime forms" and "Environment".',
  'Example, from the repository root with the variables above exported:',
  '  node migration/dist/quiesce/cli.js seek-subscriptions --to 2026-06-30T00:00:00Z',
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
    io.stdout.write(HELP);
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
  // Tracing has started or failed by now.
  const logging = await import('@opt2/platform/logging');

  try {
    await ctx?.close();
  } catch (error) {
    // A close failure becomes the outcome only when the command succeeded; otherwise the command's error is reported.
    if (outcome.ok) outcome = { ok: false, error };
    else logFailure(logging, diagnosticLogger(logging, io), `${SERVICE_NAME} ${command.kind}: closing the context failed`, error);
  }

  let code: number;
  if (outcome.ok) {
    writeLine(logging, io, { command: command.kind, ok: true, ...outcome.result });
    code = 0;
  } else {
    logFailure(logging, diagnosticLogger(logging, io), `${SERVICE_NAME} ${command.kind} failed`, outcome.error);
    writeLine(logging, io, { command: command.kind, ok: false, error: errorSummary(logging, outcome.error, quiesce) });
    code = 1;
  }

  try {
    await shutdownTracing();
  } catch (error) {
    // The command has finished and its line is written; a failed final span export does not change its exit code.
    diagnosticLogger(logging, io).warn({ error: logging.serializeError(error) }, `${SERVICE_NAME}: exporting traces failed`);
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

/** `safeFailure` of `error`, then the fields naming what failed with every nested error text reduced to its safe text. */
function errorSummary(logging: LoggingModule, error: unknown, quiesce: QuiesceModule | undefined): Record<string, unknown> {
  return { ...safeFailure(logging, error), ...withSafeErrors(logging, detailsOf(error, quiesce)) };
}

/** Counts, owners, queues, rows, subscriptions, operation, owner and status of a known failure; response bodies are left out. */
function detailsOf(error: unknown, quiesce: QuiesceModule | undefined): Record<string, unknown> {
  if (!(error instanceof Error)) return {};
  if (quiesce !== undefined) {
    if (error instanceof quiesce.DrainTimeoutError) return { timeoutMs: error.timeoutMs, owners: error.owners };
    if (error instanceof quiesce.InvocationsRunningError) return { timeoutMs: error.timeoutMs, queues: error.queues };
    if (error instanceof quiesce.OrphanedWritesError) return { rows: error.rows };
    if (error instanceof quiesce.SeekVerificationError) return { nonEmpty: error.nonEmpty };
    if (error instanceof quiesce.MissingSubscriptionError || error instanceof quiesce.UnlistedProducerError) {
      return { subscriptions: error.subscriptions };
    }
    if (error instanceof quiesce.ResumeReconcileError) return { failed: error.failed };
    if (error instanceof quiesce.BackgroundCallError) return { operation: error.operation, status: error.status };
  }
  if (isOwnerCallError(error)) return { owner: error.owner, status: error.status };
  return {};
}

/** Matches `OwnerCallError` of `owners/client.ts` and its subclasses by their `owner` and `status` fields, without importing the owners module. */
function isOwnerCallError(error: Error): error is Error & { owner: string; status: number } {
  const { owner, status } = error as { owner?: unknown; status?: unknown };
  return typeof owner === 'string' && typeof status === 'number';
}

/** The stderr logger of `opt2-ops` diagnostics: service OPT2_SERVICE_NAME or `opt2-ops`, env `cloud` only with a usable project. */
function diagnosticLogger(logging: LoggingModule, io: OpsIo): Logger {
  const { OPT2_ENV, OPT2_SERVICE_NAME, GOOGLE_CLOUD_PROJECT } = process.env;
  const service = OPT2_SERVICE_NAME || SERVICE_NAME;
  return stderrLogger(logging, io, { service, version: SERVICE_VERSION, env: OPT2_ENV, googleCloudProject: GOOGLE_CLOUD_PROJECT });
}

// npm links bins as symlinks and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
