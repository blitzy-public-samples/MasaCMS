import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stepSchema, type SessionSpec, type Step } from '../../src/golden/catalogue.js';
import { createScenarioContext } from '../../src/golden/session.js';
import { runScenarioSteps } from '../../src/golden/steps.js';
import {
  WORKLOAD_COUNTS,
  WORKLOAD_ID,
  buildWorkloadPlan,
  planDigest,
  runWorkload,
  workloadSeedConfigSchema,
  type WorkloadDataset,
  type WorkloadDeps,
  type WorkloadPlan,
  type WorkloadUser,
} from '../../src/golden/workload.js';
import type { EnvLike } from '../../src/lib/paths.js';

const GATEWAY = 'http://127.0.0.1:8100';
const LEGACY_PORT = '8080';
const LEGACY = `http://127.0.0.1:${LEGACY_PORT}`;
const ADMIN_PASSWORD = 'FIXTURE-ADMIN-PASSWORD';
/** CSRF token `admin-login.html` carries. */
const LOGIN_TOKEN = 'FIXTURECSRFTOKEN0000000000000001';
const EXPIRES = '260630120000000';
/** Hidden input the content form carries per pooled category. */
const CATEGORY_FIELD = 'categoryAssignFIXTURECATEGORY0001';
const CLOCK = new Date('2026-06-30T12:00:00.000Z');
const HOME_ID = '00000000000000000000000000000000001';
const JSON_API = /^\/_api\/json\/v1\/([^/]+)\/(.*)$/;
const LOGIN_HTML = readFileSync(new URL('../fixtures/html/admin-login.html', import.meta.url), 'utf8');
/** Admin form pages the workload reads before each save. */
const FORM_ACTIONS: ReadonlySet<string> = new Set([
  'carch.edit',
  'cusers.edituser',
  'cusers.editaddress',
  'cusers.editgroup',
  'csettings.editsite',
]);

const CONFIG = workloadSeedConfigSchema.parse(
  JSON.parse(readFileSync(new URL('../fixtures/golden/seed-config.sample.json', import.meta.url), 'utf8')),
);
const { persons: RESERVED_PERSONS, usernames: RESERVED_USERNAMES } = CONFIG.reserved.rehearsal;
/** Two reserved persons and one reserved username, each held by a dataset user. */
const RESERVED_HELD = [...RESERVED_PERSONS.slice(0, 2), ...RESERVED_USERNAMES.slice(0, 1)];

function user(userID: string, username: string, overrides: Partial<WorkloadUser> = {}): WorkloadUser {
  return {
    userID,
    siteID: 'tenant-a',
    isPublic: 0,
    username,
    fname: 'Fixture',
    lname: username,
    email: `${username}@tenant-a.example`,
    subscribe: 0,
    ...overrides,
  };
}

function page(contentID: string, siteID: string, type = 'Page'): WorkloadDataset['masa']['content'][number] {
  return { contentID, siteID, parentID: HOME_ID, type, title: `Fixture ${contentID}`, isNav: 1 };
}

const ELIGIBLE_USERS = [1, 2, 3, 4].map((n) => user(`FIXTURE-USER-A-000${n}`, `fixture.user${n}`));
const RESERVED_USERS = [
  ...RESERVED_PERSONS.slice(0, 2).map((id, i) => user(id, `fixture.rehearsal${i + 1}`)),
  ...RESERVED_USERNAMES.slice(0, 1).map((username) => user('FIXTURE-USER-A-0090', username)),
];
const MEMBER = user('FIXTURE-USER-A-0091', 'fixture.member');
const OTHER_USERS = [
  MEMBER,
  user('FIXTURE-USER-A-0092', 'fixture.public', { isPublic: 1 }),
  user('FIXTURE-USER-B-0001', 'fixture.tenant-b', { siteID: 'tenant-b' }),
];
const ELIGIBLE_GROUPS = [
  { groupID: 'FIXTURE-GROUP-A-0001', siteID: 'tenant-a', groupname: 'Fixture Editors' },
  { groupID: 'FIXTURE-GROUP-A-0002', siteID: 'tenant-a', groupname: 'Fixture Reviewers' },
];
const ELIGIBLE_PAGES = [1, 2, 3, 4, 5, 6].map((n) => page(`FIXTURE-PAGE-A-000${n}`, 'tenant-a'));
// The fields of the generated `dataset.json` the workload reads.
const DATASET: WorkloadDataset = {
  masa: {
    users: [...ELIGIBLE_USERS, ...RESERVED_USERS, ...OTHER_USERS],
    groups: [
      ...ELIGIBLE_GROUPS,
      { groupID: 'FIXTURE-GROUP-B-0001', siteID: 'tenant-b', groupname: 'Fixture Tenant B' },
    ],
    memberships: [{ userID: MEMBER.userID, groupname: 'Fixture Editors', groupSiteID: 'tenant-a' }],
    content: [
      ...ELIGIBLE_PAGES,
      page('FIXTURE-FOLDER-A-0001', 'tenant-a', 'Folder'),
      page('FIXTURE-PAGE-B-0001', 'tenant-b'),
    ],
  },
};
const OPTIONS = {} as const;

/** One request a fake origin received. */
interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  /** A redirect hop the session followed, not a request of the plan's own. */
  follow: boolean;
  /** CSRF token of the form page this request was answered with. */
  served?: string;
}

/** Gateway or legacy origin answering every request the workload sends, and recording each. */
interface FakeOrigin {
  origin: string;
  fetch: NonNullable<WorkloadDeps['fetch']>;
  calls: Call[];
  unmatched: string[];
  /** Answers a request in place of the fake when it returns a response. */
  override?: (call: Call) => Response | undefined;
}

const fakes: FakeOrigin[] = [];
let dir = '';
let env: EnvLike = {};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'opt2-workload-'));
  // No OPT2_GATEWAY_URL, so requests take the gateway's ports.env origin; PORT names the legacy ColdFusion port.
  env = { OPT2_STATE_DIR: dir, MURA_ADMIN_PASSWORD: ADMIN_PASSWORD, PORT: LEGACY_PORT };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const fake of fakes.splice(0)) {
    expect(fake.unmatched).toStrictEqual([]);
    expect(fake.calls.filter((call) => call.url.origin !== fake.origin)).toStrictEqual([]);
  }
});

function html(markup: string, status = 200): Response {
  return new Response(markup, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** One admin form page serving every probed field empty, so no write reads as applied, and a category input. */
function formPage(token: string): Response {
  const inputs = ['jobtitle', 'email', 'contact'].map((name) => `<input name="${name}" type="text" value="">`);
  const hidden = [
    ['contenthistid', 'FIXTURE-HIST-FORM'],
    [CATEGORY_FIELD, '0'],
    ['csrf_token', token],
    ['csrf_token_expires', EXPIRES],
  ].map(([name, value]) => `<input type="hidden" name="${name}" value="${value}">`);
  const form = `<form id="contentForm" method="post" action="./">${[...inputs, ...hidden].join('')}</form>`;
  return html(`<!DOCTYPE html><html><body>${form}</body></html>`);
}

/** JSON API: empty listings for every probe. */
function jsonApi(call: Call, rest: string): Response | undefined {
  if (call.method === 'POST') return undefined;
  if (/^content\/[^/]+\/history$/.test(rest) || rest === 'content/' || rest === 'address/') {
    return json({ data: { items: [] } });
  }
  const id = /^content\/([^/]+)$/.exec(rest)?.[1];
  return id === undefined ? undefined : json({ data: { contentid: id, contenthistid: `FIXTURE-HIST-${id}` } });
}

/** Answer to `call`: admin login and forms, FW/1 post-action redirects and JSON API. */
function answer(call: Call, mint: () => string): Response | undefined {
  const { method, url } = call;
  const action = (url.searchParams.get('muraAction') ?? '').toLowerCase();
  if (method === 'GET' && url.pathname === '/admin/') {
    if (action === 'clogin.main') {
      call.served = LOGIN_TOKEN;
      return html(LOGIN_HTML);
    }
    if (FORM_ACTIONS.has(action)) {
      call.served = mint();
      return formPage(call.served);
    }
    return action === '' ? html('<!DOCTYPE html><html><body>Site Content</body></html>') : undefined;
  }
  if (method === 'POST' && (url.pathname === '/admin/' || url.pathname === '/admin/index.cfm')) {
    return new Response(null, { status: 302, headers: { location: './' } });
  }
  const api = JSON_API.exec(url.pathname);
  return api === null ? undefined : jsonApi(call, api[2] ?? '');
}

function fakeOrigin(origin: string): FakeOrigin {
  let minted = 0;
  let redirectedTo: string | undefined;
  const fake: FakeOrigin = {
    origin,
    calls: [],
    unmatched: [],
    fetch: async (input, init) => {
      const url = new URL(input);
      const call: Call = {
        method: init.method ?? 'GET',
        url,
        headers: { ...((init.headers ?? {}) as Record<string, string>) },
        body: typeof init.body === 'string' ? init.body : '',
        follow: url.href === redirectedTo,
      };
      redirectedTo = undefined;
      fake.calls.push(call);
      const response = fake.override?.(call) ?? answer(call, () => `FIXTURE-FORM-TOKEN-${(minted += 1)}`);
      if (response === undefined) {
        fake.unmatched.push(`${call.method} ${url.pathname}${url.search}`);
        return html('not found', 404);
      }
      const location = response.headers.get('location');
      if (location !== null) redirectedTo = new URL(location, url).href;
      return response;
    },
  };
  fakes.push(fake);
  return fake;
}

function depsFor(fake: FakeOrigin): WorkloadDeps {
  return { env, fetch: fake.fetch, report: { clock: () => CLOCK, generatedBy: 'test' } };
}

/** Requests of the plan's own items: neither a followed redirect nor a JSON API token fetch. */
function itemCalls(fake: FakeOrigin): Call[] {
  return fake.calls.filter((call) => !call.follow && !call.url.pathname.endsWith('/generateCSRFTokens'));
}

/** `METHOD path muraAction` of a request; ids bound at run time sit in the query, outside it. */
function target(method: string, url: URL): string {
  return `${method} ${url.pathname} ${url.searchParams.get('muraAction') ?? ''}`.trim();
}

function itemOf(plan: WorkloadPlan, name: string): Step {
  const found = plan.items.find((item) => item.name === name);
  if (found === undefined) throw new Error(`plan has no item ${name}`);
  return found;
}

/** Items of `plan` whose names match `pattern`. */
function itemsNamed(plan: WorkloadPlan, pattern: RegExp): Step[] {
  return plan.items.filter((item) => pattern.test(item.name));
}

/** Fields of `<state>/golden/workload.json` the tests read. */
interface Journal {
  planDigest: string;
  status: string;
  items: { name: string; routeKey: string | null; status: number | null; skipped?: string }[];
  failures: { name: string; routeKey: string | null; status: number | null; reason: string }[];
}

function journalPath(): string {
  return path.join(dir, 'golden', 'workload.json');
}

function journal(): Journal {
  return JSON.parse(readFileSync(journalPath(), 'utf8')) as Journal;
}

describe('buildWorkloadPlan', () => {
  it('builds a deep-equal, JSON-identical plan from equal inputs, seeded by the configuration seed', () => {
    const first = buildWorkloadPlan(CONFIG, DATASET, OPTIONS);
    const second = buildWorkloadPlan(structuredClone(CONFIG), structuredClone(DATASET), { ...OPTIONS });

    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.seed).toBe(CONFIG.seed);
    const reseeded = buildWorkloadPlan({ ...CONFIG, seed: CONFIG.seed + 1 }, DATASET, OPTIONS);
    expect(reseeded.seed).toBe(CONFIG.seed + 1);
    expect(reseeded.items).not.toStrictEqual(first.items);
  });

  it('holds only catalogue-shaped steps', () => {
    const plan = buildWorkloadPlan(CONFIG, DATASET, OPTIONS);

    expect(plan.items.length).toBeGreaterThan(0);
    for (const item of plan.items) expect(stepSchema.parse(item)).toStrictEqual(item);
  });

  it('edits tenant-a pages, creates tenant-b pages, and edits eligible tenant-a users, a group and a site', () => {
    const plan = buildWorkloadPlan(CONFIG, DATASET, OPTIONS);
    const distinct = (values: unknown[]): unknown[] => {
      expect(new Set(values).size).toBe(values.length);
      return values;
    };

    const edits = itemsNamed(plan, /^content-edit-\d+-save$/);
    expect(edits).toHaveLength(WORKLOAD_COUNTS.contentEdits);
    for (const item of edits) expect(item.form).toMatchObject({ siteid: 'tenant-a', type: 'Page' });
    expect(plan.items.filter((item) => item.mergeHidden !== undefined)).toStrictEqual(edits);
    for (const item of edits) expect(item).toMatchObject({ csrf: 'fetch-form', mergeHidden: false });
    const pageIds = ELIGIBLE_PAGES.map((row) => row.contentID);
    expect(pageIds).toEqual(expect.arrayContaining(distinct(edits.map((item) => item.form?.contentid))));

    const creates = itemsNamed(plan, /^content-create-\d+-save$/);
    expect(creates).toHaveLength(WORKLOAD_COUNTS.contentCreates);
    for (const item of creates) {
      expect(item.form).toMatchObject({ siteid: 'tenant-b', type: 'Page', parentid: HOME_ID });
    }
    distinct(creates.map((item) => item.form?.title));

    const users = itemsNamed(plan, /^user-edit-\d+-save$/);
    expect(users).toHaveLength(WORKLOAD_COUNTS.userEdits);
    for (const item of users) expect(item.form).toMatchObject({ siteid: 'tenant-a', type: '2', action: 'Update' });
    const userIds = distinct(users.map((item) => new URL(item.route, GATEWAY).searchParams.get('userid')));
    expect(ELIGIBLE_USERS.map((row) => row.userID)).toEqual(expect.arrayContaining(userIds));

    const groups = itemsNamed(plan, /^group-edit-\d+-save$/);
    expect(groups).toHaveLength(WORKLOAD_COUNTS.groupEdits);
    for (const item of groups) expect(item.form).toMatchObject({ siteid: 'tenant-a', type: '1', action: 'Update' });
    const groupNames = ELIGIBLE_GROUPS.map((row) => row.groupname);
    expect(groupNames).toEqual(expect.arrayContaining(distinct(groups.map((item) => item.form?.groupname))));

    expect(itemOf(plan, 'site-edit-save').form).toMatchObject({ siteid: 'tenant-b', action: 'Update' });
  });

  it('names no reserved rehearsal identity, though the dataset holds them', () => {
    const plan = buildWorkloadPlan(CONFIG, DATASET, OPTIONS);
    const datasetText = JSON.stringify(DATASET);
    const planText = JSON.stringify(plan);

    for (const held of RESERVED_HELD) expect(datasetText).toContain(held);
    for (const reserved of [...RESERVED_PERSONS, ...RESERVED_USERNAMES]) {
      expect(planText).not.toContain(reserved);
    }
  });

  it.each<[string, WorkloadDataset, string, string[]]>([
    [
      'users',
      { ...DATASET, masa: { ...DATASET.masa, users: [...RESERVED_USERS, ...OTHER_USERS] } },
      `workload needs ${WORKLOAD_COUNTS.userEdits} user-edit rows; the dataset has 0 eligible`,
      RESERVED_HELD,
    ],
  ])(
    'refuses to plan when only reserved %s are eligible, and plans them once unreserved',
    (_kind, dataset, message, held) => {
      const build = (): WorkloadPlan => buildWorkloadPlan(CONFIG, dataset, OPTIONS);
      const unreserved = { ...CONFIG, reserved: { rehearsal: { persons: [], usernames: [] } } };

      expect(build).toThrow(expect.objectContaining({ name: 'GoldenConfigError', message }));
      const planText = JSON.stringify(buildWorkloadPlan(unreserved, dataset, OPTIONS));
      for (const identity of held) expect(planText).toContain(identity);
    },
  );
});

describe('runWorkload', () => {
  it('sends every item to the gateway in plan order with its CSRF source, and journals each status', async () => {
    const plan = buildWorkloadPlan(CONFIG, DATASET, OPTIONS);
    const gateway = fakeOrigin(GATEWAY);
    // A 302 without Location is not followed, so this save records the 302 itself.
    const siteSave = new URL(itemOf(plan, 'site-edit-save').route, GATEWAY).href;
    gateway.override = (call) =>
      call.method === 'POST' && call.url.href === siteSave ? new Response(null, { status: 302 }) : undefined;
    const run = await runWorkload(plan, depsFor(gateway));

    expect(run).toMatchObject({ outcome: 'complete', failures: [], report: journalPath() });
    expect(run.writes).toStrictEqual({ sent: plan.writes.length, alreadyApplied: 0 });
    expect(new Set(gateway.calls.map((call) => call.url.origin))).toStrictEqual(new Set([GATEWAY]));
    const calls = itemCalls(gateway);
    expect(calls.map((call) => target(call.method, call.url))).toStrictEqual(
      plan.items.map((item) => target(item.method, new URL(item.route, GATEWAY))),
    );

    const names = plan.items.map((item) => item.name);
    expect(new Set(plan.items.map((item) => item.csrf.split(':')[0]))).toStrictEqual(new Set(['none', 'fetch-form']));
    for (const [index, item] of plan.items.entries()) {
      const call = calls[index] as Call;
      if (item.csrf === 'fetch-form') {
        const source = calls[names.indexOf(item.csrfFrom ?? '')];
        expect(source?.served).toBeDefined();
        const form = new URLSearchParams(call.body);
        expect([form.get('csrf_token'), form.get('csrf_token_expires')]).toStrictEqual([source?.served, EXPIRES]);
      }
    }
    expect(new URLSearchParams(calls[names.indexOf('admin-login')]?.body).get('csrf_token')).toBe(LOGIN_TOKEN);
    const posted = (name: string): string[] => [...new URLSearchParams(calls[names.indexOf(name)]?.body).keys()];
    for (const item of itemsNamed(plan, /^content-edit-\d+-save$/)) {
      expect(posted(item.name)).toStrictEqual(['csrf_token', 'csrf_token_expires', ...Object.keys(item.form ?? {})]);
    }
    for (const item of itemsNamed(plan, /^content-create-\d+-save$/)) {
      expect(posted(item.name)).toContain(CATEGORY_FIELD);
    }

    const written = journal();
    expect(written).toMatchObject({ planDigest: planDigest(plan), status: 'complete', failures: [] });
    expect(written.items).toStrictEqual(run.items);
    expect(written.items.map((item) => item.name)).toStrictEqual(names);
    for (const item of written.items) {
      expect(item.status).toBeGreaterThanOrEqual(200);
      expect(item.status).toBeLessThan(400);
    }
    expect(written.items.find((item) => item.name === 'site-edit-save')?.status).toBe(302);
  });

  it('sends the same requests, CSRF fields included, that capture sends to legacy', async () => {
    const plan = buildWorkloadPlan(CONFIG, DATASET, OPTIONS);
    const legacy = fakeOrigin(LEGACY);
    const unauthenticated: SessionSpec = { login: 'none', via: 'admin' };
    const sessions = Object.fromEntries(plan.items.map((item) => [item.as ?? 'admin', unauthenticated]));
    const ctx = createScenarioContext({ id: WORKLOAD_ID, sessions }, { origin: 'legacy', env, fetch: legacy.fetch });
    await runScenarioSteps(ctx, { id: WORKLOAD_ID, steps: plan.items }, { mode: 'capture', login: false });
    const gateway = fakeOrigin(GATEWAY);
    await runWorkload(plan, depsFor(gateway));

    const sent = (fake: FakeOrigin): unknown[] =>
      fake.calls.map((call) => ({
        method: call.method,
        target: `${call.url.pathname}${call.url.search}`,
        body: call.body,
        csrf: [call.headers['x-csrf_token'], call.headers['x-csrf_token_expires']],
      }));
    expect(legacy.calls.length).toBeGreaterThan(plan.items.length);
    expect(sent(gateway)).toStrictEqual(sent(legacy));
  });

  it.each([500, 404])(
    'records a write answered %i as a failure with its status, and still sends every later item',
    async (status) => {
      const plan = buildWorkloadPlan(CONFIG, DATASET, OPTIONS);
      const failing = 'user-edit-2-save';
      const failingUrl = new URL(itemOf(plan, failing).route, GATEWAY).href;
      const gateway = fakeOrigin(GATEWAY);
      const error = (): Response => html('<html><body>Error</body></html>', status);
      gateway.override = (call) => (call.method === 'POST' && call.url.href === failingUrl ? error() : undefined);
      const run = await runWorkload(plan, depsFor(gateway));

      const failure = { name: failing, routeKey: expect.any(String), status, reason: `status ${status}` };
      expect(run.failures).toStrictEqual([failure]);
      expect(run.writes).toStrictEqual({ sent: plan.writes.length, alreadyApplied: 0 });
      const written = journal();
      expect(written).toMatchObject({ status: 'complete', failures: [failure] });
      expect(written.items.find((item) => item.name === failing)?.status).toBe(status);
      expect(written.items.map((item) => item.name)).toStrictEqual(plan.items.map((item) => item.name));
      expect(written.items.filter((item) => item.status === null || item.skipped !== undefined)).toStrictEqual([]);

      const later = plan.items.slice(plan.items.findIndex((item) => item.name === failing) + 1);
      expect(later.length).toBeGreaterThan(0);
      const calls = itemCalls(gateway);
      expect(calls.slice(calls.length - later.length).map((call) => target(call.method, call.url))).toStrictEqual(
        later.map((item) => target(item.method, new URL(item.route, GATEWAY))),
      );
    },
  );
});

describe('planDigest', () => {
  it.each<[string, Step]>([
    [
      'declared',
      {
        route: '/admin/?muraAction=csettings.updatesite',
        name: 'site-edit-save',
        method: 'POST',
        csrf: 'fetch-form',
        form: { siteid: 'tenant-b', action: 'Update' },
      },
    ],
    [
      'reordered',
      {
        form: { action: 'Update', siteid: 'tenant-b' },
        csrf: 'fetch-form',
        method: 'POST',
        name: 'site-edit-save',
        route: '/admin/?muraAction=csettings.updatesite',
      },
    ],
  ])('keeps the fixed digest of an item with %s key order', (_order, item) => {
    expect(planDigest({ items: [item] })).toBe('4058e090d5439a51662930686b23d813516d314021b6d67564c44ecafcae9098');
  });
});
