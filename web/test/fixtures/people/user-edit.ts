import type { components } from '@/generated/clients/people';
import { GROUP_IDS } from '../identity/groups';
import { USER_IDS } from '../session';
import { INTEREST_CATEGORY_IDS } from '../strategies-content/categories';
import { janeSmithHomeAddress } from './address-edit';
import { PERSON_IDS } from './user-list';

type UserEditData = components['schemas']['UserEditData'];
type GroupOption = components['schemas']['GroupOption'];
type SubTypeOption = components['schemas']['SubTypeOption'];
type SiteOption = components['schemas']['SiteOption'];

export const NEW_USER_ID = '7C1E0A0F-4B2D-4E6F-8A9B0C1D2E3F4A0F';

const USER_SUBTYPE_IDS = Object.freeze({
  default: '7C1E0C01-4B2D-4E6F-8A9B0C1D2E3F4C01',
  staff: '7C1E0C02-4B2D-4E6F-8A9B0C1D2E3F4C02',
} as const);

const NEW_USER_TIMESTAMP = '2026-06-30T12:00:00.000';

const TENANT_A_ROLE_GROUP = { Site: 'Tenant A', SiteID: 'tenant-a', isPublic: 0, Perm: 0 } as const;

const tenantAPrivateGroups: readonly GroupOption[] = Object.freeze([
  Object.freeze({ UserID: GROUP_IDS.tenantAAdmin, GroupName: 'Admin', Site: 'Tenant A', SiteID: 'tenant-a', isPublic: 0, Perm: 1 }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.archiveViewer, GroupName: 'archive.viewer' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.galleryCurator, GroupName: 'gallery.curator' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.galleryUploader, GroupName: 'gallery.uploader' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.libraryApprover, GroupName: 'library.approver' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.libraryWriter, GroupName: 'library.writer' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.recordsClerk, GroupName: 'records.clerk' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.studioManager, GroupName: 'studio.manager' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.teamMember, GroupName: 'team.member' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.teamPrimaryLead, GroupName: 'team.primary-lead' }),
  Object.freeze({ ...TENANT_A_ROLE_GROUP, UserID: GROUP_IDS.teamSecondaryLead, GroupName: 'team.secondary-lead' }),
]);

const tenantAPublicGroups: readonly GroupOption[] = Object.freeze([
  Object.freeze({ UserID: GROUP_IDS.umbrellaMembers, GroupName: 'Umbrella Members', Site: 'Umbrella', SiteID: 'umbrella', isPublic: 1, Perm: 0 }),
]);

const tenantAPrivatePoolSubTypes: readonly SubTypeOption[] = Object.freeze([
  Object.freeze({ subTypeID: USER_SUBTYPE_IDS.default, type: '2', subType: 'Default' }),
  Object.freeze({ subTypeID: USER_SUBTYPE_IDS.staff, type: '2', subType: 'Staff' }),
]);

const siteOptions: readonly SiteOption[] = Object.freeze([
  Object.freeze({ siteID: 'default', site: 'Default' }),
  Object.freeze({ siteID: 'tenant-a', site: 'Tenant A' }),
  Object.freeze({ siteID: 'tenant-b', site: 'Tenant B' }),
  Object.freeze({ siteID: 'umbrella', site: 'Umbrella' }),
]);

// userBean.init values under the generated id; isPublic 1 is legacy's "Site Member" default, kept as legacy shows it.
export const newUserEditData: UserEditData = Object.freeze({
  user: Object.freeze({
    UserID: NEW_USER_ID,
    GroupName: '',
    Fname: '',
    Lname: '',
    UserName: '',
    Email: '',
    Company: '',
    JobTitle: '',
    mobilePhone: '',
    Website: '',
    Type: 2,
    subType: 'Default',
    Ext: null,
    ContactForm: '',
    Admin: null,
    S2: 0,
    LastLogin: null,
    LastUpdate: NEW_USER_TIMESTAMP,
    LastUpdateBy: '',
    LastUpdateByID: '',
    Perm: 0,
    InActive: 0,
    isPublic: 1,
    SiteID: '',
    Subscribe: 1,
    notes: '',
    description: '',
    interests: '',
    keepPrivate: 0,
    photoFileID: '',
    photoFileExt: '',
    IMName: '',
    IMService: '',
    created: NEW_USER_TIMESTAMP,
    remoteID: '',
    tags: '',
    tablist: '',
  }),
  isNew: true,
  tempIsPublic: 1,
  lockedSuper: false,
  blockedUntil: null,
  passwordExpired: false,
  addresses: [],
  privateGroups: tenantAPrivateGroups.slice(),
  publicGroups: tenantAPublicGroups.slice(),
  groupIds: [],
  categoryIds: [],
  subTypes: [],
  extendedAttributes: Object.freeze({}),
  sites: siteOptions.slice(),
  errors: Object.freeze({}),
  retained: false,
});

// Username, email and the Default subtype are Jane's ./user-list row; Staff is offered as the pool's non-default subtype.
export const existingUserEditData: UserEditData = Object.freeze({
  user: Object.freeze({
    UserID: PERSON_IDS.janeSmith,
    GroupName: '',
    Fname: 'Jane',
    Lname: 'Smith',
    UserName: 'jane_smith',
    Email: 'jane_smith@example.com',
    Company: 'Example Co, Ltd.',
    JobTitle: 'Program Coordinator',
    mobilePhone: '555-0101',
    Website: '',
    Type: 2,
    subType: 'Default',
    Ext: null,
    ContactForm: '',
    Admin: null,
    S2: 0,
    LastLogin: '2026-10-28T08:12:00.000',
    LastUpdate: '2026-10-29T14:20:00.000',
    LastUpdateBy: 'Tessa Admin',
    LastUpdateByID: USER_IDS.tenantASiteAdmin,
    Perm: 0,
    InActive: 0,
    isPublic: 0,
    SiteID: 'tenant-a',
    Subscribe: 0,
    notes: '',
    description: '',
    interests: '',
    keepPrivate: 0,
    photoFileID: '',
    photoFileExt: '',
    IMName: '',
    IMService: '',
    created: '2026-02-16T09:30:00.000',
    remoteID: 'HR-0001',
    tags: 'outreach,remote',
    tablist: '',
  }),
  isNew: false,
  tempIsPublic: 0,
  lockedSuper: false,
  blockedUntil: null,
  passwordExpired: false,
  addresses: [janeSmithHomeAddress],
  privateGroups: tenantAPrivateGroups.slice(),
  publicGroups: tenantAPublicGroups.slice(),
  groupIds: [GROUP_IDS.teamMember, GROUP_IDS.umbrellaMembers],
  categoryIds: [INTEREST_CATEGORY_IDS.newsletter, INTEREST_CATEGORY_IDS.volunteering],
  subTypes: tenantAPrivatePoolSubTypes.slice(),
  extendedAttributes: Object.freeze({ employeeNumber: 'E-1001', department: 'Outreach' }),
  sites: siteOptions.slice(),
  errors: Object.freeze({}),
  retained: false,
});
