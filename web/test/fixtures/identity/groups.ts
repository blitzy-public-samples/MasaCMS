import type { components } from '@/generated/clients/identity';
import { USER_IDS } from '../session';

type GroupAccount = components['schemas']['GroupAccount'];
type GroupMember = components['schemas']['GroupMember'];

export const GROUP_IDS = Object.freeze({
  defaultAdmin: '6A000000-0000-0000-0000000000000001',
  defaultEditor: '6A000000-0000-0000-0000000000000002',
  tenantAAdmin: '6A000000-0000-0000-0000000000000003',
  umbrellaMembers: '6A000000-0000-0000-0000000000000004',
  teamMember: '6A000000-0000-0000-0000000000000005',
  teamPrimaryLead: '6A000000-0000-0000-0000000000000006',
  teamSecondaryLead: '6A000000-0000-0000-0000000000000007',
  libraryWriter: '6A000000-0000-0000-0000000000000008',
  libraryApprover: '6A000000-0000-0000-0000000000000009',
  galleryUploader: '6A000000-0000-0000-000000000000000A',
  galleryCurator: '6A000000-0000-0000-000000000000000B',
  recordsClerk: '6A000000-0000-0000-000000000000000C',
  studioManager: '6A000000-0000-0000-000000000000000D',
  archiveViewer: '6A000000-0000-0000-000000000000000E',
} as const);

export const MEMBER_USER_IDS = Object.freeze({
  defaultAuthor: '5B000000-0000-0000-0000000000000001',
  defaultWebmaster: '5B000000-0000-0000-0000000000000002',
  tenantAStaff: '5B000000-0000-0000-0000000000000003',
} as const);

export const defaultAdminGroup: GroupAccount = Object.freeze({
  UserID: GROUP_IDS.defaultAdmin,
  GroupName: 'Admin',
  Email: null,
  Type: 1,
  subType: 'Default',
  S2: 0,
  isPublic: 0,
  SiteID: 'default',
  Perm: 1,
  InActive: 0,
  Subscribe: 0,
  tablist: null,
  LastUpdate: '2026-01-05T09:00:00.000',
  LastUpdateBy: 'System',
  LastUpdateByID: null,
  created: null,
  remoteID: null,
});

export const defaultEditorGroup: GroupAccount = Object.freeze({
  UserID: GROUP_IDS.defaultEditor,
  GroupName: 'Editor',
  Email: 'editors@example.com',
  Type: 1,
  subType: 'Default',
  S2: 0,
  isPublic: 0,
  SiteID: 'default',
  Perm: 0,
  InActive: 0,
  Subscribe: 1,
  tablist: 'Basic,Publishing,Layout & Objects',
  LastUpdate: '2026-10-29T14:20:00.000',
  LastUpdateBy: 'Admin User',
  LastUpdateByID: USER_IDS.admin,
  created: '2026-02-10T09:45:00.000',
  remoteID: null,
});

export const tenantAAdminGroup: GroupAccount = Object.freeze({
  UserID: GROUP_IDS.tenantAAdmin,
  GroupName: 'Admin',
  Email: null,
  Type: 1,
  subType: 'Default',
  S2: 0,
  isPublic: 0,
  SiteID: 'tenant-a',
  Perm: 1,
  InActive: 0,
  Subscribe: 0,
  tablist: null,
  LastUpdate: '2026-03-02T10:30:00.000',
  LastUpdateBy: 'System',
  LastUpdateByID: null,
  created: '2026-03-02T10:30:00.000',
  remoteID: null,
});

export const umbrellaMembersGroup: GroupAccount = Object.freeze({
  UserID: GROUP_IDS.umbrellaMembers,
  GroupName: 'Umbrella Members',
  Email: 'umbrella-members@example.com',
  Type: 1,
  subType: 'Default',
  S2: 0,
  isPublic: 1,
  SiteID: 'umbrella',
  Perm: 0,
  InActive: 0,
  Subscribe: 1,
  tablist: null,
  LastUpdate: '2026-06-30T07:30:00.000',
  LastUpdateBy: 'Admin User',
  LastUpdateByID: USER_IDS.admin,
  created: '2026-06-01T08:00:00.000',
  remoteID: null,
});

const ROLE_GROUP_COLUMNS = {
  Email: null,
  Type: 1,
  subType: 'Default',
  S2: 0,
  isPublic: 0,
  SiteID: 'tenant-a',
  Perm: 0,
  InActive: 0,
  Subscribe: 1,
  tablist: null,
  LastUpdate: '2026-06-30T10:00:00.000',
  LastUpdateBy: 'Admin User',
  LastUpdateByID: USER_IDS.admin,
  created: '2026-06-01T09:00:00.000',
  remoteID: null,
} as const;

const teamMemberGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.teamMember,
  GroupName: 'team.member',
});

const teamPrimaryLeadGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.teamPrimaryLead,
  GroupName: 'team.primary-lead',
});

const teamSecondaryLeadGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.teamSecondaryLead,
  GroupName: 'team.secondary-lead',
});

const libraryWriterGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.libraryWriter,
  GroupName: 'library.writer',
});

const libraryApproverGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.libraryApprover,
  GroupName: 'library.approver',
});

const galleryUploaderGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.galleryUploader,
  GroupName: 'gallery.uploader',
});

const galleryCuratorGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.galleryCurator,
  GroupName: 'gallery.curator',
});

const recordsClerkGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.recordsClerk,
  GroupName: 'records.clerk',
});

const studioManagerGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.studioManager,
  GroupName: 'studio.manager',
});

const archiveViewerGroup: GroupAccount = Object.freeze({
  ...ROLE_GROUP_COLUMNS,
  UserID: GROUP_IDS.archiveViewer,
  GroupName: 'archive.viewer',
});

export const roleGroups: readonly GroupAccount[] = Object.freeze([
  teamMemberGroup,
  teamPrimaryLeadGroup,
  teamSecondaryLeadGroup,
  libraryWriterGroup,
  libraryApproverGroup,
  galleryUploaderGroup,
  galleryCuratorGroup,
  recordsClerkGroup,
  studioManagerGroup,
  archiveViewerGroup,
]);

export const groups: readonly GroupAccount[] = Object.freeze([
  defaultAdminGroup,
  defaultEditorGroup,
  tenantAAdminGroup,
  umbrellaMembersGroup,
  ...roleGroups,
]);

export const groupsById: Readonly<Record<string, GroupAccount>> = Object.freeze({
  [GROUP_IDS.defaultAdmin]: defaultAdminGroup,
  [GROUP_IDS.defaultEditor]: defaultEditorGroup,
  [GROUP_IDS.tenantAAdmin]: tenantAAdminGroup,
  [GROUP_IDS.umbrellaMembers]: umbrellaMembersGroup,
  [GROUP_IDS.teamMember]: teamMemberGroup,
  [GROUP_IDS.teamPrimaryLead]: teamPrimaryLeadGroup,
  [GROUP_IDS.teamSecondaryLead]: teamSecondaryLeadGroup,
  [GROUP_IDS.libraryWriter]: libraryWriterGroup,
  [GROUP_IDS.libraryApprover]: libraryApproverGroup,
  [GROUP_IDS.galleryUploader]: galleryUploaderGroup,
  [GROUP_IDS.galleryCurator]: galleryCuratorGroup,
  [GROUP_IDS.recordsClerk]: recordsClerkGroup,
  [GROUP_IDS.studioManager]: studioManagerGroup,
  [GROUP_IDS.archiveViewer]: archiveViewerGroup,
});

export const newGroup: GroupAccount = Object.freeze({
  UserID: '',
  GroupName: '',
  Email: '',
  Type: 1,
  subType: 'Default',
  S2: 0,
  isPublic: 1,
  SiteID: '',
  Perm: 0,
  InActive: 0,
  Subscribe: 1,
  tablist: '',
  LastUpdate: '2026-06-30T12:00:00.000',
  LastUpdateBy: '',
  LastUpdateByID: '',
  created: '2026-06-30T12:00:00.000',
  remoteID: '',
});

// readGroupMemberships selects the member's own tusers.userID AS groupID (userDAO.cfc:652); identity answers the same.
export const editorGroupMembers: readonly GroupMember[] = Object.freeze([
  Object.freeze({
    groupID: MEMBER_USER_IDS.defaultAuthor,
    userID: MEMBER_USER_IDS.defaultAuthor,
    GroupName: null,
    Fname: 'Avery',
    Lname: 'Author',
    UserName: 'avery_author',
    Email: 'avery_author@example.com',
    Type: 2,
    S2: 0,
    InActive: 0,
    IsPublic: 0,
    SiteID: 'default',
    photoFileExt: null,
    LastLogin: '2026-10-29T16:45:00.000',
    LastUpdate: '2026-06-12T11:20:00.000',
    LastUpdateBy: 'Admin User',
    LastUpdateByID: USER_IDS.admin,
  }),
  Object.freeze({
    groupID: USER_IDS.qaEditor,
    userID: USER_IDS.qaEditor,
    GroupName: null,
    Fname: 'Quinn',
    Lname: 'Editor',
    UserName: 'qa_editor',
    Email: 'qa_editor@example.com',
    Type: 2,
    S2: 0,
    InActive: 0,
    IsPublic: 0,
    SiteID: 'default',
    photoFileExt: null,
    LastLogin: '2026-06-30T08:15:00.000',
    LastUpdate: '2026-02-10T10:00:00.000',
    LastUpdateBy: 'Admin User',
    LastUpdateByID: USER_IDS.admin,
  }),
  Object.freeze({
    groupID: USER_IDS.noSitesUser,
    userID: USER_IDS.noSitesUser,
    GroupName: null,
    Fname: 'Nadia',
    Lname: 'Member',
    UserName: 'no_sites_member',
    Email: 'no_sites_member@example.com',
    Type: 2,
    S2: 0,
    InActive: 0,
    IsPublic: 1,
    SiteID: 'default',
    photoFileExt: null,
    LastLogin: '2026-06-30T09:00:00.000',
    LastUpdate: '2026-04-20T14:00:00.000',
    LastUpdateBy: 'Admin User',
    LastUpdateByID: USER_IDS.admin,
  }),
]);

export const adminGroupMembers: readonly GroupMember[] = Object.freeze([
  Object.freeze({
    groupID: USER_IDS.admin,
    userID: USER_IDS.admin,
    GroupName: null,
    Fname: 'Admin',
    Lname: 'User',
    UserName: 'admin',
    Email: 'admin@example.com',
    Type: 2,
    S2: 1,
    InActive: 0,
    IsPublic: 0,
    SiteID: 'default',
    photoFileExt: null,
    LastLogin: '2026-06-30T08:00:00.000',
    LastUpdate: '2026-01-05T09:00:00.000',
    LastUpdateBy: 'System',
    LastUpdateByID: null,
  }),
  Object.freeze({
    groupID: MEMBER_USER_IDS.defaultWebmaster,
    userID: MEMBER_USER_IDS.defaultWebmaster,
    GroupName: null,
    Fname: 'Wren',
    Lname: 'Webmaster',
    UserName: 'wren_webmaster',
    Email: 'wren_webmaster@example.com',
    Type: 2,
    S2: 0,
    InActive: 0,
    IsPublic: 0,
    SiteID: 'default',
    photoFileExt: null,
    LastLogin: '2026-06-29T17:10:00.000',
    LastUpdate: '2026-05-18T13:40:00.000',
    LastUpdateBy: 'Admin User',
    LastUpdateByID: USER_IDS.admin,
  }),
]);

export const tenantAAdminGroupMembers: readonly GroupMember[] = Object.freeze([
  Object.freeze({
    groupID: USER_IDS.tenantASiteAdmin,
    userID: USER_IDS.tenantASiteAdmin,
    GroupName: null,
    Fname: 'Tessa',
    Lname: 'Admin',
    UserName: 'tenant_a_admin',
    Email: 'tenant_a_admin@example.com',
    Type: 2,
    S2: 0,
    InActive: 0,
    IsPublic: 0,
    SiteID: 'tenant-a',
    photoFileExt: null,
    LastLogin: '2026-06-30T08:30:00.000',
    LastUpdate: '2026-03-02T11:00:00.000',
    LastUpdateBy: 'Admin User',
    LastUpdateByID: USER_IDS.admin,
  }),
  Object.freeze({
    groupID: MEMBER_USER_IDS.tenantAStaff,
    userID: MEMBER_USER_IDS.tenantAStaff,
    GroupName: null,
    Fname: 'Toby',
    Lname: 'Staff',
    UserName: 'tenant_a_staff',
    Email: 'tenant_a_staff@example.com',
    Type: 2,
    S2: 0,
    InActive: 0,
    IsPublic: 0,
    SiteID: 'tenant-a',
    photoFileExt: null,
    LastLogin: '2026-06-28T15:05:00.000',
    LastUpdate: '2026-06-15T09:25:00.000',
    LastUpdateBy: 'Tessa Admin',
    LastUpdateByID: USER_IDS.tenantASiteAdmin,
  }),
]);

export const emptyGroupMembers: readonly GroupMember[] = Object.freeze([]);
