import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { readFixtureStatus, type FixtureStatus } from '../../src/golden/catalogue.js';
import { originBaseUrl } from '../../src/golden/session.js';
import { createHarnessInvoker, type HarnessCaller, type HarnessInvoker } from '../../src/lib/invocation.js';
import type { EnvLike } from '../../src/lib/paths.js';
import { startProcess } from '../../src/performance/run.js';
import { cutoverStatus } from '../../src/repro/cutover.js';
import { localUrl, portFor, type PackageName } from '../../src/repro/ports.js';
import {
  readUpState,
  upStatePath,
  UpStateMissingError,
  writeUpState,
  type UpProcessEntry,
  type UpState,
} from '../../src/repro/up-state.js';

/** A locally started target package the e2e suites address and control. */
export type ServiceName = PackageName;

const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_PORT_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_INTERVAL_MS = 250;
const LIVENESS_POLL_MS = 100;
const PORT_POLL_MS = 100;
const PORT_PROBE_TIMEOUT_MS = 1_000;
const HEALTH_PATH = '/healthz';

/** Gateway base URL, without a trailing slash. */
export function gatewayUrl(env: EnvLike = process.env): string {
  return originBaseUrl('gateway', env);
}

/** Legacy ColdFusion base URL, without a trailing slash. */
export function legacyUrl(env: EnvLike = process.env): string {
  return originBaseUrl('legacy', env);
}

/** Loopback base URL of `name`. */
export function serviceUrl(name: ServiceName): string {
  return localUrl(name);
}

/** Loopback base URL of the migration service. */
export function migrationUrl(): string {
  return localUrl('migration');
}

/** Raised when `up.json` is absent, meaning `harness/repro/up.sh` has not recorded a running stack. */
export class StackNotUpError extends Error {
  override name = 'StackNotUpError';
  readonly path: string;

  constructor(file: string, options?: ErrorOptions) {
    super(`stack is not up: ${file} is missing; run harness/repro/up.sh first`, options);
    this.path = file;
  }
}

/** The running stack as `up.sh` recorded it; throws `StackNotUpError` when none is recorded. */
export function readStack(): UpState {
  try {
    return readUpState();
  } catch (err) {
    if (err instanceof UpStateMissingError) throw new StackNotUpError(err.path, { cause: err });
    throw err;
  }
}

function entryFor(name: ServiceName): UpProcessEntry {
  const { processes } = readStack();
  const entry = Object.hasOwn(processes, name) ? processes[name] : undefined;
  if (entry === undefined) {
    const recorded = Object.keys(processes).sort();
    throw new Error(
      `${upStatePath()} records no process '${name}'; recorded: ${recorded.length === 0 ? 'none' : recorded.join(', ')}`,
    );
  }
  return entry;
}

function portOf(name: ServiceName, entry: UpProcessEntry): number {
  return entry.port ?? portFor(name);
}

function errnoOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return `${err.name}: ${err.message}${cause}`;
}

/** Signals the process group of `pid`, else `pid` alone; returns the target signalled, or null when both are gone. */
function signalGroupOrPid(pid: number, signal: NodeJS.Signals): number | null {
  try {
    process.kill(-pid, signal);
    return -pid;
  } catch (err) {
    const code = errnoOf(err);
    if (code !== 'ESRCH' && code !== 'EPERM') throw err;
  }
  try {
    process.kill(pid, signal);
    return pid;
  } catch (err) {
    if (errnoOf(err) === 'ESRCH') return null;
    throw err;
  }
}

function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
}

/** Whether loopback `port` still accepts TCP connections; only a refusal reads as closed. */
function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (accepts: boolean): void => {
      socket.destroy();
      resolve(accepts);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(true));
    socket.once('connect', () => settle(true));
    socket.once('error', (err) => settle(errnoOf(err) !== 'ECONNREFUSED'));
  });
}

async function waitPortClosed(name: ServiceName, port: number, timeoutMs: number, after: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (await portAccepts(port)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(`${name} still accepts connections on 127.0.0.1:${port} ${timeoutMs} ms after ${after}`);
    }
    await delay(Math.min(PORT_POLL_MS, remaining));
  }
}

/** Stops `name` with SIGTERM, then SIGKILL after `graceMs`, and waits until its port refuses connections. */
export async function stopService(name: ServiceName, opts: { graceMs?: number; timeoutMs?: number } = {}): Promise<void> {
  const { graceMs = DEFAULT_GRACE_MS, timeoutMs = DEFAULT_PORT_TIMEOUT_MS } = opts;
  const entry = entryFor(name);
  let sent = 'SIGTERM';
  const target = signalGroupOrPid(entry.pid, 'SIGTERM');
  if (target !== null) {
    const graceEnd = performance.now() + graceMs;
    while (isAlive(target) && performance.now() < graceEnd) {
      await delay(Math.min(LIVENESS_POLL_MS, Math.max(0, graceEnd - performance.now())));
    }
    if (isAlive(target)) {
      signalGroupOrPid(entry.pid, 'SIGKILL');
      sent = 'SIGKILL';
    }
  }
  await waitPortClosed(name, portOf(name, entry), timeoutMs, sent);
}

/** Kills `name` with SIGKILL and waits until its port refuses connections. */
export async function killService(name: ServiceName, opts: { timeoutMs?: number } = {}): Promise<void> {
  const entry = entryFor(name);
  signalGroupOrPid(entry.pid, 'SIGKILL');
  await waitPortClosed(name, portOf(name, entry), opts.timeoutMs ?? DEFAULT_PORT_TIMEOUT_MS, 'SIGKILL');
}

/** Starts `name` from its recorded command and env plus `extraEnv`, records the new pid in up.json, and returns it. */
export async function startService(name: ServiceName, opts: { extraEnv?: Record<string, string> } = {}): Promise<number> {
  const entry = entryFor(name);
  // The runner's own PORT is legacy ColdFusion's, so the service's port is set before its recorded env applies.
  const env = { ...process.env, PORT: String(portOf(name, entry)), ...entry.env, ...opts.extraEnv };
  // startProcess records the entry it is given; the overlay lives only in the spawn, so up.json never holds extraEnv.
  return startProcess(name, entry, {
    spawn: (command, args, options) => spawn(command, args, { ...options, env }),
    writeUpState: (patch) => writeUpState(patch),
  });
}

/** Polls `name` until it answers healthy; throws with the URL and the last answer after `timeoutMs`. */
export async function waitHealthy(name: ServiceName, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, intervalMs = DEFAULT_HEALTH_INTERVAL_MS } = opts;
  // web is the Next.js app without the service-kit health route: any non-5xx answer on its root means it serves.
  const isWeb = name === 'web';
  const url = serviceUrl(name) + (isWeb ? '/' : HEALTH_PATH);
  const deadline = performance.now() + timeoutMs;
  let last = 'no answer';
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`${name} is not healthy at ${url} after ${timeoutMs} ms; last: ${last}`);
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.ceil(remaining)) });
      await response.body?.cancel();
      if (isWeb ? response.status < 500 : response.status === 200) return;
      last = `HTTP ${response.status}`;
    } catch (err) {
      // The deadline cuts off the final poll; an earlier HTTP answer says more about why the service is unhealthy.
      const cutOff = err instanceof Error && err.name === 'TimeoutError' && last.startsWith('HTTP ');
      if (!cutOff) last = describeError(err);
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - performance.now())));
  }
}

/** Stops, starts and awaits the health of `name`; returns the new pid. */
export async function restartService(name: ServiceName, opts: { extraEnv?: Record<string, string> } = {}): Promise<number> {
  await stopService(name);
  const pid = await startService(name, opts);
  await waitHealthy(name);
  return pid;
}

async function restoreServices(names: readonly ServiceName[]): Promise<Error[]> {
  const failures: Error[] = [];
  for (const name of names) {
    try {
      await stopService(name);
      await startService(name);
      await waitHealthy(name);
    } catch (err) {
      failures.push(new Error(`restoring ${name} failed: ${describeError(err)}`, { cause: err }));
    }
  }
  return failures;
}

/**
 * Runs `fn`, then restarts every named service on its recorded command and env, attempting all of them.
 * Restoration failures throw an `AggregateError` after a successful `fn`, and become the `cause` of `fn`'s error otherwise.
 */
export async function withRestoredServices<T>(names: readonly ServiceName[], fn: () => Promise<T>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fn() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failures = await restoreServices(names);
  const restored = failures.length === 0;
  const message = `restoring ${failures.length} of ${names.length} service(s) failed`;
  if (outcome.ok) {
    if (restored) return outcome.value;
    throw new AggregateError(failures, message);
  }
  if (!restored && outcome.error instanceof Error) {
    const { error } = outcome;
    error.cause = new AggregateError(failures, message, error.cause === undefined ? undefined : { cause: error.cause });
  }
  throw outcome.error;
}

const invokers = new Map<HarnessCaller, Promise<HarnessInvoker>>();

function memoisedInvoker(caller: HarnessCaller): Promise<HarnessInvoker> {
  let invoker = invokers.get(caller);
  if (invoker === undefined) {
    // A failure (keys not generated yet) is not kept, so a call after up.sh has written the secrets succeeds.
    invoker = createHarnessInvoker({ caller }).catch((err: unknown) => {
      invokers.delete(caller);
      throw err;
    });
    invokers.set(caller, invoker);
  }
  return invoker;
}

/** Invocation credentials of the `migration` workload, for owners' `/internal/v1/migration/*` routes. */
export function migrationInvoker(): Promise<HarnessInvoker> {
  return memoisedInvoker('migration');
}

/** Invocation credentials of the `operator` workload, for the gateway's `/internal/v1/cutover/*` routes. */
export function operatorInvoker(): Promise<HarnessInvoker> {
  return memoisedInvoker('operator');
}

/** The cut-over table version the gateway has active, or null when none is. */
export async function activeTableVersion(): Promise<string | null> {
  const status = await cutoverStatus({ gatewayUrl: gatewayUrl(), invoker: await operatorInvoker() });
  return status.tableVersion;
}

/** Throws unless the gateway has cut-over table `version` active. */
export async function requireTableVersion(version: string): Promise<void> {
  const active = await activeTableVersion();
  if (active !== version) {
    throw new Error(`this suite requires cut-over table ${version}; the gateway has ${active ?? 'none'} active`);
  }
}

/** Legacy-fixture availability as `legacy-fixtures/load-fixtures.sh` recorded it. */
export function fixtureStatus(env: EnvLike = process.env): FixtureStatus {
  return readFixtureStatus(env);
}
