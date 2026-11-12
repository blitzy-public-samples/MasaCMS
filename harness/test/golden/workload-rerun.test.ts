import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stepSchema, type Step } from '../../src/golden/catalogue.js';
import { GoldenConfigError } from '../../src/golden/errors.js';
import { loadSecretStore, type SecretStore, type SeedStore } from '../../src/golden/session.js';
import {
  buildWorkloadPlan,
  loadWorkloadInputs,
  main,
  planDigest,
  runWorkload,
  type WorkloadDataset,
  type WorkloadDeps,
  type WorkloadPlan,
  type WorkloadWrite,
} from '../../src/golden/workload.js';
import type { FetchLike } from '../../src/lib/http.js';
import type { EnvLike } from '../../src/lib/paths.js';

// Nothing listens on this port: every request goes to the fake legacy behind it.
const GATEWAY = 'http://127.0.0.1:8599';
const ADMIN_PASSWORD = 'FIXTURE-ADMIN-PASSWORD';
const ROLE_PASSWORD = 'FIXTURE-ROLE-PASSWORD';
const ADMIN_CFID = 'FIXTURE-CFID-ADMIN';
const FORM_TOKEN = 'FIXTURECSRFTOKEN0000000000000007';
const LOGIN_TOKEN = 'FIXTURECSRFTOKEN0000000000000001';
const JSON_TOKEN = 'FIXTURECSRFTOKEN0000000000000009';
const EXPIRES = '260630120000000';
const SEEDED_CONTACT = 'fixture-contact@tenant-b.example';
const SEEDED_GROUP_EMAIL = 'fixture-editors@tenant-a.example';
const WORKLOAD_CONTACT = 'opt2-workload-site@workload.opt2.test';
const HOME_ID = '00000000000000000000000000000000001';
const CLOCK = new Date('2026-06-30T12:00:00.000Z');
const INTERRUPTED = 'FIXTURE-PROCESS-INTERRUPTED';
const LOGIN_HTML = readFileSync(new URL('../fixtures/html/admin-login.html', import.meta.url), 'utf8');
const EMPLOYEE = 'fixture.tenant-a.timesheets.employee';
const PREPARER = 'fixture.tenant-a.finance.preparer';
const JSON_API = /^\/_api\/json\/v1\/([^/]+)\/(.*)$/;
const FIXTURE_API = '/legacy-fixtures/cfml/api.cfm/';
const LOGINS: readonly string[] = ['admin-login', 'employee-login', 'preparer-login'];

const PAGES = [1, 2, 3, 4, 5].map((n) => ({
  contentID: `FIXTURE-PAGE-A-000${n}`,
  siteID: 'tenant-a',
  parentID: HOME_ID,
  type: 'Page',
  title: `Fixture Page ${n}`,
  isNav: 1,
}));
const PAGE_TITLES: ReadonlyMap<string, string> = new Map(PAGES.map((page) => [page.contentID, page.title] as const));
const SHEETS = [1, 2].map((n) => ({
  timesheet_id: `FIXTURE-SHEET-A-000${n}`,
  person_id: `FIXTURE-PERSON-A-000${n}`,
  siteID: 'tenant-a',
}));
const DAYS = [1, 2, 3, 4].map((n) => ({
  day_id: `FIXTURE-DAY-A-000${n}`,
  timesheet_id: `FIXTURE-SHEET-A-000${(n % 2) + 1}`,
  state: 'DRAFT',
}));
const RECORDS = [1, 2, 3].map((n) => ({
  record_id: `FIXTURE-RECORD-A-000${n}`,
  siteID: 'tenant-a',
  state: 'IN-PROGRESS',
  title: `Fixture Record ${n}`,
  amount: `${n}00.0000`,
  period: '2026-06',
}));

// Shape of the generated `dataset.json` fields the workload reads; Program_1 is tenant-a's fixture schema.
const DATASET: WorkloadDataset = {
  masa: {
    users: [1, 2, 3].map((n) => ({
      userID: `FIXTURE-USER-A-000${n}`,
      siteID: 'tenant-a',
      isPublic: 0,
      username: `fixture.user${n}`,
      fname: 'Fixture',
      lname: `User ${n}`,
      email: `fixture.user${n}@tenant-a.example`,
      subscribe: 0,
    })),
    groups: [{ groupID: 'FIXTURE-GROUP-A-0001', siteID: 'tenant-a', groupname: 'Fixture Editors' }],
    memberships: [],
    content: PAGES,
  },
  fixtures: { 'Program_1.timesheet': SHEETS, 'Program_1.timesheet_day': DAYS, 'Program_1.finance_record': RECORDS },
};

/** One request the fake received. */
interface Call {
  method: string;
  url: URL;
  form: URLSearchParams;
}

/** A request as the fake answers it: its JSON or form body text, headers and `CFID` session cookie. */
interface Received extends Call {
  body: string;
  headers: Record<string, string>;
  session: string | undefined;
}

/** Stateful legacy behind the gateway, holding every value a workload probe reads. */
interface FakeLegacy {
  fetch: FetchLike;
  calls: Call[];
  unmatched: string[];
  contact: string;
  groupEmail: string;
  jobtitles: Map<string, string>;
  /** Created pages: contentid to title. */
  pages: Map<string, string>;
  /** Draft titles saved per seeded page. */
  drafts: Map<string, string[]>;
  /** Address names added per user; every seeded user also holds `Primary`. */
  addresses: Map<string, string[]>;
  dayStates: Map<string, string>;
  financeTitles: Map<string, string>;
  financeEdits: number;
  /** Answers a request in place of the fake when it returns a response. */
  override?: (call: Call) => Response | undefined;
}

const fakes: FakeLegacy[] = [];
let dir = '';
let env: EnvLike = {};

/** `${OPT2_STATE_DIR}/fixtures.json` as `load-fixtures.sh` writes it. */
function writeFixtureStatus(available: boolean): void {
  const status = { available, reason: available ? null : 'CREATE SCHEMA denied', checkedAt: CLOCK.toISOString() };
  writeFileSync(path.join(dir, 'fixtures.json'), `${JSON.stringify(status)}\n`);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'opt2-workload-rerun-'));
  mkdirSync(path.join(dir, 'seed'), { recursive: true });
  writeFileSync(path.join(dir, 'seed', 'dataset.json'), `${JSON.stringify(DATASET)}\n`);
  mkdirSync(path.join(dir, 'secrets'), { recursive: true, mode: 0o700 });
  const credentials = { users: { 'tenant-a': { [EMPLOYEE]: ROLE_PASSWORD, [PREPARER]: ROLE_PASSWORD } } };
  writeFileSync(path.join(dir, 'secrets', 'seed-credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
  writeFixtureStatus(true);
  env = { OPT2_GATEWAY_URL: GATEWAY, OPT2_STATE_DIR: dir, MURA_ADMIN_PASSWORD: ADMIN_PASSWORD };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  for (const fake of fakes.splice(0)) {
    expect(fake.unmatched).toStrictEqual([]);
    expect(fake.calls.filter((call) => call.url.origin !== GATEWAY)).toStrictEqual([]);
  }
});

/** `esapiEncode('html_attr')`: every character but alphanumerics and `,.-_` as a hex entity. */
function htmlAttr(text: string): string {
  return text.replace(/[^A-Za-z0-9,._-]/g, (c) => `&#x${(c.codePointAt(0) ?? 0).toString(16)};`);
}

function hidden(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${htmlAttr(value)}">`)
    .join('');
}

/** Admin page holding one CSRF-protected form posting to `action`. */
function formPage(action: string, fields: Record<string, string>, extra = '', id = 'form1', status = 200): Response {
  const tokens = hidden({ csrf_token: FORM_TOKEN, csrf_token_expires: EXPIRES });
  const form = `<form id="${id}" method="post" action="${action}">${extra}${hidden(fields)}${tokens}</form>`;
  return html(`<!DOCTYPE html><html><body>${form}</body></html>`, status);
}

/** Text input `name` holding `value`, as the admin forms render it. */
function textInput(name: string, value: string): string {
  return `<input name="${name}" type="text" value="${htmlAttr(value)}" size="50">`;
}

function html(markup: string, status = 200): Response {
  return new Response(markup, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function redirect(location: string, setCookie?: string): Response {
  const headers: [string, string][] = [['location', location]];
  if (setCookie !== undefined) headers.push(['set-cookie', setCookie]);
  return new Response(null, { status: 302, headers });
}

function append(lists: Map<string, string[]>, key: string, value: string): void {
  lists.set(key, [...(lists.get(key) ?? []), value]);
}

/** JSON API: CSRF tokens, role logins, and the admin reads of page history, page listings and addresses. */
function jsonApi(fake: FakeLegacy, req: Received, site: string, rest: string): Response | undefined {
  const { method, form } = req;
  const query = req.url.searchParams;
  if (method === 'GET' && rest === 'generateCSRFTokens') {
    return json({ data: { csrf_token: JSON_TOKEN, csrf_token_expires: EXPIRES } });
  }
  if (method === 'POST' && site === 'tenant-a' && rest === 'login') {
    const username = form.get('username') ?? '';
    const ok =
      req.headers['x-csrf_token'] === JSON_TOKEN &&
      [EMPLOYEE, PREPARER].includes(username) &&
      form.get('password') === ROLE_PASSWORD;
    if (!ok) return json({ error: { code: 'invalidlogin' } }, 401);
    return json({ data: { status: 'success' } }, 200, { 'set-cookie': `CFID=FIXTURE-CFID-${username}; Path=/` });
  }
  if (method !== 'GET' || req.session !== ADMIN_CFID) return undefined;
  const content = /^content\/([^/]+?)(\/history)?$/.exec(rest);
  if (site === 'tenant-a' && content !== null) {
    const [, id = '', history] = content;
    if (history === undefined) return json({ data: { contentid: id, contenthistid: `HIST-${id}` } });
    const titles = [PAGE_TITLES.get(id) ?? '', ...(fake.drafts.get(id) ?? [])];
    return json({ data: { items: titles.map((title) => ({ contentid: id, title })) } });
  }
  if (site === 'tenant-b' && rest === 'content/') {
    // Workload pages are unapproved drafts, which only liveOnly=0 lists.
    const listed = query.get('liveOnly') === '0' ? [...fake.pages] : [];
    const items = listed.filter(([, title]) => title === query.get('title'));
    return json({ data: { items: items.map(([contentid, title]) => ({ contentid, title })) } });
  }
  if (site === 'tenant-a' && rest === 'address/') {
    const userid = query.get('userid') ?? '';
    const names = ['Primary', ...(fake.addresses.get(userid) ?? [])];
    // Upper-case keys, as ACF serialises query columns.
    return json({ data: { items: names.map((name) => ({ USERID: userid, ADDRESSNAME: name })) } });
  }
  return undefined;
}

/** Fixture API: sheet reads and day submits as the employee, record reads and edits as the preparer. */
function fixtureApi(fake: FakeLegacy, req: Received, rest: string): Response | undefined {
  const { method } = req;
  if (req.url.searchParams.get('siteid') !== 'tenant-a') return undefined;
  if (method === 'POST' && req.headers['x-csrf_token'] !== JSON_TOKEN) return json({ error: { code: 'csrf' } }, 403);
  if (req.session === `FIXTURE-CFID-${EMPLOYEE}`) {
    const sheet = /^timesheets\/sheets\/([^/]+)$/.exec(rest)?.[1];
    if (method === 'GET' && sheet !== undefined) {
      const days = DAYS.filter((day) => day.timesheet_id === sheet).map((day) => day.day_id);
      return json({ data: { days: days.map((id) => ({ DAY_ID: id, STATE: fake.dayStates.get(id) })) } });
    }
    const day = /^timesheets\/days\/([^/]+)\/submit$/.exec(rest)?.[1];
    if (method === 'POST' && day !== undefined) {
      // The fixture state machine refuses a day that has left DRAFT.
      if (fake.dayStates.get(day) !== 'DRAFT') return json({ error: { code: 'conflict' } }, 409);
      fake.dayStates.set(day, 'SUBMITTED');
      return json({ data: { day_id: day, state: 'SUBMITTED' } });
    }
  }
  if (req.session === `FIXTURE-CFID-${PREPARER}`) {
    const [, id = '', edit] = /^finance\/records\/([^/]+?)(\/edit)?$/.exec(rest) ?? [];
    if (method === 'GET' && id !== '' && edit === undefined) {
      return json({ data: { record_id: id, title: fake.financeTitles.get(id), state: 'IN-PROGRESS' } });
    }
    if (method === 'POST' && id !== '' && edit !== undefined) {
      fake.financeTitles.set(id, String((JSON.parse(req.body) as { title: unknown }).title));
      fake.financeEdits += 1;
      return json({ data: { record_id: id } });
    }
  }
  return undefined;
}

/** Admin pages behind the admin session: site, content, user, group and address forms and their saves. */
function adminPages(fake: FakeLegacy, req: Received, route: string, mint: () => number): Response | undefined {
  const { form } = req;
  const query = req.url.searchParams;
  const userid = query.get('userid') ?? '';
  switch (route) {
    case 'GET /admin/ ':
      return html('<!DOCTYPE html><html><body>Site Content</body></html>');
    case 'GET /admin/ csettings.editsite': {
      const fields = { siteid: query.get('siteid') ?? '' };
      return formPage('./?muraAction=cSettings.updateSite', fields, textInput('contact', fake.contact));
    }
    case 'POST /admin/ csettings.updatesite':
      fake.contact = form.get('contact') ?? '';
      return html('<html><body>Site updated</body></html>');
    case 'GET /admin/ carch.edit': {
      const existing = query.get('contentid') ?? '';
      const minted = existing === '' ? mint() : 0;
      const contentid = existing === '' ? `FIXTURE-NEW-PAGE-${minted}` : existing;
      const contenthistid = existing === '' ? `FIXTURE-NEW-HIST-${minted}` : (query.get('contenthistid') ?? '');
      return formPage('./?muraAction=cArch.update', { contentid, contenthistid }, '', 'contentForm');
    }
    case 'POST /admin/ carch.update': {
      const contentid = form.get('contentid') ?? '';
      const title = form.get('title') ?? '';
      if (PAGE_TITLES.has(contentid)) append(fake.drafts, contentid, title);
      else fake.pages.set(contentid, title);
      return html('<html><body>Saved</body></html>');
    }
    case 'GET /admin/ cusers.edituser': {
      const jobtitle = textInput('jobtitle', fake.jobtitles.get(userid) ?? '');
      return formPage('./?muraAction=cUsers.update', { userid }, jobtitle);
    }
    case 'GET /admin/ cusers.editgroup':
      return formPage('./?muraAction=cUsers.update', { userid }, textInput('email', fake.groupEmail));
    case 'POST /admin/ cusers.update':
      if (form.get('type') === '2') fake.jobtitles.set(userid, form.get('jobtitle') ?? '');
      else fake.groupEmail = form.get('email') ?? '';
      return html('<html><body>Updated</body></html>');
    case 'GET /admin/ cusers.editaddress':
      return formPage('./?muraAction=cUsers.updateAddress', { userid, addressid: '' });
    case 'POST /admin/ cusers.updateaddress':
      if (form.get('action') === 'Add') append(fake.addresses, userid, form.get('addressName') ?? '');
      return html('<html><body>Address saved</body></html>');
    default:
      return undefined;
  }
}

function fakeLegacy(): FakeLegacy {
  let minted = 0;
  const fake: FakeLegacy = {
    calls: [],
    unmatched: [],
    contact: SEEDED_CONTACT,
    groupEmail: SEEDED_GROUP_EMAIL,
    jobtitles: new Map(DATASET.masa.users.map((user) => [user.userID, ''] as const)),
    pages: new Map(),
    drafts: new Map(),
    addresses: new Map(),
    dayStates: new Map(DAYS.map((day) => [day.day_id, day.state] as const)),
    financeTitles: new Map(RECORDS.map((row) => [row.record_id, row.title] as const)),
    financeEdits: 0,
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? 'GET';
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = typeof init.body === 'string' ? init.body : '';
      const form = new URLSearchParams(body);
      fake.calls.push({ method, url, form });
      const overridden = fake.override?.({ method, url, form });
      if (overridden !== undefined) return overridden;
      const session = /(?:^|;\s*)CFID=([^;]*)/.exec(headers.cookie ?? '')?.[1];
      const answer = answerOf(fake, { method, url, form, body, headers, session }, () => (minted += 1));
      if (answer !== undefined) return answer;
      fake.unmatched.push(`${method} ${input}`);
      return html('not found', 404);
    },
  };
  fakes.push(fake);
  return fake;
}

/** The fake's answer to `req`: admin login, JSON API, fixture API or admin pages; undefined when none matches. */
function answerOf(fake: FakeLegacy, req: Received, mint: () => number): Response | undefined {
  const { method, url, form } = req;
  const route = `${method} ${url.pathname} ${(url.searchParams.get('muraAction') ?? '').toLowerCase()}`;
  if (route === 'GET /admin/ clogin.main') return html(LOGIN_HTML);
  if (route === 'POST /admin/index.cfm ') {
    const ok =
      form.get('username') === 'admin' &&
      form.get('password') === ADMIN_PASSWORD &&
      form.get('csrf_token') === LOGIN_TOKEN;
    return ok ? redirect('./', `CFID=${ADMIN_CFID}; Path=/`) : redirect('./?muraAction=clogin.main&status=failed');
  }
  const api = JSON_API.exec(url.pathname);
  if (api !== null) return jsonApi(fake, req, api[1] ?? '', api[2] ?? '');
  if (url.pathname.startsWith(FIXTURE_API)) return fixtureApi(fake, req, url.pathname.slice(FIXTURE_API.length));
  if (url.pathname === '/admin/' && req.session !== ADMIN_CFID) return redirect('./?muraAction=clogin.main');
  if (method === 'POST' && form.get('csrf_token') !== FORM_TOKEN) return html('invalid token', 403);
  return adminPages(fake, req, route, mint);
}

/** Env-backed admin secret and seed role passwords; role usernames are fixtures, as seeded references need them. */
function secretStore(): SecretStore {
  const store = loadSecretStore(env);
  return {
    secret: (name) => store.secret(name),
    values: () => store.values(),
    username: (site, role) => `fixture.${site}.${role}`,
  };
}

/** Rows for the catalogue's seeded references, carrying the fields their `where` placeholders read. */
const SEED_STORE: SeedStore = {
  select: (ref) =>
    ref.source === 'reserved'
      ? 'FIXTURE-RESERVED-0001'
      : {
          userID: 'FIXTURE-CATALOGUE-USER',
          timesheet_id: 'FIXTURE-CATALOGUE-SHEET',
          contentID: 'FIXTURE-CATALOGUE-CONTENT',
        },
  businessDate: () => '2026-06-30',
};

/** Deps of one run against `fake`; the report clock raises {@link INTERRUPTED} once `interrupt` holds. */
function depsFor(fake: FakeLegacy, interrupt: () => boolean = () => false): WorkloadDeps {
  const clock = (): Date => {
    if (interrupt()) throw INTERRUPTED;
    return CLOCK;
  };
  return { env, fetch: fake.fetch, secrets: secretStore(), seed: SEED_STORE, report: { clock, generatedBy: 'test' } };
}

/** The plan `main` builds from the same inputs. */
async function plan(): Promise<WorkloadPlan> {
  const inputs = await loadWorkloadInputs({ env, secrets: secretStore(), seed: SEED_STORE });
  return buildWorkloadPlan(inputs.config, inputs.dataset, inputs.options);
}

function names(workload: WorkloadPlan): string[] {
  return workload.items.map((item) => item.name);
}

function itemOf(workload: WorkloadPlan, name: string): Step {
  const found = workload.items.find((item) => item.name === name);
  if (found === undefined) throw new Error(`plan has no item ${name}`);
  return found;
}

function writeOf(workload: WorkloadPlan, name: string): WorkloadWrite {
  const found = workload.writes.find((write) => write.name === name);
  if (found === undefined) throw new Error(`plan has no write ${name}`);
  return found;
}

function journalPath(): string {
  return path.join(dir, 'golden', 'workload.json');
}

function journalText(): string {
  return readFileSync(journalPath(), 'utf8');
}

/** Fields of `workload.json` the tests read. */
interface Journal {
  planDigest: string;
  status: string;
  items: { name: string; routeKey: string | null; status: number | null; skipped?: string }[];
  failures: { name: string; status: number | null; reason: string }[];
}

function journal(): Journal {
  return JSON.parse(journalText()) as Journal;
}

/** `POST path muraAction` of a write request. */
function postOf(url: URL): string {
  return `POST ${url.pathname} ${url.searchParams.get('muraAction') ?? ''}`.trim();
}

/** Write requests the fake received from call `from` on. */
function writes(fake: FakeLegacy, from = 0): string[] {
  return fake.calls
    .slice(from)
    .filter((call) => call.method === 'POST')
    .map((call) => postOf(call.url));
}

/** Write requests of the plan's POST items in order, leaving out the items of the writes named in `unsent`. */
function postsExcept(workload: WorkloadPlan, unsent: readonly string[]): string[] {
  const left = new Set(workload.writes.filter((write) => unsent.includes(write.name)).flatMap((write) => write.skip));
  return workload.items
    .filter((item) => item.method === 'POST' && !left.has(item.name))
    .map((item) => postOf(new URL(item.route, GATEWAY)));
}

/** What legacy holds of each kind of workload write. */
function counts(fake: FakeLegacy): Record<string, unknown> {
  const total = (lists: Map<string, string[]>): number => [...lists.values()].reduce((n, list) => n + list.length, 0);
  return {
    pages: fake.pages.size,
    drafts: total(fake.drafts),
    addresses: total(fake.addresses),
    submits: [...fake.dayStates.values()].filter((state) => state !== 'DRAFT').length,
    financeEdits: fake.financeEdits,
    contact: fake.contact,
    jobtitles: [...fake.jobtitles.values()].sort(),
    groupEmail: fake.groupEmail,
  };
}

const UNTOUCHED = {
  pages: 0,
  drafts: 0,
  addresses: 0,
  submits: 0,
  financeEdits: 0,
  contact: SEEDED_CONTACT,
  jobtitles: ['', '', ''],
  groupEmail: SEEDED_GROUP_EMAIL,
};
const APPLIED = {
  pages: 2,
  drafts: 5,
  addresses: 3,
  submits: 3,
  financeEdits: 2,
  contact: WORKLOAD_CONTACT,
  jobtitles: ['OPT-2 Workload Analyst 1', 'OPT-2 Workload Analyst 2', 'OPT-2 Workload Analyst 3'],
  groupEmail: 'opt2-workload-group-1@workload.opt2.test',
};

/** A probe as the reconciliation needs it: what it requests, in which session, and what it extracts. */
type ProbeShape = Pick<Step, 'name' | 'method' | 'route' | 'as' | 'extract'>;

/** The writes and probes the plan must hold, derived from the ids its own write items post and the dataset. */
function expectedReconciliation(
  workload: WorkloadPlan,
  available: boolean,
): { writes: WorkloadWrite[]; probes: ProbeShape[] } {
  const body = (bodyPath: string) => ({ from: 'body', path: bodyPath }) as const;
  const dom = (input: string) => ({ from: 'dom', selector: `input[name=${input}]`, attr: 'value' }) as const;
  const idIn = (name: string, pattern: RegExp): string => pattern.exec(itemOf(workload, name).route)?.[1] ?? '';
  const writes: WorkloadWrite[] = [];
  const probes: ProbeShape[] = [];
  const add = (write: WorkloadWrite, route: string, as: string, extract: Step['extract']): void => {
    writes.push(write);
    probes.push({ name: write.probe, method: 'GET', route, as, extract });
  };
  for (const n of [1, 2, 3, 4, 5]) {
    const name = `content-edit-${n}`;
    const id = String(itemOf(workload, `${name}-save`).form?.contentid);
    const title = `${PAGE_TITLES.get(id)} (OPT-2 workload ${n})`;
    add(
      {
        name,
        probe: `${name}-probe`,
        check: { kind: 'some-equals', binding: 'items', field: 'title', value: title },
        skip: [`${name}-find`, `${name}-form`, `${name}-save`],
      },
      `/_api/json/v1/tenant-a/content/${id}/history?itemsPerPage=*`,
      'admin',
      { items: body('data.items') },
    );
  }
  for (const n of [1, 2]) {
    const name = `content-create-${n}`;
    add(
      {
        name,
        probe: `${name}-probe`,
        check: { kind: 'some-equals', binding: 'items', field: 'title', value: `OPT-2 Workload Page ${n}` },
        skip: [`${name}-form`, `${name}-save`],
      },
      `/_api/json/v1/tenant-b/content/?title=OPT-2%20Workload%20Page%20${n}&liveOnly=0`,
      'admin',
      { items: body('data.items') },
    );
  }
  for (const n of [1, 2, 3]) {
    const name = `user-edit-${n}`;
    const id = idIn(`${name}-save`, /[?&]userid=([^&]+)/);
    add(
      {
        name,
        probe: `${name}-form`,
        check: { kind: 'equals', binding: 'jobtitle', value: `OPT-2 Workload Analyst ${n}` },
        skip: [`${name}-save`],
      },
      `/admin/?muraAction=cUsers.editUser&siteid=tenant-a&userid=${id}`,
      'admin',
      { jobtitle: dom('jobtitle') },
    );
    add(
      {
        name: `${name}-address`,
        probe: `${name}-address-probe`,
        check: { kind: 'some-equals', binding: 'items', field: 'addressname', value: `OPT-2 Workload Office ${n}` },
        skip: [`${name}-address-form`, `${name}-address-save`],
      },
      `/_api/json/v1/tenant-a/address/?userid=${id}`,
      'admin',
      { items: body('data.items') },
    );
  }
  add(
    {
      name: 'group-edit-1',
      probe: 'group-edit-1-form',
      check: { kind: 'equals', binding: 'email', value: 'opt2-workload-group-1@workload.opt2.test' },
      skip: ['group-edit-1-save'],
    },
    '/admin/?muraAction=cUsers.editGroup&siteid=tenant-a&userid=FIXTURE-GROUP-A-0001',
    'admin',
    { email: dom('email') },
  );
  add(
    {
      name: 'site-edit',
      probe: 'site-edit-form',
      check: { kind: 'equals', binding: 'contact', value: WORKLOAD_CONTACT },
      skip: ['site-edit-save'],
    },
    '/admin/?muraAction=cSettings.editSite&siteid=tenant-b',
    'admin',
    { contact: dom('contact') },
  );
  if (!available) return { writes, probes };
  for (const n of [1, 2, 3]) {
    const name = `timesheet-submit-${n}`;
    const day = DAYS.find((row) => row.day_id === idIn(name, /\/days\/([^/]+)\/submit/));
    if (day === undefined) throw new Error(`${name} submits no dataset day`);
    add(
      {
        name,
        probe: `${name}-probe`,
        check: {
          kind: 'keyed-not-equals',
          binding: 'days',
          key: 'day_id',
          id: day.day_id,
          field: 'state',
          value: 'DRAFT',
        },
        skip: [name],
      },
      `/legacy-fixtures/cfml/api.cfm/timesheets/sheets/${day.timesheet_id}?siteid=tenant-a`,
      'employee',
      { days: body('data.days') },
    );
  }
  for (const n of [1, 2]) {
    const name = `finance-edit-${n}`;
    add(
      {
        name,
        probe: `${name}-probe`,
        check: { kind: 'equals', binding: 'title', value: `OPT-2 workload edit ${n}` },
        skip: [name],
      },
      `/legacy-fixtures/cfml/api.cfm/finance/records/${idIn(name, /\/records\/([^/]+)\/edit/)}?siteid=tenant-a`,
      'preparer',
      { title: body('data.title') },
    );
  }
  return { writes, probes };
}

describe('runWorkload per-write reconciliation', () => {
  it.each<[boolean, Record<string, unknown>]>([
    [true, APPLIED],
    [false, { ...APPLIED, submits: 0, financeEdits: 0 }],
  ])('a clean run with fixtures available=%s sends every write once and completes', async (available, applied) => {
    writeFixtureStatus(available);
    const workload = await plan();
    const fake = fakeLegacy();
    const run = await runWorkload(workload, depsFor(fake));

    expect(run).toMatchObject({ outcome: 'complete', failures: [], report: journalPath() });
    expect(run.writes).toStrictEqual({ sent: workload.writes.length, alreadyApplied: 0 });
    expect(run.items.map((item) => item.name)).toStrictEqual(names(workload));
    expect(run.items.filter((item) => item.skipped !== undefined || item.status === null)).toStrictEqual([]);
    expect(writes(fake)).toStrictEqual(postsExcept(workload, []));
    expect(counts(fake)).toStrictEqual(applied);
    expect(journal()).toMatchObject({ planDigest: planDigest(workload), status: 'complete', failures: [] });
    expect(journal().items).toStrictEqual(run.items);
    expect(journalText()).not.toContain(ADMIN_PASSWORD);
    expect(journalText()).not.toContain(ROLE_PASSWORD);
  });

  it('a rerun after a complete run is already-applied: it posts only logins, changes nothing, exits 0', async () => {
    const workload = await plan();
    const fake = fakeLegacy();
    await runWorkload(workload, depsFor(fake));
    const from = fake.calls.length;

    const rerun = await runWorkload(workload, depsFor(fake));
    expect(rerun).toMatchObject({ outcome: 'already-applied', failures: [], report: journalPath() });
    expect(rerun.writes).toStrictEqual({ sent: 0, alreadyApplied: workload.writes.length });
    const unsent = new Set(workload.writes.flatMap((write) => write.skip));
    expect(rerun.items).toStrictEqual(
      workload.items.map((item) =>
        unsent.has(item.name)
          ? { name: item.name, routeKey: null, status: null, skipped: 'already-applied' }
          : { name: item.name, routeKey: expect.any(String), status: 200 },
      ),
    );
    const cli = await main([], depsFor(fake));
    expect(cli.code).toBe(0);
    expect(cli.summary).toMatchObject({
      outcome: 'already-applied',
      failures: 0,
      writesSent: 0,
      writesAlreadyApplied: workload.writes.length,
      report: journalPath(),
    });

    const logins = postsExcept(workload, workload.writes.map((write) => write.name));
    expect(logins).toStrictEqual([
      'POST /admin/index.cfm',
      'POST /_api/json/v1/tenant-a/login',
      'POST /_api/json/v1/tenant-a/login',
    ]);
    expect(writes(fake, from)).toStrictEqual([...logins, ...logins]);
    expect(counts(fake)).toStrictEqual(APPLIED);
    expect(journal()).toMatchObject({ status: 'complete', failures: [] });
  });

  it('after a complete run and an ordinary edit of the site contact, a rerun resends only the site save', async () => {
    const workload = await plan();
    const fake = fakeLegacy();
    await runWorkload(workload, depsFor(fake));
    // GS-PS-02 sets the tenant-b contact and restores it in a later step; a capture interrupted between leaves it set.
    fake.contact = 'gs-ps-02@seed.opt2.test';
    const from = fake.calls.length;

    const rerun = await runWorkload(workload, depsFor(fake));
    expect(rerun).toMatchObject({ outcome: 'complete', failures: [] });
    expect(rerun.writes).toStrictEqual({ sent: 1, alreadyApplied: workload.writes.length - 1 });
    const others = workload.writes.map((write) => write.name).filter((name) => name !== 'site-edit');
    expect(writes(fake, from)).toStrictEqual(postsExcept(workload, others));
    expect(writes(fake, from)).toContain('POST /admin/ cSettings.updateSite');
    expect(counts(fake)).toStrictEqual(APPLIED);
  });

  it('a rerun after an interrupted run sends only the writes legacy lacks and completes the journal', async () => {
    const workload = await plan();
    const fake = fakeLegacy();
    // The process dies after the third draft save is sent, before the journal records it.
    const drafted = (): boolean => counts(fake).drafts === 3;
    await expect(runWorkload(workload, depsFor(fake, drafted))).rejects.toBe(INTERRUPTED);
    expect(journal().status).toBe('running');
    expect(journal().items.map((item) => item.name)).toStrictEqual(
      names(workload).slice(0, names(workload).indexOf('content-edit-3-save')),
    );
    expect(counts(fake)).toStrictEqual({ ...UNTOUCHED, drafts: 3 });
    const from = fake.calls.length;

    const rerun = await runWorkload(workload, depsFor(fake));
    const applied = ['content-edit-1', 'content-edit-2', 'content-edit-3'];
    expect(rerun).toMatchObject({ outcome: 'complete', failures: [] });
    expect(rerun.writes).toStrictEqual({ sent: workload.writes.length - 3, alreadyApplied: 3 });
    expect(writes(fake, from)).toStrictEqual(postsExcept(workload, applied));
    expect(counts(fake)).toStrictEqual(APPLIED);
    expect(journal()).toMatchObject({ planDigest: planDigest(workload), status: 'complete', failures: [] });
    expect(journal().items.filter((item) => item.skipped === 'already-applied').map((item) => item.name)).toStrictEqual(
      applied.flatMap((name) => writeOf(workload, name).skip),
    );
  });

  it.each<[string, string, () => Response, string]>([
    ['answers 500 without its field', 'site-edit', () => html('<html><body>Error</body></html>', 500), '(status 500)'],
    [
      'answers 500 with its field',
      'group-edit-1',
      () => formPage('./?muraAction=cUsers.update', {}, textInput('email', SEEDED_GROUP_EMAIL), 'form1', 500),
      'group-edit-1-form: status 500)',
    ],
    [
      'lacks the probed field',
      'user-edit-1',
      () => formPage('./?muraAction=cUsers.update', {}),
      'no element matches input[name=jobtitle]',
    ],
    ['lacks the probed binding', 'content-edit-1', () => json({ data: {} }), 'no data.items in the response body'],
    [
      'lists an element without the checked field',
      'content-create-1',
      () => json({ data: { items: [{ contentid: 'FIXTURE-OTHER-PAGE' }] } }),
      'binding items lacks what its some-equals check reads',
    ],
    [
      'lacks the keyed element',
      'timesheet-submit-1',
      () => json({ data: { days: [] } }),
      'binding days lacks what its keyed-not-equals check reads',
    ],
    [
      'answers a non-scalar value',
      'finance-edit-1',
      () => json({ data: { title: null } }),
      'binding title lacks what its equals check reads',
    ],
  ])('withholds a write whose probe %s, still sends the others, and exits 1', async (_case, name, answer, cause) => {
    const workload = await plan();
    const write = writeOf(workload, name);
    const target = new URL(itemOf(workload, write.probe).route, GATEWAY).href;
    const fake = fakeLegacy();
    // Only this write's probe: another write may probe the same timesheet.
    let answered = false;
    fake.override = (call) => {
      if (answered || call.method !== 'GET' || call.url.href !== target) return undefined;
      answered = true;
      return answer();
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cli = await main([], depsFor(fake));

    expect(cli.code).toBe(1);
    expect(cli.summary).toMatchObject({
      outcome: 'complete',
      failures: 1,
      writesSent: workload.writes.length - 1,
      writesAlreadyApplied: 0,
    });
    const reason = `could not verify whether it is already applied, so it was not sent (${write.probe}: `;
    expect(journal().failures).toStrictEqual([
      expect.objectContaining({ name, reason: expect.stringContaining(reason) }),
    ]);
    expect(journal().failures[0]?.reason).toContain(cause);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`${name}: ${reason}`));
    expect(journal().items.filter((item) => item.skipped !== undefined)).toStrictEqual(
      write.skip.map((skip) => ({ name: skip, routeKey: null, status: null, skipped: 'unverified' })),
    );
    expect(writes(fake)).toStrictEqual(postsExcept(workload, [name]));
  });

  it.each([true, false])(
    'buildWorkloadPlan with fixtures available=%s is pure data: catalogue steps, each write after its probe',
    async (available) => {
      writeFixtureStatus(available);
      const first = await plan();
      const second = await plan();
      expect(second).toStrictEqual(first);
      expect(JSON.parse(JSON.stringify(first))).toStrictEqual(first);
      for (const item of first.items) expect(stepSchema.parse(item)).toStrictEqual(item);
      const order = names(first);
      expect(new Set(order).size).toBe(order.length);
      const skipped = first.writes.flatMap((write) => write.skip);
      expect(new Set(skipped).size).toBe(skipped.length);
      for (const write of first.writes) {
        const at = order.indexOf(write.probe);
        expect(at).toBeGreaterThan(-1);
        expect(skipped).not.toContain(write.probe);
        for (const name of write.skip) expect(order.indexOf(name)).toBeGreaterThan(at);
      }
      const posted = first.items.filter((item) => item.method === 'POST').map((item) => item.name);
      expect(posted.filter((name) => !skipped.includes(name))).toStrictEqual(
        LOGINS.filter((name) => available || name === 'admin-login'),
      );
      const expected = expectedReconciliation(first, available);
      expect(first.writes).toStrictEqual(expected.writes);
      expect(
        first.writes.map((write) => {
          const { name, method, route, as, extract } = itemOf(first, write.probe);
          return { name, method, route, as, extract };
        }),
      ).toStrictEqual(expected.probes);
    },
  );

  it.each<[string, (workload: WorkloadPlan) => WorkloadPlan]>([
    ['is missing', (w) => ({ ...w, items: w.items.filter((item) => item.name !== 'site-edit-form') })],
    [
      'follows its items',
      (w) => ({
        ...w,
        items: w.items.map((item) =>
          item.name === 'site-edit-form'
            ? itemOf(w, 'site-edit-save')
            : item.name === 'site-edit-save'
              ? itemOf(w, 'site-edit-form')
              : item,
        ),
      }),
    ],
    [
      "is another write's item",
      (w) => ({
        ...w,
        writes: w.writes.map((write) =>
          write.name === 'content-edit-1' ? { ...write, skip: [...write.skip, 'content-edit-2-probe'] } : write,
        ),
      }),
    ],
    [
      'probes two writes',
      (w) => ({ ...w, writes: [...w.writes, { ...writeOf(w, 'site-edit'), name: 'site-edit-again' }] }),
    ],
  ])('rejects a plan whose write probe %s, before sending anything', async (_case, broken) => {
    const workload = broken(await plan());
    const fake = fakeLegacy();

    await expect(runWorkload(workload, depsFor(fake))).rejects.toBeInstanceOf(GoldenConfigError);
    expect(fake.calls).toStrictEqual([]);
    expect(existsSync(journalPath())).toBe(false);
  });
});
