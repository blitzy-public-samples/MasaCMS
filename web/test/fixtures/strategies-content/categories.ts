import type { components } from '@/generated/clients/strategies-content';
import type { CategoryTreeNode } from '@/screens/ccategory/dsp-nest';
import { TENANT_A, TENANT_UMBRELLA } from '@opt2/platform/testing';

type AdminViewModel = components['schemas']['AdminViewModel'];

export const CATEGORY_IDS = Object.freeze({
  topics: '5C000000-0005-4000-8000000000000001',
  topicsNews: '5C000000-0005-4000-8000000000000002',
  topicsEvents: '5C000000-0005-4000-8000000000000003',
  topicsEventsLocal: '5C000000-0005-4000-8000000000000004',
  inactiveArchive: '5C000000-0005-4000-8000000000000005',
  restricted: '5C000000-0005-4000-8000000000000006',
} as const);

export const INTEREST_CATEGORY_IDS = Object.freeze({
  interests: '5C000000-0005-4000-8000000000000007',
  newsletter: '5C000000-0005-4000-8000000000000008',
  volunteering: '5C000000-0005-4000-8000000000000009',
  training: '5C000000-0005-4000-800000000000000A',
} as const);

export const NEW_CATEGORY_ID = '5C000000-0005-4000-800000000000000B';

export const CCATEGORY_PATHS = Object.freeze({
  list: `/v1/sites/${TENANT_A.siteId}/categories`,
  edit: `/v1/sites/${TENANT_A.siteId}/categories/${CATEGORY_IDS.topicsEvents}`,
  editNew: `/v1/sites/${TENANT_A.siteId}/categories/${NEW_CATEGORY_ID}`,
} as const);

const RESTRICT_GROUP_IDS = Object.freeze({
  communityMembers: '6A000000-0000-0000-0000000000005C01',
  restrictedReaders: '6A000000-0000-0000-0000000000005C02',
  contentEditors: '6A000000-0000-0000-0000000000005C03',
  programStaff: '6A000000-0000-0000-0000000000005C04',
} as const);

const topicsNewsNode: CategoryTreeNode = Object.freeze({
  categoryID: CATEGORY_IDS.topicsNews,
  parentID: CATEGORY_IDS.topics,
  name: 'Agency News',
  hasKids: 0,
  isOpen: 1,
  isInterestGroup: 0,
  isActive: 1,
  restrictGroups: '',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'general-topics/agency-news',
  urltitle: 'agency-news',
  isFeatureable: 1,
  children: Object.freeze([]),
});

const topicsEventsLocalNode: CategoryTreeNode = Object.freeze({
  categoryID: CATEGORY_IDS.topicsEventsLocal,
  parentID: CATEGORY_IDS.topicsEvents,
  name: 'Local Events',
  hasKids: 0,
  isOpen: 1,
  isInterestGroup: 0,
  isActive: 1,
  restrictGroups: '',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'general-topics/events/local-events',
  urltitle: 'local-events',
  isFeatureable: 0,
  children: Object.freeze([]),
});

const topicsEventsNode: CategoryTreeNode = Object.freeze({
  categoryID: CATEGORY_IDS.topicsEvents,
  parentID: CATEGORY_IDS.topics,
  name: 'Events',
  hasKids: 1,
  isOpen: 1,
  isInterestGroup: 0,
  isActive: 1,
  restrictGroups: 'RestrictedReaders',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'general-topics/events',
  urltitle: 'events',
  isFeatureable: 1,
  children: Object.freeze([topicsEventsLocalNode]),
});

const topicsNode: CategoryTreeNode = Object.freeze({
  categoryID: CATEGORY_IDS.topics,
  parentID: '',
  name: 'General Topics',
  hasKids: 2,
  isOpen: 1,
  isInterestGroup: 0,
  isActive: 1,
  restrictGroups: '',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'general-topics',
  urltitle: 'general-topics',
  isFeatureable: 1,
  children: Object.freeze([topicsNewsNode, topicsEventsNode]),
});

const newsletterNode: CategoryTreeNode = Object.freeze({
  categoryID: INTEREST_CATEGORY_IDS.newsletter,
  parentID: INTEREST_CATEGORY_IDS.interests,
  name: 'Newsletter',
  hasKids: 0,
  isOpen: 1,
  isInterestGroup: 1,
  isActive: 1,
  restrictGroups: '',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'interests/newsletter',
  urltitle: 'newsletter',
  isFeatureable: 0,
  children: Object.freeze([]),
});

const volunteeringNode: CategoryTreeNode = Object.freeze({
  categoryID: INTEREST_CATEGORY_IDS.volunteering,
  parentID: INTEREST_CATEGORY_IDS.interests,
  name: 'Outreach Volunteering',
  hasKids: 0,
  isOpen: 1,
  isInterestGroup: 1,
  isActive: 1,
  restrictGroups: '',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'interests/outreach-volunteering',
  urltitle: 'outreach-volunteering',
  isFeatureable: 0,
  children: Object.freeze([]),
});

const trainingNode: CategoryTreeNode = Object.freeze({
  categoryID: INTEREST_CATEGORY_IDS.training,
  parentID: INTEREST_CATEGORY_IDS.interests,
  name: 'Skills Training',
  hasKids: 0,
  isOpen: 1,
  isInterestGroup: 1,
  isActive: 1,
  restrictGroups: '',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'interests/skills-training',
  urltitle: 'skills-training',
  isFeatureable: 0,
  children: Object.freeze([]),
});

const interestsNode: CategoryTreeNode = Object.freeze({
  categoryID: INTEREST_CATEGORY_IDS.interests,
  parentID: '',
  name: 'Interests',
  hasKids: 3,
  isOpen: 0,
  isInterestGroup: 1,
  isActive: 1,
  restrictGroups: '',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'interests',
  urltitle: 'interests',
  isFeatureable: 0,
  children: Object.freeze([newsletterNode, volunteeringNode, trainingNode]),
});

const inactiveArchiveNode: CategoryTreeNode = Object.freeze({
  categoryID: CATEGORY_IDS.inactiveArchive,
  parentID: '',
  name: 'Legacy Archive',
  hasKids: 0,
  isOpen: 1,
  isInterestGroup: 0,
  isActive: 0,
  restrictGroups: '',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'legacy-archive',
  urltitle: 'legacy-archive',
  isFeatureable: 0,
  children: Object.freeze([]),
});

const restrictedNode: CategoryTreeNode = Object.freeze({
  categoryID: CATEGORY_IDS.restricted,
  parentID: '',
  name: 'Restricted Notices',
  hasKids: 0,
  isOpen: 1,
  isInterestGroup: 0,
  isActive: 1,
  restrictGroups: 'Program Staff',
  siteID: TENANT_UMBRELLA.siteId,
  filename: 'restricted-notices',
  urltitle: 'restricted-notices',
  isFeatureable: 1,
  children: Object.freeze([]),
});

const categoryTree: readonly CategoryTreeNode[] = Object.freeze([
  topicsNode,
  interestsNode,
  inactiveArchiveNode,
  restrictedNode,
]);

const restrictGroupRows = Object.freeze([
  Object.freeze({ userID: RESTRICT_GROUP_IDS.communityMembers, groupName: 'Community Members', isPublic: 1 }),
  Object.freeze({ userID: RESTRICT_GROUP_IDS.restrictedReaders, groupName: 'RestrictedReaders', isPublic: 1 }),
  Object.freeze({ userID: RESTRICT_GROUP_IDS.contentEditors, groupName: 'Content Editors', isPublic: 0 }),
  Object.freeze({ userID: RESTRICT_GROUP_IDS.programStaff, groupName: 'Program Staff', isPublic: 0 }),
]);

export const ccategoryListData: AdminViewModel = Object.freeze({
  rc: Object.freeze({ categories: categoryTree }),
});

export const ccategoryEditData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    categoryBean: Object.freeze({
      categoryid: CATEGORY_IDS.topicsEvents,
      siteid: TENANT_UMBRELLA.siteId,
      datecreated: '2026-02-03T09:15:00.000Z',
      lastupdate: '2026-06-29T16:45:00.000Z',
      lastupdateby: 'Admin User',
      name: 'Events',
      isinterestgroup: '0',
      parentid: CATEGORY_IDS.topics,
      isactive: '1',
      isopen: '1',
      notes: 'Program events and calendar listings.',
      sortby: 'orderno',
      sortdirection: 'asc',
      restrictgroups: 'RestrictedReaders',
      path: `${CATEGORY_IDS.topics},${CATEGORY_IDS.topicsEvents}`,
      remoteid: '',
      remotesourceurl: '',
      remotepubdate: '',
      urltitle: 'events',
      filename: 'general-topics/events',
      isfeatureable: 1,
      isnew: '0',
      errors: Object.freeze({}),
    }),
    rsRestrictGroups: restrictGroupRows,
    categories: categoryTree,
  }),
});

// NEW_CATEGORY_ID names no category, so the answer is the unsaved bean, whose categoryid stays empty.
export const ccategoryEditNewData: AdminViewModel = Object.freeze({
  rc: Object.freeze({
    categoryBean: Object.freeze({
      categoryid: '',
      siteid: '',
      datecreated: "{ts '2026-06-30 12:00:00'}",
      lastupdate: "{ts '2026-06-30 12:00:00'}",
      lastupdateby: '',
      name: '',
      isinterestgroup: 1,
      parentid: '',
      isactive: 1,
      isopen: 1,
      notes: '',
      sortby: 'orderno',
      sortdirection: 'asc',
      restrictgroups: '',
      path: '',
      remoteid: '',
      remotesourceurl: '',
      remotepubdate: '',
      urltitle: '',
      filename: '',
      isfeatureable: 1,
      isnew: 1,
      errors: Object.freeze({}),
    }),
    rsRestrictGroups: restrictGroupRows,
    categories: categoryTree,
  }),
});

export const interestCategories: readonly CategoryTreeNode[] = Object.freeze([interestsNode]);
