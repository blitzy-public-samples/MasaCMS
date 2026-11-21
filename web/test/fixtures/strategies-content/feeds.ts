import type { components } from '@/generated/clients/strategies-content';
import { TENANT_A } from '@opt2/platform/testing';
import { CONTENT_HIST_IDS, CONTENT_IDS } from './carch';
import { CATEGORY_IDS, INTEREST_CATEGORY_IDS } from './categories';

type AdminViewModel = components['schemas']['AdminViewModel'];

export const FEED_IDS = Object.freeze({
  localIndex: '5C000000-0006-4000-8000000000000001',
  remoteRss: '5C000000-0006-4000-8000000000000002',
  newFeed: '5C000000-0006-4000-8000000000000003',
} as const);

const ADVANCED_PARAM_IDS = Object.freeze({
  titleContains: '5C000000-000F-4000-8000000000000001',
  releasedSince: '5C000000-000F-4000-8000000000000002',
} as const);

const PROGRAM_CODE_ATTRIBUTE_ID = '5C000000-0010-4000-8000000000000002';

const RESTRICT_GROUP_IDS = Object.freeze({
  communityMembers: '6A000000-0000-0000-0000000000005C01',
  restrictedReaders: '6A000000-0000-0000-0000000000005C02',
  contentEditors: '6A000000-0000-0000-0000000000005C03',
  programStaff: '6A000000-0000-0000-0000000000005C04',
} as const);

const SITE = TENANT_A.siteId;
const ROOT_ID = '00000000000000000000000000000000001';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const CHANNEL_LINK = 'https://feeds.example.test/partner/updates.rss';
const DEFAULT_COLLECTION_DISPLAY_LIST = 'Date,Title,Image,Summary,Credits';

/** Legacy's feed API endpoint of the site, kept from a first request on its own domain. */
export const FEED_API_ENDPOINT = `http://${SITE}.example.test/_api/feed/v1/${SITE}`;

// The contract serves cfeed.list and cfeed.edit from these operation paths; it names no `/cfeed/<action>` path.
export const CFEED_PATHS = Object.freeze({
  list: `/v1/sites/${SITE}/feeds`,
  editLocal: `/v1/sites/${SITE}/feeds/${FEED_IDS.localIndex}`,
  editRemote: `/v1/sites/${SITE}/feeds/${FEED_IDS.remoteRss}`,
  editNew: `/v1/sites/${SITE}/feeds/${FEED_IDS.newFeed}`,
} as const);

// listFeeds rows carry the `content.feed` columns under their PostgreSQL names, as strategies-content returns them.
const localIndexListRow = Object.freeze({
  feedid: FEED_IDS.localIndex,
  siteid: SITE,
  parentid: '',
  name: 'Latest News',
  isactive: 1,
  ispublic: 1,
  isdefault: 0,
  isfeaturesonly: 0,
  description: 'Recent agency news for the home page.',
  maxitems: 20,
  allowhtml: 1,
  lang: 'en-us',
  lastupdateby: 'Admin User',
  lastupdate: '2026-06-29 16:45:00',
  datecreated: '2026-02-03 09:15:00',
  restricted: 0,
  restrictgroups: '',
  version: 'RSS 2.0',
  channellink: '',
  type: 'Local',
  sortby: 'lastUpdate',
  sortdirection: 'desc',
  nextn: 10,
  displayname: 1,
  displayratings: 0,
  displaycomments: 0,
  altname: '',
  remoteid: '',
  remotesourceurl: '',
  remotepubdate: null,
  imagesize: 'small',
  imageheight: 'AUTO',
  imagewidth: 'AUTO',
  displaylist: 'Date,Title,Image,Summary,Credits,Tags',
  shownavonly: 1,
  showexcludesearch: 0,
  viewalllink: '',
  viewalllabel: '',
  cssclass: '',
  autoimport: 0,
  islocked: 0,
  contentpoolid: SITE,
  usecategoryintersect: 0,
  authtype: 'DEFAULT',
});

const remoteRssListRow = Object.freeze({
  feedid: FEED_IDS.remoteRss,
  siteid: SITE,
  parentid: CONTENT_IDS.news,
  name: 'Partner Updates',
  isactive: 1,
  ispublic: 0,
  isdefault: 0,
  isfeaturesonly: 0,
  description: 'Program updates syndicated from a partner agency.',
  maxitems: 10,
  allowhtml: 1,
  lang: 'en-us',
  lastupdateby: 'Admin User',
  lastupdate: '2026-06-27 11:20:00',
  datecreated: '2026-03-10 14:00:00',
  restricted: 0,
  restrictgroups: '',
  version: 'RSS 2.0',
  channellink: CHANNEL_LINK,
  type: 'Remote',
  sortby: 'lastUpdate',
  sortdirection: 'desc',
  nextn: 20,
  displayname: 0,
  displayratings: 0,
  displaycomments: 0,
  altname: '',
  remoteid: '',
  remotesourceurl: '',
  remotepubdate: null,
  imagesize: 'small',
  imageheight: 'AUTO',
  imagewidth: 'AUTO',
  displaylist: 'Date,Title,Image,Summary,Credits,Tags',
  shownavonly: 1,
  showexcludesearch: 0,
  viewalllink: '',
  viewalllabel: '',
  cssclass: '',
  autoimport: 1,
  islocked: 0,
  contentpoolid: '',
  usecategoryintersect: 0,
  authtype: '',
});

export const cfeedListData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    rsLocal: Object.freeze([localIndexListRow]),
    rsRemote: Object.freeze([remoteRssListRow]),
  }),
});

// feedBean `getAllValues()` after init: ACF stores the dot-notation instance keys upper-cased.
const NEW_FEED_BEAN = Object.freeze({
  FEEDID: '',
  SITEID: '',
  DATECREATED: "{ts '2026-06-30 12:00:00'}",
  LASTUPDATE: "{ts '2026-06-30 12:00:00'}",
  LASTUPDATEBY: '',
  NAME: '',
  ALTNAME: '',
  LANG: 'en-us',
  ISACTIVE: 1,
  SHOWNAVONLY: 1,
  SHOWEXCLUDESEARCH: 0,
  ISPUBLIC: 0,
  ISDEFAULT: 0,
  DESCRIPTION: '',
  CONTENTID: '',
  CATEGORYID: '',
  MAXITEMS: 20,
  ALLOWHTML: 1,
  ISFEATURESONLY: 0,
  FEATURETYPE: 'either',
  RESTRICTED: 0,
  RESTRICTGROUPS: '',
  VERSION: 'RSS 2.0',
  CHANNELLINK: '',
  AUTHTYPE: 'DEFAULT',
  TYPE: 'local',
  SORTBY: 'lastUpdate',
  SORTDIRECTION: 'desc',
  PARENTID: '',
  NEXTN: 20,
  DISPLAYNAME: 0,
  DISPLAYRATINGS: 0,
  DISPLAYCOMMENTS: 0,
  DISPLAYSUMMARIES: 1,
  DISPLAYKIDS: 0,
  ISNEW: 1,
  PARAMS: Object.freeze([]),
  ERRORS: Object.freeze({}),
  REMOTEID: '',
  REMOTESOURCEURL: '',
  REMOTEPUBDATE: '',
  IMAGESIZE: 'small',
  IMAGEHEIGHT: 'AUTO',
  IMAGEWIDTH: 'AUTO',
  DISPLAYLIST: 'Date,Title,Image,Summary,Credits,Tags',
  LIVEONLY: 1,
  ACTIVEONLY: 1,
  ENTITYNAME: 'content',
  TABLE: 'tcontent',
  VIEWALLLINK: '',
  VIEWALLLABEL: '',
  AUTOIMPORT: 0,
  ISLOCKED: 0,
  CSSCLASS: '',
  USECATEGORYINTERSECT: 0,
  ALTTABLE: '',
  CONTENTPOOLID: '',
  FIELDALIASES: Object.freeze({
    tag: Object.freeze({ FIELD: 'tcontenttags.tag', DATATYPE: 'varchar' }),
    taggroup: Object.freeze({ FIELD: 'tcontenttags.taggroup', DATATYPE: 'varchar' }),
  }),
  CACHEDWITHIN: 0,
  INCLUDEHOMEPAGE: 0,
});

const localIndexAdvancedParams = Object.freeze([
  Object.freeze({
    paramID: ADVANCED_PARAM_IDS.titleContains,
    feedID: FEED_IDS.localIndex,
    param: 1,
    relationship: 'and',
    field: 'tcontent.title',
    condition: 'Contains',
    criteria: 'news',
    dataType: 'varchar',
  }),
  Object.freeze({
    paramID: ADVANCED_PARAM_IDS.releasedSince,
    feedID: FEED_IDS.localIndex,
    param: 2,
    relationship: 'and',
    field: 'tcontent.releaseDate',
    condition: 'GTE',
    criteria: '2026-06-01',
    dataType: 'date',
  }),
]);

const localIndexBean = Object.freeze({
  ...NEW_FEED_BEAN,
  FEEDID: FEED_IDS.localIndex,
  SITEID: SITE,
  DATECREATED: localIndexListRow.datecreated,
  LASTUPDATE: localIndexListRow.lastupdate,
  LASTUPDATEBY: localIndexListRow.lastupdateby,
  NAME: localIndexListRow.name,
  ISPUBLIC: 1,
  DESCRIPTION: localIndexListRow.description,
  CONTENTID: CONTENT_IDS.news,
  CATEGORYID: CATEGORY_IDS.topicsNews,
  TYPE: 'Local',
  NEXTN: 10,
  DISPLAYNAME: 1,
  ISNEW: 0,
  PARAMS: localIndexAdvancedParams,
  CONTENTPOOLID: SITE,
});

const remoteRssBean = Object.freeze({
  ...NEW_FEED_BEAN,
  FEEDID: FEED_IDS.remoteRss,
  SITEID: SITE,
  DATECREATED: remoteRssListRow.datecreated,
  LASTUPDATE: remoteRssListRow.lastupdate,
  LASTUPDATEBY: remoteRssListRow.lastupdateby,
  NAME: remoteRssListRow.name,
  DESCRIPTION: remoteRssListRow.description,
  CATEGORYID: `${CATEGORY_IDS.topicsNews},${CATEGORY_IDS.topicsEvents}`,
  MAXITEMS: 10,
  CHANNELLINK: CHANNEL_LINK,
  AUTHTYPE: '',
  TYPE: 'Remote',
  PARENTID: CONTENT_IDS.news,
  ISNEW: 0,
  AUTOIMPORT: 1,
});

const NEWS_ZOOM =
  '\n\t\t<ul class="navZoom">\n\t\t' +
  '\n\t\t\t<li class="mi-file "> Home</li>\n\t\t' +
  '\n\t\t<li class="mi-folder-open-o "> <strong>News</strong></li>' +
  '\n\t\t</ul>';

const zoomHref = (contentId: string): string =>
  `href="/admin/?muraAction=cArch.list&siteid=${SITE}&topid=${contentId}&moduleid=${SITE_MANAGER_MODULE}&activeTab=0"`;

const ABOUT_US_ZOOM =
  '<ul class="breadcrumb">\n\t\t' +
  `\n\t\t\t<li class="">\n\t\t\t<a \n\t\t\t\t${zoomHref(ROOT_ID)}\n\t\t\t><i class="mi-file"></i>Home</a></li>\n\t\t` +
  `\n\t\t<li class=""><strong>\n\t\t<a \n\t\t\t${zoomHref(CONTENT_IDS.aboutUs)}\n\t\t><i class="mi-file"></i>About Us</a></strong></li>` +
  '\n\t\t</ul>';

const restrictGroupRows = Object.freeze([
  Object.freeze({ userID: RESTRICT_GROUP_IDS.communityMembers, groupName: 'Community Members', isPublic: 1 }),
  Object.freeze({ userID: RESTRICT_GROUP_IDS.restrictedReaders, groupName: 'RestrictedReaders', isPublic: 1 }),
  Object.freeze({ userID: RESTRICT_GROUP_IDS.contentEditors, groupName: 'Content Editors', isPublic: 0 }),
  Object.freeze({ userID: RESTRICT_GROUP_IDS.programStaff, groupName: 'Program Staff', isPublic: 0 }),
]);

const extendedAttributeRows = Object.freeze([
  Object.freeze({
    attributeID: PROGRAM_CODE_ATTRIBUTE_ID,
    type: 'Page',
    subType: 'Default',
    attribute: 'programCode',
    isActive: 1,
  }),
]);

const categoryRows = Object.freeze([
  Object.freeze({ categoryID: CATEGORY_IDS.topics, parentID: '', name: 'General Topics', isOpen: 1, permitted: true }),
  Object.freeze({
    categoryID: CATEGORY_IDS.topicsNews,
    parentID: CATEGORY_IDS.topics,
    name: 'Agency News',
    isOpen: 1,
    permitted: true,
  }),
  Object.freeze({
    categoryID: CATEGORY_IDS.topicsEvents,
    parentID: CATEGORY_IDS.topics,
    name: 'Events',
    isOpen: 1,
    permitted: true,
  }),
  Object.freeze({
    categoryID: CATEGORY_IDS.topicsEventsLocal,
    parentID: CATEGORY_IDS.topicsEvents,
    name: 'Local Events',
    isOpen: 1,
    permitted: true,
  }),
  Object.freeze({ categoryID: INTEREST_CATEGORY_IDS.interests, parentID: '', name: 'Interests', isOpen: 0, permitted: true }),
  Object.freeze({ categoryID: CATEGORY_IDS.restricted, parentID: '', name: 'Restricted Notices', isOpen: 1, permitted: false }),
]);

const aboutUsUsageRow = Object.freeze({
  contentHistID: CONTENT_HIST_IDS.aboutUs,
  contentID: CONTENT_IDS.aboutUs,
  type: 'Page',
  parentID: ROOT_ID,
  siteID: SITE,
  moduleID: SITE_MANAGER_MODULE,
  display: 1,
  approved: 1,
  displayStart: null,
  displayStop: null,
  lastUpdate: '2026-06-15 10:30:00',
  zoom: ABOUT_US_ZOOM,
  verdict: 'editor',
});

const siteValues = Object.freeze({
  rsRestrictGroups: restrictGroupRows,
  rsExtendedAttributes: extendedAttributeRows,
  hasCategories: categoryRows.length,
  categories: categoryRows,
  imageSizes: Object.freeze([Object.freeze({ name: 'hero-banner' })]),
  contentPool: Object.freeze([Object.freeze({ siteID: SITE, site: 'Tenant A' })]),
  useLayoutManager: false,
  defaultCollectionDisplayList: DEFAULT_COLLECTION_DISPLAY_LIST,
});

export const cfeedEditLocalData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    ...siteValues,
    feedBean: localIndexBean,
    rslist: Object.freeze([
      Object.freeze({ contentID: CONTENT_IDS.news, menuTitle: 'News', type: 'Folder', siteID: SITE, zoom: NEWS_ZOOM }),
    ]),
    rsUsage: Object.freeze([aboutUsUsageRow]),
  }),
});

export const cfeedEditRemoteData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    ...siteValues,
    feedBean: remoteRssBean,
    rslist: Object.freeze([]),
    rsUsage: Object.freeze([]),
    parentMenuTitle: 'News',
  }),
});

// FEED_IDS.newFeed names no collection, so the answer is the unsaved bean, whose FEEDID stays empty (feedDAO.read).
export const cfeedEditNewData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    ...siteValues,
    feedBean: NEW_FEED_BEAN,
    rslist: Object.freeze([]),
    rsUsage: Object.freeze([]),
  }),
});
