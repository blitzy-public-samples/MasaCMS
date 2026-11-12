import { createHash } from 'node:crypto';

import { BRIDGE_ASSERTION_HEADER, signBridgeAssertion } from '@opt2/platform/legacy-compat';
import { SERVICE_CALL_TIMEOUT_MS, createSignalBoundFetch } from '@opt2/platform/service-kit';
import { SITEMONITOR_QUEUE, queueDefinition } from '@opt2/platform/tasks';

import type { MigrationEnv } from '../env.js';

const BRIDGE_PATH = '/gateway/legacy-bridge/cfml';
const SHA256_HEADER = 'X-Opt2-Sha256';
const ASSERTION_TTL_SECONDS = 60;
// Masa cuts sessions of bot-like user agents to 2 s, so the throwaway session each bridge call creates expires at once.
const BRIDGE_USER_AGENT = 'opt2-legacy-bridge-bot';

/** Bridge page a call addresses, named without `.cfm`. */
type BridgePage = 'jobs' | 'scheduler' | 'site' | 'files';

/** Site-monitor step jobs of `jobs.cfm`; equal to programs-sites' `SiteMonitorStepName`. */
export const BRIDGE_JOBS = [
  'sendReminders',
  'emailSend',
  'publishScheduledChangesets',
  'trackBounces',
  'feedAutoImport',
  'purgeDisplayWindow',
  'clearOldCommands',
  'onGlobalMonitor',
  'onSiteMonitor',
  'setCursor',
] as const;

/** Name of one `jobs.cfm` step job. */
export type BridgeJobName = (typeof BRIDGE_JOBS)[number];

/** Default bound of a bridge call: the service-call timeout. */
export const BRIDGE_CALL_TIMEOUT_MS = SERVICE_CALL_TIMEOUT_MS;

/**
 * Default bound of the site-monitor step jobs and of `files.list`, which hashes every file of a site: the site-monitor
 * run deadline, which is also Masa's task `requestTimeOut`.
 */
export const BRIDGE_BATCH_TIMEOUT_MS = queueDefinition(SITEMONITOR_QUEUE).deadlineS * 1000;

/** Per-call options. */
export interface BridgeRequestOptions {
  /** Caller cancellation, combined with the call's bound. */
  signal?: AbortSignal;
  /** Bounds the call, from the request to the last answer byte, in place of its operation's default. */
  timeoutMs?: number;
}

/** `filesPut` options; `size` is the body's byte count, sent as `Content-Length`, which a streamed body otherwise lacks. */
export interface FilePutOptions extends BridgeRequestOptions {
  size?: number;
}

/** Client settings: the legacy origin addressed directly, the bridge HMAC key and a `fetch` replacing the platform's signal-bound fetch. */
export interface BridgeClientOptions {
  origin: string;
  key: string;
  fetch?: typeof globalThis.fetch;
}

/** Raised for any non-2xx bridge answer; `body` is the parsed JSON error, the text, or `''` for the guard's bodiless 403 and 404. */
export class BridgeError extends Error {
  override readonly name: string = 'BridgeError';
  readonly status: number;
  readonly op: string;
  readonly body: unknown;

  constructor(op: string, status: number, body: unknown, message = `legacy bridge ${op} failed with ${String(status)}`) {
    super(message);
    this.op = op;
    this.status = status;
    this.body = body;
  }
}

/** Raised when the bridge did not answer `op` within the call's bound; the exchange was aborted and its abort reason is `cause`. */
export class BridgeTimeoutError extends Error {
  override readonly name: string = 'BridgeTimeoutError';
  readonly op: string;
  readonly timeoutMs: number;

  constructor(op: string, timeoutMs: number, cause: unknown) {
    super(`legacy bridge ${op} did not answer within ${String(timeoutMs)} ms`, { cause });
    this.op = op;
    this.timeoutMs = timeoutMs;
  }
}

/** Raised for 409 `unsupportedFileStore`: the legacy store is not `fileDir`, so `files.get`, `put` and `delete` cannot run. */
export class UnsupportedFileStoreError extends BridgeError {
  override readonly name: string = 'UnsupportedFileStoreError';

  constructor(op: string, body: unknown) {
    super(op, 409, body);
  }
}

/** Raised when `files.get` bytes do not hash to `X-Opt2-Sha256`; `expected` is `''` when the header is missing. */
export class BridgeHashMismatchError extends BridgeError {
  override readonly name: string = 'BridgeHashMismatchError';
  readonly expected: string;
  readonly actual: string;

  constructor(op: string, status: number, expected: string, actual: string) {
    super(op, status, { expected, actual }, `legacy bridge ${op} returned bytes that do not hash to ${SHA256_HEADER}`);
    this.expected = expected;
    this.actual = actual;
  }
}

/** `jobs.<job>` and `jobs.purgeCache` answer; `siteId` is present on site jobs. */
export interface BridgeJobResult {
  job: string;
  siteId?: string;
  completed: boolean;
  serverTime: string;
}

/** `jobs.getCursor` answer; `lastMonitored` is a wire time, or `null` before legacy has any cursor. */
export interface BridgeCursor {
  job: string;
  lastMonitored: string | null;
  serverTime: string;
}

/**
 * Parameters of a step job, sent as URL query values exactly as given.
 * `theTime`, `lastMonitored` and `value` (the `setCursor` time) are wire times the caller has already formatted.
 */
export interface BridgeJobParams {
  siteId?: string;
  theTime?: string;
  lastMonitored?: string;
  value?: string;
}

/** ACF scheduled task in the bridge wire shape: every field a string (`""` when ACF reports none) except `paused`. */
export interface ScheduledTaskDefinition {
  task: string;
  group: string;
  url: string;
  port: string;
  interval: string;
  /** `mm/dd/yyyy`. */
  startDate: string;
  /** 24-hour `HH:mm:ss`. */
  startTime: string;
  requestTimeOut: string;
  operation: string;
  paused: boolean;
}

/** `scheduler.describe` answer: the effective Masa `ping`, Masa's site-monitor task name and every ACF task. */
export interface SchedulerDescription {
  ping: boolean;
  siteMonitorTask: string;
  tasks: ScheduledTaskDefinition[];
  serverTime: string;
}

/** Tasks selected by exact name or by case-sensitive name prefix; at least one of the two is required. */
export interface SchedulerSelection {
  tasks?: string[];
  prefix?: string;
}

/** `scheduler.restore` body: tasks recreated exactly, optionally moved to the gateway origin, then paused or resumed. */
export interface SchedulerRestoreRequest {
  tasks: ScheduledTaskDefinition[];
  repoint: boolean;
  paused: boolean;
}

/** Answer of every mutating scheduler op: the names of the tasks it affected. */
export interface SchedulerOpResult {
  op: string;
  tasks: string[];
  serverTime: string;
}

/** `site.refresh` answer; `siteExists` is false, with status 200, for a deleted site. */
export interface SiteRefreshResult {
  refreshed: boolean;
  siteExists: boolean;
  serverTime: string;
}

/** File-store variant suffix of a cached Masa file: fileDAO's `_source`, `_small`, `_medium`, or an on-demand `_<size name>` or `_W<w>_H<h>`. */
export type LegacyFileVariant = '' | '_source' | '_small' | '_medium' | `_${string}`;

/** One file of `<fileDir>/<siteid>/cache/file/`; `sha256` is lowercase hex and `lastModified` a wire time. */
export interface LegacyFileEntry {
  name: string;
  fileId: string;
  variant: LegacyFileVariant;
  ext: string;
  size: number;
  sha256: string;
  lastModified: string;
}

/** `files.list` answer; a store other than `fileDir` lists no files. */
export interface FileListing {
  fileStore: string;
  files: LegacyFileEntry[];
  serverTime: string;
}

/** `files.get` bytes with their verified lowercase hex SHA-256. */
export interface LegacyFileBytes {
  bytes: Buffer;
  sha256: string;
}

/** `files.put` answer. */
export interface FilePutResult {
  written: boolean;
  name: string;
  size: number;
  sha256: string;
  serverTime: string;
}

/** `files.delete` selector: one file by name, or every `<fileId>*` variant. */
export type FileDeleteTarget = { name: string } | { fileId: string };

/** `files.delete` answer: the names removed, `[]` when nothing matched. */
export interface FileDeleteResult {
  deleted: string[];
  serverTime: string;
}

/**
 * Signed client of the CFML legacy bridge pages `jobs.cfm`, `scheduler.cfm`, `site.cfm` and `files.cfm`.
 * Each call is bounded by BRIDGE_CALL_TIMEOUT_MS unless its method names another bound, and throws BridgeTimeoutError
 * when the bound expires.
 */
export interface BridgeClient {
  /** Runs one site-monitor step (`jobs.<job>`); site jobs need `params.siteId`. Bounded by BRIDGE_BATCH_TIMEOUT_MS, `setCursor` excepted. */
  jobsRun(job: BridgeJobName, params?: BridgeJobParams, opts?: BridgeRequestOptions): Promise<BridgeJobResult>;
  /** Reads `application.lastMonitored` (`jobs.getCursor`). */
  getCursor(opts?: BridgeRequestOptions): Promise<BridgeCursor>;
  /** Purges a site's output and data caches without cluster broadcast (`jobs.purgeCache`). */
  purgeCache(siteId: string, opts?: BridgeRequestOptions): Promise<BridgeJobResult>;
  /** Describes `ping`, Masa's site-monitor task name and every ACF task (`scheduler.describe`). */
  schedulerDescribe(opts?: BridgeRequestOptions): Promise<SchedulerDescription>;
  /**
   * Recreates the native site-monitor task against the gateway and resumes it (`scheduler.repoint`).
   * @param task captured native definition; its `task`, `group` and `startDate` are used, absent ones take Masa's defaults.
   */
  schedulerRepoint(task?: Partial<ScheduledTaskDefinition>, opts?: BridgeRequestOptions): Promise<SchedulerOpResult>;
  /** Pauses the selected tasks (`scheduler.pause`). */
  schedulerPause(sel: SchedulerSelection, opts?: BridgeRequestOptions): Promise<SchedulerOpResult>;
  /** Resumes the selected tasks (`scheduler.resume`). */
  schedulerResume(sel: SchedulerSelection, opts?: BridgeRequestOptions): Promise<SchedulerOpResult>;
  /** Deletes the selected tasks (`scheduler.delete`). */
  schedulerDelete(sel: SchedulerSelection, opts?: BridgeRequestOptions): Promise<SchedulerOpResult>;
  /** Recreates the given task definitions (`scheduler.restore`). */
  schedulerRestore(body: SchedulerRestoreRequest, opts?: BridgeRequestOptions): Promise<SchedulerOpResult>;
  /** Rebuilds Masa's in-memory site registry from `tsettings` (`site.refresh`). */
  siteRefresh(siteId: string, opts?: BridgeRequestOptions): Promise<SiteRefreshResult>;
  /** Lists a site's cached files with size and hash (`files.list`). Bounded by BRIDGE_BATCH_TIMEOUT_MS. */
  filesList(siteId: string, opts?: BridgeRequestOptions): Promise<FileListing>;
  /** Reads one cached file and verifies it against `X-Opt2-Sha256` (`files.get`). */
  filesGet(siteId: string, name: string, opts?: BridgeRequestOptions): Promise<LegacyFileBytes>;
  /**
   * Writes one cached file through Masa's file writer (`files.put`).
   * @param bytes the file's bytes, or a stream of them sent as they are read.
   * @param sha256 lowercase hex SHA-256 of `bytes`, checked by the bridge, which answers 400 `hashMismatch` on a difference.
   */
  filesPut(
    siteId: string,
    name: string,
    bytes: Buffer | Uint8Array | AsyncIterable<Uint8Array>,
    sha256: string,
    opts?: FilePutOptions,
  ): Promise<FilePutResult>;
  /** Deletes one cached file by name, or every variant of a file id (`files.delete`). */
  filesDelete(siteId: string, target: FileDeleteTarget, opts?: BridgeRequestOptions): Promise<FileDeleteResult>;
}

/** One bridge request; `siteId` is signed into the assertion and sent as `siteid`, `query` values left undefined are omitted. */
interface CallSpec {
  method: 'GET' | 'POST';
  siteId?: string;
  query?: Record<string, string | undefined>;
  json?: unknown;
  raw?: Uint8Array | AsyncIterable<Uint8Array>;
  rawHeaders?: Record<string, string>;
  /** False only for `files.get`, which answers raw bytes. */
  acceptJson?: boolean;
  opts: BridgeRequestOptions;
  /** The operation's default bound, used when `opts.timeoutMs` is absent. */
  timeoutMs: number;
}

/** Creates a bridge client; every request carries a freshly signed single-use assertion. */
export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  const origin = options.origin.replace(/\/+$/, '');
  const doFetch: typeof globalThis.fetch = options.fetch ?? createSignalBoundFetch();

  /** One bounded exchange: the request and `read` of its 2xx answer, or the error of any other answer. */
  const exchange = async <T>(
    page: BridgePage,
    opOrJob: string,
    spec: CallSpec,
    read: (response: Response) => Promise<T>,
  ): Promise<T> => {
    const op = `${page}.${opOrJob}`;
    const params = new URLSearchParams({ [page === 'jobs' ? 'job' : 'op']: opOrJob });
    if (spec.siteId !== undefined) params.set('siteid', spec.siteId);
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) params.set(name, value);
    }

    const headers: Record<string, string> = { 'User-Agent': BRIDGE_USER_AGENT, ...spec.rawHeaders };
    if (spec.acceptJson !== false) headers.Accept = 'application/json';
    let body: Uint8Array | AsyncIterable<Uint8Array> | string | undefined;
    if (spec.raw !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = spec.raw;
    } else if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    }
    const timeoutMs = spec.opts.timeoutMs ?? spec.timeoutMs;
    const bound = AbortSignal.timeout(timeoutMs);
    const signal = spec.opts.signal === undefined ? bound : AbortSignal.any([spec.opts.signal, bound]);
    // Signed last, immediately before the request, so no assertion is ever reused.
    headers[BRIDGE_ASSERTION_HEADER] = signBridgeAssertion(
      { op, siteId: spec.siteId, ttlSeconds: ASSERTION_TTL_SECONDS },
      options.key,
    );

    try {
      const response = await doFetch(`${origin}${BRIDGE_PATH}/${page}.cfm?${params.toString()}`, {
        method: spec.method,
        headers,
        body,
        // A followed redirect would replay the single-use assertion and turn a POST into a GET; the contract has none.
        redirect: 'manual',
        signal,
        ...(body === undefined || typeof body === 'string' || body instanceof Uint8Array ? {} : { duplex: 'half' as const }),
      });
      if (!response.ok) throw await bridgeErrorFrom(op, response);
      return await read(response);
    } catch (error) {
      // A BridgeError is an answer, so it propagates as is. The combined signal keeps the reason of whichever source
      // aborted first, so a caller's abort propagates unchanged.
      if (!(error instanceof BridgeError) && bound.aborted && signal.reason === bound.reason) throw new BridgeTimeoutError(op, timeoutMs, error);
      throw error;
    }
  };

  const call = <T>(page: BridgePage, opOrJob: string, spec: CallSpec): Promise<T> =>
    exchange(page, opOrJob, spec, async (response) => (await response.json()) as T);

  return {
    jobsRun: (job, params = {}, opts = {}) =>
      call<BridgeJobResult>('jobs', job, {
        method: 'POST',
        siteId: params.siteId,
        query: { theTime: params.theTime, lastMonitored: params.lastMonitored, value: params.value },
        opts,
        timeoutMs: job === 'setCursor' ? BRIDGE_CALL_TIMEOUT_MS : BRIDGE_BATCH_TIMEOUT_MS,
      }),

    getCursor: (opts = {}) =>
      call<BridgeCursor>('jobs', 'getCursor', { method: 'GET', opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    purgeCache: (siteId, opts = {}) =>
      call<BridgeJobResult>('jobs', 'purgeCache', { method: 'POST', siteId, opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    schedulerDescribe: (opts = {}) =>
      call<SchedulerDescription>('scheduler', 'describe', { method: 'GET', opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    schedulerRepoint: (task = {}, opts = {}) =>
      call<SchedulerOpResult>('scheduler', 'repoint', { method: 'POST', json: task, opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    schedulerPause: (sel, opts = {}) =>
      call<SchedulerOpResult>('scheduler', 'pause', { method: 'POST', json: sel, opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    schedulerResume: (sel, opts = {}) =>
      call<SchedulerOpResult>('scheduler', 'resume', { method: 'POST', json: sel, opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    schedulerDelete: (sel, opts = {}) =>
      call<SchedulerOpResult>('scheduler', 'delete', { method: 'POST', json: sel, opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    schedulerRestore: (body, opts = {}) =>
      call<SchedulerOpResult>('scheduler', 'restore', { method: 'POST', json: body, opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    siteRefresh: (siteId, opts = {}) =>
      call<SiteRefreshResult>('site', 'refresh', { method: 'POST', siteId, opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS }),

    filesList: (siteId, opts = {}) =>
      call<FileListing>('files', 'list', { method: 'GET', siteId, opts, timeoutMs: BRIDGE_BATCH_TIMEOUT_MS }),

    filesGet: (siteId, name, opts = {}) =>
      exchange(
        'files',
        'get',
        { method: 'GET', siteId, query: { name }, acceptJson: false, opts, timeoutMs: BRIDGE_CALL_TIMEOUT_MS },
        async (response): Promise<LegacyFileBytes> => {
          const bytes = Buffer.from(await response.arrayBuffer());
          const actual = createHash('sha256').update(bytes).digest('hex');
          const expected = (response.headers.get(SHA256_HEADER) ?? '').trim().toLowerCase();
          if (expected !== actual) throw new BridgeHashMismatchError('files.get', response.status, expected, actual);
          return { bytes, sha256: actual };
        },
      ),

    filesPut: (siteId, name, bytes, sha256, opts = {}) =>
      call<FilePutResult>('files', 'put', {
        method: 'POST',
        siteId,
        query: { name },
        raw: bytes,
        rawHeaders: { [SHA256_HEADER]: sha256, ...(opts.size === undefined ? {} : { 'Content-Length': String(opts.size) }) },
        opts,
        timeoutMs: BRIDGE_CALL_TIMEOUT_MS,
      }),

    filesDelete: (siteId, target, opts = {}) =>
      call<FileDeleteResult>('files', 'delete', {
        method: 'POST',
        siteId,
        query: 'name' in target ? { name: target.name } : { fileId: target.fileId },
        opts,
        timeoutMs: BRIDGE_CALL_TIMEOUT_MS,
      }),
  };
}

/** Creates the bridge client from `LEGACY_ORIGIN` and `OPT2_BRIDGE_HMAC_KEY`. */
export function bridgeClientFromEnv(
  env: Pick<MigrationEnv, 'LEGACY_ORIGIN' | 'OPT2_BRIDGE_HMAC_KEY'>,
  fetchImpl?: typeof fetch,
): BridgeClient {
  return createBridgeClient({ origin: env.LEGACY_ORIGIN, key: env.OPT2_BRIDGE_HMAC_KEY, fetch: fetchImpl });
}

/** Maps a non-2xx answer to `UnsupportedFileStoreError` for 409 `unsupportedFileStore`, else to `BridgeError`. */
async function bridgeErrorFrom(op: string, response: Response): Promise<BridgeError> {
  const body = parseBody(await response.text());
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (response.status === 409 && error === 'unsupportedFileStore') return new UnsupportedFileStoreError(op, body);
  return new BridgeError(op, response.status, body);
}

/** Parsed JSON of a response text, the text itself when it is not JSON, or `''` for an empty body. */
function parseBody(text: string): unknown {
  if (text === '') return '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
