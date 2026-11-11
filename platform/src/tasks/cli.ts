#!/usr/bin/env node
// `opt2-tasks` CLI of @opt2/platform/tasks: `reconcile` asks each creating service to ensure its recurring task chains.
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { reconcileRecurringQueues, type ReconcileResult } from './handlers.js';
import { EnvValidationError, baseEnvSchema, createServiceClient } from '../service-kit/index.js';
import {
  createCloudInvocationMinter,
  createLocalInvocationMinter,
  loadLocalSigningKeys,
  type InvocationMinter,
} from '../auth/index.js';

const USAGE =
  'usage: opt2-tasks reconcile [--queue <name>]... [--with-sitemonitor] [--include-local-only] [--as operator|migration]';

/** Workload identities the CLI may act as; each carries a role the queue-control routes accept. */
const CALLERS = ['operator', 'migration'] as const;

type Caller = (typeof CALLERS)[number];

/** Invalid command-line usage; answered on stderr with the usage line and exit code 2. */
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
const cliEnvSchema = baseEnvSchema.pick({
  OPT2_ENV: true,
  OPT2_SERVICE_URLS: true,
  OPT2_STATE_DIR: true,
  GOOGLE_CLOUD_PROJECT: true,
});

type CliEnv = ReturnType<typeof cliEnvSchema.parse>;

/** Runs `opt2-tasks` with the arguments after the script path; returns 0 when every chain is ensured, 1 on a failure, 2 on a usage or environment error. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ReconcileArgs;
  let env: CliEnv;
  try {
    args = parseCommand(argv);
    env = loadCliEnv(process.env);
  } catch (err) {
    if (err instanceof UsageError) {
      return usageFailure(err.message);
    }
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

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
    // Raised only for the queue selection, before any service is called.
    if (err instanceof TypeError) {
      return usageFailure(err.message);
    }
    throw err;
  } finally {
    await client.close();
  }

  await writeStdout(results.map(resultLine).join(''));
  return results.every((result) => result.skipped !== undefined || result.ok) ? 0 : 1;
}

/** Parses the subcommand and its options. */
function parseCommand(argv: string[]): ReconcileArgs {
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
      },
    });
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  const { values, positionals } = parsed;
  if (positionals.length === 0) {
    throw new UsageError('missing subcommand');
  }
  if (positionals.length !== 1 || positionals[0] !== 'reconcile') {
    throw new UsageError(`unknown subcommand ${JSON.stringify(positionals.join(' '))}`);
  }
  const as = values.as;
  if (!isCaller(as)) {
    throw new UsageError(`--as must be one of ${CALLERS.join(', ')}, got ${JSON.stringify(as)}`);
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

/** Parses the CLI's variables; throws `EnvValidationError` listing every invalid or missing one. */
function loadCliEnv(source: NodeJS.ProcessEnv): CliEnv {
  const result = cliEnvSchema.safeParse(source, {
    error: (issue) => (issue.input === undefined ? 'is required' : undefined),
  });
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EnvValidationError(issues, 'opt2-tasks');
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

function usageFailure(message: string): number {
  process.stderr.write(`opt2-tasks: ${message}; ${USAGE}\n`);
  return 2;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writes to stdout and resolves once the chunk is flushed. */
function writeStdout(text: string): Promise<void> {
  return new Promise((done, fail) => {
    process.stdout.write(text, (err) => {
      if (err) {
        fail(err);
      } else {
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
      console.error(err);
      process.exit(1);
    },
  );
}
