import type { components, operations } from '@/generated/clients/people';
import { tenantASiteAdminSession } from '../session';
import { PERSON_IDS, tenantASystemUsersPage } from './user-list';

type UserListPage = operations['searchUsers']['responses'][200]['content']['application/json'];
type AdvancedSearchPage = operations['getAdvancedSearch']['responses'][200]['content']['application/json'];
type StoredSearchCriteria = components['schemas']['StoredSearchCriteria'];
type SearchParam = StoredSearchCriteria['paramArray'][number];
type NextN = components['schemas']['NextN'];

// Session state: StoredSearchCriteria plus paramCount and paramCircuit; AdvancedSearchCriteria is the posted form.
type SessionSearchCriteria = StoredSearchCriteria & { readonly paramCount: number; readonly paramCircuit: string };

export const SEARCH_KEYWORD = 'smith';
export const EMPTY_SEARCH_KEYWORD = 'zzqx';

const SMITH_IDS: readonly string[] = [PERSON_IDS.janeSmith, PERSON_IDS.johnSmith];
const SMITH_ROWS = tenantASystemUsersPage.items.filter(({ UserID }) => SMITH_IDS.includes(UserID));

const TWO_MATCHES_NEXTN: NextN = Object.freeze({
  totalrecords: 2,
  recordsperpage: 25,
  numberofpages: 1,
  currentpagenumber: 1,
  firstpage: 1,
  lastpage: 1,
  next: 1,
  previous: 1,
  through: 2,
  startrow: 1,
});

const NO_MATCHES_NEXTN: NextN = Object.freeze({
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
});

export const smithSearchResults: UserListPage = Object.freeze({
  items: SMITH_ROWS.slice(),
  nextn: TWO_MATCHES_NEXTN,
  listUnassignedUsers: [PERSON_IDS.patRivera],
});

export const emptySearchResults: UserListPage = Object.freeze({
  items: [],
  nextn: NO_MATCHES_NEXTN,
  listUnassignedUsers: [PERSON_IDS.patRivera],
});

const { paramArray, paramCount, paramCircuit, paramCategories, paramGroups, inActive, membersOnly, visitorStatus } =
  tenantASiteAdminSession;

const LAST_NAME_PARAM: SearchParam = Object.freeze({
  Field: 'tusers.lname^varchar',
  Relationship: 'and',
  Criteria: SEARCH_KEYWORD,
  Condition: 'Contains',
});

const CITY_PARAM: SearchParam = Object.freeze({
  Field: 'tuseraddresses.city^varchar',
  Relationship: 'or',
  Criteria: 'Springfield',
  Condition: 'Equals',
});

const defaultStoredCriteria: StoredSearchCriteria = Object.freeze({
  paramArray: [...paramArray],
  inActive,
  paramCategories,
  paramGroups,
  membersOnly,
  visitorStatus,
});

const lastNameStoredCriteria: StoredSearchCriteria = Object.freeze({
  ...defaultStoredCriteria,
  paramArray: [LAST_NAME_PARAM],
  inActive: '0',
});

export const advancedSearchDefaultCriteria: SessionSearchCriteria = Object.freeze({
  ...defaultStoredCriteria,
  paramCount,
  paramCircuit,
});

export const advancedSearchLastNameCriteria: SessionSearchCriteria = Object.freeze({
  ...lastNameStoredCriteria,
  paramCount: 1,
  paramCircuit: 'cUsers',
});

export const advancedSearchTwoRowCriteria: SessionSearchCriteria = Object.freeze({
  ...advancedSearchLastNameCriteria,
  paramArray: [LAST_NAME_PARAM, CITY_PARAM],
  paramCount: 2,
});

// `groups` stays empty: the advanced search view reads no group option.
export const advancedSearchDefaultAnswer: AdvancedSearchPage = Object.freeze({
  items: tenantASystemUsersPage.items.slice(),
  nextn: tenantASystemUsersPage.nextn,
  listUnassignedUsers: [],
  criteria: defaultStoredCriteria,
  groups: [],
});

export const advancedSearchLastNameAnswer: AdvancedSearchPage = Object.freeze({
  items: SMITH_ROWS.slice(),
  nextn: TWO_MATCHES_NEXTN,
  listUnassignedUsers: [],
  criteria: lastNameStoredCriteria,
  groups: [],
});
