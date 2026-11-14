/** search.ts refusals of denied feed join tables over recording doubles; the seeded reads are in test/isolation/search.test.ts. */
// Constants, nextN, criteria and queryParam parsing are held to legacy in search-criteria.test.ts, LIKE in search-like.test.ts,
// column matching and the 2100-row cap in search-queries.test.ts and search-pushdown.test.ts; this suite does not repeat them.
import { describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { DENIED_FEED_JOIN_TABLES, getAdvancedSearch, type SearchDeps } from '../../src/domain/search.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, createRecordingDb } from '../helpers/app.js';
import { createIdentityDouble } from '../helpers/identity-double.js';
import { SITE_ADMIN_A } from '../helpers/fixtures.js';
import { criteriaOf, viewerOf } from '../helpers/search-args.js';

describe('denied feed join tables', () => {
  const viewer = viewerOf(SITE_ADMIN_A);

  /** Search deps over a database and identity that record every call and answer nothing. */
  function recordingDeps() {
    const db = createRecordingDb();
    const identity = createIdentityDouble({ clock: TEST_CLOCK });
    const deps: SearchDeps = { db, repo: createPeopleRepository({ clock: TEST_CLOCK }), identity: identity.identityClient };
    return { db, identity, deps };
  }

  // The list starts with tusers, which isDeniedFeedTable exempts as the user feed's own table.
  it.each(DENIED_FEED_JOIN_TABLES.split(',').filter((table) => table !== 'tusers'))(
    'refuses a criterion on %s as authorization before any database or identity read',
    async (table) => {
      const { db, identity, deps } = recordingDeps();
      const criteria = criteriaOf([{ field: `${table}.userid^varchar`, relationship: 'and', criteria: 'x', condition: 'Equals' }]);
      const read = getAdvancedSearch(deps, viewer, criteria, { isPublic: 0 });
      await expect(read).rejects.toBeInstanceOf(LegacyApiError);
      await expect(read).rejects.toMatchObject({ type: 'authorization' });
      expect(db.statements()).toEqual([]);
      expect(identity.requests).toEqual([]);
    },
  );

  it("lets the feed's own tusers through to the site registry read", async () => {
    const { db, identity, deps } = recordingDeps();
    const criteria = criteriaOf([{ field: 'tusers.lname^varchar', relationship: 'and', criteria: 'x', condition: 'Equals' }]);
    // The recording database holds no registry row, so the read stops at the unregistered tenant's 503.
    await expect(getAdvancedSearch(deps, viewer, criteria, { isPublic: 0 })).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    expect(db.statements().some((statement) => /tenant_registry/.test(statement.text))).toBe(true);
    expect(identity.requests).toEqual([]);
  });
});
