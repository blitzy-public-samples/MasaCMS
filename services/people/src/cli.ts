#!/usr/bin/env node
// `opt2-people` CLI: `resolve-operation` resolves one roster operation, typically a halted one, through roster recovery.
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseCliArgs } from 'node:util';
import {
  createCloudInvocationMinter,
  createLocalInvocationMinter,
  loadLocalSigningKeys,
  type InvocationMinter,
} from '@opt2/platform/auth';
import { createPublisher, type EventPublisher } from '@opt2/platform/events';
import { createLogger, serializeError, type Logger } from '@opt2/platform/logging';
import { createOutbox } from '@opt2/platform/outbox';
import {
  EnvValidationError,
  IDENTITY_SERVICE,
  ServiceUnavailableError,
  baseEnvSchema,
  createServiceClient,
  loadEnv,
  publisherEmulatorHost,
  systemClock,
  type BaseEnv,
  type ServiceClient,
} from '@opt2/platform/service-kit';
import {
  InvalidTenantIdError,
  assertTenantId,
  createPool,
  registeredTenants,
  withTenant,
  type DbEnv,
  type TenantDb,
} from '@opt2/platform/tenancy';
import { RosterResolutionError, resolveOperation, type RecoveryDeps, type ResolveAction, type ResolveTarget } from './domain/roster-recovery.js';
import { createPeopleEvents } from './events/publish.js';
import { peoplePayloadValidators } from './events/topics.js';
import { createIdentityClient, type AccountOperationState } from './legacy/identity-client.js';
import { OWNER, SCHEMA, createPeopleRepository } from './repo/repository.js';
import { FINISH_PENDING_ERROR, type RosterOperationRow, type RosterState } from './repo/tables.js';

const CLI = 'opt2-people';

const USAGE = `usage: ${CLI} resolve-operation <operationId> [--to rolled-back|done] [--tenant <uuid>]`;

const HELP = `${USAGE}

Resolves one roster operation from its and identity's recorded states, as the outbox-sweep recovery does, or towards
--to. A halted operation is resolved only with --to. Prints one JSON line:
{ operationId, tenantId, from, to, identityState, outcome }.
  --to rolled-back      abort or revert identity and restore people's before-image (identity prepared or committed)
  --to done             finish both sides (identity committed or finished; people committed)
  --tenant <uuid>       tenant holding the operation (default: search every tenant in people.tenant_registry)
  -h, --help            print this help
Environment: the people service's own (OPT2_ENV, OPT2_DB_AUTH, PG_*, OPT2_SERVICE_URLS naming identity,
OPT2_STATE_DIR when OPT2_ENV=local, PUBSUB_EMULATOR_HOST or GOOGLE_CLOUD_PROJECT, TZ and the token settings).
Exit codes: 0 the operation stands resolved, 1 not found, refused, identity unavailable, left unresolved or an error,
2 usage or environment error.
`;

/** Pub/Sub project of a local run without GOOGLE_CLOUD_PROJECT; the cloud mode requires the variable. */
const LOCAL_PROJECT_ID = 'opt2-local';

const TARGETS: readonly ResolveTarget[] = ['rolled-back', 'done'];

/** Arguments of `opt2-people resolve-operation`; `tenant` is lower-cased. */
export interface ResolveOperationArgs {
  command: 'resolve-operation';
  operationId: string;
  to?: ResolveTarget;
  tenant?: string;
}

/** The JSON line a run prints; `identityState` is null when identity did not answer or holds no record. */
export interface ResolveReport {
  operationId: string;
  tenantId: string;
  from: RosterState;
  to: RosterState;
  identityState: AccountOperationState | null;
  outcome: ResolveAction;
}

/** One run's report and whether the operation now stands resolved: rolled back, or done with identity's finish acknowledged. */
export interface ResolveRun {
  report: ResolveReport;
  settled: boolean;
}

/** Invalid command-line usage; answered on stderr with the usage line and exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** No searched tenant holds the operation. */
export class OperationNotFoundError extends Error {
  override readonly name = 'OperationNotFoundError';

  constructor(
    readonly operationId: string,
    tenant?: string,
  ) {
    super(`Roster operation ${operationId} is held by ${tenant === undefined ? 'no registered tenant' : `no row of tenant ${tenant}`}`);
  }
}

/** Parses `resolve-operation <operationId>` and its options; `'help'` for `--help` or `-h`; throws UsageError on any invalid usage. */
export function parseArgs(argv: string[]): ResolveOperationArgs | 'help' {
  let parsed;
  try {
    parsed = parseCliArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        to: { type: 'string' },
        tenant: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  const { values, positionals } = parsed;
  if (values.help) return 'help';
  const [command, operationId, ...extra] = positionals;
  if (command === undefined) throw new UsageError('missing subcommand');
  if (command !== 'resolve-operation') throw new UsageError(`unknown subcommand ${JSON.stringify(command)}`);
  if (operationId === undefined || operationId === '') throw new UsageError('missing operation id');
  if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  const { to, tenant } = values;
  if (to !== undefined && !isTarget(to)) throw new UsageError(`--to must be one of ${TARGETS.join(', ')}, got ${JSON.stringify(to)}`);
  return { command, operationId, ...(to === undefined ? {} : { to }), ...(tenant === undefined ? {} : { tenant: tenantArg(tenant) }) };
}

function isTarget(value: string): value is ResolveTarget {
  return (TARGETS as readonly string[]).includes(value);
}

function tenantArg(value: string): string {
  try {
    return assertTenantId(value);
  } catch (err) {
    if (err instanceof InvalidTenantIdError) throw new UsageError(`--tenant must be a tenant UUID, got ${JSON.stringify(value)}`);
    throw err;
  }
}

/** Whether nothing is left to resolve: rolled back, or done with no identity finish pending. */
function isSettled(row: RosterOperationRow | null): boolean {
  return row !== null && (row.state === 'rolled-back' || (row.state === 'done' && row.error !== FINISH_PENDING_ERROR));
}

/** The tenant holding the operation: `tenant` when given, else the first registered tenant whose own transaction reads it. */
async function locateTenant(deps: Pick<RecoveryDeps, 'db' | 'repo'>, operationId: string, tenant?: string): Promise<string> {
  // Case-folded as withTenant folds them, so one tenant is never read twice.
  const candidates = tenant === undefined ? new Set((await registeredTenants(deps.db)).map((entry) => entry.tenantId.toLowerCase())) : [tenant];
  for (const tenantId of candidates) {
    const row = await withTenant(deps.db, tenantId, (tx) => deps.repo.findRosterOperation(tx, operationId));
    if (row !== null) return tenantId;
  }
  throw new OperationNotFoundError(operationId, tenant);
}

/** Locates and resolves one roster operation; throws OperationNotFoundError, RosterResolutionError or identity's ServiceUnavailableError, changing nothing. */
export async function runResolveOperation(deps: RecoveryDeps, args: Omit<ResolveOperationArgs, 'command'>): Promise<ResolveRun> {
  const { operationId, to } = args;
  const tenantId = await locateTenant(deps, operationId, args.tenant);
  const outcome = await resolveOperation(deps, { tenantId, operationId, ...(to === undefined ? {} : { to }) });
  const report: ResolveReport = {
    operationId: outcome.operationId,
    tenantId,
    from: outcome.from,
    to: outcome.to,
    identityState: outcome.identityState ?? null,
    outcome: outcome.action,
  };
  // An unchanged outcome is settled only when the operation already was; a done one may still owe identity's finish.
  const settled =
    outcome.action === 'unchanged'
      ? isSettled(await withTenant(deps.db, tenantId, (tx) => deps.repo.findRosterOperation(tx, operationId)))
      : outcome.action !== 'halted';
  return { report, settled };
}

/** Runs `opt2-people` with the arguments after the script path and the process environment; returns the exit code HELP lists. */
export async function main(argv: string[] = process.argv.slice(2), source: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: ResolveOperationArgs;
  let env: CliEnv;
  try {
    const parsed = parseArgs(argv);
    if (parsed === 'help') {
      await writeStdout(HELP);
      return 0;
    }
    args = parsed;
    env = loadCliEnv(source);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${CLI}: ${err.message}; ${USAGE}\n`);
      return 2;
    }
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  // stderr, so stdout carries only the report line.
  const { base } = env;
  const logger = createLogger({
    service: OWNER,
    version: await peopleVersion(),
    env: base.OPT2_ENV,
    googleCloudProject: base.GOOGLE_CLOUD_PROJECT,
    destination: process.stderr,
    ...(base.LOG_LEVEL === undefined ? {} : { level: base.LOG_LEVEL }),
  });
  try {
    const { report, settled } = await withCliDeps(env, logger, (deps) => runResolveOperation(deps, args));
    await writeStdout(`${JSON.stringify(report)}\n`);
    if (settled) return 0;
    process.stderr.write(`${CLI}: ${unsettledMessage(report, args.to)}\n`);
    return 1;
  } catch (err) {
    if (err instanceof OperationNotFoundError || err instanceof RosterResolutionError || err instanceof ServiceUnavailableError) {
      process.stderr.write(`${CLI}: ${err.message}\n`);
      return 1;
    }
    logger.fatal({ error: serializeError(err) }, `${CLI} resolve-operation failed`);
    return 1;
  }
}

/** The service environment, its database settings and its publisher's emulator host. */
interface CliEnv {
  base: Readonly<BaseEnv>;
  db: DbEnv;
  emulatorHost: string | undefined;
}

/** loadEnv's service variables plus the CLI's rules: a database to open and an identity URL to call; throws EnvValidationError. */
function loadCliEnv(source: NodeJS.ProcessEnv): CliEnv {
  const base = loadEnv(baseEnvSchema, source);
  const emulatorHost = publisherEmulatorHost(base);
  const { OPT2_DB_AUTH, PG_DATABASE } = base;
  const issues = [
    ...(OPT2_DB_AUTH === undefined ? ['OPT2_DB_AUTH: is required'] : []),
    ...(PG_DATABASE === undefined ? ['PG_DATABASE: is required'] : []),
    ...(Object.hasOwn(base.OPT2_SERVICE_URLS, IDENTITY_SERVICE) ? [] : [`OPT2_SERVICE_URLS: must name ${IDENTITY_SERVICE}`]),
  ];
  if (OPT2_DB_AUTH === undefined || PG_DATABASE === undefined || issues.length > 0) throw new EnvValidationError(issues, CLI);
  return { base, db: { ...base, OPT2_DB_AUTH, PG_DATABASE }, emulatorHost };
}

/** Why an operation the run returned is still open, with the flag a halted one needs. */
function unsettledMessage(report: ResolveReport, to: ResolveTarget | undefined): string {
  const { operationId, to: state } = report;
  if (state === 'halted' && to === undefined) return `roster operation ${operationId} is halted; rerun with --to rolled-back or --to done`;
  if (state === 'done') return `roster operation ${operationId} is done but identity's finish is still pending; rerun later`;
  return `roster operation ${operationId} is still ${state}: its request or another resolution holds it, or identity is unreachable; rerun later`;
}

/** Opens the people pool, identity client and outbox publisher as service `people`, runs `fn`, then closes the publisher, client and pool. */
async function withCliDeps<T>(env: CliEnv, logger: Logger, fn: (deps: RecoveryDeps) => Promise<T>): Promise<T> {
  const { base } = env;
  const db: TenantDb = await createPool({
    env: env.db,
    schema: SCHEMA,
    applicationName: `${CLI}-cli`,
    onError: (err) => logger.error({ error: serializeError(err) }, 'database pool error'),
  });
  let client: ServiceClient | undefined;
  let publisher: EventPublisher | undefined;
  try {
    client = createServiceClient({ serviceUrls: base.OPT2_SERVICE_URLS, self: OWNER, credentials: invocationMinter(base) });
    publisher = createPublisher({
      projectId: base.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
      emulatorHost: env.emulatorHost,
      payloadValidators: new Map(Object.entries(peoplePayloadValidators)),
    });
    // Registers the runtime a done resolution's released rows flush through after their commit.
    createOutbox({ service: OWNER, db, publisher, logger, clock: systemClock, payloadValidators: peoplePayloadValidators });
    // Bound to the pool's schema, so repository SQL and the outbox runtime always name the same one.
    const repo = createPeopleRepository({ clock: systemClock, schema: db.schema });
    return await fn({ db, repo, identity: createIdentityClient(client), events: createPeopleEvents(repo), clock: systemClock, logger });
  } finally {
    try {
      await publisher?.close();
    } finally {
      try {
        await client?.close();
      } finally {
        await db.end();
      }
    }
  }
}

/** Google-signed ID tokens in the cloud; locally, `people` service tokens signed with the state directory's key pair, loaded at the first call. */
function invocationMinter(env: Readonly<BaseEnv>): InvocationMinter {
  if (env.OPT2_ENV === 'cloud') return createCloudInvocationMinter();
  let local: Promise<InvocationMinter> | undefined;
  return {
    async headersFor(target, opts) {
      local ??= loadLocalSigningKeys(env.OPT2_STATE_DIR, { requirePrivate: true }).then((keys) => createLocalInvocationMinter({ keys, caller: OWNER }));
      return (await local).headersFor(target, opts);
    },
  };
}

/** Version of the people package, read from its package.json beside `src` and `dist`. */
async function peopleVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writes to stdout and resolves once the chunk is flushed. */
function writeStdout(text: string): Promise<void> {
  return new Promise((done, fail) => {
    process.stdout.write(text, (err) => (err ? fail(err) : done()));
  });
}

// argv[1] may be a symlinked bin path and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(await realpath(entry)).href) {
  // Explicit exit: a Pub/Sub client that failed mid-close may leave gRPC handles open.
  process.exit(await main());
}
