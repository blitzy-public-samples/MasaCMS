import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { repoPath, type EnvLike } from '../lib/paths.js';

/** The committed fixed-port file, sourced by the shell scripts and parsed here. */
export const PORTS_ENV_PATH: string = repoPath('harness/repro/ports.env');

/** Every locally started target package, in `OPT2_SERVICE_URLS` key order. */
export const PACKAGE_NAMES = [
  'gateway',
  'web',
  'migration',
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
  'stub',
] as const;

/** A target package with a fixed local port. */
export type PackageName = (typeof PACKAGE_NAMES)[number];

/** Invalid or conflicting port configuration; the message names the variable or file at fault. */
export class PortsError extends Error {
  override name = 'PortsError';
}

const PORT_PREFIX = 'OPT2_PORT_';
const ASSIGNMENT = /^(?:export\s+)?([^=\s]+)=(.*)$/;
const KEY = /^[A-Z0-9_]+$/;
const QUOTED = /^(["'])(.*)\1$/;
const DIGITS = /^[0-9]+$/;

/** `ports.env` variable holding `name`'s port, e.g. `OPT2_PORT_PROGRAMS_SITES`. */
export function portVariable(name: PackageName): string {
  return PORT_PREFIX + name.toUpperCase().replaceAll('-', '_');
}

const PACKAGE_BY_VARIABLE = new Map<string, PackageName>(PACKAGE_NAMES.map((name) => [portVariable(name), name]));

function toPort(value: string): number | undefined {
  const port = Number(value);
  return DIGITS.test(value) && port >= 1 && port <= 65535 ? port : undefined;
}

/** Package ports from shell-sourceable `KEY=value` text; keys outside `OPT2_PORT_*` are ignored. */
export function parsePortsEnv(text: string): Record<PackageName, number> {
  const values = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const match = ASSIGNMENT.exec(line);
    const key = match?.[1];
    if (key === undefined || !KEY.test(key)) {
      throw new PortsError(`line ${index + 1} is not a KEY=value assignment with an [A-Z0-9_] key: ${line}`);
    }
    if (key.startsWith(PORT_PREFIX)) values.set(key, (match?.[2] ?? '').replace(QUOTED, '$2'));
  });

  for (const variable of values.keys()) {
    if (!PACKAGE_BY_VARIABLE.has(variable)) {
      throw new PortsError(`${variable} names no known package; expected one of ${[...PACKAGE_BY_VARIABLE.keys()].join(', ')}`);
    }
  }

  const ports = {} as Record<PackageName, number>;
  const owners = new Map<number, string>();
  for (const name of PACKAGE_NAMES) {
    const variable = portVariable(name);
    const value = values.get(variable);
    if (value === undefined) throw new PortsError(`${variable} is missing`);
    const port = toPort(value);
    if (port === undefined) throw new PortsError(`${variable} must be an integer from 1 to 65535, got '${value}'`);
    const owner = owners.get(port);
    if (owner !== undefined) throw new PortsError(`${variable} and ${owner} share port ${port}`);
    owners.set(port, variable);
    ports[name] = port;
  }
  return ports;
}

const loaded = new Map<string, Record<PackageName, number>>();

/** Parsed ports of `file`, read once per resolved path. */
export function loadPorts(file: string = PORTS_ENV_PATH): Record<PackageName, number> {
  const key = path.resolve(file);
  let ports = loaded.get(key);
  if (ports === undefined) {
    try {
      ports = Object.freeze(parsePortsEnv(readFileSync(key, 'utf8')));
    } catch (err) {
      throw new PortsError(`${key}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    loaded.set(key, ports);
  }
  return ports;
}

/** Fixed local port of `name`. */
export function portFor(name: PackageName): number {
  return loadPorts()[name];
}

/** Loopback base URL of `name`, without a trailing slash. */
export function localUrl(name: PackageName): string {
  return `http://127.0.0.1:${portFor(name)}`;
}

/** The `OPT2_SERVICE_URLS` map: every package to its loopback base URL. */
export function serviceUrls(): Record<PackageName, string> {
  return Object.fromEntries(PACKAGE_NAMES.map((name) => [name, localUrl(name)])) as Record<PackageName, string>;
}

/** Throws `PortsError` when legacy ColdFusion's port equals a fixed target port. */
export function assertNoLegacyCollision(legacyPort: number): void {
  const ports = loadPorts();
  const clash = PACKAGE_NAMES.find((name) => ports[name] === legacyPort);
  if (clash !== undefined) {
    throw new PortsError(`legacy PORT ${legacyPort} collides with ${portVariable(clash)} in ${PORTS_ENV_PATH}`);
  }
}

const USAGE = 'usage: tsx src/repro/ports.ts (--service-urls | --check) [--legacy-port <n>]';

function resolveLegacyPort(flag: string | undefined, env: EnvLike): number | undefined {
  const raw = flag ?? (env.PORT === '' ? undefined : env.PORT);
  if (raw === undefined) return undefined;
  const port = toPort(raw);
  if (port === undefined) {
    throw new UsageError(`${flag === undefined ? 'PORT' : '--legacy-port'} must be an integer from 1 to 65535, got '${raw}'`, USAGE);
  }
  return port;
}

/** CLI entry: `--service-urls` prints the URL map, `--check` validates the file; both check legacy's port when known. */
export function main(argv: string[], env: EnvLike = process.env): CliOutcome {
  const { values } = parseFlags(argv, {
    options: {
      'service-urls': { type: 'boolean' },
      check: { type: 'boolean' },
      'legacy-port': { type: 'string' },
    },
    usage: USAGE,
  });
  if (values['service-urls'] !== true && values.check !== true) {
    throw new UsageError('one of --service-urls or --check is required', USAGE);
  }

  const legacyPort = resolveLegacyPort(values['legacy-port'], env);
  if (legacyPort !== undefined) assertNoLegacyCollision(legacyPort);

  const summary: Record<string, unknown> = {};
  if (values.check === true) Object.assign(summary, { ports: loadPorts(), legacyPort: legacyPort ?? null });
  if (values['service-urls'] === true) summary.serviceUrls = serviceUrls();
  return { summary };
}

if (isMainModule(import.meta.url)) {
  await runCli(main);
}
