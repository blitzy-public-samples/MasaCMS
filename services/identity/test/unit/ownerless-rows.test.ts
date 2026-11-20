/** A legacy-window group delete through `/internal/v1/migration/apply` over PostgreSQL drops the group's ownerless split rows. */
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, type ApplyRequest, type Mapping } from '@opt2/platform/migration-kit';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  tclassextenddatauseractivityGroupMapping,
  tuseraddressesGroupMapping,
  tusersfavoritesGroupMapping,
  tusersGroupAccountMapping,
  tusersinterestsGroupMapping,
  tuserstagsGroupMapping,
} from '../../src/migration/mappings/index.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { batchOf } from '../helpers/migration-batches.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PG_READY = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'].every((name) => Boolean(process.env[name])) && (await pgAvailable());
const SITE = TENANT_A.siteId;
/** The identity units legacy's group delete window holds in v0002 (gateway/cutover/versions/v0002.json). */
const WINDOW_UNITS = ['identity.extend_data_user_activity', 'identity.group_account', 'identity.oauth_token', 'identity.trash', 'identity.user_tag'];
const WINDOW = 'window-ownerless-group-test';
/** Each group's rows in the tables whose rows follow their owner's Type. */
const OWNED_SQL = {
  user_address: 'SELECT count(*)::int AS n FROM <s>.user_address WHERE userid = $1',
  user_interest: 'SELECT count(*)::int AS n FROM <s>.user_interest WHERE userid = $1',
  user_favorite: 'SELECT count(*)::int AS n FROM <s>.user_favorite WHERE userid = $1',
  user_tag: 'SELECT count(*)::int AS n FROM <s>.user_tag WHERE userid = $1',
  extend_data_user_activity:
    'SELECT count(*)::int AS n FROM <s>.extend_data_user_activity WHERE baseid = $1 OR baseid IN (SELECT addressid FROM <s>.user_address WHERE userid = $1)',
};

describe.skipIf(!PG_READY)('ownerless rows of a migration-applied group delete', () => {
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'identity', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    ({ app } = await buildTestApp({ db: schema.app }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  async function apply(body: ApplyRequest): Promise<unknown> {
    const res = await app.inject({ method: 'POST', url: '/internal/v1/migration/apply', headers: await headersFor('service:migration'), payload: body });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  function owned(groupId: string): Promise<Record<string, number>> {
    return withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
      const counts: Record<string, number> = {};
      for (const [table, sql] of Object.entries(OWNED_SQL)) {
        counts[table] = ((await tx.query<{ n: number }>(sql.replaceAll('<s>', schema.schema), [groupId])).rows[0] as { n: number }).n;
      }
      return counts;
    });
  }

  const group = (groupId: string, groupName: string) => ({ UserID: groupId, GroupName: groupName, Type: 1, SiteID: SITE, isPublic: 0 });

  it("deletes the group's addresses with their extended data, interests, favorites, tags and extended data, under the window's held gates", async () => {
    const [deleted, kept] = [cfUuid(), cfUuid()];
    for (const groupId of [deleted, kept]) {
      const addressId = cfUuid();
      const value = { siteID: SITE, attributeValue: 'v', stringvalue: 'v' };
      await apply(batchOf(tusersGroupAccountMapping, SITE, 'backfill', [{ op: 'upsert', values: group(groupId, 'Owners') }]));
      const children: Array<[Mapping, Record<string, unknown>]> = [
        [tuseraddressesGroupMapping, { addressID: addressId, userID: groupId, siteID: SITE, addressName: 'Primary', isPrimary: 1 }],
        [tclassextenddatauseractivityGroupMapping, { dataID: randomInt(1, 2 ** 31 - 1), baseID: addressId, attributeID: 1, ...value }],
        [tclassextenddatauseractivityGroupMapping, { dataID: randomInt(1, 2 ** 31 - 1), baseID: groupId, attributeID: 2, ...value }],
        [tusersinterestsGroupMapping, { userID: groupId, categoryID: cfUuid() }],
        [tuserstagsGroupMapping, { tagID: randomInt(1, 2 ** 31 - 1), userID: groupId, siteid: SITE, tag: 'golden' }],
        [
          tusersfavoritesGroupMapping,
          { favoriteID: cfUuid(), userID: groupId, favoriteName: 'Home', favorite: cfUuid(), type: 'Page', siteID: SITE, dateCreated: '2026-06-30 09:00:00' },
        ],
      ];
      for (const [mapping, values] of children) await apply(batchOf(mapping, SITE, 'backfill', [{ op: 'upsert', values, discriminator: 1 }]));
    }
    const every = { user_address: 1, user_interest: 1, user_favorite: 1, user_tag: 1, extend_data_user_activity: 2 };
    expect(await owned(deleted)).toEqual(every);

    await closeGates(schema.app, { units: WINDOW_UNITS, holderId: WINDOW, phase: 'importing', allowLegacy: true });
    // A change that keeps the group keeps its rows.
    await apply(batchOf(tusersGroupAccountMapping, SITE, 'legacy-window', [{ op: 'upsert', values: group(deleted, 'Renamed') }], WINDOW));
    expect(await owned(deleted)).toEqual(every);
    const removal = batchOf(tusersGroupAccountMapping, SITE, 'legacy-window', [{ op: 'delete', values: group(deleted, 'Renamed') }], WINDOW);
    expect(await apply(removal)).toMatchObject({ applied: 1, skipped: 0 });

    const none = { user_address: 0, user_interest: 0, user_favorite: 0, user_tag: 0, extend_data_user_activity: 0 };
    expect(await owned(deleted)).toEqual(none);
    expect(await owned(kept)).toEqual(every);
    const origins = await withTenant(schema.app, TENANT_A.tenantId, async (tx) =>
      (
        await tx.query<{ table: string; origin: string }>(
          `SELECT DISTINCT "table", origin FROM ${schema.schema}.changelog WHERE op = 'delete' AND request_id = $1 ORDER BY "table"`,
          [removal.batchId],
        )
      ).rows,
    );
    const tables = ['extend_data_user_activity', 'group_account', 'user_address', 'user_favorite', 'user_interest', 'user_tag'];
    expect(origins).toEqual(tables.map((table) => ({ table, origin: 'legacy-window' })));
  });
});
