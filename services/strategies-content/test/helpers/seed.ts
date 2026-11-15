/** Deterministic content test data shared by the strategies-content suites: fixed ids, typed row builders, per-tenant datasets and their loaders. */
import { cfUuid } from '@opt2/platform/legacy-compat';
import { legacyRowHash, sha256Hex, type RepositoryRow, type TableDefinition, type WriteContext } from '@opt2/platform/migration-kit';
import { contentFileKey, type ContentFileVariant } from '@opt2/platform/storage';
import { withTenant } from '@opt2/platform/tenancy';
import { BUSINESS_DATE, TENANT_A, TENANT_B, TENANT_UMBRELLA, seedRegistry, type TenantFixture, type ThrowawaySchema } from '@opt2/platform/testing';
import { createContentRepository } from '../../src/repo/repository.js';
import {
  APPROVAL_ASSIGNMENT,
  APPROVAL_CHAIN,
  APPROVAL_MEMBERSHIP,
  APPROVAL_REQUEST,
  CATEGORY,
  CATEGORY_ASSIGN,
  CHANGESET,
  COMMENT,
  CONTENT,
  DISPLAY_TITLE_APPROVAL,
  FEED,
  FILE,
  FILE_OBJECT,
  FORM_RESPONSE_PACKET,
  GROUP_PROJECTION,
  IDENTITY_COLUMNS,
  MEMBERSHIP_PROJECTION,
  PERMISSION_PROJECTION,
  PUBLIC_SUBMISSION_APPROVAL,
  type ApprovalAssignmentRow,
  type ApprovalChainRow,
  type ApprovalMembershipRow,
  type ApprovalRequestRow,
  type CategoryAssignRow,
  type CategoryRow,
  type ChangesetRow,
  type CommentRow,
  type ContentRow,
  type DisplayTitleApprovalRow,
  type FeedRow,
  type FileObjectRow,
  type FileRow,
  type FormResponsePacketRow,
  type GroupProjectionRow,
  type MembershipProjectionRow,
  type PermissionProjectionRow,
  type PublicSubmissionApprovalRow,
} from '../../src/repo/tables.js';
import { TEST_CLOCK, openContentGates, type MemoryStorage, type RecordingDb } from './app.js';
import { SUBJECT_USER_IDS } from './tokens.js';

/** Fixed ids of the seeded rows: Masa sentinels verbatim, every other id a CF-format literal with a readable area prefix. */
export const IDS = Object.freeze({
  sites: Object.freeze({ tenantA: TENANT_A.siteId, tenantB: TENANT_B.siteId, umbrella: TENANT_UMBRELLA.siteId }),
  // mssql.sql:1046-1049
  modules: Object.freeze({
    content: '00000000000000000000000000000000000',
    components: '00000000000000000000000000000000003',
    forms: '00000000000000000000000000000000004',
  }),
  rootParent: '00000000000000000000000000000000END',
  content: Object.freeze({
    root: '00000000000000000000000000000000001',
    section: 'A1000000-0000-0000-0000000000000002',
    pageOne: 'A1000000-0000-0000-0000000000000003',
    pageTwo: 'A1000000-0000-0000-0000000000000004',
    restricted: 'A1000000-0000-0000-0000000000000005',
    fileNode: 'A1000000-0000-0000-0000000000000006',
    linkNode: 'A1000000-0000-0000-0000000000000007',
    formNode: 'A1000000-0000-0000-0000000000000008',
    formsModule: '00000000000000000000000000000000004',
    bRoot: '00000000000000000000000000000000001',
    bPage: 'B1000000-0000-0000-0000000000000001',
  }),
  hist: Object.freeze({
    rootActive: 'A2000000-0000-0000-0000000000000001',
    rootDraft: 'A2000000-0000-0000-0000000000000002',
    sectionActive: 'A2000000-0000-0000-0000000000000003',
    sectionDraft: 'A2000000-0000-0000-0000000000000004',
    pageOneActive: 'A2000000-0000-0000-0000000000000005',
    pageOneDraft: 'A2000000-0000-0000-0000000000000006',
    pageTwoActive: 'A2000000-0000-0000-0000000000000007',
    pageTwoDraft: 'A2000000-0000-0000-0000000000000008',
    restrictedActive: 'A2000000-0000-0000-0000000000000009',
    restrictedDraft: 'A2000000-0000-0000-0000000000000010',
    fileNodeActive: 'A2000000-0000-0000-0000000000000011',
    fileNodeDraft: 'A2000000-0000-0000-0000000000000012',
    linkNodeActive: 'A2000000-0000-0000-0000000000000013',
    linkNodeDraft: 'A2000000-0000-0000-0000000000000014',
    formsModuleActive: 'A2000000-0000-0000-0000000000000015',
    formsModuleDraft: 'A2000000-0000-0000-0000000000000016',
    formNodeActive: 'A2000000-0000-0000-0000000000000017',
    formNodeDraft: 'A2000000-0000-0000-0000000000000018',
    bRootActive: 'B2000000-0000-0000-0000000000000001',
    bRootDraft: 'B2000000-0000-0000-0000000000000002',
    bPageActive: 'B2000000-0000-0000-0000000000000003',
    bPageDraft: 'B2000000-0000-0000-0000000000000004',
  }),
  files: Object.freeze({
    pdf: 'A3000000-0000-0000-0000000000000001',
    video: 'A3000000-0000-0000-0000000000000002',
    image: 'A3000000-0000-0000-0000000000000003',
    flv: 'A3000000-0000-0000-0000000000000004',
  }),
  changesets: Object.freeze({
    scheduledDue: 'A4000000-0000-0000-0000000000000001',
    scheduledFuture: 'A4000000-0000-0000-0000000000000002',
    published: 'A4000000-0000-0000-0000000000000003',
  }),
  approval: Object.freeze({
    chain: 'A5000000-0000-0000-0000000000000001',
    membershipOne: 'A5000000-0000-0000-0000000000000002',
    membershipTwo: 'A5000000-0000-0000-0000000000000003',
    request: 'A5000000-0000-0000-0000000000000004',
    assignment: 'A5000000-0000-0000-0000000000000005',
  }),
  groups: Object.freeze({
    editor: 'A6000000-0000-0000-0000000000000001',
    approvers: 'A6000000-0000-0000-0000000000000002',
  }),
  categories: Object.freeze({
    pooledParent: 'A7000000-0000-0000-0000000000000001',
    pooledChild: 'A7000000-0000-0000-0000000000000002',
    bOwn: 'B7000000-0000-0000-0000000000000001',
  }),
  comments: Object.freeze({
    approved: 'A8000000-0000-0000-0000000000000001',
    unapproved: 'A8000000-0000-0000-0000000000000002',
    spam: 'A8000000-0000-0000-0000000000000003',
    deleted: 'A8000000-0000-0000-0000000000000004',
  }),
  feeds: Object.freeze({
    local: 'A9000000-0000-0000-0000000000000001',
    remoteAuto: 'A9000000-0000-0000-0000000000000002',
    remoteManual: 'A9000000-0000-0000-0000000000000003',
  }),
  forms: Object.freeze({
    responseOne: 'AA000000-0000-0000-0000000000000001',
    responseTwo: 'AA000000-0000-0000-0000000000000002',
  }),
});

/** A fresh CF-format id for rows a test builds beyond the seed; never used for {@link IDS}. */
export function newId(): string {
  return cfUuid();
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?$/;
const TIME_ONLY = /^\d{2}:\d{2}(?::\d{2})?$/;

/** The local Date of `yyyy-mm-ddTHH:mm[:ss]`, or of `HH:mm[:ss]` on BUSINESS_DATE; throws RangeError for any other text. */
export function at(localIso: string): Date {
  const text = TIME_ONLY.test(localIso) ? `${BUSINESS_DATE}T${localIso}` : localIso;
  const date = new Date(text);
  if (!LOCAL_DATE_TIME.test(text) || Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid local date-time: ${localIso}`);
  }
  return date;
}

/** Masa content `path`: the single-quoted ids from the root down, comma separated. */
export function contentPath(...ids: readonly string[]): string {
  return ids.map((id) => `'${id}'`).join(',');
}

const CREATED_AT = '2026-06-01T09:00:00';
const ACTIVE_UPDATED_AT = '2026-06-29T10:00:00';
const DRAFT_UPDATED_AT = '2026-06-29T15:30:00';
const COMMENT_ENTERED_ON = '2026-06-28';
const FORM_ENTERED_ON = '2026-06-28';

/** Form response packet of {@link IDS.forms.responseOne}, stored byte-exact. */
export const WDDX_RESPONSE_ONE =
  "<wddxPacket version='1.0'><header/><data><struct><var name='name'><string>Ada Lovelace</string></var><var name='email'><string>ada@example.org</string></var></struct></data></wddxPacket>";

/** Form response packet of {@link IDS.forms.responseTwo}, stored byte-exact. */
export const WDDX_RESPONSE_TWO =
  "<wddxPacket version='1.0'><header/><data><struct><var name='name'><string>Grace Hopper</string></var><var name='email'><string>grace@example.org</string></var></struct></data></wddxPacket>";

/** One seeded stored object of a file: its variant, extension, content type and payload text. */
interface ObjectSpec {
  readonly variant: ContentFileVariant;
  readonly ext: string;
  readonly contentType: string;
  readonly payload: string;
}

/** One seeded `tfiles` row of the umbrella file pool and the objects its manifest lists. */
interface FileSpec {
  readonly fileid: string;
  readonly contentid: string | null;
  readonly filename: string;
  readonly contenttype: string;
  readonly contentsubtype: string;
  readonly fileext: string;
  readonly objects: readonly ObjectSpec[];
}

/** Masa image renditions (fileDAO.cfc:159-179): every image and flv upload also stores `_source`, `_small` and `_medium` jpg files. */
function renditions(name: string): ObjectSpec[] {
  return (['_source', '_small', '_medium'] as const).map((variant) => ({
    variant,
    ext: 'jpg',
    contentType: 'image/jpeg',
    payload: `opt2 seed ${name} ${variant.slice(1)} rendition\n`,
  }));
}

const FILE_SPECS: readonly FileSpec[] = Object.freeze([
  {
    fileid: IDS.files.pdf,
    contentid: IDS.content.fileNode,
    filename: 'guide.pdf',
    contenttype: 'application',
    contentsubtype: 'pdf',
    fileext: 'pdf',
    objects: [{ variant: '', ext: 'pdf', contentType: 'application/pdf', payload: '%PDF-1.4 opt2 seed\n' }],
  },
  {
    fileid: IDS.files.video,
    contentid: null,
    filename: 'clip.mp4',
    contenttype: 'video',
    contentsubtype: 'mp4',
    fileext: 'mp4',
    objects: [{ variant: '', ext: 'mp4', contentType: 'video/mp4', payload: 'opt2 seed clip.mp4\n' }],
  },
  {
    fileid: IDS.files.image,
    contentid: null,
    filename: 'photo.jpg',
    contenttype: 'image',
    contentsubtype: 'jpeg',
    fileext: 'jpg',
    objects: [{ variant: '', ext: 'jpg', contentType: 'image/jpeg', payload: 'opt2 seed photo.jpg original\n' }, ...renditions('photo.jpg')],
  },
  {
    fileid: IDS.files.flv,
    contentid: null,
    filename: 'movie.flv',
    contenttype: 'video',
    contentsubtype: 'x-flv',
    fileext: 'flv',
    objects: [{ variant: '', ext: 'flv', contentType: 'video/x-flv', payload: 'opt2 seed movie.flv original\n' }, ...renditions('movie.flv')],
  },
]);

/** `content-files` key of one seeded object of the umbrella file pool. */
function seededObjectKey(spec: FileSpec, object: ObjectSpec): string {
  return contentFileKey({ tenantId: TENANT_UMBRELLA.tenantId, fileId: spec.fileid, variant: object.variant, ext: object.ext });
}

/** One seeded object's payload and content type. */
export interface SeedObject {
  readonly bytes: Buffer;
  readonly contentType: string;
}

/** Payload of every seeded `file_object`, by object key; each manifest row's `size` and `sha256` describe these bytes. */
export const FILE_BYTES: Readonly<Record<string, SeedObject>> = Object.freeze(
  Object.fromEntries(
    FILE_SPECS.flatMap((spec) =>
      spec.objects.map((object) => [seededObjectKey(spec, object), Object.freeze({ bytes: Buffer.from(object.payload, 'utf8'), contentType: object.contentType })]),
    ),
  ),
);

/** A `content` row as written: the identity column `tcontent_id` is assigned by PostgreSQL. */
export type ContentSeedRow = Omit<ContentRow, typeof IDENTITY_COLUMNS.content>;
/** A `display_title_approval` row as written: the repository fills `legacy_row_hash` and `occurrence`. */
export type DisplayTitleApprovalSeedRow = Omit<DisplayTitleApprovalRow, 'legacy_row_hash' | 'occurrence'>;
/** A `public_submission_approval` row as written: the repository fills `legacy_row_hash` and `occurrence`. */
export type PublicSubmissionApprovalSeedRow = Omit<PublicSubmissionApprovalRow, 'legacy_row_hash' | 'occurrence'>;

/** A Masa `Page` version of tenant-a under the home node, active and approved, with the contentBean defaults. */
export function contentRow(overrides: Partial<ContentSeedRow> = {}): ContentSeedRow {
  const contentid = overrides.contentid ?? newId();
  const title = overrides.title ?? 'Untitled Page';
  return {
    tenant_id: TENANT_A.tenantId,
    siteid: TENANT_A.siteId,
    moduleid: IDS.modules.content,
    parentid: IDS.content.root,
    contentid,
    contenthistid: newId(),
    remoteid: null,
    remoteurl: null,
    remotepubdate: null,
    remotesourceurl: null,
    remotesource: null,
    credits: null,
    fileid: null,
    template: null,
    type: 'Page',
    subtype: 'Default',
    active: 1,
    orderno: 1,
    title,
    menutitle: title,
    summary: null,
    filename: null,
    metadesc: null,
    metakeywords: null,
    body: null,
    lastupdate: at(ACTIVE_UPDATED_AT),
    lastupdateby: 'System',
    lastupdatebyid: null,
    displaystart: null,
    displaystop: null,
    display: 1,
    approved: 1,
    isnav: 1,
    restricted: 0,
    restrictgroups: null,
    target: '_self',
    targetparams: null,
    responsechart: 0,
    responsemessage: null,
    responsesendto: null,
    responsedisplayfields: null,
    moduleassign: null,
    displaytitle: 1,
    notes: null,
    inheritobjects: 'Cascade',
    isfeature: 0,
    releasedate: null,
    islocked: 0,
    nextn: 10,
    sortby: 'orderno',
    sortdirection: 'asc',
    featurestart: null,
    featurestop: null,
    forcessl: 0,
    audience: null,
    keypoints: null,
    searchexclude: 0,
    path: contentid === IDS.content.root ? contentPath(contentid) : contentPath(IDS.content.root, contentid),
    tags: null,
    docache: 1,
    urltitle: null,
    htmltitle: null,
    created: at(CREATED_AT),
    mobileexclude: 0,
    changesetid: null,
    imagesize: 'small',
    imageheight: 'AUTO',
    imagewidth: 'AUTO',
    childtemplate: null,
    majorversion: 0,
    minorversion: 0,
    expires: null,
    displayinterval: null,
    objectparams: null,
    ...overrides,
  };
}

/** A `tfiles` row of tenant-a's content module, without database-held image bytes. */
export function fileRow(overrides: Partial<FileRow> = {}): FileRow {
  return {
    tenant_id: TENANT_A.tenantId,
    fileid: newId(),
    contentid: null,
    siteid: TENANT_A.siteId,
    moduleid: IDS.modules.content,
    filename: 'file.bin',
    image: null,
    imagesmall: null,
    imagemedium: null,
    filesize: 0,
    contenttype: 'application',
    contentsubtype: 'octet-stream',
    fileext: 'bin',
    created: at(CREATED_AT),
    deleted: 0,
    caption: null,
    credits: null,
    alttext: null,
    remoteid: null,
    remoteurl: null,
    remotepubdate: null,
    remotesource: null,
    remotesourceurl: null,
    exif: null,
    ...overrides,
  };
}

/** Builder input of {@link fileObjectRow}: the manifest columns plus the object's `bytes`, which set `size` and `sha256`. */
export type FileObjectOverrides = Omit<Partial<FileObjectRow>, 'variant'> & { variant?: ContentFileVariant; bytes?: Buffer };

/** A `file_object` manifest row; `object_key` follows `contentFileKey` and `size`/`sha256` describe `bytes`. */
export function fileObjectRow(overrides: FileObjectOverrides = {}): FileObjectRow {
  const { bytes = Buffer.from('opt2 seed object\n', 'utf8'), ...columns } = overrides;
  const tenantId = columns.tenant_id ?? TENANT_A.tenantId;
  const fileId = columns.file_id ?? newId();
  const variant = columns.variant ?? '';
  const ext = columns.ext ?? 'bin';
  return {
    tenant_id: tenantId,
    file_id: fileId,
    variant,
    ext,
    object_key: contentFileKey({ tenantId, fileId, variant, ext }),
    size: String(bytes.length),
    sha256: sha256Hex(bytes),
    content_type: 'application/octet-stream',
    orphan: false,
    created_at: at(CREATED_AT),
    ...columns,
  };
}


/** An unpublished `tchangesets` row of tenant-a without a publish date. */
export function changesetRow(overrides: Partial<ChangesetRow> = {}): ChangesetRow {
  return {
    tenant_id: TENANT_A.tenantId,
    changesetid: newId(),
    siteid: TENANT_A.siteId,
    name: 'Change Set',
    description: null,
    created: at(CREATED_AT),
    publishdate: null,
    published: 0,
    lastupdate: at(ACTIVE_UPDATED_AT),
    lastupdateby: 'System',
    lastupdatebyid: null,
    remoteid: null,
    remotepubdate: null,
    remotesourceurl: null,
    closedate: null,
    ...overrides,
  };
}

/** A `tapprovalchains` row of tenant-a. */
export function approvalChainRow(overrides: Partial<ApprovalChainRow> = {}): ApprovalChainRow {
  return {
    tenant_id: TENANT_A.tenantId,
    siteid: TENANT_A.siteId,
    chainid: newId(),
    name: 'Approval Chain',
    created: at(CREATED_AT),
    lastupdate: at(ACTIVE_UPDATED_AT),
    description: null,
    lastupdateby: 'System',
    lastupdatebyid: null,
    ...overrides,
  };
}

/** A `tapprovalmemberships` row: one approving group of a chain, first in order. */
export function approvalMembershipRow(overrides: Partial<ApprovalMembershipRow> = {}): ApprovalMembershipRow {
  return {
    tenant_id: TENANT_A.tenantId,
    groupid: newId(),
    siteid: TENANT_A.siteId,
    created: at(CREATED_AT),
    orderno: 1,
    membershipid: newId(),
    chainid: newId(),
    ...overrides,
  };
}

/** A `tapprovalassignments` row binding a chain to a content node, without exemptions. */
export function approvalAssignmentRow(overrides: Partial<ApprovalAssignmentRow> = {}): ApprovalAssignmentRow {
  return {
    tenant_id: TENANT_A.tenantId,
    siteid: TENANT_A.siteId,
    assignmentid: newId(),
    contentid: IDS.content.root,
    exemptid: null,
    chainid: newId(),
    ...overrides,
  };
}

/** A `Pending` `tapprovalrequests` row of a content version. */
export function approvalRequestRow(overrides: Partial<ApprovalRequestRow> = {}): ApprovalRequestRow {
  return {
    tenant_id: TENANT_A.tenantId,
    siteid: TENANT_A.siteId,
    userid: newId(),
    groupid: newId(),
    created: at(ACTIVE_UPDATED_AT),
    status: 'Pending',
    contenthistid: newId(),
    requestid: newId(),
    chainid: newId(),
    ...overrides,
  };
}

/** A top-level `tcontentcategories` row of tenant-a with the categoryBean defaults; `path` lists the parent, when given, then the id. */
export function categoryRow(overrides: Partial<CategoryRow> = {}): CategoryRow {
  const categoryid = overrides.categoryid ?? newId();
  const parentid = overrides.parentid ?? null;
  return {
    tenant_id: TENANT_A.tenantId,
    categoryid,
    siteid: TENANT_A.siteId,
    parentid,
    datecreated: at(CREATED_AT),
    lastupdate: at(ACTIVE_UPDATED_AT),
    lastupdateby: 'System',
    name: 'Category',
    notes: null,
    isinterestgroup: 1,
    isactive: 1,
    isopen: 1,
    sortby: 'orderno',
    sortdirection: 'asc',
    restrictgroups: null,
    path: parentid === null || parentid === '' ? categoryid : `${parentid},${categoryid}`,
    remoteid: null,
    remotesourceurl: null,
    remotepubdate: null,
    urltitle: null,
    filename: null,
    isfeatureable: 1,
    ...overrides,
  };
}

/** A `tcontentcategoryassign` row of tenant-a, not featured. */
export function categoryAssignRow(overrides: Partial<CategoryAssignRow> = {}): CategoryAssignRow {
  return {
    tenant_id: TENANT_A.tenantId,
    contenthistid: newId(),
    categoryid: newId(),
    contentid: null,
    isfeature: 0,
    orderno: 1,
    siteid: TENANT_A.siteId,
    featurestart: null,
    featurestop: null,
    ...overrides,
  };
}

/** A top-level `tcontentcomments` row of tenant-a; flags default to 0 (dbUpdates/6.1.cfm:164-166) and `path` is its own id. */
export function commentRow(overrides: Partial<CommentRow> = {}): CommentRow {
  const commentid = overrides.commentid ?? newId();
  return {
    tenant_id: TENANT_A.tenantId,
    commentid,
    contentid: null,
    contenthistid: null,
    url: null,
    name: 'Commenter',
    comments: 'A comment.',
    entered: at(`${COMMENT_ENTERED_ON}T09:00:00`),
    email: 'commenter@example.org',
    siteid: TENANT_A.siteId,
    ip: '127.0.0.1',
    isapproved: 0,
    subscribe: 0,
    userid: null,
    parentid: null,
    path: commentid,
    remoteid: null,
    flagcount: 0,
    isspam: 0,
    isdeleted: 0,
    ...overrides,
  };
}

/** A `Local` `tcontentfeeds` collection of tenant-a with the feedBean defaults. */
export function feedRow(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    tenant_id: TENANT_A.tenantId,
    feedid: newId(),
    siteid: TENANT_A.siteId,
    parentid: null,
    name: 'Collection',
    isactive: 1,
    ispublic: 0,
    isdefault: 0,
    isfeaturesonly: 0,
    description: null,
    maxitems: 20,
    allowhtml: 1,
    lang: 'en-us',
    lastupdateby: 'System',
    lastupdate: at(ACTIVE_UPDATED_AT),
    datecreated: at(CREATED_AT),
    restricted: 0,
    restrictgroups: null,
    version: 'RSS 2.0',
    channellink: null,
    type: 'Local',
    sortby: 'lastUpdate',
    sortdirection: 'desc',
    nextn: 20,
    displayname: 0,
    displayratings: 0,
    displaycomments: 0,
    altname: null,
    remoteid: null,
    remotesourceurl: null,
    remotepubdate: null,
    imagesize: 'small',
    imageheight: 'AUTO',
    imagewidth: 'AUTO',
    displaylist: 'Title,Date,Image,Summary,Tags,Credits',
    shownavonly: 1,
    showexcludesearch: 0,
    viewalllink: null,
    viewalllabel: null,
    cssclass: null,
    autoimport: 0,
    islocked: 0,
    contentpoolid: '',
    usecategoryintersect: 0,
    authtype: 'DEFAULT',
    ...overrides,
  };
}

/** A `tformresponsepackets` row of tenant-a; `data` is stored byte-exact. */
export function formResponsePacketRow(overrides: Partial<FormResponsePacketRow> = {}): FormResponsePacketRow {
  return {
    tenant_id: TENANT_A.tenantId,
    responseid: newId(),
    formid: IDS.content.formNode,
    siteid: TENANT_A.siteId,
    fieldlist: 'name,email',
    data: WDDX_RESPONSE_ONE,
    entered: at(`${FORM_ENTERED_ON}T14:00:00`),
    ...overrides,
  };
}

/** A pending `tcontentdisplaytitleapprovals` row of tenant-a. */
export function displayTitleApprovalRow(overrides: Partial<DisplayTitleApprovalSeedRow> = {}): DisplayTitleApprovalSeedRow {
  return {
    tenant_id: TENANT_A.tenantId,
    contentid: IDS.content.pageOne,
    isapproved: 0,
    email: 'reader@example.org',
    siteid: TENANT_A.siteId,
    ...overrides,
  };
}

/** A pending `tcontentpublicsubmissionapprovals` row of tenant-a. */
export function publicSubmissionApprovalRow(overrides: Partial<PublicSubmissionApprovalSeedRow> = {}): PublicSubmissionApprovalSeedRow {
  return {
    tenant_id: TENANT_A.tenantId,
    contentid: IDS.content.pageOne,
    isapproved: 0,
    email: 'submitter@example.org',
    siteid: TENANT_A.siteId,
    ...overrides,
  };
}

/** A live private-pool `group_projection` row of tenant-a. */
export function groupProjectionRow(overrides: Partial<GroupProjectionRow> = {}): GroupProjectionRow {
  return {
    tenant_id: TENANT_A.tenantId,
    group_id: newId(),
    site_id: TENANT_A.siteId,
    group_name: 'Group',
    is_public: 0,
    deleted: false,
    ...overrides,
  };
}

/** A `permission_projection` node verdict of tenant-a; `Read` on the home node by default. */
export function permissionProjectionRow(overrides: Partial<PermissionProjectionRow> = {}): PermissionProjectionRow {
  return {
    tenant_id: TENANT_A.tenantId,
    group_id: newId(),
    site_id: TENANT_A.siteId,
    content_id: IDS.content.root,
    type: 'Read',
    ...overrides,
  };
}

/** A `membership_projection` row of tenant-a. */
export function membershipProjectionRow(overrides: Partial<MembershipProjectionRow> = {}): MembershipProjectionRow {
  return {
    tenant_id: TENANT_A.tenantId,
    user_id: newId(),
    site_id: TENANT_A.siteId,
    group_id: newId(),
    ...overrides,
  };
}


/** One row a loader writes, with the definition of its table. */
export interface SeedRow {
  readonly table: TableDefinition;
  readonly row: RepositoryRow;
}

/** Rows written in the given order, in one tenant transaction. */
export type SeedRows = ReadonlyArray<SeedRow>;

/** The rows stored under one tenant fixture. */
export interface TenantSeed {
  readonly tenant: TenantFixture;
  readonly rows: SeedRows;
}

/** `rows` stored under `tenant`, each stamped with the fixture's tenant id. */
function tenantSeed(tenant: TenantFixture, rows: ReadonlyArray<readonly [TableDefinition, RepositoryRow]>): TenantSeed {
  return Object.freeze({
    tenant,
    rows: Object.freeze(rows.map(([table, row]) => Object.freeze({ table, row: { ...row, tenant_id: tenant.tenantId } }))),
  });
}

type NodeSpec = Partial<ContentSeedRow> & { contentid: string; title: string };

/** The active version of one node and its later unapproved draft, whose title carries ` (draft)`. */
function nodeVersions(
  node: NodeSpec,
  hist: { active: string; draft: string },
  draft: Partial<ContentSeedRow> = {},
): Array<readonly [TableDefinition, ContentSeedRow]> {
  const menutitle = node.menutitle ?? node.title;
  return [
    [CONTENT, contentRow({ ...node, menutitle, contenthistid: hist.active })],
    [
      CONTENT,
      contentRow({
        ...node,
        menutitle,
        contenthistid: hist.draft,
        active: 0,
        approved: 0,
        title: `${node.title} (draft)`,
        lastupdate: at(DRAFT_UPDATED_AT),
        ...draft,
      }),
    ],
  ];
}

/** tenant-a: the content tree with drafts, change sets, approval chain, comments, feeds, form responses, keyless approvals and projections. */
export function tenantASeed(): TenantSeed {
  const { content: c, hist: h, groups: g } = IDS;
  const site = TENANT_A.siteId;
  return tenantSeed(TENANT_A, [
    ...nodeVersions({ contentid: c.root, parentid: IDS.rootParent, title: 'Home', template: 'default.cfm' }, { active: h.rootActive, draft: h.rootDraft }),
    ...nodeVersions(
      { contentid: c.section, type: 'Folder', title: 'Section', filename: 'section', urltitle: 'section', orderno: 1 },
      { active: h.sectionActive, draft: h.sectionDraft },
    ),
    ...nodeVersions(
      {
        contentid: c.pageOne,
        parentid: c.section,
        title: 'Page One',
        filename: 'section/page-one',
        urltitle: 'page-one',
        orderno: 1,
        path: contentPath(c.root, c.section, c.pageOne),
      },
      { active: h.pageOneActive, draft: h.pageOneDraft },
      { changesetid: IDS.changesets.scheduledDue },
    ),
    ...nodeVersions(
      {
        contentid: c.pageTwo,
        parentid: c.section,
        title: 'Page Two',
        filename: 'section/page-two',
        urltitle: 'page-two',
        orderno: 2,
        path: contentPath(c.root, c.section, c.pageTwo),
      },
      { active: h.pageTwoActive, draft: h.pageTwoDraft },
      { changesetid: IDS.changesets.published },
    ),
    ...nodeVersions(
      { contentid: c.restricted, title: 'Restricted', filename: 'restricted', urltitle: 'restricted', orderno: 2, restricted: 1, restrictgroups: 'Editor' },
      { active: h.restrictedActive, draft: h.restrictedDraft },
    ),
    ...nodeVersions(
      { contentid: c.fileNode, type: 'File', title: 'Guide', filename: 'guide', urltitle: 'guide', orderno: 3, fileid: IDS.files.pdf, body: 'guide.pdf' },
      { active: h.fileNodeActive, draft: h.fileNodeDraft },
    ),
    ...nodeVersions(
      { contentid: c.linkNode, type: 'Link', title: 'Example Link', filename: 'example-link', urltitle: 'example-link', orderno: 4, body: 'https://example.org/' },
      { active: h.linkNodeActive, draft: h.linkNodeDraft },
    ),
    ...nodeVersions(
      { contentid: c.formsModule, moduleid: IDS.modules.forms, parentid: IDS.rootParent, type: 'Module', title: 'Forms', orderno: null, path: contentPath(c.formsModule) },
      { active: h.formsModuleActive, draft: h.formsModuleDraft },
    ),
    ...nodeVersions(
      {
        contentid: c.formNode,
        moduleid: IDS.modules.forms,
        parentid: c.formsModule,
        type: 'Form',
        title: 'Contact Form',
        isnav: 0,
        path: contentPath(c.formsModule, c.formNode),
      },
      { active: h.formNodeActive, draft: h.formNodeDraft },
    ),
    [CHANGESET, changesetRow({ changesetid: IDS.changesets.scheduledDue, name: 'Due Release', publishdate: at('2026-06-30T08:00:00') })],
    [CHANGESET, changesetRow({ changesetid: IDS.changesets.scheduledFuture, name: 'Future Release', publishdate: at('2026-07-15T08:00:00') })],
    [
      CHANGESET,
      changesetRow({ changesetid: IDS.changesets.published, name: 'Published Release', published: 1, publishdate: at('2026-06-01T09:00:00') }),
    ],
    [APPROVAL_CHAIN, approvalChainRow({ chainid: IDS.approval.chain, name: 'Content Approval' })],
    [APPROVAL_MEMBERSHIP, approvalMembershipRow({ membershipid: IDS.approval.membershipOne, chainid: IDS.approval.chain, groupid: g.approvers, orderno: 1 })],
    [APPROVAL_MEMBERSHIP, approvalMembershipRow({ membershipid: IDS.approval.membershipTwo, chainid: IDS.approval.chain, groupid: g.editor, orderno: 2 })],
    [APPROVAL_ASSIGNMENT, approvalAssignmentRow({ assignmentid: IDS.approval.assignment, chainid: IDS.approval.chain, contentid: c.section })],
    [
      APPROVAL_REQUEST,
      approvalRequestRow({
        requestid: IDS.approval.request,
        chainid: IDS.approval.chain,
        contenthistid: h.sectionDraft,
        groupid: g.approvers,
        userid: SUBJECT_USER_IDS.editor,
        created: at(DRAFT_UPDATED_AT),
      }),
    ],
    [CATEGORY_ASSIGN, categoryAssignRow({ contenthistid: h.pageOneActive, contentid: c.pageOne, categoryid: IDS.categories.pooledChild })],
    ...pageOneComments(),
    [FEED, feedRow({ feedid: IDS.feeds.local, name: 'Latest News', contentpoolid: '' })],
    [
      FEED,
      feedRow({
        feedid: IDS.feeds.remoteAuto,
        name: 'Remote News',
        type: 'Remote',
        parentid: c.section,
        channellink: 'https://feeds.example.org/opt2.rss',
        autoimport: 1,
      }),
    ],
    [
      FEED,
      feedRow({
        feedid: IDS.feeds.remoteManual,
        name: 'Remote Digest',
        type: 'Remote',
        parentid: c.section,
        channellink: 'https://feeds.example.org/opt2-digest.rss',
        autoimport: 0,
      }),
    ],
    [FORM_RESPONSE_PACKET, formResponsePacketRow({ responseid: IDS.forms.responseOne, data: WDDX_RESPONSE_ONE })],
    [
      FORM_RESPONSE_PACKET,
      formResponsePacketRow({ responseid: IDS.forms.responseTwo, data: WDDX_RESPONSE_TWO, entered: at(`${FORM_ENTERED_ON}T15:00:00`) }),
    ],
    [DISPLAY_TITLE_APPROVAL, displayTitleApprovalRow()],
    [DISPLAY_TITLE_APPROVAL, displayTitleApprovalRow()],
    [DISPLAY_TITLE_APPROVAL, displayTitleApprovalRow({ isapproved: 1, email: 'approved.reader@example.org' })],
    [PUBLIC_SUBMISSION_APPROVAL, publicSubmissionApprovalRow()],
    [PUBLIC_SUBMISSION_APPROVAL, publicSubmissionApprovalRow()],
    [GROUP_PROJECTION, groupProjectionRow({ group_id: g.editor, site_id: site, group_name: 'Editor', is_public: 0 })],
    [GROUP_PROJECTION, groupProjectionRow({ group_id: g.approvers, site_id: site, group_name: 'Content Approvers', is_public: 0 })],
    [PERMISSION_PROJECTION, permissionProjectionRow({ group_id: g.editor, site_id: site, content_id: c.section, type: 'Editor' })],
    [PERMISSION_PROJECTION, permissionProjectionRow({ group_id: g.approvers, site_id: site, content_id: c.section, type: 'Read' })],
    [MEMBERSHIP_PROJECTION, membershipProjectionRow({ user_id: SUBJECT_USER_IDS.editor, site_id: site, group_id: g.editor })],
    [MEMBERSHIP_PROJECTION, membershipProjectionRow({ user_id: SUBJECT_USER_IDS.approver, site_id: site, group_id: g.approvers })],
  ]);
}

/** The four comments on page one: approved, awaiting approval, spam and deleted; spam and deleted are approved, so each flag alone hides them. */
function pageOneComments(): Array<readonly [TableDefinition, CommentRow]> {
  const ids = IDS.comments;
  const comment = (commentid: string, time: string, name: string, overrides: Partial<CommentRow>): readonly [TableDefinition, CommentRow] => [
    COMMENT,
    commentRow({
      commentid,
      contentid: IDS.content.pageOne,
      entered: at(`${COMMENT_ENTERED_ON}T${time}`),
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.org`,
      comments: `${name} on page one.`,
      ...overrides,
    }),
  ];
  return [
    comment(ids.approved, '09:00:00', 'Approved Reader', { isapproved: 1 }),
    comment(ids.unapproved, '10:00:00', 'Pending Reader', { isapproved: 0 }),
    comment(ids.spam, '11:00:00', 'Spam Sender', { isapproved: 1, isspam: 1 }),
    comment(ids.deleted, '12:00:00', 'Deleted Reader', { isapproved: 1, isdeleted: 1 }),
  ];
}

/** umbrella, tenant-a's file and category pool: the pooled categories and the `tfiles` rows with their object manifests. */
export function umbrellaSeed(): TenantSeed {
  const site = TENANT_UMBRELLA.siteId;
  const { pooledParent, pooledChild } = IDS.categories;
  return tenantSeed(TENANT_UMBRELLA, [
    [CATEGORY, categoryRow({ categoryid: pooledParent, siteid: site, name: 'Topics', filename: 'topics', urltitle: 'topics' })],
    [CATEGORY, categoryRow({ categoryid: pooledChild, parentid: pooledParent, siteid: site, name: 'News', filename: 'topics/news', urltitle: 'news' })],
    ...FILE_SPECS.map((spec): readonly [TableDefinition, FileRow] => [
      FILE,
      fileRow({
        fileid: spec.fileid,
        contentid: spec.contentid,
        siteid: site,
        filename: spec.filename,
        filesize: Buffer.byteLength(spec.objects[0]?.payload ?? '', 'utf8'),
        contenttype: spec.contenttype,
        contentsubtype: spec.contentsubtype,
        fileext: spec.fileext,
      }),
    ]),
    ...FILE_SPECS.flatMap((spec) =>
      spec.objects.map((object): readonly [TableDefinition, FileObjectRow] => [
        FILE_OBJECT,
        fileObjectRow({
          tenant_id: TENANT_UMBRELLA.tenantId,
          file_id: spec.fileid,
          variant: object.variant,
          ext: object.ext,
          bytes: Buffer.from(object.payload, 'utf8'),
          content_type: object.contentType,
        }),
      ]),
    ),
  ]);
}

/** tenant-b, which pools nothing: its own home node and one page, each with a draft, and its own category. */
export function tenantBSeed(): TenantSeed {
  const site = TENANT_B.siteId;
  const { content: c, hist: h } = IDS;
  return tenantSeed(TENANT_B, [
    ...nodeVersions({ contentid: c.bRoot, siteid: site, parentid: IDS.rootParent, title: 'Home', template: 'default.cfm' }, { active: h.bRootActive, draft: h.bRootDraft }),
    ...nodeVersions(
      { contentid: c.bPage, siteid: site, title: 'B Page', filename: 'b-page', urltitle: 'b-page', orderno: 1 },
      { active: h.bPageActive, draft: h.bPageDraft },
    ),
    [CATEGORY, categoryRow({ categoryid: IDS.categories.bOwn, siteid: site, name: 'B Topics', filename: 'b-topics', urltitle: 'b-topics' })],
  ]);
}

/** Every dataset in load order: umbrella, tenant-a, tenant-b. */
export function contentSeed(): TenantSeed[] {
  return [umbrellaSeed(), tenantASeed(), tenantBSeed()];
}

/** A throwaway copy of schema `content` the loaders write into. */
export type SeedHandle = Pick<ThrowawaySchema, 'app' | 'schema'>;

const SEED_CONTEXT: WriteContext = Object.freeze({ origin: 'backfill', actorService: 'platform.migration', requestId: 'seed' });

/** Seeds the three fixture sites into the handle's `tenant_registry`. */
export async function seedTenantRegistry(handle: SeedHandle): Promise<void> {
  await seedRegistry(handle.app, handle.schema);
}

/** Opens the content gates, then inserts `rows` in order through the content repository in one `tenant` transaction; returns the stored rows. */
export async function seedRows(handle: SeedHandle, tenant: TenantFixture, rows: SeedRows): Promise<RepositoryRow[]> {
  await openContentGates(handle);
  const repository = createContentRepository({ clock: TEST_CLOCK, schema: handle.schema });
  return withTenant(handle.app, tenant.tenantId, async (tx) => {
    const stored: RepositoryRow[] = [];
    for (const { table, row } of rows) {
      stored.push(await repository.platform.insert(tx, table.table, row, SEED_CONTEXT));
    }
    return stored;
  });
}

/** Seeds the registry, then every {@link contentSeed} dataset in order; returns the datasets written. */
export async function seedAll(handle: SeedHandle): Promise<TenantSeed[]> {
  const seeds = contentSeed();
  await seedTenantRegistry(handle);
  for (const seed of seeds) {
    await seedRows(handle, seed.tenant, seed.rows);
  }
  return seeds;
}

// First value of every content IDENTITY column (0008_identity_ranges.sql).
const IDENTITY_START = -2_147_483_648;
const IDENTITY_OF: ReadonlyMap<string, string> = new Map(Object.entries(IDENTITY_COLUMNS));
const KEYLESS_MANAGED: ReadonlySet<string> = new Set(['tenant_id', 'legacy_row_hash', 'occurrence']);

/** Rows of `seeds` by table, then tenant id, as a fresh schema stores them: identity columns numbered in load order, keyless rows hashed and counted. */
function storedSeedRows(seeds: readonly TenantSeed[]): Map<string, Map<string, RepositoryRow[]>> {
  const byTable = new Map<string, Map<string, RepositoryRow[]>>();
  const nextIdentity = new Map<string, number>();
  const occurrences = new Map<string, number>();
  for (const { tenant, rows } of seeds) {
    for (const { table, row } of rows) {
      const stored: RepositoryRow = { ...row };
      const identity = IDENTITY_OF.get(table.table);
      if (identity !== undefined && stored[identity] === undefined) {
        const value = nextIdentity.get(table.table) ?? IDENTITY_START;
        stored[identity] = value;
        nextIdentity.set(table.table, value + 1);
      }
      if (table.key === null) {
        const hash = legacyRowHash(table.columns.filter((column) => !KEYLESS_MANAGED.has(column.name)), stored);
        const occurrenceKey = `${table.table}/${tenant.tenantId}/${hash}`;
        const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
        occurrences.set(occurrenceKey, occurrence);
        Object.assign(stored, { legacy_row_hash: hash, occurrence });
      }
      const byTenant = byTable.get(table.table) ?? new Map<string, RepositoryRow[]>();
      byTable.set(table.table, byTenant);
      const tenantRows = byTenant.get(tenant.tenantId) ?? [];
      byTenant.set(tenant.tenantId, tenantRows);
      tenantRows.push(stored);
    }
  }
  return byTable;
}

/** A non-locking SELECT naming `content.<table>`, quoted or not; writes and `FOR UPDATE`/`FOR SHARE` reads fall through to the recording pool. */
function seedReadPattern(table: string): RegExp {
  return new RegExp(`^SELECT\\b(?!.*\\bFOR (?:NO KEY )?(?:UPDATE|SHARE|KEY SHARE)\\b).*"?\\bcontent"?\\."?${table}\\b`, 'i');
}

/** Answers each non-locking SELECT of a seeded table with every seeded row of that table under the transaction's tenant; gates stay open. */
export function seedRecordingDb(db: RecordingDb, seeds: readonly TenantSeed[] = contentSeed()): void {
  for (const [table, byTenant] of storedSeedRows(seeds)) {
    db.respond(seedReadPattern(table), (_params, _sql, ctx) =>
      ctx.tenantId === null ? [] : (byTenant.get(ctx.tenantId.toLowerCase()) ?? []).map((row) => ({ ...row })),
    );
  }
}

/** Stores every {@link FILE_BYTES} object in `storage` without recording a call. */
export function seedMemoryStorage(storage: MemoryStorage): void {
  for (const [key, object] of Object.entries(FILE_BYTES)) {
    storage.preload(key, object.bytes, object.contentType);
  }
}

