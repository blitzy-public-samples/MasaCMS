// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readlinkSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createLocalInvocationMinter, loadLocalSigningKeys } from '@opt2/platform/auth';
import { baseEnvSchema, createServiceClient, z, type ServiceClient } from '@opt2/platform/service-kit';
import { loadConfig } from './config.js';
import { generateCredentials, writeCredentials } from './credentials.js';
import { buildDataset } from './dataset.js';
import { directServices, runDirect, type DirectClient } from './direct.js';
import { errorCategory, nameText, oneLine, parseJson, printable, printableMessage } from './errors.js';
import { readDataset, writeDataset } from './writer.js';

/** Collaborators `run` uses instead of its defaults: credential randomness, the direct-mode client and the log sink. */
export interface GenerateDeps {
  randomBytes?: (n: number) => Buffer;
  client?: DirectClient;
  log?: (line: string) => void;
}

/** Resolved locations of one run. */
interface RunPaths {
  config: string;
  out: string;
  pin: string;
  stateDir: string;
}

// Direct mode stands in for the migration service's backfill, so it calls the owners as that workload.
const SELF = 'migration';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(pkgRoot, '../..');

const OPTIONS = {
  direct: { type: 'boolean' },
  config: { type: 'string' },
  out: { type: 'string' },
  pin: { type: 'string' },
  help: { type: 'boolean' },
} as const;

const USAGE = `Usage: node dist/generate.js [--direct] [--config <file>] [--out <dir>] [--pin <file>]

Generates the fixed-seed dataset and fresh credentials into <out>; with --direct, sends the
dataset already in <out> to the synthetic services' migration apply endpoints instead.

  --direct         apply <out>/dataset.json through OPT2_SERVICE_URLS as the migration workload
  --config <file>  seed configuration (default <package>/seed.config.json)
  --out <dir>      dataset directory, outside the checkout (default \${OPT2_STATE_DIR}/seed)
  --pin <file>     source pin (default <repository>/opt2/source-pin.json)
  --help           print this help
`;

const pinSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });

/** Writes `text` and a newline to stderr. */
function fail(text: string): void {
  process.stderr.write(`${text}\n`);
}

// Linux's MAXSYMLINKS: the most links one path lookup follows before it fails with ELOOP.
const SYMLINK_HOPS = 40;

/** Result of `fn`, or undefined when it throws. */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Absolute `path` with every symlink followed, dangling ones included, and its missing tail kept, as `realpath -m` gives it. */
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (let hops = 0; ; ) {
    const real = attempt(() => realpathSync(current));
    if (real !== undefined || dirname(current) === current) return join(real ?? current, ...missing);
    const target = hops < SYMLINK_HOPS ? attempt(() => readlinkSync(current)) : undefined;
    const parent = dirname(current);
    if (target === undefined) {
      missing.unshift(basename(current));
      current = parent;
    } else {
      current = resolve(attempt(() => realpathSync(parent)) ?? parent, target);
      hops += 1;
    }
  }
}

/** Whether `dir` is `root` or lies beneath it, compared as canonical paths. */
function isWithin(dir: string, root: string): boolean {
  return `${canonicalPath(dir)}${sep}`.startsWith(`${canonicalPath(root)}${sep}`);
}

/** Pinned source SHA from the pin file at `path`. */
async function readPinnedSha(path: string): Promise<string> {
  const parsed = pinSchema.safeParse(parseJson(await readFile(path, 'utf8'), path));
  if (!parsed.success) throw printable(new Error(`${path} has no sha of 40 lower-case hex characters`));
  return parsed.data.sha;
}

/** Callee name to base URL from `OPT2_SERVICE_URLS` by the platform's rule, or why it is unset or invalid, naming keys but never values. */
function parseServiceUrls(raw: string | undefined): { urls: Record<string, string> } | { error: string } {
  if (raw === undefined || raw.trim() === '') return { error: '--direct needs OPT2_SERVICE_URLS, a JSON object of service name to URL' };
  const parsed = baseEnvSchema.shape.OPT2_SERVICE_URLS.safeParse(raw);
  if (parsed.success) return { urls: parsed.data };
  const issues = parsed.error.issues.map(({ path, message }) =>
    path.length === 0 ? message : `${path.map((key) => nameText(String(key))).join('.')}: ${message}`,
  );
  return { error: `OPT2_SERVICE_URLS is not a JSON object of service name to http(s) URL (${issues.join('; ')})` };
}

/** Builds the dataset, writes it with its manifest, then writes fresh credentials for it. */
async function generate(paths: RunPaths, deps: GenerateDeps, log: (line: string) => void): Promise<void> {
  const config = await loadConfig(paths.config);
  const sha = await readPinnedSha(paths.pin);
  const dataset = buildDataset(config, sha);
  const manifest = await writeDataset(paths.out, dataset, config.chunkRows);
  const creds = generateCredentials(dataset, config, { randomBytes: deps.randomBytes });
  await writeCredentials(paths.out, paths.stateDir, creds);
  log(`seed digest=${manifest.digest} out=${paths.out} parts=${manifest.parts.length}`);
  log(`seed counts ${Object.entries(manifest.counts).map(([array, count]) => `${array}=${count}`).join(' ')}`);
}

/** Sends the dataset already written to `paths.out` to its owners' migration apply endpoints; returns the exit code. */
async function direct(
  paths: RunPaths,
  serviceUrls: Record<string, string>,
  deps: GenerateDeps,
  log: (line: string) => void,
): Promise<number> {
  const config = await loadConfig(paths.config);
  const dataset = await readDataset(paths.out);
  let client = deps.client;
  let owned: ServiceClient | undefined;
  if (client === undefined) {
    const unmapped = directServices(dataset, config).filter((service) => !Object.hasOwn(serviceUrls, service));
    if (unmapped.length > 0) {
      fail(`seed: OPT2_SERVICE_URLS has no URL for ${unmapped.join(', ')}`);
      return 2;
    }
    const keys = await loadLocalSigningKeys(paths.stateDir, { requirePrivate: true });
    owned = createServiceClient({ serviceUrls, self: SELF, credentials: createLocalInvocationMinter({ keys, caller: SELF }) });
    client = owned;
  }
  try {
    const result = await runDirect(dataset, { client, config, log });
    const byService = Object.entries(result.byService).map(([service, rows]) => `${service}=${rows}`);
    log(`seed direct digest=${dataset.digest} batches=${result.batches} rows=${result.rows} ${byService.join(' ')}`.trimEnd());
  } finally {
    await owned?.close();
  }
  return 0;
}

/** Runs the CLI; returns 0 on success, 1 when a run fails, 2 on a usage or environment error. */
export async function run(argv: string[], env: NodeJS.ProcessEnv, deps: GenerateDeps = {}): Promise<number> {
  let values: { direct?: boolean; config?: string; out?: string; pin?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    fail(`seed: ${oneLine(err)}`);
    process.stderr.write(USAGE);
    return 2;
  }
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const stateDir = resolve(env.OPT2_STATE_DIR || join(env.HOME || homedir(), '.opt2', 'state'));
  const paths: RunPaths = {
    config: resolve(values.config ?? join(pkgRoot, 'seed.config.json')),
    out: resolve(values.out ?? join(stateDir, 'seed')),
    pin: resolve(values.pin ?? join(repoRoot, 'opt2', 'source-pin.json')),
    stateDir,
  };
  // Generated data and credentials stay out of the checkout, so neither can be committed by accident.
  const written = values.direct === true ? [paths.out] : [paths.out, paths.stateDir];
  const inside = written.find((dir) => isWithin(dir, repoRoot));
  if (inside !== undefined) {
    fail(`seed: ${inside} is inside the checkout ${repoRoot}; choose a location outside it`);
    return 2;
  }

  let serviceUrls: Record<string, string> = {};
  if (values.direct === true && deps.client === undefined) {
    const parsed = parseServiceUrls(env.OPT2_SERVICE_URLS);
    if ('error' in parsed) {
      fail(`seed: ${parsed.error}`);
      return 2;
    }
    serviceUrls = parsed.urls;
  }

  const log = deps.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  try {
    if (values.direct === true) return await direct(paths, serviceUrls, deps, log);
    await generate(paths, deps, log);
    return 0;
  } catch (err) {
    const mode = values.direct === true ? 'direct' : 'generate';
    fail(`seed: ${printableMessage(err) ?? `${mode} failed (${errorCategory(err)})`}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void run(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
