#!/usr/bin/env node
// `opt2-db` CLI: bootstraps every OPT-2 schema with its role chain and migrations, and prints one JSON summary line.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createLogger, serializeError, type Logger } from '@opt2/platform/logging';

import type { MigrateIo } from '../cli.js';
import { loadConfig } from '../config.js';
import { BOOTSTRAP_TARGETS, loadBootstrapEnv, missingForTarget, type BootstrapTarget } from './env.js';
import { bootstrap, BootstrapEnvError } from './index.js';

const CLI_NAME = 'opt2-db';
const TARGET_FLAG = '--target';
const HELP_TOKENS: ReadonlySet<string> = new Set(['--help', '-h', 'help']);

/** Usage text, written on `--help` and after a usage error. */
export const USAGE = [
  `Usage: ${CLI_NAME} bootstrap ${TARGET_FLAG} ${BOOTSTRAP_TARGETS.join('|')}`,
  `       ${CLI_NAME} --help`,
  '',
  '  local  drops and recreates every OPT-2 schema and role; role passwords from $OPT2_STATE_DIR/secrets/db-<schema>-{app,migrator}',
  '  cloud  Cloud SQL as the built-in postgres admin plus IAM users; refuses schemas that already hold tables',
  '',
  'Prints one JSON summary line on stdout. Exit codes: 0 success, 1 failure or role-assertion finding, 2 usage error.',
  '',
].join('\n');

/** A parsed `opt2-db` invocation. */
export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'bootstrap'; target: BootstrapTarget }
  | { kind: 'usage-error'; message: string };

function isTarget(value: string): value is BootstrapTarget {
  return (BOOTSTRAP_TARGETS as readonly string[]).includes(value);
}

function usageError(message: string): ParsedArgs {
  return { kind: 'usage-error', message };
}

/** Parses the arguments after the script path; the only validation of the command line. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.some((token) => HELP_TOKENS.has(token))) return { kind: 'help' };
  const [command, ...rest] = argv;
  if (command === undefined || command.startsWith('-')) return usageError('missing command');
  if (command !== 'bootstrap') return usageError(`unknown command ${JSON.stringify(command)}`);
  const values: string[] = [];
  for (let token = rest.shift(); token !== undefined; token = rest.shift()) {
    if (token === TARGET_FLAG) {
      const value = rest.shift();
      if (value === undefined) return usageError(`${TARGET_FLAG} needs a value`);
      values.push(value);
    } else if (token.startsWith(`${TARGET_FLAG}=`)) {
      values.push(token.slice(TARGET_FLAG.length + 1));
    } else {
      return usageError(`${token.startsWith('-') ? 'unknown option' : 'unexpected argument'} ${JSON.stringify(token)}`);
    }
  }
  const [target, extra] = values;
  if (extra !== undefined) return usageError(`${TARGET_FLAG} given more than once`);
  if (target === undefined) return usageError(`${TARGET_FLAG} ${BOOTSTRAP_TARGETS.join('|')} is required`);
  if (!isTarget(target)) {
    return usageError(`${TARGET_FLAG} must be one of ${BOOTSTRAP_TARGETS.join(', ')}, got ${JSON.stringify(target)}`);
  }
  return { kind: 'bootstrap', target };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `opt2-db` with the arguments after the script path, reading the bootstrap variables from `source`.
 * @returns 0 on success or help, 1 on a failure or a role-assertion finding, 2 on a usage error.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: MigrateIo = { stdout: process.stdout, stderr: process.stderr },
  source: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === 'usage-error') {
    io.stderr.write(`${CLI_NAME}: ${parsed.message}\n${USAGE}`);
    return 2;
  }
  const { target } = parsed;
  let logger: Logger | undefined;
  try {
    const env = loadBootstrapEnv(source);
    // Checked before the logger exists: a cloud logger needs GOOGLE_CLOUD_PROJECT, and its refusal would hide the other missing names.
    const missing = missingForTarget(env, target);
    if (missing.length > 0) throw new BootstrapEnvError(missing);
    const config = loadConfig();
    // stderr, so stdout carries only the summary line; `env: target` gives cloud runs the Cloud Logging trace keys.
    logger = createLogger({
      service: 'db-bootstrap',
      version: '1.0.0',
      env: target,
      googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
      destination: io.stderr,
    });
    const summary = await bootstrap({ target, env, config, logger });
    io.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary.ok ? 0 : 1;
  } catch (error) {
    if (logger === undefined) io.stderr.write(`${CLI_NAME}: bootstrap failed: ${messageOf(error)}\n`);
    else logger.error({ error: serializeError(error) }, 'bootstrap failed');
    io.stdout.write(`${JSON.stringify({ command: 'bootstrap', target, ok: false, error: messageOf(error) })}\n`);
    return 1;
  }
}

// npm links bins as symlinks and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await main();
}
