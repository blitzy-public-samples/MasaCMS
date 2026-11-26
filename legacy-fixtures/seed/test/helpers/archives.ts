// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { SiteKey } from '../../src/config.js';
import { datasetDigest, type Dataset } from '../../src/dataset.js';
import type { FixtureRow } from '../../src/fixture-tables.js';
import { stableId } from '../../src/ids.js';

export const ARCHIVE_KEY = 'synthetic.person_archive';

/** Person archive rows, as the people fixture writes them, for the system users after each site's admin; sites in the given order. */
export function archiveRows(dataset: Dataset, perSite: readonly (readonly [SiteKey, number])[]): FixtureRow[] {
  return perSite.flatMap(([siteID, count]) => {
    const [admin, ...persons] = dataset.masa.users.filter((user) => user.siteID === siteID && user.isPublic === 0);
    if (admin === undefined || persons.length < count) throw new RangeError(`${siteID} has fewer than ${count} system users to archive`);
    return persons.slice(0, count).map(
      (person, i): FixtureRow => ({
        archive_id: stableId('archive', siteID, i),
        person_id: person.userID,
        siteID,
        effective_from: '2026-06-30T00:00:00.000',
        archived_at: '2026-06-29T12:30:00.000',
        archived_by_id: i % 2 === 0 ? admin.userID : null,
        archived_by: i % 2 === 0 ? `${admin.fname} ${admin.lname}`.slice(0, 50) : null,
      }),
    );
  });
}

/** `dataset` whose person archive holds `rows`, with its digest recomputed. */
export function withArchives(dataset: Dataset, rows: FixtureRow[]): Dataset {
  const fixtures = { ...dataset.fixtures, [ARCHIVE_KEY]: rows };
  return { ...dataset, fixtures, digest: datasetDigest({ ...dataset, fixtures }) };
}
