import { setTimeout as delay } from 'node:timers/promises';

import { z } from '@opt2/platform/service-kit';

import { isMainModule, parseFlags, runCli, UsageError, type CliOutcome } from '../lib/cli.js';
import { createHarnessInvoker, type HarnessInvoker } from '../lib/invocation.js';
import type { EnvLike } from '../lib/paths.js';
import { localUrl, type PackageName } from './ports.js';

const GATEWAY: PackageName = 'gateway';
const ACTIVATE_PATH = '/internal/v1/cutover/activate';
const STATUS_PATH = '/internal/v1/cutover/status';
const TABLE_VERSION = /^v\d{4}$/;
const CONFLICT = 409;
const POSITIVE_SECONDS = /^(?:\d+\.?\d*|\.\d+)$/;

const USAGE = 'usage: tsx src/repro/cutover.ts (activate <vNNNN> [--timeout-s <n>] | status) [--gateway-url <url>]';

/** Default bound, in milliseconds, on the wait for every live gateway instance to report the activation epoch. */
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

/** Default interval, in milliseconds, between status polls. */
export const DEFAULT_POLL_MS = 250;

/** Fetch-compatible function every request goes through; global `fetch` satisfies it. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Injection points of the client; each defaults to the local operator stack. */
export interface CutoverClientOptions {
  /** Gateway base URL; else `OPT2_GATEWAY_URL`, else the gateway's fixed local port. */
  gatewayUrl?: string;
  env?: EnvLike;
  /** Invocation-credential source; else the local `operator` invoker. */
  invoker?: HarnessInvoker;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock in milliseconds. */
  now?: () => number;
}

/** Options of {@link activateVersion}: the client's, plus the visibility bound and poll interval in milliseconds. */
export type ActivateOptions = CutoverClientOptions & { timeoutMs?: number; pollMs?: number };

/** One gateway instance as `CutoverStatus.instances` reports it. */
export interface CutoverInstanceView {
  instanceId: string;
  seenEpoch: number;
  heartbeatAt: string;
  live: boolean;
  [field: string]: unknown;
}

/** The `CutoverStatus` fields the client reads; every other reported field is kept as received. */
export interface CutoverStatusView {
  tableVersion: string | null;
  epoch: number;
  instances: CutoverInstanceView[];
  [field: string]: unknown;
}

/** One `ValidationFindings` item of a refused activation. */
export interface CutoverFinding {
  rule: string;
  message: string;
  route?: string;
  unit?: string;
  group?: string;
  [field: string]: unknown;
}

/** A live instance still behind the awaited epoch. */
export type LaggingInstance = Pick<CutoverInstanceView, 'instanceId' | 'seenEpoch' | 'heartbeatAt'>;

/** Outcome of {@link activateVersion}; `visibleAfterMs` counts from the commit, or from the status read that found it active. */
export interface ActivationResult {
  tableVersion: string;
  epoch: number;
  alreadyActive: boolean;
  visibleAfterMs: number;
}

const instanceSchema = z
  .object({ instanceId: z.string(), seenEpoch: z.number().int().min(0), heartbeatAt: z.string(), live: z.boolean() })
  .loose();

const statusSchema = z
  .object({ tableVersion: z.string().nullable(), epoch: z.number().int().min(0), instances: z.array(instanceSchema) })
  .loose();

const findingsSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            rule: z.string(),
            message: z.string(),
            route: z.string().optional(),
            unit: z.string().optional(),
            group: z.string().optional(),
          })
          .loose(),
      )
      .min(1),
  })
  .loose();

const activatedSchema = z.object({ epoch: z.number().int().min(0) }).loose();

/** The gateway refused an activation: validation findings, or the 409 conflict of a `previous` mismatch or lost compare-and-set. */
export class CutoverRejected extends Error {
  override name = 'CutoverRejected';
  readonly tableVersion: string;
  readonly status: number;
  readonly findings: CutoverFinding[];

  constructor(tableVersion: string, status: number, findings: CutoverFinding[]) {
    const detail = findings.map((finding) => `${finding.rule}: ${finding.message}`).join('; ');
    super(`gateway refused ${tableVersion} with ${status}: ${detail === '' ? 'no findings' : detail}`);
    this.tableVersion = tableVersion;
    this.status = status;
    this.findings = findings;
  }
}

/** The version was not active on every live gateway instance within the visibility bound. */
export class CutoverVisibilityTimeout extends Error {
  override name = 'CutoverVisibilityTimeout';
  readonly tableVersion: string;
  readonly epoch: number;
  readonly activeVersion: string | null;
  readonly lagging: LaggingInstance[];
  readonly timeoutMs: number;

  constructor(args: { tableVersion: string; epoch: number; activeVersion: string | null; lagging: LaggingInstance[]; timeoutMs: number }) {
    const lagging = args.lagging.map((instance) => `${instance.instanceId} at epoch ${instance.seenEpoch}`).join(', ');
    super(
      `${args.tableVersion} at epoch ${args.epoch} not visible after ${args.timeoutMs} ms: active version ` +
        `${args.activeVersion ?? 'null'}, lagging instances: ${lagging === '' ? 'none' : lagging}`,
    );
    this.tableVersion = args.tableVersion;
    this.epoch = args.epoch;
    this.activeVersion = args.activeVersion;
    this.lagging = args.lagging;
    this.timeoutMs = args.timeoutMs;
  }
}

/** A cut-over endpoint answered with a status or body the client does not accept; carries the status and response text. */
export class CutoverRequestFailed extends Error {
  override name = 'CutoverRequestFailed';
  readonly status: number;
  readonly body: string;

  constructor(request: string, status: number, body: string, detail?: string) {
    super(`${request} answered ${status}${detail === undefined ? '' : ` ${detail}`}: ${body === '' ? '(empty body)' : body}`);
    this.status = status;
    this.body = body;
  }
}

/** The gateway refused the connection, so it is not running at the URL. */
export class GatewayUnreachable extends Error {
  override name = 'GatewayUnreachable';
  readonly url: string;

  constructor(url: string, options?: ErrorOptions) {
    super(`gateway at ${url} refused the connection; start it first (harness/repro/up.sh step 8 starts the target processes)`, options);
    this.url = url;
  }
}

interface GatewayResponse {
  request: string;
  status: number;
  ok: boolean;
  text: string;
}

interface CutoverClient {
  status(): Promise<CutoverStatusView>;
  /** Commits `tableVersion` and returns the epoch the activation committed. */
  activate(tableVersion: string): Promise<number>;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function hasRefusedCode(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'ECONNREFUSED';
}

/** Whether a fetch rejection is a refused TCP connection; undici wraps it in `cause`, as an AggregateError for several addresses. */
function isConnectionRefused(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const nested = cause instanceof AggregateError ? (cause.errors as unknown[]) : [];
  return [error, cause, ...nested].some(hasRefusedCode);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function connect(opts: CutoverClientOptions): Promise<CutoverClient> {
  const env = opts.env ?? process.env;
  const base = (nonEmpty(opts.gatewayUrl) ?? nonEmpty(env.OPT2_GATEWAY_URL) ?? localUrl(GATEWAY)).replace(/\/+$/, '');
  const invoker = opts.invoker ?? (await createHarnessInvoker({ caller: 'operator', env }));
  const fetchFn = opts.fetch ?? fetch;

  const send = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<GatewayResponse> => {
    const url = base + path;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(await invoker.headersFor({ callee: GATEWAY, url })),
    };
    let response: Response;
    try {
      response = await fetchFn(url, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) });
    } catch (error) {
      if (isConnectionRefused(error)) throw new GatewayUnreachable(base, { cause: error });
      throw error;
    }
    return { request: `${method} ${url}`, status: response.status, ok: response.ok, text: await response.text() };
  };

  const status = async (): Promise<CutoverStatusView> => {
    const response = await send('GET', STATUS_PATH);
    if (!response.ok) throw new CutoverRequestFailed(response.request, response.status, response.text);
    const parsed = statusSchema.safeParse(parseJson(response.text));
    if (!parsed.success) {
      const detail = `with a body that is not CutoverStatus (${z.prettifyError(parsed.error)})`;
      throw new CutoverRequestFailed(response.request, response.status, response.text, detail);
    }
    return parsed.data;
  };

  const activate = async (tableVersion: string): Promise<number> => {
    const response = await send('POST', ACTIVATE_PATH, { tableVersion });
    const body = parseJson(response.text);
    if (response.ok) {
      const committed = activatedSchema.safeParse(body);
      return committed.success ? committed.data.epoch : (await status()).epoch;
    }
    const findings = findingsSchema.safeParse(body);
    if (response.status === CONFLICT || (response.status >= 400 && response.status < 500 && findings.success)) {
      throw new CutoverRejected(tableVersion, response.status, findings.success ? findings.data.findings : []);
    }
    throw new CutoverRequestFailed(response.request, response.status, response.text);
  };

  return { status, activate };
}

function laggingInstances(status: CutoverStatusView, epoch: number): LaggingInstance[] {
  return status.instances
    .filter((instance) => instance.live && instance.seenEpoch < epoch)
    .map(({ instanceId, seenEpoch, heartbeatAt }) => ({ instanceId, seenEpoch, heartbeatAt }));
}

/** Reads the gateway's `cutoverStatus` as the operator; a non-2xx answer throws `CutoverRequestFailed`. */
export async function cutoverStatus(opts: CutoverClientOptions = {}): Promise<CutoverStatusView> {
  return (await connect(opts)).status();
}

/**
 * Activates `tableVersion` unless it is already active, then polls until every live instance reports the epoch.
 * Throws `UsageError` for a malformed version, `CutoverRejected` for a refusal and `CutoverVisibilityTimeout` after `timeoutMs`.
 */
export async function activateVersion(tableVersion: string, opts: ActivateOptions = {}): Promise<ActivationResult> {
  if (!TABLE_VERSION.test(tableVersion)) {
    throw new UsageError(`table version must match ${TABLE_VERSION.source}, got '${tableVersion}'`, USAGE);
  }
  const { timeoutMs = DEFAULT_VISIBILITY_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, sleep = delay, now = () => performance.now() } = opts;
  const client = await connect(opts);

  const initial = await client.status();
  const alreadyActive = initial.tableVersion === tableVersion;
  const epoch = alreadyActive ? initial.epoch : await client.activate(tableVersion);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  let status = alreadyActive ? initial : await client.status();
  for (;;) {
    const lagging = laggingInstances(status, epoch);
    if (status.tableVersion === tableVersion && lagging.length === 0) {
      return { tableVersion, epoch, alreadyActive, visibleAfterMs: now() - startedAt };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new CutoverVisibilityTimeout({ tableVersion, epoch, activeVersion: status.tableVersion, lagging, timeoutMs });
    }
    await sleep(Math.min(pollMs, remaining));
    status = await client.status();
  }
}

function errorSummary(error: Error): { type: string; message: string } {
  return { type: error.name, message: error.message };
}

function timeoutMsFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!POSITIVE_SECONDS.test(raw) || !(seconds > 0)) {
    throw new UsageError(`--timeout-s must be a positive number of seconds, got '${raw}'`, USAGE);
  }
  return seconds * 1000;
}

/** CLI entry: `activate <vNNNN>` activates a version and waits until it is visible; `status` reports the cut-over status. */
export async function main(argv: string[], opts: CutoverClientOptions = {}): Promise<CliOutcome> {
  const { values, positionals } = parseFlags(argv, {
    options: { 'timeout-s': { type: 'string' }, 'gateway-url': { type: 'string' } },
    allowPositionals: true,
    usage: USAGE,
  });
  const gatewayUrl = values['gateway-url'];
  if (gatewayUrl === '') throw new UsageError('--gateway-url must not be empty', USAGE);
  const client: CutoverClientOptions = gatewayUrl === undefined ? opts : { ...opts, gatewayUrl };
  const [command, version, ...extra] = positionals;

  if (command === 'status' && version === undefined) {
    if (values['timeout-s'] !== undefined) throw new UsageError('--timeout-s applies to activate only', USAGE);
    return { summary: { ...(await cutoverStatus(client)) } };
  }
  if (command === 'activate' && version !== undefined && extra.length === 0) {
    const timeoutMs = timeoutMsFlag(values['timeout-s']);
    try {
      return { summary: { ...(await activateVersion(version, timeoutMs === undefined ? client : { ...client, timeoutMs })) } };
    } catch (error) {
      if (error instanceof CutoverRejected) {
        return {
          code: 1,
          summary: { tableVersion: version, status: error.status, findings: error.findings, error: errorSummary(error) },
        };
      }
      if (error instanceof CutoverVisibilityTimeout) {
        const { epoch, activeVersion, lagging } = error;
        return {
          code: 1,
          summary: { tableVersion: version, epoch, activeVersion, lagging, timeoutMs: error.timeoutMs, error: errorSummary(error) },
        };
      }
      throw error;
    }
  }
  throw new UsageError('expected `activate <vNNNN>` or `status`', USAGE);
}

if (isMainModule(import.meta.url)) {
  await runCli(main);
}
