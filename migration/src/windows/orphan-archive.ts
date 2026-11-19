// The orphan archive probe: whether a legacy 404 render can delete a `tcontentfilenamearchive` row (standardEventsHandler.cfc:459-499).
import sql from 'mssql';

import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';

import type { LegacyDb } from '../legacy/legacy-db.js';

/** Most filenames one probe binds, as `OrphanArchiveProbeRequest` declares. */
export const ORPHAN_PROBE_MAX_FILENAMES = 1000;

/** Longest filename one probe binds, as `OrphanArchiveProbeRequest` declares. */
export const ORPHAN_PROBE_MAX_FILENAME_LENGTH = 4000;

/** Content types `contentDAO.readActive` loads (contentDAO.cfc:246); an active row of any other type reads as no content. */
const ACTIVE_CONTENT_TYPES = ['Page', 'Folder', 'File', 'Calendar', 'Link', 'Gallery', 'Component', 'Form', 'Variation', 'Module'];

/** The probe over `count` filenames bound as `@f0`…: an archive row in any site whose content `getActiveContent` cannot read. */
export function orphanArchiveSql(count: number): string {
  const filenames = Array.from({ length: count }, (_, index) => `@f${String(index)}`).join(', ');
  const types = ACTIVE_CONTENT_TYPES.map((type) => `'${type}'`).join(', ');
  return (
    `select top (1) 1 as n from tcontentfilenamearchive a where a.filename in (${filenames}) ` +
    'and not exists (select 1 from tcontent c where c.ContentID = a.contentID and c.SiteID = a.siteID ' +
    `and c.Active = 1 and c.Type in (${types}))`
  );
}

/** The live legacy database could not be read; the route answers the legacy 503. */
export class OrphanArchiveUnavailableError extends LegacyServiceUnavailableError {
  override readonly name: string = 'OrphanArchiveUnavailableError';

  constructor(override readonly cause: unknown) {
    super('The orphan archive probe could not read the live legacy database', 'auto', 'orphan-archive-unavailable');
  }
}

/** Whether any of `filenames` names an orphan archive row on the live database, compared under its collation; throws OrphanArchiveUnavailableError. */
export async function hasOrphanArchive(legacy: Pick<LegacyDb, 'live'>, filenames: readonly string[]): Promise<boolean> {
  if (filenames.length === 0) return false;
  try {
    const request = (await legacy.live()).request();
    filenames.forEach((filename, index) => request.input(`f${String(index)}`, sql.NVarChar(ORPHAN_PROBE_MAX_FILENAME_LENGTH), filename));
    const result = await request.query<{ n: number }>(orphanArchiveSql(filenames.length));
    return result.recordset.length > 0;
  } catch (error) {
    throw new OrphanArchiveUnavailableError(error);
  }
}
