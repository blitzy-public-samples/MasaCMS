import type { components } from '@/generated/clients/people';
import { USER_IDS } from '../session';
import { INTEREST_CATEGORY_IDS } from '../strategies-content/categories';
import { systemUserHomeAddress } from './address-edit';

type ProfileData = components['schemas']['ProfileData'];
type UpdateResult = components['schemas']['UpdateResult'];

// SUBJECTS.systemUser.sub as tokens.ts derives it, not PERSON_IDS.systemUser: the token subject is session.mura.userID,
// so the profile user and its address carry it.
export const PROFILE_USER_ID = '35497CB7-0202-33EE-786E266792DA2679';

const VOLUNTEER_SUBTYPE_ID = '7C1E0C01-4B2D-4E6F-8A9B0C1D2E3F4C01';

export const profileData: ProfileData = Object.freeze({
  user: Object.freeze({
    UserID: PROFILE_USER_ID,
    GroupName: null,
    Fname: 'Casey',
    Lname: 'Taylor',
    UserName: 'casey_taylor',
    Email: 'casey_taylor@example.com',
    Company: 'Riverton Outreach',
    JobTitle: 'Volunteer Coordinator',
    mobilePhone: '555-0111',
    Website: '',
    Type: 2,
    subType: 'Volunteer',
    Ext: null,
    ContactForm: '',
    Admin: null,
    S2: 0,
    LastLogin: '2026-06-30T08:45:00.000',
    LastUpdate: '2026-06-30T07:45:00.000',
    LastUpdateBy: 'Admin User',
    LastUpdateByID: USER_IDS.admin,
    Perm: 0,
    InActive: 0,
    isPublic: 0,
    SiteID: 'tenant-a',
    Subscribe: 1,
    notes: '',
    description: '',
    interests: '',
    keepPrivate: 0,
    photoFileID: '',
    photoFileExt: '',
    IMName: '',
    IMService: '',
    created: '2026-01-12T10:00:00.000',
    remoteID: '',
    tags: 'mentoring,outreach',
    tablist: '',
  }),
  addresses: [Object.freeze({ ...systemUserHomeAddress, userID: PROFILE_USER_ID })],
  categoryIds: [INTEREST_CATEGORY_IDS.newsletter],
  subTypes: [Object.freeze({ subTypeID: VOLUNTEER_SUBTYPE_ID, type: '2', subType: 'Volunteer' })],
  extendedAttributes: Object.freeze({ volunteerRegion: 'North' }),
  errors: Object.freeze({}),
  retained: false,
});

export const profileUpdateSuccess: UpdateResult = Object.freeze({
  written: true,
  redirect: Object.freeze({ action: 'home.redirect', params: Object.freeze({}) }),
  errors: Object.freeze({}),
});
