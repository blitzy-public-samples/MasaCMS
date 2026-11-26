import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { matchRouteKey, type RouteKeyResult } from '@opt2/platform/legacy-compat';

import type { Scenario, Step } from '../../src/golden/catalogue.js';
import { coverageRouteResults, type StepRequest } from '../../src/golden/coverage.js';
import { GoldenConfigError } from '../../src/golden/errors.js';
import { formTokensFrom, loadSeedStore } from '../../src/golden/session.js';
import { runCli } from '../../src/lib/cli.js';
import { createHttpSession, type FetchLike, type HttpSession } from '../../src/lib/http.js';
import type { HarnessInvoker } from '../../src/lib/invocation.js';
import { REPO_ROOT, type EnvLike } from '../../src/lib/paths.js';
import { readPin } from '../../src/lib/pin.js';
import {
  CLOUD_MEASUREMENT,
  CONTENT_READS,
  CONTENT_READS_LABEL,
  EXPECTED_MIN_INSTANCES,
  GATEWAY_PROBES,
  GENERATED_BY,
  PERFORMANCE_FEED_NAME,
  POLL_LIMIT_MS,
  PROBE_INTERVAL_MS,
  READ_SET,
  REQUESTS_PER_SET,
  RESTART_SERVICES,
  STOP_KILL_AFTER_MS,
  STOP_POLL_MS,
  buildPerformanceReport,
  checkMinInstanceCounts,
  chooseProbe,
  createFeedCollection,
  deleteFeedCollection,
  expandCatalogueReads,
  feedReadPath,
  legacyServedFindings,
  loadCutoverTable,
  main,
  measureLatencySet,
  notTargetDetail,
  parseMinInstanceCounts,
  percentile,
  ratioFinding,
  renderPerformanceMarkdown,
  resolveReadPath,
  restartAndMeasure,
  seededPageIds,
  servingSide,
  startProcess,
  stopProcess,
  summariseSamples,
  terraformPlanReportSchema,
  windowsOverThreshold,
  windowsReportSchema,
  type CutoverTable,
  type FeedDeps,
  type Finding,
  type GatewayProbe,
  type KillLike,
  type LatencyRow,
  type MainDeps,
  type PerformanceParts,
  type PerformanceReport,
  type ProbeChoice,
  type ProbePlan,
  type ProcessDeps,
  type ReadLabels,
  type ReadSetEntry,
  type RestartService,
  type ScaleToZeroRow,
  type SessionProbeSpec,
  type SpawnLike,
  type SpawnedProcess,
} from '../../src/performance/run.js';
import { portFor } from '../../src/repro/ports.js';
import { readUpState, writeUpState, type UpProcessEntry, type UpStatePatch } from '../../src/repro/up-state.js';

// Above Linux pid_max (at most 4194304), so no signal from a test can reach a real process.
const PID_BASE = 1_000_000_000;
// `.invalid` never resolves; every request goes to the fake fetch of its test.
const LEGACY = 'http://legacy.invalid';
const GATEWAY = 'http://gateway.invalid';
const LOGIN_PAGE = '/admin/?muraAction=clogin.main';
const LOGIN_POST = '/admin/?muraAction=cLogin.login';
const CUSERS = '/admin/?muraAction=cUsers.listUsers&siteid=tenant-a&ispublic=0';
const CSETTINGS = '/admin/?muraAction=cSettings.list';
const SITE_TREE = '/admin/?muraAction=cArch.list&siteid=tenant-a&moduleid=00000000000000000000000000000000000&topid=00000000000000000000000000000000001';
const CSRF_TOKEN = 'FIXTURE-CSRF-0001';
const FEED_CSRF = 'FIXTURE-FEED-CSRF';
const CUTOVER_STATUS = '/internal/v1/cutover/status';
/** The admin login post, whose route key stands for identity's login probe. */
const LOGIN_REQUEST: StepRequest = { method: 'POST', route: '/admin/index.cfm', form: { muraAction: 'cLogin.login' } };
const USAGE = 'usage: tsx src/performance/run.ts';
const LEGACY_MS = 4;
const TARGET_MS = 5;
const ESRCH = errno('ESRCH');
const EPERM = errno('EPERM');
const EINVAL = errno('EINVAL');

const savedArgv = process.argv;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opt2-performance-'));
});

afterEach(async () => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: fixture`), { code });
}

/** Placeholder password for `label`, assembled at run time so no credential-shaped literal sits in the source. */
function credential(label: string): string {
  return ['fixture', label, 'pw'].join('-');
}

interface FakeClock {
  t: number;
  now: () => number;
  sleep: Mock<(ms: number) => Promise<void>>;
}

/** Clock that only `sleep` (and the fakes that model latency) advance. */
function fakeClock(): FakeClock {
  const clock: FakeClock = {
    t: 0,
    now: () => clock.t,
    sleep: vi.fn(async (ms: number) => {
      clock.t += ms;
    }),
  };
  return clock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function html(markup: string, setCookie: readonly string[] = []): Response {
  return new Response(`<!DOCTYPE html><html><body>${markup}</body></html>`, {
    headers: [['content-type', 'text/html; charset=utf-8'], ...setCookie.map((line): [string, string] => ['set-cookie', line])],
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function fakeChild(pid: number | undefined, error?: Error): { child: SpawnedProcess; unref: Mock<() => void> } {
  const unref = vi.fn<() => void>();
  const child: SpawnedProcess = {
    pid,
    unref,
    once: (_event, listener) => {
      if (error !== undefined) setImmediate(() => listener(error));
      return child;
    },
  };
  return { child, unref };
}

function readEntry(set: string): ReadSetEntry {
  const entry = READ_SET.find((candidate) => candidate.set === set);
  if (entry === undefined) throw new Error(`no read set ${set}`);
  return entry;
}

/** Candidate `index` of `service`'s gateway probes, which reads a path. */
function sessionCandidate(service: RestartService, index: number): SessionProbeSpec {
  const spec = GATEWAY_PROBES[service][index];
  if (spec === undefined || !('path' in spec)) throw new Error(`${service} has no path probe ${index}`);
  return spec;
}

function count(items: readonly string[], wanted: string): number {
  return items.filter((item) => item === wanted).length;
}

/** CF-style 35-character id: an 8-character tag, then `n`. */
function cfId(tag: string, n: number): string {
  return `${tag}-0000-0000-${String(n).padStart(16, '0')}`;
}

const PAGE_IDS = [1, 2, 3, 4, 5].map((n) => cfId('0000PAGE', n));
const FOLDER_ID = cfId('00FOLDER', 1);
const IMAGE_ID = cfId('000IMAGE', 1);
const LEFTOVER_FEED_ID = cfId('LEFTOVER', 1);
const NEW_FEED_ID = cfId('0000FEED', 1);

/** Seed dataset whose first tenant-a Pages, Folder and umbrella png are the content reads' seed rows, among others. */
function seedDataset(): unknown {
  return {
    businessDate: '2026-06-30',
    masa: {
      content: [
        { contentID: cfId('0000HOME', 1), siteID: 'tenant-b', type: 'Page' },
        { contentID: FOLDER_ID, siteID: 'tenant-a', type: 'Folder' },
        ...PAGE_IDS.map((contentID) => ({ contentID, siteID: 'tenant-a', type: 'Page' })),
        { contentID: cfId('0000PAGE', 6), siteID: 'tenant-a', type: 'Page' },
      ],
      files: [
        { fileID: cfId('0000FILE', 1), siteID: 'umbrella', fileExt: 'pdf' },
        { fileID: IMAGE_ID, siteID: 'umbrella', fileExt: 'png' },
      ],
    },
  };
}

async function writeFixtureFile(file: string, body: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
}

/** `route` with the content reads' seed placeholders replaced by the seedDataset rows. */
function seededRoute(route: string): string {
  return route
    .replaceAll('${seed.page.contentID}', PAGE_IDS[0] ?? '')
    .replaceAll('${seed.image.fileID}', IMAGE_ID)
    .replaceAll('${seed.feed.contentID}', FOLDER_ID);
}

/** Invoker the cut-over status request uses; the fakes ignore its headers. */
const INVOKER: HarnessInvoker = { headersFor: async () => ({}) };

/** A route key a test's cut-over version sends to target, and the gateway requests that carry it. */
interface TargetRoute {
  route: string;
  owningService: RestartService;
  kind: string;
  carries: (method: string, target: string) => boolean;
}

/** A test's cut-over version and the owner of each gateway request it sends to target; every other route is legacy. */
interface Routing {
  table: CutoverTable;
  ownerOf: (method: string, target: string) => RestartService | undefined;
}

function routing(tableVersion: string, targets: readonly TargetRoute[]): Routing {
  return {
    table: {
      tableVersion,
      entries: targets.map(({ route, owningService, kind }) => ({ route, owningService, state: 'target', kind })),
    },
    ownerOf: (method, target) => targets.find((candidate) => candidate.carries(method, target))?.owningService,
  };
}

/** The admin login post and the user list are target. */
const LOGIN_AND_USERS_TARGET = routing('v9102', [
  {
    route: 'admin:clogin.login',
    owningService: 'identity',
    kind: 'write',
    carries: (method, target) => method === 'POST' && target === LOGIN_POST,
  },
  { route: 'admin:cusers.listusers', owningService: 'people', kind: 'read', carries: (method, target) => method === 'GET' && target === CUSERS },
]);

/** Only the Site Manager tree is target. */
const SITE_TREE_TARGET = routing('v9103', [
  { route: 'admin:carch.list', owningService: 'strategies-content', kind: 'write', carries: (method, target) => method === 'GET' && target === SITE_TREE },
]);

/** Every route is legacy. */
const ALL_LEGACY_ROUTING = routing('v9104', []);

interface FeedSiteOptions {
  /** cFeed.update redirects without creating, as a refused CSRF token does. */
  refuseCreate?: boolean;
  /** The gateway answers 404 for the feed read. */
  unservedOnGateway?: boolean;
  /** cFeed.update redirects without deleting. */
  ignoreDelete?: boolean;
  /** Markup added inside the new collection's form, and after it. */
  newForm?: { inside?: string; after?: string };
}

function feedPage(markup: string): Response {
  return new Response(`<!DOCTYPE html><html><body>${markup}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** The unfilled advanced-filter row cFeed.edit renders for a collection without filters (edit.cfm:512-533). */
const FILTER_ROW = `<select name="paramRelationship1" style="display:none;"><option value="and">And</option><option value="or">Or</option></select>
  <input type="hidden" name="param" value="1" />
  <select name="paramField1"><option value="">Select Field</option><option value="tcontent.title^varchar">Title</option></select>
  <select name="paramCondition1"><option value="Equals">Equals</option><option value="Contains">Contains</option></select>
  <input type="text" name="paramCriteria1">`;

/** What a browser submits for {@link FILTER_ROW}. */
const FILTER_ROW_POST = { paramRelationship1: 'and', param: '1', paramField1: '', paramCondition1: 'Equals', paramCriteria1: '' };

/**
 * The first advanced-filter element admin/Application.cfc:474-488 reads from `fields` without it being defined, which
 * fails the request with 500: per row `param` lists, paramField, then paramCriteria unless the field is unset, then
 * paramRelationship and paramCondition unless the criteria is empty.
 */
function undefinedFilterElement(fields: Readonly<Record<string, string>>): string | undefined {
  for (const n of (fields.param ?? '').split(',').filter((item) => item !== '')) {
    const field = fields[`paramField${n}`];
    if (field === undefined) return `paramField${n}`;
    if (field === '' || field === 'Select Field') continue;
    const criteria = fields[`paramCriteria${n}`];
    if (criteria === undefined) return `paramCriteria${n}`;
    if (criteria === '') continue;
    const unset = ['paramRelationship', 'paramCondition'].find((key) => fields[`${key}${n}`] === undefined);
    if (unset !== undefined) return `${unset}${n}`;
  }
  return undefined;
}

/**
 * Legacy's collection admin and feed read, shared by both origins: a leftover Local and a Remote collection already
 * carry the run's name; each form's CSRF token is valid for its own feedID only; legacy assigns new ids. `posts` holds
 * each cFeed.update form scope as ColdFusion builds it, a repeated name's values joined by commas.
 */
function feedSite(opts: FeedSiteOptions = {}) {
  const feeds = new Map<string, string>([[LEFTOVER_FEED_ID, PERFORMANCE_FEED_NAME]]);
  const posts: Record<string, string>[] = [];
  let created = 0;
  const editLink = (id: string, type: string, text: string) =>
    `<a href="./?muraAction=cFeed.edit&amp;feedID=${id}&amp;siteid=tenant-a&amp;type=${type}">${text}</a>`;
  const list = () =>
    feedPage(
      [...feeds].map(([id, name]) => `<tr><td>${editLink(id, 'Local', 'Edit')}</td><td>${editLink(id, 'Local', name)}</td></tr>`).join('') +
        `<tr><td>${editLink(cfId('00REMOTE', 1), 'Remote', PERFORMANCE_FEED_NAME)}</td></tr><a href="./?muraAction=cFeed.list">List</a>`,
    );
  const form = (id: string) => {
    const extra = id === '' ? (opts.newForm ?? {}) : {};
    return feedPage(`<form novalidate="novalidate" action="./?muraAction=cFeed.update&amp;siteid=tenant-a" method="post" id="feedFrm">
      ${FILTER_ROW}${extra.inside ?? ''}
      <button class="btn mura-primary" onclick="submitForm(document.forms.form1,'add');">Add</button>
      <input type="hidden" name="feedID" value="${id}"><input type="hidden" name="action" value="${id === '' ? 'add' : 'update'}">
      <input type="hidden" name="type" value="Local"><input type="hidden" name="csrf_token" value="${FEED_CSRF}:${id}">
      <input type="hidden" name="csrf_token_expires" value="260630120000000"></form>${extra.after ?? ''}`);
  };

  /** The answer to a collection admin or feed read request, else undefined. */
  function answer(side: 'legacy' | 'gateway', method: string, url: URL, body: string): Response | undefined {
    if (url.pathname === '/_api/feed/v1/') {
      const served = feeds.has(url.searchParams.get('feedid') ?? '') && !(side === 'gateway' && opts.unservedOnGateway === true);
      return served ? new Response('<rss/>', { headers: { 'content-type': 'text/xml;charset=UTF-8' } }) : new Response('Not Found', { status: 404 });
    }
    const action = url.pathname === '/admin/' ? url.searchParams.get('muraAction')?.toLowerCase() : undefined;
    if (method === 'GET' && action === 'cfeed.list') return list();
    if (method === 'GET' && action === 'cfeed.edit') {
      // edit.cfm:78 reads rc.type, which only the URL sets.
      if (!url.searchParams.has('type')) return new Response('Element TYPE is undefined in RC.', { status: 500 });
      return form(url.searchParams.get('feedID') ?? '');
    }
    if (method !== 'POST' || action !== 'cfeed.update') return undefined;
    const params = new URLSearchParams(body);
    const fields = Object.fromEntries([...new Set(params.keys())].map((name) => [name, params.getAll(name).join(',')]));
    posts.push(fields);
    const undefinedElement = undefinedFilterElement(fields);
    if (undefinedElement !== undefined) {
      return new Response(`Element ${undefinedElement.toUpperCase()} is undefined in a CFML structure`, { status: 500 });
    }
    const valid = fields.csrf_token === `${FEED_CSRF}:${fields.feedID ?? ''}`;
    if (valid && fields.action === 'add' && opts.refuseCreate !== true) feeds.set(cfId('0000FEED', ++created), fields.name ?? '');
    if (valid && fields.action === 'delete' && opts.ignoreDelete !== true) feeds.delete(fields.feedID ?? '');
    return new Response(null, { status: 302, headers: { location: './?muraAction=cFeed.list&siteid=tenant-a' } });
  }
  return { feeds, posts, answer };
}

const SAVE_LOCAL_POST = {
  ...FILTER_ROW_POST,
  feedID: '',
  action: 'add',
  type: 'Local',
  csrf_token: `${FEED_CSRF}:`,
  csrf_token_expires: '260630120000000',
  siteid: 'tenant-a',
  name: PERFORMANCE_FEED_NAME,
  isActive: '1',
  isPublic: '1',
  maxItems: '20',
  contentID: FOLDER_ID,
};

function deleteLocalPost(id: string): Record<string, string> {
  return {
    ...FILTER_ROW_POST,
    feedID: id,
    action: 'delete',
    type: 'Local',
    csrf_token: `${FEED_CSRF}:${id}`,
    csrf_token_expires: '260630120000000',
    siteid: 'tenant-a',
  };
}

const LABELS: ReadLabels = {
  set: 'csettings.list',
  source: 'read-set',
  session: 'admin',
  routeKey: 'admin:csettings.list',
  servedBy: 'legacy',
};

function row(labels: ReadLabels, rest: Omit<LatencyRow, keyof ReadLabels>): LatencyRow {
  return { ...labels, ...rest };
}

describe('fixed configuration', () => {
  it('restarts the domain services and expects min_instance_count 0 for every deployed service but migration', () => {
    expect(RESTART_SERVICES).toStrictEqual(['identity', 'people', 'programs-sites', 'strategies-content']);
    expect(Object.keys(GATEWAY_PROBES)).toStrictEqual([...RESTART_SERVICES]);
    expect(EXPECTED_MIN_INSTANCES).toStrictEqual({
      gateway: 0,
      web: 0,
      ...Object.fromEntries(RESTART_SERVICES.map((service) => [service, 0])),
      migration: 1,
    });
  });

  it('reads findMany, the feed, cusers.listusers and csettings.list after the catalogue', () => {
    expect(CONTENT_READS_LABEL).toBe('content-reads');
    expect(READ_SET.map((entry) => entry.set)).toStrictEqual([
      'content-reads.content.findMany',
      'content-reads.feed',
      'cusers.listusers',
      'csettings.list',
    ]);
    expect(READ_SET.filter((entry) => entry.needs === 'feedId').map((entry) => entry.set)).toStrictEqual(['content-reads.feed']);
  });
});

describe('expandCatalogueReads', () => {
  /** Content-reads-shaped steps: two sessions by three paths, one with a query string, substituted into the route. */
  const BUILT: Pick<Scenario, 'id' | 'sessions' | 'steps'> = {
    id: CONTENT_READS_LABEL,
    sessions: { anon: { login: 'none', via: 'public' }, admin: { login: 'admin', via: 'admin' } },
    steps: [
      {
        name: 'reads',
        method: 'GET',
        route: '/_api/json/v1/tenant-a/${matrix.path}',
        as: '${matrix.session}',
        csrf: 'none',
        matrix: {
          session: ['anon', 'admin'],
          path: ['content/${seed.page.contentID}', 'content/?title=GS&type=Page', 'contentnav/${seed.page.contentID}'],
        },
      },
    ],
  };

  type Reads = ReturnType<typeof expandCatalogueReads>;
  const read = (session: string, route: string): Reads[number] => ({ set: `content-reads:${session} ${route}`, source: 'catalogue', session, route });

  it.each<{ label: string; scenario: Pick<Scenario, 'id' | 'sessions' | 'steps'>; expected: Reads }>([
    {
      label: 'names each read <scenario>:<session> <route>, every path for the first session and then for the second, seeds kept',
      scenario: BUILT,
      expected: [
        read('anon', '/_api/json/v1/tenant-a/content/${seed.page.contentID}'),
        read('anon', '/_api/json/v1/tenant-a/content/?title=GS&type=Page'),
        read('anon', '/_api/json/v1/tenant-a/contentnav/${seed.page.contentID}'),
        read('admin', '/_api/json/v1/tenant-a/content/${seed.page.contentID}'),
        read('admin', '/_api/json/v1/tenant-a/content/?title=GS&type=Page'),
        read('admin', '/_api/json/v1/tenant-a/contentnav/${seed.page.contentID}'),
      ],
    },
    {
      label: 'runs a step without a matrix once, in the only declared session when it names none',
      scenario: {
        id: 'GS-XX-01',
        sessions: { only: { login: 'none', via: 'public' } },
        steps: [{ name: 'one', method: 'GET', route: '/a', csrf: 'none' }],
      },
      expected: [{ set: 'gs-xx-01:only /a', source: 'catalogue', session: 'only', route: '/a' }],
    },
  ])('$label', ({ scenario, expected }) => {
    expect(expandCatalogueReads(scenario)).toStrictEqual(expected);
  });

  it('expands the content reads into one catalogue read per combination of their matrix, each in a declared session', () => {
    const reads = expandCatalogueReads(CONTENT_READS);
    const combinations = CONTENT_READS.steps.reduce(
      (sum, step) => sum + Object.values(step.matrix ?? {}).reduce((product, values) => product * values.length, 1),
      0,
    );
    expect(combinations).toBeGreaterThan(0);
    expect(reads).toHaveLength(combinations);
    for (const entry of reads) {
      expect(entry).toStrictEqual(read(entry.session, entry.route));
      expect(Object.keys(CONTENT_READS.sessions)).toContain(entry.session);
    }
    expect(new Set(reads.map((entry) => entry.set)).size).toBe(reads.length);
  });

  it.each<[string, Partial<Step>]>([
    ['a POST', { method: 'POST' }],
    ['an auth mode', { auth: 'anonymous' }],
    ['CSRF tokens', { csrf: 'json-api:x' }],
    ['headers', { headers: { accept: 'text/html' } }],
    ['a form', { form: { a: 'b' } }],
    ['a JSON body', { body: { a: 1 } }],
    ['a multipart body', { multipart: { fields: {}, files: [{ field: 'f', fixture: 'png', filename: 'a.png', contentType: 'image/png' }] } }],
    ['capture candidates', { candidates: [{ method: 'GET', route: '/b' }] }],
  ])('throws GoldenConfigError for a step with %s', (_label, change) => {
    const step = { ...(BUILT.steps[0] as Step), ...change };
    expect(() => expandCatalogueReads({ ...BUILT, steps: [step] })).toThrow(
      new GoldenConfigError('content-reads step reads is not a plain GET, so it cannot be timed as sent'),
    );
  });
});

describe('seededPageIds', () => {
  it('reads the content ids of the first five tenant-a Pages of the seed dataset', async () => {
    const datasetPath = path.join(tmp, 'dataset.json');
    await writeFixtureFile(datasetPath, seedDataset());
    expect(seededPageIds(loadSeedStore({}, { datasetPath }))).toStrictEqual(PAGE_IDS);
  });

  it.each([
    ['fewer than five tenant-a Pages', [{ contentID: 'c1', siteID: 'tenant-a', type: 'Page' }], GoldenConfigError],
    ['a Page without a content id', Array.from({ length: 5 }, () => ({ siteID: 'tenant-a', type: 'Page' })), Error],
  ])('throws for a dataset with %s', async (_label, content, error) => {
    const datasetPath = path.join(tmp, 'dataset.json');
    await writeFixtureFile(datasetPath, { businessDate: '2026-06-30', masa: { content } });
    expect(() => seededPageIds(loadSeedStore({}, { datasetPath }))).toThrow(error);
  });
});

describe('serving side', () => {
  const TARGET_FIND_ONE: CutoverTable = {
    tableVersion: 'v9999',
    entries: [{ route: 'api:content.findone', owningService: 'strategies-content', state: 'target', kind: 'read' }],
  };
  const LEGACY_ENTRIES: CutoverTable = {
    tableVersion: 'v9999',
    entries: [
      { route: 'api:content.findone', owningService: 'strategies-content', state: 'legacy', kind: 'read' },
      { route: 'feed:v1', owningService: 'strategies-content', state: 'legacy', kind: 'read' },
      { route: 'admin:clogin.login', owningService: 'identity', state: 'legacy', kind: 'write' },
    ],
  };

  it.each<[string, CutoverTable, Parameters<typeof servingSide>[1], ReturnType<typeof servingSide>]>([
    ['a content read a legacy entry holds', LEGACY_ENTRIES, { method: 'GET', route: `/_api/json/v1/tenant-a/content/${PAGE_IDS[0]}` }, { routeKey: 'api:content.findone', servedBy: 'legacy' }],
    ['the feed read a legacy entry holds', LEGACY_ENTRIES, { method: 'GET', route: feedReadPath(NEW_FEED_ID) }, { routeKey: 'feed:v1', servedBy: 'legacy' }],
    ['the Site Manager tree a target entry holds', SITE_TREE_TARGET.table, { method: 'GET', route: SITE_TREE }, { routeKey: 'admin:carch.list', servedBy: 'target' }],
    ['the admin login form post a legacy entry holds', LEGACY_ENTRIES, LOGIN_REQUEST, { routeKey: 'admin:clogin.login', servedBy: 'legacy' }],
    ['a content read a table routes to target', TARGET_FIND_ONE, { method: 'GET', route: `/_api/json/v1/tenant-a/content/${PAGE_IDS[0]}` }, { routeKey: 'api:content.findone', servedBy: 'target' }],
    ['a key no entry matches', TARGET_FIND_ONE, { method: 'GET', route: CSETTINGS }, { routeKey: 'admin:csettings.list', servedBy: 'legacy' }],
  ])('resolves %s', (_label, table, request, expected) => {
    expect(servingSide(table, request)).toStrictEqual(expected);
  });

  it('loads the committed v0002, which holds an entry for the route key of every probe and read-set request', async () => {
    const routes = (await loadCutoverTable('v0002', {})).entries.map((entry) => entry.route);
    const values = { ids: PAGE_IDS, feedId: NEW_FEED_ID };
    const requests: StepRequest[] = [
      ...READ_SET.map((entry): StepRequest => ({ method: 'GET', route: resolveReadPath(entry, values) })),
      ...Object.values(GATEWAY_PROBES)
        .flat()
        .map((spec): StepRequest => ('login' in spec ? LOGIN_REQUEST : { method: 'GET', route: resolveReadPath(spec, values) })),
    ];
    for (const request of requests) {
      const result = coverageRouteResults(request)[0] as RouteKeyResult;
      expect(matchRouteKey(result, routes), `${request.method} ${request.route} (${result.key})`).toBeDefined();
    }
  });

  it.each<[ReadLabels['servedBy'], Finding[]]>([
    [
      'legacy',
      [
        {
          kind: 'legacy-served',
          subject: 'csettings.list',
          detail: 'admin:csettings.list is legacy-routed in v0002: the target columns measure the gateway proxying to legacy',
        },
      ],
    ],
    ['target', []],
  ])('raises legacy-served for a %s-served row only', (servedBy, expected) => {
    expect(legacyServedFindings({ ...LABELS, servedBy }, 'v0002')).toStrictEqual(expected);
  });

  it('reads a version from OPT2_CUTOVER_DIR and rejects one naming another tableVersion or off its schema', async () => {
    const dir = path.join(tmp, 'cutover');
    await writeFixtureFile(path.join(dir, 'versions', 'v9999.json'), TARGET_FIND_ONE);
    await writeFixtureFile(path.join(dir, 'versions', 'v9998.json'), TARGET_FIND_ONE);
    await writeFixtureFile(path.join(dir, 'versions', 'v9997.json'), { tableVersion: 'v9997', entries: [{ route: 'x' }] });
    const env = { OPT2_CUTOVER_DIR: dir };
    await expect(loadCutoverTable('v9999', env)).resolves.toStrictEqual(TARGET_FIND_ONE);
    await expect(loadCutoverTable('v9998', env)).rejects.toThrow('tableVersion v9999 is not v9998');
    await expect(loadCutoverTable('v9997', env)).rejects.toThrow('v9997.json: does not match its schema');
  });
});

describe('chooseProbe', () => {
  const ALL_LEGACY: CutoverTable = { tableVersion: 'v9999', entries: [] };
  const LOGIN = LOGIN_AND_USERS_TARGET.table;
  const TREE = SITE_TREE_TARGET.table;
  const FIND_ONE_TARGET: CutoverTable = {
    tableVersion: 'v9999',
    entries: [
      { route: 'api:content.findone', owningService: 'strategies-content', state: 'target', kind: 'read' },
      { route: 'admin:carch.list', owningService: 'strategies-content', state: 'target', kind: 'write' },
    ],
  };
  const FIND_ONE_KEY = 'api:content.findone';
  const TREE_KEY = 'admin:carch.list';

  it.each<[RestartService, string, CutoverTable, ProbeChoice]>([
    ['identity', 'its login target', LOGIN, { kind: 'own', spec: { login: true }, routeKey: 'admin:clogin.login' }],
    ['identity', 'every route legacy', ALL_LEGACY, { kind: 'not-target', routeKeys: ['admin:clogin.login'] }],
    ['identity', 'only the Site Manager tree target', TREE, { kind: 'fresh-session', via: 'strategies-content', spec: sessionCandidate('strategies-content', 1), routeKey: TREE_KEY }],
    ['people', 'its user list target', LOGIN, { kind: 'own', spec: GATEWAY_PROBES.people[0], routeKey: 'admin:cusers.listusers' }],
    ['people', 'every route legacy', ALL_LEGACY, { kind: 'not-target', routeKeys: ['admin:cusers.listusers'] }],
    ['programs-sites', 'every route legacy', ALL_LEGACY, { kind: 'not-target', routeKeys: ['admin:csettings.list'] }],
    ['strategies-content', 'its content read target', FIND_ONE_TARGET, { kind: 'own', spec: sessionCandidate('strategies-content', 0), routeKey: FIND_ONE_KEY }],
    ['strategies-content', 'only the Site Manager tree target', TREE, { kind: 'own', spec: sessionCandidate('strategies-content', 1), routeKey: TREE_KEY }],
    ['strategies-content', 'every route legacy', ALL_LEGACY, { kind: 'not-target', routeKeys: [FIND_ONE_KEY, TREE_KEY] }],
  ])('chooses for %s with %s', (service, _label, table, expected) => {
    expect(chooseProbe(service, table)).toStrictEqual(expected);
  });

  it.each<[string, string, string[], string]>([
    ['one key', 'people', ['admin:cusers.listusers'], 'admin:cusers.listusers is legacy-routed in v0002, so no gateway read reaches people'],
    [
      'two keys',
      'strategies-content',
      [FIND_ONE_KEY, TREE_KEY],
      'api:content.findone and admin:carch.list are legacy-routed in v0002, so no gateway read reaches strategies-content',
    ],
    ['three keys', 'x', ['a:1', 'a:2', 'a:3'], 'a:1, a:2 and a:3 are legacy-routed in v0002, so no gateway read reaches x'],
  ])('names %s in the probe-not-target detail', (_label, service, routeKeys, detail) => {
    expect(notTargetDetail(service, routeKeys, 'v0002')).toBe(detail);
  });
});

describe('percentile', () => {
  const SAMPLES = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];

  it.each([
    [0, 1],
    [10, 1],
    [11, 2],
    [50, 5],
    [95, 10],
    [100, 10],
    [150, 10],
  ])('takes the nearest-rank sample at q=%i', (q, expected) => {
    expect(percentile(SAMPLES, q)).toBe(expected);
  });

  it('leaves the samples in their original order', () => {
    const samples = [3, 1, 2];
    percentile(samples, 50);
    expect(samples).toStrictEqual([3, 1, 2]);
  });

  it('throws a RangeError for an empty sample set', () => {
    expect(() => percentile([], 50)).toThrow(new RangeError('percentile of an empty sample set'));
  });
});

describe('summariseSamples', () => {
  it('rounds p50 and p95 to 0.1 ms', () => {
    expect(summariseSamples([0.26, 0.14])).toStrictEqual({ p50Ms: 0.1, p95Ms: 0.3 });
  });

  it('throws for an empty sample set', () => {
    expect(() => summariseSamples([])).toThrow(RangeError);
  });
});

describe('ratioFinding', () => {
  it.each([
    { target: 30, legacy: 20, ratioP95: 1.5, finding: null },
    { target: 31, legacy: 20, ratioP95: 1.55, finding: 'target p95 31 ms is 1.55x legacy p95 20 ms (above 1.5x)' },
    { target: 150.1, legacy: 100, ratioP95: 1.5, finding: 'target p95 150.1 ms is 1.5x legacy p95 100 ms (above 1.5x)' },
    { target: 2.1, legacy: 1.4, ratioP95: 1.5, finding: null },
    { target: 4.2, legacy: 2.8, ratioP95: 1.5, finding: null },
    { target: 20, legacy: 3, ratioP95: 6.67, finding: 'target p95 20 ms is 6.67x legacy p95 3 ms (above 1.5x)' },
    { target: 4, legacy: 8, ratioP95: 0.5, finding: null },
    { target: 12, legacy: 0, ratioP95: null, finding: null },
  ])('gives ratio $ratioP95 for target p95 $target ms over legacy p95 $legacy ms', ({ target, legacy, ratioP95, finding }) => {
    expect(ratioFinding({ p50Ms: 1, p95Ms: target }, { p50Ms: 1, p95Ms: legacy })).toStrictEqual({ ratioP95, finding });
  });
});

describe('resolveReadPath', () => {
  const VALUES = { ids: ['c 1', 'c/2'], feedId: 'feed&1' };

  it.each([
    ['content-reads.content.findMany', '/_api/json/v1/tenant-a/content/c%201,c%2F2'],
    ['content-reads.feed', '/_api/feed/v1/?feedid=feed%261&siteid=tenant-a'],
    ['cusers.listusers', CUSERS],
    ['csettings.list', CSETTINGS],
  ])('fills the encoded placeholders of %s', (set, expected) => {
    expect(resolveReadPath(readEntry(set), VALUES)).toBe(expected);
  });

  it('reads the RSS feed of collection feedId by id and site', () => {
    expect(feedReadPath('f 1')).toBe('/_api/feed/v1/?feedid=f%201&siteid=tenant-a');
  });
});

describe('feed collection lifecycle', () => {
  function feedRig(opts: FeedSiteOptions = {}) {
    const site = feedSite(opts);
    const clock = fakeClock();
    const requests: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? 'GET';
      requests.push(`${method} ${url.origin}${url.pathname}${url.search}`);
      const side = url.origin === LEGACY ? 'legacy' : 'gateway';
      const answered = site.answer(side, method, url, typeof init.body === 'string' ? init.body : '');
      if (answered === undefined) throw new Error(`unscripted request ${method} ${input}`);
      return answered;
    };
    const deps: FeedDeps = {
      admin: createHttpSession({ baseUrl: GATEWAY, fetch }),
      readers: { legacy: createHttpSession({ baseUrl: LEGACY, fetch }), target: createHttpSession({ baseUrl: GATEWAY, fetch }) },
      now: clock.now,
      sleep: clock.sleep,
    };
    return { site, clock, requests, deps };
  }

  it('creates the collection through the gateway cFeed form, confirms it on both sides, and deletes it', async () => {
    const rig = feedRig();
    await expect(createFeedCollection(rig.deps, FOLDER_ID)).resolves.toBe(NEW_FEED_ID);
    expect(rig.site.posts).toStrictEqual([SAVE_LOCAL_POST]);
    const read = feedReadPath(NEW_FEED_ID);
    expect(rig.requests).toStrictEqual([
      `GET ${GATEWAY}/admin/?muraAction=cFeed.list&siteid=tenant-a`,
      `GET ${GATEWAY}/admin/?muraAction=cFeed.edit&siteid=tenant-a&feedID=&type=Local`,
      `POST ${GATEWAY}/admin/?muraAction=cFeed.update&siteid=tenant-a`,
      `GET ${GATEWAY}/admin/?muraAction=cFeed.list&siteid=tenant-a`,
      `GET ${LEGACY}${read}`,
      `GET ${GATEWAY}${read}`,
    ]);

    await deleteFeedCollection(rig.deps, NEW_FEED_ID);
    expect(rig.site.posts.at(-1)).toStrictEqual(deleteLocalPost(NEW_FEED_ID));
    expect([...rig.site.feeds.keys()]).toStrictEqual([LEFTOVER_FEED_ID]);
    expect(rig.requests.slice(6)).toStrictEqual([
      `GET ${GATEWAY}/admin/?muraAction=cFeed.edit&siteid=tenant-a&feedID=${NEW_FEED_ID}&type=Local`,
      `POST ${GATEWAY}/admin/?muraAction=cFeed.update&siteid=tenant-a`,
      `GET ${GATEWAY}/admin/?muraAction=cFeed.list&siteid=tenant-a`,
      `GET ${LEGACY}${read}`,
    ]);
    expect(rig.clock.sleep).not.toHaveBeenCalled();
  });

  it.each<{ label: string; opts: FeedSiteOptions; message: string; posts: Record<string, string>[]; feeds: string[] }>([
    {
      label: 'lists no new collection after the save',
      opts: { refuseCreate: true },
      message: `cFeed.update listed no new ${PERFORMANCE_FEED_NAME} collection (status 200 at /admin/)`,
      posts: [SAVE_LOCAL_POST],
      feeds: [LEFTOVER_FEED_ID],
    },
    {
      label: 'answers 500 to a filter row whose disabled field a browser does not submit',
      opts: {
        newForm: {
          inside: '<input type="hidden" name="param" value="2"><select name="paramField2" disabled><option value="">Select Field</option></select>',
        },
      },
      message: `cFeed.update listed no new ${PERFORMANCE_FEED_NAME} collection (status 500 at /admin/)`,
      posts: [{ ...SAVE_LOCAL_POST, param: '1,2' }],
      feeds: [LEFTOVER_FEED_ID],
    },
    {
      label: 'never serves the read through the gateway, after deleting the collection',
      opts: { unservedOnGateway: true },
      message: `GET ${feedReadPath(NEW_FEED_ID)} did not answer 200 on both sides within ${POLL_LIMIT_MS} ms`,
      posts: [SAVE_LOCAL_POST, deleteLocalPost(NEW_FEED_ID)],
      feeds: [LEFTOVER_FEED_ID],
    },
    {
      label: 'never serves the read through the gateway, and the deletion fails too',
      opts: { unservedOnGateway: true, ignoreDelete: true },
      message:
        `GET ${feedReadPath(NEW_FEED_ID)} did not answer 200 on both sides within ${POLL_LIMIT_MS} ms; deleting collection ` +
        `${NEW_FEED_ID} failed: GET ${feedReadPath(NEW_FEED_ID)} still answered 200 on legacy ${POLL_LIMIT_MS} ms after ` +
        `deleting collection ${NEW_FEED_ID}`,
      posts: [SAVE_LOCAL_POST, deleteLocalPost(NEW_FEED_ID)],
      feeds: [LEFTOVER_FEED_ID, NEW_FEED_ID],
    },
  ])('throws when legacy $label', async ({ opts, message, posts, feeds }) => {
    const rig = feedRig(opts);
    await expect(createFeedCollection(rig.deps, FOLDER_ID)).rejects.toThrow(message);
    expect(rig.site.posts).toStrictEqual(posts);
    expect([...rig.site.feeds.keys()]).toStrictEqual(feeds);
  });

  it("answers 500 without creating when a save carries only the form's hidden fields, as legacy does", async () => {
    const rig = feedRig();
    const page = await rig.deps.admin.get('/admin/?muraAction=cFeed.edit&siteid=tenant-a&feedID=&type=Local');
    const form = formTokensFrom(rig.deps.admin, page);
    const saved = await rig.deps.admin.post(form.action, {
      form: { ...form.fields, csrf_token: form.token, csrf_token_expires: form.expires, name: PERFORMANCE_FEED_NAME },
    });
    expect(saved.status).toBe(500);
    expect(saved.text).toBe('Element PARAMFIELD1 is undefined in a CFML structure');
    expect([...rig.site.feeds.keys()]).toStrictEqual([LEFTOVER_FEED_ID]);
  });

  it.each<{ label: string; newForm: NonNullable<FeedSiteOptions['newForm']>; sent: Record<string, string> }>([
    {
      label: 'a checked checkbox sends its value, or on without one, and an unchecked one nothing',
      newForm: {
        inside: `<input type="checkbox" name="categoryID" value="c-1" checked><input type="checkbox" name="categoryID" value="c-2">
          <input type="checkbox" name="categoryID" value="c-3" checked><input type="CHECKBOX" name="restricted" checked>
          <input type="checkbox" name="unticked" value="1">`,
      },
      sent: { categoryID: 'c-1,c-3', restricted: 'on' },
    },
    {
      label: 'a checked radio sends its value and an unchecked one nothing',
      newForm: {
        inside: `<input type="radio" name="isFeaturesOnly" value="1"><input type="radio" name="isFeaturesOnly" value="0" checked>
          <input type="radio" name="unpicked" value="1">`,
      },
      sent: { isFeaturesOnly: '0' },
    },
    {
      label: 'a drop-down sends its last selected option, else its first enabled one, by value or else collapsed text',
      newForm: {
        inside: `<select name="sortBy"><option value="lastUpdate">Last</option><option value="title" selected>Title</option>
          <option value="menuTitle" selected>Menu</option></select>
          <select name="version"><option disabled>RSS 0.920</option><option>\n  RSS\t2.0 </option></select>
          <select name="offOnly"><option value="x" disabled selected>X</option><option value="y">Y</option></select>
          <select name="empty"></select>`,
      },
      sent: { sortBy: 'menuTitle', version: 'RSS 2.0' },
    },
    {
      label: 'a multiple select sends every selected enabled option, and a list box none unselected',
      newForm: {
        inside: `<select name="contentPoolID" multiple><option value="tenant-a" selected>A</option><option value="tenant-b">B</option>
          <option value="umbrella" selected>U</option><optgroup label="Off" disabled><option value="c" selected>C</option></optgroup></select>
          <select name="restrictgroups" size="8" multiple="multiple"><option value="RestrictAll">Restrict all</option></select>
          <select name="listBox" size="4"><option value="a">A</option></select>`,
      },
      sent: { contentPoolID: 'tenant-a,umbrella' },
    },
    {
      label: 'a textarea sends its text with CRLF line breaks',
      newForm: { inside: '<textarea name="description">\nFirst line\nsecond &amp; last</textarea>' },
      sent: { description: 'First line\r\nsecond & last' },
    },
    {
      label: 'a text input sends its value, or empty without one, and buttons, files and disabled controls nothing',
      newForm: {
        inside: `<input name="lang" value="en-us"><input type="TEXT" name="cssclass"><input name="" value="unnamed">
          <input type="submit" name="go" value="Go"><input type="image" name="map" src="map.png"><input type="reset" name="clear">
          <input type="button" name="press" value="Press"><input type="file" name="upload"><button name="btn" value="b">B</button>
          <input name="locked" value="1" disabled>
          <fieldset disabled><legend><input name="inLegend" value="kept"></legend><input name="inFieldset" value="dropped"></fieldset>`,
      },
      sent: { lang: 'en-us', cssclass: '', inLegend: 'kept' },
    },
    {
      label: 'a control belongs to the form its form attribute names, else to its enclosing form',
      newForm: {
        inside: '<input name="elsewhere" value="1" form="otherFrm">',
        after: '<input name="outside" value="1"><input name="owned" value="1" form="feedFrm"><form id="otherFrm"><input name="other"></form>',
      },
      sent: { owned: '1' },
    },
    {
      label: "a second filter row repeats param, and the run's own fields replace every control of their names",
      newForm: {
        inside: `<select name="paramRelationship2"><option value="and">And</option><option value="or" selected>Or</option></select>
          <input type="hidden" name="param" value="2">
          <select name="paramField2"><option value="">Select Field</option><option value="tcontent.title^varchar" selected>Title</option></select>
          <select name="paramCondition2"><option value="Equals">Equals</option><option value="Contains" selected>Contains</option></select>
          <input type="text" name="paramCriteria2" value="GS">
          <input type="hidden" name="maxItems" value="5"><select name="maxItems"><option>7</option></select><input name="name" value="typed">`,
      },
      sent: { param: '1,2', paramRelationship2: 'or', paramField2: 'tcontent.title^varchar', paramCondition2: 'Contains', paramCriteria2: 'GS' },
    },
  ])('posts the edit form as a browser submits it: $label', async ({ newForm, sent }) => {
    const rig = feedRig({ newForm });
    await expect(createFeedCollection(rig.deps, FOLDER_ID)).resolves.toBe(NEW_FEED_ID);
    expect(rig.site.posts).toStrictEqual([{ ...SAVE_LOCAL_POST, ...sent }]);
  });

  it('throws when legacy still serves the read POLL_LIMIT_MS after the deletion', async () => {
    const rig = feedRig({ ignoreDelete: true });
    await createFeedCollection(rig.deps, FOLDER_ID);
    await expect(deleteFeedCollection(rig.deps, NEW_FEED_ID)).rejects.toThrow(
      `GET ${feedReadPath(NEW_FEED_ID)} still answered 200 on legacy ${POLL_LIMIT_MS} ms after deleting collection ${NEW_FEED_ID}`,
    );
    expect(rig.clock.t).toBe(POLL_LIMIT_MS);
  });
});

describe('measureLatencySet', () => {
  /** Session whose every request takes the next scripted duration on `clock` and answers its status. */
  function timedSession(
    side: string,
    clock: FakeClock,
    script: readonly (readonly [ms: number, status: number])[],
    log: string[],
  ): HttpSession {
    const pending = [...script];
    const fetch: FetchLike = async (input) => {
      const next = pending.shift();
      if (next === undefined) throw new Error(`unscripted ${side} request ${input}`);
      log.push(`${side} ${new URL(input).pathname}${new URL(input).search}`);
      clock.t += next[0];
      return new Response('{}', { status: next[1] });
    };
    return createHttpSession({ baseUrl: side === 'legacy' ? LEGACY : GATEWAY, fetch });
  }

  it('requests each side in turn, legacy first, and summarises the time to each read body', async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const ok = (ms: number) => [ms, 200] as const;
    const legacy = timedSession('legacy', clock, [10, 20, 30, 40].map(ok), log);
    const target = timedSession('target', clock, [15, 25, 35, 45].map(ok), log);
    const measured = await measureLatencySet({ ...LABELS, path: CSETTINGS }, { legacy, target }, { requests: 4, now: clock.now });
    expect(log).toStrictEqual(Array.from({ length: 4 }, () => [`legacy ${CSETTINGS}`, `target ${CSETTINGS}`]).flat());
    expect(measured).toStrictEqual({
      row: row(LABELS, {
        requests: 4,
        legacy: { p50Ms: 20, p95Ms: 40 },
        target: { p50Ms: 25, p95Ms: 45 },
        statuses: { legacy: [200], target: [200] },
        ratioP95: 1.13,
        finding: null,
      }),
      findings: [],
    });
  });

  it('raises a latency-ratio finding, per side one non-ok-response listing its distinct statuses, and status-mismatch', async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const legacy = timedSession('legacy', clock, [[10, 200], [10, 500], [10, 200]], log);
    const target = timedSession('target', clock, [[40, 500], [40, 404], [40, 404]], log);
    const labels: ReadLabels = { ...LABELS, set: 'cusers.listusers', routeKey: 'admin:cusers.listusers' };
    const measured = await measureLatencySet({ ...labels, path: CUSERS }, { legacy, target }, { requests: 3, now: clock.now });
    const finding = 'target p95 40 ms is 4x legacy p95 10 ms (above 1.5x)';
    expect(measured.row).toStrictEqual(
      row(labels, {
        requests: 3,
        legacy: { p50Ms: 10, p95Ms: 10 },
        target: { p50Ms: 40, p95Ms: 40 },
        statuses: { legacy: [200, 500], target: [404, 500] },
        ratioP95: 4,
        finding,
      }),
    );
    expect(measured.findings).toStrictEqual([
      { kind: 'latency-ratio', subject: 'cusers.listusers', detail: finding },
      { kind: 'non-ok-response', subject: 'cusers.listusers/legacy', detail: '1 of 3: 500' },
      { kind: 'non-ok-response', subject: 'cusers.listusers/target', detail: '3 of 3: 404, 500' },
      { kind: 'status-mismatch', subject: 'cusers.listusers', detail: 'legacy answered 200, 500; target answered 404, 500' },
    ]);
  });

  it.each<{ legacy: number[]; target: number[]; mismatch: string | null }>([
    { legacy: [401, 401], target: [401, 401], mismatch: null },
    { legacy: [500, 200], target: [200, 500], mismatch: null },
    { legacy: [200, 200], target: [200, 403], mismatch: 'legacy answered 200; target answered 200, 403' },
    { legacy: [401, 401], target: [200, 200], mismatch: 'legacy answered 401; target answered 200' },
  ])('compares the distinct statuses $legacy on legacy with $target on target', async ({ legacy, target, mismatch }) => {
    const clock = fakeClock();
    const log: string[] = [];
    const measured = await measureLatencySet(
      { ...LABELS, path: CSETTINGS },
      {
        legacy: timedSession('legacy', clock, legacy.map((status) => [1, status] as const), log),
        target: timedSession('target', clock, target.map((status) => [1, status] as const), log),
      },
      { requests: 2, now: clock.now },
    );
    expect(measured.findings.filter((finding) => finding.kind === 'status-mismatch')).toStrictEqual(
      mismatch === null ? [] : [{ kind: 'status-mismatch', subject: LABELS.set, detail: mismatch }],
    );
  });
});

describe('stopProcess', () => {
  const PID = PID_BASE + 1;

  /** Kill stub recording every call; `answer` returns to accept a signal or throws to refuse it. */
  function scriptedKill(answer: (pid: number, signal: NodeJS.Signals | 0) => void): {
    kill: KillLike;
    calls: [number, NodeJS.Signals | 0][];
  } {
    const calls: [number, NodeJS.Signals | 0][] = [];
    const kill: KillLike = (pid, signal) => {
      calls.push([pid, signal]);
      answer(pid, signal);
      return true;
    };
    return { kill, calls };
  }

  it('SIGTERMs the process group and polls every STOP_POLL_MS until the group is gone', async () => {
    const clock = fakeClock();
    let probes = 0;
    const { kill, calls } = scriptedKill((_pid, signal) => {
      if (signal === 0 && ++probes > 2) throw ESRCH;
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(calls).toStrictEqual([
      [-PID, 'SIGTERM'],
      [-PID, 0],
      [-PID, 0],
      [-PID, 0],
    ]);
    expect(clock.sleep.mock.calls).toStrictEqual([[STOP_POLL_MS], [STOP_POLL_MS]]);
  });

  it.each(['ESRCH', 'EPERM'])('signals and polls the pid alone when signalling the group fails with %s', async (code) => {
    const clock = fakeClock();
    const { kill, calls } = scriptedKill((pid, signal) => {
      if (pid < 0) throw errno(code);
      if (signal === 0) throw ESRCH;
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(calls).toStrictEqual([
      [-PID, 'SIGTERM'],
      [PID, 'SIGTERM'],
      [PID, 0],
    ]);
  });

  it('returns without polling when neither the group nor the pid exists', async () => {
    const clock = fakeClock();
    const { kill, calls } = scriptedKill(() => {
      throw ESRCH;
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(calls).toStrictEqual([
      [-PID, 'SIGTERM'],
      [PID, 'SIGTERM'],
    ]);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('keeps polling while the liveness probe answers EPERM', async () => {
    const clock = fakeClock();
    let probes = 0;
    const { kill, calls } = scriptedKill((_pid, signal) => {
      if (signal === 0) throw ++probes === 1 ? EPERM : ESRCH;
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(calls).toStrictEqual([
      [-PID, 'SIGTERM'],
      [-PID, 0],
      [-PID, 0],
    ]);
    expect(clock.sleep.mock.calls).toStrictEqual([[STOP_POLL_MS]]);
  });

  it.each([
    ['succeeds', () => undefined],
    ['finds the group already gone', () => {
      throw ESRCH;
    }],
  ])('sends one SIGKILL STOP_KILL_AFTER_MS after SIGTERM and returns once the group exits, when the SIGKILL %s', async (_label, onKill) => {
    const clock = fakeClock();
    let killedAt: number | undefined;
    const { kill, calls } = scriptedKill((_pid, signal) => {
      if (signal === 'SIGKILL') {
        killedAt = clock.t;
        onKill();
      } else if (signal === 0 && killedAt !== undefined) {
        throw ESRCH;
      }
    });
    await stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep });
    expect(killedAt).toBe(STOP_KILL_AFTER_MS);
    expect(calls.filter(([, signal]) => signal === 'SIGKILL')).toStrictEqual([[-PID, 'SIGKILL']]);
    expect(clock.t).toBe(STOP_KILL_AFTER_MS + STOP_POLL_MS);
  });

  it('throws when the group still runs POLL_LIMIT_MS after SIGTERM, having sent SIGKILL once', async () => {
    const clock = fakeClock();
    const { kill, calls } = scriptedKill(() => undefined);
    await expect(stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep })).rejects.toThrow(
      `pid ${PID} still running ${POLL_LIMIT_MS} ms after SIGTERM`,
    );
    expect(calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    expect(clock.t).toBe(POLL_LIMIT_MS);
  });

  it.each<{ label: string; thrown: unknown; answer: (pid: number, signal: NodeJS.Signals | 0) => void }>([
    {
      label: 'signalling the group fails with EINVAL',
      thrown: EINVAL,
      answer: (pid) => {
        if (pid < 0) throw EINVAL;
      },
    },
    {
      label: 'signalling the group throws a value without an errno code',
      thrown: 'kill refused',
      answer: (pid) => {
        if (pid < 0) throw 'kill refused';
      },
    },
    {
      label: 'signalling the pid fails with EPERM after the group is gone',
      thrown: EPERM,
      answer: (pid) => {
        throw pid < 0 ? ESRCH : EPERM;
      },
    },
    {
      label: 'the liveness probe fails with EINVAL',
      thrown: EINVAL,
      answer: (_pid, signal) => {
        if (signal === 0) throw EINVAL;
      },
    },
    {
      label: 'SIGKILL fails with EPERM',
      thrown: EPERM,
      answer: (_pid, signal) => {
        if (signal === 'SIGKILL') throw EPERM;
      },
    },
  ])('rethrows when $label', async ({ thrown, answer }) => {
    const clock = fakeClock();
    const { kill } = scriptedKill(answer);
    await expect(stopProcess({ pid: PID }, { kill, now: clock.now, sleep: clock.sleep })).rejects.toBe(thrown);
  });
});

describe('startProcess', () => {
  const OLD = PID_BASE + 10;
  const NEW = PID_BASE + 20;
  const NEW_START = '424242';

  function deps(
    spawn: SpawnLike,
    startTimeOf: (pid: number) => string | undefined = () => NEW_START,
  ): {
    spawn: Mock<SpawnLike>;
    writeUpState: Mock<(patch: UpStatePatch) => unknown>;
    startTimeOf: Mock<(pid: number) => string | undefined>;
  } {
    return {
      spawn: vi.fn<SpawnLike>(spawn),
      writeUpState: vi.fn<(patch: UpStatePatch) => unknown>(),
      startTimeOf: vi.fn<(pid: number) => string | undefined>(startTimeOf),
    };
  }

  it.each<[string, UpProcessEntry['command'], string, string[]]>([
    ['an argv as is', ['node', 'dist/server.js', '--flag'], 'node', ['dist/server.js', '--flag']],
    ['a string through /bin/sh -c', 'npm run start -- --flag', '/bin/sh', ['-c', 'npm run start -- --flag']],
  ])('spawns %s, detached in the entry cwd with its env and output ignored, and records the new pid', async (_label, command, file, args) => {
    const { child, unref } = fakeChild(NEW);
    const d = deps(() => child);
    const entry: UpProcessEntry = { pid: OLD, cwd: tmp, command, env: { OPT2_SERVICE: 'people' } };
    await expect(startProcess('people', entry, d)).resolves.toBe(NEW);
    expect(d.spawn).toHaveBeenCalledTimes(1);
    const [calledFile, calledArgs, options] = d.spawn.mock.calls[0] ?? [];
    expect([calledFile, calledArgs]).toStrictEqual([file, args]);
    expect(options).toStrictEqual({
      cwd: tmp,
      env: { ...process.env, OPT2_SERVICE: 'people' },
      detached: true,
      stdio: 'ignore',
    });
    expect(unref).toHaveBeenCalledTimes(1);
    expect(d.startTimeOf.mock.calls).toStrictEqual([[NEW]]);
    expect(d.writeUpState.mock.calls).toStrictEqual([[{ processes: { people: { ...entry, pid: NEW, startTime: NEW_START } } }]]);
  });

  it.each<[string, string | undefined, Partial<UpProcessEntry>]>([
    ['the start time of the new pid', NEW_START, { startTime: NEW_START }],
    ['no start time once the new pid is gone', undefined, {}],
  ])('replaces the recorded start time of the previous process with %s', async (_label, startTime, recorded) => {
    const d = deps(() => fakeChild(NEW).child, () => startTime);
    const entry: UpProcessEntry = { pid: OLD, cwd: tmp, command: ['node'], startTime: '1' };
    await startProcess('people', entry, d);
    expect(d.writeUpState.mock.calls).toStrictEqual([
      [{ processes: { people: { pid: NEW, cwd: tmp, command: ['node'], ...recorded } } }],
    ]);
  });

  it('appends stdout and stderr to the log file under the entry cwd, created owner-only', async () => {
    const d = deps(() => fakeChild(NEW).child);
    await startProcess('people', { pid: OLD, cwd: tmp, command: ['node'], log: 'people.log' }, d);
    const stdio = d.spawn.mock.calls[0]?.[2].stdio;
    expect(stdio).toStrictEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect((stdio as unknown[])[1]).toBe((stdio as unknown[])[2]);
    expect(statSync(path.join(tmp, 'people.log')).mode & 0o777).toBe(0o600);
  });

  it('rejects naming the command, with the spawn error as cause, and records nothing when no pid is assigned', async () => {
    const failure = new Error('spawn node ENOENT');
    const { child, unref } = fakeChild(undefined, failure);
    const d = deps(() => child);
    const err: unknown = await startProcess('people', { pid: OLD, cwd: tmp, command: ['node'] }, d).catch((reason: unknown) => reason);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('people: cannot start node');
    expect((err as Error).cause).toBe(failure);
    expect(unref).not.toHaveBeenCalled();
    expect(d.writeUpState).not.toHaveBeenCalled();
  });

  it('rethrows an error the spawn call throws, after opening the log, and records nothing', async () => {
    const d = deps(() => {
      throw EPERM;
    });
    await expect(startProcess('people', { pid: OLD, cwd: tmp, command: 'npm start', log: 'people.log' }, d)).rejects.toBe(EPERM);
    expect(existsSync(path.join(tmp, 'people.log'))).toBe(true);
    expect(d.writeUpState).not.toHaveBeenCalled();
  });
});

describe('restartAndMeasure', () => {
  const OLD = PID_BASE + 30;
  const NEW = PID_BASE + 31;
  const NEW_START = '515151';
  const PEOPLE_PORT = 28_112;
  const HEALTH_URL = `http://127.0.0.1:${PEOPLE_PORT}/healthz`;
  const PROBE_DESCRIBE = `GET ${CUSERS} as admin`;

  function peopleEntry(withPort = true): UpProcessEntry {
    return {
      pid: OLD,
      ...(withPort ? { port: PEOPLE_PORT } : {}),
      cwd: tmp,
      command: ['node', 'dist/server.js'],
      env: { OPT2_SERVICE: 'people' },
    };
  }

  interface RigOptions {
    processes?: Record<string, UpProcessEntry>;
    /** Answer to the n-th /healthz request; throwing refuses the connection. */
    health?: (poll: number) => Response;
    child?: SpawnedProcess;
    kill?: KillLike;
  }

  /** Restart deps over one live old pid; every /healthz request advances the clock 0.25 ms. */
  function restartRig(opts: RigOptions = {}) {
    const clock = fakeClock();
    const alive = new Set([OLD]);
    const signals: [number, NodeJS.Signals | 0][] = [];
    const healthUrls: string[] = [];
    const kill: KillLike =
      opts.kill ??
      ((pid, signal) => {
        signals.push([pid, signal]);
        if (!alive.has(Math.abs(pid))) throw ESRCH;
        if (signal !== 0) alive.delete(Math.abs(pid));
        return true;
      });
    const fetch = vi.fn<FetchLike>(async (input) => {
      healthUrls.push(input);
      clock.t += 0.25;
      return (opts.health ?? (() => new Response('ok')))(healthUrls.length);
    });
    const spawn = vi.fn<SpawnLike>(() => opts.child ?? fakeChild(NEW).child);
    const writeUp = vi.fn<(patch: UpStatePatch) => unknown>();
    const processes = opts.processes ?? { people: peopleEntry() };
    const deps: ProcessDeps = {
      spawn,
      kill,
      fetch,
      now: clock.now,
      sleep: clock.sleep,
      readUpState: () => ({ processes }),
      writeUpState: writeUp,
      startTimeOf: () => NEW_START,
    };
    return { deps, clock, signals, healthUrls, fetch, spawn, writeUp };
  }

  function probeAnswering(answer: (call: number) => boolean): GatewayProbe & {
    attempt: Mock<(timeoutMs: number) => Promise<boolean>>;
  } {
    let calls = 0;
    return { describe: PROBE_DESCRIBE, attempt: vi.fn(async (_timeoutMs: number) => answer(++calls)) };
  }

  it.each([
    ['the entry port', true, HEALTH_URL],
    ['the ports.env port when the entry has none', false, `http://127.0.0.1:${portFor('people')}/healthz`],
  ])(
    'times the first /healthz 200 and the first gateway success from the restart, polling /healthz on %s',
    async (_label, withPort, healthUrl) => {
      const entry = peopleEntry(withPort);
      const rig = restartRig({
        processes: { people: entry },
        health: (poll) => new Response(null, { status: poll <= 2 ? 503 : 200 }),
      });
      const probe = probeAnswering((call) => call >= 3);
      const outcome = await restartAndMeasure('people', rig.deps, probe);
      expect(outcome).toStrictEqual({
        coldStart: { service: 'people', startToFirst200Ms: 100.8, label: 'measured' },
        scaleToZero: { service: 'people', stopToFirstSuccessMs: 150.8, label: 'derived' },
        findings: [],
        unhealthy: false,
      });
      expect(rig.signals).toStrictEqual([
        [-OLD, 'SIGTERM'],
        [-OLD, 0],
      ]);
      expect(rig.healthUrls).toStrictEqual([healthUrl, healthUrl, healthUrl]);
      expect(rig.fetch.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
      expect(probe.attempt.mock.calls).toStrictEqual([[POLL_LIMIT_MS], [POLL_LIMIT_MS], [POLL_LIMIT_MS - PROBE_INTERVAL_MS]]);
      expect(rig.writeUp.mock.calls).toStrictEqual([[{ processes: { people: { ...entry, pid: NEW, startTime: NEW_START } } }]]);
    },
  );

  it.each(['gateway', 'web', 'migration', 'stub', 'legacy'])('rejects %s, which is not a restartable target service', async (name) => {
    await expect(restartAndMeasure(name, restartRig().deps, { notTarget: 'not restarted' })).rejects.toThrow(
      `${name} is not a restartable target service`,
    );
  });

  interface OutcomeCase {
    label: string;
    rig: () => ReturnType<typeof restartRig>;
    probe: () => ProbePlan;
    spawns: number;
    cold: number | null;
    unhealthy: boolean;
    findings: Finding[];
  }

  it.each<OutcomeCase>([
    {
      label: 'process-entry-missing, restarting nothing, when up.json has no entry for the service',
      rig: () => restartRig({ processes: {} }),
      probe: () => probeAnswering(() => false),
      spawns: 0,
      cold: null,
      unhealthy: false,
      findings: [{ kind: 'process-entry-missing', subject: 'people', detail: 'no people entry in up.json' }],
    },
    {
      label: 'stop-failed, starting nothing, when the stop throws',
      rig: () =>
        restartRig({
          kill: () => {
            throw EINVAL;
          },
        }),
      probe: () => probeAnswering(() => false),
      spawns: 0,
      cold: null,
      unhealthy: false,
      findings: [{ kind: 'stop-failed', subject: 'people', detail: 'EINVAL: fixture' }],
    },
    {
      label: 'start-failed and unhealthy when the spawn assigns no pid',
      rig: () => restartRig({ child: fakeChild(undefined, new Error('spawn node ENOENT')).child }),
      probe: () => probeAnswering(() => false),
      spawns: 1,
      cold: null,
      unhealthy: true,
      findings: [{ kind: 'start-failed', subject: 'people', detail: 'people: cannot start node' }],
    },
    {
      label: 'cold-start-timeout and unhealthy when /healthz refuses every poll',
      rig: () =>
        restartRig({
          health: () => {
            throw errno('ECONNREFUSED');
          },
        }),
      probe: () => probeAnswering(() => false),
      spawns: 1,
      cold: null,
      unhealthy: true,
      findings: [{ kind: 'cold-start-timeout', subject: 'people', detail: `${HEALTH_URL} did not answer 200 within ${POLL_LIMIT_MS} ms` }],
    },
    {
      label: 'probe-not-target with the cold start measured when no gateway read reaches the service',
      rig: () => restartRig(),
      probe: () => ({ notTarget: 'admin:cusers.listusers is legacy-routed in v0002, so no gateway read reaches people' }),
      spawns: 1,
      cold: 0.3,
      unhealthy: false,
      findings: [
        {
          kind: 'probe-not-target',
          subject: 'people',
          detail: 'admin:cusers.listusers is legacy-routed in v0002, so no gateway read reaches people',
        },
      ],
    },
    {
      label: 'probe-not-routed when the gateway answers the probe while the service is stopped',
      rig: () => restartRig(),
      probe: () => probeAnswering(() => true),
      spawns: 1,
      cold: 0.3,
      unhealthy: false,
      findings: [
        {
          kind: 'probe-not-routed',
          subject: 'people',
          detail: `${PROBE_DESCRIBE} answered 200 through the gateway while people was stopped`,
        },
      ],
    },
    {
      label: 'scale-probe-timeout and unhealthy when every probe after the restart fails',
      rig: () => restartRig(),
      probe: () =>
        probeAnswering(() => {
          throw new Error('socket hang up');
        }),
      spawns: 1,
      cold: 0.3,
      unhealthy: true,
      findings: [
        {
          kind: 'scale-probe-timeout',
          subject: 'people',
          detail: `${PROBE_DESCRIBE} did not answer 200 through the gateway within ${POLL_LIMIT_MS} ms`,
        },
      ],
    },
  ])('reports $label, with scale to zero unavailable', async (c) => {
    const rig = c.rig();
    const outcome = await restartAndMeasure('people', rig.deps, c.probe());
    expect(outcome).toStrictEqual({
      coldStart: { service: 'people', startToFirst200Ms: c.cold, label: 'measured' },
      scaleToZero: { service: 'people', stopToFirstSuccessMs: null, label: 'unavailable' },
      findings: c.findings,
      unhealthy: c.unhealthy,
    });
    expect(rig.spawn).toHaveBeenCalledTimes(c.spawns);
  });
});

describe('parseMinInstanceCounts', () => {
  const CLOUD_RUN = 'google_cloud_run_v2_service';
  const PLAN = {
    planned_values: {
      root_module: {
        resources: [
          {
            address: 'google_cloud_run_v2_service.gateway',
            type: CLOUD_RUN,
            values: { name: 'opt2-gateway', template: [{ scaling: [{ min_instance_count: 0 }] }] },
          },
          { address: 'google_storage_bucket.exports', type: 'google_storage_bucket', values: { name: 'opt2-exports' } },
          { type: CLOUD_RUN, values: null },
        ],
        child_modules: [
          {
            resources: [
              {
                address: 'module.services["people"].google_cloud_run_v2_service.this',
                type: CLOUD_RUN,
                values: { name: 'opt2-people-renamed', template: [{ scaling: [{ min_instance_count: 0 }] }] },
              },
              {
                address: 'module.services["migration"].google_cloud_run_v2_service.this',
                type: CLOUD_RUN,
                values: { scaling: [{ min_instance_count: 1 }] },
              },
              {
                address: 'module.services["web"].google_cloud_run_v2_service.this',
                type: CLOUD_RUN,
                values: { template: [{ scaling: null }] },
              },
              {
                address: 'module.services["identity"].google_cloud_run_v2_service.this',
                type: CLOUD_RUN,
                values: { name: 42, template: 'not-a-list', scaling: [{ min_instance_count: 'two' }] },
              },
              { address: 'module.services["programs-sites"].google_cloud_run_v2_service.this', type: CLOUD_RUN },
            ],
            child_modules: [
              {},
              {
                resources: [
                  {
                    address: 'module.services["strategies-content"].module.inner.google_cloud_run_v2_service.this',
                    type: CLOUD_RUN,
                    values: { template: [{ scaling: [{ min_instance_count: 2 }] }] },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
  const FROM_PLAN = { gateway: 0, people: 0, migration: 1, web: 0, identity: 0, 'programs-sites': 0, 'strategies-content': 2 };

  it.each([
    ['no report', undefined, { source: 'unavailable', values: {} }],
    ['a null plan', terraformPlanReportSchema.parse({ plan: null }), { source: 'unavailable', values: {} }],
    ['a plan without planned_values', terraformPlanReportSchema.parse({ plan: {} }), { source: 'unavailable', values: {} }],
    [
      'planned_values without a root module',
      terraformPlanReportSchema.parse({ plan: { planned_values: {} } }),
      { source: 'plan.planned_values', values: {} },
    ],
    [
      'a non-empty minInstanceCounts summary beside a plan',
      terraformPlanReportSchema.parse({ minInstanceCounts: { gateway: 0, migration: 1 }, plan: PLAN }),
      { source: 'minInstanceCounts', values: { gateway: 0, migration: 1 } },
    ],
  ])('reads %s', (_label, report, expected) => {
    expect(parseMinInstanceCounts(report)).toStrictEqual(expected);
  });

  it.each([
    ['no summary', {}],
    ['an empty summary', { minInstanceCounts: {} }],
    ['a null summary', { minInstanceCounts: null }],
  ])(
    'walks every Cloud Run service of the plan, keyed by module instance else by name, with %s',
    (_label, summary) => {
      expect(parseMinInstanceCounts(terraformPlanReportSchema.parse({ ...summary, plan: PLAN }))).toStrictEqual({
        source: 'plan.planned_values',
        values: FROM_PLAN,
      });
    },
  );
});

describe('checkMinInstanceCounts', () => {
  it('raises nothing when every expected service is planned at its count and extras plan 0', () => {
    expect(checkMinInstanceCounts({ ...EXPECTED_MIN_INSTANCES, 'extra-service': 0 })).toStrictEqual([]);
  });

  it('flags an absent service, a differing count and an unexpected service planned above 0', () => {
    const values: Record<string, number> = { ...EXPECTED_MIN_INSTANCES, migration: 0, 'legacy-bridge': 2 };
    delete values.web;
    expect(checkMinInstanceCounts(values)).toStrictEqual([
      { kind: 'min-instance-count-missing', subject: 'web', detail: 'expected 0, absent from the plan' },
      { kind: 'min-instance-count', subject: 'migration', detail: 'expected 1, planned 0' },
      { kind: 'min-instance-count-unexpected', subject: 'legacy-bridge', detail: 'not an expected service; planned 2, expected 0' },
    ]);
  });
});

describe('windowsOverThreshold', () => {
  it('flags windows longer than 5000 ms, longest first, spanning first to last phase when durationMs is absent', () => {
    const report = windowsReportSchema.parse({
      windows: [
        { windowId: 'w-at', routeKey: 'cusers.update', durationMs: 5000 },
        { windowId: 'w-over', routeKey: 'csettings.update', durationMs: 5001 },
        {
          windowId: 'w-phases',
          routeKey: 'carch.update',
          phases: [
            { phase: 'opened', at: '2026-06-30T10:00:00.000Z' },
            { phase: 'applied', at: '2026-06-30T10:00:03.000Z' },
            { phase: 'closed', at: '2026-06-30T10:00:07.500Z' },
          ],
        },
        { windowId: 'w-one-phase', routeKey: 'cusers.delete', phases: [{ phase: 'opened', at: '2026-06-30T10:00:00.000Z' }] },
        { windowId: 'w-bare', routeKey: 'cperm.update' },
      ],
    });
    expect(windowsOverThreshold(report)).toStrictEqual([
      { windowId: 'w-phases', routeKey: 'carch.update', durationMs: 7500 },
      { windowId: 'w-over', routeKey: 'csettings.update', durationMs: 5001 },
    ]);
  });

  it.each([
    ['no report', undefined],
    ['a report without windows', windowsReportSchema.parse({})],
  ])('flags nothing for %s', (_label, report) => {
    expect(windowsOverThreshold(report)).toStrictEqual([]);
  });
});

describe('buildPerformanceReport', () => {
  it('adds the min-instance and window findings and sorts all findings by kind, subject and detail', () => {
    const parts: PerformanceParts = {
      latency: [
        row(LABELS, {
          requests: 200,
          target: { p50Ms: 5, p95Ms: 5 },
          legacy: { p50Ms: 4, p95Ms: 4 },
          statuses: { legacy: [200], target: [200] },
          ratioP95: 1.25,
          finding: null,
        }),
      ],
      coldStart: [{ service: 'people', startToFirst200Ms: 12.5, label: 'measured' }],
      scaleToZero: [{ service: 'people', stopToFirstSuccessMs: 30.1, label: 'derived' }],
      minInstanceCount: { source: 'minInstanceCounts', values: { ...EXPECTED_MIN_INSTANCES, migration: 0 } },
      windowsOverThreshold: [{ windowId: 'w-1', routeKey: 'cusers.update', durationMs: 6000 }],
      findings: [
        { kind: 'non-ok-response', subject: 'csettings.list/target', detail: 'b' },
        { kind: 'latency-ratio', subject: 'cusers.listusers', detail: 'x' },
        { kind: 'non-ok-response', subject: 'csettings.list/target', detail: 'a' },
        { kind: 'latency-ratio', subject: 'csettings.list', detail: 'x' },
      ],
    };
    const before = structuredClone(parts.findings);
    expect(buildPerformanceReport(parts)).toStrictEqual({
      latency: parts.latency,
      coldStart: parts.coldStart,
      minInstanceCount: { ...parts.minInstanceCount, label: 'measured' },
      scaleToZero: parts.scaleToZero,
      windowsOverThreshold: parts.windowsOverThreshold,
      findings: [
        { kind: 'latency-ratio', subject: 'csettings.list', detail: 'x' },
        { kind: 'latency-ratio', subject: 'cusers.listusers', detail: 'x' },
        { kind: 'min-instance-count', subject: 'migration', detail: 'expected 1, planned 0' },
        { kind: 'non-ok-response', subject: 'csettings.list/target', detail: 'a' },
        { kind: 'non-ok-response', subject: 'csettings.list/target', detail: 'b' },
        { kind: 'window-over-threshold', subject: 'w-1', detail: 'cusers.update 6000 ms' },
      ],
      cloudMeasurement: CLOUD_MEASUREMENT,
    });
    expect(parts.findings).toStrictEqual(before);
  });
});

describe('renderPerformanceMarkdown', () => {
  const REPORT: PerformanceReport = {
    latency: [
      row(
        { set: 'content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}', source: 'catalogue', session: 'anon', routeKey: 'api:content.findone', servedBy: 'legacy' },
        {
          requests: 200,
          target: { p50Ms: 5, p95Ms: 9.5 },
          legacy: { p50Ms: 4, p95Ms: 4.5 },
          statuses: { legacy: [200], target: [200] },
          ratioP95: 2.11,
          finding: 'target p95 9.5 ms is 2.11x legacy p95 4.5 ms (above 1.5x)',
        },
      ),
      row(
        { ...LABELS, set: 'cusers.listusers', routeKey: 'admin:cusers.listusers', servedBy: 'target' },
        { requests: 200, target: { p50Ms: 5, p95Ms: 5 }, legacy: { p50Ms: 4, p95Ms: 4 }, statuses: { legacy: [200], target: [200] }, ratioP95: 1.25, finding: null },
      ),
      row(LABELS, { requests: 0, target: null, legacy: null, statuses: { legacy: [], target: [] }, ratioP95: null, finding: 'unread | none' }),
    ],
    coldStart: [
      { service: 'people', startToFirst200Ms: 12.5, label: 'measured' },
      { service: 'strategies-content', startToFirst200Ms: null, label: 'measured' },
    ],
    minInstanceCount: {
      source: 'plan.planned_values',
      values: { gateway: 0, migration: 1, 'zeta-extra': 0, 'alpha-extra': 3 },
      label: 'measured',
    },
    scaleToZero: [
      { service: 'people', stopToFirstSuccessMs: 30.1, label: 'derived' },
      { service: 'strategies-content', stopToFirstSuccessMs: null, label: 'unavailable' },
    ],
    windowsOverThreshold: [{ windowId: 'w-1', routeKey: 'cusers.update', durationMs: 6000 }],
    findings: [{ kind: 'latency-ratio', subject: 'csettings.list', detail: 'a|b' }],
    cloudMeasurement: CLOUD_MEASUREMENT,
  };

  it('renders the method, one table per measurement with n/a for null cells and escaped pipes, and the findings', () => {
    expect(renderPerformanceMarkdown(REPORT)).toStrictEqual([
      '## Method',
      '',
      '- 200 sequential requests per read set and side, interleaved: one legacy request, then one target request.',
      '- p50 and p95 by nearest rank, in ms rounded to 0.1.',
      '- Target is the gateway with the active cut-over version; legacy is the ColdFusion origin, requested directly.',
      "- Source `catalogue` rows are the fixed JSON API content reads, written as catalogue steps: one per session and path of their matrix, named `content-reads:<session> <route>` with seed placeholders kept; source `read-set` rows are the fixed findMany, feed, `cusers.listusers` and `csettings.list` reads. The feed row reads a Local collection the run creates through the gateway just before the set and deletes just after it.",
      "- Served by is the side the active cut-over version routes the row's route key to. On a `legacy` row the target columns measure the gateway proxying to legacy, and a `legacy-served` finding says so.",
      '- The request sets no latency threshold: a target p95 above 1.5x legacy and a write window over 5 s are flags, not failures.',
      "- The legacy-direct admin session logs in on legacy itself, which updates that user's `tusers.LastLogin` on the legacy side.",
      '- Cold start is measured locally (process start to the first `/healthz` 200); scale to zero and back is derived (stopped service, restart, first successful request through the gateway), and `unavailable` where no such request was timed. Each poll is bounded at 60000 ms.',
      "- Each service is probed only by identity's admin login or by a request that leaves the compared state unchanged: a read, or a view whose writes are idempotent. A service none of whose probe candidates the active version routes to target has an `unavailable` row and a `probe-not-target` finding naming the candidates' route keys.",
      '- Cloud measurement: not possible without apply.',
      '',
      '## Latency',
      '',
      '| Set | Source | Served by | Requests | Target p50 (ms) | Target p95 (ms) | Legacy p50 (ms) | Legacy p95 (ms) | Ratio p95 | Finding |',
      '|---|---|---|---|---|---|---|---|---|---|',
      '| content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID} | catalogue | legacy | 200 | 5 | 9.5 | 4 | 4.5 | 2.11 | target p95 9.5 ms is 2.11x legacy p95 4.5 ms (above 1.5x) |',
      '| cusers.listusers | read-set | target | 200 | 5 | 5 | 4 | 4 | 1.25 |  |',
      '| csettings.list | read-set | legacy | 0 | n/a | n/a | n/a | n/a | n/a | unread \\| none |',
      '',
      '## Cold start (measured)',
      '',
      '| Service | Start to first 200 (ms) |',
      '|---|---|',
      '| people | 12.5 |',
      '| strategies-content | n/a |',
      '',
      '## min_instance_count (measured from the Terraform plan)',
      '',
      'Source: `plan.planned_values`.',
      '',
      '| Service | Planned | Expected |',
      '|---|---|---|',
      '| gateway | 0 | 0 |',
      '| web | absent | 0 |',
      '| identity | absent | 0 |',
      '| people | absent | 0 |',
      '| programs-sites | absent | 0 |',
      '| strategies-content | absent | 0 |',
      '| migration | 1 | 1 |',
      '| alpha-extra | 3 | 0 |',
      '| zeta-extra | 0 | 0 |',
      '',
      '## Scale to zero and back (derived)',
      '',
      '| Service | Stop to first success through the gateway (ms) | Label |',
      '|---|---|---|',
      '| people | 30.1 | derived |',
      '| strategies-content | n/a | unavailable |',
      '',
      '## Windows over 5 s',
      '',
      '| Window | Route key | Duration (ms) |',
      '|---|---|---|',
      '| w-1 | cusers.update | 6000 |',
      '',
      '## Findings',
      '',
      '| Kind | Subject | Detail |',
      '|---|---|---|',
      '| latency-ratio | csettings.list | a\\|b |',
    ]);
  });

  it('writes None. for no windows over the threshold and no findings', () => {
    const lines = renderPerformanceMarkdown({ ...REPORT, windowsOverThreshold: [], findings: [] });
    expect(lines.slice(lines.indexOf('## Windows over 5 s'))).toStrictEqual([
      '## Windows over 5 s',
      '',
      'None.',
      '',
      '## Findings',
      '',
      'None.',
    ]);
  });
});

describe('main', () => {
  const LOGIN_FORM = `
<form novalidate="novalidate" id="loginForm" name="frmLogin" method="post" action="./?muraAction=cLogin.login">
  <input id="username" name="username" type="text">
  <input id="password" type="password" name="password">
  <input type="hidden" name="isAdminLogin" value="true">
  <input type="hidden" name="csrf_token" value="${CSRF_TOKEN}">
  <input type="hidden" name="csrf_token_expires" value="260630120000000">
</form>`;
  const FIND_MANY = `/_api/json/v1/tenant-a/content/${PAGE_IDS.join(',')}`;
  const FEED_READ = feedReadPath(NEW_FEED_ID);
  const FEED_SAVE = `POST ${GATEWAY}/admin/?muraAction=cFeed.update&siteid=tenant-a`;
  const SLOW_FINDING = 'target p95 9 ms is 2.25x legacy p95 4 ms (above 1.5x)';
  // SITE_TREE_TARGET routes strategies-content's Site Manager tree probe to target; identity's is that tree in a fresh
  // admin session.
  const TARGET_PROBED: readonly RestartService[] = ['identity', 'strategies-content'];
  const PROBE_KEYS: Readonly<Record<RestartService, string[]>> = {
    identity: ['admin:clogin.login'],
    people: ['admin:cusers.listusers'],
    'programs-sites': ['admin:csettings.list'],
    'strategies-content': ['api:content.findone', 'admin:carch.list'],
  };

  /** The probe-not-target findings, by subject, of every service outside `probed` under version `version`. */
  function notTargetFindings(version: string, probed: readonly RestartService[]): Finding[] {
    return RESTART_SERVICES.filter((service) => !probed.includes(service))
      .sort()
      .map((service) => ({
        kind: 'probe-not-target',
        subject: service,
        detail: notTargetDetail(service, PROBE_KEYS[service], version),
      }));
  }

  /** The scale-to-zero row of `service`: derived from `ms`, unavailable without one. */
  function scaleRow(service: RestartService, ms: number | null): ScaleToZeroRow {
    return ms === null ? { service, stopToFirstSuccessMs: null, label: 'unavailable' } : { service, stopToFirstSuccessMs: ms, label: 'derived' };
  }

  interface StackOptions {
    adminUser?: string;
    /** Gateway latency per path, else TARGET_MS. */
    slowTarget?: Readonly<Record<string, number>>;
    /** Gateway status per path, else 200. */
    targetStatus?: Readonly<Record<string, number>>;
    neverHealthy?: readonly RestartService[];
    /** /healthz 503 answers after each start before the first 200 (default 2). */
    healthFailures?: number;
    refuse?: 'legacy' | 'gateway';
    /** Cut-over version written to OPT2_CUTOVER_DIR and routed by the gateway (default SITE_TREE_TARGET). */
    routing?: Routing;
    /** Cut-over version the gateway reports active (default the routing's). */
    activeVersion?: string | null;
    feed?: FeedSiteOptions;
  }

  interface FakeStack {
    entries: Record<string, UpProcessEntry>;
    requests: string[];
    clock: FakeClock;
    fetch: FetchLike;
    kill: KillLike;
    spawn: SpawnLike;
    spawned: Map<string, number>;
    feeds: ReturnType<typeof feedSite>;
    routing: Routing;
    deps(env: EnvLike): MainDeps;
  }

  /**
   * Legacy origin, gateway and the local service processes. The gateway proxies every route its routing leaves
   * on legacy and answers 502 for a request the routing sends to target while its owner or identity, which resolves
   * its session, is stopped; each legacy request takes LEGACY_MS on the fake clock and each gateway request TARGET_MS.
   */
  function fakeStack(opts: StackOptions = {}): FakeStack {
    const routing = opts.routing ?? SITE_TREE_TARGET;
    const clock = fakeClock();
    const requests: string[] = [];
    const running = new Map<string, number>();
    const spawned = new Map<string, number>();
    const healthPolls = new Map<string, number>();
    const byPort = new Map<string, RestartService>();
    const entries: Record<string, UpProcessEntry> = {};
    const feeds = feedSite(opts.feed);
    const accounts = new Map<string, string>([[opts.adminUser ?? 'admin', credential('admin')]]);
    let nextPid = PID_BASE + 100;
    let loginPages = 0;
    RESTART_SERVICES.forEach((service, index) => {
      // Every other entry leaves its port to ports.env.
      const port = index % 2 === 0 ? 28_100 + index : undefined;
      const pid = nextPid++;
      entries[service] = {
        pid,
        ...(port === undefined ? {} : { port }),
        cwd: path.join(tmp, service),
        command: ['node', 'dist/server.js'],
        env: { OPT2_SERVICE: service },
      };
      byPort.set(String(port ?? portFor(service)), service);
      running.set(service, pid);
    });

    const kill: KillLike = (pid, signal) => {
      const service = [...running].find(([, live]) => live === Math.abs(pid))?.[0];
      if (service === undefined) throw ESRCH;
      if (signal !== 0) running.delete(service);
      return true;
    };

    const spawn: SpawnLike = (_command, _args, options) => {
      const service = options.env?.OPT2_SERVICE;
      if (service === undefined) throw new Error('spawned without OPT2_SERVICE');
      const pid = nextPid++;
      running.set(service, pid);
      spawned.set(service, pid);
      healthPolls.set(service, 0);
      return fakeChild(pid).child;
    };

    function health(url: URL): Response {
      const service = byPort.get(url.port);
      if (url.hostname !== '127.0.0.1' || service === undefined) throw new Error(`unscripted health check ${url.href}`);
      if (!running.has(service) || opts.neverHealthy?.includes(service) === true) throw errno('ECONNREFUSED');
      const polls = (healthPolls.get(service) ?? 0) + 1;
      healthPolls.set(service, polls);
      return polls > (opts.healthFailures ?? 2) ? new Response('ok') : new Response('starting', { status: 503 });
    }

    function answer(side: 'legacy' | 'gateway', method: string, url: URL, body: string): Response {
      const target = `${url.pathname}${url.search}`;
      if (method === 'GET' && target === LOGIN_PAGE) {
        loginPages += 1;
        return html(LOGIN_FORM, [`CFID=${side}-${loginPages}; Path=/; HttpOnly`]);
      }
      if (method === 'POST' && target === LOGIN_POST) {
        const form = new URLSearchParams(body);
        const accepted =
          opts.refuse !== side &&
          form.get('csrf_token') === CSRF_TOKEN &&
          accounts.get(form.get('username') ?? '') === form.get('password');
        return redirect(accepted ? './' : './?muraAction=clogin.main');
      }
      if (method === 'GET' && target === '/admin/') return html('<h1>Masa CMS - Site Content</h1>');
      const feedAnswer = feeds.answer(side, method, url, body);
      if (feedAnswer !== undefined) return feedAnswer;
      return json({ data: {} }, side === 'gateway' ? (opts.targetStatus?.[target] ?? 200) : 200);
    }

    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? 'GET';
      const target = `${url.pathname}${url.search}`;
      requests.push(`${method} ${url.origin}${target}`);
      if (url.pathname === '/healthz') return health(url);
      if (url.origin === GATEWAY && url.pathname === CUTOVER_STATUS) {
        return json({ tableVersion: opts.activeVersion === undefined ? routing.table.tableVersion : opts.activeVersion });
      }
      const side = url.origin === LEGACY ? 'legacy' : url.origin === GATEWAY ? 'gateway' : undefined;
      if (side === undefined) throw new Error(`unscripted request ${method} ${input}`);
      clock.t += side === 'legacy' ? LEGACY_MS : (opts.slowTarget?.[target] ?? TARGET_MS);
      const owner = side === 'gateway' ? routing.ownerOf(method, target) : undefined;
      if (owner !== undefined && !(running.has(owner) && running.has('identity'))) {
        return new Response('Bad Gateway', { status: 502 });
      }
      return answer(side, method, url, typeof init.body === 'string' ? init.body : '');
    };

    return {
      entries,
      requests,
      clock,
      fetch,
      kill,
      spawn,
      spawned,
      feeds,
      routing,
      deps: (env) => ({ env, fetch, kill, spawn, now: clock.now, sleep: clock.sleep, invoker: INVOKER }),
    };
  }

  function reportsPath(...segments: string[]): string {
    return path.join(tmp, 'reports', ...segments);
  }

  /**
   * Writes up.json, the stack's cut-over version, the seed dataset and the optional plan and window reports.
   */
  async function stageMain(
    stack: FakeStack,
    stage: { plan?: unknown; windows?: unknown; adminUser?: string } = {},
  ): Promise<EnvLike> {
    const state = path.join(tmp, 'state');
    const cutoverDir = path.join(tmp, 'cutover');
    const env: EnvLike = {
      OPT2_STATE_DIR: state,
      OPT2_REPORTS_DIR: reportsPath(),
      OPT2_CUTOVER_DIR: cutoverDir,
      LEGACY_ORIGIN: LEGACY,
      OPT2_GATEWAY_URL: GATEWAY,
      MURA_ADMIN_PASSWORD: credential('admin'),
      ...(stage.adminUser === undefined ? {} : { MURA_ADMIN_USERNAME: stage.adminUser }),
    };
    writeUpState({ processes: stack.entries }, { env });
    const { table } = stack.routing;
    await writeFixtureFile(path.join(cutoverDir, 'versions', `${table.tableVersion}.json`), table);
    await writeFixtureFile(path.join(state, 'seed', 'dataset.json'), seedDataset());
    if (stage.plan !== undefined) await writeFixtureFile(reportsPath('terraform-plan.json'), stage.plan);
    if (stage.windows !== undefined) await writeFixtureFile(reportsPath('windows.json'), stage.windows);
    return env;
  }

  async function readReport(): Promise<PerformanceReport & { generatedBy: string; sourceSha: string }> {
    return JSON.parse(await fs.readFile(reportsPath('performance.json'), 'utf8')) as PerformanceReport & {
      generatedBy: string;
      sourceSha: string;
    };
  }

  function healthUrlOf(stack: FakeStack, service: RestartService): string {
    return `http://127.0.0.1:${stack.entries[service]?.port ?? portFor(service)}/healthz`;
  }

  function cliIo(lines: string[], exits: number[]) {
    return {
      argv: [],
      command: 'performance',
      stdout: { write: (chunk: string) => lines.push(chunk) },
      exit: (code: number) => {
        exits.push(code);
      },
    };
  }

  function findingsOf(report: PerformanceReport, ...kinds: string[]): Finding[] {
    return report.findings.filter((finding) => kinds.includes(finding.kind));
  }

  function withoutKinds(report: PerformanceReport, ...kinds: string[]): Finding[] {
    return report.findings.filter((finding) => !kinds.includes(finding.kind));
  }

  function allSets(): string[] {
    return [...expandCatalogueReads(CONTENT_READS).map((read) => read.set), ...READ_SET.map((entry) => entry.set)];
  }

  /** Admin form logins main makes per side for the content reads' own sessions. */
  function scenarioLogins(): number {
    return Object.values(CONTENT_READS.sessions).filter((spec) => spec.login !== 'none' && spec.via === 'admin').length;
  }

  it('measures the catalogue reads and the read set, restarts all services and writes performance.json and .md', async () => {
    const reads = expandCatalogueReads(CONTENT_READS);
    // The first catalogue read's path answers slower, and 403, through the gateway in every session that reads it.
    const slowPath = seededRoute(reads[0]?.route ?? '');
    const isSlow = (read: (typeof reads)[number]) => seededRoute(read.route) === slowPath;
    const slowSets = reads.filter(isSlow).map((read) => read.set).sort();
    const stack = fakeStack({ slowTarget: { [slowPath]: 9 }, targetStatus: { [slowPath]: 403 } });
    const env = await stageMain(stack, {
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [{ windowId: 'w-1', routeKey: 'cusers.update', durationMs: 6000 }] },
    });

    const outcome = await main([], stack.deps(env));

    const report = await readReport();
    expect(outcome).toStrictEqual({
      code: 0,
      summary: { report: reportsPath('performance.json'), latencySets: allSets().length, findings: report.findings.length, unhealthy: false },
    });
    expect(report.generatedBy).toBe(GENERATED_BY);
    expect(report.sourceSha).toBe(readPin().sha);
    const measured = { legacy: { p50Ms: 4, p95Ms: 4 }, target: { p50Ms: 5, p95Ms: 5 }, ratioP95: 1.25, finding: null };
    const ok = { requests: REQUESTS_PER_SET, statuses: { legacy: [200], target: [200] }, ...measured };
    const readSetRow = (set: string, session: string, routeKey: string): LatencyRow =>
      row({ set, source: 'read-set', session, routeKey, servedBy: 'legacy' }, ok);
    expect(report.latency).toStrictEqual([
      ...reads.map((read) => {
        const slow = isSlow(read);
        return expect.objectContaining({
          set: read.set,
          source: 'catalogue',
          session: read.session,
          // Labelled by the route key of the seed-resolved path.
          routeKey: (coverageRouteResults({ method: 'GET', route: seededRoute(read.route) })[0] as RouteKeyResult).key,
          servedBy: 'legacy',
          requests: REQUESTS_PER_SET,
          legacy: { p50Ms: 4, p95Ms: 4 },
          target: slow ? { p50Ms: 9, p95Ms: 9 } : { p50Ms: 5, p95Ms: 5 },
          statuses: { legacy: [200], target: slow ? [403] : [200] },
          ratioP95: slow ? 2.25 : 1.25,
          finding: slow ? SLOW_FINDING : null,
        }) as LatencyRow;
      }),
      readSetRow('content-reads.content.findMany', 'anonymous', 'api:content.findmany'),
      readSetRow('content-reads.feed', 'anonymous', 'feed:v1'),
      readSetRow('cusers.listusers', 'admin', 'admin:cusers.listusers'),
      readSetRow('csettings.list', 'admin', 'admin:csettings.list'),
    ]);
    expect(report.coldStart).toStrictEqual(RESTART_SERVICES.map((service) => ({ service, startToFirst200Ms: 100, label: 'measured' })));
    // identity's probe logs a fresh gateway session in (three requests) before its tree read.
    expect(report.scaleToZero).toStrictEqual(
      RESTART_SERVICES.map((service) => scaleRow(service, service === 'identity' ? 120 : TARGET_PROBED.includes(service) ? 105 : null)),
    );
    expect(report.minInstanceCount).toStrictEqual({ source: 'minInstanceCounts', values: { ...EXPECTED_MIN_INSTANCES }, label: 'measured' });
    expect(report.windowsOverThreshold).toStrictEqual([{ windowId: 'w-1', routeKey: 'cusers.update', durationMs: 6000 }]);
    const served = findingsOf(report, 'legacy-served');
    expect(served.map((finding) => finding.subject)).toStrictEqual([...allSets()].sort());
    expect(served.find((finding) => finding.subject === 'csettings.list')?.detail).toBe(
      'admin:csettings.list is legacy-routed in v9103: the target columns measure the gateway proxying to legacy',
    );
    expect(withoutKinds(report, 'legacy-served')).toStrictEqual([
      ...slowSets.map((subject) => ({ kind: 'latency-ratio', subject, detail: SLOW_FINDING })),
      ...slowSets
        .map((set) => `${set}/target`)
        .sort()
        .map((subject) => ({ kind: 'non-ok-response', subject, detail: '200 of 200: 403' })),
      ...notTargetFindings('v9103', TARGET_PROBED),
      ...slowSets.map((subject) => ({ kind: 'status-mismatch', subject, detail: 'legacy answered 200; target answered 403' })),
      { kind: 'window-over-threshold', subject: 'w-1', detail: 'cusers.update 6000 ms' },
    ]);
    expect(report.cloudMeasurement).toBe(CLOUD_MEASUREMENT);

    for (const read of reads) {
      const target = seededRoute(read.route);
      const readers = reads.filter((other) => seededRoute(other.route) === target).length;
      for (const origin of [LEGACY, GATEWAY]) expect(count(stack.requests, `GET ${origin}${target}`), target).toBe(readers * REQUESTS_PER_SET);
    }
    for (const target of [FIND_MANY, CUSERS, CSETTINGS]) {
      expect(count(stack.requests, `GET ${LEGACY}${target}`)).toBe(REQUESTS_PER_SET);
      expect(count(stack.requests, `GET ${GATEWAY}${target}`)).toBe(REQUESTS_PER_SET);
    }
    // The untimed feed confirmation reads both sides once; the deletion check reads legacy once more.
    expect(count(stack.requests, `GET ${LEGACY}${FEED_READ}`)).toBe(REQUESTS_PER_SET + 2);
    expect(count(stack.requests, `GET ${GATEWAY}${FEED_READ}`)).toBe(REQUESTS_PER_SET + 1);
    expect(stack.feeds.posts).toStrictEqual([SAVE_LOCAL_POST, deleteLocalPost(NEW_FEED_ID)]);
    expect([...stack.feeds.feeds.keys()]).toStrictEqual([LEFTOVER_FEED_ID]);
    const saved = stack.requests.indexOf(FEED_SAVE);
    const deleted = stack.requests.lastIndexOf(FEED_SAVE);
    expect(stack.requests.lastIndexOf(`GET ${GATEWAY}${FIND_MANY}`)).toBeLessThan(saved);
    expect(stack.requests.indexOf(`GET ${LEGACY}${FEED_READ}`)).toBeGreaterThan(saved);
    expect(stack.requests.lastIndexOf(`GET ${GATEWAY}${FEED_READ}`)).toBeLessThan(deleted);
    expect(stack.requests.indexOf(`GET ${LEGACY}${CUSERS}`)).toBeGreaterThan(deleted);
    expect(stack.requests.findIndex((request) => request.endsWith('/healthz'))).toBeGreaterThan(deleted);
    expect(count(stack.requests, `GET ${GATEWAY}${CUTOVER_STATUS}`)).toBe(1);
    // Legacy: admin and the scenario's sessions. Gateway: those, and identity's fresh session while it is stopped and
    // once restarted.
    expect(count(stack.requests, `POST ${LEGACY}${LOGIN_POST}`)).toBe(1 + scenarioLogins());
    expect(count(stack.requests, `POST ${GATEWAY}${LOGIN_POST}`)).toBe(3 + scenarioLogins());
    expect(readUpState({ env }).processes).toStrictEqual(
      Object.fromEntries(RESTART_SERVICES.map((service) => [service, { ...stack.entries[service], pid: stack.spawned.get(service) }])),
    );

    const markdown = await fs.readFile(reportsPath('performance.md'), 'utf8');
    expect(markdown.startsWith(`# Performance report\nSource SHA: ${readPin().sha}\n\n## Method\n`)).toBe(true);
    const slowCell = (reads[0]?.set ?? '').replaceAll('|', '\\|');
    expect(markdown).toContain(`| ${slowCell} | catalogue | legacy | 200 | 9 | 9 | 4 | 4 | 2.25 | ${SLOW_FINDING} |`);
    expect(markdown).toContain('| content-reads.feed | read-set | legacy | 200 | 5 | 5 | 4 | 4 | 1.25 |  |');
  });

  it('times no scale to zero when every probe is legacy-routed and flags absent plan and window reports', async () => {
    const stack = fakeStack({ adminUser: 'fixture-admin', routing: ALL_LEGACY_ROUTING });
    const env = await stageMain(stack, { adminUser: 'fixture-admin' });

    const outcome = await main([], stack.deps(env));

    const report = await readReport();
    expect(outcome).toStrictEqual({
      code: 0,
      summary: { report: reportsPath('performance.json'), latencySets: allSets().length, findings: report.findings.length, unhealthy: false },
    });
    expect(report.coldStart.every((row) => row.startToFirst200Ms === 100)).toBe(true);
    expect(report.scaleToZero).toStrictEqual(RESTART_SERVICES.map((service) => scaleRow(service, null)));
    expect(report.minInstanceCount).toStrictEqual({ source: 'unavailable', values: {}, label: 'measured' });
    expect(findingsOf(report, 'min-instance-count-missing').map((finding) => finding.subject)).toStrictEqual(
      Object.keys(EXPECTED_MIN_INSTANCES).sort(),
    );
    expect(findingsOf(report, 'legacy-served').map((finding) => finding.subject)).toStrictEqual([...allSets()].sort());
    expect(withoutKinds(report, 'min-instance-count-missing', 'legacy-served')).toStrictEqual([
      ...notTargetFindings('v9104', []),
      { kind: 'terraform-plan-missing', subject: 'terraform-plan.json', detail: 'not in the reports directory' },
      { kind: 'windows-report-missing', subject: 'windows.json', detail: 'not in the reports directory' },
    ]);
    expect(count(stack.requests, `POST ${LEGACY}${LOGIN_POST}`)).toBe(1 + scenarioLogins());
    expect(count(stack.requests, `POST ${GATEWAY}${LOGIN_POST}`)).toBe(1 + scenarioLogins());
  });

  it('probes identity by its own login and people by the user list, a target-served row without a legacy-served finding', async () => {
    const stack = fakeStack({ routing: LOGIN_AND_USERS_TARGET });
    const env = await stageMain(stack, {
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [] },
    });

    const outcome = await main([], stack.deps(env));

    const report = await readReport();
    expect(outcome.code).toBe(0);
    expect(report.latency.filter((latency) => latency.servedBy === 'target')).toStrictEqual([
      row(
        { set: 'cusers.listusers', source: 'read-set', session: 'admin', routeKey: 'admin:cusers.listusers', servedBy: 'target' },
        {
          requests: REQUESTS_PER_SET,
          legacy: { p50Ms: 4, p95Ms: 4 },
          target: { p50Ms: 5, p95Ms: 5 },
          statuses: { legacy: [200], target: [200] },
          ratioP95: 1.25,
          finding: null,
        },
      ),
    ]);
    expect(findingsOf(report, 'legacy-served').map((finding) => finding.subject)).toStrictEqual(
      allSets()
        .filter((set) => set !== 'cusers.listusers')
        .sort(),
    );
    // identity's probe is a fresh gateway login (three requests); people's reads the list in the admin session.
    expect(report.scaleToZero).toStrictEqual(
      RESTART_SERVICES.map((service) => scaleRow(service, service === 'identity' ? 115 : service === 'people' ? 105 : null)),
    );
    expect(withoutKinds(report, 'legacy-served')).toStrictEqual(notTargetFindings('v9102', ['identity', 'people']));
    // Admin and the scenario's sessions, then identity's login while stopped (502) and restarted.
    expect(count(stack.requests, `POST ${GATEWAY}${LOGIN_POST}`)).toBe(3 + scenarioLogins());
  });

  it('probes strategies-content by the Site Manager tree when its content read is legacy-routed, and identity by that tree in a fresh admin session', async () => {
    const stack = fakeStack({ routing: SITE_TREE_TARGET });
    const env = await stageMain(stack, {
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [] },
    });

    const outcome = await main([], stack.deps(env));

    const report = await readReport();
    expect(outcome.code).toBe(0);
    // identity's probe logs a fresh gateway session in as admin (three requests) before its tree read.
    expect(report.scaleToZero).toStrictEqual(
      RESTART_SERVICES.map((service) => scaleRow(service, service === 'identity' ? 120 : service === 'strategies-content' ? 105 : null)),
    );
    expect(withoutKinds(report, 'legacy-served')).toStrictEqual(notTargetFindings('v9103', ['identity', 'strategies-content']));
    // Per service, one tree read while it was stopped (502) and its first success after the restart.
    expect(count(stack.requests, `GET ${GATEWAY}${SITE_TREE}`)).toBe(4);
  });

  it('exits 1 through runCli when a restarted service never answers /healthz, measuring the others', async () => {
    const stack = fakeStack({ neverHealthy: ['strategies-content'] });
    const env = await stageMain(stack, {
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [] },
    });
    const lines: string[] = [];
    const exits: number[] = [];

    await expect(runCli((argv) => main(argv, stack.deps(env)), cliIo(lines, exits))).resolves.toBe(1);

    expect(exits).toStrictEqual([1]);
    const report = await readReport();
    expect(JSON.parse(lines.join(''))).toStrictEqual({
      command: 'performance',
      ok: false,
      code: 1,
      report: reportsPath('performance.json'),
      latencySets: allSets().length,
      findings: report.findings.length,
      unhealthy: true,
    });
    expect(withoutKinds(report, 'legacy-served', 'probe-not-target')).toStrictEqual([
      {
        kind: 'cold-start-timeout',
        subject: 'strategies-content',
        detail: `${healthUrlOf(stack, 'strategies-content')} did not answer 200 within ${POLL_LIMIT_MS} ms`,
      },
    ]);
    expect(report.coldStart.map((row) => [row.service, row.startToFirst200Ms])).toStrictEqual(
      RESTART_SERVICES.map((service) => [service, service === 'strategies-content' ? null : 100]),
    );
    expect(report.scaleToZero.find((row) => row.service === 'strategies-content')?.stopToFirstSuccessMs).toBeNull();
  });

  it('records feed-cleanup-failed and exits 1 after writing the report when legacy still serves the deleted collection', async () => {
    const stack = fakeStack({ feed: { ignoreDelete: true } });
    const env = await stageMain(stack, {
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [] },
    });

    const outcome = await main([], stack.deps(env));

    const report = await readReport();
    expect(outcome).toStrictEqual({
      code: 1,
      summary: { report: reportsPath('performance.json'), latencySets: allSets().length, findings: report.findings.length, unhealthy: true },
    });
    expect(withoutKinds(report, 'legacy-served', 'probe-not-target')).toStrictEqual([
      {
        kind: 'feed-cleanup-failed',
        subject: 'content-reads.feed',
        detail: `GET ${FEED_READ} still answered 200 on legacy ${POLL_LIMIT_MS} ms after deleting collection ${NEW_FEED_ID}`,
      },
    ]);
    expect(report.latency.find((row) => row.set === 'content-reads.feed')?.requests).toBe(REQUESTS_PER_SET);
    expect(stack.spawned.size).toBe(RESTART_SERVICES.length);
  });

  it.each<{ label: string; opts: StackOptions; message: string; feedPosts: number }>([
    {
      label: 'the gateway has no active cut-over version',
      opts: { activeVersion: null },
      message: 'the gateway has no active cut-over version',
      feedPosts: 0,
    },
    {
      label: 'the gateway never serves the created collection, deleting it first',
      opts: { feed: { unservedOnGateway: true } },
      message: `GET ${FEED_READ} did not answer 200 on both sides within ${POLL_LIMIT_MS} ms`,
      feedPosts: 2,
    },
  ])('fails without writing a report or restarting anything when $label', async ({ opts, message, feedPosts }) => {
    const stack = fakeStack(opts);
    const env = await stageMain(stack);
    await expect(main([], stack.deps(env))).rejects.toThrow(message);
    expect(stack.feeds.posts).toHaveLength(feedPosts);
    expect([...stack.feeds.feeds.keys()]).toStrictEqual([LEFTOVER_FEED_ID]);
    expect(stack.spawned.size).toBe(0);
    expect(existsSync(reportsPath('performance.json'))).toBe(false);
  });

  it.each(['legacy', 'gateway'] as const)('fails before measuring when the %s admin login is refused', async (side) => {
    const stack = fakeStack({ refuse: side });
    const env = await stageMain(stack);
    await expect(main([], stack.deps(env))).rejects.toThrow(`${side} admin: admin login as admin was refused (status 200 at /admin/)`);
    expect(stack.spawned.size).toBe(0);
    expect(existsSync(reportsPath('performance.json'))).toBe(false);
  });

  it.each([
    ['is not JSON', '{"minInstanceCounts":', 'terraform-plan.json: is not valid JSON'],
    ['does not match its schema', JSON.stringify({ minInstanceCounts: { gateway: 'zero' } }), 'terraform-plan.json: does not match its schema'],
  ])('fails without writing a report when terraform-plan.json %s', async (_label, text, message) => {
    const stack = fakeStack();
    const env = await stageMain(stack, { plan: text });
    await expect(main([], stack.deps(env))).rejects.toThrow(message);
    expect(existsSync(reportsPath('performance.json'))).toBe(false);
  });

  it.each([
    {
      label: 'an unknown flag with exit 2 and the usage text',
      argv: ['--requests', '10'],
      code: 2,
      line: { error: { type: 'UsageError', message: expect.stringContaining("Unknown option '--requests'") }, usage: USAGE },
    },
    {
      label: 'a missing up.json with exit 1',
      argv: [],
      code: 1,
      line: { error: { type: 'UpStateMissingError', message: expect.stringContaining('run harness/repro/up.sh first') } },
    },
  ])('rejects $label before any request', async ({ argv, code, line }) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetch = vi.fn<FetchLike>();
    const env: EnvLike = { OPT2_STATE_DIR: path.join(tmp, 'state'), OPT2_REPORTS_DIR: reportsPath() };
    const lines: string[] = [];
    const exits: number[] = [];

    await expect(runCli((args) => main(args, { env, fetch }), { ...cliIo(lines, exits), argv })).resolves.toBe(code);

    expect(exits).toStrictEqual([code]);
    expect(JSON.parse(lines.join(''))).toMatchObject({ command: 'performance', ok: false, code, ...line });
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(reportsPath())).toBe(false);
  });

  it('prints the help text naming its environment for --help, exits 0 and neither reads up.json nor sends a request', async () => {
    const stack = fakeStack();
    const env = await stageMain(stack);
    const readUp = vi.fn(readUpState);
    const lines: string[] = [];
    const exits: number[] = [];

    const cli = runCli((args) => main(args, { ...stack.deps(env), readUpState: readUp }), { ...cliIo(lines, exits), argv: ['--help'] });
    await expect(cli).resolves.toBe(0);

    const text = lines.join('');
    expect(exits).toStrictEqual([0]);
    expect(text.startsWith(`${USAGE}\n`)).toBe(true);
    for (const name of [
      'OPT2_STATE_DIR',
      'OPT2_REPORTS_DIR',
      'OPT2_CUTOVER_DIR',
      'LEGACY_ORIGIN',
      'OPT2_GATEWAY_URL',
      'MURA_ADMIN_PASSWORD',
      '--help',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).not.toMatch(/^\{/m);
    expect(readUp).not.toHaveBeenCalled();
    expect(stack.requests).toStrictEqual([]);
    expect(stack.spawned.size).toBe(0);
    expect(existsSync(reportsPath('performance.json'))).toBe(false);
  });

  it('falls back to the global fetch, process.kill, the system clock and timers, and up.json in OPT2_STATE_DIR', async () => {
    const stack = fakeStack({ healthFailures: 1 });
    const env = await stageMain(stack, {
      plan: { minInstanceCounts: { ...EXPECTED_MIN_INSTANCES } },
      windows: { windows: [] },
    });
    vi.stubGlobal('fetch', stack.fetch);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      stack.kill(pid, (signal ?? 'SIGTERM') as NodeJS.Signals | 0);
      return true;
    });

    const outcome = await main([], { env, spawn: stack.spawn, invoker: INVOKER });

    expect(outcome.code).toBe(0);
    expect(count(stack.requests, `GET ${LEGACY}${CSETTINGS}`)).toBe(REQUESTS_PER_SET);
    for (const service of RESTART_SERVICES) expect(kill).toHaveBeenCalledWith(-(stack.entries[service]?.pid ?? 0), 'SIGTERM');
    expect(stack.clock.sleep).not.toHaveBeenCalled();
    const report = await readReport();
    for (const row of report.coldStart) expect(row.startToFirst200Ms).toBeGreaterThan(0);
    expect(report.scaleToZero.filter((row) => row.stopToFirstSuccessMs !== null).map((row) => row.service)).toStrictEqual([
      ...TARGET_PROBED,
    ]);
    const { processes } = readUpState({ env });
    expect(RESTART_SERVICES.map((service) => processes[service]?.pid)).toStrictEqual(
      RESTART_SERVICES.map((service) => stack.spawned.get(service)),
    );
  });
});

describe('script entry', () => {
  it('runs main through runCli when node starts this module, exiting 2 with the usage text on an unknown flag', async () => {
    process.argv = [process.execPath, path.join(REPO_ROOT, 'harness', 'src', 'performance', 'run.ts'), '--requests'];
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      rest.find((arg): arg is () => void => typeof arg === 'function')?.();
      return true;
    }) as typeof process.stdout.write);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);

    vi.resetModules();
    await import('../../src/performance/run.js');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    const line = written.find((chunk) => chunk.startsWith('{"command"'));
    expect(JSON.parse(line ?? 'null')).toMatchObject({
      command: 'harness/src/performance/run.ts',
      ok: false,
      code: 2,
      error: { type: 'UsageError', message: expect.stringContaining("Unknown option '--requests'") },
      usage: USAGE,
    });
  });
});
