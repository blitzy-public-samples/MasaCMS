/** content-tree domain over a recording database: content reads, crumbs, the Site Manager tree, version history and audit, dashboard lists, the draft prompt, session effects and locks. */
import { beforeEach, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_UMBRELLA } from '@opt2/platform/testing';
import {
  getActiveContent,
  getApprovalsQuery,
  getArchiveHist,
  getAudit,
  getAuditTrail,
  getContentVersion,
  getCrumbList,
  getDraftHist,
  getDraftList,
  getDraftPromptData,
  getHasDrafts,
  getHistory,
  getHistoryWindow,
  getItemCount,
  getKids,
  getMyApprovalsCount,
  getMyDraftsCount,
  getMyExpiresCount,
  getMyLockedContentCount,
  getMySubmissionsCount,
  getNest,
  getPageCount,
  getPendingChangesets,
  getSubmissionsQuery,
  inheritedObjectsOf,
  lockFile,
  lockNode,
  readContent,
  saveCopyInfo,
  siteManagerTab,
  unlockFile,
  unlockNode,
  type SessionEffect,
} from '../../src/domain/content-tree.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type DomainDeps } from '../../src/domain/context.js';
import { CONTENT_SORT_OPTIONS, HISTORY_MAX_PAGE, ROOT_PARENT_ID, timespanInterval } from '../../src/repo/content-queries.js';
// DomainDeps takes a ContentRepository, which only createContentRepository builds.
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, createRecordingDb, type RecordedStatement, type RecordingDb } from '../helpers/app.js';
import {
  IDS,
  approvalRequestRow,
  at,
  contentPath,
  contentRow,
  groupProjectionRow,
  membershipProjectionRow,
  tenantASeed,
  umbrellaSeed,
} from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, subjectSessionId, type TokenSubject } from '../helpers/tokens.js';

type Row = Record<string, unknown>;
/** Rows by table name: the seed datasets plus this suite's additions, mutated by the stats writes. */
type Tables = Map<string, Row[]>;

const SITE = TENANT_A.siteId;
const C = IDS.content;
const H = IDS.hist;
const EDITOR_ID = SUBJECT_USER_IDS.editor;
const APPROVER_ID = SUBJECT_USER_IDS.approver;

/** Further versions of page one: a draft newer than the active version, an older draft and an archived version. */
const PAGE_ONE = Object.freeze({
  newerDraft: 'A2000000-0000-0001-0000000000000001',
  oldDraft: 'A2000000-0000-0001-0000000000000002',
  archived: 'A2000000-0000-0001-0000000000000003',
});
const MISSING = 'A1000000-0000-0000-00000000000000FF';
const TWIN = 'A1000000-0000-0002-0000000000000001';
const TWIN_H = 'A2000000-0000-0002-0000000000000001';
const UNPUBLISHED = 'A1000000-0000-0002-0000000000000002';
const UNPUBLISHED_H = 'A2000000-0000-0002-0000000000000002';
const LOOP_HIST = 'A2000000-0000-0003-0000000000000001';
const LOOP_SOURCE = 'A2000000-0000-0003-0000000000000002';
const ADMIN_GROUP = 'A6000000-0000-0001-0000000000000001';

/** Section children beyond the seeded pages one and two, numbered 3 to 30 by `orderno`. */
const EXTRA_CHILDREN = 28;
const childId = (n: number): string => `A1000000-0000-0001-${String(n).padStart(16, '0')}`;
const childHistId = (n: number): string => `A2000000-0000-0004-${String(n).padStart(16, '0')}`;
const CHILD_NUMBERS = Array.from({ length: EXTRA_CHILDREN }, (_, i) => i + 3);
/** The section's live children in stored order. */
const SECTION_KIDS: readonly string[] = [C.pageOne, C.pageTwo, ...CHILD_NUMBERS.map(childId)];

const ci = (value: unknown): string => String(value ?? '').replace(/ +$/u, '').toLowerCase();
const anyOf = (ids: unknown, value: unknown): boolean => Array.isArray(ids) && ids.some((id) => ci(id) === ci(value));
/** The case forms SQL Server's id equality is bound with. */
const idForms = (ids: readonly string[]): string[] => [...new Set(ids.flatMap((id) => [id, id.toUpperCase(), id.toLowerCase()]))];
const lastUpdateOf = (row: Row): number => (row.lastupdate instanceof Date ? row.lastupdate.getTime() : Number.NEGATIVE_INFINITY);

/** The value bound to the placeholder `pattern` captures in `sql`; undefined when `sql` has none. */
function bound(sql: string, params: readonly unknown[], pattern: RegExp): unknown {
  const index = pattern.exec(sql)?.[1];
  return index === undefined ? undefined : params[Number(index) - 1];
}

/** A tenant-a `content_stats` row of `contentid` with the contentStatsBean defaults. */
function statsRow(contentid: string, overrides: Row = {}): Row {
  return {
    tenant_id: TENANT_A.tenantId,
    contentid,
    siteid: SITE,
    views: 0,
    rating: 0,
    totalvotes: 0,
    upvotes: 0,
    downvotes: 0,
    comments: 0,
    majorversion: 0,
    minorversion: 0,
    lockid: null,
    locktype: null,
    disablecomments: 0,
    ...overrides,
  };
}

/** A version of page one under the section. */
function pageOneVersion(contenthistid: string, title: string, lastupdate: string, flags: { active: 0 | 1; approved: 0 | 1 }): Row {
  return contentRow({
    contentid: C.pageOne,
    contenthistid,
    parentid: C.section,
    title,
    menutitle: 'Page One',
    filename: 'section/page-one',
    urltitle: 'page-one',
    orderno: 1,
    path: contentPath(C.root, C.section, C.pageOne),
    lastupdate: at(lastupdate),
    ...flags,
  });
}

/** The umbrella and tenant-a seed datasets with the suite's page-one versions, section children and source maps. */
function seedTables(): Tables {
  const tables: Tables = new Map([
    ['content_stats', []],
    ['source_map', []],
  ]);
  const add = (table: string, row: Row): void => {
    const rows = tables.get(table);
    if (rows === undefined) tables.set(table, [row]);
    else rows.push(row);
  };
  for (const seed of [umbrellaSeed(), tenantASeed()]) {
    for (const { table, row } of seed.rows) add(table.table, { ...row });
  }
  add('content', pageOneVersion(PAGE_ONE.newerDraft, 'Page One (newer draft)', '2026-06-29T16:00:00', { active: 0, approved: 0 }));
  add('content', pageOneVersion(PAGE_ONE.oldDraft, 'Page One (old draft)', '2026-06-25T10:00:00', { active: 0, approved: 0 }));
  add('content', pageOneVersion(PAGE_ONE.archived, 'Page One (archived)', '2026-06-20T10:00:00', { active: 0, approved: 1 }));
  add('content', contentRow({ contentid: C.linkNode, contenthistid: LOOP_HIST, type: 'Link', title: 'Example Link (copy)', active: 0, approved: 0 }));
  for (const n of CHILD_NUMBERS) {
    add(
      'content',
      contentRow({
        contentid: childId(n),
        contenthistid: childHistId(n),
        parentid: C.section,
        title: `Child ${n}`,
        orderno: n,
        path: contentPath(C.root, C.section, childId(n)),
      }),
    );
  }
  for (const row of tables.get('content') ?? []) {
    if (row.contentid === C.pageOne) row.remoteid = 'remote-page-one';
  }
  // Page one's draft names section's draft as its source, which names page two's content id; the loop pair maps to each other.
  const map = (mapid: string, contenthistid: string, sourceid: string): Row => ({
    tenant_id: TENANT_A.tenantId,
    mapid,
    contenthistid,
    sourceid,
    siteid: SITE,
    contentid: null,
    created: at('2026-06-29T15:30:00'),
  });
  add('source_map', map('A9100000-0000-0000-0000000000000001', H.pageOneDraft, H.sectionDraft));
  add('source_map', map('A9100000-0000-0000-0000000000000002', H.sectionDraft, C.pageTwo));
  add('source_map', map('A9100000-0000-0000-0000000000000003', LOOP_HIST, LOOP_SOURCE));
  add('source_map', map('A9100000-0000-0000-0000000000000004', LOOP_SOURCE, LOOP_HIST));
  return tables;
}

const VERSION_SELECT = /^SELECT tcontent\.active, tcontent\.approved, tcontent\.audience,/;
const CRUMB_SELECT = /^SELECT tcontent\.contenthistid, tcontent\.contentid, tcontent\.title,/;
const ITEM_COUNT = /^SELECT tcontent\.menutitle, tcontent\.title, tcontent\.filename, tcontent\.lastupdate, tcontent\.type FROM/;
const HISTORY_FROM =
  / FROM "content"\."content" tcontent(?: (?:LEFT|INNER) JOIN "content"\."changeset" tchangesets ON \(tcontent\.changesetid = tchangesets\.changesetid\))? LEFT JOIN "content"\."approval_request" tapprovalrequests ON \(tcontent\.contenthistid = tapprovalrequests\.contenthistid\) WHERE tcontent\.contentid = ANY\(\$1::bpchar\[\]\) AND tcontent\.siteid = \$2/;
const HIST_ROWS = /^SELECT tcontent\.menutitle, tcontent\.contentid, tcontent\.contenthistid,.* tchangesets\.published AS changsetpublished/;
const VERSION_PARENTS = /^SELECT contenthistid, parentid FROM "content"\."content" WHERE/;
const PENDING_BY_CONTENT = /^SELECT tchangesets\.changesetid, tcontent\.contentid,/;
const SOURCE_MAP = /^SELECT s\.siteid, s\.created, s\.sourceid/;
const CHANGESET_BY_ID = /^SELECT \* FROM "content"\."changeset" WHERE tenant_id = \$1 AND changesetid = ANY\(\$2::bpchar\[\]\)/;
const FILE_JOIN = /^SELECT fileid, fileext, filesize, filename AS assocfilename/;
const KIDS_SELECT = /^SELECT tcontent\.title, tcontent\.releasedate, tcontent\.menutitle/;
const NEST_SELECT = /^SELECT tcontent\.contenthistid, tcontent\.contentid, tcontent\.moduleid/;
const NEST_COUNT = /^SELECT count\(\*\)::integer AS total FROM \(SELECT 1 FROM/;
const PAGE_COUNT = /^SELECT count\(contentid\)::integer AS counter/;
const DRAFT_LIST = /^SELECT \* FROM \(SELECT draft\.contenthistid, module\.title AS module, active\.moduleid/;
const PENDING_REQUESTS = /^SELECT \* FROM \(SELECT DISTINCT draft\.contenthistid/;
const EXPIRING = /^SELECT contentid FROM "content"\."content" WHERE lower\(rtrim\(lastupdatebyid\)\)/;
const STATS_STATEMENT =
  /^(?:SELECT (?:\*|s\.contentid, s\.siteid\b.*?|count\(\*\)::integer AS thecount) FROM "content"\."content_stats"(?: s)? WHERE|INSERT INTO "content"\."content_stats" |UPDATE "content"\."content_stats" )/;
const STATS_WRITE = /^(?:INSERT INTO|UPDATE) "content"\."content_stats"/;
const CHANGELOG_INSERT = /^INSERT INTO "content"\."changelog"/;
const MEMBERSHIPS = /^SELECT group_id FROM "content"\."membership_projection"/;
const GROUPS = /^SELECT \* FROM "content"\."group_projection" WHERE tenant_id = \$1 AND .* = ANY\(\$2::bpchar\[\]\)/;
const PERMISSIONS = /^SELECT \* FROM "content"\."permission_projection" WHERE/;

/** The stats statements of the lock reads and writes, kept in `stats`: reads by item or lock holder, inserts and updates. */
function statsAnswer(stats: Row[], params: readonly unknown[], sql: string, tenantId: string | null): Row[] {
  if (sql.startsWith('INSERT')) {
    const columns = [...sql.slice(0, sql.indexOf(' VALUES ')).matchAll(/"(\w+)"/g)].slice(2).map((match) => match[1] ?? '');
    const row = Object.fromEntries(columns.map((column, i) => [column, params[i]]));
    stats.push(row);
    return [{ ...row }];
  }
  const [head = '', where = ''] = sql.split(' WHERE ');
  const site = bound(where, params, /siteid"? = \$(\d+)/);
  const inSite = stats.filter((row) => ci(row.tenant_id) === ci(tenantId) && row.siteid === site);
  if (head.startsWith('SELECT count(*)')) {
    return [{ thecount: inSite.filter((row) => anyOf(bound(where, params, /lockid = ANY\(\$(\d+)/), row.lockid)).length }];
  }
  const id = bound(where, params, /contentid"? = (?:ANY\()?\$(\d+)/);
  const found = inSite.filter((row) => (Array.isArray(id) ? anyOf(id, row.contentid) : ci(id) === ci(row.contentid)));
  if (head.startsWith('UPDATE')) {
    for (const [, column = '', n] of head.matchAll(/"(\w+)" = \$(\d+)/g)) {
      for (const row of found) row[column] = params[Number(n) - 1];
    }
  }
  return found.map((row) => ({ ...row }));
}

// seedRecordingDb answers every read naming a seeded table with all of that table's rows, whatever the WHERE binds, so
// these responders answer each statement the domain issues from the seed datasets filtered by the values it binds.
/** Answers the content, crumb, history, tree, stats, file and projection reads of `tables` on `db`. */
function answerFrom(db: RecordingDb, tables: Tables): void {
  const own = (table: string, tenantId: string | null): Row[] => (tables.get(table) ?? []).filter((row) => ci(row.tenant_id) === ci(tenantId));
  const request = (row: Row): Row | undefined => (tables.get('approval_request') ?? []).find((r) => ci(r.contenthistid) === ci(row.contenthistid));
  const changeset = (row: Row): Row | undefined =>
    row.changesetid === null ? undefined : (tables.get('changeset') ?? []).find((cs) => ci(cs.changesetid) === ci(row.changesetid));
  const withRequest = (row: Row): Row => ({
    ...row,
    approvalstatus: request(row)?.status ?? null,
    requestid: request(row)?.requestid ?? null,
    approvalgroupid: request(row)?.groupid ?? null,
  });
  // Tenant-a keeps its files in the umbrella pool, so the content tenant's joins find no file row.
  const versionRow = (row: Row): Row => withRequest({ ...row, filesize: null, contenttype: null, contentsubtype: null, fileext: null, assocfilename: null });
  const treeRow = (row: Row): Row => ({
    ...versionRow(row),
    filealttext: null,
    rating: null,
    totalvotes: null,
    downvotes: null,
    upvotes: null,
    comments: null,
    lockid: null,
    locktype: null,
    parenttype: '',
    kids: null,
  });
  const children = (params: readonly unknown[], sql: string, tenantId: string | null): Row[] => {
    const parent = bound(sql, params, /tcontent\.parentid = ANY\(\$(\d+)/);
    const site = bound(sql, params, /tcontent\.siteid = \$(\d+)/);
    return own('content', tenantId)
      .filter((row) => row.active === 1 && row.siteid === site && anyOf(parent, row.parentid))
      .map(treeRow);
  };

  db.respond(VERSION_SELECT, (params, sql, { tenantId }) => {
    const where = sql.slice(sql.indexOf(' WHERE '));
    const key =
      /^ WHERE (?:tcontent\.(contenthistid|contentid) = ANY\(\$1::bpchar\[\]\)|lower\(rtrim\(tcontent\.(\w+)\)\) = lower\(rtrim\(\$1::text\)\)|\(\(\(tcontent\.(\w+)::bpchar\) COLLATE "content"\."lookup_ci"\) = \$1::text::bpchar AND )/.exec(where);
    const site = bound(where, params, /tcontent\.siteid = \$(\d+)/);
    const types = [...where.matchAll(/lower\(rtrim\(tcontent\.type\)\) IN \(([^)]*)\)/g)].map((match) => (match[1] ?? '').replace(/'/g, '').split(', '));
    return own('content', tenantId)
      .filter((row) => {
        if (key?.[1] === 'contenthistid') return anyOf(params[0], row.contenthistid);
        const matched = key?.[1] === 'contentid' ? anyOf(params[0], row.contentid) : ci(row[key?.[2] ?? key?.[3] ?? '']) === ci(params[0]);
        return matched && row.active === 1 && row.siteid === site && types.every((list) => list.includes(ci(row.type)));
      })
      .map(versionRow);
  });
  db.respond(CRUMB_SELECT, (params, sql, { tenantId }) => {
    const site = bound(sql, params, /tcontent\.siteid = \$(\d+)/);
    const assignment = (row: Row): Row | undefined =>
      own('approval_assignment', tenantId).find((a) => ci(a.contentid) === ci(row.contentid) && a.siteid === row.siteid);
    const rows = own('content', tenantId)
      .filter((row) => row.active === 1 && row.siteid === site && anyOf(params[0], row.contentid))
      .map((row): Row => ({ ...row, fileext: null, chainid: assignment(row)?.chainid ?? null, exemptid: assignment(row)?.exemptid ?? null }));
    if (/ ORDER BY length\(rtrim\(tcontent\.path\)\) DESC/.test(sql)) rows.sort((a, b) => String(b.path).length - String(a.path).length);
    return / LIMIT 1$/.test(sql) ? rows.slice(0, 1) : rows;
  });
  db.respond(ITEM_COUNT, (params, _sql, { tenantId }) =>
    own('content', tenantId)
      .filter((row) => row.active === 1 && row.siteid === params[1] && anyOf(params[0], row.contentid))
      .map(({ menutitle, title, filename, lastupdate, type }) => ({ menutitle, title, filename, lastupdate, type })),
  );
  db.respond(HISTORY_FROM, (params, sql, { tenantId }) => {
    const where = sql.slice(sql.indexOf(' WHERE '));
    const filters: Array<readonly [RegExp, (row: Row) => boolean]> = [
      [/tcontent\.approved = 0\b/, (row) => row.approved === 0],
      [/tcontent\.approved = 1\b/, (row) => row.approved === 1],
      [/tcontent\.active = 0\b/, (row) => row.active === 0],
      [/changesetid IS NULL/, (row) => row.changesetid === null],
      [/changesetid IS NOT NULL/, (row) => row.changesetid !== null],
    ];
    const inner = / INNER JOIN "content"\."changeset" /.test(sql);
    const rows = own('content', tenantId)
      .filter((row) => anyOf(params[0], row.contentid) && row.siteid === params[1])
      .filter((row) => filters.every(([pattern, keep]) => !pattern.test(where) || keep(row)))
      .filter((row) => !inner || changeset(row) !== undefined)
      .map((row) => ({
        ...withRequest(row),
        changesetname: changeset(row)?.name ?? null,
        changsetpublished: changeset(row)?.published ?? null,
        changesetpublishdate: changeset(row)?.publishdate ?? null,
      }))
      .sort((a, b) => lastUpdateOf(b) - lastUpdateOf(a));
    if (sql.startsWith('SELECT count(*)')) return [{ total: rows.length }];
    const limit = bound(sql, params, / LIMIT \$(\d+)/);
    const offset = Number(bound(sql, params, / OFFSET \$(\d+)/) ?? 0);
    return limit === undefined ? rows : rows.slice(offset, offset + Number(limit));
  });
  db.respond(VERSION_PARENTS, (params, _sql, { tenantId }) =>
    own('content', tenantId)
      .filter((row) => anyOf(params[0], row.contenthistid))
      .map(({ contenthistid, parentid }) => ({ contenthistid, parentid })),
  );
  db.respond(PENDING_BY_CONTENT, (params, _sql, { tenantId }) =>
    own('content', tenantId).flatMap((row) => {
      const set = changeset(row);
      if (row.siteid !== params[0] || !anyOf(params[1], row.contentid) || set === undefined || set.published !== 0) return [];
      const { contentid, contenthistid, siteid, menutitle, lastupdate, lastupdateby, approvalstatus, requestid, approvalgroupid } = withRequest(row);
      const { changesetid, name: changesetname, publishdate, closedate } = set;
      return [
        { changesetid, contentid, contenthistid, siteid, menutitle, changesetname, approvalstatus, requestid, lastupdate, lastupdateby, approvalgroupid, publishdate, closedate },
      ];
    }),
  );
  db.respond(SOURCE_MAP, (params, _sql, { tenantId }) =>
    own('source_map', tenantId)
      .filter((map) => anyOf(params[0], map.contenthistid) && map.siteid === params[1])
      .sort((a, b) => String(a.mapid).localeCompare(String(b.mapid)))
      .slice(0, 1),
  );
  db.respond(CHANGESET_BY_ID, (params, _sql, { tenantId }) => own('changeset', tenantId).filter((set) => anyOf(params[1], set.changesetid)).slice(0, 1));
  db.respond(FILE_JOIN, (params, _sql, { tenantId }) =>
    own('file', tenantId)
      .filter((file) => anyOf(params[0], file.fileid))
      .map((file) => ({
        fileid: file.fileid,
        fileext: file.fileext,
        filesize: file.filesize,
        assocfilename: file.filename,
        contenttype: file.contenttype,
        contentsubtype: file.contentsubtype,
      })),
  );
  db.respond(KIDS_SELECT, (params, sql, { tenantId }) => {
    const rows = children(params, sql, tenantId).filter((row) => row.approved === 1);
    const limit = bound(sql, params, / LIMIT \$(\d+)$/);
    return limit === undefined ? rows : rows.slice(0, Number(limit));
  });
  db.respond(NEST_SELECT, (params, sql, { tenantId }) => {
    const offset = Number(bound(sql, params, / OFFSET \$(\d+)$/) ?? 0);
    const limit = bound(sql, params, / LIMIT \$(\d+)/);
    return children(params, sql, tenantId).slice(offset, limit === undefined ? undefined : offset + Number(limit));
  });
  db.respond(NEST_COUNT, (params, sql, { tenantId }) => [{ total: children(params, sql, tenantId).length }]);
  db.respond(PAGE_COUNT, (params, _sql, { tenantId }) => [
    {
      counter: own('content', tenantId).filter(
        (row) => row.active === 1 && row.siteid === params[0] && ['page', 'folder', 'file', 'calendar', 'gallery'].includes(ci(row.type)),
      ).length,
    },
  ]);
  db.respond(STATS_STATEMENT, (params, sql, { tenantId }) => statsAnswer(tables.get('content_stats') ?? [], params, sql, tenantId));
  db.respond(MEMBERSHIPS, (params, _sql, { tenantId }) =>
    own('membership_projection', tenantId)
      .filter((row) => ci(row.user_id) === ci(params[1]))
      .map((row) => ({ group_id: row.group_id })),
  );
  db.respond(GROUPS, (params, _sql, { tenantId }) => own('group_projection', tenantId).filter((row) => anyOf(params[1], row.group_id)));
  db.respond(PERMISSIONS, (params, _sql, { tenantId }) =>
    own('permission_projection', tenantId).filter((row) => ci(row.site_id) === ci(params[1]) && anyOf(params[2], row.content_id)),
  );
}


/** The actor of a token subject's verified claims. */
function actorOf(subject: TokenSubject): Actor {
  const { site, tid, roles, s2 } = SUBJECT_CLAIMS[subject];
  const claims = { iss: 'opt2-local-identity', aud: 'opt2-local', sid: subjectSessionId(subject), sub: SUBJECT_USER_IDS[subject], tid, site, s2 };
  return actorFromClaims({ ...claims, roles: [...roles], epoch: 1, iat: 0, exp: 0 }, `${subject} user`);
}

const S2 = actorOf('s2');
const EDITOR = actorOf('editor');

let tables: Tables;
let db: RecordingDb;
let deps: DomainDeps;

beforeEach(() => {
  tables = seedTables();
  db = createRecordingDb();
  answerFrom(db, tables);
  deps = { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS };
});

const rowsOf = (table: string): Row[] => tables.get(table) ?? [];
const statements = (pattern: RegExp): RecordedStatement[] => db.statements.filter((statement) => pattern.test(statement.sql));
/** The one statement matching `pattern`. */
function statementOf(pattern: RegExp): RecordedStatement {
  const found = statements(pattern);
  expect(found).toHaveLength(1);
  return found[0] as RecordedStatement;
}
const pdfFile = (): Row | undefined => rowsOf('file').find((file) => file.fileid === IDS.files.pdf);
const contentById = (contentId: string): Row[] => rowsOf('content').filter((row) => row.contentid === contentId && row.active === 1);
const addRequest = (contenthistid: string, groupid: string): void => {
  rowsOf('approval_request').push(approvalRequestRow({ contenthistid, groupid, userid: EDITOR_ID }));
};
const addStats = (contentid: string, overrides: Row = {}): void => {
  rowsOf('content_stats').push(statsRow(contentid, overrides));
};
const statsOf = (contentId: string): Row | undefined => rowsOf('content_stats').find((row) => ci(row.contentid) === ci(contentId) && row.siteid === SITE);
const statsWrites = (): string[] =>
  db
    .writes()
    .filter((statement) => STATS_WRITE.test(statement.sql))
    .map((statement) => (statement.sql.startsWith('INSERT') ? 'insert' : 'update'));

describe('readContent', () => {
  it.each([
    ['contentid', { contentId: C.pageOne }],
    ['contenthistid', { contentHistId: H.pageOneActive }],
    ['filename, slashes trimmed and in any case', { filename: '/Section/Page-One/' }],
    ['remoteid in any case', { remoteId: 'REMOTE-PAGE-ONE' }],
    ['title in any case', { title: 'page one' }],
    ['urltitle in any case', { urlTitle: 'PAGE-ONE' }],
  ])('reads the active version of the item by %s', async (_key, ref) => {
    expect(await readContent(deps, S2, { siteId: SITE, ...ref })).toMatchObject({
      isNew: 0,
      version: { contentid: C.pageOne, contenthistid: H.pageOneActive, siteid: SITE, active: 1 },
    });
  });

  it('reads the version contenthistid names over every other key, in any site', async () => {
    const bean = await readContent(deps, S2, { siteId: 'other-site', contentHistId: H.pageOneDraft, filename: 'section/page-two', contentId: C.pageTwo });
    expect(bean).toMatchObject({ isNew: 0, version: { contenthistid: H.pageOneDraft, active: 0 } });
  });

  it.each(['', '/'])('reads the home page for filename %j', async (filename) => {
    expect(await readContent(deps, S2, { siteId: SITE, filename })).toMatchObject({ isNew: 0, version: { contentid: C.root, contenthistid: H.rootActive } });
  });

  it('leaves the last matching row when several active items share the title', async () => {
    rowsOf('content').push(contentRow({ contentid: TWIN, contenthistid: TWIN_H, title: 'Page One' }));
    expect(await readContent(deps, S2, { siteId: SITE, title: 'Page One' })).toMatchObject({ isNew: 0, version: { contentid: TWIN } });
  });

  it.each([
    ['contentid', { contentId: MISSING }],
    ['contenthistid', { contentHistId: MISSING }],
    ['filename', { filename: 'no/such/page' }],
    ['remoteid', { remoteId: 'no-such-remote' }],
    ['title', { title: 'No Such Page' }],
  ])('answers an unknown %s with the new bean of the site, never ContentNotFoundError', async (_key, ref) => {
    expect(await readContent(deps, S2, { siteId: SITE, ...ref })).toEqual({ isNew: 1, version: null, values: { active: 1, siteid: SITE } });
  });

  it.each([
    ['content', { contentId: MISSING }, 'The requested page could not be found.'],
    ['version', { contentHistId: MISSING }, 'The requested version of this content could not be found.'],
  ])('answers an unknown %s with the 404 bean under use404', async (_kind, ref, body) => {
    expect(await readContent(deps, S2, { siteId: SITE, use404: true, ...ref })).toEqual({
      isNew: 1,
      version: null,
      values: {
        active: 1,
        siteid: SITE,
        type: 'Page',
        subtype: 'Default',
        body,
        title: '404',
        menutitle: '404',
        filename: '404',
        parentid: ROOT_PARENT_ID,
        contentid: C.root,
        path: C.root,
        display: 1,
        approved: 1,
      },
    });
  });

  it('requires a siteid and reads nothing without one', async () => {
    await expect(readContent(deps, S2, { siteId: '', contentId: C.pageOne })).rejects.toThrow("A 'SITEID' is required in order to read content.");
    expect(db.statements).toEqual([]);
  });

  it("fills a pooled file's columns from the file-pool tenant", async () => {
    const bean = await readContent(deps, S2, { siteId: SITE, contentId: C.fileNode });
    expect(bean).toMatchObject({
      isNew: 0,
      version: { fileid: IDS.files.pdf, fileext: 'pdf', filesize: pdfFile()?.filesize, contenttype: 'application', contentsubtype: 'pdf', assocfilename: 'guide.pdf' },
    });
    expect(statements(FILE_JOIN).map((statement) => statement.tenantId)).toEqual([TENANT_UMBRELLA.tenantId]);
  });

  it('getActiveContent reads the active version and getContentVersion any one version', async () => {
    expect(await getActiveContent(deps, S2, { contentId: C.section, siteId: SITE })).toMatchObject({ isNew: 0, version: { contenthistid: H.sectionActive } });
    expect(await getContentVersion(deps, S2, { contentHistId: H.sectionDraft, siteId: SITE })).toMatchObject({
      isNew: 0,
      version: { contenthistid: H.sectionDraft, active: 0 },
    });
  });
});

describe('getCrumbList', () => {
  it('walks from the item to the site root, leaf first, each crumb carrying its siteid', async () => {
    const crumbs = await getCrumbList(deps, S2, { contentId: C.pageOne, siteId: SITE });
    expect(crumbs.map((crumb) => [crumb.contentid, crumb.siteid])).toEqual([
      [C.pageOne, SITE],
      [C.section, SITE],
      [C.root, SITE],
    ]);
    expect(crumbs[0]?.parentarray).toEqual([C.pageOne, C.section, C.root]);
    expect(statements(CRUMB_SELECT)).toHaveLength(3);
  });

  it('returns the crumbs root first for sort desc in any case', async () => {
    const crumbs = await getCrumbList(deps, S2, { contentId: C.pageOne, siteId: SITE, sort: 'DESC' });
    expect(crumbs.map((crumb) => crumb.contentid)).toEqual([C.root, C.section, C.pageOne]);
  });

  it("reads the crumbs of a stored path in one query, deepest first", async () => {
    const crumbs = await getCrumbList(deps, S2, { contentId: C.pageOne, siteId: SITE, path: contentPath(C.root, C.section, C.pageOne) });
    expect(crumbs.map((crumb) => crumb.contentid)).toEqual([C.pageOne, C.section, C.root]);
    expect(statements(CRUMB_SELECT)).toHaveLength(1);
  });

  const inheritance: Array<[string, Record<string, string>, string]> = [
    ['the item itself', {}, H.pageOneActive],
    ['the nearest cascading ancestor, in any case', { [C.pageOne]: 'Inherit', [C.section]: 'cascade' }, H.sectionActive],
    ['no crumb', { [C.pageOne]: 'Inherit', [C.section]: 'Inherit', [C.root]: 'Reject' }, ''],
  ];
  it.each(inheritance)('setInheritance takes the inherited objects from %s', async (_source, objects, contentHistId) => {
    for (const [contentId, inheritobjects] of Object.entries(objects)) {
      for (const row of contentById(contentId)) row.inheritobjects = inheritobjects;
    }
    expect(inheritedObjectsOf(await getCrumbList(deps, S2, { contentId: C.pageOne, siteId: SITE }))).toBe(contentHistId);
  });
});


describe('getKids', () => {
  const SECTION = { parentId: C.section, siteId: SITE };
  const TODAY = new Date(2026, 6, 4, 9, 30, 0);
  const DEFAULT_ORDER = 'tcontent.releasedate DESC NULLS LAST, tcontent.lastupdate DESC NULLS LAST, lower(tcontent.menutitle) ASC NULLS FIRST';
  // Listed options without a column of their own fall back to legacy's default order; any unlisted name is an extended-attribute sort.
  const LISTED_ORDER: Record<(typeof CONTENT_SORT_OPTIONS)[number], string> = {
    menutitle: 'lower(tcontent.menutitle) ASC NULLS FIRST',
    title: 'lower(tcontent.title) ASC NULLS FIRST',
    lastupdate: 'tcontent.lastupdate ASC NULLS FIRST',
    releasedate: 'tcontent.releasedate ASC NULLS FIRST',
    orderno: 'tcontent.orderno ASC NULLS FIRST',
    displaystart: 'tcontent.displaystart ASC NULLS FIRST',
    created: 'tcontent.created ASC NULLS FIRST',
    rating: 'tcontentstats.rating ASC NULLS FIRST, tcontentstats.totalvotes ASC NULLS FIRST',
    comment: DEFAULT_ORDER,
    credits: DEFAULT_ORDER,
    type: 'lower(tcontent.type) ASC NULLS FIRST',
    subtype: 'lower(tcontent.subtype) ASC NULLS FIRST',
  };

  it.each([
    ['every row by default', {}, 1, 30],
    ['rows 11 to 20', { startRow: 11, maxRows: 10 }, 11, 10],
    ['the last five rows of a short page', { startRow: 26, maxRows: 10 }, 26, 5],
    ['nothing past the end', { startRow: 31 }, 31, 0],
  ])('pages the children to %s over the whole record count', async (_window, window, from, count) => {
    const page = await getKids(deps, S2, { ...SECTION, ...window });
    expect(page.recordCount).toBe(30);
    expect(page.rows.map((row) => row.contentid)).toEqual(SECTION_KIDS.slice(from - 1, from - 1 + count));
  });

  it.each([
    ['100 by default', undefined, 100, 30],
    ['12 rows', 12, 12, 12],
    ['every row for size 0', 0, undefined, 30],
  ])('caps the query at size: %s', async (_cap, size, limit, recordCount) => {
    const page = await getKids(deps, S2, { ...SECTION, size, startRow: 6 });
    const { sql, params } = statementOf(KIDS_SELECT);
    expect(bound(sql, params, / LIMIT \$(\d+)$/)).toBe(limit);
    expect(page.recordCount).toBe(recordCount);
    expect(page.rows[0]?.contentid).toBe(SECTION_KIDS[5]);
  });

  it.each([{ startRow: 0 }, { startRow: 1.5 }, { maxRows: 2.5 }])('rejects the window %j', async (window) => {
    await expect(getKids(deps, S2, { ...SECTION, ...window })).rejects.toThrow(RangeError);
  });

  it.each(CONTENT_SORT_OPTIONS.map((option) => [option, LISTED_ORDER[option]] as const))('orders by the listed sortBy %s as %s', async (sortBy, order) => {
    await getKids(deps, S2, { ...SECTION, sortBy });
    expect(statementOf(KIDS_SELECT).sql).toContain(` ORDER BY ${order} LIMIT `);
  });

  it('matches a listed sortBy in any case', async () => {
    await getKids(deps, S2, { ...SECTION, sortBy: 'MenuTitle' });
    expect(statementOf(KIDS_SELECT).sql).toContain(` ORDER BY ${LISTED_ORDER.menutitle} LIMIT `);
  });

  it('orders an unlisted sortBy by the extended attribute of that name', async () => {
    await getKids(deps, S2, { ...SECTION, sortBy: 'eventDate' });
    const { sql, params } = statementOf(KIDS_SELECT);
    expect(sql).toContain(' qextendedsort ON (tcontent.contenthistid = qextendedsort.baseid)');
    expect(sql).toContain(' ORDER BY lower(qextendedsort.extendedsort) ASC NULLS FIRST LIMIT ');
    expect(params.slice(0, 2)).toEqual([SITE, 'eventDate']);
  });

  it.each([
    ['desc', 'DESC NULLS LAST'],
    ['DESC', 'DESC NULLS LAST'],
    ['asc', 'ASC NULLS FIRST'],
    ['sideways', 'ASC NULLS FIRST'],
  ])('reads sortDirection %s as %s', async (sortDirection, order) => {
    await getKids(deps, S2, { ...SECTION, sortBy: 'orderno', sortDirection });
    expect(statementOf(KIDS_SELECT).sql).toContain(` ORDER BY tcontent.orderno ${order} LIMIT `);
  });

  it.each([
    [
      'default',
      undefined,
      '(tcontent.display = 1 OR (tcontent.display = 2 AND (tcontent.displaystart < $4 AND (tcontent.displaystop >= $5 OR tcontent.displaystop IS NULL))))',
      [timespanInterval(TODAY), timespanInterval(TODAY)],
    ],
    ['fixed', 'fixed', '(tcontent.display = 1)', []],
    [
      'calendar',
      'Calendar',
      '(tcontent.display = 2 AND (tcontent.displaystart < $4 AND (tcontent.displaystop >= $5 OR tcontent.displaystop IS NULL)))',
      [new Date(2026, 6, 5, 9, 30, 0), TODAY],
    ],
  ])('filters the %s menu type to its display window on today', async (_type, type, clause, window) => {
    await getKids(deps, S2, { ...SECTION, type, today: TODAY, size: 0 });
    const { sql, params } = statementOf(KIDS_SELECT);
    expect(sql).toContain(` AND ${clause} AND (tcontent.mobileexclude `);
    expect(params.slice(3)).toEqual(window);
  });

  it('defaults today to the clock, which the ReleaseMonth window also compares as now', async () => {
    await getKids(deps, S2, { ...SECTION, size: 0 });
    const now = TEST_CLOCK.now();
    expect(statementOf(KIDS_SELECT).params.slice(3)).toEqual([timespanInterval(now), timespanInterval(now)]);
    db.clear();
    await getKids(deps, S2, { ...SECTION, size: 0, type: 'ReleaseMonth', today: TODAY });
    const { params } = statementOf(KIDS_SELECT);
    expect(params).toContainEqual(now);
    expect(params).toContainEqual(new Date(2026, 6, 1));
  });

  it("fills a pooled file child's columns from the file-pool tenant", async () => {
    const page = await getKids(deps, S2, { parentId: C.root, siteId: SITE });
    expect(page.rows.map((row) => row.contentid)).toEqual([C.section, C.restricted, C.fileNode, C.linkNode]);
    expect(page.rows.find((row) => row.contentid === C.fileNode)).toMatchObject({ fileext: 'pdf', filesize: pdfFile()?.filesize, assocfilename: 'guide.pdf' });
  });
});

describe('getNest and getPageCount', () => {
  const SECTION = { parentId: C.section, siteId: SITE };

  it.each([
    ['every row without a count query', {}, 1, 30, 0],
    ['a full page and counts the rest', { startRow: 11, maxRows: 10 }, 11, 10, 1],
    ['a short last page without a count query', { startRow: 28, maxRows: 10 }, 28, 3, 0],
    ['an empty page past the end and counts the rest', { startRow: 41, maxRows: 10 }, 41, 0, 1],
  ])('getNest reads %s', async (_page, window, from, count, countQueries) => {
    const page = await getNest(deps, S2, { ...SECTION, ...window });
    expect(page.rows.map((row) => row.contentid)).toEqual(SECTION_KIDS.slice(from - 1, from - 1 + count));
    expect(page.recordCount).toBe(30);
    expect(statements(NEST_COUNT)).toHaveLength(countQueries);
  });

  it('getNest orders by orderno by default and binds the window as LIMIT and OFFSET', async () => {
    await getNest(deps, S2, { ...SECTION, startRow: 11, maxRows: 10 });
    const { sql, params } = statementOf(NEST_SELECT);
    expect(sql).toMatch(/ ORDER BY tcontent\.orderno ASC NULLS FIRST, min\(tcontent\.tcontent_id\) ASC, .* LIMIT \$3 OFFSET \$4$/);
    expect(params.slice(2)).toEqual([10, 10]);
  });

  it("getNest leaves a pooled file child's columns null, reading no file-pool tenant, as legacy's site-scoped file join does", async () => {
    const page = await getNest(deps, S2, { parentId: C.root, siteId: SITE });
    expect(page.rows.find((row) => row.contentid === C.fileNode)).toMatchObject({
      type: 'File',
      fileid: IDS.files.pdf,
      fileext: null,
      filesize: null,
      contenttype: null,
      contentsubtype: null,
      assocfilename: null,
    });
    expect(statements(FILE_JOIN)).toEqual([]);
    expect(db.statements.filter((statement) => statement.tenantId === TENANT_UMBRELLA.tenantId)).toEqual([]);
  });

  it('getNest orders by a listed sortBy and direction', async () => {
    await getNest(deps, S2, { ...SECTION, sortBy: 'title', sortDirection: 'desc' });
    expect(statementOf(NEST_SELECT).sql).toContain(' ORDER BY lower(tcontent.title) DESC NULLS LAST, min(tcontent.tcontent_id) ASC');
  });

  it.each([
    [SITE, 6 + EXTRA_CHILDREN],
    ['no-such-site', 0],
  ])("getPageCount counts site %s's active pages, folders, files, calendars and galleries", async (siteId, count) => {
    expect(await getPageCount(deps, S2, siteId)).toBe(count);
  });

  it('getPageCount answers 0 when the count returns no row', async () => {
    db.respond(PAGE_COUNT, []);
    expect(await getPageCount(deps, S2, SITE)).toBe(0);
  });
});


describe('version history and audit', () => {
  const PAGE = { contentId: C.pageOne, siteId: SITE };
  const VERSIONS_NEWEST_FIRST = [PAGE_ONE.newerDraft, H.pageOneDraft, H.pageOneActive, PAGE_ONE.oldDraft, PAGE_ONE.archived];

  it('getHistory lists every version newest first with its change set and approval status, the item summary, crumbs, verdict and stats', async () => {
    addRequest(PAGE_ONE.newerDraft, IDS.groups.approvers);
    addStats(C.pageOne, { lockid: EDITOR_ID, locktype: 'node' });
    const model = await getHistory(deps, S2, PAGE);
    expect(model.items.map((row) => [row.contenthistid, row.active, row.approved, row.changesetname, row.approvalstatus])).toEqual([
      [PAGE_ONE.newerDraft, 0, 0, null, 'Pending'],
      [H.pageOneDraft, 0, 0, 'Due Release', null],
      [H.pageOneActive, 1, 1, null, null],
      [PAGE_ONE.oldDraft, 0, 0, null, null],
      [PAGE_ONE.archived, 0, 1, null, null],
    ]);
    expect(model.historyTotal).toBe(5);
    expect(Object.fromEntries(model.parents)).toEqual(Object.fromEntries(VERSIONS_NEWEST_FIRST.map((id) => [id, C.section])));
    expect(model.contentBean).toMatchObject({ isNew: 0, version: { contenthistid: H.pageOneActive } });
    expect(model.rsCount).toEqual([{ menutitle: 'Page One', title: 'Page One', filename: 'section/page-one', lastupdate: at('2026-06-29T10:00:00'), type: 'Page' }]);
    expect(model.crumbs.map((crumb) => crumb.contentid)).toEqual([C.pageOne, C.section, C.root]);
    expect(model.perm).toBe('editor');
    expect(model.stats).toMatchObject({ contentid: C.pageOne, lockid: EDITOR_ID, locktype: 'node' });
    expect(statementOf(HIST_ROWS).params.slice(2)).toEqual([HISTORY_MAX_PAGE, 0]);
  });

  it.each([
    ['s2', 'editor'],
    ['editor', 'editor'],
    ['approver', 'read'],
    ['member', 'none'],
  ] as const)("getHistory carries the %s actor's node verdict %s", async (subject, perm) => {
    expect((await getHistory(deps, actorOf(subject), PAGE)).perm).toBe(perm);
  });

  it('getHistory lists no versions of an item without an active version', async () => {
    expect(await getHistory(deps, S2, { contentId: MISSING, siteId: SITE })).toMatchObject({
      contentBean: { isNew: 1 },
      items: [],
      historyTotal: 0,
      rsCount: [],
      crumbs: [],
      perm: 'none',
      stats: null,
    });
  });

  it('getHistoryWindow reads the window its callback picks from the history count', async () => {
    const { items, window } = await getHistoryWindow(deps, S2, PAGE, (total) => ({ offset: total - 2, limit: 2 }));
    expect(window).toEqual({ offset: 3, limit: 2 });
    expect(items.map((row) => row.contenthistid)).toEqual([PAGE_ONE.oldDraft, PAGE_ONE.archived]);
  });

  it('splits the versions into drafts, pending change-set versions and archived versions, with the active summary', async () => {
    expect((await getDraftHist(deps, S2, PAGE)).map((row) => row.contenthistid)).toEqual([PAGE_ONE.newerDraft, PAGE_ONE.oldDraft]);
    expect((await getPendingChangesets(deps, S2, PAGE)).map((row) => [row.contenthistid, row.changesetname])).toEqual([[H.pageOneDraft, 'Due Release']]);
    expect((await getArchiveHist(deps, S2, PAGE)).map((row) => row.contenthistid)).toEqual([PAGE_ONE.archived]);
    expect(await getHasDrafts(deps, S2, PAGE)).toBe(2);
    expect((await getItemCount(deps, S2, PAGE)).map((row) => row.title)).toEqual(['Page One']);
  });

  it('getAudit lists the audit trail of the version and the change sets its versions name', async () => {
    const model = await getAudit(deps, S2, { ...PAGE, contentHistId: H.pageOneDraft });
    expect(model.trail.map((version) => version.contenthistid)).toEqual([H.pageOneDraft, H.pageTwoActive]);
    expect([...model.changesets.keys()]).toEqual([IDS.changesets.scheduledDue]);
    expect(model.changesets.get(IDS.changesets.scheduledDue)).toMatchObject({ name: 'Due Release' });
    expect(model).toMatchObject({ perm: 'editor', contentBean: { isNew: 0, version: { contenthistid: H.pageOneActive } }, rsCount: [{ title: 'Page One' }] });
    expect(model.crumbs.map((crumb) => crumb.contentid)).toEqual([C.pageOne, C.section, C.root]);
  });

  it.each([
    ['follows the source maps past a version id to the active source', H.pageOneDraft, [H.pageOneDraft, H.pageTwoActive]],
    ['stops where the source maps loop', LOOP_HIST, [LOOP_HIST]],
    ['lists nothing for an unknown version', MISSING, []],
  ])('getAuditTrail %s', async (_trail, contentHistId, trail) => {
    expect(await getAuditTrail(deps, S2, contentHistId)).toEqual(trail);
  });
});

describe('drafts, approvals and dashboard counts', () => {
  const SYSTEM_USER_ID = SUBJECT_USER_IDS['system-user'];
  const listRow = (contentid: string | null, contenthistid: string): Row => ({
    contenthistid,
    module: 'Site Manager',
    moduleid: IDS.modules.content,
    siteid: SITE,
    parentid: C.section,
    type: 'Page',
    subtype: 'Default',
    menutitle: 'Page One',
    filename: 'section/page-one',
    contentid,
    targetparams: null,
    lastupdate: at('2026-06-29T16:00:00'),
    lastupdateby: 'Editor',
    fileext: null,
    changesetid: null,
    majorversion: 0,
    minorversion: 0,
    lockid: null,
    locktype: null,
    expires: null,
    approvalstatus: 'Pending',
    displaystart: null,
    publishdate: null,
  });
  // Two rows of one item, its id in another case, and two rows without an item: three distinct values to a query of queries.
  const LIST_ROWS = [
    listRow(C.pageOne, PAGE_ONE.newerDraft),
    listRow(C.pageOne, PAGE_ONE.oldDraft),
    listRow(C.pageOne.toLowerCase(), H.pageTwoDraft),
    listRow(null, H.sectionDraft),
    listRow(null, H.rootDraft),
  ];

  it('getDraftList reads the drafts assigned to or saved by the acting user', async () => {
    db.respond(DRAFT_LIST, LIST_ROWS);
    expect(await getDraftList(deps, EDITOR, { siteId: SITE })).toEqual(LIST_ROWS);
    const { params } = statementOf(DRAFT_LIST);
    expect(params).toContainEqual(idForms([EDITOR_ID]));
    expect(params).toContain(EDITOR_ID);
  });

  it("getDraftList reads a given user's drafts from the start date's midnight", async () => {
    await getDraftList(deps, EDITOR, { siteId: SITE, userId: APPROVER_ID, startDate: new Date(2026, 5, 1, 15, 45) });
    const { params } = statementOf(DRAFT_LIST);
    expect(params).toContainEqual(idForms([APPROVER_ID]));
    expect(params).not.toContainEqual(idForms([EDITOR_ID]));
    expect(params).toContainEqual(new Date(2026, 5, 1, 0, 0, 0));
  });

  const approvalCases: Array<[string, TokenSubject, string[] | undefined, string[] | null]> = [
    ['every request for an s2 actor', 's2', undefined, null],
    ["the Content Approvers group's requests", 'approver', undefined, [IDS.groups.approvers]],
    ["the Editor group's requests", 'editor', undefined, [IDS.groups.editor]],
    ['the given membership ids in place of the actor groups', 'approver', ['G1'], ['G1']],
  ];
  it.each(approvalCases)('getApprovalsQuery reads %s', async (_reads, subject, membershipIds, groupIds) => {
    await getApprovalsQuery(deps, actorOf(subject), { siteId: SITE, membershipIds });
    const { sql, params } = statementOf(PENDING_REQUESTS);
    expect(sql.includes('tapprovalrequests.groupid')).toBe(groupIds !== null);
    expect(bound(sql, params, /tapprovalrequests\.groupid = ANY\(\$(\d+)/)).toEqual(groupIds === null ? undefined : idForms(groupIds));
  });

  it("getApprovalsQuery lifts the group limit for a member of the site's Admin group", async () => {
    rowsOf('group_projection').push(groupProjectionRow({ group_id: ADMIN_GROUP, site_id: SITE, group_name: 'Admin', is_public: 0 }));
    rowsOf('membership_projection').push(membershipProjectionRow({ user_id: SYSTEM_USER_ID, site_id: SITE, group_id: ADMIN_GROUP }));
    await getApprovalsQuery(deps, actorOf('system-user'), { siteId: SITE });
    expect(statementOf(PENDING_REQUESTS).sql).not.toContain('tapprovalrequests.groupid');
  });

  it.each([
    ['the acting user', undefined, EDITOR_ID],
    ['a given user', APPROVER_ID, APPROVER_ID],
  ])('getSubmissionsQuery reads the requests %s submitted', async (_who, userId, submitter) => {
    await getSubmissionsQuery(deps, EDITOR, { siteId: SITE, userId });
    const { sql, params } = statementOf(PENDING_REQUESTS);
    expect(bound(sql, params, /tapprovalrequests\.userid = ANY\(\$(\d+)/)).toEqual(idForms([submitter]));
  });

  /** The distinct-id count statement over the list `list` matches. */
  const countOf = (list: RegExp): RegExp =>
    new RegExp(`^SELECT \\(count\\(DISTINCT q\\.contentid\\) \\+ \\(count\\(\\*\\) > count\\(q\\.contentid\\)\\)::integer\\)::integer AS total FROM \\(${list.source.slice(1)}`);
  /** The count statement's total over `rows`: their distinct non-NULL ids, plus one where any id is NULL. */
  const totalOf = (rows: readonly Row[]): number =>
    new Set(rows.flatMap((row) => (row.contentid === null ? [] : [row.contentid]))).size + (rows.some((row) => row.contentid === null) ? 1 : 0);
  const countCases: Array<[string, RegExp, (actor: Actor) => Promise<number>]> = [
    ['getMyApprovalsCount', countOf(PENDING_REQUESTS), (actor) => getMyApprovalsCount(deps, actor, { siteId: SITE })],
    ['getMySubmissionsCount', countOf(PENDING_REQUESTS), (actor) => getMySubmissionsCount(deps, actor, { siteId: SITE })],
    ['getMyDraftsCount', countOf(DRAFT_LIST), (actor) => getMyDraftsCount(deps, actor, { siteId: SITE })],
  ];
  it.each(countCases)('%s counts distinct contentids case-sensitively, NULL once', async (_count, pattern, count) => {
    db.respond(pattern, [{ total: totalOf(LIST_ROWS) }]);
    expect(await count(EDITOR)).toBe(3);
  });

  it('getMyDraftsCount reads the drafts since the start date', async () => {
    await getMyDraftsCount(deps, EDITOR, { siteId: SITE, startDate: new Date(2026, 5, 20, 8, 0) });
    expect(statementOf(countOf(DRAFT_LIST)).params).toContainEqual(new Date(2026, 5, 20, 0, 0, 0));
  });

  it('getMyExpiresCount counts the distinct items of the user expiring within a month of the clock or expired within a year', async () => {
    db.respond(EXPIRING, [{ contentid: C.pageOne }, { contentid: C.pageOne }, { contentid: C.section }]);
    expect(await getMyExpiresCount(deps, EDITOR, { siteId: SITE })).toBe(2);
    expect(statementOf(EXPIRING).params.slice(0, 4)).toEqual([EDITOR_ID, SITE, new Date(2026, 6, 30, 12, 0, 0), new Date(2025, 5, 30, 12, 0, 0)]);
  });

  it('getMyLockedContentCount counts the items of the site whose lock the user holds, the id in any case', async () => {
    addStats(C.pageOne, { lockid: EDITOR_ID, locktype: 'node' });
    addStats(C.section, { lockid: EDITOR_ID.toLowerCase(), locktype: 'file' });
    addStats(C.linkNode, { lockid: SUBJECT_USER_IDS.s2, locktype: 'node' });
    addStats(C.pageTwo, { lockid: EDITOR_ID, locktype: 'node', siteid: 'other-site' });
    expect(await getMyLockedContentCount(deps, EDITOR, { siteId: SITE })).toBe(2);
  });
});


describe('getDraftPromptData', () => {
  it('reports the draft newer than the active version to an editor, with the pending change sets and no approvals', async () => {
    const view = await getDraftPromptData(deps, S2, C.pageOne, SITE);
    expect(view).toMatchObject({
      verdict: 'editor',
      publishedHistoryId: H.pageOneActive,
      hasDraft: true,
      hasDraftPending: false,
      historyId: PAGE_ONE.newerDraft,
      lockId: '',
      lockType: '',
      yourApprovals: [],
    });
    expect(view.pendingChangesets).toEqual([{ contenthistid: H.pageOneDraft, title: 'Due Release', lastupdate: at('2026-06-29T15:30:00'), lastupdateby: 'System' }]);
  });

  it.each([
    ['s2', { verdict: 'editor', hasDraft: true, hasDraftPending: true, historyId: PAGE_ONE.newerDraft }, [PAGE_ONE.newerDraft]],
    ['editor', { verdict: 'editor', hasDraft: true, hasDraftPending: true, historyId: PAGE_ONE.newerDraft }, []],
    ['approver', { verdict: 'read', hasDraft: false, hasDraftPending: false, historyId: '' }, [PAGE_ONE.newerDraft]],
  ] as const)('reports a draft pending approval by Content Approvers to the %s actor', async (subject, flags, approvals) => {
    addRequest(PAGE_ONE.newerDraft, IDS.groups.approvers);
    const view = await getDraftPromptData(deps, actorOf(subject), C.pageOne, SITE);
    expect(view).toMatchObject(flags);
    expect(view.pendingChangesets.map((row) => row.contenthistid)).toEqual([H.pageOneDraft]);
    expect(view.yourApprovals).toEqual(
      approvals.map((contenthistid) => ({ contenthistid, title: 'Page One', lastupdate: at('2026-06-29T16:00:00'), lastupdateby: 'System' })),
    );
  });

  it('reports nothing to prompt for an item without drafts, change sets or approvals', async () => {
    expect(await getDraftPromptData(deps, S2, childId(3), SITE)).toEqual({
      verdict: 'editor',
      publishedHistoryId: childHistId(3),
      hasDraft: false,
      hasDraftPending: false,
      historyId: '',
      lockId: '',
      lockType: '',
      pendingChangesets: [],
      yourApprovals: [],
    });
  });

  it("carries the item's stats lock", async () => {
    addStats(childId(3), { lockid: APPROVER_ID, locktype: 'node' });
    expect(await getDraftPromptData(deps, S2, childId(3), SITE)).toMatchObject({ lockId: APPROVER_ID, lockType: 'node', hasDraft: false });
  });

  it('drops the pending change sets for an admin without an editor verdict on an item never published', async () => {
    rowsOf('content').push(
      contentRow({ contentid: UNPUBLISHED, contenthistid: UNPUBLISHED_H, title: 'Unpublished', active: 0, approved: 0, changesetid: IDS.changesets.scheduledFuture }),
    );
    addRequest(UNPUBLISHED_H, IDS.groups.approvers);
    const view = await getDraftPromptData(deps, S2, UNPUBLISHED, SITE);
    expect(view).toMatchObject({ verdict: 'none', publishedHistoryId: '', hasDraft: false, historyId: '', pendingChangesets: [] });
    expect(view.yourApprovals.map((row) => [row.contenthistid, row.title])).toEqual([[UNPUBLISHED_H, 'Unpublished']]);
  });
});

describe('Site Manager session effects', () => {
  const effects: Array<[string, () => SessionEffect, SessionEffect]> = [
    ['siteManagerTab', () => siteManagerTab({ siteId: SITE, tab: '2' }), { kind: 'flatViewArgs', siteId: SITE, tab: '2' }],
    [
      'saveCopyInfo',
      () => saveCopyInfo({ siteId: SITE, contentId: C.pageOne, moduleId: IDS.modules.content, copyAll: 'true' }),
      { kind: 'copyInfo', copySiteID: SITE, copyContentID: C.pageOne, copyModuleID: IDS.modules.content, copyAll: 'true' },
    ],
  ];
  it.each(effects)('%s returns its session effect and touches no table', (_action, effect, expected) => {
    expect(effect()).toEqual(expected);
    expect(db.statements).toEqual([]);
  });
});

describe('node and file locks', () => {
  it('lockNode inserts a node lock for the actor where the item has no stats row', async () => {
    expect(await lockNode(deps, EDITOR, { contentId: C.pageOne, siteId: SITE, requestId: 'req-lock' })).toBe(true);
    expect(statsWrites()).toEqual(['insert']);
    expect(statsOf(C.pageOne)).toMatchObject({ lockid: EDITOR_ID, locktype: 'node', views: 0 });
    const { params } = statementOf(CHANGELOG_INSERT);
    expect(params).toContain(EDITOR_ID);
    expect(params).toContain('req-lock');
  });

  it('lockNode updates the stats row of a lock the actor holds, the id in any case, keeping its counts', async () => {
    addStats(C.pageOne, { lockid: EDITOR_ID.toLowerCase(), locktype: 'file', views: 7 });
    expect(await lockNode(deps, EDITOR, { contentId: C.pageOne, siteId: SITE })).toBe(true);
    expect(statsWrites()).toEqual(['update']);
    expect(statsOf(C.pageOne)).toMatchObject({ lockid: EDITOR_ID, locktype: 'node', views: 7 });
  });

  it.each(['s2', 'editor'] as const)("lockNode leaves another user's lock in place for the %s actor", async (subject) => {
    addStats(C.pageOne, { lockid: APPROVER_ID, locktype: 'node' });
    expect(await lockNode(deps, actorOf(subject), { contentId: C.pageOne, siteId: SITE })).toBe(false);
    expect(db.writes()).toEqual([]);
    expect(statsOf(C.pageOne)).toMatchObject({ lockid: APPROVER_ID, locktype: 'node' });
  });

  it.each([
    ['s2', C.fileNode, IDS.files.pdf],
    ['editor', C.pageOne, ''],
  ] as const)("lockFile file-locks the item over another user's lock for the %s actor and redirects to its download", async (subject, contentId, fileId) => {
    addStats(contentId, { lockid: APPROVER_ID, locktype: 'node' });
    expect(await lockFile(deps, actorOf(subject), { contentId, siteId: SITE, context: '/masa' })).toEqual({
      locked: true,
      location: `/masa/index.cfm/_api/render/file/?fileid=${fileId}&method=attachment`,
    });
    expect(statsWrites()).toEqual(['update']);
    expect(statsOf(contentId)).toMatchObject({ lockid: SUBJECT_USER_IDS[subject], locktype: 'file' });
  });

  it('lockFile inserts the stats row of an item without one', async () => {
    expect(await lockFile(deps, S2, { contentId: C.fileNode, siteId: SITE, context: '' })).toMatchObject({ locked: true });
    expect(statsWrites()).toEqual(['insert']);
    expect(statsOf(C.fileNode)).toMatchObject({ lockid: SUBJECT_USER_IDS.s2, locktype: 'file' });
  });

  it.each(['approver', 'member'] as const)('lockFile refuses the %s actor without author or editor rights and writes nothing', async (subject) => {
    expect(await lockFile(deps, actorOf(subject), { contentId: C.pageOne, siteId: SITE, context: '' })).toEqual({ locked: false });
    expect(db.writes()).toEqual([]);
  });

  describe.each([
    ['unlockFile', unlockFile],
    ['unlockNode', unlockNode],
  ] as const)('%s', (_action, unlock) => {
    it.each([
      ['clears the lock the actor holds', 'editor', EDITOR_ID, true],
      ["clears another user's lock for an s2 actor", 's2', EDITOR_ID, true],
      ["leaves another user's lock for an actor without s2", 'approver', EDITOR_ID, false],
      ['reports false where no lock is held', 'editor', null, false],
    ] as const)('%s', async (_case, subject, lockId, cleared) => {
      addStats(C.pageOne, { lockid: lockId, locktype: lockId === null ? null : 'node' });
      expect(await unlock(deps, actorOf(subject), { contentId: C.pageOne, siteId: SITE })).toBe(cleared);
      expect(statsWrites()).toEqual(cleared ? ['update'] : []);
      expect(statsOf(C.pageOne)).toMatchObject(cleared ? { lockid: null, locktype: null } : { lockid: lockId });
    });
  });

  it('unlocks nothing for an item without an active version', async () => {
    expect(await unlockNode(deps, S2, { contentId: MISSING, siteId: SITE })).toBe(false);
    expect(db.writes()).toEqual([]);
  });
});

