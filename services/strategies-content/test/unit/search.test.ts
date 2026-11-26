/** Search (GS-CO-06) over the recording pool: carch.search, public search, JSON API content findQuery and the cnav.searchsitedata raw route. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_ERROR_PAGE_HTML, LEGACY_ERROR_STATUS_TEXT, LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, type TenantFixture } from '@opt2/platform/testing';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import {
  PRIVATE_SEARCH_RECORDS_PER_PAGE,
  contentQueryCriteria,
  findContentQuery,
  privateSearch,
  publicSearch,
  searchSiteData,
  type ContentFeedStep,
  type ContentQueryRequest,
  type PrivateSearchInput,
  type SearchDeps,
  type SiteListRow,
} from '../../src/domain/search.js';
import { renderSearchSiteDataJson } from '../../src/legacy/admin-render-comments.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, type RecordedStatement, type RecordingDb, type TestApp } from '../helpers/app.js';
import { IDS, contentRow, seedRecordingDb, tenantASeed, umbrellaSeed } from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, contentHeaders, type ContentSubject, type TokenSubject } from '../helpers/tokens.js';

type Row = Record<string, unknown>;

const SITE_A = TENANT_A.siteId;
const SEARCH_MODULES = [IDS.modules.content, IDS.modules.components, IDS.modules.forms];
const PDF_FORMS = [IDS.files.pdf, IDS.files.pdf.toLowerCase()];

const PRIVATE_SEARCH = /AS supersort FROM "content"\."content" tcontent LEFT JOIN "content"\."content" tcontent2 /;
const PUBLIC_SEARCH = /AS supersort FROM "content"\."content" tcontent LEFT JOIN "content"\."file" tfiles /;
const FILE_IDS = /^SELECT DISTINCT tcontent\.fileid FROM "content"\."content" tcontent /;
const POOL_MATCHES = /AS matches FROM "content"\."file" tfiles /;
const FILE_COLUMNS = /^SELECT fileid, fileext, filesize, filename AS assocfilename/;
const CATEGORY_PATHS = /^SELECT \* FROM "content"\."category" WHERE tenant_id = \$1 AND upper\(path\) LIKE/;
const FEED_ROWS = /AS keypoints, tcontent\.contentid AS contentid/;
const FEED_COUNT = /^SELECT count\(\*\)::integer AS count FROM "content"\."content" tcontent /;
const CRUMBS = /LEFT JOIN "content"\."approval_assignment" tapprovalassignments /;
const MEMBERSHIPS = /FROM "content"\."membership_projection" /;
const PROJECTIONS = /"content"\."(?:permission|membership|group)_projection"/;
const PLUMBING = /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|^SELECT set_config\(|"content"\."unit_gate"|content\.tenant_registry/;

const seededRows = (seed: ReturnType<typeof tenantASeed>, table: string): Row[] =>
  seed.rows.filter((entry) => entry.table.table === table).map((entry) => ({ ...entry.row }));

const ACTIVE_A = seededRows(tenantASeed(), 'content').filter((row) => row.active === 1);
const UMBRELLA_FILES = seededRows(umbrellaSeed(), 'file');
const MEMBERSHIPS_A = seededRows(tenantASeed(), 'membership_projection');

/** The active seeded version of a tenant-a node. */
function nodeA(contentId: string): Row {
  const row = ACTIVE_A.find((candidate) => candidate.contentid === contentId);
  if (row === undefined) throw new Error(`tenant-a seeds no active node ${contentId}`);
  return row;
}

/** The seeded umbrella `tfiles` row of `fileId`. */
function fileOf(fileId: string): Row {
  const row = UMBRELLA_FILES.find((candidate) => candidate.fileid === fileId);
  if (row === undefined) throw new Error(`umbrella seeds no file ${fileId}`);
  return row;
}

/** A getPrivateSearch row of a version, its file columns unjoined as a pooled site's query leaves them. */
const searchRow = (row: Row, overrides: Row = {}): Row => ({
  ...row,
  haskids: 0,
  priority: 2,
  supersort: 1,
  filesize: null,
  fileext: null,
  assocfilename: null,
  filealttext: null,
  lockid: null,
  locktype: null,
  ...overrides,
});

/** A getPublicSearch row of a version, its file columns unjoined as a pooled site's query leaves them. */
const publicRow = (row: Row): Row => ({
  ...row,
  comments: 0,
  kids: 0,
  parenttype: 'Page',
  sortdate: row.created,
  priority: 0,
  supersort: 1,
  filesize: null,
  fileext: null,
  assocfilename: null,
  filealttext: null,
  rating: null,
  totalvotes: null,
  downvotes: null,
  upvotes: null,
  lockid: null,
  locktype: null,
});

/** The verified actor of a token subject, on `tenant` instead of its own site when given. */
function actorOf(subject: TokenSubject, tenant?: Pick<TenantFixture, 'siteId' | 'tenantId'>): Actor {
  const claims = SUBJECT_CLAIMS[subject];
  return actorFromClaims(
    {
      iss: 'opt2-local-identity',
      aud: 'opt2-local',
      sub: SUBJECT_USER_IDS[subject],
      sid: `session-${subject}`,
      tid: tenant?.tenantId ?? claims.tid,
      site: tenant?.siteId ?? claims.site,
      roles: [...claims.roles],
      s2: claims.s2,
      epoch: 1,
      iat: 1_782_820_800,
      exp: 1_782_821_100,
    },
    'Test User',
  );
}

const ADMIN_A = actorOf('s2');
const ADMIN_B = actorOf('other-tenant');
const ADMIN_UMBRELLA = actorOf('s2', TENANT_UMBRELLA);
const EDITOR_A = actorOf('editor');
const MEMBER_A = actorOf('member');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The values `statement` binds at each `$n` of `fragment`, in SQL order. */
function bound(statement: RecordedStatement | undefined, fragment: string): unknown[] {
  if (statement === undefined) throw new Error(`no recorded statement to read ${fragment} from`);
  const pattern = new RegExp(escapeRegExp(fragment).replaceAll('\\$n', () => '\\$(\\d+)'), 'g');
  return [...statement.sql.matchAll(pattern)].map((match) => statement.params[Number(match[1]) - 1]);
}

/** A recording pool answering every seeded table, plus the pooled-file reads the searches of tenant-a make in the umbrella pool. */
function seededDb(): RecordingDb {
  const db = createRecordingDb();
  seedRecordingDb(db);
  db.respond(FILE_IDS, (_params, _sql, ctx) =>
    ctx.tenantId === TENANT_A.tenantId ? ACTIVE_A.filter((row) => row.fileid !== null).map((row) => ({ fileid: row.fileid })) : [],
  );
  db.respond(POOL_MATCHES, (params) => {
    // `%kw%` leads the params unless the keywords are empty; the file ids come last.
    const keyword = typeof params[0] === 'string' ? params[0].slice(1, -1).toLowerCase() : null;
    const listed = params.at(-1) as string[];
    return UMBRELLA_FILES.filter((file) => listed.includes(String(file.fileid))).map((file) => ({
      fileid: file.fileid,
      matches: keyword !== null && String(file.filename).toLowerCase().includes(keyword),
    }));
  });
  db.respond(FILE_COLUMNS, (params, _sql, ctx) =>
    ctx.tenantId !== TENANT_UMBRELLA.tenantId
      ? []
      : UMBRELLA_FILES.filter((file) => (params[0] as string[]).includes(String(file.fileid))).map((file) => ({
          fileid: file.fileid,
          fileext: file.fileext,
          filesize: file.filesize,
          assocfilename: file.filename,
          contenttype: file.contenttype,
          contentsubtype: file.contentsubtype,
        })),
  );
  return db;
}

const depsOf = (db: RecordingDb): SearchDeps => ({ db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK });

/** The `title` of each row; a projection or blank row may hold none. */
const titles = (rows: readonly object[]): unknown[] => rows.map((row) => (row as { title?: unknown }).title);

describe('privateSearch (carch.search)', () => {
  let db: RecordingDb;
  let deps: SearchDeps;
  const ran = (pattern: RegExp): RecordedStatement[] => db.statements.filter((statement) => pattern.test(statement.sql));
  const workTenants = (): Array<string | null> => db.statements.filter((statement) => !PLUMBING.test(statement.sql)).map((statement) => statement.tenantId);
  const search = (actor: Actor, input: Partial<PrivateSearchInput>) => privateSearch(deps, actor, { siteId: actor.siteId, keywords: '', startRow: 1, ...input });

  beforeEach(() => {
    db = seededDb();
    deps = depsOf(db);
  });

  it('matches the keywords in titles, summary, body and extended attributes, exact titles first, in the token tenant', async () => {
    db.respond(PRIVATE_SEARCH, [searchRow(nodeA(IDS.content.pageOne)), searchRow(nodeA(IDS.content.pageTwo))]);
    const result = await search(ADMIN_A, { keywords: 'Page' });
    expect(titles(result.rows)).toEqual(['Page One', 'Page Two']);
    const [statement] = ran(PRIVATE_SEARCH);
    expect(statement?.tenantId).toBe(TENANT_A.tenantId);
    const likes = ['tcontent.title', 'tcontent.menutitle', 'tcontent.summary', 'tcontent.body', 'tclassextenddata.attributevalue'];
    expect(likes.map((column) => bound(statement, `upper(${column}) LIKE upper($n::text)`))).toEqual(likes.map(() => ['%Page%']));
    expect(statement?.sql).toContain("NOT (lower(rtrim(tcontent.type)) IN ('link', 'file')) AND upper(tcontent.body) LIKE");
    expect(bound(statement, 'lower(rtrim(tcontent.title)) = lower(rtrim($n::text))')).toEqual(['Page', 'Page', 'Page', 'Page']);
    expect(statement?.sql).toContain('ORDER BY d.supersort ASC NULLS FIRST, d.priority ASC NULLS FIRST, lower(d.title) ASC NULLS FIRST LIMIT 1000');
    expect(bound(statement, 'tcontent.siteid = $n')).toEqual([SITE_A, SITE_A, SITE_A]);
    expect(bound(statement, 'tcontent.moduleid = ANY($n::bpchar[])')).toEqual([SEARCH_MODULES, SEARCH_MODULES]);
  });

  it.each([1, 31, 61])('returns every row with getNextN 30-row paging from start row %i and the session.keywords effect', async (startRow) => {
    const rows = Array.from({ length: 65 }, (_, i) => searchRow(nodeA(IDS.content.pageOne), { contenthistid: `hist-${String(i)}` }));
    db.respond(PRIVATE_SEARCH, rows);
    const result = await search(ADMIN_A, { keywords: 'About Us', startRow });
    expect(result.rows).toHaveLength(65);
    expect([result.paging, result.sessionEffect]).toEqual([
      { recordsPerPage: PRIVATE_SEARCH_RECORDS_PER_PAGE, startRow },
      { kind: 'keywords', keywords: 'About Us' },
    ]);
    expect(PRIVATE_SEARCH_RECORDS_PER_PAGE).toBe(30);
  });

  it.each([
    {
      name: 'a tag joins the version tags and matches the trimmed tag in place of the keywords',
      input: { tag: ' News ' },
      fragment: 'lower(rtrim(tcontenttags.tag)) = lower(rtrim($n::text))',
      values: ['News'],
      keywordLikes: 0,
    },
    {
      name: 'a section keeps the versions whose path holds it, in both branches',
      input: { keywords: 'Page', sectionId: IDS.content.section },
      fragment: 'upper(tcontent.path) LIKE upper($n::text)',
      values: [`%${IDS.content.section}%`, `%${IDS.content.section}%`],
      keywordLikes: 1,
    },
  ])('narrows the query: $name', async ({ input, fragment, values, keywordLikes }) => {
    db.respond(PRIVATE_SEARCH, []);
    await search(ADMIN_A, input);
    const [statement] = ran(PRIVATE_SEARCH);
    expect(bound(statement, fragment)).toEqual(values);
    expect(bound(statement, 'upper(tcontent.title) LIKE upper($n::text)')).toHaveLength(keywordLikes);
    expect(statement?.sql.includes('INNER JOIN "content"."content_tag" tcontenttags')).toBe('tag' in input);
  });

  it("reads a pooled site's version files in its file-pool tenant and fills their columns there", async () => {
    db.respond(PRIVATE_SEARCH, [searchRow(nodeA(IDS.content.fileNode), { supersort: 0, priority: 1 })]);
    const result = await search(ADMIN_A, { keywords: 'Guide' });
    const pdf = fileOf(IDS.files.pdf);
    expect(result.rows.map((row) => [row.title, row.fileid, row.fileext, row.filesize, row.assocfilename])).toEqual([
      ['Guide', IDS.files.pdf, 'pdf', pdf.filesize, 'guide.pdf'],
    ]);
    expect(workTenants()).toEqual([TENANT_A.tenantId, TENANT_UMBRELLA.tenantId, TENANT_A.tenantId, TENANT_UMBRELLA.tenantId]);
    expect(bound(ran(PRIVATE_SEARCH)[0], 'CASE WHEN tcontent.fileid = ANY($n::bpchar[])')).toEqual([PDF_FORMS, PDF_FORMS]);
  });

  it('searches a site keeping its own files in one statement of its tenant, joining the file table', async () => {
    db.respond(PRIVATE_SEARCH, []);
    await search(ADMIN_B, { keywords: 'Page' });
    expect(workTenants()).toEqual([TENANT_B.tenantId]);
    expect(ran(PRIVATE_SEARCH)[0]?.sql).toContain('LEFT JOIN "content"."file" tfiles ON (tcontent.fileid = tfiles.fileid)');
  });

  it('spans a file search of the pool site over the sites pooling their files there, merged in the gateway order and capped at 1000', async () => {
    const stands = Array.from({ length: 999 }, (_, i) =>
      searchRow(contentRow({ tenant_id: TENANT_UMBRELLA.tenantId, siteid: TENANT_UMBRELLA.siteId, title: `Stand ${String(i).padStart(3, '0')}` }), {
        fileid: IDS.files.image,
        fileext: 'jpg',
        filesize: 1,
        assocfilename: 'photo.jpg',
      }),
    );
    const pooled = [searchRow(nodeA(IDS.content.fileNode), { supersort: 0, priority: 1 }), searchRow(nodeA(IDS.content.pageOne))];
    db.respond(PRIVATE_SEARCH, (_params, _sql, ctx) => (ctx.tenantId === TENANT_UMBRELLA.tenantId ? stands : pooled));
    const result = await search(ADMIN_UMBRELLA, { keywords: 'guide', searchType: 'file' });
    expect(result.rows).toHaveLength(1000);
    expect([...titles(result.rows.slice(0, 3)), result.rows.at(-1)?.title]).toEqual(['Guide', 'Page One', 'Stand 000', 'Stand 997']);
    expect(result.rows[0]?.assocfilename).toBe('guide.pdf');
    const statements = ran(PRIVATE_SEARCH);
    expect(statements.map((statement) => statement.tenantId)).toEqual([TENANT_UMBRELLA.tenantId, TENANT_A.tenantId]);
    for (const statement of statements) {
      expect(bound(statement, 'tcontent.siteid = ANY($n::text[])')).toEqual([
        [TENANT_UMBRELLA.siteId, TENANT_A.siteId],
        [TENANT_UMBRELLA.siteId, TENANT_A.siteId],
      ]);
    }
  });

  it('applies no node permission: an editor gets every row the query returns, restricted ones included, without a projection read', async () => {
    db.respond(PRIVATE_SEARCH, [searchRow(nodeA(IDS.content.restricted)), searchRow(nodeA(IDS.content.pageOne))]);
    const result = await search(EDITOR_A, { keywords: 'e' });
    expect(result.rows.map((row) => [row.title, row.restricted])).toEqual([
      ['Restricted', 1],
      ['Page One', 0],
    ]);
    expect(ran(PROJECTIONS)).toEqual([]);
  });

  it('refuses a token tenant the registry does not hold before any content read', async () => {
    const stranger = actorOf('s2', { siteId: 'nowhere', tenantId: '9f1b2c3d-4e5f-5a6b-8c7d-9e0f1a2b3c4d' });
    await expect(search(stranger, { keywords: 'Page' })).rejects.toMatchObject({ name: 'UnregisteredTenantError' });
    expect(workTenants()).toEqual([]);
  });
});

describe('publicSearch', () => {
  let db: RecordingDb;
  let deps: SearchDeps;
  const ran = (pattern: RegExp): RecordedStatement[] => db.statements.filter((statement) => pattern.test(statement.sql));

  beforeEach(() => {
    db = seededDb();
    deps = depsOf(db);
  });

  it('reads only active, approved, displayable, searchable content of the site at the clock, unreleased and released', async () => {
    db.respond(PUBLIC_SEARCH, [publicRow(nodeA(IDS.content.pageOne)), publicRow(nodeA(IDS.content.restricted))]);
    const rows = await publicSearch(deps, ADMIN_A, { siteId: SITE_A, keywords: 'Page' });
    expect(titles(rows)).toEqual(['Page One', 'Restricted']);
    const [statement] = ran(PUBLIC_SEARCH);
    expect(statement?.tenantId).toBe(TENANT_A.tenantId);
    expect(bound(statement, '(tcontent.active = 1 AND tcontent.approved = 1 AND tcontent.siteid = $n)')).toEqual([SITE_A, SITE_A]);
    expect(bound(statement, 'tcontent.displaystart <= $n')).toEqual([TEST_CLOCK.now(), TEST_CLOCK.now()]);
    expect(bound(statement, 'tcontent.displaystop >= $n')).toEqual([TEST_CLOCK.now(), TEST_CLOCK.now()]);
    expect(statement?.sql).toContain("OR tcontent.display = 1) AND lower(rtrim(tcontent.type)) IN ('page', 'folder', 'calendar', 'file', 'link', 'gallery')");
    expect(['tcontent.releasedate IS NULL', 'tcontent.releasedate IS NOT NULL', 'tcontent.searchexclude = 0'].map((clause) => statement?.sql.split(clause).length)).toEqual([2, 2, 3]);
    const likes = ['title', 'menutitle', 'metakeywords', 'summary', 'body', 'credits'];
    expect(likes.map((column) => bound(statement, `upper(tcontent.${column}) LIKE upper($n::text)`))).toEqual(likes.map(() => ['%Page%', '%Page%']));
    expect([ran(CATEGORY_PATHS), statement?.sql.includes('content_category_assign')]).toEqual([[], false]);
  });

  it('narrows to the listed categories and their descendants, resolved in the category-pool tenant', async () => {
    db.respond(PUBLIC_SEARCH, []);
    await publicSearch(deps, ADMIN_A, { siteId: SITE_A, keywords: 'Page', categoryId: IDS.categories.pooledParent });
    const [paths] = ran(CATEGORY_PATHS);
    expect([paths?.tenantId, paths?.params[1]]).toEqual([TENANT_UMBRELLA.tenantId, `%${IDS.categories.pooledParent}%`]);
    const filters = bound(ran(PUBLIC_SEARCH)[0], 'tcontentcategoryassign.categoryid = ANY($n::bpchar[])');
    expect(filters).toHaveLength(2);
    for (const ids of filters) expect(ids).toEqual(expect.arrayContaining([IDS.categories.pooledParent, IDS.categories.pooledChild]));
  });

  it.each([
    ['a named tag group', 'Topics', ['Topics', 'Topics']],
    ['the default tag group', 'Default', []],
  ])('searches by the tag list instead of the keywords, within %s', async (_name, tagGroup, groups) => {
    db.respond(PUBLIC_SEARCH, []);
    await publicSearch(deps, ADMIN_A, { siteId: SITE_A, keywords: 'Page', tag: 'News,Events', tagGroup });
    const [statement] = ran(PUBLIC_SEARCH);
    expect(statement?.sql).toContain('INNER JOIN "content"."content_tag" tcontenttags');
    expect(bound(statement, 'lower(rtrim(tcontenttags.tag)) IN (SELECT lower(rtrim(v)) FROM unnest($n::text[]) AS v)')).toEqual([
      ['News', 'Events'],
      ['News', 'Events'],
    ]);
    expect(bound(statement, 'lower(rtrim(tcontenttags.taggroup)) = lower(rtrim($n::text))')).toEqual(groups);
    expect(bound(statement, 'upper(tcontent.summary) LIKE upper($n::text)')).toEqual([]);
  });

  it("fills a pooled site's file columns from its file-pool tenant", async () => {
    db.respond(PUBLIC_SEARCH, [publicRow(nodeA(IDS.content.fileNode))]);
    const rows = await publicSearch(deps, ADMIN_A, { siteId: SITE_A, keywords: 'Guide' });
    expect(rows.map((row) => [row.title, row.fileext, row.filesize, row.assocfilename])).toEqual([['Guide', 'pdf', fileOf(IDS.files.pdf).filesize, 'guide.pdf']]);
    expect(ran(FILE_COLUMNS).map((statement) => [statement.tenantId, statement.params[0]])).toEqual([[TENANT_UMBRELLA.tenantId, PDF_FORMS]]);
  });
});

const param = (field: string, criteria: string, condition = 'eq', relationship = 'and'): ContentFeedStep => ({
  kind: 'addParam',
  param: { field, criteria, condition, relationship, datatype: '' },
});
const set = (key: string, value: unknown): ContentFeedStep => ({ kind: 'setValue', key, value });

describe('contentQueryCriteria (JSON API findQuery)', () => {
  it.each<[string, Row, string, ContentFeedStep[], string]>([
    [
      'keywords and property filters become params in query-string order; paging and API keys filter nothing',
      { keywords: 'orchid', title: 'Page*', credits: 'like^Ada', pageIndex: '2', itemsPerPage: '10', method: 'findQuery', entityname: 'content' },
      'keywords=orchid&title=Page*&credits=like^Ada&pageIndex=2&itemsPerPage=10&method=findQuery&entityname=content',
      [param('keywords', 'orchid'), param('title', 'Page%', 'like'), param('credits', 'Ada', 'like')],
      'keywords=orchid&title=Page*&credits=like%5EAda&itemsPerPage=10&method=findQuery&entityname=content',
    ],
    [
      'sort terms become the ORDER BY and maxItems the row cap',
      { sort: '-lastupdate,title', maxItems: '5' },
      'sort=-lastupdate,title&maxItems=5',
      [set('orderBy', 'tcontent.lastupdate desc,tcontent.title asc'), set('maxItems', '5')],
      'sort=-lastupdate%2Ctitle&maxItems=5',
    ],
    [
      'sortBy and sortDirection pass through and a wildcard maxItems lifts the cap',
      { sortBy: 'releaseDate', sortDirection: 'asc', maxItems: '*' },
      'sortBy=releaseDate&sortDirection=asc&maxItems=*',
      [set('sortdirection', 'asc'), set('sortby', 'releaseDate'), set('maxItems', 0)],
      'sortBy=releaseDate&sortDirection=asc&maxItems=*',
    ],
    ['a key missing from the URL scope or from the query string adds nothing', { ghost: 'x' }, 'phantom=1', [], ''],
    ['empty aggregate and join keys add nothing', { groupBy: '', innerJoin: '' }, 'groupBy=&innerJoin=', [], 'groupBy&innerJoin'],
  ])('%s', (_name, params, queryString, steps, baseQuery) => {
    const criteria = contentQueryCriteria(params, queryString);
    expect([criteria.source, criteria.steps, criteria.baseQuery, criteria.countOnly]).toEqual([{ kind: 'entity' }, steps, baseQuery, false]);
  });
});

describe('findContentQuery (JSON API findQuery)', () => {
  let db: RecordingDb;
  let deps: SearchDeps;
  const ran = (pattern: RegExp): RecordedStatement[] => db.statements.filter((statement) => pattern.test(statement.sql));
  const request = (params: Row, queryString: string, extra: Partial<ContentQueryRequest> = {}): ContentQueryRequest => ({
    siteId: SITE_A,
    extranet: false,
    params,
    queryString,
    ...extra,
  });
  /** Feed rows carry the unquoted materialized path legacy stores (contentManager.setMaterializedPath). */
  const feedRow = (contentId: string): Row => {
    const row = nodeA(contentId);
    return { ...row, path: String(row.path).replaceAll("'", '') };
  };
  const BY_TITLE_DESC = [feedRow(IDS.content.pageTwo), feedRow(IDS.content.pageOne)];

  beforeEach(() => {
    db = seededDb();
    deps = depsOf(db);
  });

  it('runs the criteria through feedContent in the site tenant and returns its rows in the query order', async () => {
    db.respond(FEED_ROWS, BY_TITLE_DESC);
    const result = await findContentQuery(deps, ADMIN_A, request({ title: '*Page*', sort: '-title', maxItems: '5' }, 'title=*Page*&sort=-title&maxItems=5'));
    expect('rows' in result && [titles(result.rows), result.paging, result.baseQuery]).toEqual([
      ['Page Two', 'Page One'],
      { recordCount: 2, nextN: 20, pageIndex: 1 },
      'title=*Page*&sort=-title&maxItems=5',
    ]);
    const [statement] = ran(FEED_ROWS);
    expect(statement?.tenantId).toBe(TENANT_A.tenantId);
    expect(bound(statement, 'tcontent.siteid = ANY($n::text[])')).toEqual([[SITE_A]]);
    expect(bound(statement, 'upper(tcontent.title::text) LIKE upper($n::text)')).toEqual(['%%Page%%']);
    expect(bound(statement, 'ORDER BY lower(tcontent.title) DESC NULLS LAST, tcontent.tcontent_id LIMIT $n')).toEqual([5]);
  });

  it.each<[string, Row, string, string[], unknown]>([
    ['one item a page, page 2', { itemsPerPage: '1', pageIndex: '2' }, 'itemsPerPage=1&pageIndex=2', ['Page One'], { recordCount: 2, nextN: 1, pageIndex: 2 }],
    ['every item on one page', { itemsPerPage: '*' }, 'itemsPerPage=*', ['Page Two', 'Page One'], { recordCount: 2, nextN: 2, pageIndex: 1 }],
    ['the blank row of page 0', { itemsPerPage: '1', pageIndex: '0' }, 'itemsPerPage=1&pageIndex=0', [''], { recordCount: 2, nextN: 1, pageIndex: 0 }],
    ['the blank rows of a negative page', { itemsPerPage: '2', pageIndex: '-3' }, 'itemsPerPage=2&pageIndex=-3', ['', ''], { recordCount: 2, nextN: 2, pageIndex: -3 }],
    ['a page from row 0', { itemsPerPage: '2', pageIndex: '0.75' }, 'itemsPerPage=2&pageIndex=0.75', ['', 'Page Two'], { recordCount: 2, nextN: 2, pageIndex: 0.75 }],
    ['a page whose index rounds past the last row', { itemsPerPage: '5', pageIndex: '1.2' }, 'itemsPerPage=5&pageIndex=1.2', ['Page Two', ''], { recordCount: 2, nextN: 5, pageIndex: 1.2 }],
    ['no row for a negative page size', { itemsPerPage: '-1' }, 'itemsPerPage=-1', [], { recordCount: 2, nextN: -1, pageIndex: 1 }],
  ])('pages by the URL scope without filtering by it: %s', async (_name, url, queryString, expected, paging) => {
    db.respond(FEED_ROWS, BY_TITLE_DESC);
    const result = await findContentQuery(deps, ADMIN_A, request({ sort: '-title', ...url }, `sort=-title&${queryString}`));
    expect('rows' in result && [titles(result.rows), result.paging]).toEqual([expected, paging]);
    expect(ran(FEED_ROWS)[0]?.sql).not.toMatch(/itemsperpage|pageindex/i);
  });

  it.each<[string, (row: Row) => Row, string, number[]]>([
    ['read by contenthistid after a blank row', (row) => row, '0.75', []],
    ['read by contentid after a blank row, whose page query is of site \'\'', ({ contenthistid: _omitted, ...row }) => row, '0.75', [1]],
    ['whose row lies past getPageIDList', (row) => row, '1.75', [0]],
  ])('marks the rows whose content bean misses the page query: %s', async (_name, columns, pageIndex, misses) => {
    db.respond(FEED_ROWS, BY_TITLE_DESC.map(columns));
    const result = await findContentQuery(deps, ADMIN_A, request({ sort: '-title', itemsPerPage: '2', pageIndex }, `sort=-title&itemsPerPage=2&pageIndex=${pageIndex}`));
    expect('rows' in result && [...result.misses]).toEqual(misses);
  });

  it('answers countOnly with the count query alone', async () => {
    db.respond(FEED_COUNT, [{ count: 7 }]);
    expect(await findContentQuery(deps, ADMIN_A, request({ countOnly: 'true', title: 'Page One' }, 'title=Page One'))).toEqual({ count: 7 });
    expect([ran(FEED_COUNT).length, ran(FEED_ROWS).length]).toEqual([1, 0]);
  });

  it.each<[string, Actor, boolean, string[]]>([
    ['a member, off the extranet', MEMBER_A, false, ['Page One', 'Restricted']],
    ['a member, on the extranet', MEMBER_A, true, ['Page One']],
    ['an Editor group member, on the extranet', EDITOR_A, true, ['Page One', 'Restricted']],
  ])('filters restricted rows by the reader only on an extranet site: %s', async (_name, actor, extranet, expected) => {
    db.respond(FEED_ROWS, [feedRow(IDS.content.pageOne), feedRow(IDS.content.restricted)]);
    db.respond(CRUMBS, (params) =>
      ACTIVE_A.filter((row) => (params[0] as string[]).includes(String(row.contentid)))
        .map((row) => ({ ...row, path: String(row.path).replaceAll("'", ''), fileext: null, chainid: null, exemptid: null }))
        .sort((a, b) => a.path.length - b.path.length)
        .reverse(),
    );
    db.respond(MEMBERSHIPS, (params, _sql, ctx) =>
      MEMBERSHIPS_A.filter((row) => row.tenant_id === ctx.tenantId && row.user_id === params[1]).map((row) => ({ group_id: row.group_id })),
    );
    const result = await findContentQuery(deps, actor, request({}, '', { extranet }));
    expect('rows' in result && titles(result.rows)).toEqual(expected);
    expect(ran(CRUMBS).length > 0).toBe(extranet);
  });
});

describe('searchSiteData (cnav.searchsitedata)', () => {
  const SITES: SiteListRow[] = [
    { siteid: 'tenant-b', site: 'Tenant B' },
    { siteid: 'umbrella', site: 'Umbrella Group' },
    { siteid: 'tenant-a', site: 'Tenant A' },
    { siteid: 'default', site: 'default' },
  ];

  it.each<[boolean, string[], string, string[]]>([
    [true, [], '', ['default', 'tenant-a', 'tenant-b', 'umbrella']],
    [true, [], 'Tenant', ['tenant-a', 'tenant-b']],
    [true, [], 'nt-b', ['tenant-b']],
    [true, [], 'TENANT', []],
    [false, [], '', []],
    [false, [], 'Tenant', []],
    [false, ['tenant-a'], '', ['tenant-a']],
    [false, ['tenant-a'], 'Tenant', ['tenant-a']],
    [false, ['tenant-a'], 'Umbrella', []],
    [false, ['umbrella', 'tenant-a'], 'a', ['tenant-a', 'umbrella']],
  ])('isS2 %s with site array %j and search %j lists %j, case-sensitive on id or name, in site-name order', (isS2, userSiteIds, searchString, expected) => {
    expect(searchSiteData({ sites: SITES, userSiteIds, isS2, searchString }).map((row) => row.siteid)).toEqual(expected);
  });

  it('renders the rows as the legacy [{id, value}] JSON', () => {
    const out = renderSearchSiteDataJson(searchSiteData({ sites: SITES, userSiteIds: [], isS2: true, searchString: 'Tenant' }));
    expect([out.status, out.contentType, JSON.parse(out.body)]).toEqual([
      200,
      'application/json; charset=UTF-8',
      [
        { id: 'tenant-a', value: 'Tenant A' },
        { id: 'tenant-b', value: 'Tenant B' },
      ],
    ]);
  });
});

describe('cnav.searchsitedata raw route', () => {
  const URL = '/v1/raw/cnav/searchsitedata';
  /** identity's session site array: tenant-a and tenant-b are registered, `phantom` is not; the registry's umbrella is not listed. */
  const LISTED = [
    { siteID: 'tenant-b', site: 'Tenant B' },
    { siteID: 'tenant-a', site: 'Tenant A' },
    { siteID: 'phantom', site: 'Phantom Tenant' },
  ];
  const VERIFIED: SiteListRow[] = [
    { siteid: 'tenant-a', site: 'Tenant A' },
    { siteid: 'tenant-b', site: 'Tenant B' },
  ];
  const identity = { status: 200, body: { sites: LISTED } as unknown };
  let t: TestApp;
  const sitesReads = () => t.client.requests.filter((req) => req.service === 'identity' && req.path === '/v1/sessions/current/sites');

  beforeAll(async () => {
    t = await buildTestApp({
      env: { LOG_LEVEL: 'fatal' },
      clientHandlers: { identity: { 'GET /v1/sessions/current/sites': () => ({ status: identity.status, headers: {}, body: identity.body }) } },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.client.clear();
    Object.assign(identity, { status: 200, body: { sites: LISTED } });
  });

  it.each<[ContentSubject, string, boolean, string[]]>([
    ['s2', 'Tenant', true, ['tenant-a', 'tenant-b']],
    ['editor', '', false, ['tenant-a', 'tenant-b']],
    ['editor', 'Phantom', false, []],
    ['site-admin', 'Umbrella', false, []],
  ])('as %s searching %j renders getUserSites over the registry and identity sites', async (subject, searchString, isS2, expected) => {
    const response = await t.app.inject({ method: 'GET', url: `${URL}?siteid=${SITE_A}&searchString=${searchString}`, headers: await contentHeaders(subject) });
    const rendered = renderSearchSiteDataJson(searchSiteData({ sites: VERIFIED, userSiteIds: LISTED.map((site) => site.siteID), isS2, searchString }));
    expect([response.statusCode, response.headers['content-type'], response.body]).toEqual([200, rendered.contentType, rendered.body]);
    expect((JSON.parse(response.body) as Array<{ id: string }>).map((row) => row.id)).toEqual(expected);
    expect([response.headers.generator, response.headers['strict-transport-security']]).toEqual(['Masa CMS 7.6.1', 'max-age=1200']);
    expect(sitesReads()).toHaveLength(1);
  });

  it('answers an anonymous session with an empty list without asking identity', async () => {
    const response = await t.app.inject({ method: 'GET', url: `${URL}?siteid=${SITE_A}&searchString=Tenant`, headers: await contentHeaders('anonymous') });
    expect([response.statusCode, response.body]).toEqual([200, renderSearchSiteDataJson([]).body]);
    expect(sitesReads()).toEqual([]);
  });

  it('takes site lists from verified data only, never from the request', async () => {
    const forged = `${URL}?siteid=${SITE_A}&searchString=Umbrella&siteArray=umbrella&sites=umbrella&isS2=true`;
    const response = await t.app.inject({ method: 'GET', url: forged, headers: await contentHeaders('editor') });
    expect([response.statusCode, response.body]).toEqual([200, renderSearchSiteDataJson([]).body]);
  });

  it('reads the search string from a posted form as from the query', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: `${URL}?siteid=${SITE_A}`,
      headers: { ...(await contentHeaders('s2')), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'searchString=Tenant',
    });
    expect([response.statusCode, response.body]).toEqual([200, renderSearchSiteDataJson(VERIFIED).body]);
  });

  // Own oracle: cnav.searchsitedata without searchString answers 500 "An Error Occurred", text/html;charset=UTF-8.
  it.each<[string, 'GET' | 'POST', string, number, unknown, number]>([
    ['a missing search string', 'GET', '', 200, { sites: LISTED }, 500],
    ['a posted form without a search string', 'POST', '', 200, { sites: LISTED }, 500],
    ['identity unavailable', 'GET', '&searchString=Tenant', 503, {}, 503],
    ['a malformed identity answer', 'GET', '&searchString=Tenant', 200, { nope: true }, 503],
  ])('answers %s with the legacy admin error page', async (_name, method, query, status, body, expected) => {
    Object.assign(identity, { status, body });
    const headers = await contentHeaders('s2');
    const response = await t.app.inject(
      method === 'GET'
        ? { method, url: `${URL}?siteid=${SITE_A}${query}`, headers }
        : { method, url: `${URL}?siteid=${SITE_A}`, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: '' },
    );
    expect([response.statusCode, response.statusMessage, response.headers['content-type'], response.body]).toEqual([
      expected,
      LEGACY_ERROR_STATUS_TEXT,
      LEGACY_HTML_CONTENT_TYPE,
      LEGACY_ERROR_PAGE_HTML,
    ]);
    expect([response.headers.generator, response.headers['strict-transport-security']]).toEqual(['Masa CMS 7.6.1', 'max-age=1200']);
  });

  it('answers identity refusing the session with the legacy 401 envelope', async () => {
    Object.assign(identity, { status: 401, body: {} });
    const response = await t.app.inject({ method: 'GET', url: `${URL}?siteid=${SITE_A}&searchString=Tenant`, headers: await contentHeaders('s2') });
    expect([response.statusCode, response.json<{ error?: { code?: string } }>().error?.code]).toEqual([401, 'invalid_request']);
  });
});
