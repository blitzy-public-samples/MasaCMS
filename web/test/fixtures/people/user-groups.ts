import type { components } from '@/generated/clients/people';
import { GROUP_IDS, adminGroupMembers, editorGroupMembers, groupsById, tenantAAdminGroupMembers } from '../identity/groups';

type UserGroupsPage = components['schemas']['UserGroupsPageV2'];
type GroupListRow = components['schemas']['GroupListRow'];

const RECORDS_PER_PAGE = 25;
const PAGE_BUFFER = 3;
const UMBRELLA_MEMBER_COUNT = 3;

/** A flag column of a stored group fixture, which never holds posted text. */
function storedFlag(value: number | string | null | undefined): number | null {
  if (typeof value === 'string') throw new TypeError(`Stored group flag ${value} is not a number`);
  return value ?? null;
}

/** The `getUserGroups` row of an identity group fixture, with its pool member count (null for none). */
function listRow(groupId: string, Counter: number | null): GroupListRow {
  const group = groupsById[groupId];
  if (group === undefined) throw new RangeError(`No identity group fixture ${groupId}`);
  return Object.freeze({
    UserID: group.UserID,
    Email: group.Email ?? null,
    GroupName: group.GroupName ?? null,
    Type: group.Type,
    LastLogin: group.LastLogin ?? null,
    LastUpdate: group.LastUpdate ?? null,
    LastUpdateBy: group.LastUpdateBy ?? null,
    LastUpdateByID: group.LastUpdateByID ?? null,
    Counter,
    Perm: storedFlag(group.Perm),
    isPublic: storedFlag(group.isPublic),
  });
}

/** People's `listUserGroupsV2` answer for `startrow=1&recordsperpage=25`: every row fits page 1, with `utility.getNextN` paging (page buffer 3). */
function firstPageOf(items: GroupListRow[]): UserGroupsPage {
  const totalrecords = items.length;
  const numberofpages = Math.ceil(totalrecords / RECORDS_PER_PAGE);
  const next = RECORDS_PER_PAGE + 1;
  return Object.freeze({
    items,
    nextn: Object.freeze({
      totalrecords,
      recordsperpage: RECORDS_PER_PAGE,
      numberofpages,
      currentpagenumber: 1,
      firstpage: 1,
      lastpage: Math.min(1 + 2 * PAGE_BUFFER, numberofpages),
      next: next > totalrecords ? 1 : next,
      previous: 1,
      through: totalrecords < next ? totalrecords : next - 1,
      startrow: 1,
    }),
  });
}

export const defaultPrivateGroupsPage: UserGroupsPage = firstPageOf([
  listRow(GROUP_IDS.defaultAdmin, adminGroupMembers.length),
  listRow(GROUP_IDS.defaultEditor, editorGroupMembers.length),
]);

export const tenantAPrivateGroupsPage: UserGroupsPage = firstPageOf([
  listRow(GROUP_IDS.tenantAAdmin, tenantAAdminGroupMembers.length),
  listRow(GROUP_IDS.archiveViewer, null),
  listRow(GROUP_IDS.galleryCurator, null),
  listRow(GROUP_IDS.galleryUploader, null),
  listRow(GROUP_IDS.libraryApprover, null),
  listRow(GROUP_IDS.libraryWriter, null),
  listRow(GROUP_IDS.recordsClerk, null),
  listRow(GROUP_IDS.studioManager, null),
  listRow(GROUP_IDS.teamMember, null),
  listRow(GROUP_IDS.teamPrimaryLead, null),
  listRow(GROUP_IDS.teamSecondaryLead, null),
]);

export const tenantAPublicGroupsPage: UserGroupsPage = firstPageOf([
  listRow(GROUP_IDS.umbrellaMembers, UMBRELLA_MEMBER_COUNT),
]);

export const emptyGroupsPage: UserGroupsPage = firstPageOf([]);
