#!/usr/bin/env node
// `opt2-auth` CLI of @opt2/platform/auth: `matrix` writes the route/role matrix of a built Fastify app as JSON.
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { collectRouteMatrix, serializeRouteMatrix } from './matrix.js';

const USAGE = 'usage: opt2-auth matrix --app <module> [--export <name>] [--options <json>] [--out <file>]';

const HELP = `${USAGE}

Builds the Fastify app with the module's export, waits for ready (never listens) and writes its route/role matrix as JSON.
  --app <module>     compiled ESM module, resolved against the working directory (required)
  --export <name>    builder export, called with the options; returns the app or { app } (default: buildApp)
  --options <json>   JSON value passed to the builder (default: {})
  --out <file>       output file, parent directories created (default: stdout)
`;

/** Invalid command-line usage; answered on stderr with the usage line and exit code 2. */
class UsageError extends Error {}

/** Arguments of `opt2-auth matrix`. */
interface MatrixArgs {
  app: string;
  exportName: string;
  options: unknown;
  out?: string;
}

/** Runs `opt2-auth` with the arguments after the script path; returns the exit code: 0 done, 1 failed, 2 usage error. */
export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseCommand(argv);
    if (args === 'help') {
      await writeStdout(HELP);
    } else {
      await exportMatrix(args);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`opt2-auth: ${err.message}; ${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`opt2-auth: ${messageOf(err)}\n`);
    return 1;
  }
}

/** Parses the subcommand and its options; `'help'` when `--help` is given. */
function parseCommand(argv: string[]): MatrixArgs | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        app: { type: 'string' },
        export: { type: 'string', default: 'buildApp' },
        options: { type: 'string', default: '{}' },
        out: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    return 'help';
  }
  if (positionals.length === 0) {
    throw new UsageError('missing subcommand');
  }
  if (positionals.length !== 1 || positionals[0] !== 'matrix') {
    throw new UsageError(`unknown subcommand ${JSON.stringify(positionals.join(' '))}`);
  }
  if (!values.app) {
    throw new UsageError('missing --app');
  }
  return { app: values.app, exportName: values.export, options: parseOptions(values.options), out: values.out };
}

/** The `--options` JSON value. */
function parseOptions(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new UsageError(`--options is not valid JSON: ${messageOf(err)}`);
  }
}

/** Imports the module, builds and readies its app, writes the serialized matrix and closes the app. */
async function exportMatrix({ app: appPath, exportName, options, out }: MatrixArgs): Promise<void> {
  const modulePath = resolve(process.cwd(), appPath);
  const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const builder = mod[exportName];
  if (typeof builder !== 'function') {
    throw new UsageError(`export ${JSON.stringify(exportName)} of ${modulePath} is not a function`);
  }
  const app = appOf(await (builder as (options: unknown) => unknown)(options));
  try {
    await app.ready();
    const text = serializeRouteMatrix(collectRouteMatrix(app));
    if (out === undefined) {
      await writeStdout(text);
    } else {
      const outPath = resolve(process.cwd(), out);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, text, 'utf8');
    }
  } finally {
    await app.close();
  }
}

/** The Fastify instance a builder returned, directly or as `{ app }`. */
function appOf(built: unknown): FastifyInstance {
  const candidate = isFastifyInstance(built) ? built : isRecord(built) ? built['app'] : undefined;
  if (!isFastifyInstance(candidate)) {
    throw new Error('the builder returned neither a Fastify instance nor { app }');
  }
  return candidate;
}

function isFastifyInstance(value: unknown): value is FastifyInstance {
  return isRecord(value) && typeof value['ready'] === 'function' && typeof value['close'] === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

// npm `.bin` shims are symlinks and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(await realpath(entry)).href) {
  // Explicit exit: an app whose plugins failed while the builder awaited it is never handed back to close, so its handles may stay open.
  process.exit(await main(process.argv.slice(2)));
}
