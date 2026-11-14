/** Tenant isolation of the people schema, its user-pool reads, its pooled archive and its event consumers against PostgreSQL. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, dlqTopicName, type DeadLetterReason } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import {
  NON_TENANT_TABLES,
  OutsideTenantTransactionError,
  TransactionEndedError,
  createPool,
  tenantIdForSite,
  withMetadata,
  withTenant,
  type SiteChangedPayload,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import {
  PLATFORM_TABLE_GROUPS,
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createCapturingPublisher,
  createThrowawaySchema,
  defineIsolationSuite,
  expectPlatformTables,
  fixtureForTenant,
  isAck,
  pushTo,
  seedRegistry,
  testEnvelope,
  testPgConfig,
  withoutTenant,
  type InjectResponse,
  type PlatformTableGroup,
  type TenantFixture,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { GROUP_NAME_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { GROUP_CHANGED_TOPIC, PERSON_ARCHIVED_TOPIC, SITE_CHANGED_TOPIC, type GroupChangedPayload } from '../../src/events/topics.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { OWNED_TABLES, PEOPLE_UNITS, type PersonRow } from '../../src/repo/tables.js';
import { PG_AVAILABLE, TEST_CLOCK, buildTestApp, userHeaders, type TestApp } from '../helpers/app.js';
import {
  ARCHIVE_EFFECTIVE_FROM,
  ARCHIVE_PERSON,
  DEFAULT_PEOPLE_SEED,
  MEMBER_B_PERSON,
  OTHER_TENANT,
  POOLED_MEMBER_PERSON,
  SITE_ADMIN_A,
  SYSTEM_USER_A_PERSON,
  TENANT_A_PUBLIC_MEMBERS,
  TENANT_A_SYSTEM_USERS,
  TENANT_B_USERS,
  accountsForSeed,
  addressRow,
  extendAttributeRow,
  extendDataRow,
  extendSetRow,
  extendSubtypeRow,
  favoriteRow,
  groupNameRow,
  interestRow,
  personArchiveRow,
  personRow,
  rosterOperationRow,
  seedPeople,
  tagRow,
  type TestActor,
} from '../helpers/fixtures.js';

type Row = Record<string, unknown>;
type Method = 'GET' | 'POST';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const ALL_PLATFORM_GROUPS = Object.keys(PLATFORM_TABLE_GROUPS) as PlatformTableGroup[];
const PLATFORM_TENANT_TABLES = ALL_PLATFORM_GROUPS.flatMap((group) => PLATFORM_TABLE_GROUPS[group].tenantOwned);
const OWNED_TABLE_NAMES = OWNED_TABLES.map(({ table }) => table);
const TABLES = [...OWNED_TABLE_NAMES, ...PLATFORM_TENANT_TABLES];
const GATE_HOLDER = 'people-isolation-suite';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const CSRF = Object.freeze({ csrf_token: 'TOKEN', csrf_token_expires: '260630110000000' });
const ARCHIVE_PATH = (userId: string): string => `/legacy-fixtures/cfml/api.cfm/people/persons/${userId}/archive`;
const TENANT_POLICY = /^\(tenant_id = \(NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)\)::uuid\)$/;
const UNREGISTERED_SITE = 'opt2-unregistered';
const UNREGISTERED_TENANT = tenantIdForSite(UNREGISTERED_SITE);
/** Every tenant a delivery could have written to: the fixtures and the unregistered one. */
const PROBED_TENANTS = [...TENANT_LIST.map(({ tenantId }) => tenantId), UNREGISTERED_TENANT];

/** A `trash` row of the people share: a deleted user's WDDX-less tombstone. */
function trashRow(siteid: string): Row {
  return {
    objectid: cfUuid(),
    parentid: cfUuid(),
    siteid,
    objectlabel: 'Isolation User',
    objectclass: 'userBean',
    objecttype: 'User',
    objectsubtype: 'Default',
    objectstring: null,
    deleteddate: TEST_CLOCK.now(),
    deletedby: 'Isolation Suite',
    deleteid: cfUuid(),
    orderno: null,
  };
}

/** Fresh rows of every owned table for a site, written through the people repository. */
const OWNED_ROWS: ReadonlyMap<string, (siteid: string) => Row> = new Map<string, (siteid: string) => Row>([
  ['person', (siteid) => personRow({ siteid })],
  ['user_address', (siteid) => addressRow({ siteid })],
  ['user_interest', () => interestRow()],
  ['user_tag', (siteid) => tagRow({ siteid })],
  ['user_favorite', (siteid) => favoriteRow({ siteid })],
  ['extend_data_user_activity', (siteid) => extendDataRow({ siteid })],
  // tclassextenddata rows have the columns of tclassextenddatauseractivity rows.
  ['extend_data', (siteid) => extendDataRow({ siteid })],
  ['trash', trashRow],
  ['extend_subtype', (siteid) => extendSubtypeRow({ siteid })],
  ['extend_set', (siteid) => extendSetRow({ siteid })],
  ['extend_attribute', (siteid) => extendAttributeRow({ siteid })],
  [
    'extend_rc_set',
    (siteid) => ({ subtypeid: cfUuid(), availablesubtypes: null, siteid, entitytype: 'content', name: 'Related Content', orderno: 1, relatedcontentsetid: cfUuid() }),
  ],
  ['person_archive', (siteid) => personArchiveRow({ siteid })],
  // A finished operation keeps no user closed, so the global open-operation index never collides.
  ['roster_operation', () => rosterOperationRow({ state: 'done' })],
  ['group_name', (site_id) => groupNameRow({ site_id })],
  ['person_tombstone', () => ({ userid: cfUuid(), row_version: '1' })],
]);

/** Fresh rows of the platform tenant tables, which no repository writes; published outbox rows and finished tasks stay inert. */
const PLATFORM_ROWS: ReadonlyMap<string, () => Row> = new Map<string, () => Row>([
  [
    'outbox',
    () => ({
      event_id: randomUUID(),
      topic: 'people.isolation.probe.v1',
      kind: 'state',
      ordering_key: cfUuid(),
      envelope: '{}',
      created_at: TEST_CLOCK.now(),
      published_at: TEST_CLOCK.now(),
    }),
  ],
  ['inbox', () => ({ event_id: randomUUID(), subscription: GROUP_NAME_SUBSCRIPTION, status: 'applied' })],
  ['consumer_aggregate_version', () => ({ subscription: GROUP_NAME_SUBSCRIPTION, aggregate_type: 'group', aggregate_id: cfUuid(), last_version: 1 })],
  ['changelog', () => ({ table: 'person', op: 'insert', key: cfUuid(), after: 'N', origin: 'backfill' })],
  ['migration_batch', () => ({ batch_id: randomUUID(), legacy_table: 'tusers', origin: 'backfill', row_count: 1 })],
  [
    'scheduled_task_queue',
    () => ({
      queue: 'people-isolation',
      name: randomUUID(),
      schedule_time: TEST_CLOCK.now(),
      url: 'http://127.0.0.1:8112/internal/v1/isolation',
      body: '{}',
      deadline_s: 60,
      status: 'done',
      created_at: TEST_CLOCK.now(),
      updated_at: TEST_CLOCK.now(),
    }),
  ],
  ['scheduled_task_queue_state', () => ({ queue: `people-isolation-${randomUUID()}`, paused: false, updated_at: TEST_CLOCK.now() })],
]);

let schema: ThrowawaySchema | undefined;
let repository: PeopleRepository | undefined;
let testApp: TestApp<TenantDb> | undefined;
const publisher = createCapturingPublisher();

/** The schema the outer beforeAll created; throws when its creation failed. */
function created(): ThrowawaySchema {
  if (schema === undefined) {
    throw new Error('The throwaway people schema was not created; see the beforeAll failure');
  }
  return schema;
}

/** What the outer beforeAll built; throws when building it failed. */
function built(): { schema: ThrowawaySchema; repository: PeopleRepository; testApp: TestApp<TenantDb> } {
  if (repository === undefined || testApp === undefined) {
    throw new Error('The people repository or app was not built; see the beforeAll failure');
  }
  return { schema: created(), repository, testApp };
}

/** A fresh `table` row of `tenant` without `tenant_id`; throws TypeError for a table without a builder. */
function rowFor(table: string, tenant: TenantFixture): Row {
  const build = OWNED_ROWS.get(table);
  const platform = PLATFORM_ROWS.get(table);
  if (build === undefined && platform === undefined) {
    throw new TypeError(`No isolation row builder for people table ${table}`);
  }
  const { tenant_id: _tenant, ...columns } = build === undefined ? (platform as () => Row)() : build(tenant.siteId);
  return columns;
}

/** Writes one fresh row of `table` for `tenant`: owned tables through the gated, audited repository, platform tables directly. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const row = rowFor(table, tenant);
  if (OWNED_ROWS.has(table)) {
    await built().repository.insert(tx, table, row);
    return;
  }
  const names = ['tenant_id', ...Object.keys(row)];
  const placeholders = names.map((_, index) => `$${String(index + 1)}`);
  await tx.query(`INSERT INTO "${tx.schema}"."${table}" (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${placeholders.join(', ')})`, [
    tx.tenantId,
    ...Object.values(row),
  ]);
}

/** Every row of `table` visible in `tx`; RLS is the only filter. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** Inserts every missing people gate and opens it, so a refused write can only come from tenant isolation. */
async function openPeopleGates(db: ThrowawaySchema): Promise<void> {
  await ensureUnitGates(db.app, PEOPLE_UNITS);
  // openGates reopens only its holder's gates, so the new `legacy` gates are first closed under this suite's holder.
  await closeGates(db.app, { units: PEOPLE_UNITS, holderId: GATE_HOLDER, allowLegacy: true });
  await openGates(db.app, { units: PEOPLE_UNITS, holderId: GATE_HOLDER, state: 'open' });
}

/** Rows of `table` matching `where` visible in tenant `tenantId`. */
function countIn(tenantId: string, table: string, where = 'true', values: unknown[] = []): Promise<number> {
  return withTenant(created().app, tenantId, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tx.schema}"."${table}" WHERE ${where}`, values);
    return rows[0]?.n ?? 0;
  });
}

/** {@link countIn} for each fixture tenant, keyed by fixture key. */
async function countsByFixture(table: string, where?: string, values?: unknown[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const tenant of TENANT_LIST) {
    counts[tenant.key] = await countIn(tenant.tenantId, table, where, values);
  }
  return counts;
}

/** Site ids of the tenant registry, sorted. */
async function registrySites(): Promise<string[]> {
  const { rows } = await withMetadata(created().app, (tx) =>
    tx.query<{ site_id: string }>(`SELECT site_id FROM "${tx.schema}".tenant_registry ORDER BY site_id`),
  );
  return rows.map(({ site_id }) => site_id);
}

/** A full private-pool group state of `tenant`'s site; `overrides` replace payload fields. */
function groupEnvelope(tenant: { siteId: string; tenantId: string }, overrides: Partial<GroupChangedPayload> = {}) {
  const groupId = cfUuid();
  const payload: GroupChangedPayload = {
    groupId,
    siteId: tenant.siteId,
    groupName: 'Isolation Group',
    type: 1,
    isPublic: 0,
    poolTenantId: tenant.tenantId,
    deleted: false,
    ...overrides,
  };
  return testEnvelope({ topic: GROUP_CHANGED_TOPIC, tenantId: tenant.tenantId, aggregateId: groupId, aggregateVersion: 1, payload });
}

/** A `programs-sites.site.changed.v1` envelope of a site no registry holds, owning all of its pools. */
function unregisteredSiteEnvelope(tenantId: string) {
  const siteId = 'iso-unregistered';
  const payload: SiteChangedPayload = {
    siteId,
    publicUserPoolId: siteId,
    privateUserPoolId: siteId,
    categoryPoolId: siteId,
    filePoolId: siteId,
    displayPoolId: siteId,
    contentPoolIds: [siteId],
    domains: [],
  };
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId, aggregateId: siteId, aggregateVersion: 1, payload });
}

/** Injects `method url` as `actor` through the gateway, sending `form` urlencoded when given. */
async function send(method: Method, url: string, actor: TestActor, form?: Record<string, string>): Promise<InjectResponse> {
  const { app } = built().testApp;
  const headers = await userHeaders(actor);
  if (form === undefined) {
    return app.inject({ method, url, headers });
  }
  return app.inject({ method, url, headers: { ...headers, ...FORM }, payload: new URLSearchParams(form).toString() });
}

/** The `UserID` of each listed person, sorted. */
function listedIds(reply: InjectResponse): string[] {
  return reply
    .json<{ items: Array<{ UserID: string }> }>()
    .items.map((item) => item.UserID)
    .sort();
}

/** The user ids of `persons`, sorted. */
function idsOf(persons: readonly PersonRow[]): string[] {
  return persons.map(({ userid }) => userid).sort();
}

/** Ids and emails of `persons`, which no answer for another tenant may carry. */
function markersOf(persons: readonly PersonRow[]): string[] {
  return persons.flatMap(({ userid, email }) => (email === null ? [userid] : [userid, email]));
}

/** The seeded field values of `person` a foreign read must not return. */
function fieldValuesOf(person: PersonRow): string[] {
  return [person.email, person.fname, person.lname].filter((value): value is string => value !== null);
}

/** The markers of `markers` that `reply`'s body carries. */
function leaked(reply: InjectResponse, markers: readonly string[]): string[] {
  return markers.filter((marker) => reply.body.includes(marker));
}

/** Rows of `person`, `group_name` and `changelog` stored under `tenant`. */
async function storedCounts(tenant: TenantFixture): Promise<Record<string, number>> {
  return {
    person: await countIn(tenant.tenantId, 'person'),
    group_name: await countIn(tenant.tenantId, 'group_name'),
    changelog: await countIn(tenant.tenantId, 'changelog'),
  };
}

const TENANT_A_MARKERS = markersOf([...TENANT_A_SYSTEM_USERS, ...TENANT_A_PUBLIC_MEMBERS]);
const TENANT_B_MARKERS = markersOf([...TENANT_B_USERS, MEMBER_B_PERSON]);

describe.skipIf(!PG_AVAILABLE)('people tenant isolation', () => {
  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'people', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    repository = createPeopleRepository({ clock: TEST_CLOCK, schema: schema.schema });
    testApp = await buildTestApp({ db: schema.app, publisher });
    // Opened after the build, whose start-up may insert missing gates as `legacy`; seeding writes through the gates.
    await openPeopleGates(schema);
    await seedPeople(schema.app, DEFAULT_PEOPLE_SEED, { clock: TEST_CLOCK });
    // User lists join people rows with identity's isPublic, S2 and inactive answers.
    testApp.identity.seedAccounts(...accountsForSeed(DEFAULT_PEOPLE_SEED));
  });

  afterAll(async () => {
    try {
      await testApp?.close();
    } finally {
      await schema?.drop();
    }
  });

  // checkCatalog (forced RLS, USING and WITH CHECK, no role reaching SUPERUSER or BYPASSRLS) runs in the shared suite below.
  describe('catalog', () => {
    it('creates the outbox, event, migration-kit, task and tenancy tables with RLS forced on the tenant-owned ones', async () => {
      await expectPlatformTables(created(), { groups: ALL_PLATFORM_GROUPS });
    });

    it('guards every owned and platform tenant table with one tenant_isolation policy on app.tenant_id for USING and WITH CHECK', async () => {
      const db = created();
      const { rows } = await db.adminPool.query<{ table: string; policy: string; cmd: string; qual: string | null; check: string | null }>(
        'SELECT tablename::text AS table, policyname::text AS policy, cmd, qual, with_check AS check FROM pg_policies WHERE schemaname = $1',
        [db.schema],
      );
      expect(rows.map(({ table }) => table).sort()).toEqual([...TABLES].sort());
      for (const { table, policy, cmd, qual, check } of rows) {
        expect({ table, policy, cmd }).toEqual({ table, policy: 'tenant_isolation', cmd: 'ALL' });
        expect(qual, `USING of ${table}`).toMatch(TENANT_POLICY);
        expect(check, `WITH CHECK of ${table}`).toMatch(TENANT_POLICY);
      }
    });

    it('starts every owned table with tenant_id uuid NOT NULL', async () => {
      const db = created();
      const { rows } = await db.adminPool.query<{ table: string; column: string; type: string; nullable: string }>(
        `SELECT table_name::text AS table, column_name::text AS column, data_type::text AS type, is_nullable::text AS nullable
           FROM information_schema.columns WHERE table_schema = $1 AND ordinal_position = 1 AND table_name = ANY($2::text[])`,
        [db.schema, OWNED_TABLE_NAMES],
      );
      const firstColumns = [...rows].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
      expect(firstColumns).toEqual([...OWNED_TABLE_NAMES].sort().map((table) => ({ table, column: 'tenant_id', type: 'uuid', nullable: 'NO' })));
    });

    it('holds no tenant table beyond those the shared suite covers', async () => {
      const db = created();
      const { rows } = await db.adminPool.query<{ table: string }>(
        `SELECT table_name::text AS table FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [db.schema],
      );
      const nonTenant: readonly string[] = NON_TENANT_TABLES;
      expect(rows.map(({ table }) => table).filter((table) => !nonTenant.includes(table)).sort()).toEqual([...TABLES].sort());
      expect(rows.map(({ table }) => table).filter((table) => nonTenant.includes(table)).sort()).toEqual([...nonTenant].sort());
    });
  });

  // Its event case is the tenantless identity.group.changed.v1 delivery, so the cases below do not repeat it.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => schema,
      name: 'people owned and platform tables',
      tables: TABLES,
      writeAs,
      readAs,
      rowFor,
      event: {
        app: () => testApp?.app,
        subscription: GROUP_NAME_SUBSCRIPTION,
        envelopeFor: (tenantId) => groupEnvelope(fixtureForTenant(tenantId) ?? TENANT_A),
        publisher,
      },
    },
  );

  describe('repository guard', () => {
    type Write = (repo: PeopleRepository, tx: TenantTx) => Promise<unknown>;
    const writes: Array<[name: string, write: Write]> = [
      ['insert', (repo, tx) => repo.insert(tx, 'person', rowFor('person', TENANT_A))],
      [
        'insertPerson',
        (repo, tx) => {
          const { tenant_id: _tenant, created: _created, lastupdate: _lastupdate, ext: _ext, row_version: _version, ...input } = personRow();
          return repo.insertPerson(tx, input);
        },
      ],
      [
        'upsertGroupName',
        (repo, tx) => {
          const { tenant_id: _tenant, ...group } = groupNameRow();
          return repo.upsertGroupName(tx, group);
        },
      ],
    ];

    // The write guard refuses outside withTenant; a method that queries the ended transaction first is refused by it instead.
    const refusal = (err: unknown): boolean => err instanceof OutsideTenantTransactionError || err instanceof TransactionEndedError;

    it.each(writes)('people repository %s refuses a tenant transaction that has already ended', async (_name, write) => {
      const { schema: db, repository: repo } = built();
      const ended = await withTenant(db.app, TENANT_A.tenantId, async (tx) => tx);
      const before = await storedCounts(TENANT_A);
      await expect(write(repo, ended)).rejects.toSatisfy(refusal);
      expect(await storedCounts(TENANT_A)).toEqual(before);
    });
  });

  describe('user pools through the app', () => {
    it('tenant-a site-admin lists its public members from umbrella and its system users from tenant-a, never tenant-b rows', async () => {
      const members = await send('GET', `/v1/users?siteid=${TENANT_A.siteId}&ispublic=1`, SITE_ADMIN_A);
      const systemUsers = await send('GET', `/v1/users?siteid=${TENANT_A.siteId}&ispublic=0`, SITE_ADMIN_A);

      expect([members.statusCode, systemUsers.statusCode]).toEqual([200, 200]);
      expect(listedIds(members)).toEqual(idsOf(TENANT_A_PUBLIC_MEMBERS));
      expect(listedIds(systemUsers)).toEqual(idsOf(TENANT_A_SYSTEM_USERS));
      for (const reply of [members, systemUsers]) {
        expect(leaked(reply, TENANT_B_MARKERS), `tenant-b data in ${reply.raw.req.url ?? ''}`).toEqual([]);
      }
    });

    it('tenant-b site-admin lists only tenant-b members and system users, never umbrella or tenant-a rows', async () => {
      const members = await send('GET', `/v1/users?siteid=${TENANT_B.siteId}&ispublic=1`, OTHER_TENANT);
      const systemUsers = await send('GET', `/v1/users?siteid=${TENANT_B.siteId}&ispublic=0`, OTHER_TENANT);

      expect([members.statusCode, systemUsers.statusCode]).toEqual([200, 200]);
      expect(listedIds(members)).toEqual(idsOf([MEMBER_B_PERSON]));
      expect(listedIds(systemUsers)).toEqual(idsOf(TENANT_B_USERS));
      for (const reply of [members, systemUsers]) {
        expect(leaked(reply, TENANT_A_MARKERS), `tenant-a or umbrella data in ${reply.raw.req.url ?? ''}`).toEqual([]);
      }
    });

    it.each([
      ['a tenant-a system user', SYSTEM_USER_A_PERSON],
      ['a pooled tenant-a member', POOLED_MEMBER_PERSON],
    ])('tenant-b site-admin reading %s by id gets a new user, carrying none of its values', async (_label, person) => {
      const site = TENANT_B.siteId;
      const edit = await send('GET', `/v1/users/edit?siteid=${site}&userid=${person.userid}`, OTHER_TENANT);
      const api = await send('GET', `/_api/json/v1/${site}/user/${person.userid}`, OTHER_TENANT);

      expect([edit.statusCode, api.statusCode]).toEqual([200, 200]);
      expect(edit.json()).toMatchObject({ isNew: true });
      expect(edit.json<{ user: { UserID: string } }>().user.UserID).not.toBe(person.userid);
      expect(api.json<{ data: { userid: string } }>().data.userid).not.toBe(person.userid);
      for (const reply of [edit, api]) {
        expect(leaked(reply, fieldValuesOf(person)), `values of ${person.userid} in ${reply.raw.req.url ?? ''}`).toEqual([]);
      }
    });

    it('a tenant-b token naming siteid=tenant-a is refused with 403 and returns no tenant-a data', async () => {
      const site = TENANT_A.siteId;
      const replies = [
        await send('GET', `/v1/users?siteid=${site}&ispublic=1`, OTHER_TENANT),
        await send('GET', `/v1/users?siteid=${site}&ispublic=0`, OTHER_TENANT),
        await send('GET', `/v1/users/edit?siteid=${site}&userid=${SYSTEM_USER_A_PERSON.userid}`, OTHER_TENANT),
      ];

      expect(replies.map((reply) => reply.statusCode)).toEqual([403, 403, 403]);
      for (const reply of replies) {
        expect(leaked(reply, [...TENANT_A_MARKERS, ...fieldValuesOf(SYSTEM_USER_A_PERSON)])).toEqual([]);
      }
    });
  });

  describe('pooled archive through the app', () => {
    const archiveWhere = 'person_id = $1';
    const outboxWhere = `topic = $1 AND envelope->>'aggregateId' = $2`;

    beforeEach(() => {
      publisher.clear();
    });

    it('a tenant-b site-admin cannot archive a pooled tenant-a member, and no tenant stores a record or event', async () => {
      const form = { siteid: TENANT_B.siteId, effectiveFrom: ARCHIVE_EFFECTIVE_FROM, ...CSRF };
      const reply = await send('POST', ARCHIVE_PATH(ARCHIVE_PERSON.userid), OTHER_TENANT, form);

      expect(reply.statusCode).toBe(404);
      expect(reply.json()).toMatchObject({ error: { message: 'Not Found' } });
      expect(await countsByFixture('person_archive', archiveWhere, [ARCHIVE_PERSON.userid])).toEqual({ A: 0, B: 0, umbrella: 0 });
      expect(await countsByFixture('outbox', outboxWhere, [PERSON_ARCHIVED_TOPIC, ARCHIVE_PERSON.userid])).toEqual({ A: 0, B: 0, umbrella: 0 });
      expect(publisher.published).toEqual([]);
    });

    it('archiving a pooled tenant-a member stores the record and its event under umbrella only, and publishes it there', async () => {
      const form = { siteid: TENANT_A.siteId, effectiveFrom: ARCHIVE_EFFECTIVE_FROM, ...CSRF };
      const reply = await send('POST', ARCHIVE_PATH(ARCHIVE_PERSON.userid), SITE_ADMIN_A, form);

      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({
        method: 'people.persons.archive',
        data: { personid: ARCHIVE_PERSON.userid, siteid: TENANT_UMBRELLA.siteId },
      });
      expect(await countsByFixture('person_archive', archiveWhere, [ARCHIVE_PERSON.userid])).toEqual({ A: 0, B: 0, umbrella: 1 });
      expect(await countsByFixture('outbox', outboxWhere, [PERSON_ARCHIVED_TOPIC, ARCHIVE_PERSON.userid])).toEqual({ A: 0, B: 0, umbrella: 1 });
      expect(publisher.published.map(({ topic, envelope }) => ({ topic, tenantId: envelope.tenantId, aggregateId: envelope.aggregateId }))).toEqual([
        { topic: PERSON_ARCHIVED_TOPIC, tenantId: TENANT_UMBRELLA.tenantId, aggregateId: ARCHIVE_PERSON.userid },
      ]);
    });
  });

  describe('dead-lettered deliveries', () => {
    interface DeadLetterCase {
      name: string;
      subscription: string;
      reason: DeadLetterReason;
      envelope(): TenantlessEnvelope;
    }

    const cases: DeadLetterCase[] = [
      {
        name: 'a site.changed event without a tenant',
        subscription: SITE_CHANGED_SUBSCRIPTION,
        reason: 'missing-tenant',
        envelope: () => withoutTenant(unregisteredSiteEnvelope(TENANT_A.tenantId)),
      },
      // An unregistered tenant fails the consumer's registry lookup before its pool check, hence invalid-tenant.
      {
        name: 'a group.changed event of a tenant no registry holds',
        subscription: GROUP_NAME_SUBSCRIPTION,
        reason: 'invalid-tenant',
        envelope: () => groupEnvelope({ siteId: UNREGISTERED_SITE, tenantId: UNREGISTERED_TENANT }),
      },
      {
        name: "a tenant-a group.changed event naming tenant-b's pool",
        subscription: GROUP_NAME_SUBSCRIPTION,
        reason: 'tenant-mismatch',
        envelope: () => groupEnvelope(TENANT_A, { poolTenantId: TENANT_B.tenantId }),
      },
    ];

    beforeEach(() => {
      publisher.clear();
    });

    it.each(cases)('$name is acked, dead-lettered as $reason and stores nothing in any tenant', async ({ subscription, reason, envelope }) => {
      const delivered = envelope();
      const sitesBefore = await registrySites();

      const reply = await pushTo(built().testApp.app, subscription, delivered);

      expect(isAck(reply), `push answered ${String(reply.statusCode)}`).toBe(true);
      expect(reply.statusCode).toBe(204);
      expect(publisher.raw.map(({ topic, message }) => ({ topic, reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE] }))).toEqual([
        { topic: dlqTopicName(subscription), reason },
      ]);
      expect(publisher.published).toEqual([]);
      for (const tenantId of PROBED_TENANTS) {
        expect(await countIn(tenantId, 'inbox', 'event_id = $1', [delivered.eventId]), `inbox receipts of ${tenantId}`).toBe(0);
        // A group event's aggregate id is its group id.
        expect(await countIn(tenantId, 'group_name', 'group_id = $1', [delivered.aggregateId]), `group_name rows of ${tenantId}`).toBe(0);
      }
      expect(await registrySites()).toEqual(sitesBefore);
    });
  });

  it('drops its throwaway schema and roles', async () => {
    const db = created();
    await testApp?.close();
    testApp = undefined;
    await db.drop();
    const pg = testPgConfig();
    const probe = await createPool({
      env: { OPT2_DB_AUTH: 'password', PG_HOST: pg.host, PG_PORT: pg.port, PG_DATABASE: pg.database, PG_USER: pg.user, PG_PASSWORD: pg.password },
      schema: 'public',
      max: 1,
    });
    try {
      const left = await withMetadata(probe, async (tx) => ({
        schemas: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1', [db.schema])).rows[0]?.n,
        roles: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1::text[])', [Object.values(db.roles)])).rows[0]
          ?.n,
      }));
      expect(left, `objects of ${db.schema} left after drop`).toEqual({ schemas: 0, roles: 0 });
    } finally {
      await probe.end();
    }
  });
});
