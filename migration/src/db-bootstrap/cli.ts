#!/usr/bin/env node
// `opt2-db` CLI: bootstraps every OPT-2 schema with its role chain and migrations, or tears them down locally, and
// prints one JSON summary line.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import * as logging from '@opt2/platform/logging';

import { logFailure, safeFailure, stderrLogger, writeLine } from '../cli-diagnostics.js';
import type { MigrateIo } from '../cli.js';
import { loadConfig } from '../config.js';
import { BOOTSTRAP_TARGETS, loadBootstrapEnv, missingForTarget, type BootstrapTarget } from './env.js';
import { bootstrap, BootstrapEnvError, teardown } from './index.js';
import { MigrationFailedError, SchemaNotEmptyError } from './migrations.js';

const CLI_NAME = 'opt2-db';
const LOGGER_IDENTITY = { service: 'db-bootstrap', version: '1.0.0' } as const;
const TARGET_FLAG = '--target';
const HELP_TOKENS: ReadonlySet<string> = new Set(['--help', '-h', 'help']);

type CommandName = 'bootstrap' | 'teardown';
// The cloud bootstrap is declared but never executed, so only a local stack is torn down.
const TARGETS_OF: Readonly<Record<CommandName, readonly BootstrapTarget[]>> = {
  bootstrap: BOOTSTRAP_TARGETS,
  teardown: ['local'],
};

const SYNOPSIS = [
  `Usage: ${CLI_NAME} bootstrap ${TARGET_FLAG} ${BOOTSTRAP_TARGETS.join('|')}`,
  `       ${CLI_NAME} teardown ${TARGET_FLAG} ${TARGETS_OF.teardown.join('|')}`,
  `       ${CLI_NAME} --help`,
  '',
  '  local  drops and recreates every OPT-2 schema and role; role passwords from $OPT2_STATE_DIR/secrets/db-<schema>-{app,migrator}',
  '  cloud  Cloud SQL as the built-in postgres admin plus IAM users; refuses schemas that already hold tables',
  '',
  'teardown drops every OPT-2 schema and its roles from local PostgreSQL; it is repeatable and reads no password file.',
  '',
];
const SUMMARY_NOTE = 'Prints one JSON summary line on stdout.';
const EXIT_CODES = 'Exit codes: 0 success, 1 failure (an invalid environment included) or role-assertion finding, 2 usage error.';

/** Usage text, written after a usage error. */
export const USAGE = [...SYNOPSIS, `${SUMMARY_NOTE} ${EXIT_CODES}`, ''].join('\n');

/** Help, written on `--help`: usage, the variables of each target, exit codes, documentation and an example. */
export const HELP = [
  ...SYNOPSIS,
  SUMMARY_NOTE,
  'Environment:',
  '  OPT2_ENV                      local or cloud (required)',
  '  PG_DATABASE                   PostgreSQL database of every OPT-2 schema (required)',
  '  PG_HOST                       PostgreSQL host (required for --target local)',
  '  PG_PORT                       PostgreSQL port (required for --target local)',
  '  PG_USER                       administrator role with CREATEROLE and CREATE on PG_DATABASE, never a <svc>_app role',
  '                                (required for --target local)',
  '  PG_PASSWORD                   password of PG_USER (required for --target local)',
  '  OPT2_STATE_DIR                absolute directory outside the checkout; --target local reads the role passwords',
  '                                from its secrets/db-<schema>-{app,migrator} (default: ~/.opt2/state)',
  '  CLOUD_SQL_INSTANCE            <project>:<region>:<instance> (required for --target cloud)',
  '  GOOGLE_CLOUD_PROJECT          project of the service accounts and their IAM database users',
  '                                (required for --target cloud)',
  "  OPT2_CLOUDSQL_ADMIN_PASSWORD  password of Cloud SQL's built-in postgres user, in the cloud the Secret Manager",
  '                                secret cloudsql-admin-password (required for --target cloud)',
  EXIT_CODES,
  'Documentation: migration/README.md, section "Bootstrap environment".',
  'Example, from the repository root with the local variables above exported:',
  `  OPT2_ENV=local node migration/dist/db-bootstrap/cli.js bootstrap ${TARGET_FLAG} local`,
  '',
].join('\n');

/** A parsed `opt2-db` invocation. */
export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'bootstrap'; target: BootstrapTarget }
  | { kind: 'teardown'; target: 'local' }
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
  if (command !== 'bootstrap' && command !== 'teardown') return usageError(`unknown command ${JSON.stringify(command)}`);
  const allowed = TARGETS_OF[command];
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
  if (target === undefined) return usageError(`${TARGET_FLAG} ${allowed.join('|')} is required`);
  if (!isTarget(target)) {
    return usageError(`${TARGET_FLAG} must be one of ${allowed.join(', ')}, got ${JSON.stringify(target)}`);
  }
  if (!allowed.includes(target)) {
    return usageError(`${command} supports only ${TARGET_FLAG} ${allowed.join('|')}, not ${JSON.stringify(target)}`);
  }
  return command === 'bootstrap' ? { kind: command, target } : { kind: command, target: 'local' };
}

/** `safeFailure` of `error`, then the fields naming what failed. */
function failureOf(error: unknown): Record<string, unknown> {
  return { ...safeFailure(logging, error), ...detailsOf(error) };
}

/** File, SQLSTATE and location of a failed migration, or the schemas a refused cloud bootstrap found holding tables. */
function detailsOf(error: unknown): Record<string, unknown> {
  if (error instanceof MigrationFailedError) {
    const { file, sqlState, line, position } = error;
    return { file, sqlState, line, position };
  }
  if (error instanceof SchemaNotEmptyError) return { schemas: error.schemas };
  return {};
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
    io.stdout.write(HELP);
    return 0;
  }
  if (parsed.kind === 'usage-error') {
    io.stderr.write(`${CLI_NAME}: ${parsed.message}\n${USAGE}`);
    return 2;
  }
  const { kind: command, target } = parsed;
  let logger: logging.Logger | undefined;
  try {
    const env = loadBootstrapEnv(source);
    // Checked before the logger exists: a cloud logger needs GOOGLE_CLOUD_PROJECT, and its refusal would hide the other missing names.
    const missing = missingForTarget(env, target);
    if (missing.length > 0) throw new BootstrapEnvError(missing);
    const config = loadConfig();
    // stderr, so stdout carries only the summary line; `env: target` gives cloud runs the Cloud Logging trace keys.
    logger = logging.createLogger({
      ...LOGGER_IDENTITY,
      env: target,
      googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
      destination: io.stderr,
    });
    const summary =
      command === 'bootstrap' ? await bootstrap({ target, env, config, logger }) : await teardown({ env, config, logger });
    io.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary.ok ? 0 : 1;
  } catch (error) {
    // Before the logger exists, the same identity logs on stderr, as local when the cloud project cannot form the trace key.
    const failureLogger =
      logger ?? stderrLogger(logging, io, { ...LOGGER_IDENTITY, env: target, googleCloudProject: source.GOOGLE_CLOUD_PROJECT });
    logFailure(logging, failureLogger, `${command} failed`, error);
    writeLine(logging, io, { command, target, ok: false, error: failureOf(error) });
    return 1;
  }
}

// npm links bins as symlinks and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await main();
}
