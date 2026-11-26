/** The cUsers CSV downloads through the people app over PostgreSQL: legacy users-CSV bytes and headers per filter, the posted advanced search. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import type { UserHeadersInput } from '../helpers/app.js';
import { DOWNLOAD_SEARCH, DOWNLOAD_USERS, GET_SEARCH, SEARCH_HEADER, SET_SEARCH, USERS_HEADER, call } from '../helpers/csv-downloads.js';
import { PG_AVAILABLE, withPgApp, type PgTestApp } from '../helpers/pg-app.js';
import { ADMIN_S2, SITE_ADMIN_A, accountFor, accountsForSeed, personRow, seedPeople, type PeopleSeed } from '../helpers/fixtures.js';

const LEGACY_CSV_HEADERS = { 'content-disposition': 'attachment;filename=users.csv', 'content-type': 'text/csv; charset=UTF-8' };

const ADA = 'A1000000-0000-0000-0000000000000000';
const QUINN = 'A2000000-0000-0000-0000000000000000';
const CASEY = 'A3000000-0000-0000-0000000000000000';
const ROBIN = 'B1000000-0000-0000-0000000000000000';
const PAT = 'B2000000-0000-0000-0000000000000000';
const STAFF_GROUP = '6E000000-0000-0000-0000000000000001';

// Fixed ids keep every expected body a literal, which the fixture seed's generated ids would not.
// tenant-a's private pool: a numeric-only company, commas in a name and in lastupdateby, double quotes, a NULL email and lastupdateby.
const ADA_PERSON = personRow({ userid: ADA, fname: 'Ada', lname: 'Lovelace', email: 'ada@csv.test', company: '1842', lastupdateby: 'Admin, Ada' });
const QUINN_PERSON = personRow({ userid: QUINN, fname: 'Quinn "Q"', lname: 'Quote', email: null, lastupdateby: null });
const CASEY_PERSON = personRow({ userid: CASEY, fname: 'Casey', lname: 'Comma, Jr.', email: 'casey@csv.test', company: 'Engines, Ltd.' });
// tenant-a's public pool `umbrella`: one last name, so first names decide the order against userid order.
const ROBIN_PERSON = personRow({ userid: ROBIN, siteid: TENANT_UMBRELLA.siteId, fname: 'Robin', lname: 'Member', email: 'robin@csv.test' });
const PAT_PERSON = personRow({ userid: PAT, siteid: TENANT_UMBRELLA.siteId, fname: 'Pat', lname: 'Member', email: 'pat@csv.test' });

const SEED: PeopleSeed = {
  [TENANT_A.tenantId]: { persons: [ADA_PERSON, QUINN_PERSON, CASEY_PERSON] },
  [TENANT_UMBRELLA.tenantId]: { persons: [ROBIN_PERSON, PAT_PERSON] },
};

const CASEY_USERS_LINE =
  '" ","casey@csv.test ","Casey "," ",0 ,"2026-06-30 12:00:00.0 ","System ","Comma, Jr. ",0 ,"tenant-a ","Default ",2 ,' +
  '"A3000000-0000-0000-0000000000000000 ","casey "\n';
const ADA_USERS_LINE =
  '" ","ada@csv.test ","Ada "," ",0 ,"2026-06-30 12:00:00.0 ","Admin, Ada ","Lovelace ",0 ,"tenant-a ","Default ",2 ,' +
  '"A1000000-0000-0000-0000000000000000 ","ada "\n';
const QUINN_USERS_LINE =
  '" "," ","Quinn "Q" "," ",0 ,"2026-06-30 12:00:00.0 "," ","Quote ",0 ,"tenant-a ","Default ",2 ,' +
  '"A2000000-0000-0000-0000000000000000 ",007 \n';
const PAT_USERS_LINE =
  '" ","pat@csv.test ","Pat "," ",1 ,"2026-06-30 12:00:00.0 ","System ","Member ",0 ,"umbrella ","Default ",2 ,' +
  '"B2000000-0000-0000-0000000000000000 ","pat "\n';
const ROBIN_USERS_LINE =
  '" ","robin@csv.test ","Robin "," ",1 ,"2026-06-30 12:00:00.0 ","System ","Member ",0 ,"umbrella ","Default ",2 ,' +
  '"B1000000-0000-0000-0000000000000000 ","robin "\n';

const CASEY_SEARCH_LINE =
  '"Engines, Ltd. "," ","2026-06-30 12:00:00.0 "," ","casey@csv.test ","Casey "," "," "," ",0 ," ",0 ," ",0 ," ",' +
  '"2026-06-30 12:00:00.0 ","System "," ","Comma, Jr. "," "," "," ",0 ," "," "," ",0 ,"tenant-a ",0 ,"Default "," "," ",2 ,' +
  '"A3000000-0000-0000-0000000000000000 ","casey "," "\n';
const ADA_SEARCH_LINE =
  '1842 ," ","2026-06-30 12:00:00.0 "," ","ada@csv.test ","Ada "," "," "," ",0 ," ",0 ," ",0 ," ",' +
  '"2026-06-30 12:00:00.0 ","Admin, Ada "," ","Lovelace "," "," "," ",0 ," "," "," ",0 ,"tenant-a ",0 ,"Default "," "," ",2 ,' +
  '"A1000000-0000-0000-0000000000000000 ","ada "," "\n';

/** The data lines of a users CSV body, without the header line and the final newline's empty remainder. */
function dataLines(body: string): string[] {
  return body.split('\n').slice(1, -1);
}

describe.skipIf(!PG_AVAILABLE)('cUsers CSV downloads through the people app over PostgreSQL', () => {
  let pg: PgTestApp;
  let release: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let opened!: (ctx: PgTestApp) => void;
    const ready = new Promise<PgTestApp>((resolve) => {
      opened = resolve;
    });
    // The seeded schema stays open until afterAll; withPgApp drops it once its callback returns.
    const run = withPgApp(async (ctx) => {
      await seedPeople(ctx.db, SEED);
      ctx.identity.seedAccounts(...accountsForSeed(SEED));
      // Later views replace earlier ones: a numeric-only username, and the umbrella members' public accounts.
      ctx.identity.seedAccounts(
        accountFor(QUINN_PERSON, { username: '007' }),
        ...[ROBIN_PERSON, PAT_PERSON].map((person) => accountFor(person, { isPublic: 1 })),
      );
      ctx.identity.seedMemberships(ADA, [STAFF_GROUP]);
      ctx.identity.seedMemberships(CASEY, [STAFF_GROUP]);
      opened(ctx);
      await finished;
    });
    pg = await Promise.race([ready, run.then((result) => Promise.reject(new Error(`withPgApp ended early: ${JSON.stringify(result)}`)))]);
    release = async () => {
      finish();
      await run;
    };
  });

  afterAll(async () => {
    await release();
  });

  describe('downloadUsersCsv', () => {
    it.each([
      { filter: "the public pool's members, by last then first name", query: 'ispublic=1', body: USERS_HEADER + PAT_USERS_LINE + ROBIN_USERS_LINE },
      { filter: "the private pool's users, by last name", query: 'ispublic=0', body: USERS_HEADER + CASEY_USERS_LINE + ADA_USERS_LINE + QUINN_USERS_LINE },
      { filter: 'only the users without a group membership', query: 'ispublic=0&unassigned=1', body: USERS_HEADER + QUINN_USERS_LINE },
    ])('answers $filter as the legacy users CSV', async ({ query, body }) => {
      const res = await call(pg.app, 'GET', `${DOWNLOAD_USERS}?siteid=${TENANT_A.siteId}&${query}`, SITE_ADMIN_A);
      expect(res.status).toBe(200);
      expect(res.body).toBe(body);
    });

    it('answers the header line alone for a pool without users', async () => {
      const res = await call(pg.app, 'GET', `${DOWNLOAD_USERS}?siteid=${TENANT_B.siteId}&ispublic=0`, { ...ADMIN_S2, site: TENANT_B.siteId });
      expect(res.status).toBe(200);
      expect(res.body).toBe(USERS_HEADER);
    });

    it('keeps commas inside their quoted fields and a trailing space after every value', async () => {
      const { body } = await call(pg.app, 'GET', `${DOWNLOAD_USERS}?siteid=${TENANT_A.siteId}&ispublic=0`, SITE_ADMIN_A);
      expect(body).toContain(',"Comma, Jr. ",');
      expect(body).toContain(',"Admin, Ada ",');
      expect(body).not.toContain('**comma**');
      const lines = dataLines(body);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        // A closing qualifier or a bare number before a delimiter would mean a value without its trailing space.
        expect(`${line}\n`).not.toMatch(/[^ ]"[,\n]/);
        expect(`${line}\n`).not.toMatch(/[0-9][,\n]/);
      }
    });

    it("answers dsp_download's Content-Disposition and Content-Type values exactly", async () => {
      const res = await call(pg.app, 'GET', `${DOWNLOAD_USERS}?siteid=${TENANT_A.siteId}&ispublic=0`, SITE_ADMIN_A);
      expect(res.headers).toMatchObject(LEGACY_CSV_HEADERS);
    });
  });

  describe('downloadAdvancedSearchCsv', () => {
    it("downloads the session's posted criteria as getAdvancedSearch selects them", async () => {
      const searcher: UserHeadersInput = { ...SITE_ADMIN_A, sid: 'csv-downloads-advanced-search' };
      const query = `siteid=${TENANT_A.siteId}&ispublic=0`;
      const form = {
        muraAction: 'cUsers.advancedSearch',
        param: '1',
        paramField1: 'tusers.fname^varchar',
        paramRelationship1: 'and',
        paramCriteria1: 'a',
        paramCondition1: 'Contains',
        inActive: '0',
      };
      expect((await call(pg.app, 'POST', `${SET_SEARCH}?${query}`, searcher, form)).status).toBe(200);

      const page = await call(pg.app, 'GET', `${GET_SEARCH}?${query}`, searcher);
      const items = (JSON.parse(page.body) as { items: Array<{ UserID: string }> }).items;
      expect(items.map((row) => row.UserID)).toEqual([CASEY, ADA]);

      const res = await call(pg.app, 'GET', `${DOWNLOAD_SEARCH}?${query}`, searcher);
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject(LEGACY_CSV_HEADERS);
      expect(res.body).toBe(SEARCH_HEADER + CASEY_SEARCH_LINE + ADA_SEARCH_LINE);
    });
  });
});
