/** Known legacy issues people reproduces as legacy shows them: new users default to Member, and the admin date mask prints the day of year. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { cfLsDateFormat } from '@opt2/platform/legacy-compat';
import { fixedClock, seedRegistry } from '@opt2/platform/testing';
import { USER_BEAN_DEFAULTS, newUserValues } from '../../src/domain/person.js';
import { TEST_CLOCK, buildTestApp, userHeaders, type RecordingDb, type TestApp } from '../helpers/app.js';
import { SITE_ADMIN_A, accountFor, personRow, seedPeople } from '../helpers/fixtures.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};

/** The path of the contract's GET operation `operationId`. */
function getPath(operationId: string): string {
  const found = Object.entries(OPENAPI.paths).find(([, item]) => item.get?.operationId === operationId);
  if (found === undefined) throw new Error(`contracts/openapi.yaml declares no GET ${operationId}`);
  return found[0];
}

/** en_US `session.dateKeyFormat`, which the cusers lists pass to LSDateFormat. */
const DATE_KEY_FORMAT = 'MM/DD/YYYY';
const SITE = SITE_ADMIN_A.site;
const INSERT_COLUMNS = /^INSERT INTO \S+(?: AS \w+)? \(([^)]*)\)/;

/** Makes `select` answer the rows `insert` statements stored, of the tenant bound to `$1`. */
function storeRows(db: RecordingDb, insert: RegExp, select: RegExp): void {
  const rows: Record<string, unknown>[] = [];
  db.respond(insert, (text, values) => {
    const columns = (INSERT_COLUMNS.exec(text)?.[1] ?? '').split(',').map((column) => column.trim().replaceAll('"', ''));
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    rows.push(row);
    return [row];
  });
  db.respond(select, (_text, values) => rows.filter((row) => row.tenant_id === values[0]));
}

describe('known legacy issues', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
    storeRows(t.db, /^INSERT INTO people\.tenant_registry /, /FROM people\.tenant_registry WHERE tenant_id = \$1$/);
    storeRows(t.db, /^INSERT INTO "people"\."person" /, /FROM "people"\."person" WHERE tenant_id = \$1 /);
    await seedRegistry(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  describe('the user form defaults to Member', () => {
    it('keeps ispublic=1 in the userBean.init defaults and in every new bean', () => {
      expect(USER_BEAN_DEFAULTS.ispublic).toBe(1);
      expect(newUserValues(TEST_CLOCK).ispublic).toBe(1);
    });

    it('defaults a new user to Member (ispublic=1) as legacy does', async () => {
      const res = await t.app.inject({ method: 'GET', url: `${getPath('getUserEdit')}?siteid=${SITE}`, headers: await userHeaders(SITE_ADMIN_A) });

      expect(res.statusCode).toBe(200);
      // tempIsPublic 1 checks the "Site Member" radio of the Edit User form.
      expect(res.json()).toMatchObject({ isNew: true, tempIsPublic: 1, user: { isPublic: 1 } });
    });
  });

  describe('the admin date mask shows the day of year', () => {
    it.each([
      { at: new Date(2026, 9, 29, 14, 5), stamp: '2026-10-29T14:05:00.000', shown: '10/302/2026' },
      { at: new Date(2026, 0, 5, 14, 5), stamp: '2026-01-05T14:05:00.000', shown: '01/05/2026' },
    ])('lists LastUpdate $stamp unformatted, which the dateKeyFormat mask renders as $shown', async ({ at, stamp, shown }) => {
      const person = personRow({ siteid: SITE, lastupdate: at });
      await seedPeople(t.db, { [person.tenant_id]: { persons: [person] } }, { clock: fixedClock(at) });
      t.identity.seedAccounts(accountFor(person));

      const res = await t.app.inject({ method: 'GET', url: `${getPath('listUsers')}?siteid=${SITE}&ispublic=0`, headers: await userHeaders(SITE_ADMIN_A) });

      expect(res.statusCode).toBe(200);
      const row = res.json<{ items: Array<Record<string, unknown>> }>().items.find((item) => item.UserID === person.userid);
      // getUsers selects no `created`, so LastUpdate is the one date the user list masks.
      expect(row?.LastUpdate).toBe(stamp);
      // A LocalTimestamp without an offset parses as the same local wall-clock time.
      expect(cfLsDateFormat(new Date(String(row?.LastUpdate)), DATE_KEY_FORMAT)).toBe(shown);
    });
  });
});
