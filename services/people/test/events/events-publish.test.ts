/** People's outbox producer against PostgreSQL: versions and tombstones, held rows, archives and the state events of migration applies. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import { consumeEnvelope, subscriptionName, type ConsumerDefinition, type DestinationResult, type EventEnvelope } from '@opt2/platform/events';
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
import { tenantRegistryConsumer, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createCapturingPublisher,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  registryPayloads,
  testEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createPeopleEvents, personChangedPayload, type PeopleEvents } from '../../src/events/publish.js';
import {
  PERSON_ARCHIVED_TOPIC,
  PERSON_CHANGED_TOPIC,
  SITE_CHANGED_TOPIC,
  peoplePayloadValidators,
  type PersonChangedPayload,
} from '../../src/events/topics.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { ADDRESS, PEOPLE_UNITS, PERSON, type PersonRow } from '../../src/repo/tables.js';
import { NOW, NOW_TEXT, personRow } from '../helpers/publish-rows.js';

const CLOCK = fixedClock(NOW);
const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

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
  const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'events-publish-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'events-publish-test', state: 'open' });
    repo = createPeopleRepository({ clock: CLOCK, schema: handle.schema });
    createOutbox({ service: 'people', db: handle.app, publisher: capture, logger, clock: CLOCK, payloadValidators: peoplePayloadValidators });
    events = createPeopleEvents(repo);
    // The consumer's tenant re-check needs tenant A in the registry.
    const site = registryPayloads().find((payload) => payload.siteId === TENANT_A.siteId);
    if (site === undefined) throw new Error('no registry fixture for tenant A');
    const registration = testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: site.siteId, payload: site });
    await consumeEnvelope(handle.app, tenantRegistryConsumer, registration, { subscription: subscriptionName('people', SITE_CHANGED_TOPIC), messageId: 'site', logger });
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

  /** Creates, updates, deletes and recreates one person through the repository, publishing each state; returns its user id. */
  async function domainLifecycle(): Promise<string> {
    const { userid } = await inTenant(async (tx) => {
      const created = await repo.insertPerson(tx, personInput());
      await events.publishPersonChanged(tx, created);
      return created;
    });
    await inTenant(async (tx) => {
      const updated = await repo.updatePerson(tx, userid, personInput({ userid, fname: 'Patricia' }));
      await events.publishPersonChanged(tx, updated as PersonRow);
    });
    await inTenant(async (tx) => {
      const before = await repo.delete<PersonRow>(tx, PERSON.table, { userid });
      await events.publishPersonChanged(tx, before as PersonRow, { deleted: true });
    });
    await inTenant(async (tx) => events.publishPersonChanged(tx, await repo.insertPerson(tx, personInput({ userid }))));
    return userid;
  }

  /** Upserts a mapped person `row` as a migration apply does: the stored row read first, the hook's row_version in the same write. */
  async function applyPerson(tx: TenantTx, row: Record<string, unknown> & { userid: string }, write: WriteContext): Promise<PersonRow> {
    const before = await repo.findByKey<PersonRow>(tx, PERSON.table, { userid: row.userid });
    const pending = { unit: PERSON.unit, table: PERSON.table, row, ...(before === null ? {} : { before }) };
    return repo.upsert<PersonRow>(tx, PERSON.table, { ...row, ...(await events.targetOnlyColumns(tx, pending, write)) }, write);
  }

  /** The same lifecycle as legacy-window applies through `targetOnlyColumns` and `emitStateEvents`; returns the user id. */
  async function migrationLifecycle(): Promise<string> {
    const write = migrationWrite('legacy-window');
    const userid = cfUuid();
    const seed = { userid, lname: 'Rated', siteid: TENANT_A.siteId, subscribe: 0 };
    for (const [op, fname] of [['insert', 'Mig'], ['update', 'Migrated'], ['delete', 'Migrated'], ['insert', 'Restored']] as const) {
      await inTenant(async (tx) => {
        const image =
          op === 'delete'
            ? await repo.delete<PersonRow>(tx, PERSON.table, { userid }, write)
            : await applyPerson(tx, { ...seed, fname }, write);
        await events.emitStateEvents(tx, change(PERSON.unit, PERSON.table, op, image as PersonRow, 'legacy-window'), write);
      });
    }
    return userid;
  }

  /** The tenant's person changelog rows of `userid` as op and columns, in write order. */
  async function personLog(userid: string): Promise<[string, string[]][]> {
    return inTenant(async (tx) => {
      const sql = `SELECT op, columns FROM ${handle.schema}.changelog WHERE "table" = 'person' AND key LIKE $1 ORDER BY seq`;
      return (await tx.query<{ op: string; columns: string[] }>(sql, [`%${userid}%`])).rows.map((row): [string, string[]] => [row.op, row.columns]);
    });
  }

  const lifecycles = { domain: domainLifecycle, migration: migrationLifecycle };
  const CONTACT_SUBSCRIPTION = subscriptionName('identity', PERSON_CHANGED_TOPIC);

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

  it('writes each applied person upsert at its next row_version in one changelog row and its state, then the delete one past the before-image', async () => {
    const write = migrationWrite('backfill');
    const userid = cfUuid();
    const seed = { userid, fname: 'Mig', lname: 'Rated', siteid: TENANT_A.siteId, subscribe: 0 };

    for (const [op, fname] of [['insert', 'Mig'], ['update', 'Migrated']] as const) {
      await inTenant(async (tx) => {
        const applied = await applyPerson(tx, { ...seed, fname }, write);
        await events.emitStateEvents(tx, change(PERSON.unit, PERSON.table, op, applied), write);
      });
    }
    const stored = await inTenant((tx) => repo.findPerson(tx, userid));
    expect(stored?.row_version).toBe('2');
    expect((await personLog(userid)).map(([op, columns]) => [op, op === 'insert' ? columns.at(-1) : columns])).toStrictEqual([
      ['insert', 'row_version'],
      ['update', ['fname', 'row_version']],
    ]);

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

  it.each([
    ['domain', 'target'],
    ['migration', 'legacy-window'],
  ] as const)('continues a person recreated through the %s path past its tombstone, at versions 1 to 4', async (path, origin) => {
    const userid = await lifecycles[path]();

    expect((await outboxRows(userid)).map((row) => [row.envelope.aggregateVersion, row.envelope.payload.deleted])).toStrictEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, false],
    ]);
    expect(capture.published).toHaveLength(4);
    expect(await inTenant((tx) => repo.personTombstoneVersion(tx, userid))).toBe('3');
    expect((await inTenant((tx) => repo.findPerson(tx, userid)))?.row_version).toBe('4');
    const log = await inTenant(async (tx) => {
      const sql = `SELECT op, origin FROM ${handle.schema}.changelog WHERE "table" = 'person_tombstone' AND key LIKE $1 ORDER BY seq`;
      return (await tx.query<{ op: string; origin: string }>(sql, [`%${userid}%`])).rows;
    });
    expect(log).toStrictEqual([{ op: 'insert', origin }]);
  });

  it.each([
    ['domain', 'the update late', [1, 3, 4, 2], ['applied', 'applied', 'applied', 'stale']],
    ['domain', 'the recreate before the delete', [1, 4, 3, 2], ['applied', 'applied', 'stale', 'stale']],
    ['migration', 'the update late', [1, 3, 4, 2], ['applied', 'applied', 'applied', 'stale']],
    ['migration', 'the recreate before the delete', [1, 4, 3, 2], ['applied', 'applied', 'stale', 'stale']],
  ] as const)('leaves a state consumer on the person recreated through the %s path when it receives %s', async (path, _order, versions, results) => {
    const userid = await lifecycles[path]();
    const stored = new Map((await outboxRows(userid)).map((row) => [row.envelope.aggregateVersion, row.envelope as unknown as EventEnvelope<PersonChangedPayload>]));
    const projection = new Map<string, { version: number; deleted: boolean }>();
    const contacts: ConsumerDefinition<PersonChangedPayload> = {
      topic: PERSON_CHANGED_TOPIC,
      kind: 'state',
      apply: (_tx, envelope) => {
        projection.set(envelope.aggregateId, { version: envelope.aggregateVersion, deleted: envelope.payload.deleted });
      },
    };

    const outcomes: DestinationResult[] = [];
    for (const version of versions) {
      const envelope = stored.get(version);
      if (envelope === undefined) throw new Error(`no outbox row at version ${version}`);
      const outcome = await consumeEnvelope(handle.app, contacts, envelope, { subscription: CONTACT_SUBSCRIPTION, messageId: envelope.eventId, logger });
      outcomes.push(...outcome.destinations.map((destination) => destination.result));
    }

    expect(outcomes).toStrictEqual(results);
    expect(projection.get(userid)).toStrictEqual({ version: 4, deleted: false });
  });

  it('writes no event for an applied change of another people unit', async () => {
    const write = migrationWrite('migration-feed');
    const address = { addressid: cfUuid(), userid: cfUuid(), siteid: TENANT_A.siteId };
    const before = await outboxCount();

    await inTenant(async (tx) => {
      expect(await events.targetOnlyColumns(tx, { unit: ADDRESS.unit, table: ADDRESS.table, row: address }, write)).toStrictEqual({});
      const applied = await repo.upsert(tx, ADDRESS.table, address, write);
      await events.emitStateEvents(tx, change(ADDRESS.unit, ADDRESS.table, 'insert', applied, 'migration-feed'), write);
    });

    expect(await outboxCount()).toBe(before);
    expect(capture.published).toStrictEqual([]);
  });

  it('throws for an applied change without a row image', async () => {
    const write = migrationWrite('backfill');
    const before = await outboxCount();

    await expect(
      inTenant((tx) => events.emitStateEvents(tx, { unit: PERSON.unit, table: PERSON.table, op: 'delete', origin: 'backfill', tenantId: TENANT_A.tenantId }, write)),
    ).rejects.toThrow('Applied delete on people.person carries no row image');
    expect(await outboxCount()).toBe(before);
  });
});
