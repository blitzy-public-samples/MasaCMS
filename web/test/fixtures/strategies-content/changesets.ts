import type { components } from '@/generated/clients/strategies-content';
import { TENANT_A } from '@opt2/platform/testing';
import { USER_IDS } from '../session';
import { CONTENT_HIST_IDS, CONTENT_IDS } from './carch';
import { CATEGORY_IDS, INTEREST_CATEGORY_IDS } from './categories';

type AdminViewModel = components['schemas']['AdminViewModel'];

export const CHANGESET_IDS = Object.freeze({
  open: '5C000000-0003-4000-8000000000000001',
  scheduled: '5C000000-0003-4000-8000000000000002',
  published: '5C000000-0003-4000-8000000000000003',
  newSet: '5C000000-0003-4000-8000000000000004',
} as const);

const SITE = TENANT_A.siteId;
const WEB_PATH = `http://${SITE}.localhost:8100`;
const ROOT_ID = '00000000000000000000000000000000001';
const END_ID = '00000000000000000000000000000000END';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const FORMS_MODULE = '00000000000000000000000000000000004';

// The contract serves the cchangesets screens from these operation paths; it names no `/cchangesets/<action>` path.
export const CCHANGESETS_PATHS = Object.freeze({
  list: `/v1/sites/${SITE}/changesets`,
  save: `/v1/sites/${SITE}/changesets`,
  editOpen: `/v1/sites/${SITE}/changesets/${CHANGESET_IDS.open}`,
  editScheduled: `/v1/sites/${SITE}/changesets/${CHANGESET_IDS.scheduled}`,
  editPublished: `/v1/sites/${SITE}/changesets/${CHANGESET_IDS.published}`,
  assignments: `/v1/sites/${SITE}/changesets/${CHANGESET_IDS.scheduled}/assignments`,
} as const);

const previewLink = (changesetId: string): string => `${WEB_PATH}/?changesetID=${changesetId}`;

const CATEGORY_ROWS = Object.freeze([
  { categoryID: CATEGORY_IDS.topics, parentID: '', name: 'General Topics', isOpen: true, permitted: true },
  { categoryID: CATEGORY_IDS.topicsNews, parentID: CATEGORY_IDS.topics, name: 'Agency News', isOpen: true, permitted: true },
  { categoryID: CATEGORY_IDS.topicsEvents, parentID: CATEGORY_IDS.topics, name: 'Events', isOpen: true, permitted: true },
  {
    categoryID: CATEGORY_IDS.topicsEventsLocal,
    parentID: CATEGORY_IDS.topicsEvents,
    name: 'Local Events',
    isOpen: true,
    permitted: true,
  },
  { categoryID: INTEREST_CATEGORY_IDS.interests, parentID: '', name: 'Interests', isOpen: false, permitted: true },
  {
    categoryID: INTEREST_CATEGORY_IDS.newsletter,
    parentID: INTEREST_CATEGORY_IDS.interests,
    name: 'Newsletter',
    isOpen: true,
    permitted: true,
  },
  {
    categoryID: INTEREST_CATEGORY_IDS.volunteering,
    parentID: INTEREST_CATEGORY_IDS.interests,
    name: 'Outreach Volunteering',
    isOpen: true,
    permitted: true,
  },
  {
    categoryID: INTEREST_CATEGORY_IDS.training,
    parentID: INTEREST_CATEGORY_IDS.interests,
    name: 'Skills Training',
    isOpen: true,
    permitted: true,
  },
  { categoryID: CATEGORY_IDS.inactiveArchive, parentID: '', name: 'Legacy Archive', isOpen: true, permitted: true },
  { categoryID: CATEGORY_IDS.restricted, parentID: '', name: 'Restricted Notices', isOpen: true, permitted: false },
]);

/** The category rows under `parentID` as nested nodes, each with its `children`. */
const categoryNodes = (parentID: string): readonly Readonly<Record<string, unknown>>[] =>
  Object.freeze(
    CATEGORY_ROWS.filter((row) => row.parentID === parentID).map((row) =>
      Object.freeze({ ...row, children: categoryNodes(row.categoryID) }),
    ),
  );

const CATEGORY_COUNT = CATEGORY_ROWS.length;

const OPEN_BEAN = Object.freeze({
  changesetID: CHANGESET_IDS.open,
  siteID: SITE,
  name: 'Summer Refresh',
  description: '',
  created: '2026-06-15T09:00:00.000',
  publishDate: '',
  published: 0,
  lastUpdate: '2026-06-29T16:20:00.000',
  lastUpdateBy: 'Admin User',
  lastUpdateByID: USER_IDS.admin,
  remoteID: '',
  remoteSourceURL: '',
  remotePubDate: '',
  closeDate: '',
  categoryID: CATEGORY_IDS.topicsNews,
  tags: 'refresh,summer',
  isNew: 0,
  errors: Object.freeze({}),
});

const SCHEDULED_BEAN = Object.freeze({
  changesetID: CHANGESET_IDS.scheduled,
  siteID: SITE,
  name: 'Autumn Launch',
  description: 'Launch pages, banner and contact form for the autumn program intake.',
  created: '2026-06-20T11:00:00.000',
  publishDate: '2026-07-15T09:00:00.000',
  published: 0,
  lastUpdate: '2026-06-30T10:45:00.000',
  lastUpdateBy: 'Tessa Admin',
  lastUpdateByID: USER_IDS.tenantASiteAdmin,
  remoteID: '',
  remoteSourceURL: '',
  remotePubDate: '',
  closeDate: '',
  categoryID: `${CATEGORY_IDS.topicsEvents},${CATEGORY_IDS.topicsEventsLocal}`,
  tags: 'autumn,launch',
  isNew: 0,
  errors: Object.freeze({}),
});

const PUBLISHED_BEAN = Object.freeze({
  changesetID: CHANGESET_IDS.published,
  siteID: SITE,
  name: 'Spring Cleanup',
  description: 'Retired the spring program notices.',
  created: '2026-04-20T10:00:00.000',
  publishDate: '2026-05-01T08:00:00.000',
  published: 1,
  lastUpdate: '2026-06-28T14:30:00.000',
  lastUpdateBy: 'Admin User',
  lastUpdateByID: USER_IDS.admin,
  remoteID: '',
  remoteSourceURL: '',
  remotePubDate: '',
  closeDate: '',
  categoryID: '',
  tags: 'cleanup',
  isNew: 0,
  errors: Object.freeze({}),
});

export const cchangesetsListData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    startrow: '1',
    keywords: '',
    tags: '',
    changesets: Object.freeze({
      pageIndex: 1,
      pageCount: 1,
      recordCount: 3,
      firstRecordOnPageIndex: 1,
      lastRecordOnPageIndex: 3,
      items: Object.freeze([
        Object.freeze({ ...OPEN_BEAN, previewURL: previewLink(CHANGESET_IDS.open) }),
        Object.freeze({ ...SCHEDULED_BEAN, previewURL: previewLink(CHANGESET_IDS.scheduled) }),
        Object.freeze({ ...PUBLISHED_BEAN, previewURL: '' }),
      ]),
    }),
    categoryCount: CATEGORY_COUNT,
    categories: categoryNodes(''),
  }),
});

export const cchangesetsEditOpen: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    changeset: OPEN_BEAN,
    hasPendingApprovals: 0,
    categoryCount: CATEGORY_COUNT,
    categories: CATEGORY_ROWS,
    previewLink: previewLink(CHANGESET_IDS.open),
  }),
});

export const cchangesetsEditScheduled: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    changeset: SCHEDULED_BEAN,
    hasPendingApprovals: 0,
    categoryCount: CATEGORY_COUNT,
    categories: CATEGORY_ROWS,
    previewLink: previewLink(CHANGESET_IDS.scheduled),
  }),
});

export const cchangesetsEditPublished: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    changeset: PUBLISHED_BEAN,
    categoryCount: CATEGORY_COUNT,
    categories: CATEGORY_ROWS,
  }),
});

export const cchangesetsEditNew: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    changeset: Object.freeze({
      changesetID: CHANGESET_IDS.newSet,
      siteID: '',
      name: '',
      description: '',
      created: '2026-06-30T12:00:00.000',
      publishDate: '',
      published: 0,
      lastUpdate: '2026-06-30T12:00:00.000',
      lastUpdateBy: 'Admin User',
      lastUpdateByID: USER_IDS.admin,
      remoteID: '',
      remoteSourceURL: '',
      remotePubDate: '',
      closeDate: '',
      categoryID: '',
      tags: '',
      isNew: 1,
      errors: Object.freeze({}),
    }),
    hasPendingApprovals: 0,
    categoryCount: CATEGORY_COUNT,
    categories: CATEGORY_ROWS,
  }),
});

const HOME_CRUMB = Object.freeze({
  contentid: ROOT_ID,
  siteid: SITE,
  moduleid: SITE_MANAGER_MODULE,
  parentid: END_ID,
  type: 'Page',
  subtype: 'Default',
  menutitle: 'Home',
  filename: '',
  restricted: 0,
  icon: 'mi-file',
});

const ABOUT_US_CRUMB = Object.freeze({
  contentid: CONTENT_IDS.aboutUs,
  siteid: SITE,
  moduleid: SITE_MANAGER_MODULE,
  parentid: ROOT_ID,
  type: 'Page',
  subtype: 'Default',
  menutitle: 'About Us',
  filename: 'about-us',
  restricted: 0,
  icon: 'mi-file',
});

const NEWS_CRUMB = Object.freeze({
  contentid: CONTENT_IDS.news,
  siteid: SITE,
  moduleid: SITE_MANAGER_MODULE,
  parentid: ROOT_ID,
  type: 'Folder',
  subtype: 'Default',
  menutitle: 'News',
  filename: 'news',
  restricted: 0,
  icon: 'mi-folder-open-o',
});

const NEWS_ARTICLE_CRUMB = Object.freeze({
  contentid: CONTENT_IDS.newsArticle,
  siteid: SITE,
  moduleid: SITE_MANAGER_MODULE,
  parentid: CONTENT_IDS.news,
  type: 'Page',
  subtype: 'Default',
  menutitle: 'Program Update',
  filename: 'news/program-update',
  restricted: 0,
  icon: 'mi-file',
});

const COMPONENTS_CRUMB = Object.freeze({
  contentid: COMPONENTS_MODULE,
  siteid: SITE,
  moduleid: COMPONENTS_MODULE,
  parentid: END_ID,
  type: 'Module',
  subtype: 'Default',
  menutitle: 'Components',
  filename: '',
  restricted: 0,
  icon: 'mi-cog',
});

const HOME_BANNER_CRUMB = Object.freeze({
  contentid: CONTENT_IDS.homeBanner,
  siteid: SITE,
  moduleid: COMPONENTS_MODULE,
  parentid: COMPONENTS_MODULE,
  type: 'Component',
  subtype: 'Default',
  menutitle: 'Home Banner',
  filename: '',
  restricted: 0,
  icon: 'mi-align-justify',
});

const FORMS_CRUMB = Object.freeze({
  contentid: FORMS_MODULE,
  siteid: SITE,
  moduleid: FORMS_MODULE,
  parentid: END_ID,
  type: 'Module',
  subtype: 'Default',
  menutitle: 'Forms',
  filename: '',
  restricted: 0,
  icon: 'mi-cog',
});

const CONTACT_FORM_CRUMB = Object.freeze({
  contentid: CONTENT_IDS.contactForm,
  siteid: SITE,
  moduleid: FORMS_MODULE,
  parentid: FORMS_MODULE,
  type: 'Form',
  subtype: 'Default',
  menutitle: 'Contact Us Form',
  filename: '',
  restricted: 0,
  icon: 'mi-toggle-on',
});

const ASSIGNMENT_ROW_DEFAULTS = Object.freeze({
  siteid: SITE,
  fileid: null,
  subtype: 'Default',
  lastupdateby: 'Tessa Admin',
  lastupdatebyid: USER_IDS.tenantASiteAdmin,
  active: 0,
  approved: 0,
  display: 1,
  displaystart: null,
  displaystop: null,
  isnav: 1,
  notes: '',
  isfeature: 0,
  inheritobjects: 'Inherit',
  targetparams: '',
  releasedate: null,
  changesetid: CHANGESET_IDS.scheduled,
  remoteid: '',
  remoteurl: '',
  approvalstatus: null,
  requestid: null,
  verdict: 'editor',
});

export const cchangesetsAssignmentsData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    changeset: SCHEDULED_BEAN,
    hasPendingApprovals: 0,
    previewLink: previewLink(CHANGESET_IDS.scheduled),
    siteAssignments: Object.freeze([
      Object.freeze({
        ...ASSIGNMENT_ROW_DEFAULTS,
        menutitle: 'About Us',
        title: 'About Us',
        parentid: ROOT_ID,
        path: `'${ROOT_ID}','${CONTENT_IDS.aboutUs}'`,
        contentid: CONTENT_IDS.aboutUs,
        contenthistid: CONTENT_HIST_IDS.aboutUsDraft,
        type: 'Page',
        lastupdate: '2026-06-30T10:30:00.000',
        moduleid: SITE_MANAGER_MODULE,
        filename: 'about-us',
        urltitle: 'about-us',
        previewURL: `${WEB_PATH}/about-us/?previewid=${CONTENT_HIST_IDS.aboutUsDraft}`,
        crumbdata: Object.freeze([ABOUT_US_CRUMB, HOME_CRUMB]),
      }),
      Object.freeze({
        ...ASSIGNMENT_ROW_DEFAULTS,
        menutitle: 'Program Update',
        title: 'Program Update',
        parentid: CONTENT_IDS.news,
        path: `'${ROOT_ID}','${CONTENT_IDS.news}','${CONTENT_IDS.newsArticle}'`,
        contentid: CONTENT_IDS.newsArticle,
        contenthistid: CONTENT_HIST_IDS.newsArticleDraft,
        type: 'Page',
        lastupdate: '2026-06-30T10:35:00.000',
        moduleid: SITE_MANAGER_MODULE,
        filename: 'news/program-update',
        urltitle: 'program-update',
        previewURL: `${WEB_PATH}/news/program-update/?previewid=${CONTENT_HIST_IDS.newsArticleDraft}`,
        crumbdata: Object.freeze([NEWS_ARTICLE_CRUMB, NEWS_CRUMB, HOME_CRUMB]),
      }),
    ]),
    componentAssignments: Object.freeze([
      Object.freeze({
        ...ASSIGNMENT_ROW_DEFAULTS,
        menutitle: 'Home Banner',
        title: 'Home Banner',
        parentid: COMPONENTS_MODULE,
        path: `'${COMPONENTS_MODULE}','${CONTENT_IDS.homeBanner}'`,
        contentid: CONTENT_IDS.homeBanner,
        contenthistid: CONTENT_HIST_IDS.homeBanner,
        type: 'Component',
        lastupdate: '2026-06-30T10:40:00.000',
        moduleid: COMPONENTS_MODULE,
        isnav: 0,
        filename: null,
        urltitle: 'home-banner',
        crumbdata: Object.freeze([HOME_BANNER_CRUMB, COMPONENTS_CRUMB]),
      }),
    ]),
    formAssignments: Object.freeze([
      Object.freeze({
        ...ASSIGNMENT_ROW_DEFAULTS,
        menutitle: 'Contact Us Form',
        title: 'Contact Us Form',
        parentid: FORMS_MODULE,
        path: `'${FORMS_MODULE}','${CONTENT_IDS.contactForm}'`,
        contentid: CONTENT_IDS.contactForm,
        contenthistid: CONTENT_HIST_IDS.contactForm,
        type: 'Form',
        lastupdate: '2026-06-30T10:42:00.000',
        moduleid: FORMS_MODULE,
        isnav: 0,
        filename: null,
        urltitle: 'contact-us-form',
        crumbdata: Object.freeze([CONTACT_FORM_CRUMB, FORMS_CRUMB]),
      }),
    ]),
    // configBean `variations` is off, as Masa defaults it, so assignments() sets no variationAssignments.
  }),
});
