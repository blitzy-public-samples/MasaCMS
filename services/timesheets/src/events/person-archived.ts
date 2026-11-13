// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheets' consumer of `people.person.archived.v1`, which blacks out the archived person's open days in each destination tenant. */
import type { ConsumerDefinition } from '@opt2/platform/events';
import { registryEntryForTenant } from '@opt2/platform/tenancy';
import { applyBlackout } from '../domain/blackout.js';
import type { PersonArchivedPayload } from '../generated/events/people.person.archived.v1.js';
import { createTimesheetsRepository, type TimesheetsRepository } from '../repo/repository.js';

/** Topic of people's person-archive event. */
export const PERSON_ARCHIVED_TOPIC = 'people.person.archived.v1';

/** What the person-archived consumer writes through. */
export interface PersonArchivedConsumerDeps {
  repository: TimesheetsRepository;
}

/** Aggregate type of people's person events. */
const PERSON_AGGREGATE_TYPE = 'person';

/** A site id in SQL Server's case-insensitive equality form: trailing spaces are insignificant, leading ones are not. */
function siteKey(siteId: string): string {
  return siteId.replace(/ +$/, '').toLowerCase();
}

// The contract carries `timestamp(3)` wall-clock text while the blackout domain takes Dates; ISO date-time text without an
// offset parses as local time, the Date pg writes back as that same wall-clock value in the process zone.
function localDate(text: string): Date {
  return new Date(text.replace(' ', 'T'));
}

/** Consumer that applies the archive's blackouts, written at the archive's own time as the fixture passes it to `usp_person_archived_blackout`. */
export function createPersonArchivedConsumer({ repository }: PersonArchivedConsumerDeps): ConsumerDefinition<PersonArchivedPayload> {
  return {
    topic: PERSON_ARCHIVED_TOPIC,
    kind: 'process',
    fanout: 'userPool',
    // Bound to the envelope tenant, never tx.tenantId: a user-pool member destination has its own site, not the person's.
    async checkTenant(tx, { tenantId, aggregateType, aggregateId, payload }) {
      if (aggregateType !== PERSON_AGGREGATE_TYPE || aggregateId !== payload.personId) {
        return false;
      }
      const origin = await registryEntryForTenant(tx, tenantId);
      if (origin === null) {
        return 'invalid-tenant';
      }
      return siteKey(origin.siteId) === siteKey(payload.siteId);
    },
    async apply(tx, envelope) {
      const { personId, effectiveFrom, archiveId, archivedAt } = envelope.payload;
      await applyBlackout(tx, repository, {
        personId,
        effectiveFrom: localDate(effectiveFrom),
        archiveId,
        now: localDate(archivedAt),
      });
    },
  };
}

/** The consumer over a default timesheets repository, for tests and contract checks. */
export const personArchivedConsumer = createPersonArchivedConsumer({ repository: createTimesheetsRepository() });
