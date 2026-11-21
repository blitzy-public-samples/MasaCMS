import type { components } from '@/generated/clients/strategies-content';
import type { GatewayResponse } from '@/lib/gateway-client';
import { TENANT_A } from '@opt2/platform/testing';
import { USER_IDS } from '../session';
import { CONTENT_HIST_IDS, CONTENT_IDS } from './carch';

type AdminViewModel = components['schemas']['AdminViewModel'];

export const APPROVAL_GROUP_IDS = Object.freeze({
  contentEditors: '5C000000-0008-4000-8000000000000001',
  contentPublishers: '5C000000-0008-4000-8000000000000002',
  marketing: '5C000000-0008-4000-8000000000000003',
} as const);

export const APPROVAL_CHAIN_IDS = Object.freeze({
  standard: '5C000000-0007-4000-8000000000000001',
} as const);

export const NEW_APPROVAL_CHAIN_ID = '5C000000-0007-4000-8000000000000002';

export const APPROVAL_REQUEST_IDS = Object.freeze({
  pending: '5C000000-0009-4000-8000000000000001',
  approved: '5C000000-0009-4000-8000000000000002',
  rejected: '5C000000-0009-4000-8000000000000003',
} as const);

const SITE = TENANT_A.siteId;
const WEB_PATH = `http://${SITE}.localhost:8100`;
const ROOT_ID = '00000000000000000000000000000000001';
const END_ID = '00000000000000000000000000000000END';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
// Kept clear of the ids ./changesets assigns, which this file cannot import.
const REVIEW_CHANGESET_ID = '5C000000-0003-4000-8000000000000010';
const REVIEW_CHANGESET_NAME = 'Q3 Content Review';

export const CCHAIN_PATHS = Object.freeze({
  list: `/v1/sites/${SITE}/approval-chains`,
  edit: `/v1/sites/${SITE}/approval-chains/${APPROVAL_CHAIN_IDS.standard}`,
  editNew: `/v1/sites/${SITE}/approval-chains/${NEW_APPROVAL_CHAIN_ID}`,
  pending: `/v1/sites/${SITE}/approval-chains/${APPROVAL_CHAIN_IDS.standard}/pending`,
  save: `/v1/sites/${SITE}/approval-chains`,
  delete: `/v1/sites/${SITE}/approval-chains/${APPROVAL_CHAIN_IDS.standard}/delete`,
  statusModal: '/v1/raw/carch/statusmodal',
} as const);

const STANDARD_CHAIN_VALUES = Object.freeze({
  chainID: APPROVAL_CHAIN_IDS.standard,
  siteID: SITE,
  name: 'Standard Publishing',
  description: 'Two-step review for public pages: content editors first, then content publishers.',
  created: '2026-05-12T09:00:00.000',
  lastupdate: '2026-06-30T10:15:00.000',
  lastupdateby: 'Admin User',
  lastupdatebyid: USER_IDS.admin,
});

const STANDARD_CHAIN_BEAN = Object.freeze({
  ...STANDARD_CHAIN_VALUES,
  isNew: false,
  errors: Object.freeze({}),
});

const CONTENT_EDITORS_MEMBERSHIP = Object.freeze({
  groupID: APPROVAL_GROUP_IDS.contentEditors,
  orderNo: 1,
  groupName: 'Content Editors',
});

const CONTENT_PUBLISHERS_MEMBERSHIP = Object.freeze({
  groupID: APPROVAL_GROUP_IDS.contentPublishers,
  orderNo: 2,
  groupName: 'Content Publishers',
});

const CONTENT_EDITORS_GROUP = Object.freeze({
  userID: APPROVAL_GROUP_IDS.contentEditors,
  groupName: 'Content Editors',
  siteID: SITE,
  isPublic: 0,
});

const CONTENT_PUBLISHERS_GROUP = Object.freeze({
  userID: APPROVAL_GROUP_IDS.contentPublishers,
  groupName: 'Content Publishers',
  siteID: SITE,
  isPublic: 0,
});

const MARKETING_GROUP = Object.freeze({
  userID: APPROVAL_GROUP_IDS.marketing,
  groupName: 'Marketing Reviewers',
  siteID: SITE,
  isPublic: 0,
});

const ABOUT_US_CRUMBS = Object.freeze([
  Object.freeze({
    contentid: CONTENT_IDS.aboutUs,
    contenthistid: CONTENT_HIST_IDS.aboutUs,
    siteid: SITE,
    moduleid: SITE_MANAGER_MODULE,
    parentid: ROOT_ID,
    type: 'Page',
    subtype: 'Default',
    menutitle: 'About Us',
    filename: 'about-us',
    restricted: 0,
    icon: 'mi-file',
  }),
  Object.freeze({
    contentid: ROOT_ID,
    contenthistid: CONTENT_HIST_IDS.home,
    siteid: SITE,
    moduleid: SITE_MANAGER_MODULE,
    parentid: END_ID,
    type: 'Page',
    subtype: 'Default',
    menutitle: 'Home',
    filename: '',
    restricted: 0,
    icon: 'mi-file',
  }),
]);

const ABOUT_US_PENDING_REQUEST = Object.freeze({
  requestID: APPROVAL_REQUEST_IDS.pending,
  created: '2026-06-30T09:45:00.000',
  contentID: CONTENT_IDS.aboutUs,
  contentHistID: CONTENT_HIST_IDS.aboutUsDraft,
  siteID: SITE,
  moduleID: SITE_MANAGER_MODULE,
  parentID: ROOT_ID,
  title: 'About Us',
  menuTitle: 'About Us',
  summary: '<p>Who we are and how our programs serve the community.</p>',
  type: 'Page',
  subType: 'Default',
  filename: 'about-us',
  fileID: '',
  changesetID: REVIEW_CHANGESET_ID,
  lastUpdate: '2026-06-30T09:40:00.000',
  lastUpdateBy: 'Quinn Editor',
  lastUpdateByID: USER_IDS.qaEditor,
  changesetName: REVIEW_CHANGESET_NAME,
  changesetPublishDate: '2026-07-15T09:00:00.000',
  previewURL: `${WEB_PATH}/about-us/?previewid=${CONTENT_HIST_IDS.aboutUsDraft}`,
  crumbArray: ABOUT_US_CRUMBS,
});

export const cchainListData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    siteid: SITE,
    chains: Object.freeze([STANDARD_CHAIN_VALUES]),
  }),
});

export const cchainEditData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    siteid: SITE,
    chainid: APPROVAL_CHAIN_IDS.standard,
    chain: STANDARD_CHAIN_BEAN,
    availableGroups: Object.freeze([MARKETING_GROUP]),
    memberships: Object.freeze([CONTENT_EDITORS_MEMBERSHIP, CONTENT_PUBLISHERS_MEMBERSHIP]),
  }),
});

export const cchainEditNewData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    siteid: SITE,
    chainid: NEW_APPROVAL_CHAIN_ID,
    chain: Object.freeze({
      chainID: NEW_APPROVAL_CHAIN_ID,
      siteID: '',
      name: '',
      description: '',
      created: '2026-06-30T12:00:00.000',
      lastupdate: '2026-06-30T12:00:00.000',
      lastupdateby: 'Admin User',
      lastupdatebyid: USER_IDS.admin,
      isNew: true,
      errors: Object.freeze({}),
    }),
    availableGroups: Object.freeze([CONTENT_EDITORS_GROUP, CONTENT_PUBLISHERS_GROUP, MARKETING_GROUP]),
    memberships: Object.freeze([]),
  }),
});

export const cchainPendingData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    siteid: SITE,
    chainid: APPROVAL_CHAIN_IDS.standard,
    chain: STANDARD_CHAIN_BEAN,
    hasChangesets: true,
    members: Object.freeze([
      Object.freeze({ ...CONTENT_EDITORS_MEMBERSHIP, requests: Object.freeze([ABOUT_US_PENDING_REQUEST]) }),
      Object.freeze({ ...CONTENT_PUBLISHERS_MEMBERSHIP, requests: Object.freeze([]) }),
    ]),
  }),
});

const STATUS_MODAL_HEAD = Object.freeze([
  '',
  '<div id="status-modal" class="mura-list-grid">',
  '\t<dl>',
  '\t\t<dt>Created By</dt> ',
  '\t\t<dd>',
  '\t\t\t<i class="mi-user"></i>',
  '\t\t\t<p>Quinn Editor </p>',
  '\t\t</dd>',
  '\t</dl>',
  '\t',
  '\t<dl class="created-on">',
  '\t\t<dt>Created On</dt>',
  '\t\t<dd>',
  '\t\t\t<i class="mi-calendar"></i>',
  '\t\t\t<p>06/181/2026<br />',
  '\t\t\t9:40 AM</p>',
  '\t\t</dd>',
  '\t</dl>',
  '\t',
  '\t<dl>',
  '\t\t<dt>Status</dt>',
  '\t\t<dd>\t',
  '\t\t\t',
]);

const STATUS_MODAL_CHANGESET_OPEN = Object.freeze([
  '\t\t\t',
  '\t\t</dd>',
  '\t</dl>',
  '\t\t',
  '\t',
  '\t\t',
  '\t\t<dl class="change-set">',
  '\t\t\t<dt>Change Set</dt>',
  '\t\t\t<dd>',
  '\t\t\t\t<i class="mi-list-alt"></i>',
]);

const STATUS_MODAL_CHANGESET_CLOSE = Object.freeze(['\t\t\t</dd>', '\t\t</dl>', '\t\t']);

const STATUS_MODAL_ACTIONS_OPEN = Object.freeze([
  '\t\t\t<dl class="approval-chain-comments">',
  '\t\t\t\t<dt>Actions</dt>',
  '\t\t\t\t',
]);

const STATUS_MODAL_ACTIONS_CLOSE = Object.freeze(['\t\t\t', '\t\t\t</dl>', '\t\t\t']);

const STATUS_MODAL_TAIL = Object.freeze(['</div>', '', '']);

const FRAGMENT_HEADERS = Object.freeze({ 'content-type': 'text/html;charset=UTF-8' } as const);

export const statusModalPending = {
  status: 200,
  ok: true,
  headers: FRAGMENT_HEADERS,
  body: [
    ...STATUS_MODAL_HEAD,
    '\t\t\t\t<i class="mi-clock-o"></i>',
    '\t\t\t\t<p>Pending Approval</p>',
    ...STATUS_MODAL_CHANGESET_OPEN,
    `\t\t\t\t<p>${REVIEW_CHANGESET_NAME}</p>`,
    ...STATUS_MODAL_CHANGESET_CLOSE,
    '\t\t\t<dl class="approval-status">',
    '\t\t\t\t<dt>Approval Status</dt>',
    '\t\t\t\t<dd>',
    '\t\t\t\t\t<i class="mi-clock-o"></i>',
    '\t\t\t\t\t ',
    '\t\t\t\t\t\t<em>Waiting for Group:</em>',
    '\t\t\t\t\t\t<p>Content Editors</p>',
    '\t\t\t\t\t',
    '\t\t\t\t</dd>',
    '\t\t\t</dl>',
    '\t\t\t',
    '\t\t\t\t<dl class="approval-action-form">',
    '\t\t\t\t<dt>Action</dt>',
    '\t\t\t\t<dd>',
    '\t\t\t\t\t<div class="mura-control-group">',
    '\t\t\t\t\t\t',
    '\t\t\t\t\t\t<label class="radio inline">',
    '\t\t\t\t\t\t\t<input class="approval-action" id="approval-approve" name="approval-action"type="radio" value="Approve" checked/> Approve ',
    '\t\t\t\t\t\t</label>',
    '\t\t\t\t\t\t<label class="radio inline">',
    '\t\t\t\t\t\t\t<input class="approval-action" id="approval-reject" name="approval-action" type="radio" value="Reject" checked/> Reject',
    '\t\t\t\t\t\t</label>',
    '\t\t\t\t\t\t',
    '\t\t\t\t\t</div>\t\t\t\t\t',
    '\t\t\t\t<p>Comments (Required for Rejection)</p>',
    '\t\t\t\t<textarea id="approval-comments" rows="4"></textarea>',
    '\t\t\t\t\t<div class="form-actions">\t\t\t\t\t',
    `\t\t\t\t\t<input id="mura-approval-apply" type="button" class="btn mura-primary" value="Apply" onclick="applyApprovalAction('${APPROVAL_REQUEST_IDS.pending}',$('input:radio[name=approval-action]:checked').val(),$('#approval-comments').val(),'tenant\\x2Da');"/>`,
    '\t\t\t\t\t</div>',
    '\t\t\t\t</dd>',
    '\t\t\t\t</dl>',
    '\t\t\t',
    ...STATUS_MODAL_TAIL,
  ].join('\n'),
  setCookies: [],
} as const satisfies GatewayResponse<string>;

export const statusModalApproved = {
  status: 200,
  ok: true,
  headers: FRAGMENT_HEADERS,
  body: [
    ...STATUS_MODAL_HEAD,
    '\t\t\t\t<i class="mi-check-circle"></i>',
    '\t\t\t\t<p>Published</p>',
    ...STATUS_MODAL_CHANGESET_OPEN,
    '\t\t\t\t<p>Unassigned</p>',
    ...STATUS_MODAL_CHANGESET_CLOSE,
    ...STATUS_MODAL_ACTIONS_OPEN,
    '\t\t\t',
    '\t\t\t\t<dd>',
    '\t\t\t\t\t<strong class="approved">',
    '\t\t\t\t\t<i class="mi-check-circle"></i> Approved</strong> ',
    '\t\t\t\t\t',
    '\t\t\t\t\t<em>by Tessa Admin on 06/181/2026 at 11:00 AM</em>\t\t',
    '\t\t\t\t</dd>',
    '\t\t\t',
    '\t\t\t',
    '\t\t\t',
    '\t\t\t\t<dd>',
    '\t\t\t\t\t<strong class="approved">',
    '\t\t\t\t\t<i class="mi-check-circle"></i> Approved</strong> ',
    '\t\t\t\t\t',
    '\t\t\t\t\t<em>by Admin User on 06/181/2026 at 2:30 PM</em>\t\t',
    '\t\t\t\t</dd>',
    '\t\t\t',
    ...STATUS_MODAL_ACTIONS_CLOSE,
    ...STATUS_MODAL_TAIL,
  ].join('\n'),
  setCookies: [],
} as const satisfies GatewayResponse<string>;

export const statusModalRejected = {
  status: 200,
  ok: true,
  headers: FRAGMENT_HEADERS,
  body: [
    ...STATUS_MODAL_HEAD,
    '\t\t\t\t<i class="mi-clock-o"></i>',
    '\t\t\t\t<p>Rejected</p>',
    ...STATUS_MODAL_CHANGESET_OPEN,
    `\t\t\t\t<p>${REVIEW_CHANGESET_NAME}</p>`,
    ...STATUS_MODAL_CHANGESET_CLOSE,
    ...STATUS_MODAL_ACTIONS_OPEN,
    '\t\t\t',
    '\t\t\t\t<dd>',
    '\t\t\t\t\t<strong class="rejected">',
    '\t\t\t\t\t<i class="mi-warning"></i> Rejected</strong> ',
    '\t\t\t\t\t<p>Please shorten the summary before publishing.</p>',
    '\t\t\t\t\t<em>by Admin User on 06/181/2026 at 3:10 PM</em>\t\t',
    '\t\t\t\t</dd>',
    '\t\t\t',
    ...STATUS_MODAL_ACTIONS_CLOSE,
    ...STATUS_MODAL_TAIL,
  ].join('\n'),
  setCookies: [],
} as const satisfies GatewayResponse<string>;
