import type { components } from '@/generated/clients/people';
import { USER_IDS } from '../session';

type UserListRow = components['schemas']['UserListRow'];
type UserListPageV2 = components['schemas']['UserListPageV2'];

export const PERSON_IDS = Object.freeze({
  janeSmith: '7C1E0A01-4B2D-4E6F-8A9B0C1D2E3F4A01',
  johnSmith: '7C1E0A02-4B2D-4E6F-8A9B0C1D2E3F4A02',
  alexDoe: '7C1E0A03-4B2D-4E6F-8A9B0C1D2E3F4A03',
  samLee: '7C1E0A04-4B2D-4E6F-8A9B0C1D2E3F4A04',
  patRivera: '7C1E0A05-4B2D-4E6F-8A9B0C1D2E3F4A05',
  systemUser: '7C1E0A06-4B2D-4E6F-8A9B0C1D2E3F4A06',
} as const);

const TENANT_A_SYSTEM_USER = {
  GroupName: null,
  Type: 2,
  subType: 'Default',
  Admin: null,
  S2: 0,
  isPublic: 0,
  SiteID: 'tenant-a',
} as const;

const tenantASystemUsers: readonly UserListRow[] = Object.freeze([
  Object.freeze({
    ...TENANT_A_SYSTEM_USER,
    UserID: USER_IDS.tenantASiteAdmin,
    Fname: 'Tessa',
    Lname: 'Admin',
    UserName: 'tenant_a_admin',
    Email: 'tenant_a_admin@example.com',
    LastUpdate: '2026-03-02T11:00:00.000',
    LastUpdateBy: 'Admin User',
  }),
  Object.freeze({
    ...TENANT_A_SYSTEM_USER,
    UserID: PERSON_IDS.alexDoe,
    Fname: 'Alex',
    Lname: 'Doe',
    UserName: 'alex_doe',
    Email: 'alex_doe@example.com',
    LastUpdate: '2026-04-14T09:05:00.000',
    LastUpdateBy: 'Tessa Admin',
  }),
  Object.freeze({
    ...TENANT_A_SYSTEM_USER,
    UserID: PERSON_IDS.samLee,
    Fname: 'Sam',
    Lname: 'Lee',
    UserName: 'sam_lee',
    Email: 'sam_lee@example.com',
    LastUpdate: '2026-05-21T16:40:00.000',
    LastUpdateBy: 'Tessa Admin',
  }),
  Object.freeze({
    ...TENANT_A_SYSTEM_USER,
    UserID: PERSON_IDS.patRivera,
    Fname: 'Pat',
    Lname: 'Rivera',
    UserName: 'pat_rivera',
    Email: 'pat_rivera@example.com',
    LastUpdate: '2026-06-03T10:15:00.000',
    LastUpdateBy: 'Admin User',
  }),
  Object.freeze({
    ...TENANT_A_SYSTEM_USER,
    UserID: PERSON_IDS.janeSmith,
    Fname: 'Jane',
    Lname: 'Smith',
    UserName: 'jane_smith',
    Email: 'jane_smith@example.com',
    LastUpdate: '2026-10-29T14:20:00.000',
    LastUpdateBy: 'Tessa Admin',
  }),
  Object.freeze({
    ...TENANT_A_SYSTEM_USER,
    UserID: PERSON_IDS.johnSmith,
    Fname: 'John',
    Lname: 'Smith',
    UserName: 'john_smith',
    Email: 'john_smith@example.com',
    LastUpdate: '2026-06-18T08:50:00.000',
    LastUpdateBy: 'Tessa Admin',
  }),
  Object.freeze({
    ...TENANT_A_SYSTEM_USER,
    UserID: PERSON_IDS.systemUser,
    Fname: 'Casey',
    Lname: 'Taylor',
    UserName: 'casey_taylor',
    Email: 'casey_taylor@example.com',
    LastUpdate: '2026-06-30T07:45:00.000',
    LastUpdateBy: 'Admin User',
  }),
]);

// listUsersV2 answers only the page's rows; legacy page links post the page number as startrow (setPage(startrow)),
// so page 2 at two per page is startrow 2 and rows 3-4.
export const tenantASystemUsersPage: UserListPageV2 = Object.freeze({
  items: tenantASystemUsers.slice(),
  nextn: Object.freeze({
    totalrecords: 7,
    recordsperpage: 25,
    numberofpages: 1,
    currentpagenumber: 1,
    firstpage: 1,
    lastpage: 1,
    next: 1,
    previous: 1,
    through: 7,
    startrow: 1,
  }),
  listUnassignedUsers: [PERSON_IDS.patRivera],
});

export const tenantASystemUsersSecondPage: UserListPageV2 = Object.freeze({
  items: tenantASystemUsers.slice(2, 4),
  nextn: Object.freeze({
    totalrecords: 7,
    recordsperpage: 2,
    numberofpages: 4,
    currentpagenumber: 1,
    firstpage: 1,
    lastpage: 4,
    next: 3,
    previous: 1,
    through: 2,
    startrow: 2,
  }),
  listUnassignedUsers: [PERSON_IDS.patRivera],
});

export const emptyUsersPage: UserListPageV2 = Object.freeze({
  items: [],
  nextn: Object.freeze({
    totalrecords: 0,
    recordsperpage: 25,
    numberofpages: 0,
    currentpagenumber: 1,
    firstpage: 1,
    lastpage: 0,
    next: 1,
    previous: 1,
    through: 0,
    startrow: 1,
  }),
  listUnassignedUsers: [],
});
