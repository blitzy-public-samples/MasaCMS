/** A legacy-window person delete through `/internal/v1/migration/apply` over PostgreSQL drops the person's ownerless split rows. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, encodeRow, type ApplyRequest, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A } from '@opt2/platform/testing';
import { personMapping } from '../../src/migration/mappings/index.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import { headersFor, TEST_CLOCK } from '../helpers/app.js';
import { PG_AVAILABLE, withPgApp } from '../helpers/pg-app.js';

const TENANT = TENANT_A.tenantId;
const TUSERS_COLUMNS: CanonicalColumn[] = [...personMapping.legacyColumns, { name: 'Type', type: 'i' }];
/** The target-authoritative units legacy's user delete window holds (gateway/cutover/versions/v0002.json). */
const WINDOW_UNITS = ['people.person', 'people.user_tag', 'people.extend_data_user_activity', 'people.trash'];
const WINDOW = 'window-ownerless-test';
/** Each person's rows in the tables whose rows follow their owner's Type. */
const OWNED_SQL = {
  user_address: 'SELECT count(*)::int AS n FROM <s>.user_address WHERE userid = $1',
  user_interest: 'SELECT count(*)::int AS n FROM <s>.user_interest WHERE userid = $1',
  user_favorite: 'SELECT count(*)::int AS n FROM <s>.user_favorite WHERE userid = $1',
  user_tag: 'SELECT count(*)::int AS n FROM <s>.user_tag WHERE userid = $1',
  extend_data_user_activity:
    'SELECT count(*)::int AS n FROM <s>.extend_data_user_activity WHERE baseid = $1 OR baseid IN (SELECT addressid FROM <s>.user_address WHERE userid = $1)',
};

/** One tusers row of a Type=2 user, encoded as a window import sends it. */
function tusersBatch(op: 'upsert' | 'delete', origin: ApplyRequest['origin'], userId: string, fname: string): ApplyRequest {
  const values: Record<string, unknown> = { ...Object.fromEntries(TUSERS_COLUMNS.map((column) => [column.name, null])) };
  Object.assign(values, { UserID: userId, SiteID: TENANT_A.siteId, Type: 2, Fname: fname, Lname: 'Owner', subType: 'Default' });
  return {
    batchId: `people-ownerless-${randomUUID()}`,
    origin,
    legacyTable: personMapping.legacyTable,
    siteId: TENANT_A.siteId,
    columns: TUSERS_COLUMNS.map((column) => ({ ...column })),
    ...(origin === 'legacy-window' ? { units: ['people.person'], holderId: WINDOW } : {}),
    rows: [{ op, row: encodeRow(TUSERS_COLUMNS, values) }],
  };
}

describe.skipIf(!PG_AVAILABLE)('ownerless rows of a migration-applied person delete', () => {
  it("deletes the person's addresses with their extended data, interests, favorites, tags and extended data, under the window's held gates", async () => {
    const outcome = await withPgApp(async ({ app, db, schema }) => {
      const repo = createPeopleRepository({ clock: TEST_CLOCK, schema: db.schema });
      const headers = await headersFor('service:migration');
      const apply = async (body: ApplyRequest): Promise<unknown> => {
        const res = await app.inject({ method: 'POST', url: '/internal/v1/migration/apply', headers, payload: body });
        expect(res.statusCode, res.body).toBe(200);
        return res.json();
      };
      const owned = (userId: string): Promise<Record<string, number>> =>
        withTenant(db, TENANT, async (tx) => {
          const counts: Record<string, number> = {};
          for (const [table, sql] of Object.entries(OWNED_SQL)) {
            counts[table] = ((await tx.query<{ n: number }>(sql.replaceAll('<s>', schema.schema), [userId])).rows[0] as { n: number }).n;
          }
          return counts;
        });

      const [deleted, kept] = [cfUuid(), cfUuid()];
      for (const userId of [deleted, kept]) {
        await apply(tusersBatch('upsert', 'backfill', userId, 'Pat'));
        await withTenant(db, TENANT, async (tx) => {
          const address = await repo.insertAddress(tx, { userid: userId, isprimary: 1 });
          const values = { siteid: TENANT_A.siteId, attributevalue: 'v', remoteid: null, datetimevalue: null, numericvalue: null, stringvalue: 'v' };
          await repo.replaceExtendData(tx, address.addressid, [{ attributeId: 1, row: values }]);
          await repo.replaceExtendData(tx, userId, [{ attributeId: 2, row: values }]);
          await repo.replaceInterests(tx, userId, [cfUuid()]);
          await repo.replaceTags(tx, { userId, siteId: TENANT_A.siteId, tags: 'golden' });
          await repo.insertFavorite(tx, {
            favoriteid: cfUuid(),
            userid: userId,
            favoritename: 'Home',
            favorite: cfUuid(),
            type: 'Page',
            siteid: TENANT_A.siteId,
            datecreated: TEST_CLOCK.now(),
            columnnumber: null,
            rownumber: null,
            maxrssitems: null,
          });
        });
      }
      const every = { user_address: 1, user_interest: 1, user_favorite: 1, user_tag: 1, extend_data_user_activity: 2 };
      expect(await owned(deleted)).toEqual(every);

      await closeGates(db, { units: WINDOW_UNITS, holderId: WINDOW, phase: 'importing' });
      // A change that keeps the person keeps its rows.
      await apply(tusersBatch('upsert', 'legacy-window', deleted, 'Pam'));
      expect(await owned(deleted)).toEqual(every);
      expect(await apply(tusersBatch('delete', 'legacy-window', deleted, 'Pam'))).toMatchObject({ applied: 1, skipped: 0 });

      const none = { user_address: 0, user_interest: 0, user_favorite: 0, user_tag: 0, extend_data_user_activity: 0 };
      expect(await owned(deleted)).toEqual(none);
      expect(await owned(kept)).toEqual(every);
      const origins = await withTenant(db, TENANT, async (tx) =>
        (
          await tx.query<{ table: string; origin: string }>(
            `SELECT DISTINCT "table", origin FROM ${schema.schema}.changelog WHERE op = 'delete' ORDER BY "table"`,
          )
        ).rows,
      );
      expect(origins).toEqual(
        ['extend_data_user_activity', 'person', 'user_address', 'user_favorite', 'user_interest', 'user_tag'].map((table) => ({ table, origin: 'legacy-window' })),
      );
      return 'ran';
    });
    expect(outcome).toBe('ran');
  });
});
