import type { components } from '@/generated/clients/identity';
import { LEGACY_ADMIN_SENTINEL_ID } from '@opt2/platform/legacy-compat';
import { GROUP_IDS } from './groups';

type ContentPermissions = components['schemas']['ContentPermissions'];
type ModulePermissions = components['schemas']['ModulePermissions'];
type GroupList = components['schemas']['GroupList'];
type NodeVerdicts = Pick<ContentPermissions, 'groups' | 'publicGroups'>;

export const CONTENT_NODE_IDS = Object.freeze({
  root: LEGACY_ADMIN_SENTINEL_ID,
  child: 'C0000000-0000-0000-0000000000000002',
  grandchild: 'C0000000-0000-0000-0000000000000003',
} as const);

export const MODULE_IDS = Object.freeze({
  content: '00000000000000000000000000000000000',
  users: '00000000000000000000000000000000008',
  categories: '00000000000000000000000000000000010',
} as const);

export const nodePermissionRows: Readonly<Record<keyof typeof CONTENT_NODE_IDS, Readonly<NodeVerdicts>>> = Object.freeze({
  root: Object.freeze({
    groups: [
      Object.freeze({ groupId: GROUP_IDS.archiveViewer, groupName: 'archive.viewer', perm: 'none' }),
      Object.freeze({ groupId: GROUP_IDS.defaultEditor, groupName: 'Editor', perm: 'editor' }),
      Object.freeze({ groupId: GROUP_IDS.libraryApprover, groupName: 'library.approver', perm: 'author' }),
      Object.freeze({ groupId: GROUP_IDS.recordsClerk, groupName: 'records.clerk', perm: 'deny' }),
    ],
    publicGroups: [
      Object.freeze({ groupId: GROUP_IDS.umbrellaMembers, groupName: 'Umbrella Members', perm: 'editor' }),
    ],
  }),
  child: Object.freeze({
    groups: [
      Object.freeze({ groupId: GROUP_IDS.archiveViewer, groupName: 'archive.viewer', perm: 'none' }),
      Object.freeze({ groupId: GROUP_IDS.defaultEditor, groupName: 'Editor', perm: 'author' }),
      Object.freeze({ groupId: GROUP_IDS.libraryApprover, groupName: 'library.approver', perm: 'read' }),
      Object.freeze({ groupId: GROUP_IDS.recordsClerk, groupName: 'records.clerk', perm: 'editor' }),
    ],
    publicGroups: [
      Object.freeze({ groupId: GROUP_IDS.umbrellaMembers, groupName: 'Umbrella Members', perm: 'read' }),
    ],
  }),
  grandchild: Object.freeze({
    groups: [
      Object.freeze({ groupId: GROUP_IDS.archiveViewer, groupName: 'archive.viewer', perm: 'none' }),
      Object.freeze({ groupId: GROUP_IDS.defaultEditor, groupName: 'Editor', perm: 'read' }),
      Object.freeze({ groupId: GROUP_IDS.libraryApprover, groupName: 'library.approver', perm: 'deny' }),
      Object.freeze({ groupId: GROUP_IDS.recordsClerk, groupName: 'records.clerk', perm: 'author' }),
    ],
    publicGroups: [
      Object.freeze({ groupId: GROUP_IDS.umbrellaMembers, groupName: 'Umbrella Members', perm: 'deny' }),
    ],
  }),
});

export const cpermMainAnswer: ContentPermissions = Object.freeze({
  contentId: CONTENT_NODE_IDS.root,
  siteId: 'default',
  ...nodePermissionRows.root,
});

export const cpermMainChildAnswer: ContentPermissions = Object.freeze({
  contentId: CONTENT_NODE_IDS.child,
  siteId: 'default',
  ...nodePermissionRows.child,
});

export const cpermMainGrandchildAnswer: ContentPermissions = Object.freeze({
  contentId: CONTENT_NODE_IDS.grandchild,
  siteId: 'default',
  ...nodePermissionRows.grandchild,
});

// Identity's verdict lists omit `Admin`; cperm.main takes the Admin group id from this `/v1/groups?ispublic=0` answer.
export const cpermMainSystemGroupsAnswer: GroupList = Object.freeze({
  items: [
    Object.freeze({
      UserID: GROUP_IDS.defaultAdmin,
      Email: null,
      GroupName: 'Admin',
      Type: 1,
      Counter: 2,
      Perm: 1,
      isPublic: 0,
    }),
    Object.freeze({
      UserID: GROUP_IDS.archiveViewer,
      Email: null,
      GroupName: 'archive.viewer',
      Type: 1,
      Counter: null,
      Perm: 0,
      isPublic: 0,
    }),
    Object.freeze({
      UserID: GROUP_IDS.defaultEditor,
      Email: 'editors@example.com',
      GroupName: 'Editor',
      Type: 1,
      Counter: 3,
      Perm: 0,
      isPublic: 0,
    }),
    Object.freeze({
      UserID: GROUP_IDS.libraryApprover,
      Email: null,
      GroupName: 'library.approver',
      Type: 1,
      Counter: null,
      Perm: 0,
      isPublic: 0,
    }),
    Object.freeze({
      UserID: GROUP_IDS.recordsClerk,
      Email: null,
      GroupName: 'records.clerk',
      Type: 1,
      Counter: null,
      Perm: 0,
      isPublic: 0,
    }),
  ],
  total: 5,
  nextOffset: null,
});

export const cpermModuleUsersAnswer: ModulePermissions = Object.freeze({
  moduleId: MODULE_IDS.users,
  siteId: 'default',
  privateGroups: [
    Object.freeze({ groupId: GROUP_IDS.archiveViewer, groupName: 'archive.viewer', granted: false }),
    Object.freeze({ groupId: GROUP_IDS.defaultEditor, groupName: 'Editor', granted: true }),
    Object.freeze({ groupId: GROUP_IDS.libraryApprover, groupName: 'library.approver', granted: false }),
    Object.freeze({ groupId: GROUP_IDS.recordsClerk, groupName: 'records.clerk', granted: true }),
  ],
  publicGroups: [Object.freeze({ groupId: GROUP_IDS.umbrellaMembers, groupName: 'Umbrella Members', granted: false })],
});

export const cpermModuleCategoriesAnswer: ModulePermissions = Object.freeze({
  moduleId: MODULE_IDS.categories,
  siteId: 'default',
  privateGroups: [
    Object.freeze({ groupId: GROUP_IDS.archiveViewer, groupName: 'archive.viewer', granted: false }),
    Object.freeze({ groupId: GROUP_IDS.defaultEditor, groupName: 'Editor', granted: false }),
    Object.freeze({ groupId: GROUP_IDS.libraryApprover, groupName: 'library.approver', granted: true }),
    Object.freeze({ groupId: GROUP_IDS.recordsClerk, groupName: 'records.clerk', granted: false }),
  ],
  publicGroups: [Object.freeze({ groupId: GROUP_IDS.umbrellaMembers, groupName: 'Umbrella Members', granted: true })],
});

export const cpermModuleNoGroupsAnswer: ModulePermissions = Object.freeze({
  moduleId: MODULE_IDS.users,
  siteId: 'tenant-b',
  privateGroups: [],
  publicGroups: [],
});
