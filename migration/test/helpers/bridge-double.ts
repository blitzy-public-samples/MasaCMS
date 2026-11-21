// In-process stand-in for the CFML legacy bridge pages jobs.cfm, scheduler.cfm, site.cfm and files.cfm behind their assertion guard.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  BRIDGE_ASSERTION_HEADER,
  MemoryNonceStore,
  cfDateTimeFormat,
  strictLocalInstant,
  verifyBridgeAssertion,
  type BridgeAssertionPayload,
  type BridgeAssertionRejection,
} from '@opt2/platform/legacy-compat';
import { systemClock, type Clock } from '@opt2/platform/service-kit';

import { STORED_NAME_PATTERN, storePath } from '../../src/files/names.js';
import {
  BRIDGE_JOBS,
  type BridgeCursor,
  type BridgeJobName,
  type BridgeJobResult,
  type FileDeleteResult,
  type FileListing,
  type FilePutResult,
  type LegacyFileEntry,
  type LegacyFileVariant,
  type ScheduledTaskDefinition,
  type SchedulerDescription,
  type SchedulerOpResult,
  type SiteRefreshResult,
} from '../../src/legacy/index.js';

import { TEST_BRIDGE_KEY } from './env.js';
import { FILE_LISTINGS, FILE_STORE, FIXTURE_GATEWAY_ORIGIN, FIXTURE_SITES, NATIVE_TASKS_SAMPLE, SITE_MONITOR_TASK } from './fixtures.js';
import type { CallLog } from './gateway-double.js';

/** Component name of the bridge double's call-log entries. */
export const BRIDGE_COMPONENT = 'bridge';

/** URL path of every bridge page. */
const BRIDGE_PATH = '/gateway/legacy-bridge/cfml/';
const ASSERTION_HEADER = BRIDGE_ASSERTION_HEADER.toLowerCase();
const SHA256_HEADER = 'x-opt2-sha256';
const JSON_TYPE = 'application/json; charset=utf-8';

/** Bridge page the double serves, named without `.cfm`. */
export type BridgePage = 'jobs' | 'scheduler' | 'site' | 'files';
const PAGES: ReadonlySet<string> = new Set<BridgePage>(['jobs', 'scheduler', 'site', 'files']);

/** `configBean.getFileStore()` of the legacy application. */
export type BridgeFileStore = 'fileDir' | 's3';

/** Why the guard refused a call; it answers each with a bodiless 403 (Application.cfc verifyAssertion). */
export type BridgeRejectionReason = 'missingAssertion' | BridgeAssertionRejection | 'opMismatch' | 'siteMismatch';

/** One call the guard accepted; `op` is `<file>.<op|job>` and `assertion` the verified payload. */
export interface BridgeCall {
  file: BridgePage;
  op: string;
  method: string;
  /** URL parameters; repeated values joined with commas, as the CFML url scope holds them. */
  query: Record<string, string>;
  /** `files.put` bytes, else the parsed JSON body (its text when not JSON), undefined when empty. */
  body: unknown;
  assertion: BridgeAssertionPayload;
  /** Status answered. */
  status: number;
  at: Date;
}

/** One call the guard refused. */
export interface BridgeRejectedCall {
  path: string;
  method: string;
  query: Record<string, string>;
  reason: BridgeRejectionReason;
  at: Date;
}

/** One site-monitor step `jobs.cfm` ran; times are the wire values sent. */
export interface BridgeJobRun {
  job: BridgeJobName;
  siteId?: string;
  theTime?: string;
  lastMonitored?: string;
  at: Date;
}

/** One `jobs.purgeCache` of a site's output and data caches. */
export interface BridgePurge {
  siteId: string;
  at: Date;
}

/** One `site.refresh`; `siteExists` as answered. */
export interface BridgeRefresh {
  siteId: string;
  siteExists: boolean;
  at: Date;
}

/** Initial state of {@link startBridgeDouble}. */
export interface BridgeDoubleOptions {
  /** Key assertions must verify with; default {@link TEST_BRIDGE_KEY}. */
  key?: string;
  /** Clock of `serverTime`, the default cursor, `repoint`'s start date and recorded times; never of assertion checks. */
  clock?: Clock;
  log?: CallLog;
  /** ACF tasks; default the fixture capture `NATIVE_TASKS_SAMPLE.tasks`. */
  tasks?: readonly ScheduledTaskDefinition[];
  /** Effective Masa `ping`; default false. */
  ping?: boolean;
  /** File-store bytes by `<siteid>/cache/file/<name>`; default the fixture store. */
  files?: Readonly<Record<string, Buffer>>;
  fileStore?: BridgeFileStore;
  /** Registered sites; default the fixture sites. */
  sites?: readonly string[];
  /** `OPT2_GATEWAY_ORIGIN` of the ColdFusion process; `''` means unset. Default the fixture gateway origin. */
  gatewayOrigin?: string;
  /** Initial `application.lastMonitored`; default one minute before `clock.now()` (contentServer.cfc:669-670). */
  lastMonitored?: Date;
}

/** The running double: its origin for `createBridgeClient` and the legacy state its pages act on. */
export interface BridgeDouble {
  origin: string;
  calls: BridgeCall[];
  rejected: BridgeRejectedCall[];
  /** ACF tasks by name. */
  tasks: Map<string, ScheduledTaskDefinition>;
  /** Copies of the tasks the double started with. */
  readonly capturedTasks: readonly ScheduledTaskDefinition[];
  /** `application.lastMonitored`. */
  cursor: { lastMonitored: Date };
  jobRuns: BridgeJobRun[];
  purges: BridgePurge[];
  refreshes: BridgeRefresh[];
  /** Masa's in-memory site registry. */
  sites: Set<string>;
  /** File-store bytes by `<siteid>/cache/file/<name>`. */
  files: Map<string, Buffer>;
  readonly fileStore: BridgeFileStore;
  setFileStore(store: BridgeFileStore): void;
  /** The next accepted call of `op` (`<file>.<op|job>`) answers `status` with `body` (JSON for an object) instead of running. */
  failNext(op: string, status: number, body?: object | string): void;
  close(): Promise<void>;
}

/** An error answer `{error, message}` with its status, as Application.cfc's raise() throws it. */
class BridgeFail extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, message: string) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

const badRequest = (message: string): BridgeFail => new BridgeFail(400, 'badRequest', message);

/** A page answer: JSON (serverTime added when absent) or raw bytes. */
type Reply = { status: number; json: Record<string, unknown> } | { status: number; bytes: Buffer; headers: Record<string, string> };

/** The request as a page sees it. */
interface PageRequest {
  method: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: Buffer;
  now: Date;
}

/** Wire time with a `T` or space separator and 0-3 fraction digits, as Application.cfc's parseLegacyTime accepts it. */
const WIRE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9-]{35}$/;

/** Bridge wire time `yyyy-mm-ddTHH:nn:ss.lll` in the process zone, as Application.cfc's formatLegacyTime writes it. */
export function formatWireTime(d: Date): string {
  return `${cfDateTimeFormat(d, 'yyyy-mm-dd')}T${cfDateTimeFormat(d, 'HH:nn:ss.lll')}`;
}

/** Parses a wire time in the process zone; undefined where parseLegacyTime answers 400. */
function parseWireTime(text: string): Date | undefined {
  const match = WIRE_TIME.exec(text.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number((match[7] ?? '').padEnd(3, '0'));
  const instant = strictLocalInstant({ year, month, day, hour, minute, second, ms });
  return instant === undefined ? undefined : new Date(instant);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** CFML isSimpleValue for a JSON value. */
function isSimple(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** URL parameters by name, repeated values joined with commas. */
function queryOf(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  for (const name of new Set(url.searchParams.keys())) query[name] = url.searchParams.getAll(name).join(',');
  return query;
}

/** The JSON object body, `{}` when empty; 400 badRequest otherwise (Application.cfc readJsonBody). */
function readJsonBody(req: PageRequest): Record<string, unknown> {
  const text = req.body.toString('utf8');
  if (text === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest('invalid JSON body');
  }
  if (!isRecord(body)) throw badRequest('invalid JSON body');
  return body;
}

/** The body as recorded on a call. */
function recordedBody(file: BridgePage, body: Buffer): unknown {
  if (file === 'files' || body.length === 0) return body.length === 0 ? undefined : Buffer.from(body);
  const text = body.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function requireMethod(req: PageRequest, method: 'GET' | 'POST'): void {
  if (req.method !== method) throw badRequest('wrong method');
}

/** A body field as a string, `''` when absent or null; 400 when it is not a simple value. */
function bodyText(source: Readonly<Record<string, unknown>>, key: string): string {
  const value = source[key];
  if (value === undefined || value === null) return '';
  if (!isSimple(value)) throw badRequest(`${key} must be a string`);
  return String(value);
}

/** A body flag, false when absent or null; 400 when it is not a JSON boolean. */
function bodyFlag(source: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = source[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw badRequest(`${key} must be a boolean`);
  return value;
}

/** A required wire-time URL parameter as sent and parsed; 400 when missing or invalid. */
function timeParam(req: PageRequest, name: string): { text: string; at: Date } {
  const text = req.query[name] ?? '';
  if (text === '') throw badRequest(`missing parameter ${name}`);
  const at = parseWireTime(text);
  if (at === undefined) throw badRequest('invalid time');
  return { text, at };
}

/** Fields `restore` copies from a wire task. */
const TASK_FIELDS = ['task', 'operation', 'url', 'port', 'interval', 'startDate', 'startTime', 'requestTimeOut'] as const;
/** Lead of a past-due ONCE task moved to run now, as scheduler.cfm's `rescheduleLeadS`. */
const RESCHEDULE_LEAD_MS = 10_000;
const TASK_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TASK_TIME = /^(\d{2}):(\d{2}):(\d{2})$/;

/** Start instant of a ONCE task in the process zone; undefined for any other interval or an unreadable start. */
function onceStart(task: Pick<ScheduledTaskDefinition, 'interval' | 'startDate' | 'startTime'>): number | undefined {
  const date = TASK_DATE.exec(task.startDate);
  const time = TASK_TIME.exec(task.startTime);
  if (task.interval.toLowerCase() !== 'once' || date === null || time === null) return undefined;
  const [month, day, year] = date.slice(1, 4).map(Number) as [number, number, number];
  const [hour, minute, second] = time.slice(1, 4).map(Number) as [number, number, number];
  return strictLocalInstant({ year, month, day, hour, minute, second, ms: 0 });
}

/** scheduler.cfm `startPassed`: a ONCE task whose start is not after `now`. */
function startPassed(task: Pick<ScheduledTaskDefinition, 'interval' | 'startDate' | 'startTime'>, now: Date): boolean {
  const start = onceStart(task);
  return start !== undefined && start <= now.getTime();
}

/** Task attributes a save passes; `''` leaves the field as the existing task has it, as ACF's update does with an omitted attribute. */
type TaskAttributes = Record<(typeof TASK_FIELDS)[number], string> & { group: string };

/** Scheme, host and port of a gateway origin. */
interface GatewayOrigin {
  scheme: string;
  host: string;
  port: string;
}

/** Jobs `jobs.cfm` answers, matched case-sensitively; `getCursor` and `purgeCache` are bridge-only. */
const ALL_JOBS: ReadonlySet<string> = new Set<string>([...BRIDGE_JOBS, 'getCursor', 'purgeCache']);
/** Jobs that need a registered `siteid`. */
const SITE_JOBS: ReadonlySet<string> = new Set(['trackBounces', 'feedAutoImport', 'onSiteMonitor', 'purgeCache']);

/** Starts the bridge double on an ephemeral `127.0.0.1` port. */
export async function startBridgeDouble(opts: BridgeDoubleOptions = {}): Promise<BridgeDouble> {
  const key = opts.key ?? TEST_BRIDGE_KEY;
  const clock = opts.clock ?? systemClock;
  const nonces = new MemoryNonceStore();
  const calls: BridgeCall[] = [];
  const rejected: BridgeRejectedCall[] = [];
  const failures = new Map<string, { status: number; body: object | string | undefined }[]>();
  const tasks = new Map<string, ScheduledTaskDefinition>();
  for (const task of opts.tasks ?? NATIVE_TASKS_SAMPLE.tasks) tasks.set(task.task, { ...task });
  const capturedTasks = [...tasks.values()].map((task) => Object.freeze({ ...task }));
  const cursor = { lastMonitored: opts.lastMonitored ?? new Date(clock.now().getTime() - 60_000) };
  const jobRuns: BridgeJobRun[] = [];
  const purges: BridgePurge[] = [];
  const refreshes: BridgeRefresh[] = [];
  const sites = new Set<string>(opts.sites ?? FIXTURE_SITES);
  const files = new Map<string, Buffer>(Object.entries(opts.files ?? FILE_STORE).map(([path, bytes]) => [path, Buffer.from(bytes)]));
  // Files whose time the double does not know report the time it started.
  const startedAt = formatWireTime(clock.now());
  const fileTimes = new Map<string, string>();
  if (opts.files === undefined) {
    for (const [siteId, listing] of Object.entries(FILE_LISTINGS)) {
      for (const entry of listing.files) fileTimes.set(storePath(siteId, entry.name), entry.lastModified);
    }
  }
  let fileStore: BridgeFileStore = opts.fileStore ?? 'fileDir';
  const ping = opts.ping ?? false;
  const gatewayOriginText = opts.gatewayOrigin ?? FIXTURE_GATEWAY_ORIGIN;

  // ---- scheduler.cfm

  const listTasks = (): ScheduledTaskDefinition[] => [...tasks.values()].sort((a, b) => byCodeUnit(a.task, b.task));

  /** OPT2_GATEWAY_ORIGIN split; an origin without a port takes 443 for https and 80 otherwise. */
  const gatewayOrigin = (): GatewayOrigin => {
    if (gatewayOriginText === '') throw new BridgeFail(500, 'serverError', 'OPT2_GATEWAY_ORIGIN unset');
    let uri: URL;
    try {
      uri = new URL(gatewayOriginText);
    } catch {
      throw new BridgeFail(500, 'serverError', 'OPT2_GATEWAY_ORIGIN invalid');
    }
    if (uri.hostname === '') throw new BridgeFail(500, 'serverError', 'OPT2_GATEWAY_ORIGIN invalid');
    const scheme = uri.protocol.slice(0, -1);
    const port = uri.port !== '' ? uri.port : scheme.toLowerCase() === 'https' ? '443' : '80';
    return { scheme, host: uri.hostname, port };
  };

  /** `utility.scheduleTask(action="update")`: creates the task, or updates it keeping its paused state and every omitted attribute. */
  const saveTask = (attrs: TaskAttributes): void => {
    const existing = tasks.get(attrs.task);
    const keep = (field: (typeof TASK_FIELDS)[number]): string => (attrs[field] !== '' ? attrs[field] : (existing?.[field] ?? ''));
    tasks.set(attrs.task, {
      task: attrs.task,
      group: attrs.group !== '' ? attrs.group : 'default',
      url: keep('url'),
      port: keep('port'),
      interval: keep('interval'),
      startDate: keep('startDate'),
      startTime: keep('startTime'),
      requestTimeOut: keep('requestTimeOut'),
      operation: keep('operation'),
      paused: existing?.paused ?? false,
    });
  };

  /** cfschedule pause, resume or delete of one task. */
  const taskAction = (action: string, name: string): void => {
    if (action === 'delete') {
      tasks.delete(name);
      return;
    }
    const task = tasks.get(name);
    if (task !== undefined) task.paused = action === 'pause';
  };

  /** ACF's default group is passed as no group, where Masa's own call places its task. */
  const groupAttr = (group: string): string => (group.toLowerCase() === 'default' ? '' : group);

  /** STATUS Expired: seeded so, or a ONCE task running past its start, which ACF has run or never runs. */
  const isExpired = (task: ScheduledTaskDefinition, now: Date): boolean => task.expired === true || (!task.paused && startPassed(task, now));

  /** `attrs` with its start rescheduleLeadS from `now`, as scheduler.cfm `saveDueNow` saves it. */
  const dueNow = (attrs: TaskAttributes, now: Date): TaskAttributes => {
    const runAt = new Date(now.getTime() + RESCHEDULE_LEAD_MS);
    return { ...attrs, startDate: cfDateTimeFormat(runAt, 'mm/dd/yyyy'), startTime: cfDateTimeFormat(runAt, 'HH:nn:ss') };
  };

  /** scheduler.cfm `pauseTask`: true once paused, false for an expired task, which ACF refuses to pause. */
  const pauseTask = (task: ScheduledTaskDefinition, now: Date): boolean => {
    if (task.paused) return true;
    if (isExpired(task, now)) return false;
    task.paused = true;
    return true;
  };

  /** scheduler.cfm `resumeTask`: ACF refuses a task past its start; with `reschedule` a paused one is moved to now first. */
  const resumeTask = (task: ScheduledTaskDefinition, now: Date, reschedule: boolean): boolean => {
    if (isExpired(task, now)) return false;
    if (startPassed(task, now)) {
      if (!reschedule) return false;
      saveTask(dueNow({ ...task, group: groupAttr(task.group) }, now));
    }
    taskAction('resume', task.task);
    return true;
  };

  /** scheduler.cfm `sameDefinition`: a listed task carries the definition's group, URL, port, interval, start and timeout. */
  const sameDefinition = (task: ScheduledTaskDefinition, attrs: TaskAttributes): boolean =>
    groupAttr(task.group).toLowerCase() === attrs.group.toLowerCase() &&
    task.interval.toLowerCase() === attrs.interval.toLowerCase() &&
    (['url', 'port', 'startDate', 'startTime', 'requestTimeOut'] as const).every((field) => task[field] === attrs[field]);

  const scheduler = (op: string, req: PageRequest): Record<string, unknown> => {
    if (!['describe', 'repoint', 'pause', 'resume', 'delete', 'restore'].includes(op)) throw new BridgeFail(404, 'notFound', 'unknown op');
    requireMethod(req, op === 'describe' ? 'GET' : 'POST');
    const body = op === 'describe' ? {} : readJsonBody(req);
    switch (op) {
      case 'describe':
        return {
          ping,
          siteMonitorTask: SITE_MONITOR_TASK,
          tasks: listTasks().map((task) => ({ ...task, expired: isExpired(task, req.now) })),
        } satisfies Omit<SchedulerDescription, 'serverTime'>;
      // onApplicationStart_include.cfm:562-575: Masa's attributes, the URL without its port, which goes in `port`.
      case 'repoint': {
        const origin = gatewayOrigin();
        const name = bodyText(body, 'task') || SITE_MONITOR_TASK;
        const startDate = bodyText(body, 'startDate');
        saveTask({
          task: name,
          group: groupAttr(bodyText(body, 'group')),
          operation: 'HTTPRequest',
          url: `${origin.scheme}://${origin.host}/index.cfm/_api/sitemonitor/`,
          port: origin.port,
          startDate: startDate || cfDateTimeFormat(req.now, 'mm/dd/yyyy'),
          startTime: '00:15:00',
          interval: '900',
          requestTimeOut: '600',
        });
        taskAction('resume', name);
        return { op, tasks: [name] } satisfies Omit<SchedulerOpResult, 'serverTime'>;
      }
      case 'pause':
      case 'resume':
      case 'delete': {
        const wanted = body.tasks ?? [];
        const prefix = bodyText(body, 'prefix');
        if (!Array.isArray(wanted) || (wanted.length === 0 && prefix === '')) throw badRequest('tasks or prefix required');
        if (!wanted.every(isSimple)) throw badRequest('tasks must be names');
        const names = wanted.map(String);
        const affected: string[] = [];
        const expired: string[] = [];
        for (const task of listTasks()) {
          if ((prefix !== '' && task.task.startsWith(prefix)) || names.includes(task.task)) {
            if (op === 'delete') taskAction(op, task.task);
            const done = op === 'delete' || (op === 'pause' ? pauseTask(task, req.now) : resumeTask(task, req.now, task.paused));
            (done ? affected : expired).push(task.task);
          }
        }
        const result: Omit<SchedulerOpResult, 'serverTime'> = op === 'delete' ? { op, tasks: affected } : { op, tasks: affected, expired };
        return result;
      }
      default: {
        // restore: every definition is checked before any is saved; ACF's update keeps a paused state, so each is paused or
        // resumed, and a past ONCE start is never saved over a task, whose update would run it at once.
        if (!Array.isArray(body.tasks)) throw badRequest('tasks required');
        const repoint = bodyFlag(body, 'repoint');
        const pauseAfter = bodyFlag(body, 'paused');
        const origin = repoint ? gatewayOrigin() : undefined;
        const definitions = (body.tasks as unknown[]).map((given): { attrs: TaskAttributes; expired: boolean } => {
          if (!isRecord(given) || bodyText(given, 'task') === '') throw badRequest('every task needs a name');
          const definition = { group: groupAttr(bodyText(given, 'group')) } as TaskAttributes;
          for (const field of TASK_FIELDS) definition[field] = bodyText(given, field);
          if (origin !== undefined) {
            if (definition.url !== '') {
              const uri = new URL(definition.url);
              definition.url = `${origin.scheme}://${origin.host}${uri.pathname}${uri.search}`;
            }
            definition.port = origin.port;
          }
          return { attrs: definition, expired: bodyFlag(given, 'expired') };
        });
        const existing = new Map(listTasks().map((task) => [task.task, { ...task, expired: isExpired(task, req.now) }]));
        const expired: string[] = [];
        for (const { attrs, expired: capturedExpired } of definitions) {
          const current = existing.get(attrs.task);
          let held: boolean;
          if (!startPassed(attrs, req.now)) {
            saveTask(attrs);
            const saved = tasks.get(attrs.task) as ScheduledTaskDefinition;
            held = pauseAfter ? pauseTask(saved, req.now) : resumeTask(saved, req.now, !capturedExpired);
          } else if (!pauseAfter && !capturedExpired) {
            saveTask(dueNow(attrs, req.now));
            taskAction('resume', attrs.task);
            held = true;
          } else if (current !== undefined && sameDefinition(current, attrs) && (current.expired === true || (current.paused && pauseAfter && !capturedExpired))) {
            held = current.expired !== true;
          } else {
            // Created with a past start, the task is expired at once.
            tasks.delete(attrs.task);
            saveTask(attrs);
            held = false;
          }
          if (!held) expired.push(attrs.task);
        }
        return { op, tasks: definitions.map(({ attrs }) => attrs.task), expired } satisfies Omit<SchedulerOpResult, 'serverTime'>;
      }
    }
  };

  // ---- jobs.cfm and site.cfm

  /** A registered `siteid`; 400 when missing, 404 when unregistered. */
  const registeredSite = (req: PageRequest, missing: string, unknown: string): string => {
    const siteId = req.query.siteid ?? '';
    if (siteId === '') throw badRequest(missing);
    if (!sites.has(siteId)) throw new BridgeFail(404, 'notFound', unknown);
    return siteId;
  };

  const jobs = (job: string, req: PageRequest): Record<string, unknown> => {
    if (!ALL_JOBS.has(job)) throw new BridgeFail(404, 'notFound', 'unknown job');
    requireMethod(req, job === 'getCursor' ? 'GET' : 'POST');
    const siteId = SITE_JOBS.has(job) ? registeredSite(req, 'missing parameter siteid', 'unregistered site') : undefined;
    const reply: Omit<BridgeJobResult, 'serverTime'> = { job, completed: true, ...(siteId === undefined ? {} : { siteId }) };
    switch (job) {
      case 'getCursor':
        return { job, lastMonitored: formatWireTime(cursor.lastMonitored) } satisfies Omit<BridgeCursor, 'serverTime'>;
      case 'setCursor':
        cursor.lastMonitored = timeParam(req, 'value').at;
        return { ...reply };
      case 'purgeCache':
        purges.push({ siteId: siteId ?? '', at: req.now });
        return { ...reply };
      default: {
        // contentServer.cfc:683 needs theTime; the display-window purge (:702-711) runs over [lastMonitored, theTime].
        const run: BridgeJobRun = { job: job as BridgeJobName, at: req.now, ...(siteId === undefined ? {} : { siteId }) };
        if (job === 'purgeDisplayWindow') run.lastMonitored = timeParam(req, 'lastMonitored').text;
        if (job === 'sendReminders' || job === 'purgeDisplayWindow') run.theTime = timeParam(req, 'theTime').text;
        jobRuns.push(run);
        return { ...reply };
      }
    }
  };

  const site = (op: string, req: PageRequest): Record<string, unknown> => {
    if (op === 'list') {
      if (req.method !== 'GET') throw badRequest('GET required');
      return { sites: [...sites] };
    }
    if (op !== 'refresh') throw new BridgeFail(404, 'notFound', 'unknown op');
    if (req.method !== 'POST') throw badRequest('POST required');
    const siteId = req.query.siteid ?? '';
    if (siteId === '') throw badRequest('siteid is required');
    const reply: Omit<SiteRefreshResult, 'serverTime'> = { refreshed: true, siteExists: sites.has(siteId) };
    refreshes.push({ siteId, siteExists: reply.siteExists, at: req.now });
    return { ...reply };
  };

  // ---- files.cfm: <fileDir>/<siteid>/cache/file/<fileID><variant>.<ext> (fileDAO.cfc:153-199)

  /** A URL parameter matching `pattern`; 400 otherwise. */
  const requireParam = (req: PageRequest, name: string, pattern: RegExp): string => {
    const value = req.query[name];
    if (value === undefined || !pattern.test(value)) throw badRequest(`invalid ${name}`);
    return value;
  };

  /** The listing entry of one stored name; `ext` follows the last dot. */
  const entryOf = (dir: string, name: string, bytes: Buffer): LegacyFileEntry => {
    const ext = name.slice(name.lastIndexOf('.') + 1);
    return {
      name,
      fileId: name.slice(0, 35),
      variant: name.slice(35, name.length - ext.length - 1) as LegacyFileVariant,
      ext,
      size: bytes.length,
      sha256: sha256Hex(bytes),
      lastModified: fileTimes.get(dir + name) ?? startedAt,
    };
  };

  const filesPage = (op: string, req: PageRequest): Reply => {
    if (!['list', 'get', 'put', 'delete'].includes(op)) throw new BridgeFail(404, 'notFound', 'unknown op');
    requireMethod(req, op === 'list' || op === 'get' ? 'GET' : 'POST');
    const siteId = registeredSite(req, 'missing siteid', 'unknown site');
    // As files.cfm: another store lists no files, and only get, put and delete answer 409.
    if (fileStore !== 'fileDir' && op !== 'list') throw new BridgeFail(409, 'unsupportedFileStore', fileStore);
    const dir = storePath(siteId, '');
    switch (op) {
      case 'list': {
        // Every name that starts with a fileID and meets the name rule, so variants are found rather than assumed.
        const listed: LegacyFileEntry[] = [];
        for (const [path, bytes] of fileStore === 'fileDir' ? files : []) {
          const name = path.slice(dir.length);
          if (path.startsWith(dir) && STORED_NAME_PATTERN.test(name)) listed.push(entryOf(dir, name, bytes));
        }
        listed.sort((a, b) => byCodeUnit(a.name, b.name));
        return { status: 200, json: { fileStore, files: listed } satisfies Omit<FileListing, 'serverTime'> };
      }
      case 'get': {
        const name = requireParam(req, 'name', STORED_NAME_PATTERN);
        const bytes = files.get(dir + name);
        if (bytes === undefined) throw new BridgeFail(404, 'notFound', 'missing file');
        return {
          status: 200,
          bytes: Buffer.from(bytes),
          headers: { 'Content-Type': 'application/octet-stream', 'X-Opt2-Sha256': sha256Hex(bytes) },
        };
      }
      case 'put': {
        const name = requireParam(req, 'name', STORED_NAME_PATTERN);
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('application/octet-stream')) throw badRequest('body must be application/octet-stream');
        const declared = req.headers[SHA256_HEADER];
        if (typeof declared !== 'string' || declared === '') throw badRequest('missing X-Opt2-Sha256');
        const sha256 = sha256Hex(req.body);
        if (sha256 !== declared.toLowerCase()) throw new BridgeFail(400, 'hashMismatch', 'body does not hash to X-Opt2-Sha256');
        files.set(dir + name, Buffer.from(req.body));
        fileTimes.set(dir + name, formatWireTime(req.now));
        const reply: Omit<FilePutResult, 'serverTime'> = { written: true, name, size: req.body.length, sha256 };
        return { status: 200, json: { ...reply } };
      }
      default: {
        // By name (which wins when both are given), or every <fileId>* file as deleteCachedFile does (fileDAO.cfc:382-402).
        let names: string[];
        if (req.query.name !== undefined) {
          const name = requireParam(req, 'name', STORED_NAME_PATTERN);
          names = files.has(dir + name) ? [name] : [];
        } else if (req.query.fileId !== undefined) {
          const prefix = dir + requireParam(req, 'fileId', FILE_ID_PATTERN);
          names = [...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(dir.length));
          names = names.filter((name) => !name.includes('/')).sort(byCodeUnit);
        } else {
          throw badRequest('missing name or fileId');
        }
        for (const name of names) {
          files.delete(dir + name);
          fileTimes.delete(dir + name);
        }
        return { status: 200, json: { deleted: names } satisfies Omit<FileDeleteResult, 'serverTime'> };
      }
    }
  };

  // ---- guard and dispatch

  /** Application.cfc's guard: the verified payload when it is signed for this page's op and the URL `siteid`. */
  const guard = (file: BridgePage, query: Record<string, string>, header: unknown): BridgeAssertionPayload | BridgeRejectionReason => {
    if (typeof header !== 'string' || header === '') return 'missingAssertion';
    // createBridgeClient signs with the wall clock, so assertions are checked at the wall clock whatever `clock` reads.
    const result = verifyBridgeAssertion(header, key, nonces, systemClock.now());
    if (!result.ok) return result.reason;
    const urlOp = query[file === 'jobs' ? 'job' : 'op'] ?? '';
    if (urlOp === '' || result.payload.op !== `${file}.${urlOp}`) return 'opMismatch';
    if ((query.siteid ?? '') !== result.payload.siteId) return 'siteMismatch';
    return result.payload;
  };

  const run = (file: BridgePage, op: string, req: PageRequest): Reply => {
    switch (file) {
      case 'files':
        return filesPage(op, req);
      case 'jobs':
        return { status: 200, json: jobs(op, req) };
      case 'scheduler':
        return { status: 200, json: scheduler(op, req) };
      default:
        return { status: 200, json: site(op, req) };
    }
  };

  /** The answer of a call `failNext` scripted. */
  const injected = (failure: { status: number; body: object | string | undefined }): Reply => {
    const { status, body } = failure;
    if (body === undefined) return { status, json: { error: 'serverError', message: 'injected failure' } };
    if (typeof body === 'string') return { status, bytes: Buffer.from(body, 'utf8'), headers: { 'Content-Type': 'text/plain; charset=utf-8' } };
    if (isRecord(body)) return { status, json: { ...body } };
    return { status, bytes: Buffer.from(JSON.stringify(body), 'utf8'), headers: { 'Content-Type': JSON_TYPE } };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const query = queryOf(url);
    const method = req.method ?? 'GET';
    const now = clock.now();
    const page = url.pathname.startsWith(BRIDGE_PATH) ? /^([a-z]+)\.cfm$/.exec(url.pathname.slice(BRIDGE_PATH.length))?.[1] : undefined;
    if (page === undefined || !PAGES.has(page)) {
      sendReply(res, { status: 404, bytes: Buffer.alloc(0), headers: {} }, now);
      return;
    }
    const file = page as BridgePage;
    const verdict = guard(file, query, req.headers[ASSERTION_HEADER]);
    if (typeof verdict === 'string') {
      rejected.push({ path: url.pathname, method, query, reason: verdict, at: now });
      sendReply(res, { status: 403, bytes: Buffer.alloc(0), headers: {} }, now);
      return;
    }

    const opOrJob = query[file === 'jobs' ? 'job' : 'op'] ?? '';
    const op = `${file}.${opOrJob}`;
    const call: BridgeCall = { file, op, method, query, body: recordedBody(file, body), assertion: verdict, status: 200, at: now };
    calls.push(call);
    opts.log?.append(BRIDGE_COMPONENT, op, query);
    const failure = failures.get(op)?.shift();
    let reply: Reply;
    if (failure !== undefined) {
      reply = injected(failure);
    } else {
      try {
        reply = run(file, opOrJob, { method, query, headers: req.headers, body, now });
      } catch (error) {
        // Each page's catch (any e) answers 500 serverError with the exception type only.
        const fail = error instanceof BridgeFail ? error : new BridgeFail(500, 'serverError', error instanceof Error ? error.name : 'Error');
        reply = { status: fail.status, json: { error: fail.error, message: fail.message } };
      }
    }
    call.status = reply.status;
    sendReply(res, reply, now);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    calls,
    rejected,
    tasks,
    capturedTasks,
    cursor,
    jobRuns,
    purges,
    refreshes,
    sites,
    files,
    get fileStore() {
      return fileStore;
    },
    setFileStore(store) {
      fileStore = store;
    },
    failNext(op, status, body) {
      failures.set(op, [...(failures.get(op) ?? []), { status, body }]);
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

/** Writes a reply; a JSON body gets `serverTime` when it has none, as Application.cfc's respondJson adds it. */
function sendReply(res: ServerResponse, reply: Reply, now: Date): void {
  if ('json' in reply) {
    const text = JSON.stringify('serverTime' in reply.json ? reply.json : { ...reply.json, serverTime: formatWireTime(now) });
    res.writeHead(reply.status, { 'Content-Type': JSON_TYPE, 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  res.writeHead(reply.status, { ...reply.headers, 'Content-Length': reply.bytes.length });
  res.end(reply.bytes);
}

