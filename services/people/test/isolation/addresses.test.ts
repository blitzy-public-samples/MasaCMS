/** The stored address order listAddresses reads over a throwaway `people` schema. */
import { describe, expect, it } from 'vitest';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { listAddresses } from '../../src/domain/addresses.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import type { AddressRow } from '../../src/repo/tables.js';
import { TEST_CLOCK } from '../helpers/app.js';
import { PG_AVAILABLE, withPgApp } from '../helpers/pg-app.js';
import { addressRow, personRow, seedPeople } from '../helpers/fixtures.js';

const A = TENANT_A.tenantId;

describe.skipIf(!PG_AVAILABLE)('listAddresses against PostgreSQL', () => {
  // SQL Server 2022 returns isPrimary NULL, 0, 1, 0 in addressID order as 1, 0, 0, NULL with the last 0 first.
  it("lists the user's addresses as SQL Server's unstable sort of isPrimary desc leaves them, a NULL isPrimary last", async () => {
    const owner = personRow();
    const id = (n: number): string => `B0000000-0000-0000-000000000000000${String(n)}`;
    const own = [
      addressRow({ addressid: id(1), userid: owner.userid, isprimary: null }),
      addressRow({ addressid: id(2), userid: owner.userid, isprimary: 0 }),
      addressRow({ addressid: id(3), userid: owner.userid, isprimary: 1 }),
      addressRow({ addressid: id(4), userid: owner.userid, isprimary: 0 }),
    ];
    const outcome = await withPgApp(async ({ db }) => {
      await seedPeople(db, {
        [A]: { persons: [owner], addresses: [...own, addressRow({ addressid: id(5), isprimary: 1 })] },
        [TENANT_B.tenantId]: { addresses: [addressRow({ addressid: id(6), userid: owner.userid, siteid: TENANT_B.siteId, isprimary: 1 })] },
      });
      const repo = createPeopleRepository({ clock: TEST_CLOCK, schema: db.schema });
      return withTenant(db, A, (tx) => listAddresses(repo, tx, owner.userid));
    });
    expect(outcome).not.toHaveProperty('skipped');
    expect((outcome as AddressRow[]).map((row) => [row.addressid, row.isprimary])).toEqual([
      [id(3), 1],
      [id(4), 0],
      [id(2), 0],
      [id(1), null],
    ]);
  });
});
