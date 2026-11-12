// Seam checks run against a scripted gateway, owner exports and clock: no socket, emulator or real timer is used.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INVOCATION_HEADER, Roles, loadLocalSigningKeys, verifyLocalServiceToken } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, CSRF_HEADER_TOKEN } from '@opt2/platform/legacy-compat';
import {
  MAX_EXPORT_LIMIT,
  MIGRATION_PATH_PREFIX,
  encodeKey,
  encodeRow,
  sha256Hex,
  type CanonicalColumn,
  type CanonicalType,
  type ExportResponse,
  type ExportTable,
} from '@opt2/platform/migration-kit';
import { QUEUES } from '@opt2/platform/tasks';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, registryPayloads, writeTestSecrets } from '@opt2/platform/testing';

import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SEAM_SITE,
  isOpenDay,
  pollUntil,
  readOwnerExport,
  runSeam1,
  runSeam2,
  siteRegistry,
  unitFor,
  type SeamDeps,
  type SeamResult,
} from '../../src/events/seams.js';
import type { FixtureStatus } from '../../src/golden/catalogue.js';
import type { SecretStore, SeedStore } from '../../src/golden/session.js';
import type { FetchLike } from '../../src/lib/http.js';
import { createHarnessInvoker, harnessCallerRoles, type HarnessInvoker } from '../../src/lib/invocation.js';
import type { PackageName } from '../../src/repro/ports.js';

type Row = Record<string, unknown>;

// No listener on these ports; every request goes to the fake fetch of its test.
const GATEWAY = 'http://127.0.0.1:8500';
const PEOPLE_URL = 'http://127.0.0.1:8512';
const SITES_URL = 'http://127.0.0.1:8513';
const COMMUNICATIONS_URL = 'http://127.0.0.1:8515';
const TIMESHEETS_URL = 'http://127.0.0.1:8518';
const SERVICE_URLS = {
  people: PEOPLE_URL,
  'programs-sites': SITES_URL,
  communications: COMMUNICATIONS_URL,
  timesheets: TIMESHEETS_URL,
} as const satisfies Partial<Record<PackageName, string>>;
const SERVICE_BY_ORIGIN: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SERVICE_URLS).map(([service, url]) => [url, service]),
);

const EXPORT_PATH = `${MIGRATION_PATH_PREFIX}/export`;
const FIXTURE_API = '/legacy-fixtures/cfml/api.cfm';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;
const CSRF_HEADER = CSRF_HEADER_TOKEN.toLowerCase();
const CSRF_EXPIRES = '260630120000000';
const INVOCATION_CREDENTIAL = 'Bearer FIXTURE-invocation-credential';
const SESSION_COOKIES = ['CFID=FIXTURE-cfid; Path=/; HttpOnly', 'CFTOKEN=FIXTURE-cftoken; Path=/; HttpOnly'];

const BUSINESS_DATE = '2026-06-30';
/** Local wall-clock start of every stack clock: the business day, before the seam 2 default launch at midnight. */
const CLOCK_START = Date.parse(`${BUSINESS_DATE}T08:00:00`);
const AVAILABLE: FixtureStatus = { available: true, reason: null, checkedAt: '2026-06-30T07:00:00.000Z' };
const POLL = { timeoutMs: 3_000, intervalMs: 1_000 };
/** Delay after the archive or schedule POST at which the consumer's rows become visible. */
const DELIVERY_MS = 1_000;

const LAUNCH_QUEUE = QUEUES['surveys-launch'].name;
const REMINDER_QUEUE = QUEUES['communications-reminders'].name;

const PERSON = 'A1B2C3D4-0001-0001-0001000000000001';
const RESERVED_PERSON = 'A1B2C3D4-0001-0001-0001000000000002';
const ARCHIVED_PERSON = 'A1B2C3D4-0001-0001-0001000000000003';
const CLOSED_PERSON = 'A1B2C3D4-0001-0001-0001000000000004';
const PERSON_B = 'A1B2C3D4-0001-0001-0001000000000005';
const SURVEY = 'B1B2C3D4-0002-0002-0002000000000001';
const OTHER_SURVEY = 'B1B2C3D4-0002-0002-0002000000000002';
const SCHEDULE_VERSION = 3;
const LAUNCH_TASK = `${LAUNCH_QUEUE}-${SURVEY}-v${SCHEDULE_VERSION}`;
const FIRST_REMINDER = `${REMINDER_QUEUE}-${SURVEY}-v${SCHEDULE_VERSION}-r1`;
const SECOND_REMINDER = `${REMINDER_QUEUE}-${SURVEY}-v${SCHEDULE_VERSION}-r2`;
const DIGEST_TASK = `communications-digest-${SURVEY}`;

/** Seeded accounts the gateway accepts, as `[site, role]`. */
const ACCOUNTS: readonly (readonly [string, string])[] = [
  [TENANT_UMBRELLA.siteId, 'site-admin'],
  [TENANT_B.siteId, 'site-admin'],
  [TENANT_A.siteId, 'surveys.manager'],
];

const SECRETS: SecretStore = {
  username: (site, role) => `FIXTURE-${site}-${role}`,
  secret: (name) => `FIXTURE-password-${name}`,
  values: () => [],
};

interface UnitTable {
  unit: string;
  legacyTable: string;
  key: string;
  columns: CanonicalColumn[];
}

function columns(...specs: (readonly [string, CanonicalType])[]): CanonicalColumn[] {
  return specs.map(([name, type]) => ({ name, type }));
}

const SITE: UnitTable = {
  unit: 'programs_sites.site',
  legacyTable: 'tsettings',
  key: 'SiteID',
  columns: columns(['SiteID', 's'], ['publicUserPoolID', 's'], ['privateUserPoolID', 's']),
};
const TIMESHEET: UnitTable = {
  unit: 'timesheets.timesheet',
  legacyTable: 'timesheet',
  key: 'timesheet_id',
  columns: columns(['timesheet_id', 's'], ['person_id', 's'], ['siteID', 's'], ['period_start', 't']),
};
const TIMESHEET_DAY: UnitTable = {
  unit: 'timesheets.timesheet_day',
  legacyTable: 'timesheet_day',
  key: 'day_id',
  columns: columns(['day_id', 's'], ['timesheet_id', 's'], ['work_date', 't'], ['state', 's']),
};
const BLACKOUT: UnitTable = {
  unit: 'timesheets.blackout',
  legacyTable: 'blackout',
  key: 'blackout_id',
  columns: columns(['blackout_id', 's'], ['day_id', 's'], ['person_id', 's'], ['archive_id', 's'], ['created', 't']),
};
const PERSON_ARCHIVE: UnitTable = {
  unit: 'people.person_archive',
  legacyTable: 'person_archive',
  key: 'archive_id',
  columns: columns(['archive_id', 's'], ['person_id', 's'], ['siteID', 's'], ['effective_from', 't']),
};
const PERSON_TABLE: UnitTable = {
  unit: 'people.person',
  legacyTable: 'tusers',
  key: 'UserID',
  columns: columns(['UserID', 's'], ['SiteID', 's']),
};
const SCHEDULED_TASK: UnitTable = {
  unit: 'communications.scheduled_task',
  legacyTable: 'scheduled_task',
  key: 'scheduled_task_id',
  columns: columns(
    ['scheduled_task_id', 's'],
    ['task_name', 's'],
    ['kind', 's'],
    ['queue', 's'],
    ['schedule_time', 't'],
    ['status', 's'],
    ['source_type', 's'],
    ['source_id', 's'],
    ['schedule_version', 'i'],
  ),
};

/** One unit's rows on an export page, encoded by the migration kit. */
function exportTable(table: UnitTable, rows: readonly Row[]): ExportTable {
  return {
    unit: table.unit,
    legacyTable: table.legacyTable,
    targetTable: table.unit,
    keyless: false,
    columns: table.columns,
    rows: rows.map((row) => {
      const encoded = encodeRow(table.columns, row);
      return { key: encodeKey(table.columns, [table.key], row), row: encoded, hash: sha256Hex(encoded) };
    }),
  };
}

function exportPage(unit: string, tenantId: string, tables: ExportTable[], next: string | null = null): ExportResponse {
  return { unit, tenantId, tables, next };
}

/** One request the fake fetch received; header names as the session sent them (lower-cased). */
interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

interface Route {
  method: 'GET' | 'POST';
  /** Matched against the request's origin and path, without its query. */
  url: RegExp;
  reply: (request: RecordedRequest, match: RegExpExecArray) => Response;
}

/** Fetch answering the first matching route and 404 otherwise, recording every request. */
function fakeFetch(routes: readonly Route[]): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const raw = init.body;
    const body = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : undefined;
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body,
    };
    requests.push(request);
    const target = `${url.origin}${url.pathname}`;
    for (const route of routes) {
      const match = route.method === request.method ? route.url.exec(target) : null;
      if (match !== null) return route.reply(request, match);
    }
    return new Response(`no fake route for ${request.method} ${target}`, { status: 404 });
  };
  return { fetch, requests };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Route pattern of `origin` plus `pathPattern`, a regular-expression source. */
function at(origin: string, pathPattern: string): RegExp {
  return new RegExp(`^${escapeRegExp(origin)}${pathPattern}$`);
}

function cookieHeaders(setCookie: readonly string[]): [string, string][] {
  return setCookie.map((line) => ['set-cookie', line]);
}

function json(body: unknown, status = 200, setCookie: readonly string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: [['content-type', 'application/json; charset=utf-8'], ...cookieHeaders(setCookie)],
  });
}

function html(markup: string, setCookie: readonly string[] = []): Response {
  return new Response(`<!DOCTYPE html><html><body>${markup}</body></html>`, {
    headers: [['content-type', 'text/html; charset=utf-8'], ...cookieHeaders(setCookie)],
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** Owner export route answering 401 without an invocation credential, else the tables `tables` gives. */
function exportRoute(origin: string, tables: (unit: string, tenantId: string) => ExportTable[]): Route {
  return {
    method: 'GET',
    url: at(origin, escapeRegExp(EXPORT_PATH)),
    reply: (request) => {
      if (request.headers[INVOCATION_HEADER] === undefined) return json({ error: 'unauthenticated' }, 401);
      const unit = request.url.searchParams.get('unit') ?? '';
      const tenantId = request.url.searchParams.get('tenantId') ?? '';
      return json(exportPage(unit, tenantId, tables(unit, tenantId)));
    },
  };
}

function csrfToken(context: string): string {
  return `FIXTURE-csrf-${context}`;
}

const ADMIN_LOGIN_FORM = `
<form novalidate="novalidate" id="loginForm" name="frmLogin" method="post" action="index.cfm">
  <input id="username" name="username" type="text">
  <input id="password" type="password" name="password">
  <input type="hidden" name="muraAction" value="cLogin.login">
  <input type="hidden" name="isAdminLogin" value="true">
  <input type="hidden" name="${CSRF_FIELD_TOKEN}" value="${csrfToken('login')}">
  <input type="hidden" name="${CSRF_FIELD_EXPIRES}" value="${CSRF_EXPIRES}">
</form>`;

/** Programs-sites site rows of the three fixture tenants, pools as registryPayloads() seeds them. */
function registryRows(): Row[] {
  return registryPayloads().map((site) => ({
    SiteID: site.siteId,
    publicUserPoolID: site.publicUserPoolId,
    privateUserPoolID: site.privateUserPoolId,
  }));
}

const SITE_IDS = registryPayloads().map((site) => site.siteId);

function sheet(timesheetId: string, personId: string, siteId: string): Row {
  return { timesheet_id: timesheetId, person_id: personId, siteID: siteId, period_start: '2026-06-29T00:00:00' };
}

function day(dayId: string, timesheetId: string, date: string, state: string): Row {
  return { day_id: dayId, timesheet_id: timesheetId, work_date: `${date}T00:00:00`, state };
}

function blackout(blackoutId: string, dayId: string, personId: string, archiveId: string): Row {
  return { blackout_id: blackoutId, day_id: dayId, person_id: personId, archive_id: archiveId, created: '2026-06-01T09:00:00' };
}

interface TenantTimesheets {
  sheets: Row[];
  days: Row[];
  blackouts: Row[];
}

/**
 * Timesheets per tenant. In tenant-a only PERSON qualifies as the default person; PERSON also works in umbrella,
 * where an earlier blackout exists, and holds an open day in tenant-b, outside its user-pool fan-out.
 */
function seededTimesheets(): Map<string, TenantTimesheets> {
  return new Map([
    [
      TENANT_A.tenantId,
      {
        sheets: [
          sheet('TS-A-RES', RESERVED_PERSON, TENANT_A.siteId),
          sheet('TS-A-ARC', ARCHIVED_PERSON, TENANT_A.siteId),
          sheet('TS-A-CLO', CLOSED_PERSON, TENANT_A.siteId),
          sheet('TS-A-P', PERSON, TENANT_A.siteId),
        ],
        days: [
          day('DAY-A-R1', 'TS-A-RES', '2026-07-01', 'IN-PROGRESS'),
          day('DAY-A-X1', 'TS-A-ARC', '2026-07-01', 'SUBMITTED'),
          day('DAY-A-C1', 'TS-A-CLO', '2026-07-01', 'APPROVED'),
          day('DAY-A-C2', 'TS-A-CLO', '2026-06-29', 'IN-PROGRESS'),
          day('DAY-A-P1', 'TS-A-P', '2026-06-30', 'IN-PROGRESS'),
          day('DAY-A-P2', 'TS-A-P', '2026-07-01', 'submitted'),
          day('DAY-A-P3', 'TS-A-P', '2026-06-29', 'IN-PROGRESS'),
          day('DAY-A-P4', 'TS-A-P', '2026-07-02', 'approved  '),
        ],
        blackouts: [],
      },
    ],
    [
      TENANT_UMBRELLA.tenantId,
      {
        sheets: [sheet('TS-U-P', PERSON, TENANT_UMBRELLA.siteId)],
        days: [day('DAY-U-P0', 'TS-U-P', '2026-06-01', 'APPROVED'), day('DAY-U-P1', 'TS-U-P', '2026-07-03', 'RE-SUBMITTED')],
        blackouts: [blackout('BO-U-0', 'DAY-U-P0', PERSON, 'ARC-EARLIER')],
      },
    ],
    [
      TENANT_B.tenantId,
      {
        sheets: [sheet('TS-B-P', PERSON, TENANT_B.siteId), sheet('TS-B-Q', PERSON_B, TENANT_B.siteId)],
        days: [
          day('DAY-B-P1', 'TS-B-P', '2026-07-01', 'IN-PROGRESS'),
          day('DAY-B-Q1', 'TS-B-Q', '2026-07-01', 'IN-PROGRESS'),
          day('DAY-B-Q2', 'TS-B-Q', '2026-06-15', 'IN-PROGRESS'),
        ],
        blackouts: [],
      },
    ],
  ]);
}

/** The correct fan-out of PERSON's archive: umbrella (its tenant) and tenant-a (public pool umbrella). */
const POOLED_FAN_OUT: Readonly<Record<string, readonly string[]>> = {
  [TENANT_UMBRELLA.tenantId]: ['DAY-U-P1'],
  [TENANT_A.tenantId]: ['DAY-A-P1', 'DAY-A-P2'],
};

const SEED_USERS: readonly Row[] = [
  { userID: PERSON, siteID: TENANT_UMBRELLA.siteId },
  { userID: PERSON_B, siteID: TENANT_B.siteId },
];
const SEED_SURVEYS: readonly Row[] = [
  { survey_id: OTHER_SURVEY, siteID: TENANT_A.siteId, status: 'SCHEDULED' },
  { survey_id: SURVEY, siteID: TENANT_A.siteId, status: 'DRAFT' },
];

function seedStore(reserved: readonly string[] = [RESERVED_PERSON]): SeedStore {
  const lists: Readonly<Record<string, readonly Row[]>> = { 'masa.users': SEED_USERS, 'fixtures.synthetic.survey': SEED_SURVEYS };
  return {
    select(ref) {
      if (ref.source === 'reserved' && ref.path === 'reserved.rehearsal') return { site: TENANT_A.siteId, persons: [...reserved] };
      const where = Object.entries(ref.where ?? {});
      const row = (lists[ref.path] ?? []).find((candidate) => where.every(([name, value]) => candidate[name] === value));
      if (row === undefined) throw new Error(`seed has no ${ref.path} row matching ${JSON.stringify(ref.where)}`);
      return row;
    },
    businessDate: () => BUSINESS_DATE,
  };
}

function taskRow(task: {
  id: string;
  name: string;
  kind: string;
  queue: string;
  at: string;
  surveyId: string;
  version: number;
  status?: string;
  sourceType?: string;
}): Row {
  return {
    scheduled_task_id: task.id,
    task_name: task.name,
    kind: task.kind,
    queue: task.queue,
    schedule_time: task.at,
    status: task.status ?? 'scheduled',
    source_type: task.sourceType ?? 'survey',
    source_id: task.surveyId.toLowerCase(),
    schedule_version: task.version,
  };
}

/** `wallClock` plus `seconds`, both zone-less. */
function plusSeconds(wallClock: string, seconds: number): string {
  return new Date(Date.parse(`${wallClock}Z`) + seconds * 1000).toISOString().slice(0, 19);
}

/** The tasks communications plans for a schedule: one launch at `launchAt`, one reminder per offset. */
function plannedTasks(surveyId: string, launchAt: string, reminders: readonly { offsetMinutes: number }[]): Row[] {
  const base = { surveyId, version: SCHEDULE_VERSION };
  return [
    taskRow({
      ...base,
      id: 'ST-LAUNCH',
      name: `${LAUNCH_QUEUE}-${surveyId}-v${SCHEDULE_VERSION}`,
      kind: 'survey-launch',
      queue: LAUNCH_QUEUE,
      at: launchAt,
    }),
    ...reminders.map((reminder, index) =>
      taskRow({
        ...base,
        id: `ST-REMINDER-${index + 1}`,
        name: `${REMINDER_QUEUE}-${surveyId}-v${SCHEDULE_VERSION}-r${index + 1}`,
        kind: 'survey-reminder',
        queue: REMINDER_QUEUE,
        at: plusSeconds(launchAt, reminder.offsetMinutes * 60),
      }),
    ),
  ];
}

/** Task rows of other versions, surveys and sources that seam 2 must leave out. */
const EARLIER_TASKS: readonly Row[] = [
  taskRow({
    id: 'ST-OLD',
    name: `${LAUNCH_QUEUE}-${SURVEY}-v2`,
    kind: 'survey-launch',
    queue: LAUNCH_QUEUE,
    at: '2026-06-20T00:00:00',
    surveyId: SURVEY,
    version: 2,
    status: 'superseded',
  }),
  taskRow({
    id: 'ST-OTHER',
    name: `${LAUNCH_QUEUE}-${OTHER_SURVEY}-v${SCHEDULE_VERSION}`,
    kind: 'survey-launch',
    queue: LAUNCH_QUEUE,
    at: '2026-07-01T00:00:00',
    surveyId: OTHER_SURVEY,
    version: SCHEDULE_VERSION,
  }),
  taskRow({
    id: 'ST-CAMPAIGN',
    name: `${REMINDER_QUEUE}-campaign`,
    kind: 'survey-reminder',
    queue: REMINDER_QUEUE,
    at: '2026-07-01T00:00:00',
    surveyId: SURVEY,
    version: SCHEDULE_VERSION,
    sourceType: 'campaign',
  }),
];

interface StackOptions {
  /** Day ids the timesheets consumer blacks out per tenant, {@link DELIVERY_MS} after the archive. */
  fanOut?: Readonly<Record<string, readonly string[]>>;
  /** Answer of the archive route instead of accepting. */
  archiveRefusal?: () => Response;
  /** Status the schedule route answers instead of accepting. */
  scheduleStatus?: number;
  /** `schedule_version` of the schedule response; null leaves it out. */
  scheduleVersion?: number | null;
  /** Rewrites the task rows communications plans for the schedule. */
  plan?: (rows: Row[]) => Row[];
  existingTasks?: readonly Row[];
  /** False when the communications export carries no table for the scheduled-task unit. */
  exportsTaskTable?: boolean;
  /** Status the fixture task list answers instead of listing. */
  taskListStatus?: number;
  refuseLogins?: boolean;
  clockStart?: number;
}

interface SeamStack {
  deps: SeamDeps;
  requests: RecordedRequest[];
  sleeps: number[];
  /** Callee of every invocation credential minted, in order. */
  callees: string[];
}

let stateRoot: string;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(os.tmpdir(), 'opt2-seams-'));
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

/** Harness invoker whose minter returns a placeholder credential and records each callee. */
async function stubInvoker(callees: string[] = []): Promise<HarnessInvoker> {
  return createHarnessInvoker({
    caller: 'migration',
    env: { OPT2_STATE_DIR: stateRoot },
    minterFactory: () => ({
      async headersFor({ name }) {
        callees.push(name);
        return { [INVOCATION_HEADER]: INVOCATION_CREDENTIAL };
      },
    }),
  });
}

/** Gateway, legacy fixture routes, owner exports and a clock that only `sleep` advances. */
async function seamStack(options: StackOptions = {}): Promise<SeamStack> {
  let now = options.clockStart ?? CLOCK_START;
  const sleeps: number[] = [];
  const callees: string[] = [];
  const timesheets = seededTimesheets();
  const delivered: { tenantId: string; at: number; row: Row }[] = [];
  const tasks: { tenantId: string; at: number; row: Row }[] = (options.existingTasks ?? []).map((row) => ({
    tenantId: TENANT_A.tenantId,
    at: now,
    row,
  }));
  const visible = <T extends { at: number }>(entries: readonly T[]): T[] => entries.filter((entry) => entry.at <= now);
  const accounts = new Map(
    ACCOUNTS.map(([site, role]) => {
      const username = SECRETS.username(site, role);
      return [username, SECRETS.secret(`seed:${username}`)];
    }),
  );
  const accepts = (form: URLSearchParams): boolean =>
    options.refuseLogins !== true && accounts.get(form.get('username') ?? '') === form.get('password');
  const inSession = (request: RecordedRequest): boolean => (request.headers.cookie ?? '').includes('CFID=');
  const holdsToken = (request: RecordedRequest, context: string): boolean =>
    request.headers[CSRF_HEADER] === csrfToken(context) && inSession(request);
  const surveyTasks = (tenantId: string, surveyId: string): Row[] =>
    visible(tasks)
      .filter((entry) => entry.tenantId === tenantId)
      .map((entry) => entry.row)
      .filter(
        (row) =>
          row.source_type === 'survey' &&
          String(row.source_id).toUpperCase() === surveyId.toUpperCase() &&
          row.schedule_version === SCHEDULE_VERSION,
      );

  const timesheetTables = (unit: string, tenantId: string): ExportTable[] => {
    const data = timesheets.get(tenantId) ?? { sheets: [], days: [], blackouts: [] };
    if (unit === TIMESHEET.unit) return [exportTable(TIMESHEET, data.sheets)];
    if (unit === TIMESHEET_DAY.unit) return [exportTable(TIMESHEET_DAY, data.days)];
    if (unit !== BLACKOUT.unit) return [];
    const arrived = visible(delivered).filter((entry) => entry.tenantId === tenantId);
    return [exportTable(BLACKOUT, [...data.blackouts, ...arrived.map((entry) => entry.row)])];
  };

  const { fetch, requests } = fakeFetch([
    {
      method: 'GET',
      url: at(GATEWAY, '/admin/'),
      reply: (request) =>
        request.url.searchParams.get('muraAction') === 'clogin.main'
          ? html(ADMIN_LOGIN_FORM, inSession(request) ? [] : SESSION_COOKIES)
          : html('<h1>Masa CMS - Site Content</h1>'),
    },
    {
      method: 'POST',
      url: at(GATEWAY, '/admin/index\\.cfm'),
      reply: (request) => {
        const form = new URLSearchParams(request.body);
        const valid = accepts(form) && form.get(CSRF_FIELD_TOKEN) === csrfToken('login');
        return redirect(valid ? './' : './?muraAction=clogin.main');
      },
    },
    {
      method: 'GET',
      url: at(GATEWAY, '/_api/json/v1/([^/]+)/generateCSRFTokens'),
      reply: (request) =>
        json(
          { data: { [CSRF_FIELD_TOKEN]: csrfToken(request.url.searchParams.get('context') ?? ''), [CSRF_FIELD_EXPIRES]: CSRF_EXPIRES } },
          200,
          inSession(request) ? [] : SESSION_COOKIES,
        ),
    },
    {
      method: 'POST',
      url: at(GATEWAY, '/_api/json/v1/([^/]+)/login'),
      reply: (request) => {
        const valid = accepts(new URLSearchParams(request.body)) && request.headers[CSRF_HEADER] === csrfToken('login');
        return json({ data: valid ? { status: 'success' } : { status: 'failed', message: 'login failed' } });
      },
    },
    {
      method: 'POST',
      url: at(GATEWAY, `${escapeRegExp(FIXTURE_API)}/people/persons/([^/]+)/archive`),
      reply: (request, match) => {
        const userId = decodeURIComponent(match[1] ?? '');
        if (!holdsToken(request, userId)) return json({ error: 'invalid csrf token' }, 403);
        if (options.archiveRefusal !== undefined) return options.archiveRefusal();
        for (const [tenantId, dayIds] of Object.entries(options.fanOut ?? POOLED_FAN_OUT)) {
          for (const dayId of dayIds) {
            const row = blackout(`BO-SEAM-${delivered.length + 1}`, dayId, userId.toLowerCase(), 'ARC-SEAM');
            delivered.push({ tenantId, at: now + DELIVERY_MS, row });
          }
        }
        return json({ data: { archive_id: 'ARC-SEAM', person_id: userId } });
      },
    },
    {
      method: 'POST',
      url: at(GATEWAY, `${escapeRegExp(FIXTURE_API)}/surveys/surveys/([^/]+)/schedule`),
      reply: (request, match) => {
        const surveyId = decodeURIComponent(match[1] ?? '');
        if (!holdsToken(request, surveyId)) return json({ error: 'invalid csrf token' }, 403);
        if (options.scheduleStatus !== undefined) return json({ error: 'survey is not DRAFT' }, options.scheduleStatus);
        const body = JSON.parse(request.body ?? '{}') as { launchAt: string; reminders: { offsetMinutes: number }[] };
        const tenantId = tenantIdForSite(request.url.searchParams.get('siteid') ?? '');
        const planned = plannedTasks(surveyId, body.launchAt, body.reminders);
        for (const row of (options.plan ?? ((rows) => rows))(planned)) tasks.push({ tenantId, at: now + DELIVERY_MS, row });
        const version = options.scheduleVersion === undefined ? SCHEDULE_VERSION : options.scheduleVersion;
        const schedule = version === null ? { survey_id: surveyId } : { survey_id: surveyId, schedule_version: version };
        return json({ data: { schedule } });
      },
    },
    {
      method: 'GET',
      url: at(GATEWAY, `${escapeRegExp(FIXTURE_API)}/surveys/surveys/([^/]+)/tasks`),
      reply: (request, match) => {
        if (options.taskListStatus !== undefined) return json({ error: 'cfschedule list failed' }, options.taskListStatus);
        const tenantId = tenantIdForSite(request.url.searchParams.get('siteid') ?? '');
        const items = surveyTasks(tenantId, decodeURIComponent(match[1] ?? '')).map((row) => ({
          taskname: row.task_name,
          kind: String(row.kind).replace(/^survey-/, ''),
        }));
        return json({ data: { items } });
      },
    },
    exportRoute(SITES_URL, (unit, tenantId) =>
      unit === SITE.unit ? [exportTable(SITE, registryRows().filter((row) => tenantIdForSite(String(row.SiteID)) === tenantId))] : [],
    ),
    exportRoute(PEOPLE_URL, (unit, tenantId) => {
      if (unit !== PERSON_ARCHIVE.unit) return [];
      const archived = {
        archive_id: 'ARC-EARLIER',
        person_id: ARCHIVED_PERSON,
        siteID: TENANT_A.siteId,
        effective_from: '2026-06-01T00:00:00',
      };
      return [exportTable(PERSON_ARCHIVE, tenantId === TENANT_A.tenantId ? [archived] : [])];
    }),
    exportRoute(TIMESHEETS_URL, timesheetTables),
    exportRoute(COMMUNICATIONS_URL, (unit, tenantId) =>
      unit === SCHEDULED_TASK.unit && options.exportsTaskTable !== false
        ? [exportTable(SCHEDULED_TASK, visible(tasks).filter((entry) => entry.tenantId === tenantId).map((entry) => entry.row))]
        : [],
    ),
  ]);

  return {
    deps: {
      env: { OPT2_GATEWAY_URL: GATEWAY, OPT2_STATE_DIR: stateRoot },
      fetch,
      invoker: await stubInvoker(callees),
      secrets: SECRETS,
      seed: seedStore(),
      serviceUrls: SERVICE_URLS,
      siteIds: SITE_IDS,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      poll: POLL,
      fixtures: AVAILABLE,
    },
    requests,
    sleeps,
    callees,
  };
}

/** The evidence of a seam that ran; fails the test when it was skipped. */
function ran<E>(result: SeamResult<E>): { passed: boolean; evidence: E } {
  if (result.skipped !== undefined) throw new Error(`seam skipped: ${String(result.evidence.reason)}`);
  return result;
}

function posts(stack: SeamStack, suffix: string): RecordedRequest[] {
  return stack.requests.filter((request) => request.method === 'POST' && request.url.pathname.endsWith(suffix));
}

function exportRequests(stack: SeamStack): RecordedRequest[] {
  return stack.requests.filter((request) => request.url.pathname === EXPORT_PATH);
}

describe('runSeam1', () => {
  it('archives a pooled umbrella person once through the gateway and finds its blackouts in umbrella and tenant-a only', async () => {
    const stack = await seamStack();

    const result = ran(await runSeam1(stack.deps));

    expect(result.passed).toBe(true);
    const { evidence } = result;
    expect(evidence).toMatchObject({
      personId: PERSON,
      siteId: TENANT_UMBRELLA.siteId,
      effectiveFrom: BUSINESS_DATE,
      archive: { status: 200, body: { data: { archive_id: 'ARC-SEAM', person_id: PERSON } } },
      polls: 2,
      elapsedMs: DELIVERY_MS,
      timedOut: false,
    });
    expect(evidence.destinations).toEqual([
      {
        siteId: TENANT_UMBRELLA.siteId,
        tenantId: TENANT_UMBRELLA.tenantId,
        reason: 'person-tenant',
        expectedDayIds: ['DAY-U-P0', 'DAY-U-P1'],
        preexistingDayIds: ['DAY-U-P0'],
        blackoutDayIds: ['DAY-U-P0', 'DAY-U-P1'],
      },
      {
        siteId: TENANT_A.siteId,
        tenantId: TENANT_A.tenantId,
        reason: 'userPool',
        expectedDayIds: ['DAY-A-P1', 'DAY-A-P2'],
        preexistingDayIds: [],
        blackoutDayIds: ['DAY-A-P1', 'DAY-A-P2'],
      },
    ]);
    expect(evidence.otherTenants).toEqual([{ siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId, blackoutRows: 0 }]);
    expect(stack.sleeps).toEqual([DELIVERY_MS]);

    const archives = posts(stack, '/archive');
    expect(archives).toHaveLength(1);
    const [archive] = archives;
    expect(archive?.url.origin).toBe(GATEWAY);
    expect(archive?.url.pathname).toBe(`${FIXTURE_API}/people/persons/${PERSON}/archive`);
    expect(archive?.url.searchParams.get('siteid')).toBe(TENANT_UMBRELLA.siteId);
    expect(JSON.parse(archive?.body ?? 'null')).toEqual({ effectiveFrom: BUSINESS_DATE });
    expect(archive?.headers.traceparent).toMatch(TRACEPARENT);
    expect(archive?.headers.traceparent?.split('-')[1]).toBe(evidence.traceId);
    expect(archive?.headers[CSRF_HEADER]).toBe(csrfToken(PERSON));

    const login = posts(stack, '/admin/index.cfm');
    expect(new URLSearchParams(login[0]?.body).get('username')).toBe(SECRETS.username(TENANT_UMBRELLA.siteId, 'site-admin'));
    const exports = exportRequests(stack);
    expect(exports.map((request) => request.headers[INVOCATION_HEADER])).toEqual(exports.map(() => INVOCATION_CREDENTIAL));
    expect(exports.filter((request) => request.headers.authorization !== undefined)).toEqual([]);
    expect(stack.callees).toEqual(exports.map((request) => SERVICE_BY_ORIGIN[request.url.origin]));
  });

  it.each([
    {
      title: 'fails naming tenant-b when a blackout lands there outside the fan-out',
      fanOut: { ...POOLED_FAN_OUT, [TENANT_B.tenantId]: ['DAY-B-P1'] },
      blackouts: [
        ['DAY-U-P0', 'DAY-U-P1'],
        ['DAY-A-P1', 'DAY-A-P2'],
      ],
      tenantBRows: 1,
      polls: 2,
      timedOut: false,
    },
    {
      title: 'fails once the poll budget runs out when the fan-out never reaches tenant-a',
      fanOut: { [TENANT_UMBRELLA.tenantId]: ['DAY-U-P1'] },
      blackouts: [['DAY-U-P0', 'DAY-U-P1'], []],
      tenantBRows: 0,
      polls: 4,
      timedOut: true,
    },
    {
      title: 'fails without waiting out the budget when a day is blacked out twice',
      fanOut: { ...POOLED_FAN_OUT, [TENANT_A.tenantId]: ['DAY-A-P1', 'DAY-A-P1'] },
      blackouts: [
        ['DAY-U-P0', 'DAY-U-P1'],
        ['DAY-A-P1', 'DAY-A-P1'],
      ],
      tenantBRows: 0,
      polls: 2,
      timedOut: false,
    },
  ])('$title', async ({ fanOut, blackouts, tenantBRows, polls, timedOut }) => {
    const stack = await seamStack({ fanOut });

    const { passed, evidence } = ran(await runSeam1(stack.deps));

    expect(passed).toBe(false);
    expect(evidence.destinations.map((destination) => destination.blackoutDayIds)).toEqual(blackouts);
    expect(evidence.otherTenants).toEqual([{ siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId, blackoutRows: tenantBRows }]);
    expect(evidence).toMatchObject({ polls, timedOut, elapsedMs: (polls - 1) * POLL.intervalMs });
    expect(posts(stack, '/archive')).toHaveLength(1);
  });

  it('archives an unpooled tenant-b person into tenant-b alone', async () => {
    const stack = await seamStack({ fanOut: { [TENANT_B.tenantId]: ['DAY-B-Q1', 'DAY-B-Q2'] } });

    const { passed, evidence } = ran(
      await runSeam1({ ...stack.deps, person: { userId: PERSON_B, siteId: TENANT_B.siteId }, effectiveFrom: '2026-06-15' }),
    );

    expect(passed).toBe(true);
    expect(evidence.destinations).toEqual([
      {
        siteId: TENANT_B.siteId,
        tenantId: TENANT_B.tenantId,
        reason: 'person-tenant',
        expectedDayIds: ['DAY-B-Q1', 'DAY-B-Q2'],
        preexistingDayIds: [],
        blackoutDayIds: ['DAY-B-Q1', 'DAY-B-Q2'],
      },
    ]);
    expect(evidence.otherTenants).toEqual([
      { siteId: TENANT_A.siteId, tenantId: TENANT_A.tenantId, blackoutRows: 0 },
      { siteId: TENANT_UMBRELLA.siteId, tenantId: TENANT_UMBRELLA.tenantId, blackoutRows: 0 },
    ]);
    const [archive] = posts(stack, '/archive');
    expect(archive?.url.searchParams.get('siteid')).toBe(TENANT_B.siteId);
    expect(JSON.parse(archive?.body ?? 'null')).toEqual({ effectiveFrom: '2026-06-15' });
    expect(stack.requests.filter((request) => request.url.origin === PEOPLE_URL)).toEqual([]);
  });

  it.each([
    {
      title: 'a JSON badRequest',
      refusal: () => json({ error: 'person already archived' }, 400),
      archive: { status: 400, body: { error: 'person already archived' } },
    },
    {
      title: 'a plain-text 503',
      refusal: () => new Response('people unavailable', { status: 503 }),
      archive: { status: 503, body: 'people unavailable' },
    },
  ])('fails without reading blackouts again when the gateway answers the archive with $title', async ({ refusal, archive }) => {
    const stack = await seamStack({ archiveRefusal: refusal });

    const { passed, evidence } = ran(await runSeam1(stack.deps));

    expect(passed).toBe(false);
    expect(evidence.archive).toEqual(archive);
    expect(evidence).toMatchObject({ polls: 0, timedOut: false, otherTenants: [] });
    const archiveAt = stack.requests.findIndex((request) => request.url.pathname.endsWith('/archive'));
    expect(stack.requests.slice(archiveAt + 1)).toEqual([]);
    expect(stack.sleeps).toEqual([]);
  });

  it('rejects before archiving when the gateway refuses the seeded site-admin', async () => {
    const stack = await seamStack({ refuseLogins: true });
    const username = SECRETS.username(TENANT_UMBRELLA.siteId, 'site-admin');

    await expect(runSeam1(stack.deps)).rejects.toThrow(`admin login as ${username} through the gateway failed (status 200)`);
    expect(posts(stack, '/archive')).toEqual([]);
  });

  it('rejects without a request to the gateway when every open-day person is reserved or archived', async () => {
    const stack = await seamStack();

    await expect(runSeam1({ ...stack.deps, seed: seedStore([RESERVED_PERSON, PERSON]) })).rejects.toThrow(
      `no ${DEFAULT_SEAM_SITE} person outside reserved.rehearsal and without an archive has open timesheet days on or after ${BUSINESS_DATE}`,
    );
    expect(stack.requests.filter((request) => request.url.origin === GATEWAY)).toEqual([]);
  });
});

describe('runSeam2', () => {
  it('schedules the draft survey once and finds one launch on surveys-launch and two reminders on communications-reminders', async () => {
    const stack = await seamStack({ existingTasks: EARLIER_TASKS });

    const { passed, evidence } = ran(await runSeam2(stack.deps));

    expect(passed).toBe(true);
    expect(evidence).toEqual({
      surveyId: SURVEY,
      siteId: TENANT_A.siteId,
      tenantId: TENANT_A.tenantId,
      launchAt: '2026-07-01T00:00:00',
      scheduleVersion: SCHEDULE_VERSION,
      schedule: { status: 200, body: { data: { schedule: { survey_id: SURVEY, schedule_version: SCHEDULE_VERSION } } } },
      rows: [
        { name: LAUNCH_TASK, kind: 'survey-launch', queue: LAUNCH_QUEUE, offsetS: 0, status: 'scheduled' },
        { name: FIRST_REMINDER, kind: 'survey-reminder', queue: REMINDER_QUEUE, offsetS: 86_400, status: 'scheduled' },
        { name: SECOND_REMINDER, kind: 'survey-reminder', queue: REMINDER_QUEUE, offsetS: 172_800, status: 'scheduled' },
      ],
      queueCounts: { [LAUNCH_QUEUE]: 1, [REMINDER_QUEUE]: 2 },
      taskList: [
        { name: LAUNCH_TASK, queue: LAUNCH_QUEUE, status: 'listed' },
        { name: FIRST_REMINDER, queue: REMINDER_QUEUE, status: 'listed' },
        { name: SECOND_REMINDER, queue: REMINDER_QUEUE, status: 'listed' },
      ],
      mismatches: [],
      polls: 2,
      elapsedMs: DELIVERY_MS,
      timedOut: false,
    });
    expect([LAUNCH_QUEUE, REMINDER_QUEUE]).toEqual(['surveys-launch', 'communications-reminders']);

    const schedules = posts(stack, '/schedule');
    expect(schedules).toHaveLength(1);
    const [schedule] = schedules;
    expect(schedule?.url.origin).toBe(GATEWAY);
    expect(schedule?.url.pathname).toBe(`${FIXTURE_API}/surveys/surveys/${SURVEY}/schedule`);
    expect(schedule?.url.searchParams.get('siteid')).toBe(TENANT_A.siteId);
    expect(schedule?.headers[CSRF_HEADER]).toBe(csrfToken(SURVEY));
    expect(JSON.parse(schedule?.body ?? 'null')).toEqual({
      launchAt: '2026-07-01T00:00:00',
      reminders: [{ offsetMinutes: 1_440 }, { offsetMinutes: 2_880 }],
    });
    const [login] = posts(stack, '/login');
    expect(login?.url.pathname).toBe(`/_api/json/v1/${TENANT_A.siteId}/login`);
    expect(new URLSearchParams(login?.body).get('username')).toBe(SECRETS.username(TENANT_A.siteId, 'surveys.manager'));
    const exports = exportRequests(stack);
    expect(exports.map((request) => request.url.searchParams.get('tenantId'))).toEqual([TENANT_A.tenantId, TENANT_A.tenantId]);
    expect(stack.callees).toEqual(['communications', 'communications']);
  });

  const shiftLaunch = (rows: Row[]): Row[] =>
    rows.map((row) => (row.kind === 'survey-launch' ? { ...row, schedule_time: plusSeconds(String(row.schedule_time), 60) } : row));
  const digest = taskRow({
    id: 'ST-DIGEST',
    name: DIGEST_TASK,
    kind: 'survey-digest',
    queue: REMINDER_QUEUE,
    at: '2026-07-01T00:00:00',
    surveyId: SURVEY,
    version: SCHEDULE_VERSION,
  });

  it.each<{ title: string; options: StackOptions; mismatches: string[]; polls: number; timedOut: boolean }>([
    {
      title: 'fails on a missing reminder once the poll budget runs out',
      options: { plan: (rows) => rows.slice(0, -1) },
      mismatches: ['survey-reminder offsets [86400] s, expected [86400, 172800] s'],
      polls: 4,
      timedOut: true,
    },
    {
      title: 'fails on a launch task queued on communications-reminders',
      options: { plan: (rows) => rows.map((row) => (row.kind === 'survey-launch' ? { ...row, queue: REMINDER_QUEUE } : row)) },
      mismatches: [
        `${LAUNCH_TASK}: survey-launch on queue ${REMINDER_QUEUE}, expected ${LAUNCH_QUEUE}`,
        `task list lacks ${LAUNCH_TASK} on ${REMINDER_QUEUE}`,
        `task list holds ${LAUNCH_TASK} on ${LAUNCH_QUEUE}, absent from scheduled_task`,
      ],
      polls: 2,
      timedOut: false,
    },
    {
      title: 'fails on a launch task scheduled a minute after the launch time',
      options: { plan: shiftLaunch },
      mismatches: [`${LAUNCH_TASK}: launch at offset 60 s, expected 0 s`],
      polls: 2,
      timedOut: false,
    },
    {
      title: 'fails on a task kind communications does not plan',
      options: { plan: (rows) => [...rows, digest] },
      mismatches: [
        `${DIGEST_TASK}: unexpected kind survey-digest`,
        `task list lacks ${DIGEST_TASK} on ${REMINDER_QUEUE}`,
        `task list holds ${DIGEST_TASK} on unknown kind digest, absent from scheduled_task`,
      ],
      polls: 2,
      timedOut: false,
    },
    {
      title: 'fails when the schedule response carries no schedule version',
      options: { scheduleVersion: null },
      mismatches: ['schedule response carries no data.schedule.schedule_version'],
      polls: 2,
      timedOut: false,
    },
    {
      title: 'fails when the fixture task list answers an error',
      options: { taskListStatus: 500 },
      mismatches: [
        'task list answered 500',
        `task list lacks ${LAUNCH_TASK} on ${LAUNCH_QUEUE}`,
        `task list lacks ${FIRST_REMINDER} on ${REMINDER_QUEUE}`,
        `task list lacks ${SECOND_REMINDER} on ${REMINDER_QUEUE}`,
      ],
      polls: 2,
      timedOut: false,
    },
  ])('$title', async ({ options, mismatches, polls, timedOut }) => {
    const stack = await seamStack(options);

    const { passed, evidence } = ran(await runSeam2(stack.deps));

    expect(passed).toBe(false);
    expect(evidence.mismatches).toEqual(mismatches);
    expect(evidence).toMatchObject({ polls, timedOut });
    expect(posts(stack, '/schedule')).toHaveLength(1);
  });

  it('fails without reading communications when the gateway refuses the schedule', async () => {
    const stack = await seamStack({ scheduleStatus: 409 });

    const { passed, evidence } = ran(await runSeam2(stack.deps));

    expect(passed).toBe(false);
    expect(evidence).toMatchObject({
      schedule: { status: 409, body: { error: 'survey is not DRAFT' } },
      scheduleVersion: null,
      mismatches: ['schedule answered 409'],
      rows: [],
      polls: 0,
    });
    expect(stack.requests.filter((request) => request.url.origin === COMMUNICATIONS_URL)).toEqual([]);
    expect(stack.requests.filter((request) => request.url.pathname.endsWith('/tasks'))).toEqual([]);
  });

  it('stops polling at once when the communications export carries no scheduled-task table', async () => {
    const stack = await seamStack({ exportsTaskTable: false });

    const { passed, evidence } = ran(await runSeam2(stack.deps));

    expect(passed).toBe(false);
    expect(evidence.mismatches).toEqual([
      'communications export carries no table for unit communications.scheduled_task',
      'expected 1 survey-launch task, found 0',
      'survey-reminder offsets [] s, expected [86400, 172800] s',
    ]);
    expect(evidence).toMatchObject({ polls: 1, timedOut: false, rows: [], queueCounts: {} });
    expect(stack.sleeps).toEqual([]);
  });

  it('launches one day after the clock once the business-date midnight has passed', async () => {
    const stack = await seamStack({ clockStart: Date.parse('2026-07-02T09:15:30.250') });

    const { passed, evidence } = ran(await runSeam2({ ...stack.deps, reminderOffsetsS: [3_600] }));

    expect(passed).toBe(true);
    expect(evidence.launchAt).toBe('2026-07-03T09:15:30');
    expect(evidence.rows.map((row) => [row.kind, row.offsetS])).toEqual([
      ['survey-launch', 0],
      ['survey-reminder', 3_600],
    ]);
    expect(JSON.parse(posts(stack, '/schedule')[0]?.body ?? 'null')).toEqual({
      launchAt: '2026-07-03T09:15:30',
      reminders: [{ offsetMinutes: 60 }],
    });
  });

  it.each([[[90]], [[-60]]])('rejects reminder offsets %j before any request', async (offsets) => {
    const stack = await seamStack();

    await expect(runSeam2({ ...stack.deps, reminderOffsetsS: offsets })).rejects.toThrow(
      new RangeError(`reminderOffsetsS must be non-negative whole minutes, got [${offsets.join(', ')}]`),
    );
    expect(stack.requests).toEqual([]);
  });

  it('rejects before scheduling when the gateway refuses the seeded surveys manager', async () => {
    const stack = await seamStack({ refuseLogins: true });
    const username = SECRETS.username(TENANT_A.siteId, 'surveys.manager');

    await expect(runSeam2(stack.deps)).rejects.toThrow(`JSON API login as ${username} through the gateway failed (status 200)`);
    expect(posts(stack, '/schedule')).toEqual([]);
  });
});

describe('fixtures unavailable', () => {
  it.each([
    ['runSeam1', runSeam1],
    ['runSeam2', runSeam2],
  ] as const)('%s reports skipped: fixtures unavailable without a request', async (_name, run) => {
    const reason = 'CREATE SCHEMA permission denied in muradb_c64';
    await writeFile(
      path.join(stateRoot, 'fixtures.json'),
      JSON.stringify({ available: false, reason, checkedAt: '2026-06-30T07:00:00.000Z' }),
    );
    const { fetch, requests } = fakeFetch([]);

    const result = await run({ env: { OPT2_STATE_DIR: stateRoot, OPT2_GATEWAY_URL: GATEWAY }, fetch });

    expect(result).toEqual({ passed: false, skipped: 'skipped: fixtures unavailable', evidence: { reason } });
    expect(requests).toEqual([]);
  });
});

describe('unitFor', () => {
  it.each([
    ['programs_sites', 'site'],
    ['people', 'person_archive'],
    ['timesheets', 'timesheet'],
    ['timesheets', 'timesheet_day'],
    ['timesheets', 'blackout'],
    ['communications', 'scheduled_task'],
  ])('names %s.%s as opt2/table-ownership.json assigns it', (schema, table) => {
    expect(unitFor(schema, table)).toBe(`${schema}.${table}`);
  });

  it('throws naming a unit the ownership file does not assign', () => {
    expect(() => unitFor('timesheets', 'holiday')).toThrow('opt2/table-ownership.json assigns no unit timesheets.holiday');
  });
});

describe('readOwnerExport', () => {
  const firstPage = [{ archive_id: 'ARC-1', person_id: PERSON, siteID: TENANT_A.siteId, effective_from: '2026-06-01T00:00:00' }];
  const secondPage = [{ archive_id: 'ARC-2', person_id: PERSON_B, siteID: TENANT_A.siteId, effective_from: null }];

  it('pages the export with a platform.migration credential alone and decodes the requested unit', async () => {
    await writeTestSecrets(stateRoot);
    const { fetch, requests } = fakeFetch([
      {
        method: 'GET',
        url: at(PEOPLE_URL, escapeRegExp(EXPORT_PATH)),
        reply: (request) =>
          request.url.searchParams.get('after') === null
            ? json(
                exportPage(
                  PERSON_ARCHIVE.unit,
                  TENANT_A.tenantId,
                  [exportTable(PERSON_ARCHIVE, firstPage), exportTable(PERSON_TABLE, [{ UserID: PERSON, SiteID: TENANT_A.siteId }])],
                  'FIXTURE-cursor-1',
                ),
              )
            : json(exportPage(PERSON_ARCHIVE.unit, TENANT_A.tenantId, [exportTable(PERSON_ARCHIVE, secondPage)])),
      },
    ]);

    const out = await readOwnerExport(
      { service: 'people', unit: PERSON_ARCHIVE.unit, tenantId: TENANT_A.tenantId },
      { env: { OPT2_STATE_DIR: stateRoot }, fetch, serviceUrls: SERVICE_URLS },
    );

    expect(out.columns).toEqual(PERSON_ARCHIVE.columns);
    expect(out.rows).toEqual([
      { archive_id: 'ARC-1', person_id: PERSON, siteID: TENANT_A.siteId, effective_from: '2026-06-01T00:00:00.000' },
      { archive_id: 'ARC-2', person_id: PERSON_B, siteID: TENANT_A.siteId, effective_from: null },
    ]);
    expect(out.entries).toEqual([...exportTable(PERSON_ARCHIVE, firstPage).rows, ...exportTable(PERSON_ARCHIVE, secondPage).rows]);
    const query = { unit: PERSON_ARCHIVE.unit, tenantId: TENANT_A.tenantId, limit: String(MAX_EXPORT_LIMIT) };
    expect(requests.map((request) => [request.url.origin, request.url.pathname, Object.fromEntries(request.url.searchParams)])).toEqual([
      [PEOPLE_URL, EXPORT_PATH, query],
      [PEOPLE_URL, EXPORT_PATH, { ...query, after: 'FIXTURE-cursor-1' }],
    ]);

    const { publicKey } = await loadLocalSigningKeys(stateRoot);
    for (const request of requests) {
      expect(Object.keys(request.headers)).toEqual([INVOCATION_HEADER]);
      const credential = request.headers[INVOCATION_HEADER] ?? '';
      expect(credential.startsWith('Bearer ')).toBe(true);
      const identity = await verifyLocalServiceToken(credential.slice('Bearer '.length), { publicKey, audience: 'people' });
      expect(identity).toEqual({ name: 'migration', roles: harnessCallerRoles('migration') });
      expect(identity.roles).toContain(Roles.platformMigration);
    }
  });

  it('leaves tenantId out of the query when the target names no tenant', async () => {
    const { fetch, requests } = fakeFetch([
      exportRoute(PEOPLE_URL, () => [exportTable(PERSON_ARCHIVE, firstPage)]),
    ]);

    const out = await readOwnerExport(
      { service: 'people', unit: PERSON_ARCHIVE.unit },
      { fetch, invoker: await stubInvoker(), serviceUrls: SERVICE_URLS },
    );

    expect(out.rows).toHaveLength(1);
    expect(requests.map((request) => request.url.searchParams.has('tenantId'))).toEqual([false]);
  });

  it('rejects with the owner status and body on a non-2xx answer', async () => {
    const { fetch } = fakeFetch([
      { method: 'GET', url: at(TIMESHEETS_URL, escapeRegExp(EXPORT_PATH)), reply: () => new Response('unit gate closed', { status: 503 }) },
    ]);

    await expect(
      readOwnerExport(
        { service: 'timesheets', unit: BLACKOUT.unit, tenantId: TENANT_B.tenantId },
        { fetch, invoker: await stubInvoker(), serviceUrls: SERVICE_URLS },
      ),
    ).rejects.toThrow('timesheets export of timesheets.blackout answered 503: unit gate closed');
  });
});

describe('siteRegistry', () => {
  it('reads the installed default and every seed-config site, an empty or NULL pool falling back to the site', async () => {
    const rows = [...registryRows(), { SiteID: 'Default', publicUserPoolID: null, privateUserPoolID: '' }];
    const { fetch, requests } = fakeFetch([
      exportRoute(SITES_URL, (_unit, tenantId) => [
        exportTable(SITE, rows.filter((row) => tenantIdForSite(String(row.SiteID)) === tenantId)),
      ]),
    ]);

    const registry = await siteRegistry({ fetch, invoker: await stubInvoker(), serviceUrls: SERVICE_URLS });

    expect(requests.map((request) => request.url.searchParams.get('unit'))).toEqual(requests.map(() => SITE.unit));
    expect(requests.map((request) => request.url.searchParams.get('tenantId'))).toEqual(
      ['default', TENANT_UMBRELLA.siteId, TENANT_A.siteId, TENANT_B.siteId].map((site) => tenantIdForSite(site)),
    );
    expect(registry).toEqual([
      { siteId: 'Default', tenantId: tenantIdForSite('default'), publicUserPoolId: 'default', privateUserPoolId: 'default' },
      {
        siteId: TENANT_UMBRELLA.siteId,
        tenantId: TENANT_UMBRELLA.tenantId,
        publicUserPoolId: TENANT_UMBRELLA.siteId,
        privateUserPoolId: TENANT_UMBRELLA.siteId,
      },
      {
        siteId: TENANT_A.siteId,
        tenantId: TENANT_A.tenantId,
        publicUserPoolId: TENANT_UMBRELLA.siteId,
        privateUserPoolId: TENANT_A.siteId,
      },
      { siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId, publicUserPoolId: TENANT_B.siteId, privateUserPoolId: TENANT_B.siteId },
    ]);
  });
});

describe('pollUntil', () => {
  function testClock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
    let now = 0;
    const sleeps: number[] = [];
    return {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      sleeps,
    };
  }

  function counter(): () => Promise<number> {
    let calls = 0;
    return async () => {
      calls += 1;
      return calls;
    };
  }

  it('resolves with the first value done accepts, sleeping the interval between calls', async () => {
    const clock = testClock();

    const outcome = await pollUntil(counter(), (calls) => calls === 3, { ...clock, poll: { timeoutMs: 10_000, intervalMs: 250 } });

    expect(outcome).toEqual({ value: 3, polls: 3, elapsedMs: 500, timedOut: false });
    expect(clock.sleeps).toEqual([250, 250]);
  });

  it('times out with the last value read, the final sleep clipped to the remaining budget', async () => {
    const clock = testClock();

    const outcome = await pollUntil(counter(), () => false, { ...clock, poll: { timeoutMs: 2_500, intervalMs: 1_000 } });

    expect(outcome).toEqual({ value: 4, polls: 4, elapsedMs: 2_500, timedOut: true });
    expect(clock.sleeps).toEqual([1_000, 1_000, 500]);
  });

  it('sleeps the default interval when no bounds are given', async () => {
    const clock = testClock();

    const outcome = await pollUntil(counter(), (calls) => calls === 2, clock);

    expect(outcome).toEqual({ value: 2, polls: 2, elapsedMs: DEFAULT_POLL_INTERVAL_MS, timedOut: false });
    expect(clock.sleeps).toEqual([DEFAULT_POLL_INTERVAL_MS]);
  });

  it('returns after one call without sleeping when the first value is done', async () => {
    const outcome = await pollUntil(async () => 'ready', (value) => value === 'ready');

    expect(outcome).toMatchObject({ value: 'ready', polls: 1, timedOut: false });
  });
});

describe('isOpenDay', () => {
  it.each([
    {
      title: 'an IN-PROGRESS day on effectiveFrom is open',
      day: { state: 'IN-PROGRESS', work_date: '2026-06-30T00:00:00.000' },
      open: true,
    },
    {
      title: 'columns match ignoring case and a date-only work date is midnight',
      day: { STATE: 'submitted', Work_Date: '2026-07-01' },
      open: true,
    },
    {
      title: 'a padded lower-case approved day is closed',
      day: { state: 'approved  ', work_date: '2026-07-01T00:00:00.000' },
      open: false,
    },
    {
      title: 'a day before effectiveFrom is closed',
      day: { state: 'IN-PROGRESS', work_date: '2026-06-29T23:59:59.997' },
      open: false,
    },
    { title: 'a day without a state is closed', day: { state: null, work_date: '2026-07-01T00:00:00.000' }, open: false },
  ])('$title', ({ day: candidate, open }) => {
    expect(isOpenDay(candidate, BUSINESS_DATE)).toBe(open);
  });
});
