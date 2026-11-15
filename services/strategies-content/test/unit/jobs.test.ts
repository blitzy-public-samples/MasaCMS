/** Site-monitor step routes over the recording pool: publishBySchedule and doAutoImport as managed Cloud Tasks, behind unit gates. */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ERROR_MAP, apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { GATE_WAIT_MS } from '@opt2/platform/migration-kit';
import { queueDefinition, taskWireBody, type TaskWireBody } from '@opt2/platform/tasks';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, type TenantFixture } from '@opt2/platform/testing';
import { FEED_AUTO_IMPORT_PATH, PUBLISH_SCHEDULED_CHANGESETS_PATH } from '../../src/jobs/index.js';
import { CHANGESET, CONTENT } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, type TestApp } from '../helpers/app.js';
import { IDS, at, changesetRow, contentRow, feedRow } from '../helpers/seed.js';
import { underSleptClock } from '../helpers/slept-clock.js';
import { contentHeaders, serviceHeaders, tasksHeaders } from '../helpers/tokens.js';

// The gate polls sleep through node:timers/promises; inside underSleptClock each sleep moves the faked Date instead of waiting.
vi.mock('node:timers/promises', async (importOriginal) =>
  (await import('../helpers/slept-clock.js')).sleptTimersPromises(await importOriginal<typeof import('node:timers/promises')>()),
);

type Row = Record<string, unknown>;

const PUBLISH_QUEUE = 'content-scheduled-publish';
const FEED_QUEUE = 'content-feed-import';
const THE_TIME = '2026-06-30T10:15:00.000';
const CUTOFF = at('2026-06-30T10:15:00');
const LAST_MONITORED = '2026-06-30T10:00:00.000';
const SITE_TREE_MODULE = '00000000000000000000000000000000000';

const A_LATE = 'A4100000-0000-0000-0000000000000001';
const A_EARLY = 'A4100000-0000-0000-0000000000000002';
const A_AFTER_THE_TIME = 'A4100000-0000-0000-0000000000000003';
const A_FUTURE = 'A4100000-0000-0000-0000000000000004';
const A_PUBLISHED = 'A4100000-0000-0000-0000000000000005';
const A_UNDATED = 'A4100000-0000-0000-0000000000000006';
const A_AT_CLOCK = 'A4100000-0000-0000-0000000000000007';
const A_MINUTE_AFTER_CLOCK = 'A4100000-0000-0000-0000000000000008';
const B_DUE = 'B4100000-0000-0000-0000000000000001';
const B_FUTURE = 'B4100000-0000-0000-0000000000000002';
const U_FUTURE = 'C4100000-0000-0000-0000000000000001';

const A_INACTIVE_FEED = 'A9000000-0000-0000-0000000000000004';
const B_AUTO_FEED = 'B9000000-0000-0000-0000000000000001';
const AUTO_URL = 'https://feeds.example.org/opt2.rss';
const MANUAL_URL = 'https://feeds.example.org/opt2-digest.rss';
const INACTIVE_URL = 'https://feeds.example.org/opt2-archive.rss';
const LOCAL_URL = 'https://feeds.example.org/opt2-local.rss';
const B_URL = 'https://feeds.example.org/tenant-b.rss';

const FIRST_GUID = 'urn:opt2:story:1';
const FIRST_LINK = 'https://feeds.example.org/stories/1';
const SECOND_LINK = 'https://feeds.example.org/stories/2';

/** RSS 2.0 body every stubbed fetch answers: the first item has a guid, the second only a link. */
const RSS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<rss version="2.0"><channel><title>OPT-2 News</title><link>https://feeds.example.org/</link><description>News</description>',
  `<item><title>First Story</title><link>${FIRST_LINK}</link><guid>${FIRST_GUID}</guid><pubDate>Tue, 30 Jun 2026 08:00:00 GMT</pubDate><description>First summary</description></item>`,
  `<item><title>Second Story</title><link>${SECOND_LINK}</link><pubDate>Tue, 30 Jun 2026 09:00:00 GMT</pubDate><description>Second summary</description></item>`,
  '</channel></rss>',
].join('\n');

const DUE_SELECT =
  /^SELECT changesetid FROM "content"\."changeset" WHERE tenant_id = \$1 AND published = 0 AND publishdate IS NOT NULL AND publishdate <= \$2 ORDER BY publishdate ASC, changesetid$/;
const CHANGESET_BY_ID = /^SELECT \* FROM "content"\."changeset" WHERE (?:tenant_id|"tenant_id") = \$1 AND \(?"?changesetid"? = /;
const CHANGESET_UPDATE = /^UPDATE "content"\."changeset" SET (.+) WHERE (.+) RETURNING \*$/;
const REMOTE_FEEDS =
  /^SELECT tcontentfeeds\.feedid, .* FROM "content"\."feed" tcontentfeeds WHERE tcontentfeeds\.siteid = \$1 AND lower\(rtrim\(tcontentfeeds\.type\)\) = lower\(rtrim\(\$2::text\)\) AND tcontentfeeds\.isactive = 1 ORDER BY lower\(tcontentfeeds\.name\) ASC NULLS FIRST, tcontentfeeds\.feedid$/;
const FEED_BY_ID = /^SELECT tcontentfeeds\.feedid, .* FROM "content"\."feed" tcontentfeeds WHERE tcontentfeeds\.feedid = ANY\(\$1::bpchar\[\]\) ORDER BY tcontentfeeds\.feedid LIMIT 1$/;
const CONTENT_BY_ID = /^SELECT tcontent\.active, .* WHERE tcontent\.contentid = ANY\(/;
const CONTENT_INSERT = /^INSERT INTO "content"\."content" \(([^)]*)\) VALUES /;

/** hash(s, 'CFMX_COMPAT') of ASCII text: uppercase hex MD5. */
const cfmxCompatHash = (text: string): string => createHash('md5').update(text, 'latin1').digest('hex').toUpperCase();

/** A bound id or id list as SQL Server's case-insensitive collation compares it. */
const ciForms = (value: unknown): string[] => [value].flat().map((item) => String(item).trimEnd().toLowerCase());

/** The parameter `sql` binds to `column` by `= $n` or `= ANY($n`; undefined when the column is not bound. */
function boundParam(sql: string, params: readonly unknown[], column: string): unknown {
  const match = new RegExp(`(?<![\\w.])"?${column.replace(/\./g, '\\.')}"? = (?:ANY\\()?\\$(\\d+)`).exec(sql);
  return match?.[1] === undefined ? undefined : params[Number(match[1]) - 1];
}

/** True when `row[column]` equals the value `sql` binds to `column`, or when the column is not bound. */
function matchesBound(row: Row, sql: string, params: readonly unknown[], column: string): boolean {
  const wanted = boundParam(sql, params, column);
  return wanted === undefined || ciForms(wanted).includes(String(row[column.replace(/^\w+\./, '')]).trimEnd().toLowerCase());
}

const time = (value: unknown): number => (value instanceof Date ? value.getTime() : Number.NaN);

/** The tenant-scoped rows the route reads and writes, and the writes it made. */
interface Model {
  changesets: Row[];
  feeds: Row[];
  content: Row[];
  /** Each change-set UPDATE, with the tenant of its transaction. */
  publishes: Array<{ tenantId: string | null; changesetId: unknown; published: unknown; publishdate: unknown; lastupdateby: unknown }>;
  /** Each content version INSERT, with the tenant of its transaction. */
  imports: Array<{ tenantId: string | null; row: Row }>;
}

/** A `tchangesets` row of `tenant` last saved by a release manager. */
function changeset(changesetid: string, publishdate: Date | null, opts: { published?: number; tenant?: TenantFixture } = {}): Row {
  const { published = 0, tenant = TENANT_A } = opts;
  return {
    ...changesetRow({ changesetid, name: changesetid, publishdate, published, lastupdateby: 'Release Manager' }),
    tenant_id: tenant.tenantId,
    siteid: tenant.siteId,
  };
}

function changesetSeed(): Row[] {
  // Listed late-first and with ids out of date order, so only publishdate gives the legacy order.
  return [
    changeset(A_LATE, at('2026-06-30T09:30:00')),
    changeset(A_EARLY, at('2026-06-30T08:00:00')),
    changeset(A_AFTER_THE_TIME, at('2026-06-30T11:00:00')),
    changeset(A_FUTURE, at('2026-07-01T08:00:00')),
    changeset(A_PUBLISHED, at('2026-06-30T07:00:00'), { published: 1 }),
    changeset(A_UNDATED, null),
    changeset(B_DUE, CUTOFF, { tenant: TENANT_B }),
    changeset(B_FUTURE, at('2026-07-01T08:00:00'), { tenant: TENANT_B }),
    changeset(U_FUTURE, at('2026-07-15T08:00:00'), { tenant: TENANT_UMBRELLA }),
  ];
}

function feedSeed(): Row[] {
  const remote = (overrides: Parameters<typeof feedRow>[0]): Row => ({ ...feedRow({ type: 'Remote', parentid: IDS.content.section, ...overrides }) });
  return [
    remote({ feedid: IDS.feeds.remoteAuto, name: 'Remote News', channellink: AUTO_URL, autoimport: 1 }),
    remote({ feedid: IDS.feeds.remoteManual, name: 'Remote Digest', channellink: MANUAL_URL, autoimport: 0 }),
    remote({ feedid: A_INACTIVE_FEED, name: 'Remote Archive', channellink: INACTIVE_URL, autoimport: 1, isactive: 0 }),
    { ...feedRow({ feedid: IDS.feeds.local, name: 'Latest News', channellink: LOCAL_URL, autoimport: 1 }) },
    remote({
      tenant_id: TENANT_B.tenantId,
      siteid: TENANT_B.siteId,
      feedid: B_AUTO_FEED,
      name: 'B News',
      parentid: IDS.content.bPage,
      channellink: B_URL,
      autoimport: 1,
    }),
  ];
}

function contentSeed(): Row[] {
  return [
    { ...contentRow({ contentid: IDS.content.section, contenthistid: IDS.hist.sectionActive, type: 'Folder', title: 'Section', filename: 'section' }) },
    {
      ...contentRow({ contentid: IDS.content.bPage, contenthistid: IDS.hist.bPageActive, title: 'B Page', filename: 'b-page' }),
      tenant_id: TENANT_B.tenantId,
      siteid: TENANT_B.siteId,
    },
  ];
}

/** Answers the change-set, feed and content statements of both steps over `model`, as forced RLS and their predicates select. */
function installResponders(db: TestApp['db'], model: Model): void {
  const own = (rows: Row[], tenantId: string | null): Row[] => rows.filter((row) => row.tenant_id === tenantId);

  db.respond(DUE_SELECT, (params, _sql, { tenantId }) =>
    own(model.changesets, tenantId)
      .filter((row) => row.published === 0 && row.publishdate !== null && time(row.publishdate) <= time(params[1]))
      .sort((x, y) => time(x.publishdate) - time(y.publishdate) || String(x.changesetid).localeCompare(String(y.changesetid)))
      .map((row) => ({ changesetid: row.changesetid })),
  );
  db.respond(CHANGESET_BY_ID, (params, sql, { tenantId }) =>
    own(model.changesets, tenantId)
      .filter((row) => matchesBound(row, sql, params, 'changesetid'))
      .map((row) => ({ ...row })),
  );
  db.respond(CHANGESET_UPDATE, (params, sql, { tenantId }) => {
    const [, assignments = '', where = ''] = CHANGESET_UPDATE.exec(sql) ?? [];
    const row = own(model.changesets, tenantId).find((candidate) => matchesBound(candidate, where, params, 'changesetid'));
    if (row === undefined) return [];
    for (const [, column = '', index = ''] of assignments.matchAll(/"(\w+)" = \$(\d+)/g)) row[column] = params[Number(index) - 1];
    model.publishes.push({ tenantId, changesetId: row.changesetid, published: row.published, publishdate: row.publishdate, lastupdateby: row.lastupdateby });
    return [{ ...row }];
  });

  db.respond(REMOTE_FEEDS, (params, _sql, { tenantId }) =>
    own(model.feeds, tenantId)
      .filter((row) => ciForms(row.siteid)[0] === ciForms(params[0])[0] && ciForms(row.type)[0] === ciForms(params[1])[0] && row.isactive === 1)
      .sort((x, y) => String(x.name).toLowerCase().localeCompare(String(y.name).toLowerCase()) || String(x.feedid).localeCompare(String(y.feedid)))
      .map((row) => ({ ...row })),
  );
  db.respond(FEED_BY_ID, (params, _sql, { tenantId }) =>
    own(model.feeds, tenantId)
      .filter((row) => ciForms(params[0]).includes(String(row.feedid).toLowerCase()))
      .map((row) => ({ ...row })),
  );
  db.respond(CONTENT_BY_ID, (params, sql, { tenantId }) =>
    own(model.content, tenantId)
      .filter((row) => row.active === 1 && matchesBound(row, sql, params, 'tcontent.contentid') && matchesBound(row, sql, params, 'tcontent.siteid'))
      .map((row) => ({ ...row })),
  );
  db.respond(CONTENT_INSERT, (params, sql, { tenantId }) => {
    const columns = (CONTENT_INSERT.exec(sql)?.[1] ?? '').split(', ').map((column) => column.replace(/"/g, ''));
    const row: Row = { ...Object.fromEntries(columns.map((column, i) => [column, params[i] ?? null])), tcontent_id: model.content.length + 1 };
    model.content.push(row);
    model.imports.push({ tenantId, row });
    return [row];
  });
}

/** The wire body the task adapters POST for one `queue` task the programs-sites orchestrator creates. */
function stepTask(queue: typeof PUBLISH_QUEUE | typeof FEED_QUEUE, payload: Row, tenantId?: string): TaskWireBody {
  const { targetPath, deadlineS } = queueDefinition(queue);
  return taskWireBody({
    queue,
    name: `${queue}-1782814500`,
    scheduleTime: TEST_CLOCK.now(),
    url: `http://127.0.0.1:8114${targetPath}`,
    deadlineS,
    body: payload,
    ...(tenantId === undefined ? {} : { tenantId }),
  });
}

const publishTask = (payload: Row = { step: 'publishScheduledChangesets', theTime: THE_TIME, lastMonitored: LAST_MONITORED }, tenantId?: string): TaskWireBody =>
  stepTask(PUBLISH_QUEUE, payload, tenantId);

const feedTask = (extra: Row = {}, tenantId?: string): TaskWireBody =>
  stepTask(FEED_QUEUE, { step: 'feedAutoImport', theTime: THE_TIME, lastMonitored: LAST_MONITORED, ...extra }, tenantId);

const unavailable = apiUnavailableResponse();

const legacyError = (type: 'badRequest' | 'authorization' | 'invalidParameters'): Row => ({
  apiversion: 'v1',
  method: 'invalid',
  error: { message: LEGACY_ERROR_MAP[type].message, code: LEGACY_ERROR_MAP[type].code },
});

let t: TestApp;
let model: Model;
const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
  new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml; charset=utf-8' } }),
);
const fetchedUrls = (): string[] => fetchMock.mock.calls.map(([input]) => String(input));

/** POSTs `body` to `url` with the tasks-invoker credential of its path unless `headers` replaces it. */
async function post(url: string, body: TaskWireBody, headers?: Record<string, string>) {
  const credential = headers ?? (await tasksHeaders(url.split('?')[0] ?? url));
  return t.app.inject({ method: 'POST', url, headers: { ...credential, 'content-type': 'application/json' }, payload: body });
}

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.db.reset();
  model = { changesets: changesetSeed(), feeds: feedSeed(), content: contentSeed(), publishes: [], imports: [] };
  installResponders(t.db, model);
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe(`POST ${PUBLISH_SCHEDULED_CHANGESETS_PATH}`, () => {
  const ALL_TENANTS = [TENANT_A, TENANT_B, TENANT_UMBRELLA];
  /** Tenant and cutoff of each due-change-set select, in run order. */
  const dueSelects = (): Array<[string | null, number]> =>
    t.db.statements.filter((statement) => DUE_SELECT.test(statement.sql)).map((statement) => [statement.tenantId, time(statement.params[1])]);
  const publishedIds = (): unknown[] => model.publishes.map(({ changesetId }) => changesetId);
  const publishedBy = (tenant: TenantFixture, changesetId: string) => ({
    tenantId: tenant.tenantId,
    changesetId,
    published: 1,
    publishdate: TEST_CLOCK.now(),
    lastupdateby: 'Release Manager',
  });

  it('publishes the change sets due by theTime in every registered tenant, earliest first, each in its own tenant transaction', async () => {
    const res = await post(PUBLISH_SCHEDULED_CHANGESETS_PATH, publishTask());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      step: 'publishScheduledChangesets',
      changesets: [
        { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, changesetId: A_EARLY, published: true },
        { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, changesetId: A_LATE, published: true },
        { tenantId: TENANT_B.tenantId, siteId: TENANT_B.siteId, changesetId: B_DUE, published: true },
      ],
    });
    expect(dueSelects()).toEqual(ALL_TENANTS.map((tenant) => [tenant.tenantId, CUTOFF.getTime()]));
    // No session user: the publish stamps published and now(), and keeps the last editor.
    expect(model.publishes).toEqual([publishedBy(TENANT_A, A_EARLY), publishedBy(TENANT_A, A_LATE), publishedBy(TENANT_B, B_DUE)]);
    const untouched = new Set([A_AFTER_THE_TIME, A_FUTURE, A_PUBLISHED, A_UNDATED, B_FUTURE, U_FUTURE]);
    const unchanged = (rows: Row[]): Row[] => rows.filter((row) => untouched.has(String(row.changesetid)));
    expect(unchanged(model.changesets)).toEqual(unchanged(changesetSeed()));
    expect(new Set(t.db.writes().map((statement) => statement.tenantId))).toEqual(new Set([TENANT_A.tenantId, TENANT_B.tenantId]));
  });

  it('publishes nothing more when the same task is delivered again', async () => {
    await post(PUBLISH_SCHEDULED_CHANGESETS_PATH, publishTask());
    const writes = t.db.writes().length;

    const retried = await post(PUBLISH_SCHEDULED_CHANGESETS_PATH, publishTask());

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ step: 'publishScheduledChangesets', changesets: [] });
    expect(t.db.writes()).toHaveLength(writes);
    expect(publishedIds()).toEqual([A_EARLY, A_LATE, B_DUE]);
  });

  it('selects by the injected clock without theTime: due at the clock instant, not one minute after', async () => {
    const now = TEST_CLOCK.now();
    model.changesets.push(changeset(A_AT_CLOCK, now), changeset(A_MINUTE_AFTER_CLOCK, new Date(now.getTime() + 60_000)));

    const res = await post(PUBLISH_SCHEDULED_CHANGESETS_PATH, publishTask({ step: 'publishScheduledChangesets', lastMonitored: LAST_MONITORED }));

    expect(res.statusCode).toBe(200);
    expect(dueSelects()).toEqual(ALL_TENANTS.map((tenant) => [tenant.tenantId, now.getTime()]));
    expect(publishedIds()).toEqual([A_EARLY, A_LATE, A_AFTER_THE_TIME, A_AT_CLOCK, B_DUE]);
    expect(model.changesets.find((row) => row.changesetid === A_MINUTE_AFTER_CLOCK)).toMatchObject({ published: 0 });
  });

  it.each([
    ['a word', 'yesterday'],
    ['a date without a time', '2026-06-30'],
    ['a timestamp with an offset', '2026-06-30T10:15:00.000Z'],
  ])('refuses theTime as %s with legacy invalidParameters before any statement', async (_label, theTime) => {
    const res = await post(PUBLISH_SCHEDULED_CHANGESETS_PATH, publishTask({ step: 'publishScheduledChangesets', theTime, lastMonitored: LAST_MONITORED }));

    expect(res.statusCode).toBe(LEGACY_ERROR_MAP.invalidParameters.status);
    expect(res.json()).toEqual(legacyError('invalidParameters'));
    expect(t.db.statements).toEqual([]);
  });
});

describe(`POST ${FEED_AUTO_IMPORT_PATH}`, () => {
  const importedPage = (tenant: TenantFixture, parentid: string): Row => ({
    tenant_id: tenant.tenantId,
    siteid: tenant.siteId,
    parentid,
    type: 'Page',
    moduleid: SITE_TREE_MODULE,
    approved: 1,
    active: 1,
    display: 1,
    isnav: 1,
  });

  it('imports every item of the active autoimport remote feeds of ?siteid=, last item first, keyed by the guid or link hash', async () => {
    const res = await post(`${FEED_AUTO_IMPORT_PATH}?siteid=${TENANT_A.siteId}`, feedTask());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ step: 'feedAutoImport', siteId: TENANT_A.siteId, feeds: 1 });
    // getFeeds(siteid, 'Remote', 0, 1): active remote feeds only; the autoimport flag then picks among them.
    expect(t.db.statements.filter((statement) => REMOTE_FEEDS.test(statement.sql)).map(({ tenantId, params }) => [tenantId, params])).toEqual([
      [TENANT_A.tenantId, [TENANT_A.siteId, 'Remote']],
    ]);
    expect(fetchedUrls()).toEqual([AUTO_URL]);
    expect(model.imports.map(({ tenantId }) => tenantId)).toEqual([TENANT_A.tenantId, TENANT_A.tenantId]);
    expect(model.imports.map(({ row }) => row)).toEqual([
      expect.objectContaining({
        ...importedPage(TENANT_A, IDS.content.section),
        title: 'Second Story',
        remoteid: cfmxCompatHash(SECOND_LINK),
        remoteurl: SECOND_LINK,
        summary: 'Second summary',
      }),
      expect.objectContaining({
        ...importedPage(TENANT_A, IDS.content.section),
        title: 'First Story',
        remoteid: cfmxCompatHash(FIRST_GUID),
        remoteurl: FIRST_LINK,
        summary: 'First summary',
      }),
    ]);
  });

  it.each<[string, string, Row, TenantFixture, string, string]>([
    ['the payload siteId when the query has none', FEED_AUTO_IMPORT_PATH, { siteId: TENANT_A.siteId }, TENANT_A, AUTO_URL, IDS.content.section],
    ['the query before the payload siteId', `${FEED_AUTO_IMPORT_PATH}?siteid=${TENANT_B.siteId}`, { siteId: TENANT_A.siteId }, TENANT_B, B_URL, IDS.content.bPage],
    ['the query in any case, answering the registered spelling', `${FEED_AUTO_IMPORT_PATH}?siteid=TENANT-A`, {}, TENANT_A, AUTO_URL, IDS.content.section],
  ])('takes the site from %s', async (_label, url, extra, tenant, fetched, parentid) => {
    const res = await post(url, feedTask(extra));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ step: 'feedAutoImport', siteId: tenant.siteId, feeds: 1 });
    expect(fetchedUrls()).toEqual([fetched]);
    expect(model.imports).toEqual([
      { tenantId: tenant.tenantId, row: expect.objectContaining(importedPage(tenant, parentid)) },
      { tenantId: tenant.tenantId, row: expect.objectContaining(importedPage(tenant, parentid)) },
    ]);
  });

  it.each([
    ['without a site', FEED_AUTO_IMPORT_PATH],
    ['with an empty siteid', `${FEED_AUTO_IMPORT_PATH}?siteid=`],
    ['for an unregistered site', `${FEED_AUTO_IMPORT_PATH}?siteid=nosuchsite`],
  ])('answers the legacy badRequest %s, opening no tenant transaction and fetching nothing', async (_label, url) => {
    const res = await post(url, feedTask());

    expect(res.statusCode).toBe(LEGACY_ERROR_MAP.badRequest.status);
    expect(res.json()).toEqual(legacyError('badRequest'));
    expect(t.db.statements.filter((statement) => statement.tenantId !== null)).toEqual([]);
    expect(t.db.writes()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** The two step targets as the orchestrator addresses them, each with a task body builder. */
const STEPS: ReadonlyArray<readonly [string, string, (tenantId?: string) => TaskWireBody]> = [
  ['publish', PUBLISH_SCHEDULED_CHANGESETS_PATH, (tenantId) => publishTask(undefined, tenantId)],
  ['feed import', `${FEED_AUTO_IMPORT_PATH}?siteid=${TENANT_A.siteId}`, (tenantId) => feedTask({}, tenantId)],
];

describe('unit gates', () => {
  it.each([
    ['publish', CHANGESET.unit, 'closed', PUBLISH_SCHEDULED_CHANGESETS_PATH, () => publishTask()],
    ['publish', CHANGESET.unit, 'legacy', PUBLISH_SCHEDULED_CHANGESETS_PATH, () => publishTask()],
    ['feed import', CONTENT.unit, 'closed', `${FEED_AUTO_IMPORT_PATH}?siteid=${TENANT_A.siteId}`, () => feedTask()],
    ['feed import', CONTENT.unit, 'legacy', `${FEED_AUTO_IMPORT_PATH}?siteid=${TENANT_A.siteId}`, () => feedTask()],
  ] as const)('answers the %s step with the legacy 503 and writes nothing while %s is %s', async (_step, unit, state, url, body) => {
    t.db.setGate(unit, state);
    const headers = await tasksHeaders(url.split('?')[0] ?? url);

    const { result: res, elapsedMs } = await underSleptClock(() => post(url, body(), headers));

    expect(res.statusCode).toBe(unavailable.status);
    expect(res.body).toBe(unavailable.body);
    expect(res.headers.etag).toBe(unavailable.headers.ETag);
    // A closed gate is waited out for the full budget so the queue's retry finds it reopened; a legacy gate refuses at once.
    if (state === 'closed') expect(elapsedMs).toBeGreaterThanOrEqual(GATE_WAIT_MS);
    else expect(elapsedMs).toBeLessThan(GATE_WAIT_MS);
    expect(t.db.writes()).toEqual([]);
    expect(model.publishes).toEqual([]);
    expect(model.imports).toEqual([]);
  });
});

describe('task transport', () => {
  it.each([
    [PUBLISH_QUEUE, PUBLISH_SCHEDULED_CHANGESETS_PATH],
    [FEED_QUEUE, FEED_AUTO_IMPORT_PATH],
  ])('the orchestrator queue %s targets %s on strategies-content', (queue, path) => {
    expect(queueDefinition(queue)).toMatchObject({ targetService: 'strategies-content', targetPath: path, creators: expect.arrayContaining(['programs-sites']) });
  });

  const CREDENTIALS: ReadonlyArray<readonly [string, () => Promise<Record<string, string>>]> = [
    ['a user token relayed by the gateway', () => contentHeaders('s2')],
    ['the migration service credential', () => serviceHeaders('platform.migration')],
    ['no credential', async () => ({})],
  ];

  it.each(STEPS.flatMap(([step, url, body]) => CREDENTIALS.map(([who, headers]) => [step, who, url, body, headers] as const)))(
    'refuses the %s step presented with %s as legacy authorization, before any statement',
    async (_step, _who, url, body, headers) => {
      const res = await post(url, body(), await headers());

      expect(res.statusCode).toBe(LEGACY_ERROR_MAP.authorization.status);
      expect(res.json()).toEqual(legacyError('authorization'));
      expect(t.db.statements).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(STEPS)('refuses a %s task body that carries a tenant as legacy badRequest, before any statement', async (_step, url, body) => {
    const res = await post(url, body(TENANT_A.tenantId));

    expect(res.statusCode).toBe(LEGACY_ERROR_MAP.badRequest.status);
    expect(res.json()).toEqual(legacyError('badRequest'));
    expect(t.db.statements).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
