/** `repo/content-queries` component, history, draft, approval, search, related-content, usage, tag, object, category, comment and file-join reads over a throwaway `content` schema. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  ContentQueryError,
  SITE_TREE_MODULE_ID,
  approvalsQuery,
  archiveHist,
  categorySummary,
  commentCount,
  componentType,
  components,
  downloadSelect,
  draftHist,
  draftList,
  draftPromptData,
  expireAssignments,
  expiringContent,
  fileJoinColumns,
  hasComments,
  hasRatings,
  hasTagCloud,
  hist,
  lockedContentCount,
  mergeRelatedContent,
  nest,
  objectInheritance,
  objects,
  pageCount,
  pendingChangesets,
  poolFileMatches,
  privateSearch,
  privateSearchFileIds,
  publicSearch,
  readActive,
  readActiveByFilename,
  relatedCandidates,
  relatedContent,
  relatedLinks,
  sections,
  submissionsQuery,
  tagCloud,
  top,
  usage,
  type DraftListPaging,
  type PrivateSearchArgs,
  type PublicSearchArgs,
  type RelatedContentArgs,
} from '../../src/repo/content-queries.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

/** A CF-format id whose first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const at = (stamp: string): Date => new Date(stamp);

const SITE = TENANT_A.siteId;
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const FORMS_MODULE = '00000000000000000000000000000000004';
const TODAY = at('2026-06-15T12:00');
const MISSING = cfId('Z', 9);

const USER = cfId('U', 1);
const OTHER = cfId('U', 2);
const G1 = cfId('G', 1);
const G2 = cfId('G', 2);
const CS1 = cfId('Q', 1);
const RCSET1 = cfId('Q', 2);
const RQ1 = cfId('Q', 3);
const RQ2 = cfId('Q', 4);
const CAT1 = cfId('T', 1);
const CAT2 = cfId('T', 2);
const CAT3 = cfId('T', 3);
const HOME_FILE = cfId('F', 1);
const IMG = cfId('F', 2);
const PDF = cfId('F', 3);
/** A pool image no content references. */
const ORPHAN = cfId('F', 4);

const MODULE = SITE_TREE_MODULE_ID;
const HOME = cfId('C', 1);
const P = cfId('C', 2);
const Q = cfId('C', 3);
const R = cfId('C', 4);
const S = cfId('C', 5);
const T = cfId('C', 6);
const [CMP1, CMP2, CMP3, FORM1, OTHER_FORM] = [1, 2, 3, 4, 5].map((n) => cfId('K', n)) as [string, string, string, string, string];
const [E1, E2, E3, E4] = [1, 2, 3, 4].map((n) => cfId('E', n)) as [string, string, string, string];
const [SA, SB, SC, SD, SE, SF, SH, SM, SX, EV] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => cfId('S', n)) as [
  string, string, string, string, string, string, string, string, string, string,
];
/** The version id of a single-version content id: `V`, the content id's prefix, then its remaining digits. */
const v = (contentId: string): string => `V${contentId.slice(0, 1)}${contentId.slice(2)}`;
const [P_V1, P_V2, P_V3, P_V4] = [1, 2, 3, 4].map((n) => cfId('H', 20 + n)) as [string, string, string, string];
const HOME_OLD = cfId('H', 11);
const Q_DRAFT = cfId('H', 31);
const B_VERSION = cfId('H', 90);
/** Tenant B content of `TENANT_B.siteId`: a page an A version relates to, and a page whose version relates to A's `SB`. */
const [BX, BY] = [1, 2].map((n) => cfId('X', n)) as [string, string];
const POOL = [SITE, TENANT_B.siteId];
/** A tenant B site whose content, assignments, requests and files keep mixed-case legacy spellings. */
const MX = 'mixedcase';
const [MXP, MFILE, MFORM, MFOLDER, MLINK, MCAL, MEVENT, MCOMP, MIMAGE, MDRAFT, MAPPROVE] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => cfId('W', n)) as [
  string, string, string, string, string, string, string, string, string, string, string,
];
const MPNG = cfId('W', 20);

const TOP_COLUMNS = [
  'contenthistid', 'contentid', 'moduleid', 'approved', 'filename', 'active', 'type', 'subtype', 'orderno', 'parentid', 'title',
  'menutitle', 'lastupdate', 'lastupdateby', 'lastupdatebyid', 'display', 'displaystart', 'displaystop', 'isnav', 'restricted',
  'isfeature', 'inheritobjects', 'target', 'targetparams', 'islocked', 'sortby', 'sortdirection', 'releasedate', 'featurestart',
  'featurestop', 'template', 'childtemplate', 'siteid', 'remoteurl', 'fileext', 'assocfilename', 'fileid', 'lockid', 'locktype',
];
const HISTORY_COLUMNS = [
  'menutitle', 'contentid', 'contenthistid', 'fileid', 'type', 'lastupdateby', 'lastupdatebyid', 'active', 'approved', 'lastupdate',
  'display', 'displaystart', 'displaystop', 'moduleid', 'isnav', 'notes', 'isfeature', 'inheritobjects', 'filename', 'targetparams',
  'releasedate',
];
const APPROVAL_JOIN = ['approvalstatus', 'requestid', 'approvalgroupid'];
const DRAFT_COLUMNS = [
  'contenthistid', 'module', 'moduleid', 'siteid', 'parentid', 'type', 'subtype', 'menutitle', 'filename', 'contentid', 'targetparams',
  'lastupdate', 'lastupdateby', 'fileext', 'changesetid', 'majorversion', 'minorversion', 'lockid', 'locktype', 'expires',
];
const PRIVATE_COLUMNS = [
  'contenthistid', 'contentid', 'approved', 'filename', 'active', 'type', 'orderno', 'parentid', 'title', 'menutitle', 'lastupdate',
  'lastupdateby', 'lastupdatebyid', 'display', 'displaystart', 'subtype', 'displaystop', 'isnav', 'restricted', 'isfeature',
  'inheritobjects', 'target', 'targetparams', 'islocked', 'releasedate', 'nextn', 'majorversion', 'minorversion', 'expires', 'haskids',
  'priority', 'filesize', 'fileext', 'fileid', 'assocfilename', 'lockid', 'locktype', 'filealttext', 'supersort',
];
const PUBLIC_COLUMNS = [
  'contentid', 'contenthistid', 'siteid', 'title', 'menutitle', 'targetparams', 'filename', 'summary', 'tags', 'restricted',
  'releasedate', 'type', 'subtype', 'restrictgroups', 'target', 'displaystart', 'displaystop', 'comments', 'credits', 'remotesource',
  'remotesourceurl', 'remoteurl', 'filesize', 'fileext', 'fileid', 'audience', 'keypoints', 'rating', 'totalvotes', 'downvotes',
  'upvotes', 'kids', 'parenttype', 'nextn', 'path', 'orderno', 'lastupdate', 'created', 'sortdate', 'priority', 'majorversion',
  'minorversion', 'lockid', 'locktype', 'expires', 'assocfilename', 'filealttext', 'supersort',
];
const RELATED_COLUMNS = [
  'title', 'releasedate', 'menutitle', 'lastupdate', 'lastupdatebyid', 'summary', 'filename', 'type', 'contentid', 'target',
  'targetparams', 'restricted', 'restrictgroups', 'displaystart', 'displaystop', 'orderno', 'sortby', 'sortdirection', 'fileid',
  'credits', 'remotesource', 'remotesourceurl', 'remoteurl', 'subtype', 'filesize', 'fileext', 'path', 'siteid', 'contenthistid',
  'relatedfromcontentid', 'relatedcontentsetid', 'displayinterval', 'display', 'parenttype',
];
const USAGE_COLUMNS = [
  'menutitle', 'type', 'filename', 'lastupdate', 'contentid', 'siteid', 'approved', 'display', 'displaystart', 'displaystop',
  'moduleid', 'contenthistid', 'parentid',
];

type Row = Record<string, unknown>;

let handle: ThrowawaySchema;

/** Inserts `rows` into `table` in the transaction tenant; each row names its own columns. */
async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const names = Object.keys(row);
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }
}

/** A live, navigable site-tree page of `SITE` under the home page; `fields` override any column. */
const page = (contentid: string, contenthistid: string, title: string, fields: Row = {}): Row => ({
  contentid,
  contenthistid,
  siteid: SITE,
  moduleid: SITE_TREE_MODULE_ID,
  parentid: HOME,
  type: 'Page',
  title,
  menutitle: title,
  active: 1,
  approved: 1,
  display: 1,
  isnav: 1,
  searchexclude: 0,
  ...fields,
});

const draft = { active: 0, approved: 0 };
const component = (contentid: string, title: string, fields: Row): Row =>
  page(contentid, v(contentid), title, { type: 'Component', moduleid: COMPONENTS_MODULE, isnav: 0, body: title, ...fields });

async function seedTenantA(tx: TenantTx): Promise<void> {
  await insert(tx, 'content', [
    page(MODULE, cfId('H', 1), 'Site Manager', { type: 'Module', parentid: null }),
    page(HOME, cfId('H', 10), 'Home', { parentid: '00000000000000000000000000000000END', fileid: HOME_FILE, path: HOME, orderno: 1 }),
    page(HOME, HOME_OLD, 'Home', { active: 0, parentid: '00000000000000000000000000000000END' }),
    component(CMP1, 'beta box', { moduleassign: SITE_TREE_MODULE_ID }),
    component(CMP2, 'Alpha box', { display: 2, moduleassign: `${SITE_TREE_MODULE_ID},${COMPONENTS_MODULE}` }),
    component(CMP3, 'hidden box', { display: 0, moduleassign: SITE_TREE_MODULE_ID }),
    component(FORM1, 'Contact', { type: 'Form', moduleid: FORMS_MODULE, moduleassign: SITE_TREE_MODULE_ID, responsechart: 1 }),
    ...[
      [P_V1, { active: 0, lastupdate: at('2026-01-01T09:00'), majorversion: 1 }],
      [P_V2, { lastupdate: at('2026-02-01T09:00'), majorversion: 2 }],
      [P_V3, { ...draft, lastupdate: at('2026-03-01T09:00'), lastupdatebyid: USER, menutitle: 'Draft P edited' }],
      [P_V4, { ...draft, lastupdate: at('2026-04-01T09:00'), changesetid: CS1 }],
    ].map(([id, fields]) => page(P, id as string, 'Draft P', { path: `${HOME},${P}`, lastupdateby: 'Other', lastupdatebyid: OTHER, ...(fields as Row) })),
    page(Q, v(Q), 'Draft Q', { lastupdate: at('2026-01-10T09:00') }),
    page(Q, Q_DRAFT, 'Draft Q edited', { ...draft, lastupdate: at('2026-03-10T09:00'), lastupdatebyid: OTHER }),
    page(R, v(R), 'Draft R', { approved: 0, lastupdate: at('2026-03-20T09:00'), lastupdatebyid: USER, orderno: 40 }),
    page(S, v(S), 'Draft S', { approved: 0, lastupdate: at('2026-03-25T09:00'), lastupdatebyid: OTHER }),
    page(T, v(T), 'Draft T', { approved: 0, lastupdate: at('2026-03-15T09:00'), lastupdatebyid: USER }),
    page(E1, v(E1), 'Expiring 1', { lastupdatebyid: USER, expires: at('2026-07-01T00:00') }),
    page(E2, v(E2), 'Expiring 2', { lastupdatebyid: OTHER, expires: at('2025-08-01T00:00') }),
    page(E3, v(E3), 'Expiring 3', { lastupdatebyid: USER, expires: at('2027-01-01T00:00') }),
    page(E4, v(E4), 'Expiring 4', { lastupdatebyid: USER, expires: at('2025-06-01T00:00') }),
    page(SA, v(SA), 'Orchid', { isnav: 0, orderno: 30, path: `${HOME},${SA}`, created: at('2026-02-01T00:00'), body: 'Plain body' }),
    page(SB, v(SB), 'Orchid Care', {
      parentid: SA,
      path: `${HOME},${SA},${SB}`,
      orderno: 10,
      releasedate: at('2026-05-01T00:00'),
      created: at('2026-01-15T00:00'),
    }),
    page(SC, v(SC), 'Garden', { orderno: 20, path: `${HOME},${SC}`, created: at('2026-04-01T00:00'), body: 'An orchid grows here' }),
    page(SD, v(SD), 'Links', { type: 'Link', created: at('2026-04-15T00:00'), body: 'orchid link' }),
    page(SE, v(SE), 'Plants', { created: at('2026-03-01T00:00'), body: `[mura]${CMP1}[/mura]` }),
    page(SF, v(SF), 'Photo', { type: 'File', fileid: IMG, created: at('2026-03-05T00:00') }),
    page(SH, v(SH), 'Brochure', { type: 'File', fileid: PDF, created: at('2026-03-06T00:00') }),
    page(SM, v(SM), 'Orchid Mobile', { mobileexclude: 2, created: at('2026-02-10T00:00') }),
    page(SX, v(SX), 'Orchid Secret', { searchexclude: 1, created: at('2026-02-11T00:00') }),
    page(EV, v(EV), 'Event', { display: 2, displaystart: at('2026-06-20T00:00'), displaystop: at('2026-06-21T00:00') }),
  ]);
  await insert(tx, 'file', [
    { fileid: HOME_FILE, siteid: SITE, filename: 'home.jpg', fileext: 'jpg', filesize: 10, contenttype: 'image', contentsubtype: 'jpeg', caption: 'Home' },
    { fileid: IMG, siteid: SITE, filename: 'photo.png', fileext: 'png', filesize: 20, contenttype: 'image', contentsubtype: 'png', caption: 'Orchid photo' },
    { fileid: PDF, siteid: SITE, filename: 'brochure.pdf', fileext: 'pdf', filesize: 30, contenttype: 'application', contentsubtype: 'pdf', credits: 'Orchid Society' },
    { fileid: ORPHAN, siteid: SITE, filename: 'orphan.png', fileext: 'png', filesize: 40, contenttype: 'image', contentsubtype: 'png', caption: 'orchid' },
  ]);
  await insert(tx, 'file_metadata', [{ metaid: cfId('M', 1), fileid: IMG, contenthistid: v(SF), contentid: SF, siteid: SITE, alttext: 'Meta alt' }]);
  await insert(tx, 'extend_data', [{ baseid: v(SE), attributeid: 1, siteid: SITE, attributevalue: 'Orchid lover' }]);
  await insert(tx, 'content_stats', [
    { contentid: HOME, siteid: SITE, lockid: OTHER, locktype: 'node' },
    { contentid: P, siteid: SITE, lockid: USER, locktype: 'node', majorversion: 2, minorversion: 0 },
    { contentid: Q, siteid: SITE, lockid: USER, locktype: 'draft' },
  ]);
  await insert(tx, 'content_assignment', [
    { contentid: Q, contenthistid: Q_DRAFT, siteid: SITE, userid: USER, type: 'draft' },
    { contentid: S, contenthistid: v(S), siteid: SITE, userid: USER, type: 'draft' },
    { contentid: E2, contenthistid: v(E2), siteid: SITE, userid: USER, type: 'expire' },
  ]);
  await insert(tx, 'approval_request', [
    { requestid: RQ1, siteid: SITE, userid: OTHER, groupid: G2, status: 'Pending', contenthistid: P_V4 },
    { requestid: RQ2, siteid: SITE, userid: USER, groupid: G1, status: 'Pending', contenthistid: v(T) },
  ]);
  await insert(tx, 'changeset', [{ changesetid: CS1, siteid: SITE, name: 'Spring', published: 0, publishdate: at('2026-05-01T00:00') }]);
  await insert(
    tx,
    'content_tag',
    [
      [SA, 'Bees', null],
      [SB, 'Flowers', null],
      [SC, 'Trees', 'Garden'],
      [SC, 'Asters', null],
      [SE, 'flowers ', null],
    ].map(([id, tag, taggroup]) => ({ contenthistid: v(id as string), contentid: id, siteid: SITE, tag, taggroup })),
  );
  await insert(
    tx,
    'content_category_assign',
    [
      [v(SA), CAT2, SA],
      [v(SB), CAT1, SB],
      [v(SC), CAT1, SC],
      [v(SC), CAT2, SC],
      [v(SE), CAT1, SE],
      [P_V2, CAT3, P],
      [v(EV), CAT2, EV],
    ].map(([contenthistid, categoryid, contentid]) => ({ contenthistid, categoryid, contentid, siteid: SITE })),
  );
  await insert(
    tx,
    'content_related',
    [
      [SA, null, 1],
      [SB, RCSET1, 3],
      [SC, RCSET1, 2],
      [R, null, 4],
      [BX, RCSET1, 1],
    ].map(([relatedid, relatedcontentsetid, orderno]) => ({ contenthistid: P_V2, relatedid, contentid: P, siteid: SITE, relatedcontentsetid, orderno })),
  );
  await insert(tx, 'extend_rc_set', [{ relatedcontentsetid: RCSET1, siteid: SITE, name: 'Featured' }]);
  await insert(tx, 'content_object', [
    { contenthistid: P_V2, contentid: P, siteid: SITE, columnid: 2, orderno: 1, object: 'comments', objectid: 'none', name: 'Comments' },
    { contenthistid: P_V2, contentid: P, siteid: SITE, columnid: 2, orderno: 2, object: 'component', objectid: CMP1, name: 'beta box', params: '{"x":1}' },
    { contenthistid: P_V2, contentid: P, siteid: SITE, columnid: 2, orderno: 3, object: 'goToFirstChild', objectid: 'none' },
    { contenthistid: P_V2, contentid: P, siteid: SITE, columnid: 1, orderno: 1, object: 'Rater', objectid: 'none' },
    { contenthistid: P_V2, contentid: P, siteid: SITE, columnid: 1, orderno: 2, object: 'tag_cloud', objectid: 'none' },
    { contenthistid: v(SE), contentid: SE, siteid: SITE, columnid: 2, orderno: 1, object: 'comments', objectid: 'none' },
  ]);
  await insert(
    tx,
    'comment',
    [
      [1, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [1, 0, 1],
      [0, 0, 0],
    ].map(([isapproved, isspam, isdeleted], i) => ({ commentid: cfId('M', 10 + i), contentid: P, siteid: SITE, isapproved, isspam, isdeleted })),
  );
  await insert(tx, 'form_response_packet', [
    { responseid: cfId('R', 1), formid: FORM1, siteid: SITE, entered: at('2026-05-02T08:00') },
    { responseid: cfId('R', 2), formid: FORM1, siteid: SITE, entered: at('2026-05-01T08:00') },
    { responseid: cfId('R', 3), formid: FORM1, siteid: SITE, entered: at('2026-05-03T08:00') },
    { responseid: cfId('R', 4), formid: OTHER_FORM, siteid: SITE, entered: at('2026-04-01T08:00') },
  ]);
}

/** Site `MX` in tenant B: children of `MXP` stored with lower-case types, a future event under a lower-case calendar, and mixed-case assignment, request and extension values. */
async function seedMixedCase(tx: TenantTx): Promise<void> {
  const mx = (contentid: string, title: string, fields: Row = {}): Row => page(contentid, v(contentid), title, { siteid: MX, ...fields });
  await insert(tx, 'content', [
    mx(MODULE, 'Site Manager', { type: 'Module', parentid: null }),
    mx(MXP, 'Mixed parent'),
    mx(MFILE, 'Willow brochure', { type: 'file', parentid: MXP, orderno: 1, filename: 'willow.pdf', expires: at('2026-07-01T00:00') }),
    mx(MFORM, 'Willow form', { type: 'form', parentid: MXP, orderno: 2, moduleid: FORMS_MODULE }),
    mx(MFOLDER, 'Willow folder', { type: 'folder', parentid: MXP, orderno: 3 }),
    mx(MLINK, 'Link', { type: 'link', parentid: MXP, orderno: 4, body: 'willow' }),
    mx(MCAL, 'Calendar', { type: 'calendar', parentid: MXP, orderno: 5 }),
    mx(MIMAGE, 'Picture', { type: 'FILE', parentid: MXP, orderno: 6, fileid: MPNG }),
    mx(MEVENT, 'Willow event', { parentid: MCAL, display: 2, displaystart: at('2026-07-01T00:00') }),
    mx(MCOMP, 'Willow box', { type: 'component', moduleid: COMPONENTS_MODULE, isnav: 0, moduleassign: SITE_TREE_MODULE_ID }),
    mx(MDRAFT, 'Draft item', { approved: 0, lastupdate: at('2026-03-01T09:00') }),
    mx(MAPPROVE, 'Approval item', { approved: 0, lastupdate: at('2026-03-02T09:00') }),
  ]);
  await insert(tx, 'file', [{ fileid: MPNG, siteid: MX, filename: 'willow.PNG', fileext: 'PNG', caption: 'Willow picture' }]);
  await insert(tx, 'content_assignment', [
    { contentid: MFILE, contenthistid: v(MFILE), siteid: MX, userid: USER, type: 'EXPIRE' },
    { contentid: MDRAFT, contenthistid: v(MDRAFT), siteid: MX, userid: USER, type: 'Draft' },
  ]);
  await insert(tx, 'approval_request', [{ requestid: cfId('W', 30), siteid: MX, userid: OTHER, groupid: G1, status: 'pending', contenthistid: v(MAPPROVE) }]);
  await insert(tx, 'content_related', [{ contenthistid: v(MXP), relatedid: MEVENT, contentid: MXP, siteid: MX, orderno: 1 }]);
  await insert(tx, 'content_tag', [{ contenthistid: v(MEVENT), contentid: MEVENT, siteid: MX, tag: 'Willow' }]);
}

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_B.tenantId, fn);
const ids = (rows: readonly Row[], column = 'contentid'): unknown[] => rows.map((row) => row[column]);

describe.skipIf(!(await pgAvailable()))('repo/content-queries history, drafts, search and related reads', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await inA(seedTenantA);
    await inB(async (tx) => {
      await insert(tx, 'content', [
        page(P, B_VERSION, 'Tenant B page', { lastupdate: at('2026-05-01T09:00') }),
        page(BX, v(BX), 'hedge', { siteid: TENANT_B.siteId, orderno: 15, created: at('2026-03-01T00:00') }),
        page(BY, v(BY), 'apiary', { siteid: TENANT_B.siteId }),
      ]);
      await insert(tx, 'content_related', [{ contenthistid: v(BY), relatedid: SB, contentid: BY, siteid: TENANT_B.siteId, orderno: 1 }]);
      await seedMixedCase(tx);
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it.each([
    ['the site tree', SITE_TREE_MODULE_ID, [CMP2, CMP1]],
    ['the component module', COMPONENTS_MODULE, [CMP2]],
  ])('components lists the live components assigned to %s by case-insensitive title', async (_label, moduleId, expected) => {
    const rows = await inA((tx) => components(tx, { moduleId, siteId: SITE }));
    expect(ids(rows)).toEqual(expected);
    expect(Object.keys(rows[0] ?? {})).toEqual(['contentid', 'menutitle', 'body', 'title', 'filename']);
  });

  it.each([
    ['components', { type: 'component' }, [CMP2, CMP1]],
    ['components assigned to a module', { type: 'COMPONENT', moduleId: COMPONENTS_MODULE }, [CMP2]],
    ['forms, an empty module id narrowing nothing', { type: 'Form', moduleId: '' }, [FORM1]],
  ])('componentType lists live %s', async (_label, args, expected) => {
    const rows = await inA((tx) => componentType(tx, { siteId: SITE, ...args }));
    expect(ids(rows)).toEqual(expected);
    expect(Object.keys(rows[0] ?? {})).toEqual(['contentid', 'menutitle', 'responsechart']);
  });

  it('top reads the active root version with its file and lock columns', async () => {
    const rows = await inA((tx) => top(tx, { topId: HOME.toLowerCase(), siteId: SITE }));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).toEqual(TOP_COLUMNS);
    expect(rows[0]).toMatchObject({ contenthistid: cfId('H', 10), fileext: 'jpg', assocfilename: 'home.jpg', fileid: HOME_FILE, lockid: OTHER, locktype: 'node' });
  });

  it.each([
    ['a form', FORM1.toLowerCase(), { firstentered: at('2026-05-01T08:00'), lastentered: at('2026-05-03T08:00'), countentered: 3 }],
    ['a form without submissions', MISSING, { firstentered: null, lastentered: null, countentered: 0 }],
  ])('downloadSelect summarises the submissions of %s', async (_label, contentId, expected) => {
    expect(await inA((tx) => downloadSelect(tx, { contentId, siteId: SITE }))).toEqual([expected]);
  });

  it('hist lists every version newest first with its change set and approval request', async () => {
    const rows = await inA((tx) => hist(tx, { contentId: P.toLowerCase(), siteId: SITE }));
    expect(ids(rows, 'contenthistid')).toEqual([P_V4, P_V3, P_V2, P_V1]);
    expect(Object.keys(rows[0] ?? {})).toEqual([
      ...HISTORY_COLUMNS,
      'siteid', 'featurestart', 'featurestop', 'changesetid', 'changesetname', 'changsetpublished', 'changesetpublishdate',
      'majorversion', 'minorversion', ...APPROVAL_JOIN,
    ]);
    expect(rows[0]).toMatchObject({
      changesetid: CS1,
      changesetname: 'Spring',
      changsetpublished: 0,
      changesetpublishdate: at('2026-05-01T00:00'),
      approvalstatus: 'Pending',
      requestid: RQ1,
      approvalgroupid: G2,
    });
    expect(rows[3]).toMatchObject({ changesetname: null, approvalstatus: null, requestid: null, majorversion: 1 });
  });

  it.each<[string, (tx: TenantTx, args: { contentId: string; siteId: string }) => Promise<Row[]>, string[], string[]]>([
    ['draftHist the unapproved versions outside change sets', draftHist, [P_V3], [...HISTORY_COLUMNS, 'path', ...APPROVAL_JOIN]],
    [
      'pendingChangesets the unapproved versions in change sets',
      pendingChangesets,
      [P_V4],
      [...HISTORY_COLUMNS, 'path', 'changesetpublishdate', 'changesetname', 'changesetid', ...APPROVAL_JOIN],
    ],
    ['archiveHist the approved inactive versions', archiveHist, [P_V1], [...HISTORY_COLUMNS, 'path', ...APPROVAL_JOIN]],
  ])('%s', async (_label, read, expected, columns) => {
    const rows = await inA((tx) => read(tx, { contentId: P, siteId: SITE }));
    expect(ids(rows, 'contenthistid')).toEqual(expected);
    expect(Object.keys(rows[0] ?? {})).toEqual(columns);
  });

  it('reads only the transaction tenant’s rows, even for the same site and content id', async () => {
    expect(ids(await inA((tx) => hist(tx, { contentId: P, siteId: SITE })), 'contenthistid')).not.toContain(B_VERSION);
    expect(ids(await inB((tx) => hist(tx, { contentId: P, siteId: SITE })), 'contenthistid')).toEqual([B_VERSION]);
  });

  it('draftList lists assigned and own drafts outside change sets and requests, newest first, newer drafts with active columns', async () => {
    const rows = await inA((tx) => draftList(tx, { siteId: SITE, userId: USER.toLowerCase() }));
    expect(ids(rows, 'contenthistid')).toEqual([v(S), v(R), Q_DRAFT, P_V3]);
    expect(Object.keys(rows[0] ?? {})).toEqual(DRAFT_COLUMNS);
    expect(rows[2]).toMatchObject({ module: 'Site Manager', menutitle: 'Draft Q', lockid: USER, locktype: 'draft' });
    expect(rows[3]).toMatchObject({ menutitle: 'Draft P', lockid: USER, locktype: 'node', lastupdate: at('2026-03-01T09:00') });
  });

  it.each<[string, DraftListPaging, string[]]>([
    ['a limit', { limit: 2.9 }, [v(S), v(R)]],
    ['a day window from midnight to 23:59', { startDate: at('2026-03-10T15:00'), stopDate: at('2026-03-20T00:00') }, [v(R), Q_DRAFT]],
    ['a menu title sort', { sortBy: 'menuTitle', sortDirection: 'asc' }, [P_V3, Q_DRAFT, v(R), v(S)]],
    ['a sort list, its direction on the last field', { sortBy: 'type,lastUpdate', sortDirection: 'ASC' }, [P_V3, Q_DRAFT, v(R), v(S)]],
    ['an unknown direction as desc', { sortDirection: 'sideways' }, [v(S), v(R), Q_DRAFT, P_V3]],
  ])('draftList applies %s', async (_label, paging, expected) => {
    expect(ids(await inA((tx) => draftList(tx, { siteId: SITE, userId: USER, ...paging })), 'contenthistid')).toEqual(expected);
  });

  it('draftList rejects a sort field outside its result columns', async () => {
    await expect(inA((tx) => draftList(tx, { siteId: SITE, userId: USER, sortBy: 'lastUpdate,body' }))).rejects.toThrow(
      new ContentQueryError("Invalid sort by field: 'body'"),
    );
  });

  it.each<[string, DraftListPaging & { groupIds: readonly string[] | null }, string[]]>([
    ['every group for a null group list', { groupIds: null }, [P_V4, v(T)]],
    ['the listed groups', { groupIds: [G1.toLowerCase()] }, [v(T)]],
    ['no group', { groupIds: [] }, []],
    ['a day window on the active version', { groupIds: null, startDate: at('2026-01-15T00:00'), stopDate: at('2026-02-15T00:00') }, [P_V4]],
    ['a limit', { groupIds: null, limit: 1 }, [P_V4]],
    ['a sort with a padded direction', { groupIds: null, sortBy: 'lastupdate', sortDirection: ' asc ' }, [v(T), P_V4]],
  ])('approvalsQuery lists the pending requests of %s', async (_label, args, expected) => {
    expect(ids(await inA((tx) => approvalsQuery(tx, { siteId: SITE, ...args })), 'contenthistid')).toEqual(expected);
  });

  it('approvalsQuery returns the draft columns with the request status, display start and change set publish date', async () => {
    const rows = await inA((tx) => approvalsQuery(tx, { siteId: SITE, groupIds: null }));
    expect(Object.keys(rows[0] ?? {})).toEqual([...DRAFT_COLUMNS, 'approvalstatus', 'displaystart', 'publishdate']);
    expect(rows[0]).toMatchObject({ module: 'Site Manager', changesetid: CS1, approvalstatus: 'Pending', publishdate: at('2026-05-01T00:00'), lockid: USER });
    expect(rows[1]).toMatchObject({ menutitle: 'Draft T', approvalstatus: 'Pending', publishdate: null, lockid: null });
  });

  it.each([
    ['direction', { sortDirection: 'sideways' }, "Invalid sort direction 'sideways'. Only 'asc' or 'desc' allowed to prevent SQL injection."],
    ['field', { sortBy: 'title' }, "Invalid sort by field: 'title'"],
  ])('approvalsQuery rejects an invalid sort %s', async (_label, sort, message) => {
    await expect(inA((tx) => approvalsQuery(tx, { siteId: SITE, groupIds: null, ...sort }))).rejects.toThrow(new ContentQueryError(message));
  });

  it.each([
    [USER.toLowerCase(), [v(T)]],
    [OTHER, [P_V4]],
  ])('submissionsQuery lists the pending requests user %s submitted', async (userId, expected) => {
    expect(ids(await inA((tx) => submissionsQuery(tx, { siteId: SITE, userId })), 'contenthistid')).toEqual(expected);
  });

  it('expiringContent lists own and notified content expiring within a month or expired within a year', async () => {
    expect(await inA((tx) => expiringContent(tx, { siteId: SITE, userId: USER.toLowerCase(), today: TODAY }))).toEqual([
      { contentid: E1 },
      { contentid: E2 },
    ]);
  });

  it.each([
    [USER.toLowerCase(), 2],
    [OTHER, 1],
    [MISSING, 0],
  ])('lockedContentCount counts the locks of %s', async (userId, expected) => {
    expect(await inA((tx) => lockedContentCount(tx, { siteId: SITE, userId }))).toBe(expected);
  });

  it('draftPromptData reads the active version, drafts, pending change-set versions and stats', async () => {
    const data = await inA((tx) => draftPromptData(tx, { contentId: P, siteId: SITE }));
    expect(data.active?.contenthistid).toBe(P_V2);
    expect(ids(data.draftHist, 'contenthistid')).toEqual([P_V3]);
    expect(data.pendingChangesets).toEqual([
      {
        changesetid: CS1,
        contentid: P,
        contenthistid: P_V4,
        siteid: SITE,
        menutitle: 'Draft P',
        changesetname: 'Spring',
        approvalstatus: 'Pending',
        requestid: RQ1,
        lastupdate: at('2026-04-01T09:00'),
        lastupdateby: 'Other',
        approvalgroupid: G2,
        publishdate: at('2026-05-01T00:00'),
        closedate: null,
      },
    ]);
    expect(data.stats).toMatchObject({ contentid: P, lockid: USER, majorversion: 2 });
    expect(await inA((tx) => draftPromptData(tx, { contentId: MISSING, siteId: SITE }))).toEqual({
      active: null,
      draftHist: [],
      pendingChangesets: [],
      stats: null,
    });
  });

  it('privateSearch puts exact title matches first, then title, body and attribute matches by title', async () => {
    const rows = await inA((tx) => privateSearch(tx, { siteId: SITE, keywords: 'orchid' }));
    expect(ids(rows)).toEqual([SA, SC, SB, SM, SX, SE]);
    expect(Object.keys(rows[0] ?? {})).toEqual(PRIVATE_COLUMNS);
    expect(rows[0]).toMatchObject({ haskids: 1, priority: 1, supersort: 0 });
    expect(rows[1]).toMatchObject({ haskids: 0, priority: 2, supersort: 1 });
  });

  it.each<[string, Omit<PrivateSearchArgs, 'siteId'>, string[]]>([
    ['a trimmed, case-insensitive tag', { keywords: '', tag: ' FLOWERS' }, [SB, SE]],
    ['a section', { keywords: 'orchid', sectionId: SA }, [SA, SB]],
    ['the site-tree module', { keywords: 'orchid', moduleId: SITE_TREE_MODULE_ID }, [SA, SC, SB, SM, SX, SE]],
    ['another module', { keywords: 'orchid', moduleId: COMPONENTS_MODULE }, []],
    ['neither keywords nor a tag', { keywords: '  ' }, []],
    ['images by file caption', { keywords: 'orchid', searchType: 'Image' }, [SF]],
    ['files by caption or credits, exact titles first', { keywords: 'orchid', searchType: 'file' }, [SA, SH, SF]],
    ['files outside the file-pool sites', { keywords: 'orchid', searchType: 'file', filePoolSiteIds: ['other'] }, []],
  ])('privateSearch matches %s', async (_label, args, expected) => {
    expect(ids(await inA((tx) => privateSearch(tx, { siteId: SITE, ...args })))).toEqual(expected);
  });

  it('privateSearch joins the file and version metadata columns of an image search', async () => {
    const [row] = await inA((tx) => privateSearch(tx, { siteId: SITE, keywords: 'orchid', searchType: 'image' }));
    expect(row).toMatchObject({ fileid: IMG, fileext: 'png', filesize: 20, assocfilename: 'photo.png', filealttext: 'Meta alt' });
  });

  it.each<[string, Omit<PrivateSearchArgs, 'siteId'>, string[]]>([
    ['an image search, images or not', { keywords: 'orchid', searchType: 'IMAGE' }, [HOME_FILE, IMG, PDF]],
    ['a file search by tag', { keywords: '', tag: 'flowers', searchType: 'file' }, [HOME_FILE, IMG, PDF]],
    ['a section', { keywords: 'orchid', searchType: 'file', sectionId: HOME.toLowerCase() }, [HOME_FILE]],
    ['another module', { keywords: 'orchid', searchType: 'file', moduleId: COMPONENTS_MODULE }, []],
    ['a default search', { keywords: 'orchid' }, []],
    ['neither keywords nor a tag', { keywords: '  ', searchType: 'image' }, []],
  ])('privateSearchFileIds reads the files of active versions in scope for %s', async (_label, args, expected) => {
    expect(await inA((tx) => privateSearchFileIds(tx, { siteId: SITE, ...args }))).toEqual(expected);
  });

  it.each([
    ['image', 'orchid', { fileIds: [HOME_FILE, IMG], keywordFileIds: [IMG] }],
    ['FILE', ' ORCHID ', { fileIds: [HOME_FILE, IMG, PDF], keywordFileIds: [IMG, PDF] }],
    ['image', '', { fileIds: [HOME_FILE, IMG], keywordFileIds: [] }],
    ['default', 'orchid', { fileIds: [], keywordFileIds: [] }],
  ])('poolFileMatches answers a %s search for %j over the referenced files only', async (searchType, keywords, expected) => {
    const fileIds = await inA((tx) => privateSearchFileIds(tx, { siteId: SITE, keywords: 'orchid', searchType: 'file' }));
    expect(fileIds).not.toContain(ORPHAN);
    expect(await inA((tx) => poolFileMatches(tx, { keywords, searchType, fileIds }))).toEqual(expected);
  });

  it.each<[string, readonly string[], number, { fileIds: string[]; keywordFileIds: string[] }]>([
    ['no listed file without a query', [], 1000, { fileIds: [], keywordFileIds: [] }],
    ['a listed file by any case', [ORPHAN.toLowerCase()], 1000, { fileIds: [ORPHAN], keywordFileIds: [ORPHAN] }],
    ['one id per batch, repeated ids once, in file id order', [PDF, IMG.toLowerCase(), HOME_FILE, PDF.toLowerCase(), MISSING], 1, { fileIds: [HOME_FILE, IMG, PDF], keywordFileIds: [IMG, PDF] }],
  ])('poolFileMatches reads %s', async (_label, fileIds, batchSize, expected) => {
    expect(await inA((tx) => poolFileMatches(tx, { keywords: 'orchid', searchType: 'file', fileIds }, batchSize))).toEqual(expected);
  });

  it('poolFileMatches rejects a batch size that is not a positive integer', async () => {
    await expect(inA((tx) => poolFileMatches(tx, { keywords: 'orchid', searchType: 'file', fileIds: [IMG] }, 0))).rejects.toThrow(RangeError);
  });

  it('privateSearch over a pooled file tenant matches by pool file ids and returns the file id for fileJoinColumns', async () => {
    const fileIds = await inA((tx) => privateSearchFileIds(tx, { siteId: SITE, keywords: 'orchid', searchType: 'image' }));
    const pooledFiles = await inA((tx) => poolFileMatches(tx, { keywords: 'orchid', searchType: 'image', fileIds }));
    expect(pooledFiles.fileIds).not.toContain(ORPHAN);
    const rows = await inA((tx) => privateSearch(tx, { siteId: SITE, keywords: 'orchid', searchType: 'image', pooledFiles }));
    expect(ids(rows)).toEqual([SF]);
    expect(Object.keys(rows[0] ?? {})).toEqual(PRIVATE_COLUMNS);
    expect(rows[0]).toMatchObject({ fileid: IMG, filesize: null, fileext: null, assocfilename: null, filealttext: 'Meta alt' });
    expect(ids(await inA((tx) => privateSearch(tx, { siteId: SITE, keywords: 'orchid', searchType: 'file', pooledFiles })))).toEqual([SA, SF]);
    expect((await inA((tx) => privateSearch(tx, { siteId: SITE, keywords: 'orchid', searchType: 'file', pooledFiles })))[0]?.fileid).toBeNull();
  });

  it.each<[string, readonly string[], Row[]]>([
    ['no ids without a query', [], []],
    [
      'listed ids by file id',
      [PDF, IMG.toLowerCase()],
      [
        { fileid: IMG, fileext: 'png', filesize: 20, assocfilename: 'photo.png', contenttype: 'image', contentsubtype: 'png' },
        { fileid: PDF, fileext: 'pdf', filesize: 30, assocfilename: 'brochure.pdf', contenttype: 'application', contentsubtype: 'pdf' },
      ],
    ],
  ])('fileJoinColumns reads %s', async (_label, fileIds, expected) => {
    expect(await inA((tx) => fileJoinColumns(tx, fileIds))).toEqual(expected);
  });

  it('publicSearch lists live searchable pages, exact titles first, then newest release or creation date', async () => {
    const rows = await inA((tx) => publicSearch(tx, { siteId: SITE, keywords: 'orchid', today: TODAY }));
    expect(ids(rows)).toEqual([SA, SB, SC, SE]);
    expect(Object.keys(rows[0] ?? {})).toEqual(PUBLIC_COLUMNS);
    expect(rows[0]).toMatchObject({ supersort: 0, sortdate: at('2026-02-01T00:00'), parenttype: 'Page', comments: 0, kids: 0, priority: 0 });
    expect(rows[1]).toMatchObject({ supersort: 1, sortdate: at('2026-05-01T00:00'), parenttype: 'Page' });
  });

  it.each<[string, Omit<PublicSearchArgs, 'siteId' | 'today'>, string[]]>([
    ['mobile-only pages for a mobile request', { keywords: 'orchid', mobile: true }, [SA, SB, SC, SE, SM]],
    ['a tag list, case-insensitively', { keywords: '', tag: 'flowers,TREES' }, [SB, SC, SE]],
    ['tags of a tag group', { keywords: '', tag: 'flowers,trees', tagGroup: 'garden' }, [SC]],
    ['tags of the default group', { keywords: '', tag: 'flowers', tagGroup: 'Default' }, [SB, SE]],
    ['categories', { keywords: 'orchid', categoryIds: [CAT2.toLowerCase()] }, [SA, SC]],
    ['no category', { keywords: 'orchid', categoryIds: [] }, []],
    ['a section', { keywords: 'orchid', sectionId: SA }, [SA, SB]],
  ])('publicSearch matches %s', async (_label, args, expected) => {
    expect(ids(await inA((tx) => publicSearch(tx, { siteId: SITE, today: TODAY, ...args })))).toEqual(expected);
  });

  it('relatedContent reads the live related content with the legacy columns', async () => {
    const rows = await inA((tx) => relatedContent(tx, { siteId: SITE, contentHistId: `${P_V2.toLowerCase()},${MISSING}`, today: TODAY }));
    expect(ids(rows)).toEqual([SB, SC, SA]);
    expect(Object.keys(rows[0] ?? {})).toEqual(RELATED_COLUMNS);
    expect(rows[0]).toMatchObject({ relatedfromcontentid: P, relatedcontentsetid: RCSET1, parenttype: '', orderno: 10, filesize: null });
  });

  it.each<[string, Partial<RelatedContentArgs>, string[]]>([
    ['every active link when liveOnly is false', { liveOnly: false }, [SB, SC, SA, R]],
    ['a previewed version', { preview: { contentIds: [R], contentHistIds: [v(R)] } }, [SB, SC, SA, R]],
    ['a related-content set by link order', { relatedContentSetId: RCSET1 }, [SC, SB]],
    ['set 0 as the default set', { relatedContentSetId: '0' }, [SA]],
    ['a set name', { name: 'FEATURED' }, [SC, SB]],
    ['the Default set name with unnamed links', { name: 'Default' }, [SA]],
    ['navigation items', { navOnly: true }, [SB, SC]],
    ['a menu title sort', { sortBy: 'MenuTitle', sortDirection: 'DESC' }, [SB, SA, SC]],
    ['an unknown sort as content order', { sortBy: 'views' }, [SB, SC, SA]],
    ['another content pool', { contentPoolSiteIds: ['other'] }, []],
    ['the versions relating to content, by menu title', { reverse: true, reverseContentId: SB, sortDirection: 'desc' }, [P]],
  ])('relatedContent reads %s', async (_label, args, expected) => {
    expect(ids(await inA((tx) => relatedContent(tx, { siteId: SITE, contentHistId: P_V2, today: TODAY, ...args })))).toEqual(expected);
  });

  it('relatedContent rejects a rating sort, whose table legacy never joins', async () => {
    await expect(inA((tx) => relatedContent(tx, { siteId: SITE, contentHistId: P_V2, today: TODAY, sortBy: 'rating' }))).rejects.toThrow(
      new ContentQueryError('Sort by rating references tcontentstats, which getRelatedContent does not join'),
    );
  });

  it('relatedContent in one tenant transaction cannot join a link to content kept in another pool tenant', async () => {
    const args = { siteId: SITE, contentHistId: P_V2, today: TODAY, contentPoolSiteIds: POOL };
    expect(ids(await inA((tx) => relatedContent(tx, args)))).toEqual([SB, SC, SA]);
    expect(await inB((tx) => relatedContent(tx, args))).toEqual([]);
  });

  it.each<[string, Partial<RelatedContentArgs>, string[]]>([
    ['every link in insertion order', {}, [SA, SB, SC, R, BX]],
    ['a related-content set', { relatedContentSetId: RCSET1.toLowerCase() }, [SB, SC, BX]],
    ['set 0 as the default set', { relatedContentSetId: '0' }, [SA, R]],
    ['the Default set name with unnamed links', { name: 'default' }, [SA, R]],
    ['no version', { contentHistId: MISSING }, []],
  ])('relatedLinks reads %s', async (_label, args, expected) => {
    const links = await inA((tx) => relatedLinks(tx, { contentHistId: P_V2, ...args }));
    expect(ids(links, 'relatedid')).toEqual(expected);
    if (links.length > 0) expect(Object.keys(links[0] ?? {})).toEqual(['relatedid', 'contentid', 'relatedcontentsetid', 'orderno']);
  });

  it.each<[string, Partial<RelatedContentArgs>, string[]]>([
    ['content order', {}, [SB, BX, SC, SA]],
    ['a related-content set by link order', { relatedContentSetId: RCSET1 }, [BX, SC, SB]],
    ['a set name by link order', { name: 'FEATURED' }, [BX, SC, SB]],
    ['a case-insensitive menu title sort', { sortBy: 'menutitle', sortDirection: 'desc' }, [SB, SA, BX, SC]],
    ['creation date', { sortBy: 'created' }, [SB, SA, BX, SC]],
  ])('relatedLinks, relatedCandidates in each pool tenant and mergeRelatedContent read a forward relation across pool tenants by %s', async (_label, sort, expected) => {
    const args: RelatedContentArgs = { siteId: SITE, contentHistId: P_V2, today: TODAY, contentPoolSiteIds: POOL, ...sort };
    const links = await inA((tx) => relatedLinks(tx, args));
    const candidates = [await inA((tx) => relatedCandidates(tx, { ...args, links })), await inB((tx) => relatedCandidates(tx, { ...args, links }))];
    const rows = await inA((tx) => mergeRelatedContent(tx, args, candidates));
    expect(ids(rows)).toEqual(expected);
    expect(rows.map((row) => Object.keys(row))).toEqual(rows.map(() => RELATED_COLUMNS));
    expect(rows.find((row) => row.contentid === BX)).toMatchObject({
      siteid: TENANT_B.siteId,
      relatedfromcontentid: P,
      relatedcontentsetid: RCSET1,
      orderno: 15,
      parenttype: '',
    });
  });

  it('relatedCandidates in each pool tenant and mergeRelatedContent read the versions relating to content across pool tenants', async () => {
    const args: RelatedContentArgs = { siteId: SITE, contentHistId: '', today: TODAY, contentPoolSiteIds: POOL, reverse: true, reverseContentId: SB };
    const candidates = [await inA((tx) => relatedCandidates(tx, args)), await inB((tx) => relatedCandidates(tx, args))];
    expect(candidates.map((tenant) => ids(tenant.map((candidate) => candidate.row)))).toEqual([[P], [BY]]);
    const rows = await inA((tx) => mergeRelatedContent(tx, args, candidates));
    expect(ids(rows)).toEqual([BY, P]);
    expect(rows[0]).toMatchObject({ relatedfromcontentid: BY, siteid: TENANT_B.siteId, menutitle: 'apiary' });
  });

  it('relatedCandidates answers no links with no rows, rejects links on a reverse read, and mergeRelatedContent keeps legacy sort failures', async () => {
    const args: RelatedContentArgs = { siteId: SITE, contentHistId: P_V2, today: TODAY, contentPoolSiteIds: POOL };
    expect(await inA((tx) => relatedCandidates(tx, { ...args, links: [] }))).toEqual([]);
    await expect(inA((tx) => relatedCandidates(tx, { ...args, reverse: true, reverseContentId: SB, links: [] }))).rejects.toThrow(TypeError);
    const inPoolB = await inB((tx) => relatedCandidates(tx, { ...args, links: [{ relatedid: BX, contentid: P, relatedcontentsetid: null, orderno: 7 }] }));
    expect(inPoolB).toMatchObject([{ row: { contentid: BX, relatedcontentsetid: null }, linkOrderNo: 7, created: at('2026-03-01T00:00') }]);
    expect(await inA((tx) => mergeRelatedContent(tx, args, [[], inPoolB]))).toEqual(inPoolB.map((candidate) => candidate.row));
    await expect(inA((tx) => mergeRelatedContent(tx, { ...args, sortBy: 'comments' }, []))).rejects.toThrow(ContentQueryError);
  });

  it.each([
    ['an object placed in a region or named in a body', CMP1.toLowerCase(), [P_V2, v(SE)]],
    ['no object', '', []],
  ])('usage lists the active versions using %s', async (_label, objectId, expected) => {
    const rows = await inA((tx) => usage(tx, { siteId: SITE, objectId }));
    expect(ids(rows, 'contenthistid')).toEqual(expected);
    if (rows.length > 0) expect(Object.keys(rows[0] ?? {})).toEqual(USAGE_COLUMNS);
  });

  it.each<[string, Partial<Parameters<typeof tagCloud>[1]>, [string, number][]]>([
    ['the default group of navigable site-tree content, grouped case- and space-insensitively', {}, [['asters', 1], ['flowers', 2]]],
    ['a tag group', { tagGroup: 'GARDEN' }, [['trees', 1]]],
    ['the default group by name', { tagGroup: 'default' }, [['asters', 1], ['flowers', 2]]],
    ['children of a parent', { parentId: SA.toLowerCase() }, [['flowers', 1]]],
    ['categories', { categoryIds: [CAT2] }, [['asters', 1]]],
    ['another module', { moduleId: COMPONENTS_MODULE }, []],
  ])('tagCloud counts %s', async (_label, args, expected) => {
    const rows = await inA((tx) => tagCloud(tx, { siteId: SITE, today: TODAY, ...args }));
    expect(rows.map((row) => [row.tag.trim().toLowerCase(), row.tagcount])).toEqual(expected);
  });

  it('objects lists a region by position and objectInheritance drops goToFirstChild', async () => {
    expect(await inA((tx) => objects(tx, { columnId: 2, contentHistId: P_V2.toLowerCase(), siteId: SITE }))).toEqual([
      { object: 'comments', name: 'Comments', objectid: 'none', orderno: 1, params: null, configuratorinit: null },
      { object: 'component', name: 'beta box', objectid: CMP1, orderno: 2, params: '{"x":1}', configuratorinit: null },
      { object: 'goToFirstChild', name: null, objectid: 'none', orderno: 3, params: null, configuratorinit: null },
    ]);
    expect(ids(await inA((tx) => objectInheritance(tx, { columnId: 2, inheritedObjects: P_V2, siteId: SITE })), 'object')).toEqual([
      'comments',
      'component',
    ]);
    expect(await inA((tx) => objectInheritance(tx, { columnId: 1, inheritedObjects: P_V2, siteId: 'other' }))).toEqual([]);
  });

  it.each<[string, typeof hasComments, { contentHistId: string; inheritedObjects?: string }, number]>([
    ['hasComments on a version', hasComments, { contentHistId: P_V2 }, 1],
    ['hasComments with inherited objects', hasComments, { contentHistId: v(SE), inheritedObjects: P_V2.toLowerCase() }, 2],
    ['hasComments with an empty inherited version', hasComments, { contentHistId: v(SE), inheritedObjects: '' }, 1],
    ['hasRatings on a version', hasRatings, { contentHistId: P_V2 }, 1],
    ['hasRatings without raters', hasRatings, { contentHistId: v(SE) }, 0],
    ['hasTagCloud on a version', hasTagCloud, { contentHistId: P_V2 }, 1],
  ])('%s counts its placements', async (_label, count, args, expected) => {
    expect(await inA((tx) => count(tx, { siteId: SITE, ...args }))).toBe(expected);
  });

  it.each<[string, Partial<Parameters<typeof categorySummary>[1]>, [string, number][]]>([
    ['live navigable site-tree content', {}, [[CAT1, 3], [CAT2, 1], [CAT3, 1]]],
    ['the calendar window', { menuType: 'Calendar' }, [[CAT1, 3], [CAT2, 2], [CAT3, 1]]],
    ['listed categories', { categoryIds: [CAT2.toLowerCase()] }, [[CAT2, 1]]],
    ['content within other categories', { categoryIds: [CAT1], withinCategoryIds: [CAT2] }, [[CAT1, 1]]],
    ['children of listed parents', { parentId: `${SA},${MISSING}` }, [[CAT1, 1]]],
    ['content relating to listed content', { relatedIds: [SB] }, [[CAT3, 1]]],
  ])('categorySummary counts %s per category', async (_label, args, expected) => {
    const rows = await inA((tx) => categorySummary(tx, { siteId: SITE, today: TODAY, ...args }));
    expect(rows.map((row) => [row.categoryid, row.count])).toEqual(expected);
  });

  it('categorySummary rejects category narrowing without categories, as legacy’s unclosed IN list fails', async () => {
    await expect(inA((tx) => categorySummary(tx, { siteId: SITE, today: TODAY, withinCategoryIds: [CAT1] }))).rejects.toThrow(
      new ContentQueryError('Incorrect syntax: the category id IN list is not closed'),
    );
  });

  it.each([
    ['approved comments', {}, 2],
    ['spam', { isSpam: true }, 1],
    ['deleted comments', { isDeleted: true }, 1],
    ['deleted spam', { isSpam: true, isDeleted: true }, 0],
  ])('commentCount counts %s', async (_label, flags, expected) => {
    expect(await inA((tx) => commentCount(tx, { siteId: SITE, contentId: P.toLowerCase(), ...flags }))).toBe(expected);
  });

  it.each<[string, (tx: TenantTx) => Promise<unknown>, unknown]>([
    ['readActive a version stored as type file', async (tx) => ids(await readActive(tx, { siteId: MX, contentId: MFILE }), 'contenthistid'), [v(MFILE)]],
    ['readActive a version stored as type form', async (tx) => ids(await readActive(tx, { siteId: MX, contentId: MFORM }), 'contenthistid'), [v(MFORM)]],
    ['readActiveByFilename a file by filename', async (tx) => ids(await readActiveByFilename(tx, { siteId: MX, filename: 'Willow.PDF' }), 'contenthistid'), [v(MFILE)]],
    ['nest the tree children of every listed type', async (tx) => ids(await nest(tx, { parentId: MXP, siteId: MX })), [MFILE, MFORM, MFOLDER, MLINK, MCAL, MIMAGE]],
    ['sections the folders and calendars', async (tx) => ids(await sections(tx, { siteId: MX })), [MFOLDER, MCAL]],
    ['pageCount the pages, folders, files and calendars', (tx) => pageCount(tx, { siteId: MX }), [{ counter: 8 }]],
    ['components a component', async (tx) => ids(await components(tx, { moduleId: SITE_TREE_MODULE_ID, siteId: MX })), [MCOMP]],
    ['privateSearch every search type, never a link by its body', async (tx) => ids(await privateSearch(tx, { siteId: MX, keywords: 'willow' })), [MCOMP, MFILE, MEVENT, MFOLDER, MFORM]],
    ['privateSearch a PNG as an image', async (tx) => ids(await privateSearch(tx, { siteId: MX, keywords: 'willow', searchType: 'image' })), [MIMAGE]],
    ['poolFileMatches a PNG as an image', (tx) => poolFileMatches(tx, { keywords: 'willow', searchType: 'image', fileIds: [MPNG] }), { fileIds: [MPNG], keywordFileIds: [MPNG] }],
    ['publicSearch files, folders and a future event under a calendar', async (tx) => ids(await publicSearch(tx, { siteId: MX, keywords: 'willow', today: TODAY })), [MFILE, MEVENT, MFOLDER]],
    ['relatedContent a future event under a calendar', async (tx) => ids(await relatedContent(tx, { siteId: MX, contentHistId: v(MXP), today: TODAY })), [MEVENT]],
    ['tagCloud the tags of a future event under a calendar', (tx) => tagCloud(tx, { siteId: MX, today: TODAY }), [{ tag: 'Willow', tagcount: 1 }]],
    ['expireAssignments an EXPIRE assignment', (tx) => expireAssignments(tx, { contentHistId: v(MFILE) }), [{ userid: USER }]],
    ['expiringContent content with an EXPIRE assignment', (tx) => expiringContent(tx, { siteId: MX, userId: USER, today: TODAY }), [{ contentid: MFILE }]],
    ['draftList a Draft assignment', async (tx) => ids(await draftList(tx, { siteId: MX, userId: USER }), 'contenthistid'), [v(MDRAFT)]],
    ['approvalsQuery a pending request', async (tx) => ids(await approvalsQuery(tx, { siteId: MX, groupIds: null }), 'contenthistid'), [v(MAPPROVE)]],
  ])('compares stored legacy spellings case-insensitively: %s', async (_label, read, expected) => {
    expect(await inB(read)).toEqual(expected);
  });

  it('makes every read wait out an executing window and fail with UnitReadBlockedError', async () => {
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId, phase: 'executing', allowLegacy: true });
    try {
      const reads: [string, (tx: TenantTx) => Promise<unknown>][] = [
        ['components', (tx) => components(tx, { moduleId: SITE_TREE_MODULE_ID, siteId: SITE })],
        ['componentType', (tx) => componentType(tx, { siteId: SITE, type: 'Component' })],
        ['top', (tx) => top(tx, { topId: HOME, siteId: SITE })],
        ['downloadSelect', (tx) => downloadSelect(tx, { contentId: FORM1, siteId: SITE })],
        ['hist', (tx) => hist(tx, { contentId: P, siteId: SITE })],
        ['draftList', (tx) => draftList(tx, { siteId: SITE, userId: USER })],
        ['approvalsQuery', (tx) => approvalsQuery(tx, { siteId: SITE, groupIds: null })],
        ['expiringContent', (tx) => expiringContent(tx, { siteId: SITE, userId: USER, today: TODAY })],
        ['lockedContentCount', (tx) => lockedContentCount(tx, { siteId: SITE, userId: USER })],
        ['draftPromptData', (tx) => draftPromptData(tx, { contentId: P, siteId: SITE })],
        ['poolFileMatches', (tx) => poolFileMatches(tx, { keywords: 'orchid', searchType: 'file', fileIds: [IMG] })],
        ['privateSearchFileIds', (tx) => privateSearchFileIds(tx, { siteId: SITE, keywords: 'orchid', searchType: 'file' })],
        ['privateSearch', (tx) => privateSearch(tx, { siteId: SITE, keywords: 'orchid' })],
        ['publicSearch', (tx) => publicSearch(tx, { siteId: SITE, keywords: 'orchid', today: TODAY })],
        ['relatedContent', (tx) => relatedContent(tx, { siteId: SITE, contentHistId: P_V2, today: TODAY })],
        ['relatedLinks', (tx) => relatedLinks(tx, { contentHistId: P_V2 })],
        [
          'relatedCandidates',
          (tx) => relatedCandidates(tx, { siteId: SITE, contentHistId: P_V2, today: TODAY, links: [{ relatedid: SB, contentid: P, relatedcontentsetid: null, orderno: 1 }] }),
        ],
        ['usage', (tx) => usage(tx, { siteId: SITE, objectId: CMP1 })],
        ['tagCloud', (tx) => tagCloud(tx, { siteId: SITE, today: TODAY })],
        ['objects', (tx) => objects(tx, { columnId: 2, contentHistId: P_V2, siteId: SITE })],
        ['objectInheritance', (tx) => objectInheritance(tx, { columnId: 2, inheritedObjects: P_V2, siteId: SITE })],
        ['categorySummary', (tx) => categorySummary(tx, { siteId: SITE, today: TODAY })],
        ['commentCount', (tx) => commentCount(tx, { siteId: SITE, contentId: P })],
        ['hasComments', (tx) => hasComments(tx, { siteId: SITE, contentHistId: P_V2 })],
        ['fileJoinColumns', (tx) => fileJoinColumns(tx, [IMG])],
      ];
      for (const [label, read] of reads) {
        const err = await withGatedTenant(handle.app, TENANT_A.tenantId, read, { budgetMs: 200 }).catch((caught: unknown) => caught);
        expect(err, label).toBeInstanceOf(UnitReadBlockedError);
      }
    } finally {
      await openGates(handle.app, { units: CONTENT_UNITS, holderId, state: 'legacy' });
    }
  });
});
