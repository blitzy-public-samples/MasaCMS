/** `repo/content-queries` clause builders, version, object and assignment reads, crumbs, the content tree and getNest's SQL window over a throwaway `content` schema. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { getNest } from '../../src/domain/content-tree.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type DomainDeps } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import {
  ContentQueryError,
  ROOT_PARENT_ID,
  SITE_TREE_MODULE_ID,
  SqlParams,
  activeClause,
  categoryAssignments,
  contentAssignments,
  contentIdFromHistId,
  contentObject,
  contentObjects,
  count,
  crumbPath,
  expireAssignments,
  extendedCastColumn,
  extendedSortJoin,
  extendedSortKey,
  histIdFromContentId,
  isExtendedSort,
  itemCount,
  kids,
  kidsCount,
  menuTypeClause,
  mobileClause,
  nest,
  nestCount,
  pageCount,
  readActive,
  readActiveByFilename,
  readActiveByRemoteId,
  readActiveByTitle,
  readActiveByUrlTitle,
  readVersion,
  regionObjects,
  relatedItems,
  sections,
  sortDirectionOf,
  stats,
  tags,
  timespanInterval,
  versionParents,
  type ChangesetPreview,
  type KidsArgs,
  type NestRow,
  type SqlFragment,
} from '../../src/repo/content-queries.js';
import { CONTENT_UNITS, UNIT_OF } from '../../src/repo/tables.js';

/** A CF UUID (8-4-4-16) whose first group is `n` in hex. */
const cfId = (n: number): string => `${n.toString(16).toUpperCase().padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;

const SITE = TENANT_A.siteId;
const OTHER_SITE = 'other-site';
const HOME = `${'0'.repeat(34)}1`;
const COMPONENT_MODULE = `${'0'.repeat(34)}3`;
const HOME_H = cfId(0x01);
const FOLDER = cfId(0x10);
const FOLDER_H = cfId(0x11);
const BETA = cfId(0x20);
const BETA_H = cfId(0x21);
const BETA_OLD_H = cfId(0x22);
const BETA_DRAFT_H = cfId(0x23);
const ALPHA = cfId(0x30);
const ALPHA_H = cfId(0x31);
const FUTURE = cfId(0x40);
const FUTURE_H = cfId(0x41);
const HIDDEN = cfId(0x50);
const HIDDEN_H = cfId(0x51);
const GAMMA = cfId(0x60);
const GAMMA_H = cfId(0x61);
const COMP = cfId(0x70);
const COMP_H = cfId(0x71);
const CHILD = cfId(0x80);
const CHILD_H = cfId(0x81);
const ORPHAN = cfId(0x90);
const ROOTLESS = cfId(0x98);
const LOOP_1 = cfId(0xa0);
const LOOP_2 = cfId(0xb0);
const EVENTS = cfId(0xc0);
const EVENTS_H = cfId(0xc1);
const MISSING = cfId(0xee);
const FILE_ID = cfId(0xf0);
const CAT_1 = cfId(0xf1);
const CAT_2 = cfId(0xf2);
const SET_1 = cfId(0xf3);
const LOCK = cfId(0xf4);
const REQUEST = cfId(0xf5);
const GROUP = cfId(0xf6);
const CHAIN = cfId(0xf7);
const USER_1 = cfId(0xe1);
const USER_2 = cfId(0xe2);
const USER_3 = cfId(0xe3);

const WINDOW_PARENT = cfId(0x100);
const W = {
  FIXED: cfId(0x101),
  CAL_TODAY: cfId(0x102),
  CAL_PAST: cfId(0x103),
  CAL_FUTURE: cfId(0x104),
  REL_DAY: cfId(0x105),
  REL_MONTH: cfId(0x106),
  REL_YEAR: cfId(0x107),
  UPD_DAY: cfId(0x108),
  SPAN: cfId(0x109),
} as const;

const TODAY = new Date(2026, 5, 30, 12, 0, 0);
const MENU_DATE = new Date(2026, 5, 15, 10, 0, 0);
const PREVIEW: ChangesetPreview = { contentIds: [BETA], contentHistIds: [BETA_DRAFT_H] };
const KIDS: KidsArgs = { siteId: SITE, parentId: FOLDER, today: TODAY };

// contentDAO variables.fieldlist, then the readVersion joins.
const VERSION_COLUMNS = [
  ...'active,approved,audience,body,contenthistid,contentid,credits,display,displaystart,displaystop,featurestart,featurestop,fileid,filename,forcessl,inheritobjects,isfeature,islocked,isnav,keypoints,lastupdate,lastupdateby,lastupdatebyid,menutitle,metadesc,metakeywords,moduleassign,moduleid,nextn,notes,orderno,parentid,displaytitle,releasedate,remoteid,remotepubdate,remotesource,remotesourceurl,remoteurl,responsechart,responsedisplayfields,responsemessage,responsesendto,restricted,restrictgroups,searchexclude,siteid,sortby,sortdirection,summary,target,targetparams,template,title,type,subtype,path,tags,docache,created,urltitle,htmltitle,mobileexclude,changesetid,imagesize,imageheight,imagewidth,childtemplate,majorversion,minorversion,expires,displayinterval,objectparams'.split(','),
  ...['filesize', 'contenttype', 'contentsubtype', 'fileext', 'assocfilename', 'approvalstatus', 'requestid', 'approvalgroupid'],
];
const KIDS_COLUMNS =
  'title,releasedate,menutitle,lastupdate,summary,tags,filename,type,subtype,siteid,contentid,contenthistid,target,targetparams,restricted,restrictgroups,displaystart,displaystop,orderno,sortby,sortdirection,fileid,credits,remotesource,remotesourceurl,remoteurl,filesize,fileext,audience,keypoints,rating,totalvotes,downvotes,upvotes,comments,parenttype,kids,path,created,nextn,majorversion,minorversion,lockid,locktype,expires,assocfilename,displayinterval,display,filealttext,changesetid'.split(
    ',',
  );
const NEST_COLUMNS =
  'contenthistid,contentid,moduleid,approved,filename,active,type,subtype,orderno,parentid,title,menutitle,lastupdate,lastupdateby,lastupdatebyid,display,displaystart,displaystop,isnav,restricted,haskids,isfeature,inheritobjects,target,targetparams,islocked,sortby,sortdirection,releasedate,filesize,fileext,contenttype,contentsubtype,siteid,featurestart,featurestop,template,childtemplate,majorversion,minorversion,lockid,locktype,expires,rating,totalvotes,comments,assocfilename,displayinterval,fileid,filealttext,remoteurl'.split(
    ',',
  );
const CRUMB_KEYS =
  'type,subtype,filename,title,menutitle,urltitle,target,contentid,parentid,siteid,restricted,restrictgroups,template,contenthistid,targetprams,metadesc,metakeywords,sortby,sortdirection,inheritobjects,fileext,chainid,exemptid,moduleid'.split(
    ',',
  );

type Row = Record<string, unknown>;

let handle: ThrowawaySchema;

async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const names = Object.keys(row);
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }
}

/** A live navigable site-tree page of tenant A's site, overridden by `row`. */
const page = (row: Row): Row => ({
  siteid: SITE,
  moduleid: SITE_TREE_MODULE_ID,
  type: 'Page',
  active: 1,
  approved: 1,
  isnav: 1,
  display: 1,
  lastupdate: '2025-01-01 00:00:00',
  ...row,
});

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_B.tenantId, fn);
const histIds = (rows: readonly { contenthistid: string | null }[]): (string | null)[] => rows.map((row) => row.contenthistid);

/** Content ids of tenant B's window rows that `clause` (numbered from $2) admits, in insertion order. */
async function windowRows(clause: SqlFragment): Promise<string[]> {
  return inB(async (tx) => {
    const { rows } = await tx.query<{ contentid: string }>(
      `SELECT tcontent.contentid FROM ${handle.schema}.content tcontent WHERE tcontent.parentid = $1 AND (${clause.sql}) ORDER BY tcontent.tcontent_id`,
      [WINDOW_PARENT, ...clause.params],
    );
    return rows.map((row) => row.contentid);
  });
}

describe('content-queries clause builders', () => {
  it('numbers placeholders from the offset and appends included fragments', () => {
    const p = new SqlParams(2);
    expect(p.add('a')).toBe('$3');
    expect(p.next).toBe(3);
    expect(p.include({ sql: 'x = $4 AND y = $5', params: [1, 2] })).toBe('x = $4 AND y = $5');
    expect(p.next).toBe(5);
    const fragment = p.fragment('done');
    expect(fragment).toEqual({ sql: 'done', params: ['a', 1, 2] });
    p.add('b');
    expect(fragment.params).toHaveLength(3);
  });

  it('names ContentQueryError', () => {
    const err = new ContentQueryError('failed');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ContentQueryError');
    expect(err.message).toBe('failed');
  });

  it.each<[string, number | undefined, number]>([
    ['the five-minute default', undefined, 1505],
    ['a zero timespan as the default', 0, 1505],
    ['a one-minute timespan', 59, 1500],
  ])('rounds down to %s interval plus one second', (_label, seconds, expected) => {
    const date = new Date(1512_400);
    expect(timespanInterval(date, seconds).getTime()).toBe(expected * 1000);
  });

  it.each<[string, Parameters<typeof activeClause>, SqlFragment]>([
    ['live versions', ['t'], { sql: '(t.active = 1 AND t.approved = 1)', params: [] }],
    ['active versions without liveOnly', ['t', null, { liveOnly: false }], { sql: '(t.active = 1)', params: [] }],
    ['live versions for an empty preview', ['t', { contentIds: [], contentHistIds: [] }], { sql: '(t.active = 1 AND t.approved = 1)', params: [] }],
    [
      'preview versions in place of their live ones',
      ['t', PREVIEW, { offset: 2 }],
      {
        sql: '((t.active = 1 AND t.approved = 1 AND t.contentid <> ALL($3::bpchar[])) OR t.contenthistid = ANY($4::bpchar[]))',
        params: [[BETA], [BETA_DRAFT_H]],
      },
    ],
    ['every version without activeOnly', ['t', PREVIEW, { activeOnly: false }], { sql: 'TRUE', params: [] }],
  ])('activeClause renders %s', (_label, args, expected) => {
    expect(activeClause(...args)).toEqual(expected);
  });

  it.each([
    [false, '(t.mobileexclude IS NULL OR t.mobileexclude IN (0, 1))'],
    [true, '(t.mobileexclude IS NULL OR t.mobileexclude IN (0, 2))'],
  ])('mobileClause for a mobile request %s', (mobile, expected) => {
    expect(mobileClause('t', mobile)).toBe(expected);
  });

  it('mobileClause defaults to a desktop request', () => {
    expect(mobileClause('t')).toBe(mobileClause('t', false));
  });

  it.each<[string | null | undefined, 'asc' | 'desc' | undefined, string]>([
    ['ASC', undefined, 'asc'],
    ['Desc', undefined, 'desc'],
    ['sideways', undefined, 'asc'],
    [null, undefined, 'asc'],
    [undefined, 'desc', 'desc'],
  ])('sortDirectionOf(%s) with fallback %s is %s', (value, fallback, expected) => {
    expect(sortDirectionOf(value, fallback)).toBe(expected);
  });

  it.each<[string, readonly string[] | undefined, boolean]>([
    ['Title', undefined, false],
    ['credits', undefined, false],
    ['Priority', undefined, true],
    ['comments', undefined, true],
    ['credits', ['title'], true],
  ])('isExtendedSort(%s, %j) is %s', (sortBy, options, expected) => {
    expect(isExtendedSort(sortBy, options)).toBe(expected);
  });

  it.each([
    ['numericvalue', 'desc', 'qextendedsort.extendedsort DESC NULLS LAST'],
    ['datetimevalue', 'asc', 'qextendedsort.extendedsort ASC NULLS FIRST'],
    ['stringvalue', 'asc', 'lower(qextendedsort.extendedsort) ASC NULLS FIRST'],
  ] as const)('extendedSortKey orders %s %s', (cast, direction, expected) => {
    expect(extendedSortKey(cast, direction)).toBe(expected);
  });

  it('extendedSortJoin joins the attribute value on the version, numbered from the offset', () => {
    expect(extendedSortJoin('s', 'tcontent', 'numericvalue', SITE, 'Priority', 3)).toEqual({
      sql:
        'LEFT JOIN (SELECT tclassextenddata.numericvalue AS extendedsort, tclassextenddata.baseid FROM "s"."extend_data" tclassextenddata' +
        ' INNER JOIN "s"."extend_attribute" tclassextendattributes ON (tclassextenddata.attributeid = tclassextendattributes.attributeid)' +
        ' WHERE tclassextendattributes.siteid = $4 AND lower(rtrim(tclassextendattributes.name)) = lower(rtrim($5::text))) qextendedsort' +
        ' ON (tcontent.contenthistid = qextendedsort.baseid)',
      params: [SITE, 'Priority'],
    });
  });

  it.each<[string, Date[]]>([
    ['calendar', [new Date(2026, 6, 1, 10, 0, 0), new Date(2026, 5, 30, 10, 0, 0)]],
    ['fixed', []],
    ['default', [new Date(2026, 5, 30, 10, 0, 0), new Date(2026, 5, 30, 10, 0, 0)]],
  ])('menuTypeClause %s binds its window dates in placeholder order', (menuType, params) => {
    const clause = menuTypeClause('t', menuType, new Date(2026, 5, 30, 10, 0, 0), { offset: 4 });
    expect(clause.params).toEqual(params);
    expect(clause.sql.match(/\$\d+/g) ?? []).toEqual(params.map((_, i) => `$${i + 5}`));
  });

  it('menuTypeClause ReleaseMonth compares display windows with the caller clock and clamps the next month', () => {
    const now = new Date(2026, 0, 20, 9, 0, 0);
    const clause = menuTypeClause('t', 'ReleaseMonth', new Date(2026, 0, 31, 8, 0, 0), { now });
    const febFirst = new Date(2026, 1, 1);
    const janFirst = new Date(2026, 0, 1);
    expect(clause.params).toEqual([now, new Date(2026, 1, 28, 8, 0, 0), now, febFirst, janFirst, febFirst, janFirst]);
    expect(clause.sql.startsWith('(t.display = 1 OR (t.display = 2 AND (t.displaystart <= $1 AND t.displaystart < $2')).toBe(true);
  });
});

describe.skipIf(!(await pgAvailable()))('repo/content-queries versions and tree', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await inA(async (tx) => {
      await insert(tx, 'content', [
        page({ contentid: HOME, contenthistid: HOME_H, parentid: ROOT_PARENT_ID, title: 'Home', menutitle: 'Home', path: HOME, orderno: 1 }),
        page({
          contentid: FOLDER,
          contenthistid: FOLDER_H,
          parentid: HOME,
          type: 'Folder',
          title: 'News',
          menutitle: '',
          filename: 'news',
          template: 'two.cfm',
          childtemplate: 'child.cfm',
          path: `${HOME},${FOLDER}`,
          orderno: 2,
        }),
        page({
          contentid: BETA,
          contenthistid: BETA_H,
          parentid: FOLDER,
          title: 'Beta',
          menutitle: 'Beta',
          urltitle: 'beta',
          filename: 'news/beta',
          remoteid: 'REM-1',
          body: 'first body',
          fileid: FILE_ID,
          isfeature: 1,
          releasedate: '2026-06-10 09:00:00',
          lastupdate: '2026-06-11 09:00:00',
          template: 'page.cfm',
          childtemplate: '',
          targetparams: 'width=1',
          path: `${HOME},${FOLDER},${BETA}`,
          orderno: 2,
        }),
        page({ contentid: BETA, contenthistid: BETA_OLD_H, parentid: FOLDER, title: 'Beta old', filename: 'news/beta', active: 0, orderno: 2 }),
        page({
          contentid: BETA,
          contenthistid: BETA_DRAFT_H,
          parentid: FOLDER,
          title: 'Beta draft',
          menutitle: 'Beta draft',
          urltitle: 'beta',
          filename: 'news/beta',
          remoteid: 'REM-1',
          active: 0,
          approved: 0,
          orderno: 2,
        }),
        page({
          contentid: ALPHA,
          contenthistid: ALPHA_H,
          parentid: FOLDER,
          title: 'alpha',
          menutitle: 'Alpha Menu',
          filename: 'news/alpha',
          body: 'Second body',
          display: 2,
          displaystart: '2026-06-01 00:00:00',
          isfeature: 2,
          featurestart: '2026-06-01 00:00:00',
          releasedate: '2026-06-20 09:00:00',
          lastupdate: '2026-06-21 09:00:00',
          orderno: 1,
        }),
        page({ contentid: FUTURE, contenthistid: FUTURE_H, parentid: FOLDER, title: 'Future', filename: 'news/future', display: 2, displaystart: '2026-07-15 00:00:00', orderno: 4 }),
        page({ contentid: HIDDEN, contenthistid: HIDDEN_H, parentid: FOLDER, title: 'Hidden', filename: 'news/hidden', isnav: 0, orderno: 5 }),
        page({
          contentid: GAMMA,
          contenthistid: GAMMA_H,
          parentid: FOLDER,
          title: 'Gamma',
          menutitle: 'Gamma',
          filename: 'news/gamma',
          body: 'third',
          mobileexclude: 1,
          isfeature: 2,
          featurestart: '2026-06-01 00:00:00',
          featurestop: '2026-06-15 00:00:00',
          lastupdate: '2026-06-05 09:00:00',
          orderno: 3,
        }),
        page({ contentid: COMP, contenthistid: COMP_H, parentid: FOLDER, type: 'Component', moduleid: COMPONENT_MODULE, title: 'Comp', orderno: 6 }),
        page({
          contentid: CHILD,
          contenthistid: CHILD_H,
          parentid: BETA,
          title: 'Grandchild',
          menutitle: 'Grandchild',
          filename: 'news/beta/grandchild',
          path: `${HOME},${FOLDER},${BETA},${CHILD}`,
          orderno: 1,
        }),
        page({ contentid: ORPHAN, contenthistid: cfId(0x91), parentid: MISSING, title: 'Orphan', filename: 'orphan' }),
        page({ contentid: ROOTLESS, contenthistid: cfId(0x99), parentid: null, type: 'Link', title: 'Rootless', filename: 'rootless' }),
        page({ contentid: LOOP_1, contenthistid: cfId(0xa1), parentid: LOOP_2, title: 'Loop 1', filename: 'loop-1' }),
        page({ contentid: LOOP_2, contenthistid: cfId(0xb1), parentid: LOOP_1, title: 'Loop 2', filename: 'loop-2' }),
        page({
          contentid: EVENTS,
          contenthistid: EVENTS_H,
          parentid: HOME,
          type: 'Calendar',
          title: 'Events',
          menutitle: 'Events',
          filename: 'events',
          display: 2,
          displaystart: '2026-06-01 00:00:00',
          displaystop: '2026-12-31 00:00:00',
          orderno: 3,
        }),
        page({ contentid: cfId(0xd0), contenthistid: cfId(0xd1), siteid: OTHER_SITE, parentid: FOLDER, title: 'Elsewhere', filename: 'elsewhere', orderno: 7 }),
        page({ contentid: COMPONENT_MODULE, contenthistid: cfId(0x03), parentid: ROOT_PARENT_ID, type: 'Module', moduleid: COMPONENT_MODULE, title: 'Components' }),
      ]);
      await insert(tx, 'file', [
        { fileid: FILE_ID, contentid: BETA, siteid: SITE, filename: 'beta.png', filesize: 3, contenttype: 'image', contentsubtype: 'png', fileext: 'png' },
      ]);
      await insert(tx, 'file_metadata', [{ metaid: cfId(0xf8), fileid: FILE_ID, contenthistid: BETA_H, contentid: BETA, siteid: SITE, alttext: 'beta alt' }]);
      await insert(tx, 'approval_request', [{ requestid: REQUEST, contenthistid: BETA_H, groupid: GROUP, siteid: SITE, status: 'Pending' }]);
      await insert(tx, 'approval_assignment', [{ assignmentid: cfId(0xf9), contentid: FOLDER, siteid: SITE, chainid: CHAIN, exemptid: 'exempt-group' }]);
      await insert(tx, 'content_stats', [
        {
          contentid: BETA,
          siteid: SITE,
          views: 10,
          rating: 4,
          totalvotes: 3,
          upvotes: 3,
          downvotes: 0,
          comments: 2,
          majorversion: 1,
          minorversion: 2,
          lockid: LOCK,
          locktype: 'node',
          disablecomments: 0,
        },
        { contentid: ALPHA, siteid: SITE, rating: 2, totalvotes: 1, comments: 5 },
      ]);
      await insert(tx, 'content_object', [
        { contenthistid: BETA_H, contentid: BETA, objectid: 'obj-1', object: 'component', name: 'Side', columnid: 2, orderno: 1, siteid: SITE, params: '{"a":1}' },
        { contenthistid: BETA_H, contentid: BETA, objectid: 'obj-2', object: 'feed', name: 'Feed', columnid: 1, orderno: 2, siteid: SITE, params: null },
        { contenthistid: BETA_H, contentid: BETA, objectid: 'obj-3', object: 'plugin', name: 'Plugin', columnid: 1, orderno: 1, siteid: SITE, params: '' },
        { contenthistid: BETA_H, contentid: BETA, objectid: 'obj-4', object: 'form', name: 'Form', columnid: 1, orderno: 3, siteid: OTHER_SITE, params: null },
      ]);
      await insert(tx, 'content_related', [
        { contenthistid: BETA_H, contentid: BETA, relatedid: GAMMA, siteid: SITE, relatedcontentsetid: SET_1, orderno: 1 },
        { contenthistid: BETA_H, contentid: BETA, relatedid: ALPHA, siteid: SITE, relatedcontentsetid: null, orderno: 2 },
        { contenthistid: BETA_H, contentid: BETA, relatedid: FUTURE, siteid: OTHER_SITE, relatedcontentsetid: null, orderno: 3 },
      ]);
      await insert(tx, 'content_tag', [
        { contenthistid: BETA_H, contentid: BETA, siteid: SITE, tag: 'Red', taggroup: null },
        { contenthistid: BETA_H, contentid: BETA, siteid: SITE, tag: 'Sky', taggroup: 'colors' },
        { contenthistid: BETA_H, contentid: BETA, siteid: SITE, tag: 'Sea', taggroup: 'colors' },
        { contenthistid: GAMMA_H, contentid: GAMMA, siteid: SITE, tag: 'blue', taggroup: 'colors' },
      ]);
      await insert(tx, 'content_category_assign', [
        { contenthistid: BETA_H, categoryid: CAT_2, contentid: BETA, isfeature: 0, orderno: 2, siteid: SITE },
        { contenthistid: BETA_H, categoryid: CAT_1, contentid: BETA, isfeature: 1, orderno: 1, siteid: SITE, featurestart: '2026-06-01 00:00:00' },
        { contenthistid: GAMMA_H, categoryid: CAT_1, contentid: GAMMA, isfeature: 0, orderno: 1, siteid: SITE },
      ]);
      await insert(tx, 'content_assignment', [
        { contentid: BETA, contenthistid: BETA_H, siteid: SITE, userid: USER_2, type: 'expire' },
        { contentid: BETA, contenthistid: BETA_H, siteid: SITE, userid: USER_1, type: 'draft' },
        { contentid: BETA, contenthistid: BETA_H, siteid: SITE, userid: USER_3, type: 'expire' },
      ]);
      await insert(tx, 'extend_attribute', [
        { attributeid: 101, siteid: SITE, name: 'Priority', validation: 'Numeric' },
        { attributeid: 102, siteid: SITE, name: 'Label', validation: null },
        { attributeid: 103, siteid: SITE, name: 'When', validation: 'Date' },
        { attributeid: 104, siteid: OTHER_SITE, name: 'Rank', validation: 'Numeric' },
      ]);
      await insert(tx, 'extend_data', [
        { baseid: BETA_H, attributeid: 101, siteid: SITE, numericvalue: 1 },
        { baseid: ALPHA_H, attributeid: 101, siteid: SITE, numericvalue: 3 },
        { baseid: GAMMA_H, attributeid: 101, siteid: SITE, numericvalue: 2 },
        { baseid: BETA_H, attributeid: 102, siteid: SITE, stringvalue: 'b' },
        { baseid: ALPHA_H, attributeid: 102, siteid: SITE, stringvalue: 'C' },
        { baseid: GAMMA_H, attributeid: 102, siteid: SITE, stringvalue: 'a' },
      ]);
    });
    await inB(async (tx) => {
      const windowRow = (contentid: string, row: Row): Row => ({
        ...page({ contentid, contenthistid: contentid, parentid: WINDOW_PARENT, siteid: TENANT_B.siteId, title: contentid }),
        ...row,
      });
      await insert(tx, 'content', [
        windowRow(W.FIXED, {}),
        windowRow(W.CAL_TODAY, { display: 2, displaystart: '2026-06-15 18:00:00', lastupdate: '2026-06-03 09:00:00' }),
        windowRow(W.CAL_PAST, { display: 2, displaystart: '2026-06-01 00:00:00', displaystop: '2026-06-10 00:00:00' }),
        windowRow(W.CAL_FUTURE, { display: 2, displaystart: '2026-07-02 00:00:00' }),
        windowRow(W.REL_DAY, { releasedate: '2026-06-15 12:00:00' }),
        windowRow(W.REL_MONTH, { releasedate: '2026-06-02 00:00:00' }),
        windowRow(W.REL_YEAR, { releasedate: '2026-02-01 00:00:00' }),
        windowRow(W.UPD_DAY, { lastupdate: '2026-06-15 11:00:00' }),
        windowRow(W.SPAN, { display: 2, displaystart: '2026-05-01 00:00:00', displaystop: '2026-07-31 00:00:00' }),
      ]);
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  const DEFAULT_WINDOW = [W.FIXED, W.REL_DAY, W.REL_MONTH, W.REL_YEAR, W.UPD_DAY, W.SPAN];
  it.each<[string, string[]]>([
    ['Calendar', [W.CAL_TODAY, W.SPAN]],
    ['CALENDARDATE', [W.CAL_TODAY, W.SPAN]],
    ['calendar_features', [W.CAL_TODAY, W.CAL_FUTURE, W.SPAN]],
    ['ReleaseDate', [W.REL_DAY, W.UPD_DAY]],
    ['ReleaseMonth', [W.REL_DAY, W.REL_MONTH, W.UPD_DAY]],
    ['CalendarMonth', [W.CAL_TODAY, W.CAL_PAST, W.SPAN]],
    ['ReleaseYear', [W.CAL_TODAY, W.REL_DAY, W.REL_MONTH, W.REL_YEAR, W.UPD_DAY]],
    ['fixed', [W.FIXED, W.REL_DAY, W.REL_MONTH, W.REL_YEAR, W.UPD_DAY]],
    ['default', DEFAULT_WINDOW],
    ['CalendarYear', DEFAULT_WINDOW],
    ['FixedDate', DEFAULT_WINDOW],
  ])('menuTypeClause %s selects the legacy display window on PostgreSQL', async (menuType, expected) => {
    const clause = menuTypeClause('tcontent', menuType, MENU_DATE, { offset: 1 });
    expect(clause.sql.match(/\$\d+/g) ?? []).toEqual(clause.params.map((_, i) => `$${i + 2}`));
    expect(await windowRows(clause)).toEqual(expected);
  });

  it('menuTypeClause ReleaseMonth admits a display window already open at the caller clock', async () => {
    const clause = menuTypeClause('tcontent', 'ReleaseMonth', MENU_DATE, { offset: 1, now: new Date(2026, 5, 20) });
    expect(await windowRows(clause)).toEqual([W.CAL_TODAY, W.REL_DAY, W.REL_MONTH, W.UPD_DAY]);
  });

  it('readVersion selects the contentDAO field list with its file and approval-request joins', async () => {
    const [row, ...rest] = await inA((tx) => readVersion(tx, { contentHistId: BETA_H }));
    expect(rest).toEqual([]);
    expect(Object.keys(row ?? {})).toEqual(VERSION_COLUMNS);
    expect(row).toMatchObject({
      contentid: BETA,
      title: 'Beta',
      forcessl: 0,
      filesize: 3,
      contenttype: 'image',
      contentsubtype: 'png',
      fileext: 'png',
      assocfilename: 'beta.png',
      approvalstatus: 'Pending',
      requestid: REQUEST,
      approvalgroupid: GROUP,
    });
    expect(row?.releasedate).toEqual(new Date(2026, 5, 10, 9, 0, 0));
  });

  it('versionParents reads the parent of each listed version by id in any case, skipping unknown and empty ids', async () => {
    const lower = BETA_H.toLowerCase();
    expect(await inA((tx) => versionParents(tx, { contentHistIds: [lower, HOME_H, cfId(0xfff), ''] }))).toEqual(
      new Map([[lower, FOLDER], [HOME_H, ROOT_PARENT_ID]]),
    );
    expect(await inA((tx) => versionParents(tx, { contentHistIds: [''] }))).toEqual(new Map());
  });

  it.each<[string, (tx: TenantTx) => Promise<{ contenthistid: string | null }[]>, string[]]>([
    ['readVersion of an empty id', (tx) => readVersion(tx, { contentHistId: '' }), []],
    ['readVersion of a draft', (tx) => readVersion(tx, { contentHistId: BETA_DRAFT_H }), [BETA_DRAFT_H]],
    ['readVersion of a lower-case id', (tx) => readVersion(tx, { contentHistId: BETA_H.toLowerCase() }), [BETA_H]],
    ['readVersion of a missing id', (tx) => readVersion(tx, { contentHistId: MISSING }), []],
    ['readActive of an empty id', (tx) => readActive(tx, { siteId: SITE, contentId: '' }), []],
    ['readActive', (tx) => readActive(tx, { siteId: SITE, contentId: BETA }), [BETA_H]],
    ['readActive in a preview', (tx) => readActive(tx, { siteId: SITE, contentId: BETA, preview: PREVIEW }), [BETA_DRAFT_H]],
    ['readActive in another site', (tx) => readActive(tx, { siteId: OTHER_SITE, contentId: BETA }), []],
    ['readActive of a component', (tx) => readActive(tx, { siteId: SITE, contentId: COMP }), [COMP_H]],
    ['readActiveByRemoteId of an empty id', (tx) => readActiveByRemoteId(tx, { siteId: SITE, remoteId: '' }), []],
    ['readActiveByRemoteId case-insensitively', (tx) => readActiveByRemoteId(tx, { siteId: SITE, remoteId: 'rem-1' }), [BETA_H]],
    ['readActiveByRemoteId of a type', (tx) => readActiveByRemoteId(tx, { siteId: SITE, remoteId: 'REM-1', type: 'page' }), [BETA_H]],
    ['readActiveByRemoteId of another type', (tx) => readActiveByRemoteId(tx, { siteId: SITE, remoteId: 'REM-1', type: 'Folder' }), []],
    ['readActiveByTitle of an empty title', (tx) => readActiveByTitle(tx, { siteId: SITE, title: '' }), []],
    ['readActiveByTitle ignoring trailing spaces', (tx) => readActiveByTitle(tx, { siteId: SITE, title: 'BETA  ' }), [BETA_H]],
    ['readActiveByUrlTitle of an empty title', (tx) => readActiveByUrlTitle(tx, { siteId: SITE, urlTitle: '' }), []],
    ['readActiveByUrlTitle in a preview', (tx) => readActiveByUrlTitle(tx, { siteId: SITE, urlTitle: 'Beta', preview: PREVIEW }), [BETA_DRAFT_H]],
    ['readActiveByFilename of the home page', (tx) => readActiveByFilename(tx, { siteId: SITE, filename: '' }), [HOME_H]],
    ['readActiveByFilename case-insensitively', (tx) => readActiveByFilename(tx, { siteId: SITE, filename: 'NEWS/BETA' }), [BETA_H]],
    ['readActiveByFilename of a type', (tx) => readActiveByFilename(tx, { siteId: SITE, filename: 'news', type: 'Folder' }), [FOLDER_H]],
    ['readActiveByFilename of another type', (tx) => readActiveByFilename(tx, { siteId: SITE, filename: 'news', type: 'Page' }), []],
  ])('%s returns the matching versions', async (_label, read, expected) => {
    expect(histIds(await inA(read))).toEqual(expected);
  });

  it.each<[string, (tx: TenantTx) => Promise<string>, string]>([
    ['the content id of a version', (tx) => contentIdFromHistId(tx, { contentHistId: BETA_OLD_H.toLowerCase() }), BETA],
    ['no content id for a missing version', (tx) => contentIdFromHistId(tx, { contentHistId: MISSING }), ''],
    ['the active version of a content id', (tx) => histIdFromContentId(tx, { contentId: BETA, siteId: SITE }), BETA_H],
    ['the preview version of a content id', (tx) => histIdFromContentId(tx, { contentId: BETA, siteId: SITE, preview: PREVIEW }), BETA_DRAFT_H],
    ['the live version titled by a non-UUID', (tx) => histIdFromContentId(tx, { contentId: 'beta', siteId: SITE }), BETA_H],
    ['no version for a title that is not live', (tx) => histIdFromContentId(tx, { contentId: 'Beta draft', siteId: SITE }), ''],
    ['no version for the home id, which is not a CF UUID', (tx) => histIdFromContentId(tx, { contentId: HOME, siteId: SITE }), ''],
    ['no version in another site', (tx) => histIdFromContentId(tx, { contentId: BETA, siteId: OTHER_SITE }), ''],
  ])('maps ids: %s', async (_label, read, expected) => {
    expect(await inA(read)).toBe(expected);
  });

  it('reads display objects by region and position, per site or per region', async () => {
    const all = await inA((tx) => contentObjects(tx, { contentHistId: BETA_H, siteId: SITE }));
    expect(all.map((row) => row.objectid)).toEqual(['obj-3', 'obj-2', 'obj-1']);
    expect(Object.keys(all[0] ?? {})).toEqual(['contenthistid', 'contentid', 'objectid', 'siteid', 'object', 'name', 'columnid', 'orderno', 'params']);
    const region = await inA((tx) => regionObjects(tx, { contentHistId: BETA_H, columnId: 1, siteId: SITE }));
    expect(region.map((row) => row.objectid)).toEqual(['obj-3', 'obj-2', 'obj-4']);
    const [object, ...rest] = await inA((tx) => contentObject(tx, { contentHistId: BETA_H, columnId: 2, orderNo: 1 }));
    expect(rest).toEqual([]);
    expect(object).toEqual({
      contenthistid: BETA_H,
      objectid: 'obj-1',
      object: 'component',
      contentid: BETA,
      name: 'Side',
      orderno: 1,
      siteid: SITE,
      columnid: 2,
      params: '{"a":1}',
    });
    expect(await inA((tx) => contentObject(tx, { contentHistId: BETA_H, columnId: 2, orderNo: 9 }))).toEqual([]);
  });

  it.each<[string, string | undefined, string[]]>([
    ['every set', undefined, [GAMMA, ALPHA]],
    ['an empty set id as every set', '', [GAMMA, ALPHA]],
    ['one related-content set', SET_1.toLowerCase(), [GAMMA]],
  ])('relatedItems reads the site links of %s in insertion order', async (_label, relatedContentSetId, expected) => {
    const rows = await inA((tx) =>
      relatedItems(tx, { contentHistId: BETA_H, siteId: SITE, ...(relatedContentSetId === undefined ? {} : { relatedContentSetId }) }),
    );
    expect(rows.map((row) => row.relatedid)).toEqual(expected);
    expect(Object.keys(rows[0] ?? {})).toEqual(['relatedid', 'relatedcontentsetid', 'orderno']);
  });

  it('reads tags in custom tag groups in insertion order', async () => {
    expect(await inA((tx) => tags(tx, { contentHistId: BETA_H }))).toEqual([
      { tag: 'Sky', taggroup: 'colors' },
      { tag: 'Sea', taggroup: 'colors' },
    ]);
  });

  it('reads category assignments by category id', async () => {
    const rows = await inA((tx) => categoryAssignments(tx, { contentHistId: BETA_H }));
    expect(rows.map((row) => row.categoryid)).toEqual([CAT_1, CAT_2]);
    expect(rows[0]).toEqual({
      contenthistid: BETA_H,
      categoryid: CAT_1,
      contentid: BETA,
      isfeature: 1,
      orderno: 1,
      siteid: SITE,
      featurestart: new Date(2026, 5, 1),
      featurestop: null,
    });
  });

  it('reads the stats row of a content item in its site, or null', async () => {
    expect(await inA((tx) => stats(tx, { contentId: BETA, siteId: SITE }))).toEqual({
      contentid: BETA,
      siteid: SITE,
      views: 10,
      rating: 4,
      totalvotes: 3,
      upvotes: 3,
      downvotes: 0,
      comments: 2,
      majorversion: 1,
      minorversion: 2,
      lockid: LOCK,
      locktype: 'node',
      disablecomments: 0,
    });
    expect(await inA((tx) => stats(tx, { contentId: BETA, siteId: OTHER_SITE }))).toBeNull();
  });

  it('reads draft and expiry assignments by type then user, and the expiry users alone', async () => {
    const rows = await inA((tx) => contentAssignments(tx, { contentHistId: BETA_H }));
    expect(rows.map((row) => [row.type, row.userid])).toEqual([
      ['draft', USER_1],
      ['expire', USER_2],
      ['expire', USER_3],
    ]);
    expect(Object.keys(rows[0] ?? {})).toEqual(['contentid', 'contenthistid', 'siteid', 'userid', 'type']);
    const expiring = await inA((tx) => expireAssignments(tx, { contentHistId: BETA_H }));
    expect(expiring.map((row) => row.userid).sort()).toEqual([USER_2, USER_3]);
  });

  it.each<[string, { attribute: string; datatype?: string | null }, string]>([
    ['an attribute name case-insensitively', { attribute: 'priority' }, 'numericvalue'],
    ['an attribute id', { attribute: '101' }, 'numericvalue'],
    ['a padded attribute id', { attribute: ' 103 ' }, 'datetimevalue'],
    ['an attribute without validation', { attribute: 'Label' }, 'stringvalue'],
    ['an attribute of another site', { attribute: 'Rank' }, 'stringvalue'],
    ['a missing attribute', { attribute: 'Missing' }, 'stringvalue'],
    ['a null datatype by lookup', { attribute: 'Priority', datatype: null }, 'numericvalue'],
    ['a numeric datatype', { attribute: 'Missing', datatype: 'Numeric' }, 'numericvalue'],
    ['a date datatype', { attribute: 'Missing', datatype: 'date' }, 'datetimevalue'],
    ['a datetime datatype', { attribute: 'Missing', datatype: 'DateTime' }, 'datetimevalue'],
    ['a timestamp datatype', { attribute: 'Missing', datatype: 'timestamp' }, 'datetimevalue'],
    ['any other datatype', { attribute: 'Priority', datatype: 'Email' }, 'stringvalue'],
  ])('extendedCastColumn casts %s', async (_label, args, expected) => {
    expect(await inA((tx) => extendedCastColumn(tx, { siteId: SITE, ...args }))).toBe(expected);
  });

  it('walks the crumbs from a node to the site root, self first', async () => {
    const crumbs = await inA((tx) => crumbPath(tx, { contentId: CHILD, siteId: SITE }));
    expect(crumbs.map((crumb) => crumb.contentid)).toEqual([CHILD, BETA, FOLDER, HOME]);
    expect(crumbs[0]?.parentarray).toEqual([CHILD, BETA, FOLDER, HOME]);
    expect(Object.keys(crumbs[0] ?? {})).toEqual([...CRUMB_KEYS, 'parentarray']);
    expect(Object.keys(crumbs[1] ?? {})).toEqual(CRUMB_KEYS);
    expect(crumbs[1]).toMatchObject({ contenthistid: BETA_H, menutitle: 'Beta', template: 'page.cfm', fileext: 'png', targetprams: 'width=1', chainid: null });
    expect(crumbs[2]).toMatchObject({ menutitle: 'News', title: 'News', template: 'child.cfm', chainid: CHAIN, exemptid: 'exempt-group', type: 'Folder' });
    expect(crumbs[3]).toMatchObject({ parentid: ROOT_PARENT_ID, fileext: null });
  });

  it('reads the crumbs of a stored path deepest first, keeping an empty menu title', async () => {
    const crumbs = await inA((tx) => crumbPath(tx, { contentId: CHILD, siteId: SITE, path: `${HOME},${FOLDER},${BETA},${CHILD}` }));
    expect(crumbs.map((crumb) => crumb.contenthistid)).toEqual([CHILD_H, BETA_H, FOLDER_H, HOME_H]);
    expect(crumbs[0]?.parentarray).toEqual([CHILD, BETA, FOLDER, HOME]);
    expect(crumbs[2]).toMatchObject({ menutitle: '', template: 'child.cfm', chainid: CHAIN });
  });

  it.each<[string, { contentId: string; siteId: string; path?: string }, string[]]>([
    ['a path without ids', { contentId: CHILD, siteId: SITE, path: ',,' }, []],
    ['the root parent id in any case', { contentId: ROOT_PARENT_ID.toLowerCase(), siteId: SITE }, []],
    ['another site', { contentId: CHILD, siteId: OTHER_SITE }, []],
    ['a missing parent', { contentId: ORPHAN, siteId: SITE }, [ORPHAN]],
    ['a NULL parent', { contentId: ROOTLESS, siteId: SITE }, [ROOTLESS]],
  ])('crumbPath stops at %s', async (_label, args, expected) => {
    const crumbs = await inA((tx) => crumbPath(tx, args));
    expect(crumbs.map((crumb) => crumb.contentid)).toEqual(expected);
    expect(crumbs[0]?.parentarray).toEqual(expected.length === 0 ? undefined : expected);
  });

  it('gives up a parent loop after 51 crumbs without parentarray', async () => {
    const crumbs = await inA((tx) => crumbPath(tx, { contentId: LOOP_1, siteId: SITE }));
    expect(crumbs).toHaveLength(51);
    expect(crumbs[0]?.parentarray).toBeUndefined();
    expect(crumbs[49]?.contentid).toBe(LOOP_2);
    expect(crumbs[50]?.contentid).toBe(LOOP_1);
  });

  it('kids selects the getKids column list with its file, metadata and stats joins', async () => {
    const rows = await inA((tx) => kids(tx, KIDS));
    expect(histIds(rows)).toEqual([ALPHA_H, BETA_H, GAMMA_H]);
    expect(Object.keys(rows[0] ?? {})).toEqual(KIDS_COLUMNS);
    expect(rows[1]).toMatchObject({
      filesize: 3,
      fileext: 'png',
      assocfilename: 'beta.png',
      filealttext: 'beta alt',
      rating: 4,
      totalvotes: 3,
      comments: 2,
      lockid: LOCK,
      locktype: 'node',
      parenttype: '',
      kids: null,
    });
    expect(rows[0]).toMatchObject({ filesize: null, rating: 2, lockid: null });
  });

  it.each<[string, Partial<KidsArgs>, string[]]>([
    ['the first rows within size', { size: 2 }, [ALPHA_H, BETA_H]],
    ['every row for size 0', { size: 0 }, [ALPHA_H, BETA_H, GAMMA_H]],
    ['title, case-insensitively', { sortBy: 'title' }, [ALPHA_H, BETA_H, GAMMA_H]],
    ['title descending', { sortBy: 'Title', sortDirection: 'DESC' }, [GAMMA_H, BETA_H, ALPHA_H]],
    ['release date descending, NULLs last', { sortBy: 'releasedate', sortDirection: 'desc' }, [ALPHA_H, BETA_H, GAMMA_H]],
    ['rating then votes, NULLs first', { sortBy: 'rating' }, [GAMMA_H, ALPHA_H, BETA_H]],
    ['stats comments descending', { sortBy: 'comments', sortDirection: 'desc' }, [ALPHA_H, BETA_H, GAMMA_H]],
    ['the default order for a listed non-column sort', { sortBy: 'credits' }, [ALPHA_H, BETA_H, GAMMA_H]],
    ['a numeric extended attribute', { sortBy: 'Priority' }, [BETA_H, GAMMA_H, ALPHA_H]],
    ['a numeric extended attribute descending', { sortBy: 'Priority', sortDirection: 'desc' }, [ALPHA_H, GAMMA_H, BETA_H]],
    ['a string extended attribute, case-insensitively', { sortBy: 'label' }, [GAMMA_H, BETA_H, ALPHA_H]],
    ['keywords in the title', { keywords: 'BET' }, [BETA_H]],
    ['keywords in the body', { keywords: 'second' }, [ALPHA_H]],
    ['features at the menu date', { hasFeatures: true }, [ALPHA_H, BETA_H]],
    ['category ids', { categoryIds: [CAT_1.toLowerCase()] }, [BETA_H, GAMMA_H]],
    ['an empty category list', { categoryIds: [] }, []],
    ['featured category assignments', { categoryIds: [CAT_1], hasFeatures: true }, [BETA_H]],
    ['a category intersection', { categoryIds: [CAT_1, CAT_2], useCategoryIntersect: true }, [BETA_H]],
    ['an intersection of no categories', { categoryIds: [], useCategoryIntersect: true }, []],
    ['a featured category intersection', { categoryIds: [CAT_1, CAT_2], useCategoryIntersect: true, hasFeatures: true }, []],
    ['related ids', { relatedIds: [BETA] }, [ALPHA_H, GAMMA_H]],
    ['an empty related list', { relatedIds: [] }, [ALPHA_H, BETA_H, GAMMA_H]],
    ['a tag, case-insensitively', { tag: 'RED' }, [BETA_H]],
    ['a tag list', { tag: 'red,blue' }, [BETA_H, GAMMA_H]],
    ['a tag in its tag group', { tag: 'blue', tagGroup: 'Colors' }, [GAMMA_H]],
    ['a tag outside the tag group', { tag: 'red', tagGroup: 'colors' }, []],
    ['a tag in the default tag group', { tag: 'red', tagGroup: 'Default' }, [BETA_H]],
    ['the preview version in place of the live one', { preview: PREVIEW }, [ALPHA_H, BETA_DRAFT_H, GAMMA_H]],
    ['a mobile request', { mobile: true }, [ALPHA_H, BETA_H]],
    ['the fixed menu type', { type: 'fixed' }, [BETA_H, GAMMA_H]],
    ['the calendar menu type', { type: 'Calendar' }, [ALPHA_H]],
    ['another module', { moduleId: COMPONENT_MODULE }, [COMP_H]],
    ['another parent', { parentId: BETA }, [CHILD_H]],
  ])('kids filters or orders by %s', async (_label, args, expected) => {
    expect(histIds(await inA((tx) => kids(tx, { ...KIDS, ...args })))).toEqual(expected);
  });

  it('kids aggregates the live navigable children of each child', async () => {
    const rows = await inA((tx) => kids(tx, { ...KIDS, aggregation: true }));
    expect(rows.map((row) => [row.contenthistid, row.kids])).toEqual([
      [ALPHA_H, null],
      [BETA_H, 1],
      [GAMMA_H, null],
    ]);
    const previewed = await inA((tx) => kids(tx, { ...KIDS, aggregation: true, preview: PREVIEW }));
    expect(previewed.map((row) => [row.contenthistid, row.kids])).toEqual([
      [ALPHA_H, null],
      [BETA_DRAFT_H, 1],
      [GAMMA_H, null],
    ]);
    const tagged = await inA((tx) => kids(tx, { ...KIDS, aggregation: true, tag: 'red' }));
    expect(tagged.map((row) => [row.contenthistid, row.kids])).toEqual([[BETA_H, 1]]);
  });

  it('kids sorts mxpRelevance as an extended attribute only with aggregation', async () => {
    await expect(inA((tx) => kids(tx, { ...KIDS, sortBy: 'mxpRelevance' }))).rejects.toBeInstanceOf(ContentQueryError);
    const rows = await inA((tx) => kids(tx, { ...KIDS, sortBy: 'mxpRelevance', aggregation: true }));
    expect(histIds(rows).sort()).toEqual([BETA_H, ALPHA_H, GAMMA_H].sort());
  });

  it.each<[string, (tx: TenantTx) => Promise<unknown>]>([
    ['kids', (tx) => kids(tx, { ...KIDS, sortBy: 'tcontent.credits' })],
    ['nest', (tx) => nest(tx, { parentId: FOLDER, siteId: SITE, sortBy: 'tcontent.credits' })],
  ])('%s rejects the tcontent.credits sort legacy interpolates as a missing column', async (_label, read) => {
    await expect(inA(read)).rejects.toThrow(new ContentQueryError('Sort column "tcontent.tcontent.credits" does not exist'));
  });

  it.each<[string, Parameters<typeof kidsCount>[1], number]>([
    ['across parents, as legacy splits the unparenthesised menu clause', { siteId: SITE, parentId: FOLDER, today: TODAY }, 5],
    ['the fixed window', { siteId: SITE, parentId: FOLDER, today: TODAY, type: 'fixed' }, 3],
    ['the fixed window of a mobile request', { siteId: SITE, parentId: FOLDER, today: TODAY, type: 'fixed', mobile: true }, 2],
    ['the fixed window of a preview', { siteId: SITE, parentId: FOLDER, today: TODAY, type: 'fixed', preview: PREVIEW }, 3],
    ['active children without liveOnly', { siteId: SITE, parentId: FOLDER, today: TODAY, liveOnly: false }, 6],
    ['no children in another site', { siteId: OTHER_SITE, parentId: HOME, today: TODAY, type: 'fixed' }, 0],
  ])('kidsCount counts %s', async (_label, args, expected) => {
    expect(await inA((tx) => kidsCount(tx, args))).toBe(expected);
  });

  it('nest reads the active children of every tree type with haskids, by orderno', async () => {
    const rows = await inA((tx) => nest(tx, { parentId: FOLDER, siteId: SITE }));
    expect(histIds(rows)).toEqual([ALPHA_H, BETA_H, GAMMA_H, FUTURE_H, HIDDEN_H, COMP_H]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([...NEST_COLUMNS].sort());
    expect(rows.map((row) => row.haskids)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(rows[1]).toMatchObject({ filesize: 3, fileext: 'png', contenttype: 'image', assocfilename: 'beta.png', filealttext: 'beta alt', lockid: LOCK, rating: 4 });
    const flat = await inA((tx) => nest(tx, { parentId: FOLDER, siteId: SITE, aggregation: false, sortBy: 'title', sortDirection: 'desc' }));
    expect(histIds(flat)).toEqual([HIDDEN_H, GAMMA_H, FUTURE_H, COMP_H, BETA_H, ALPHA_H]);
    expect(flat[0]).not.toHaveProperty('haskids');
  });

  it.each<[string, Partial<Parameters<typeof nest>[1]>, number, string[], number]>([
    ['a menu title search', { searchString: 'menu' }, 0, [ALPHA_H], 1],
    ['rating descending, NULLs last', { sortBy: 'rating', sortDirection: 'desc' }, 0, [BETA_H, ALPHA_H], 6],
    ['an extended attribute with aggregation, NULLs first', { sortBy: 'Priority' }, 3, [BETA_H, GAMMA_H, ALPHA_H], 6],
    ['an extended attribute descending without aggregation', { sortBy: 'Priority', sortDirection: 'desc', aggregation: false }, 0, [ALPHA_H, GAMMA_H, BETA_H], 6],
  ])('nest narrows or orders by %s', async (_label, args, from, expected, total) => {
    const rows = histIds(await inA((tx) => nest(tx, { parentId: FOLDER, siteId: SITE, ...args })));
    expect(rows).toHaveLength(total);
    expect(rows.slice(from, from + expected.length)).toEqual(expected);
  });

  it('nest sorts credits as an extended attribute of the tree', async () => {
    const rows = await inA((tx) => nest(tx, { parentId: FOLDER, siteId: SITE, sortBy: 'credits' }));
    expect(histIds(rows).sort()).toEqual([ALPHA_H, BETA_H, GAMMA_H, FUTURE_H, HIDDEN_H, COMP_H].sort());
  });

  describe('nest pages in SQL', () => {
    const TIES = cfId(0x200);
    const PAIR = cfId(0x220);
    const SPLIT = cfId(0x230);
    const N = { ONE: cfId(0x201), TWO: cfId(0x202), THREE: cfId(0x203), FOUR: cfId(0x204), FIVE: cfId(0x205), SIX: cfId(0x206), KID: cfId(0x207), FILE: cfId(0x208), DUPE: cfId(0x221), TWIN: cfId(0x231), LONE: cfId(0x232) };
    const QUERY = { parentId: TIES, siteId: TENANT_B.siteId };
    const reader: Actor = { ...actorFromClaims(undefined, 'Tree Reader'), siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId };
    let deps: DomainDeps;
    // Explicit tcontent_ids run against insertion order, so only the tie-breaker orders equal ordernos.
    const tie = (contentid: string, tcontentId: number, orderno: number, menutitle: string, row: Row = {}): Row =>
      page({ contentid, contenthistid: contentid, tcontent_id: tcontentId, parentid: TIES, siteid: TENANT_B.siteId, title: menutitle, menutitle, orderno, ...row });

    beforeAll(async () => {
      await inB(async (tx) => {
        await insert(tx, 'content', [
          tie(N.ONE, 9005, 2, 'Odd one'),
          tie(N.TWO, 9004, 1, 'Even two'),
          tie(N.THREE, 9003, 2, 'Odd three'),
          tie(N.THREE, 9007, 2, 'Odd three before', { contenthistid: cfId(0x213), active: 0 }),
          tie(N.FOUR, 9002, 1, 'Even four'),
          tie(N.FIVE, 9001, 2, 'Odd five'),
          tie(N.SIX, 9006, 3, 'Even six', { fileid: N.FILE }),
          tie(N.KID, 9008, 1, 'Kid', { parentid: N.ONE }),
          // Physical row pairs of one active version, which legacy's GROUP BY collapses.
          tie(N.DUPE, 9010, 1, 'Dupe', { parentid: PAIR }),
          tie(N.DUPE, 9009, 1, 'Dupe', { parentid: PAIR }),
          tie(N.TWIN, 9013, 1, 'Twin', { parentid: SPLIT }),
          tie(N.LONE, 9012, 1, 'Lone', { parentid: SPLIT }),
          tie(N.TWIN, 9011, 1, 'Twin', { parentid: SPLIT }),
        ]);
        await insert(tx, 'file', [{ fileid: N.FILE, contentid: N.SIX, siteid: TENANT_B.siteId, filename: 'six.png', filesize: 6, contenttype: 'image', contentsubtype: 'png', fileext: 'png' }]);
        await insert(tx, 'file_metadata', [
          { metaid: cfId(0x20a), fileid: N.FILE, contenthistid: N.SIX, contentid: N.SIX, siteid: TENANT_B.siteId, alttext: 'b alt' },
          { metaid: cfId(0x20b), fileid: N.FILE, contenthistid: N.SIX, contentid: N.SIX, siteid: TENANT_B.siteId, alttext: 'a alt' },
        ]);
      });
      deps = { db: handle.app, repository: createContentRepository({ clock: fixedClock(TODAY), schema: handle.schema }), clock: fixedClock(TODAY), config: CONTENT_CONFIG_DEFAULTS };
    });

    const TIED = [[N.FOUR, null], [N.TWO, null], [N.FIVE, null], [N.THREE, null], [N.ONE, null], [N.SIX, 'a alt'], [N.SIX, 'b alt']];
    it.each<[string, Partial<Parameters<typeof nest>[1]>, (string | null)[][], number[] | undefined]>([
      ['orderno ties with aggregation', {}, TIED, [0, 0, 0, 0, 1, 0, 0]],
      ['orderno ties without aggregation', { aggregation: false }, TIED, undefined],
      ['a menu title search', { searchString: 'ODD' }, [[N.FIVE, null], [N.THREE, null], [N.ONE, null]], [0, 0, 1]],
    ])('nest pages of %s concatenate to the unbounded read, which nestCount counts', async (_label, args, expected, haskids) => {
      const query = { ...QUERY, ...args };
      const all = await inB((tx) => nest(tx, query));
      expect(all.map((row) => [row.contenthistid, row.filealttext])).toEqual(expected);
      expect(all.map((row) => row.haskids)).toEqual(haskids ?? expected.map(() => undefined));
      expect(await inB((tx) => nestCount(tx, query))).toBe(expected.length);
      for (const size of [1, 2, 3]) {
        const pages: NestRow[] = [];
        for (let offset = 0; offset < all.length; offset += size) pages.push(...(await inB((tx) => nest(tx, { ...query, offset, limit: size }))));
        expect(pages).toEqual(all);
      }
      expect(await inB((tx) => nest(tx, { ...query, offset: all.length, limit: 2 }))).toEqual([]);
    });

    it.each<[string, string, string[], string[]]>([
      ['alone', PAIR, [N.DUPE], [N.DUPE, N.DUPE]],
      ['around a tied sibling, by their least tcontent_id', SPLIT, [N.TWIN, N.LONE], [N.TWIN, N.LONE, N.TWIN]],
    ])('nest groups physical rows sharing every grouped value into one row %s, and reads each without aggregation', async (_label, parentId, grouped, flat) => {
      const query = { parentId, siteId: TENANT_B.siteId };
      const rows = await inB((tx) => nest(tx, query));
      expect(histIds(rows)).toEqual(grouped);
      expect(await inB((tx) => nestCount(tx, query))).toBe(grouped.length);
      expect(await getNest(deps, reader, { ...query, startRow: 1, maxRows: 1 })).toEqual({ rows: rows.slice(0, 1), recordCount: rows.length });
      const unaggregated = { ...query, aggregation: false };
      expect(histIds(await inB((tx) => nest(tx, unaggregated)))).toEqual(flat);
      expect(await inB((tx) => nestCount(tx, unaggregated))).toBe(flat.length);
    });

    it.each<[number | undefined, number | undefined]>([
      [undefined, undefined],
      [3, 2],
      [6, 5],
      [8, 2],
      [1, 0],
      [4, -1],
      [20, undefined],
      [2 ** 60, 2 ** 60],
    ])('getNest reads startRow %s and maxRows %s as a SQL page with the whole count', async (startRow, maxRows) => {
      const all = await inB((tx) => nest(tx, QUERY));
      const from = (startRow ?? 1) - 1;
      const rows = maxRows === undefined || maxRows < 0 ? all.slice(from) : all.slice(from, from + maxRows);
      expect(await getNest(deps, reader, { ...QUERY, startRow, maxRows })).toEqual({ rows, recordCount: TIED.length });
    });

    it.each<[number, number]>([
      [0, 1],
      [1.5, 1],
      [1, 2.5],
    ])('getNest rejects startRow %s and maxRows %s as windowOf does', async (startRow, maxRows) => {
      await expect(getNest(deps, reader, { ...QUERY, startRow, maxRows })).rejects.toThrow(new RangeError('startRow must be a positive integer and maxRows an integer'));
    });
  });

  it('reads live sections, counts and item summaries of a site', async () => {
    expect(await inA((tx) => sections(tx, { siteId: SITE }))).toEqual([
      { contentid: FOLDER, menutitle: '', type: 'Folder', siteid: SITE, path: `${HOME},${FOLDER}` },
      { contentid: EVENTS, menutitle: 'Events', type: 'Calendar', siteid: SITE, path: null },
    ]);
    expect((await inA((tx) => sections(tx, { siteId: SITE, type: 'component' }))).map((row) => row.contentid)).toEqual([COMP]);
    expect(await inA((tx) => pageCount(tx, { siteId: SITE }))).toEqual([{ counter: 12 }]);
    expect(await inA((tx) => pageCount(tx, { siteId: OTHER_SITE }))).toEqual([{ counter: 1 }]);
    expect(await inA((tx) => itemCount(tx, { contentId: BETA, siteId: SITE }))).toEqual([
      { menutitle: 'Beta', title: 'Beta', filename: 'news/beta', lastupdate: new Date(2026, 5, 11, 9, 0, 0), type: 'Page' },
    ]);
    expect(await inA((tx) => itemCount(tx, { contentId: BETA, siteId: OTHER_SITE }))).toEqual([]);
  });

  it.each<[string, string, Date, number]>([
    ['displayed live navigable children', FOLDER, TODAY, 4],
    ['children before their display window', FOLDER, new Date(2026, 4, 1), 3],
    ['a single child', BETA, TODAY, 1],
    ['no children of a leaf', CHILD, TODAY, 0],
  ])('count counts %s', async (_label, contentId, today, expected) => {
    expect(await inA((tx) => count(tx, { siteId: SITE, contentId, today }))).toBe(expected);
  });

  it('keeps tenant B out of tenant A reads', async () => {
    expect(await inB((tx) => readActive(tx, { siteId: SITE, contentId: BETA }))).toEqual([]);
    expect(await inB((tx) => kids(tx, KIDS))).toEqual([]);
    expect(await inB((tx) => crumbPath(tx, { contentId: CHILD, siteId: SITE }))).toEqual([]);
    expect(await inB((tx) => versionParents(tx, { contentHistIds: [BETA_H] }))).toEqual(new Map());
  });

  describe('during a legacy write window', () => {
    const units = [
      UNIT_OF.content,
      UNIT_OF.content_object,
      UNIT_OF.content_related,
      UNIT_OF.content_tag,
      UNIT_OF.content_category_assign,
      UNIT_OF.content_stats,
      UNIT_OF.content_assignment,
      UNIT_OF.extend_attribute,
    ];
    const holderId = `window-${randomUUID()}`;

    beforeAll(async () => {
      await closeGates(handle.app, { units, holderId, phase: 'executing', allowLegacy: true });
    });

    afterAll(async () => {
      await openGates(handle.app, { units, holderId, state: 'legacy' });
    });

    it.each<[string, (tx: TenantTx) => Promise<unknown>]>([
      ['readVersion', (tx) => readVersion(tx, { contentHistId: BETA_H })],
      ['versionParents', (tx) => versionParents(tx, { contentHistIds: [BETA_H] })],
      ['readActive', (tx) => readActive(tx, { siteId: SITE, contentId: BETA })],
      ['histIdFromContentId', (tx) => histIdFromContentId(tx, { contentId: BETA, siteId: SITE })],
      ['contentObjects', (tx) => contentObjects(tx, { contentHistId: BETA_H, siteId: SITE })],
      ['relatedItems', (tx) => relatedItems(tx, { contentHistId: BETA_H, siteId: SITE })],
      ['tags', (tx) => tags(tx, { contentHistId: BETA_H })],
      ['categoryAssignments', (tx) => categoryAssignments(tx, { contentHistId: BETA_H })],
      ['stats', (tx) => stats(tx, { contentId: BETA, siteId: SITE })],
      ['contentAssignments', (tx) => contentAssignments(tx, { contentHistId: BETA_H })],
      ['extendedCastColumn', (tx) => extendedCastColumn(tx, { siteId: SITE, attribute: 'Priority' })],
      ['crumbPath', (tx) => crumbPath(tx, { contentId: CHILD, siteId: SITE })],
      ['kids', (tx) => kids(tx, KIDS)],
      ['nest', (tx) => nest(tx, { parentId: FOLDER, siteId: SITE })],
      ['nestCount', (tx) => nestCount(tx, { parentId: FOLDER, siteId: SITE })],
      ['kidsCount', (tx) => kidsCount(tx, { siteId: SITE, parentId: FOLDER, today: TODAY })],
    ])('%s waits out the executing phase and fails with UnitReadBlockedError', async (_label, read) => {
      await expect(withGatedTenant(handle.app, TENANT_A.tenantId, read, { budgetMs: 200 })).rejects.toBeInstanceOf(UnitReadBlockedError);
    });
  });
});
