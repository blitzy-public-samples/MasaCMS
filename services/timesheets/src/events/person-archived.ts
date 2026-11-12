// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheets' consumer of `people.person.archived.v1`, which blacks out the archived person's open days in each destination tenant. */
import type { ConsumerDefinition } from '@opt2/platform/events';
import { applyBlackout } from '../domain/blackout.js';
import type { PersonArchivedPayload } from '../generated/events/people.person.archived.v1.js';
import { createTimesheetsRepository, type TimesheetsRepository } from '../repo/repository.js';

/** Topic of people's person-archive event. */
export const PERSON_ARCHIVED_TOPIC = 'people.person.archived.v1';

/** What the person-archived consumer writes through. */
export interface PersonArchivedConsumerDeps {
  repository: TimesheetsRepository;
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
