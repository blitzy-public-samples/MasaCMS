import type { components } from '@/generated/clients/people';
import { NEW_USER_ID, newUserEditData } from './user-edit';

type UpdateResult = components['schemas']['UpdateResult'];
type RouteResult = components['schemas']['RouteResult'];
type PersonRecord = components['schemas']['PersonRecord'];

// A System Users add in tenant-a's private pool, the pool of the ./user-list rows.
const submittedNewUser: PersonRecord = Object.freeze({
  ...newUserEditData.user,
  UserID: NEW_USER_ID,
  Fname: 'Jordan',
  Lname: 'Smith',
  UserName: 'jordan_smith',
  Email: 'jordan_smith@example.com',
  isPublic: 0,
  SiteID: 'tenant-a',
});

// 'jane_smith' is PERSON_IDS.janeSmith's UserName in ./user-list.
export const duplicateUsernameResult: UpdateResult = Object.freeze({
  written: false,
  errors: Object.freeze({
    username: "The username 'jane_smith' that you entered is being used by another user.",
  }),
  userBean: Object.freeze({ ...submittedNewUser, UserName: 'jane_smith' }),
  passwordExpired: false,
});

export const missingEmailResult: UpdateResult = Object.freeze({
  written: false,
  errors: Object.freeze({ email: "The 'Email Address' field is required." }),
  userBean: Object.freeze({ ...submittedNewUser, Email: '' }),
  passwordExpired: false,
});

export const passwordMismatchResult: UpdateResult = Object.freeze({
  written: false,
  errors: Object.freeze({ password: "The 'Password' and 'Confirm Password' fields must match." }),
  userBean: submittedNewUser,
  passwordExpired: false,
});

export const invalidEmailResult: UpdateResult = Object.freeze({
  written: false,
  errors: Object.freeze({ email: "The 'Email' field must be in a valid email format." }),
  userBean: Object.freeze({ ...submittedNewUser, Email: 'jordan_smith.example.com' }),
  passwordExpired: false,
});

export const routeToListUsersResult: RouteResult = Object.freeze({
  redirect: Object.freeze({
    action: 'cUsers.listusers',
    params: Object.freeze({ siteid: 'tenant-a', ispublic: '0' }),
  }),
});
