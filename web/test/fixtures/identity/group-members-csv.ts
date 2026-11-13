import type { operations } from '@/generated/clients/identity';
import type { FakeRoute } from '../../helpers/fake-gateway';
import { USER_IDS } from '../session';
import { MEMBER_USER_IDS } from './groups';

type GroupMembersCsvResponse = operations['downloadGroupMembers']['responses'][200];

export const GROUP_MEMBERS_CSV_FILENAME = 'users.csv';

export const GROUP_MEMBERS_CSV_HEADERS = Object.freeze({
  'content-type': 'text/csv; charset=UTF-8' satisfies keyof GroupMembersCsvResponse['content'],
  'content-disposition': 'attachment;filename=users.csv' satisfies GroupMembersCsvResponse['headers']['Content-Disposition'],
});

const GROUP_MEMBERS_CSV_HEADER_ROW =
  '"COMPANY","CONTACTFORM","CREATED","DESCRIPTION","EMAIL","FNAME","GROUPID","GROUPNAME","IMNAME","IMSERVICE",' +
  '"INACTIVE","INTERESTS","ISPUBLIC","JOBTITLE","KEEPPRIVATE","LASTLOGIN","LASTUPDATE","LASTUPDATEBY","LASTUPDATEBYID",' +
  '"LNAME","MOBILEPHONE","NOTES","PASSWORDCREATED","PERM","PHOTOFILEEXT","PHOTOFILEID","REMOTEID","S2","SITEID",' +
  '"SUBSCRIBE","SUBTYPE","TABLIST","TAGS","TYPE","USERID","USERNAME","WEBSITE"\n';

export const GROUP_MEMBERS_CSV_BODY =
  GROUP_MEMBERS_CSV_HEADER_ROW +
  `"Example, Inc. "," ","2026-02-01 08:30:00.0 "," ","avery_author@example.com ","Avery ",` +
  `"${MEMBER_USER_IDS.defaultAuthor} "," "," "," ",` +
  `0 ," ",0 ," ",0 ,"2026-10-29 16:45:00.0 ","2026-06-12 11:20:00.0 ","Admin User ","${USER_IDS.admin} ",` +
  `"Author "," "," ","2026-02-01 08:30:00.0 ",0 ," "," "," ",0 ,"default ",` +
  `1 ,"Default "," "," ",2 ,"${MEMBER_USER_IDS.defaultAuthor} ","avery_author "," "\n` +
  `" "," ","2026-02-10 10:00:00.0 "," ","qa_editor@example.com ","Quinn ","${USER_IDS.qaEditor} "," "," "," ",` +
  `0 ," ",0 ," ",0 ,"2026-06-30 08:15:00.0 ","2026-02-10 10:00:00.0 ","Admin User ","${USER_IDS.admin} ",` +
  `"Editor "," "," ","2026-02-10 10:00:00.0 ",0 ," "," "," ",0 ,"default ",` +
  `1 ,"Default "," "," ",2 ,"${USER_IDS.qaEditor} ","qa_editor "," "\n` +
  `" "," ","2026-04-20 14:00:00.0 "," ","no_sites_member@example.com ","Nadia ","${USER_IDS.noSitesUser} "," "," "," ",` +
  `0 ," ",1 ," ",0 ,"2026-06-30 09:00:00.0 ","2026-04-20 14:00:00.0 ","Admin User ","${USER_IDS.admin} ",` +
  `"Member "," "," ","2026-04-20 14:00:00.0 ",0 ," "," "," ",0 ,"default ",` +
  `0 ,"Default "," "," ",2 ,"${USER_IDS.noSitesUser} ","no_sites_member "," "\n`;

export const editorGroupMembersCsv = Object.freeze({
  status: 200,
  headers: GROUP_MEMBERS_CSV_HEADERS,
  body: GROUP_MEMBERS_CSV_BODY,
}) satisfies FakeRoute;

export const emptyGroupMembersCsv = Object.freeze({
  status: 200,
  headers: GROUP_MEMBERS_CSV_HEADERS,
  body: GROUP_MEMBERS_CSV_HEADER_ROW,
}) satisfies FakeRoute;
