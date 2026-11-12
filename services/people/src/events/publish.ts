/** People's outbox producer of `people.person.changed.v1` and `people.person.archived.v1`; publishing is the platform outbox's flush and sweep. */
import type { EventEnvelope } from '@opt2/platform/events';
import type { AppliedChange, MigrationHandlerOptions } from '@opt2/platform/migration-kit';
import { localTimestamp, writeOutbox, type OutboxOrigin } from '@opt2/platform/outbox';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { PeopleRepository } from '../repo/repository.js';
import { PERSON, type PersonArchiveRow, type PersonRow } from '../repo/tables.js';
import { PERSON_ARCHIVED_TOPIC, PERSON_CHANGED_TOPIC, type PersonArchivedPayload, type PersonChangedPayload } from './topics.js';

/** Aggregate type of both people topics; the aggregate id is the person's user id. */
const PERSON_AGGREGATE = 'person';

/** Options of a person event; `operationId` holds the row until the operation is released. */
export interface PersonChangedOptions {
  deleted?: boolean;
  operationId?: string;
  origin?: OutboxOrigin;
}

/** Outbox writes of people's events in the caller's tenant transaction; each returns the stored envelope, or null when the origin suppresses it. */
export interface PeopleEvents {
  /** Writes a person's state at its `row_version`, or at `row_version + 1` from the before-image when `deleted`. */
  publishPersonChanged(tx: TenantTx, person: PersonRow, opts?: PersonChangedOptions): Promise<EventEnvelope<PersonChangedPayload> | null>;
  /** Writes one archive at the person's current `row_version`, or 1 when the tenant holds no person row. */
  publishPersonArchived(tx: TenantTx, archive: PersonArchiveRow): Promise<EventEnvelope<PersonArchivedPayload> | null>;
  /** Writes the person state event of one migration-applied `people.person` change in the apply transaction. */
  emitStateEvents: NonNullable<MigrationHandlerOptions['emitStateEvents']>;
}

/** `timestamp(3)` text of a stored value; pg yields a Date in the process zone, which `localTimestamp` formats back exactly. */
function timestampText(value: Date | string): string;
function timestampText(value: Date | string | null): string | null;
function timestampText(value: Date | string | null): string | null {
  return value instanceof Date ? localTimestamp(value) : value;
}

/** The `people.person.changed.v1` payload of a stored person row, values as stored. */
export function personChangedPayload(row: PersonRow, { deleted }: { deleted: boolean }): PersonChangedPayload {
  return {
    userId: row.userid,
    // A person without a site id has no contract form; '' makes the payload validator reject it.
    siteId: row.siteid ?? '',
    deleted,
    groupName: row.groupname,
    fname: row.fname,
    lname: row.lname,
    email: row.email,
    company: row.company,
    jobTitle: row.jobtitle,
    mobilePhone: row.mobilephone,
    website: row.website,
    subType: row.subtype,
    ext: row.ext,
    contactForm: row.contactform,
    subscribe: row.subscribe,
    notes: row.notes,
    description: row.description,
    interests: row.interests,
    keepPrivate: row.keepprivate,
    photoFileId: row.photofileid,
    imName: row.imname,
    imService: row.imservice,
    tags: row.tags,
    created: timestampText(row.created),
    lastUpdate: timestampText(row.lastupdate),
    lastUpdateBy: row.lastupdateby,
    lastUpdateById: row.lastupdatebyid,
  };
}

/** The `people.person.archived.v1` payload of a stored archive row. */
export function personArchivedPayload(archive: PersonArchiveRow): PersonArchivedPayload {
  return {
    personId: archive.person_id,
    siteId: archive.siteid,
    effectiveFrom: timestampText(archive.effective_from),
    archiveId: archive.archive_id,
    archivedAt: timestampText(archive.archived_at),
  };
}

/** The person row an applied change leaves: the before-image of a delete, the stored row otherwise. */
function appliedPerson(change: AppliedChange): PersonRow {
  const image = change.op === 'delete' ? change.before : change.after;
  if (image === undefined) {
    throw new Error(`Applied ${change.op} on ${change.unit} carries no row image`);
  }
  return image as PersonRow;
}

/** Builds people's event writers over `repository`, which holds the `people.person.row_version` aggregate versions. */
export function createPeopleEvents(repository: PeopleRepository): PeopleEvents {
  const publishPersonChanged: PeopleEvents['publishPersonChanged'] = (tx, person, opts = {}) => {
    const deleted = opts.deleted ?? false;
    return writeOutbox(tx, {
      topic: PERSON_CHANGED_TOPIC,
      kind: 'state',
      aggregateType: PERSON_AGGREGATE,
      aggregateId: person.userid,
      aggregateVersion: Number(person.row_version) + (deleted ? 1 : 0),
      payload: personChangedPayload(person, { deleted }),
      operationId: opts.operationId,
      origin: opts.origin,
    });
  };

  const publishPersonArchived: PeopleEvents['publishPersonArchived'] = async (tx, archive) => {
    // Archiving leaves the person row unchanged, so the event carries the person's current version.
    const person = await repository.findPerson(tx, archive.person_id);
    return writeOutbox(tx, {
      topic: PERSON_ARCHIVED_TOPIC,
      kind: 'process',
      aggregateType: PERSON_AGGREGATE,
      aggregateId: archive.person_id,
      aggregateVersion: person === null ? 1 : Number(person.row_version),
      payload: personArchivedPayload(archive),
    });
  };

  const emitStateEvents: PeopleEvents['emitStateEvents'] = async (tx, change, write) => {
    if (change.unit !== PERSON.unit) {
      return;
    }
    const person = appliedPerson(change);
    if (change.op === 'delete') {
      await publishPersonChanged(tx, person, { deleted: true, origin: change.origin });
      return;
    }
    // Applied upserts leave the target-only row_version as stored (0 for a new row, below the envelope minimum), so it is
    // advanced here; the update also returns the row without the window-phase wait a findPerson read would take.
    const bumped = await repository.update<PersonRow>(
      tx,
      PERSON.table,
      { userid: person.userid },
      { row_version: String(BigInt(person.row_version) + 1n) },
      write,
    );
    if (bumped === null) {
      throw new Error(`Applied person ${person.userid} is missing from its apply transaction`);
    }
    await publishPersonChanged(tx, bumped, { origin: change.origin });
  };

  return Object.freeze({ publishPersonChanged, publishPersonArchived, emitStateEvents });
}
