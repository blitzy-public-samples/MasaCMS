#!/usr/bin/env node
// `opt2-tasks` CLI of @opt2/platform/tasks: `reconcile` asks each creating service to ensure its recurring task chains.
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { reconcileRecurringQueues, type ReconcileResult } from './handlers.js';
import { SITEMONITOR_QUEUE } from './queues.js';
import { EnvValidationError, baseEnvSchema, createServiceClient } from '../service-kit/index.js';
import {
  createCloudInvocationMinter,
  createLocalInvocationMinter,
  loadLocalSigningKeys,
  type InvocationMinter,
} from '../auth/index.js';
import { createCliDiagnostics, emitDiagnostic, parseArgsProblem, type CliDiagnostics } from '../logging/index.js';
import { safeErrorMessage } from '../logging/safe-error.js';

const USAGE =
  'usage: opt2-tasks reconcile [--queue <name>]... [--with-sitemonitor] [--include-local-only] [--as operator|migration]';

const HELP = `${USAGE}

Asks each creating service in OPT2_SERVICE_URLS to ensure the current slot's task of its recurring queues, one queue
and creator at a time. Prints one JSON line per queue and creator.
  --queue <name>            recurring queue to reconcile, repeatable (default: every outbox sweep queue)
  --with-sitemonitor        also reconcile programs-sites-sitemonitor, which --queue may name only with this flag
  --include-local-only      also reconcile the local-only stub outbox sweep (default: on when OPT2_ENV=local)
  --as operator|migration   workload identity the calls are made as (default: operator)
  -h, --help                print this help
Environment:
  OPT2_ENV                  local or cloud (required)
  OPT2_SERVICE_URLS         JSON map of service name to base URL, naming at least one creator (required)
  OPT2_STATE_DIR            local key pair directory, absolute and outside the checkout; read when OPT2_ENV=local
                            (default: ~/.opt2/state)
  GOOGLE_CLOUD_PROJECT      Google Cloud project (required when OPT2_ENV=cloud)
Exit codes: 0 every chain ensured, 1 a chain failed, 2 usage or environment error.
`;

/** Workload identities the CLI may act as; each carries a role the queue-control routes accept. */
const CALLERS = ['operator', 'migration'] as const;

type Caller = (typeof CALLERS)[number];

/** Fixed problem of a --queue selection reconcileRecurringQueues refuses: a non-recurring name, or the site monitor without its flag. */
const QUEUE_SELECTION_PROBLEM = `--queue must name recurring queues, and ${SITEMONITOR_QUEUE} only with --with-sitemonitor`;

/** Invalid command-line usage, its message a fixed problem text; answered on stderr with the usage line and exit code 2. */
class UsageError extends Error {}

/** Arguments of `opt2-tasks reconcile`; `includeLocalOnly` is undefined when the flag is absent. */
interface ReconcileArgs {
  queues?: string[];
  withSiteMonitor: boolean;
  includeLocalOnly?: boolean;
  as: Caller;
}

// loadEnv requires every base variable and the service mode rules (PORT, TZ, token issuer and audience, JWKS URL),
// so the CLI parses only the variables it reads, with loadEnv's messages and error type.
const cliEnvSchema = baseEnvSchema
  .pick({
    OPT2_ENV: true,
    OPT2_SERVICE_URLS: true,
    OPT2_STATE_DIR: true,
    GOOGLE_CLOUD_PROJECT: true,
  })
  .extend({
    // Without a service URL no creator is reachable, so the base default `{}` is refused here.
    OPT2_SERVICE_URLS: baseEnvSchema.shape.OPT2_SERVICE_URLS.refine(
      (urls) => Object.keys(urls).length > 0,
      'must name at least one service',
    ),
  });

type CliEnv = ReturnType<typeof cliEnvSchema.parse>;

/** Runs `opt2-tasks` with the arguments after the script path; returns 0 when every chain is ensured or help was printed, 1 on a failure, 2 on a usage or environment error. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // On stderr from the start, so parse and environment failures are logged too and stdout carries only the help or result lines.
  const diagnostics = createCliDiagnostics({ cli: 'opt2-tasks', usage: USAGE });
  try {
    const command = parseCommand(argv);
    if (command === 'help') {
      await writeStdout(HELP);
      return 0;
    }
    return await reconcile(command, loadCliEnv(process.env), diagnostics);
  } catch (err) {
    if (err instanceof UsageError) {
      diagnostics.usage(err.message);
      return 2;
    }
    if (err instanceof EnvValidationError) {
      // Its safe record names the invalid variables, never their values or issue texts.
      diagnostics.error('invalid environment', err);
      return 2;
    }
    diagnostics.fatal('reconcile failed', err);
    return 1;
  } finally {
    await diagnostics.flush();
  }
}

/** Reconciles the selected queues and writes one result line each; returns the exit code `main` describes. */
async function reconcile(args: ReconcileArgs, env: CliEnv, diagnostics: CliDiagnostics): Promise<number> {
  const credentials = invocationMinter(env, args.as);
  const client = createServiceClient({ serviceUrls: env.OPT2_SERVICE_URLS, self: args.as, credentials });
  let results: ReconcileResult[];
  try {
    results = await reconcileRecurringQueues(client, {
      serviceUrls: env.OPT2_SERVICE_URLS,
      queues: args.queues,
      withSiteMonitor: args.withSiteMonitor,
      includeLocalOnly: args.includeLocalOnly ?? env.OPT2_ENV === 'local',
    });
  } catch (err) {
    // Raised only for the queue selection, before any service is called; its text quotes the --queue value.
    if (err instanceof TypeError) {
      throw new UsageError(QUEUE_SELECTION_PROBLEM);
    }
    throw err;
  } finally {
    await client.close();
  }

  await writeStdout(results.map(resultLine).join(''));
  if (results.every((result) => result.skipped !== undefined)) {
    diagnostics.error('OPT2_SERVICE_URLS names no creator of the selected queues');
    return 2;
  }
  return results.every((result) => result.skipped !== undefined || result.ok) ? 0 : 1;
}

/** Parses the subcommand and its options; `'help'` when `--help` or `-h` is given. */
function parseCommand(argv: string[]): ReconcileArgs | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        queue: { type: 'string', multiple: true },
        'with-sitemonitor': { type: 'boolean', default: false },
        'include-local-only': { type: 'boolean' },
        as: { type: 'string', default: 'operator' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new UsageError(parseArgsProblem(err));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    return 'help';
  }
  if (positionals.length === 0) {
    throw new UsageError('missing subcommand');
  }
  if (positionals.length !== 1 || positionals[0] !== 'reconcile') {
    throw new UsageError('unknown subcommand');
  }
  const as = values.as;
  if (!isCaller(as)) {
    throw new UsageError(`--as must be one of ${CALLERS.join(', ')}`);
  }
  return {
    queues: values.queue,
    withSiteMonitor: values['with-sitemonitor'],
    includeLocalOnly: values['include-local-only'],
    as,
  };
}

function isCaller(value: string): value is Caller {
  return (CALLERS as readonly string[]).includes(value);
}

/** Parses the CLI's variables, then the cloud mode's project rule; throws `EnvValidationError` listing every invalid or missing one. */
function loadCliEnv(source: NodeJS.ProcessEnv): CliEnv {
  const result = cliEnvSchema.safeParse(source, {
    error: (issue) => (issue.input === undefined ? 'is required' : undefined),
  });
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EnvValidationError(issues, 'opt2-tasks');
  }
  // The platform mode rule; the cloud logger's trace key needs the project.
  if (result.data.OPT2_ENV === 'cloud' && result.data.GOOGLE_CLOUD_PROJECT === undefined) {
    throw new EnvValidationError(['GOOGLE_CLOUD_PROJECT: is required when OPT2_ENV=cloud'], 'opt2-tasks');
  }
  return result.data;
}

/** Google-signed ID tokens in the cloud; locally, service tokens for `caller` signed with the state directory's key pair. */
function invocationMinter(env: CliEnv, caller: Caller): InvocationMinter {
  if (env.OPT2_ENV === 'cloud') {
    // In the cloud the caller is the ADC service account; `caller` only names the client in error messages.
    return createCloudInvocationMinter();
  }
  // Keys load at the first call, so a queue selection error is answered as usage even without a key pair.
  let local: Promise<InvocationMinter> | undefined;
  return {
    async headersFor(target) {
      local ??= loadLocalSigningKeys(env.OPT2_STATE_DIR, { requirePrivate: true }).then((keys) =>
        createLocalInvocationMinter({ keys, caller }),
      );
      return (await local).headersFor(target);
    },
  };
}

/** One JSON line per creator and queue, with the ensured task flattened into it. */
function resultLine({ queue, service, ok, ensured, skipped, error }: ReconcileResult): string {
  const line = { queue, service, ok, created: ensured?.created, name: ensured?.name, reason: ensured?.reason, skipped, error };
  return `${JSON.stringify(line)}\n`;
}

/** Writes to stdout and resolves once the chunk is flushed; a failed write rejects instead of raising an uncaught `error` event. */
function writeStdout(text: string): Promise<void> {
  return new Promise((done, fail) => {
    // The stream emits a failed write's error after its callback, so the listener stays until then.
    const onError = (err: Error): void => fail(err);
    process.stdout.once('error', onError);
    process.stdout.write(text, (err) => {
      if (err) {
        fail(err);
      } else {
        process.stdout.off('error', onError);
        done();
      }
    });
  });
}

// argv[1] may be a symlinked path (node_modules/@opt2/platform is a link) and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(await realpath(entry)).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Only failures before main's diagnostics open reach here.
      emitDiagnostic('OPT2_TASKS', `opt2-tasks failed: ${safeErrorMessage(err)}`, err);
      // A native warning prints on the next tick, so exiting now would drop it.
      setImmediate(() => process.exit(1));
    },
  );
}
