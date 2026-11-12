/** People's topics and outbox producer: topic names and validators, payload builders, versions, held rows, archives and the state events of migration applies. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import {
  closeGates,
  ensureUnitGates,
  openGates,
  requestMigrationAuthority,
  type AppliedChange,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { OutboxPayloadError, createOutbox, releaseOperation } from '@opt2/platform/outbox';
import { newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createCapturingPublisher, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createPeopleEvents, personArchivedPayload, personChangedPayload, type PeopleEvents } from '../../src/events/publish.js';
import {
  GROUP_CHANGED_TOPIC,
  PEOPLE_TOPICS,
  PERSON_ARCHIVED_TOPIC,
  PERSON_CHANGED_TOPIC,
  SITE_CHANGED_TOPIC,
  groupChangedSchema,
  peoplePayloadValidators,
  personArchivedSchema,
  personChangedSchema,
  siteChangedSchema,
} from '../../src/events/topics.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { ADDRESS, PEOPLE_UNITS, PERSON, type PersonArchiveRow, type PersonRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const NOW_TEXT = '2026-06-30 10:00:00.000';
const CLOCK = fixedClock(NOW);
const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/** Whether `payload` satisfies the compiled contract of `topic`. */
function conforms(topic: string, payload: unknown): boolean | undefined {
  return peoplePayloadValidators[topic]?.validatePayload(payload).ok;
}

/** A stored person row as pg returns it, with `overrides` applied. */
function personRow(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    tenant_id: TENANT_A.tenantId,
    userid: cfUuid(),
    groupname: null,
    fname: 'Pat',
    lname: 'Lee',
    email: 'pat@example.com',
    company: null,
    jobtitle: null,
    mobilephone: null,
    website: null,
    subtype: 'Default',
    ext: null,
    contactform: null,
    lastupdate: NOW,
    lastupdateby: 'Ada Admin',
    lastupdatebyid: 'ACTOR',
    siteid: TENANT_A.siteId,
    subscribe: 1,
    notes: null,
    description: null,
    interests: null,
    keepprivate: 0,
    photofileid: null,
    imname: null,
    imservice: null,
    created: NOW,
    tags: null,
    row_version: '1',
    ...overrides,
  };
}

describe('people topics', () => {
  it('names the produced topics and compiles their contracts with their declared kinds', () => {
    expect(PEOPLE_TOPICS).toStrictEqual([PERSON_CHANGED_TOPIC, PERSON_ARCHIVED_TOPIC]);
    expect([PERSON_CHANGED_TOPIC, PERSON_ARCHIVED_TOPIC, GROUP_CHANGED_TOPIC, SITE_CHANGED_TOPIC]).toStrictEqual([
      'people.person.changed.v1',
      'people.person.archived.v1',
      'identity.group.changed.v1',
      'programs-sites.site.changed.v1',
    ]);
    expect(Object.keys(peoplePayloadValidators)).toStrictEqual([...PEOPLE_TOPICS]);
    expect(PEOPLE_TOPICS.map((topic) => peoplePayloadValidators[topic]?.meta)).toStrictEqual([
      { kind: 'state' },
      { kind: 'process', fanout: 'userPool' },
    ]);
    expect(Object.isFrozen(peoplePayloadValidators)).toBe(true);
  });

  it.each([
    ['people person changed', personChangedSchema, 'urn:opt2:people:event:people.person.changed.v1'],
    ['people person archived', personArchivedSchema, 'urn:opt2:people:event:people.person.archived.v1'],
    ['identity group changed', groupChangedSchema, 'urn:opt2:identity:event:identity.group.changed.v1'],
    ['programs-sites site changed', siteChangedSchema, 'urn:opt2:programs-sites:event:programs-sites.site.changed.v1'],
  ])('reads the %s schema from its producer contracts', (_label, schema, id) => {
    expect(schema.$id).toBe(id);
    expect(schema.$comment).toBe('source-sha: 696383140578f8dea3ece26f80cd7bfb370ddf0f');
  });
});

describe('person payloads', () => {
  it('carries every people-owned column of the stored row under its contract name, timestamps as local text', () => {
    const row = personRow({ ext: 12, notes: 'n', tags: 'red,blue', lastupdate: new Date(2026, 5, 30, 11, 15, 30, 250) });

    const payload = personChangedPayload(row, { deleted: false });

    expect(Object.keys(payload)).toStrictEqual(personChangedSchema.required);
    expect(payload).toMatchObject({ userId: row.userid, siteId: TENANT_A.siteId, deleted: false, ext: 12, notes: 'n', tags: 'red,blue' });
    expect([payload.created, payload.lastUpdate]).toStrictEqual([NOW_TEXT, '2026-06-30 11:15:30.250']);
    expect(conforms(PERSON_CHANGED_TOPIC, payload)).toBe(true);
  });

  it.each<[string, Record<'created' | 'lastupdate', string | null>, Record<'created' | 'lastUpdate', string | null>]>([
    ['timestamp text as stored', { created: '2020-01-02 03:04:05.006', lastupdate: '2021-01-02 03:04:05.000' }, { created: '2020-01-02 03:04:05.006', lastUpdate: '2021-01-02 03:04:05.000' }],
    ['null timestamps as null', { created: null, lastupdate: null }, { created: null, lastUpdate: null }],
  ])('keeps %s', (_label, times, expected) => {
    const row = { ...personRow(), ...times } as unknown as PersonRow;

    const payload = personChangedPayload(row, { deleted: true });

    expect(payload).toMatchObject({ ...expected, deleted: true });
    expect(conforms(PERSON_CHANGED_TOPIC, payload)).toBe(true);
  });

  it('leaves a person without a site id to the payload contract', () => {
    const payload = personChangedPayload(personRow({ siteid: null }), { deleted: false });

    expect(payload.siteId).toBe('');
    expect(conforms(PERSON_CHANGED_TOPIC, payload)).toBe(false);
  });

  it.each<[string, Record<'effective_from' | 'archived_at', Date | string>, string, string]>([
    ['Date values', { effective_from: new Date(2026, 6, 1, 0, 0, 0, 0), archived_at: NOW }, '2026-07-01 00:00:00.000', NOW_TEXT],
    ['text values', { effective_from: '2026-07-01 00:00:00.000', archived_at: '2026-06-30 09:59:59.999' }, '2026-07-01 00:00:00.000', '2026-06-30 09:59:59.999'],
  ])('builds an archive payload from %s', (_label, times, effectiveFrom, archivedAt) => {
    const archive = { tenant_id: TENANT_A.tenantId, archive_id: cfUuid(), person_id: cfUuid(), siteid: TENANT_A.siteId, archived_by_id: null, archived_by: null, ...times };

    const payload = personArchivedPayload(archive as unknown as PersonArchiveRow);

    expect(payload).toStrictEqual({ personId: archive.person_id, siteId: TENANT_A.siteId, effectiveFrom, archiveId: archive.archive_id, archivedAt });
    expect(conforms(PERSON_ARCHIVED_TOPIC, payload)).toBe(true);
  });
});

interface StoredEvent {
  topic: string;
  kind: string;
  held: boolean;
  envelope: { aggregateType: string; aggregateId: string; aggregateVersion: number; payload: Record<string, unknown> };
}

const available = await pgAvailable();

describe.skipIf(!available)('people events against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: PeopleRepository;
  let events: PeopleEvents;
  const capture = createCapturingPublisher();

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'events-publish-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'events-publish-test', state: 'open' });
    repo = createPeopleRepository({ clock: CLOCK, schema: handle.schema });
    const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'people', db: handle.app, publisher: capture, logger, clock: CLOCK, payloadValidators: peoplePayloadValidators });
    events = createPeopleEvents(repo);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    capture.clear();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(TENANT_A.tenantId, fn);
  }

  /** The tenant's committed outbox rows of `aggregateId` in write order. */
  async function outboxRows(aggregateId: string): Promise<StoredEvent[]> {
    return inTenant(
      async (tx) =>
        (await tx.query<StoredEvent>(`SELECT topic, kind, held, envelope FROM ${handle.schema}.outbox WHERE ordering_key = $1 ORDER BY seq`, [aggregateId])).rows,
    );
  }

  /** Number of the tenant's committed outbox rows. */
  async function outboxCount(): Promise<number> {
    return inTenant(async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${handle.schema}.outbox`)).rows[0]?.n));
  }

  /** The write context a migration apply of `origin` passes, with its migration authority. */
  function migrationWrite(origin: WriteContext['origin']): WriteContext {
    const store = { ...newRequestContext(), service: { name: 'migration', roles: [Roles.platformMigration] } };
    const authority = runWithRequestContext(store, () => requestMigrationAuthority());
    expect(authority).toBeDefined();
    return { origin, authority, requestId: `batch-${String(origin)}` };
  }

  /** One applied change of tenant A; a delete carries `image` as its before-image. */
  function change(unit: string, table: string, op: AppliedChange['op'], image: Record<string, unknown>, origin: AppliedChange['origin'] = 'backfill'): AppliedChange {
    return { unit, table, op, ...(op === 'delete' ? { before: image } : { after: image }), origin, tenantId: TENANT_A.tenantId };
  }

  function personInput(overrides: Partial<PersonInput> = {}): PersonInput {
    return {
      userid: cfUuid(),
      groupname: '',
      fname: 'Pat',
      lname: 'Lee',
      email: 'pat@example.com',
      company: '',
      jobtitle: '',
      mobilephone: '',
      website: '',
      subtype: 'Default',
      contactform: '',
      lastupdateby: 'Ada Admin',
      lastupdatebyid: 'ACTOR',
      siteid: TENANT_A.siteId,
      subscribe: 1,
      notes: '',
      description: '',
      interests: '',
      keepprivate: 0,
      photofileid: '',
      imname: '',
      imservice: '',
      tags: '',
      ...overrides,
    };
  }

  it('writes a person state at its row_version and a delete one past it, publishing each after commit', async () => {
    const person = await inTenant(async (tx) => {
      const created = await repo.insertPerson(tx, personInput());
      const envelope = await events.publishPersonChanged(tx, created);
      expect(envelope).toMatchObject({ tenantId: TENANT_A.tenantId, aggregateType: 'person', aggregateId: created.userid, aggregateVersion: 1, producer: 'people' });
      expect(envelope?.payload).toStrictEqual(personChangedPayload(created, { deleted: false }));
      expect(envelope?.payload.created).toBe(NOW_TEXT);
      expect(capture.published).toStrictEqual([]);
      return created;
    });
    expect(capture.published.map((entry) => [entry.topic, entry.envelope.aggregateVersion])).toStrictEqual([[PERSON_CHANGED_TOPIC, 1]]);

    const removed = await inTenant((tx) => events.publishPersonChanged(tx, person, { deleted: true, origin: 'target' }));

    expect(removed).toMatchObject({ aggregateVersion: 2, payload: { deleted: true, userId: person.userid } });
    expect((await outboxRows(person.userid)).map((row) => [row.kind, row.held, row.envelope.aggregateVersion])).toStrictEqual([
      ['state', false, 1],
      ['state', false, 2],
    ]);
    expect(capture.published).toHaveLength(2);
  });

  it('holds a roster operation event until the operation is released', async () => {
    const operationId = cfUuid();
    const person = await inTenant(async (tx) => {
      const created = await repo.insertPerson(tx, personInput());
      await events.publishPersonChanged(tx, created, { operationId });
      return created;
    });
    expect(capture.published).toStrictEqual([]);
    expect((await outboxRows(person.userid)).map((row) => row.held)).toStrictEqual([true]);

    await inTenant((tx) => releaseOperation(tx, operationId));

    expect(capture.published.map((entry) => entry.envelope.aggregateId)).toStrictEqual([person.userid]);
    expect((await outboxRows(person.userid)).map((row) => row.held)).toStrictEqual([false]);
  });

  it('rejects a person without a site id through the payload contract, writing nothing', async () => {
    const person = personRow({ siteid: null });

    await expect(inTenant((tx) => events.publishPersonChanged(tx, person))).rejects.toBeInstanceOf(OutboxPayloadError);
    expect(await outboxRows(person.userid)).toStrictEqual([]);
    expect(capture.published).toStrictEqual([]);
  });

  it('writes an archive at the person current row_version, or at 1 when the tenant holds no person row', async () => {
    const effectiveFrom = new Date(2026, 6, 1, 0, 0, 0, 0);
    const { person, archive, envelope } = await inTenant(async (tx) => {
      const created = await repo.insertPerson(tx, personInput());
      await repo.updatePerson(tx, created.userid, { ...personInput({ userid: created.userid, fname: 'Patricia' }) });
      const stored = await repo.insertPersonArchive(tx, { person_id: created.userid, siteid: TENANT_A.siteId, effective_from: effectiveFrom, archived_by_id: null, archived_by: null });
      return { person: created, archive: stored, envelope: await events.publishPersonArchived(tx, stored) };
    });

    expect(envelope).toMatchObject({ aggregateType: 'person', aggregateId: person.userid, aggregateVersion: 2 });
    expect(envelope?.payload).toStrictEqual({
      personId: person.userid,
      siteId: TENANT_A.siteId,
      effectiveFrom: '2026-07-01 00:00:00.000',
      archiveId: archive.archive_id,
      archivedAt: NOW_TEXT,
    });
    expect((await outboxRows(person.userid)).map((row) => [row.topic, row.kind])).toStrictEqual([[PERSON_ARCHIVED_TOPIC, 'process']]);

    const orphanId = cfUuid();
    const orphan = await inTenant(async (tx) => {
      const stored = await repo.insertPersonArchive(tx, { person_id: orphanId, siteid: TENANT_A.siteId, effective_from: effectiveFrom, archived_by_id: null, archived_by: null });
      return events.publishPersonArchived(tx, stored);
    });
    expect(orphan).toMatchObject({ aggregateId: orphanId, aggregateVersion: 1 });
    expect(orphan?.payload.archivedAt).toMatch(LOCAL_TIMESTAMP);
    expect(capture.published.map((entry) => entry.topic)).toStrictEqual([PERSON_ARCHIVED_TOPIC, PERSON_ARCHIVED_TOPIC]);
  });

  it('advances row_version for each applied person upsert and writes its state, then the delete one past the before-image', async () => {
    const write = migrationWrite('backfill');
    const userid = cfUuid();
    const seed = { userid, fname: 'Mig', lname: 'Rated', siteid: TENANT_A.siteId, subscribe: 0 };

    for (const [op, fname] of [['insert', 'Mig'], ['update', 'Migrated']] as const) {
      await inTenant(async (tx) => {
        const applied = await repo.upsert<PersonRow>(tx, PERSON.table, { ...seed, fname }, write);
        await events.emitStateEvents(tx, change(PERSON.unit, PERSON.table, op, applied), write);
      });
    }
    const stored = await inTenant((tx) => repo.findPerson(tx, userid));
    expect(stored?.row_version).toBe('2');

    await inTenant(async (tx) => {
      const before = await repo.delete<PersonRow>(tx, PERSON.table, { userid }, write);
      await events.emitStateEvents(tx, change(PERSON.unit, PERSON.table, 'delete', before as PersonRow), write);
    });

    const rows = await outboxRows(userid);
    expect(rows.map((row) => [row.topic, row.envelope.aggregateVersion, row.envelope.payload.fname, row.envelope.payload.deleted])).toStrictEqual([
      [PERSON_CHANGED_TOPIC, 1, 'Mig', false],
      [PERSON_CHANGED_TOPIC, 2, 'Migrated', false],
      [PERSON_CHANGED_TOPIC, 3, 'Migrated', true],
    ]);
    expect(capture.published).toHaveLength(3);
  });

  it('writes no event for an applied change of another people unit', async () => {
    const write = migrationWrite('migration-feed');
    const address = { addressid: cfUuid(), userid: cfUuid(), siteid: TENANT_A.siteId };
    const before = await outboxCount();

    await inTenant(async (tx) => {
      const applied = await repo.upsert(tx, ADDRESS.table, address, write);
      await events.emitStateEvents(tx, change(ADDRESS.unit, ADDRESS.table, 'insert', applied, 'migration-feed'), write);
    });

    expect(await outboxCount()).toBe(before);
    expect(capture.published).toStrictEqual([]);
  });

  it('throws for an applied person missing from its transaction and for a change without a row image', async () => {
    const write = migrationWrite('backfill');
    const ghost = personRow({ row_version: '0' });

    await expect(inTenant((tx) => events.emitStateEvents(tx, change(PERSON.unit, PERSON.table, 'update', ghost), write))).rejects.toThrow(
      `Applied person ${ghost.userid} is missing from its apply transaction`,
    );
    await expect(
      inTenant((tx) => events.emitStateEvents(tx, { unit: PERSON.unit, table: PERSON.table, op: 'delete', origin: 'backfill', tenantId: TENANT_A.tenantId }, write)),
    ).rejects.toThrow('Applied delete on people.person carries no row image');
    expect(await outboxRows(ghost.userid)).toStrictEqual([]);
  });
});
