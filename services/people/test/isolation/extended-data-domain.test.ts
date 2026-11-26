/** User extended attributes: a validate, save, read and delete round trip through the people repository on a throwaway `people` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  EXTEND_CONFIG_DEFAULTS,
  deleteExtendedData,
  extendSetData,
  loadSubmittedAttributes,
  saveExtendedData,
  validateExtendedData,
} from '../../src/domain/extended-data.js';
import { normaliseParams } from '../../src/domain/person.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { EXTEND_ATTRIBUTE, EXTEND_SET, EXTEND_SUBTYPE, PEOPLE_UNITS } from '../../src/repo/tables.js';

const TENANT = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const WRITE: WriteContext = { actorUserId: 'ACTOR', requestId: 'REQ-1' };

const available = await pgAvailable();

describe.skipIf(!available)('extended data through the people repository on PostgreSQL', () => {
  let handle: ThrowawaySchema | undefined;
  let db: TenantDb;
  let repo: PeopleRepository;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    db = handle.app;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'extended-data-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'extended-data-test', state: 'open' });
    repo = createPeopleRepository({ clock: fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0)), schema: handle.schema });
    await inTenant(async (tx) => {
      await repo.insert(tx, EXTEND_SUBTYPE.table, { subtypeid: 'ST-USER', siteid: SITE, basetable: 'tusers', type: 'User', subtype: 'Default' });
      await repo.insert(tx, EXTEND_SET.table, { extendsetid: 'SET-A', subtypeid: 'ST-USER', siteid: SITE, orderno: 1 });
      const attributes = [
        [1, 'Nickname', null, null],
        [2, 'Birthday', 'Date', null],
        [3, 'Shoe', 'Numeric', null],
        [4, 'Team', null, 'Blue'],
      ] as const;
      for (const [attributeid, name, validation, defaultvalue] of attributes) {
        await repo.insert(tx, EXTEND_ATTRIBUTE.table, { attributeid, extendsetid: 'SET-A', siteid: SITE, name, type: 'TextBox', validation, orderno: attributeid, defaultvalue });
      }
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(TENANT, fn);
  }

  it('validates, saves, reads back and deletes a person\'s values over CHAR(35) set ids', async () => {
    const userId = cfUuid();
    const input = normaliseParams({ extendSetID: 'set-a', ext1: 'Pat', birthday: '06/30/2026', shoe: '9.5' });

    const attributes = await inTenant((tx) => loadSubmittedAttributes(repo, tx, 'set-a', SITE, { forSave: false }));
    expect(validateExtendedData(attributes, input, EXTEND_CONFIG_DEFAULTS)).toStrictEqual({});

    const saved = await inTenant((tx) => saveExtendedData(repo, tx, userId, input, { siteId: SITE, config: EXTEND_CONFIG_DEFAULTS, write: WRITE }));
    expect(saved.map((row) => [row.attributeid, row.siteid, row.attributevalue, row.datetimevalue, row.numericvalue])).toStrictEqual([
      [1, SITE, 'Pat', null, null],
      [2, SITE, "{ts '2026-06-30 00:00:00'}", new Date(2026, 5, 30), null],
      [3, SITE, '9.5', null, 10],
    ]);

    const read = await inTenant((tx) => extendSetData(repo, tx, userId, { siteId: SITE, type: 'User', subtype: 'Default' }));
    expect(read.entries).toStrictEqual([['Nickname', 'Pat'], ['Birthday', new Date(2026, 5, 30)], ['Shoe', '9.5'], ['Team', 'Blue']]);

    expect(await inTenant((tx) => deleteExtendedData(repo, tx, userId, { write: WRITE }))).toBe(3);
    expect(await inTenant((tx) => repo.listExtendData(tx, [userId]))).toStrictEqual([]);
  });
});
