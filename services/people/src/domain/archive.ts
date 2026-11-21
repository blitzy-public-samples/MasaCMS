// The person archive of the people fixture (legacy-fixtures/cfml/modules/people.cfc): POST stores the archive record with its
// `people.person.archived.v1` outbox row, GET reads the record; errors carry the fixture envelope's types.
import { LegacyApiError, cfDateTimeFormat, javaTrim, sqlServerDatetime } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { PeopleEvents } from '../events/publish.js';
import { DuplicateArchiveError, type AuditActor, type PeopleRepository } from '../repo/repository.js';
import type { PersonArchiveRow, PersonRow } from '../repo/tables.js';
import type { PersonFence } from './person-fence.js';

const EFFECTIVE_FROM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** SQL Server `datetime`'s first year, the fixture's `effectiveFrom` floor. */
const DATETIME_FIRST_YEAR = 1753;
/** The `envelope.rows` date-time mask. */
const FIXTURE_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss";
/** `left(getFullName(), 50)` of `archived_by`. */
const ARCHIVED_BY_WIDTH = 50;

/** A validated archive request. */
export interface ArchiveInput {
  /** The route's person id as given; it is stored as `person_id`, as the fixture stores it. */
  userId: string;
  /** First archived day, `yyyy-mm-dd`. */
  effectiveFrom: string;
}

/** The fixture's response `data`: the five `person_archive` columns, dates as `yyyy-mm-ddTHH:nn:ss`. */
export interface ArchiveRecord {
  archiveid: string;
  personid: string;
  siteid: string;
  effectivefrom: string;
  archivedat: string;
}

/** Collaborators of the archive; `fence` is the roster protocol's per-user fence (roster-protocol.ts `personFence`). */
export interface ArchiveDeps {
  db: TenantDb;
  repo: PeopleRepository;
  events: Pick<PeopleEvents, 'publishPersonArchived'>;
  clock: Clock;
  fence: PersonFence;
}

/** Arguments of `archivePerson`; `tenantId` is the tenant of the user pool holding the person, `actor` the session user. */
export interface ArchiveArgs {
  tenantId: string;
  input: ArchiveInput;
  actor?: AuditActor;
}

/** Local midnight of a `yyyy-mm-dd` day, as CFML `createDate` gives it. */
function localMidnight(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date);
}

/** True when `text` is a `yyyy-mm-dd` calendar day from 1753 on; the round trip rejects day and month rollover. */
function isCalendarDay(text: string): boolean {
  if (!EFFECTIVE_FROM_PATTERN.test(text)) return false;
  const [year, month, date] = text.split('-').map(Number) as [number, number, number];
  const day = localMidnight(text);
  return year >= DATETIME_FIRST_YEAR && day.getMonth() === month - 1 && day.getDate() === date;
}

/** The found person's site id, trimmed as `user.getSiteID()` holds it; a missing person, or one whose blank site id matches no user pool, is `notFound`. */
function requirePersonSite(person: PersonRow | null): string {
  const siteId = javaTrim(person?.siteid ?? '');
  if (siteId === '') throw new LegacyApiError('notFound');
  return siteId;
}

/** `left(getFullName(), 50)`: the session user's first and last name, trimmed, then cut to 50 code units. */
function archivedBy(actor: AuditActor): string {
  return javaTrim(`${actor.fname ?? ''} ${actor.lname ?? ''}`).slice(0, ARCHIVED_BY_WIDTH);
}

/** The response record of a stored archive row. */
function archiveRecord(row: PersonArchiveRow): ArchiveRecord {
  return {
    archiveid: row.archive_id,
    personid: row.person_id,
    siteid: row.siteid,
    effectivefrom: cfDateTimeFormat(row.effective_from, FIXTURE_TIMESTAMP_MASK),
    archivedat: cfDateTimeFormat(row.archived_at, FIXTURE_TIMESTAMP_MASK),
  };
}

/** The archive input of `userId`; `params` is keyed by lower-cased name. Throws `invalidParameters` unless `effectiveFrom` is a `yyyy-mm-dd` calendar day from 1753 on. */
export function parseArchiveInput(userId: string, params: ReadonlyMap<string, unknown>): ArchiveInput {
  const effectiveFrom = params.get('effectivefrom');
  if (typeof effectiveFrom !== 'string' || !isCalendarDay(effectiveFrom)) throw new LegacyApiError('invalidParameters');
  return { userId, effectiveFrom };
}

/**
 * Archives the person from `input.effectiveFrom`: the record and its `people.person.archived.v1` outbox row commit in one
 * transaction of `tenantId`. Throws `notFound` for a person the tenant does not hold and `badRequest` for one already archived.
 * @returns the stored record as the fixture's response `data`.
 */
export async function archivePerson(deps: ArchiveDeps, { tenantId, input, actor }: ArchiveArgs): Promise<ArchiveRecord> {
  const write: WriteContext = { origin: 'target', actorUserId: actor?.userId };
  try {
    return await deps.fence.withPersonsOpen(
      deps.db,
      tenantId,
      async (tx) => {
        await deps.fence.fencePersons(tx, [input.userId]);
        const siteid = requirePersonSite(await deps.repo.findPerson(tx, input.userId));
        const archive = await deps.repo.insertPersonArchive(
          tx,
          {
            person_id: input.userId,
            siteid,
            effective_from: localMidnight(input.effectiveFrom),
            // The fixture's `now()` lands in a `datetime` column, which keeps 1/300 s.
            archived_at: sqlServerDatetime(deps.clock.now()),
            archived_by_id: actor?.userId ?? null,
            archived_by: actor === undefined ? null : archivedBy(actor),
          },
          write,
        );
        await deps.events.publishPersonArchived(tx, archive);
        return archiveRecord(archive);
      },
      { clock: deps.clock },
    );
  } catch (err) {
    if (err instanceof DuplicateArchiveError) throw new LegacyApiError('badRequest');
    throw err;
  }
}

/** The person's archive record, first by effective date as the fixture's GET reads it; throws `notFound` when the tenant holds no such person or the person has no record. */
export async function getPersonArchive(deps: ArchiveDeps, { tenantId, userId }: { tenantId: string; userId: string }): Promise<ArchiveRecord> {
  const archive = await deps.fence.withPersonsOpen(
    deps.db,
    tenantId,
    async (tx) => {
      await deps.fence.fencePersons(tx, [userId]);
      requirePersonSite(await deps.repo.findPerson(tx, userId));
      return deps.repo.findPersonArchive(tx, userId);
    },
    { clock: deps.clock },
  );
  if (archive === null) throw new LegacyApiError('notFound');
  return archiveRecord(archive);
}
