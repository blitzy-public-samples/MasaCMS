import type { components } from '@/generated/clients/people';
import { GROUP_IDS, adminGroupMembers, editorGroupMembers, groupsById, tenantAAdminGroupMembers } from '../identity/groups';

type UserGroupsPage = components['schemas']['UserGroupsPage'];
type GroupListRow = components['schemas']['GroupListRow'];

const RECORDS_PER_PAGE = 25;
const PAGE_BUFFER = 3;
const UMBRELLA_MEMBER_COUNT = 3;

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
    Perm: group.Perm ?? null,
    isPublic: group.isPublic ?? null,
  });
}

/** People's answer for `startrow=1&recordsperpage=25`: every row, with `utility.getNextN` paging (page buffer 3). */
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
  listRow(GROUP_IDS.communicationsSender, null),
  listRow(GROUP_IDS.esignatureAuditor, null),
  listRow(GROUP_IDS.esignatureSigner, null),
  listRow(GROUP_IDS.financeApprover, null),
  listRow(GROUP_IDS.financePreparer, null),
  listRow(GROUP_IDS.reportingExporter, null),
  listRow(GROUP_IDS.surveysManager, null),
  listRow(GROUP_IDS.timesheetsEmployee, null),
  listRow(GROUP_IDS.timesheetsPrimaryApprover, null),
  listRow(GROUP_IDS.timesheetsSecondaryApprover, null),
]);

export const tenantAPublicGroupsPage: UserGroupsPage = firstPageOf([
  listRow(GROUP_IDS.umbrellaMembers, UMBRELLA_MEMBER_COUNT),
]);

export const emptyGroupsPage: UserGroupsPage = firstPageOf([]);
