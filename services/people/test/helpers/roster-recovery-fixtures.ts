/** Roster-recovery fixtures shared by the offline and PostgreSQL recovery suites. */
import { TENANT_A } from '@opt2/platform/testing';
import type { BeforeImage } from '../../src/domain/roster-protocol.js';
import { RECOVERY_THRESHOLD_MS } from '../../src/domain/roster-recovery.js';
import type { AccountPrepareRequest } from '../../src/legacy/identity-client.js';
import type { PersonRow } from '../../src/repo/tables.js';

/** Age of a stale operation: just past the recovery threshold. */
export const STALE_MS = RECOVERY_THRESHOLD_MS + 1_000;

/** The account part of a roster update, as identity's prepare takes it. */
export const CHANGE: AccountPrepareRequest = {
  kind: 'update',
  siteId: TENANT_A.siteId,
  account: { UserName: 'jdoe', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 },
  groupIds: [],
};

/** The before-image a people commit stores for an update of `person`. */
export function imageOf(person: PersonRow): string {
  const image: BeforeImage = { existed: true, person, addresses: [], interests: [], tags: [], extendData: [] };
  return JSON.stringify(image);
}
