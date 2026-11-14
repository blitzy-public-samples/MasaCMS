import type { operations } from '@/generated/clients/people';
import type { FakeRoute } from '../../helpers/fake-gateway';

type UsersCsvResponse = operations['downloadUsersCsv']['responses'][200];

export const USERS_CSV_FILENAME = 'users.csv';

export const USERS_CSV_HEADERS = Object.freeze({
  // ACF 2023 adds the charset to dsp_download.cfm's cfcontent type="text/csv".
  'content-type': 'text/csv; charset=UTF-8' satisfies keyof UsersCsvResponse['content'],
  'content-disposition': 'attachment;filename=users.csv' satisfies UsersCsvResponse['headers']['Content-Disposition'],
});

export const TENANT_A_USERS_CSV_BODY =
  '"ADMIN","EMAIL","FNAME","GROUPNAME","ISPUBLIC","LASTUPDATE","LASTUPDATEBY","LNAME","S2","SITEID","SUBTYPE","TYPE",' +
  '"USERID","USERNAME"\n' +
  '" ","tenant_a_admin@example.com ","Tessa "," ",0 ,"2026-03-02 11:00:00.0 ","Admin User ","Admin ",0 ,"tenant-a ",' +
  '"Default ",2 ,"5A000000-0000-0000-0000000000000003 ","tenant_a_admin "\n' +
  '" ","alex_doe@example.com ","Alex "," ",0 ,"2026-04-14 09:05:00.0 ","Tessa Admin ","Doe ",0 ,"tenant-a ",' +
  '"Default ",2 ,"7C1E0A03-4B2D-4E6F-8A9B0C1D2E3F4A03 ","alex_doe "\n' +
  '" ","sam_lee@example.com ","Sam "," ",0 ,"2026-05-21 16:40:00.0 ","Tessa Admin ","Lee ",0 ,"tenant-a ",' +
  '"Default ",2 ,"7C1E0A04-4B2D-4E6F-8A9B0C1D2E3F4A04 ","sam_lee "\n' +
  '" ","pat_rivera@example.com ","Pat "," ",0 ,"2026-06-03 10:15:00.0 ","Admin User ","Rivera ",0 ,"tenant-a ",' +
  '"Default ",2 ,"7C1E0A05-4B2D-4E6F-8A9B0C1D2E3F4A05 ","pat_rivera "\n' +
  '" ","jane_smith@example.com ","Jane "," ",0 ,"2026-10-29 14:20:00.0 ","Tessa Admin ","Smith ",0 ,"tenant-a ",' +
  '"Default ",2 ,"7C1E0A01-4B2D-4E6F-8A9B0C1D2E3F4A01 ","jane_smith "\n' +
  '" ","john_smith@example.com ","John "," ",0 ,"2026-06-18 08:50:00.0 ","Tessa Admin ","Smith ",0 ,"tenant-a ",' +
  '"Default ",2 ,"7C1E0A02-4B2D-4E6F-8A9B0C1D2E3F4A02 ","john_smith "\n' +
  '" ","casey_taylor@example.com ","Casey "," ",0 ,"2026-06-30 07:45:00.0 ","Admin User ","Taylor ",0 ,"tenant-a ",' +
  '"Default ",2 ,"7C1E0A06-4B2D-4E6F-8A9B0C1D2E3F4A06 ","casey_taylor "\n';

export const ADVANCED_SEARCH_CSV_BODY =
  '"COMPANY","CONTACTFORM","CREATED","DESCRIPTION","EMAIL","FNAME","GROUPNAME","IMNAME","IMSERVICE","INACTIVE",' +
  '"INTERESTS","ISPUBLIC","JOBTITLE","KEEPPRIVATE","LASTLOGIN","LASTUPDATE","LASTUPDATEBY","LASTUPDATEBYID","LNAME",' +
  '"MOBILEPHONE","NOTES","PASSWORDCREATED","PERM","PHOTOFILEEXT","PHOTOFILEID","REMOTEID","S2","SITEID","SUBSCRIBE",' +
  '"SUBTYPE","TABLIST","TAGS","TYPE","USERID","USERNAME","WEBSITE"\n' +
  '"Example Widgets, LLC "," ","2026-02-16 09:30:00.0 "," ","jane_smith@example.com ","Jane "," "," "," ",0 ,' +
  '" ",0 ,"Analyst ",0 ,"2026-10-30 08:12:00.0 ","2026-10-29 14:20:00.0 ","Tessa Admin ",' +
  '"5A000000-0000-0000-0000000000000003 ","Smith ",' +
  '" "," ","2026-02-16 09:30:00.0 ",0 ," "," "," ",0 ,"tenant-a ",1 ,' +
  '"Default "," "," ",2 ,"7C1E0A01-4B2D-4E6F-8A9B0C1D2E3F4A01 ","jane_smith "," "\n' +
  '" "," ","2026-03-09 13:05:00.0 "," ","john_smith@example.com ","John "," "," "," ",0 ,' +
  '" ",0 ," ",0 ," ","2026-06-18 08:50:00.0 ","Tessa Admin ",' +
  '"5A000000-0000-0000-0000000000000003 ","Smith ",' +
  '" "," ","2026-03-09 13:05:00.0 ",0 ," "," "," ",0 ,"tenant-a ",0 ,' +
  '"Default "," "," ",2 ,"7C1E0A02-4B2D-4E6F-8A9B0C1D2E3F4A02 ","john_smith "," "\n';

export const PASSWORD_COLUMN_QUIRK_CSV_BODY =
  '"EMAIL","FNAME","LNAME","USERID","USERNAME"\n' +
  '"jane_smith@example.com ","Jane ","Smith ","not-a-real-hash ","7C1E0A01-4B2D-4E6F-8A9B0C1D2E3F4A01 ","jane_smith "\n' +
  '"john_smith@example.com ","John ","Smith ","not-a-real-hash ","7C1E0A02-4B2D-4E6F-8A9B0C1D2E3F4A02 ","john_smith "\n';

export const tenantAUsersCsv = Object.freeze({
  status: 200,
  headers: USERS_CSV_HEADERS,
  body: TENANT_A_USERS_CSV_BODY,
}) satisfies FakeRoute;

export const advancedSearchCsv = Object.freeze({
  status: 200,
  headers: USERS_CSV_HEADERS,
  body: ADVANCED_SEARCH_CSV_BODY,
}) satisfies FakeRoute;

export const passwordColumnQuirkCsv = Object.freeze({
  status: 200,
  headers: USERS_CSV_HEADERS,
  body: PASSWORD_COLUMN_QUIRK_CSV_BODY,
}) satisfies FakeRoute;
