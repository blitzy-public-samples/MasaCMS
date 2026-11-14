/** Tenant isolation of the identity schema, its group, permission and token routes, and its person-contact consumer against PostgreSQL. */
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, cfUuid, generateCsrfToken } from '@opt2/platform/legacy-compat';
import { ensureUnitGates, type CanonicalType } from '@opt2/platform/migration-kit';
import { NON_TENANT_TABLES, OutsideTenantTransactionError, createPool, withMetadata, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import {
  PLATFORM_TABLE_GROUPS,
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  defineIsolationSuite,
  expectPlatformTables,
  fixtureForTenant,
  isAck,
  mintUserToken,
  pgAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  testPgConfig,
  type CapturingPublisher,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { PERSON_CHANGED_TOPIC, PERSON_CONTACT_SUBSCRIPTION, type PersonChangedPayload } from '../../src/events/person-contact.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, OWNED_TABLES, type GroupAccountRow, type IdentityTableDefinition } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, headersFor } from '../helpers/app.js';
import {
  MEMBER_B,
  POOLED_MEMBER,
  SITE_ADMIN_A,
  accountRow,
  credentialRow,
  groupRow,
  loginSnapshotFixture,
  loginStateRow,
  membershipRow,
  oauthClientRow,
  oauthTokenRow,
  permissionRow,
  personContactRow,
  sessionRow,
  type TestActor,
} from '../helpers/rows.js';

type Row = Record<string, unknown>;
type Method = 'GET' | 'PUT';
type AppContext = Awaited<ReturnType<typeof buildTestApp>>;
type Reply = Awaited<ReturnType<AppContext['app']['inject']>>;
/** NOT NULL columns without a default, per table, mapped to their `char(n)` length or null. */
type RequiredColumns = Map<string, Map<string, number | null>>;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const ALL_PLATFORM_GROUPS = Object.keys(PLATFORM_TABLE_GROUPS) as PlatformTableGroup[];
const PLATFORM_TENANT_TABLES = ALL_PLATFORM_GROUPS.flatMap((group) => PLATFORM_TABLE_GROUPS[group].tenantOwned);
const TABLES = OWNED_TABLES.map(({ table }) => table);
const DEFINITIONS: ReadonlyMap<string, IdentityTableDefinition> = new Map(OWNED_TABLES.map((definition) => [definition.table, definition]));
const USERS_MODULE = '00000000000000000000000000000000008';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const SITE_ADMIN_ROLES = ROLE_SET.find(({ name }) => name === 'site-admin')?.roles ?? [];
const TENANT_POLICY = /^\(tenant_id = \(NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)\)::uuid\)$/;

const REQUIRED_COLUMNS_SQL = `
SELECT c.relname::text AS table, a.attname::text AS column,
       CASE WHEN a.atttypid = 'bpchar'::regtype THEN a.atttypmod - 4 END AS length
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull AND NOT a.atthasdef`;

/** Values the CHECK constraints admit; a finished operation keeps no user closed. */
const CHECKED_VALUES: ReadonlyMap<string, Row> = new Map([
  ['csrf_claim', { state: 'used' }],
  ['account_operation', { kind: 'update', state: 'finished' }],
]);

/** Fresh rows from the shared builders, keyed by table; each takes the site of the row's tenant. */
const BUILDERS: ReadonlyMap<string, (siteId: string) => Row> = new Map<string, (siteId: string) => Row>([
  ['group_account', (siteid) => groupRow({ siteid })],
  ['user_account', (siteid) => accountRow({ siteid })],
  ['credential', () => credentialRow()],
  ['login_state', () => loginStateRow()],
  ['membership', () => membershipRow()],
  ['permission', (siteid) => permissionRow({ siteid })],
  ['session', (site_id) => sessionRow({ site_id })],
  ['oauth_client', (siteid) => oauthClientRow({ siteid })],
  ['oauth_token', () => oauthTokenRow()],
  ['person_contact', (site_id) => personContactRow({ site_id })],
]);

/** The single item of `items`. */
function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined) throw new TypeError(`Expected one item, got ${String(items.length)}`);
  return item;
}

const A_ADMIN_GROUP: GroupAccountRow = only(SITE_ADMIN_A.groups);
const A_PRIVATE_GROUP = groupRow({ tenant_id: TENANT_A.tenantId, siteid: TENANT_A.siteId, groupname: 'A Private Group', ispublic: 0 });
const A_CONTENT_ID = cfUuid();
const A_PERMISSION = permissionRow({ tenant_id: TENANT_A.tenantId, contentid: A_CONTENT_ID, groupid: A_PRIVATE_GROUP.userid, type: 'Editor' });
const A_SESSION = sessionRow({
  tenant_id: TENANT_A.tenantId,
  user_id: SITE_ADMIN_A.account.userid,
  site_id: TENANT_A.siteId,
  login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: SITE_ADMIN_A })),
  mode: 'target-primary',
});
const POOLED_GROUP = groupRow({ tenant_id: TENANT_UMBRELLA.tenantId, siteid: TENANT_UMBRELLA.siteId, groupname: 'Pooled Members', ispublic: 1 });
const POOLED_MEMBERSHIP = membershipRow({ tenant_id: TENANT_UMBRELLA.tenantId, userid: POOLED_MEMBER.account.userid, groupid: POOLED_GROUP.userid });
const B_GROUP = groupRow({ tenant_id: TENANT_B.tenantId, siteid: TENANT_B.siteId, groupname: 'B Only Group', ispublic: 0 });
const B_PERMISSION = permissionRow({ tenant_id: TENANT_B.tenantId, siteid: TENANT_B.siteId, contentid: cfUuid(), groupid: B_GROUP.userid, type: 'Read' });
const B_SESSION = sessionRow({
  tenant_id: TENANT_B.tenantId,
  user_id: MEMBER_B.account.userid,
  site_id: TENANT_B.siteId,
  login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: MEMBER_B })),
  mode: 'target-primary',
});

/** Ids and names of the seeded tenant-a rows that no tenant-b answer may carry. */
const TENANT_A_MARKERS = [A_ADMIN_GROUP.userid, A_PRIVATE_GROUP.userid, 'A Private Group', SITE_ADMIN_A.account.userid, A_CONTENT_ID];
/** Ids and names of the seeded tenant-b rows that no tenant-a answer may carry. */
const TENANT_B_MARKERS = [B_GROUP.userid, 'B Only Group', MEMBER_B.account.userid, 'member_b', MEMBER_B.contact.email ?? '', B_PERMISSION.contentid];

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

let schema: ThrowawaySchema | undefined;
let repository: IdentityRepository | undefined;
let ctx: AppContext | undefined;
let required: RequiredColumns = new Map();

/** The schema the outer beforeAll created; throws when its creation failed. */
function created(): ThrowawaySchema {
  if (schema === undefined) {
    throw new Error('The throwaway identity schema was not created; see the beforeAll failure');
  }
  return schema;
}

/** What the outer beforeAll built; throws when building it failed. */
function built(): { schema: ThrowawaySchema; repository: IdentityRepository; ctx: AppContext } {
  if (repository === undefined || ctx === undefined) {
    throw new Error('The identity repository or app was not built; see the beforeAll failure');
  }
  return { schema: created(), repository, ctx };
}

/** The app's capturing publisher, read through once beforeAll built the app. */
const appPublisher: CapturingPublisher = {
  get published() {
    return built().ctx.publisher.published;
  },
  get raw() {
    return built().ctx.publisher.raw;
  },
  publish: (topic, envelope) => built().ctx.publisher.publish(topic, envelope),
  publishRaw: (topic, message) => built().ctx.publisher.publishRaw(topic, message),
  close: () => built().ctx.publisher.close(),
  clear: () => {
    built().ctx.publisher.clear();
  },
  failNext: (n) => {
    built().ctx.publisher.failNext(n);
  },
  deadLetters: (subscription) => built().ctx.publisher.deadLetters(subscription),
};

/** Reads the NOT NULL columns without a default of every table of `db`. */
async function requiredColumns(db: ThrowawaySchema): Promise<RequiredColumns> {
  const { rows } = await db.adminPool.query<{ table: string; column: string; length: number | null }>(REQUIRED_COLUMNS_SQL, [db.schema]);
  const tables: RequiredColumns = new Map();
  for (const { table, column, length } of rows) {
    tables.set(table, (tables.get(table) ?? new Map<string, number | null>()).set(column, length));
  }
  return tables;
}

/** A fresh value of canonical type `type`; text exactly fills a `char(length)` column shorter than a CF UUID. */
function valueFor(type: CanonicalType, length: number | null): unknown {
  switch (type) {
    case 's':
      return length === null || length >= 35 ? cfUuid() : randomBytes(length).toString('hex').slice(0, length);
    case 'i':
      return randomInt(1, 2 ** 31 - 1);
    case 'f':
      return 0;
    case 'd':
      return '0.0000';
    case 't':
      return TEST_CLOCK.now();
    case 'b':
      return Buffer.alloc(0);
  }
}

/** A `table` row of `tenant` with only its NOT NULL columns without a default set, CHECK-constrained ones to admitted values. */
function requiredRow(table: string, tenant: TenantFixture): Row {
  const definition = DEFINITIONS.get(table);
  const columns = required.get(table);
  if (definition === undefined || columns === undefined) {
    throw new TypeError(`identity has no table ${table} in schema ${created().schema}`);
  }
  const row: Row = {};
  for (const { name, type } of definition.columns) {
    if (name !== 'tenant_id' && columns.has(name)) {
      row[name] = name === 'siteid' ? tenant.siteId : valueFor(type, columns.get(name) ?? null);
    }
  }
  return { ...row, ...CHECKED_VALUES.get(table) };
}

/** A fresh `table` row of `tenant` without `tenant_id`, from its builder when one exists. */
function rowFor(table: string, tenant: TenantFixture): Row {
  const build = BUILDERS.get(table);
  const { tenant_id: _tenant, ...columns } = build === undefined ? requiredRow(table, tenant) : build(tenant.siteId);
  return columns;
}

/** Writes one fresh row of `table` for `tenant` through the identity repository, so the unit gate and changelog hooks run. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  await built().repository.insert(tx, table, rowFor(table, tenant));
}

/** Every row of `table` visible in `tx`; RLS is the only filter. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** The account, credential, login-state and contact rows of `actor`, keyed by table. */
function actorRows(actor: TestActor): Array<readonly [table: string, row: Row]> {
  return [
    ['user_account', actor.account],
    ['credential', actor.credential],
    ['login_state', actor.loginState],
    ['person_contact', actor.contact],
  ];
}

/** Inserts `rows` under `tenant` through the identity repository in one tenant transaction. */
async function seedRows(tenant: TenantFixture, rows: ReadonlyArray<readonly [table: string, row: Row]>): Promise<void> {
  const { schema: db, repository: repo } = built();
  await withTenant(db.app, tenant.tenantId, async (tx) => {
    for (const [table, row] of rows) {
      const { tenant_id: _tenant, ...columns } = row;
      await repo.insert(tx, table, columns);
    }
  });
}

/** Seeds tenant-a's private pool, the umbrella public pool tenant-a uses, and tenant-b. */
async function seedTenants(): Promise<void> {
  await seedRows(TENANT_A, [
    ...actorRows(SITE_ADMIN_A),
    ['group_account', A_ADMIN_GROUP],
    ['group_account', A_PRIVATE_GROUP],
    ...SITE_ADMIN_A.memberships.map((membership) => ['membership', membership] as const),
    ['permission', A_PERMISSION],
    ['session', A_SESSION],
  ]);
  await seedRows(TENANT_UMBRELLA, [...actorRows(POOLED_MEMBER), ['group_account', POOLED_GROUP], ['membership', POOLED_MEMBERSHIP]]);
  await seedRows(TENANT_B, [...actorRows(MEMBER_B), ['group_account', B_GROUP], ['permission', B_PERMISSION], ['session', B_SESSION]]);
}

/** Inserts every missing identity gate and opens them all, so a refusal can only come from tenant isolation. */
async function openIdentityGates(db: ThrowawaySchema): Promise<void> {
  await ensureUnitGates(db.app, IDENTITY_UNITS);
  await withMetadata(db.app, (tx) =>
    tx.query(`UPDATE "${tx.schema}".unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet' WHERE unit = ANY($1::text[])`, [
      [...IDENTITY_UNITS],
    ]),
  );
}

/** A full person state of `userId` at `siteId`, as people publishes it. */
function personPayload(userId: string, siteId: string): PersonChangedPayload {
  return {
    userId,
    siteId,
    deleted: false,
    groupName: null,
    fname: 'Isolation',
    lname: 'Person',
    email: `isolation@${siteId}.opt2.test`,
    company: null,
    jobTitle: null,
    mobilePhone: null,
    website: null,
    subType: 'Default',
    ext: null,
    contactForm: null,
    subscribe: 0,
    notes: null,
    description: null,
    interests: null,
    keepPrivate: 0,
    photoFileId: null,
    imName: null,
    imService: null,
    tags: null,
    created: '2026-06-30 11:59:00.000',
    lastUpdate: '2026-06-30 12:00:00.000',
    lastUpdateBy: 'Isolation Suite',
    lastUpdateById: null,
  };
}

/** A `people.person.changed.v1` envelope of a new person of `tenant`'s site, in `tenant`. */
function personEnvelope(tenant: TenantFixture, userId: string = cfUuid()) {
  return testEnvelope({
    topic: PERSON_CHANGED_TOPIC,
    tenantId: tenant.tenantId,
    aggregateId: userId,
    aggregateVersion: 1,
    payload: personPayload(userId, tenant.siteId),
  });
}

/** Injects `method url` with `headers`, sending `form` urlencoded when given. */
function send(method: Method, url: string, headers: Record<string, string>, form?: Record<string, string>): Promise<Reply> {
  const { app } = built().ctx;
  if (form === undefined) {
    return app.inject({ method, url, headers });
  }
  return app.inject({ method, url, headers: { ...headers, ...FORM }, payload: new URLSearchParams(form).toString() });
}

/** Headers of a site-admin of `site`, the user `sub`, whose user token names the stored session `sid`. */
async function sessionHeaders(site: string, sid: string, sub: string): Promise<Record<string, string>> {
  const headers = await headersFor('site-admin', { site, sub });
  return { ...headers, authorization: `Bearer ${await mintUserToken({ sub, sid, site, roles: SITE_ADMIN_ROLES })}` };
}

/** Form fields of a fresh CSRF token for `context` under the session secret `secret`, valid at the app's clock. */
function csrfFields(secret: string, context: string): Record<string, string> {
  const { token, expires } = generateCsrfToken({ context, secret, now: TEST_CLOCK.now() });
  return { [CSRF_FIELD_TOKEN]: token, [CSRF_FIELD_EXPIRES]: expires };
}

/** The `group_account` and `permission` rows and the changelog length stored under `tenant`. */
function storedRows(tenant: TenantFixture): Promise<{ groups: unknown[]; permissions: unknown[]; changelog: unknown }> {
  return withTenant(created().app, tenant.tenantId, async (tx) => ({
    groups: (await tx.query(`SELECT * FROM "${tx.schema}".group_account ORDER BY userid`)).rows,
    permissions: (await tx.query(`SELECT * FROM "${tx.schema}".permission ORDER BY contentid, groupid, type`)).rows,
    changelog: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tx.schema}".changelog`)).rows[0]?.n,
  }));
}

/** The markers of `markers` that `reply`'s body carries. */
function leaked(reply: Reply, markers: readonly string[]): string[] {
  return markers.filter((marker) => reply.body.includes(marker));
}

/** The `UserID` of each listed group. */
function listedGroupIds(reply: Reply): string[] {
  return reply.json<{ items: Array<{ UserID: string }> }>().items.map((item) => item.UserID);
}

describe.skipIf(!available)('identity tenant isolation', () => {
  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'identity', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    required = await requiredColumns(schema);
    repository = createIdentityRepository({ clock: TEST_CLOCK, schema: schema.schema });
    ctx = await buildTestApp({ db: schema.app });
    await ctx.app.ready();
    // Opened after the build, whose start-up inserts every missing gate as `legacy`.
    await openIdentityGates(schema);
    await seedTenants();
  });

  afterAll(async () => {
    try {
      await ctx?.app.close();
    } finally {
      await schema?.drop();
    }
  });

  // The shared suite below asserts checkCatalog itself: forced RLS with USING and WITH CHECK on every tenant table, and no
  // schema role that is or inherits SUPERUSER or BYPASSRLS.
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
      expect(rows.map(({ table }) => table).sort()).toEqual([...TABLES, ...PLATFORM_TENANT_TABLES].sort());
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
        [db.schema, TABLES],
      );
      const firstColumns = [...rows].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
      expect(firstColumns).toEqual([...TABLES].sort().map((table) => ({ table, column: 'tenant_id', type: 'uuid', nullable: 'NO' })));
    });

    it('holds no table beyond the owned, platform tenant and five metadata tables', async () => {
      const db = created();
      const { rows } = await db.adminPool.query<{ table: string }>(
        `SELECT table_name::text AS table FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [db.schema],
      );
      const expected = [...TABLES, ...PLATFORM_TENANT_TABLES, ...NON_TENANT_TABLES].sort();
      expect(rows.map(({ table }) => table).sort()).toEqual(expected);
    });
  });

  // Its event case covers a tenantless people.person.changed.v1: acked, dead-lettered as missing-tenant, no owned row changed.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => schema,
      name: 'identity owned tables',
      tables: TABLES,
      writeAs,
      readAs,
      rowFor,
      event: {
        app: () => ctx?.app,
        subscription: PERSON_CONTACT_SUBSCRIPTION,
        envelopeFor: (tenantId) => personEnvelope(fixtureForTenant(tenantId) ?? TENANT_A),
        publisher: appPublisher,
      },
    },
  );

  describe('repository guard', () => {
    type Write = (repo: IdentityRepository, tx: TenantTx) => Promise<unknown>;
    const writes: Array<[name: string, write: Write]> = [
      ['insert', (repo, tx) => repo.insert(tx, 'group_account', rowFor('group_account', TENANT_A))],
      [
        'insertAccount',
        (repo, tx) => {
          const { tenant_id: _tenant, admin: _admin, opt2_state: _state, ...account } = accountRow();
          return repo.insertAccount(tx, account);
        },
      ],
      [
        'upsertPersonContact',
        (repo, tx) => {
          const { tenant_id: _tenant, updated_at: _updated, ...contact } = personContactRow();
          return repo.upsertPersonContact(tx, contact);
        },
      ],
    ];

    it.each(writes)('identity repository %s refuses a tenant transaction that has already ended', async (_name, write) => {
      const { schema: db, repository: repo } = built();
      const ended = await withTenant(db.app, TENANT_A.tenantId, async (tx) => tx);
      const before = await storedRows(TENANT_A);
      await expect(write(repo, ended)).rejects.toBeInstanceOf(OutsideTenantTransactionError);
      expect(await storedRows(TENANT_A)).toEqual(before);
    });
  });

  describe('through the app', () => {
    it('tenant-a site-admin lists tenant-a private groups and pooled umbrella public groups, never tenant-b rows', async () => {
      const headers = await headersFor('site-admin', { site: TENANT_A.siteId, sub: SITE_ADMIN_A.account.userid });
      const privateGroups = await send('GET', `/v1/groups?siteid=${TENANT_A.siteId}&ispublic=0`, headers);
      const publicGroups = await send('GET', `/v1/groups?siteid=${TENANT_A.siteId}&ispublic=1`, headers);
      const members = await send('GET', `/v1/groups/${POOLED_GROUP.userid}/members`, headers);

      expect([privateGroups.statusCode, publicGroups.statusCode, members.statusCode]).toEqual([200, 200, 200]);
      expect(listedGroupIds(privateGroups)).toEqual(expect.arrayContaining([A_ADMIN_GROUP.userid, A_PRIVATE_GROUP.userid]));
      expect(listedGroupIds(publicGroups)).toEqual([POOLED_GROUP.userid]);
      expect(members.json<{ items: Array<{ userID: string }> }>().items.map((item) => item.userID)).toEqual([POOLED_MEMBER.account.userid]);
      for (const reply of [privateGroups, publicGroups, members]) {
        expect(leaked(reply, TENANT_B_MARKERS), `tenant-b data in ${reply.raw.req.url ?? ''}`).toEqual([]);
      }
    });

    it('tenant-b token with siteid=tenant-a is refused with 403 and changes no tenant-a row', async () => {
      const headers = await headersFor('site-admin', { site: TENANT_B.siteId, sub: MEMBER_B.account.userid });
      const before = await storedRows(TENANT_A);
      const query = `siteid=${TENANT_A.siteId}`;

      const replies = [
        await send('GET', `/v1/groups/${A_PRIVATE_GROUP.userid}?${query}`, headers),
        await send('PUT', `/v1/groups/${A_PRIVATE_GROUP.userid}?${query}`, headers, { siteid: TENANT_A.siteId, groupname: 'Renamed by B' }),
        await send('PUT', `/v1/permissions/modules/${USERS_MODULE}?${query}`, headers, { moduleid: USERS_MODULE, groupid: B_GROUP.userid }),
      ];

      expect(replies.map((reply) => reply.statusCode)).toEqual([403, 403, 403]);
      for (const reply of replies) {
        expect(leaked(reply, TENANT_A_MARKERS)).toEqual([]);
      }
      expect(await storedRows(TENANT_A)).toEqual(before);
    });

    it('tenant-b token cannot modify tenant-a groups or permissions by guessed id, and its own writes land in tenant-b', async () => {
      const headers = await sessionHeaders(TENANT_B.siteId, B_SESSION.session_id, MEMBER_B.account.userid);
      const before = await storedRows(TENANT_A);
      const query = `siteid=${TENANT_B.siteId}`;

      const groupWrite = await send('PUT', `/v1/groups/${A_PRIVATE_GROUP.userid}?${query}`, headers, {
        siteid: TENANT_B.siteId,
        groupname: 'Renamed by B',
        ispublic: '0',
        ...csrfFields(B_SESSION.csrf_secret, A_PRIVATE_GROUP.userid),
      });
      const grant = await send('PUT', `/v1/permissions/modules/${USERS_MODULE}?${query}`, headers, {
        moduleid: USERS_MODULE,
        groupid: A_PRIVATE_GROUP.userid,
        ...csrfFields(B_SESSION.csrf_secret, USERS_MODULE),
      });
      const verdicts = await send('GET', `/v1/permissions/content/${A_CONTENT_ID}?${query}`, headers);

      expect({ group: groupWrite.statusCode, grant: grant.statusCode, verdicts: verdicts.statusCode }).toEqual({ group: 503, grant: 200, verdicts: 200 });
      // The save is halted rather than moving the tenant-a group into tenant-b's pool.
      expect(groupWrite.json()).toMatchObject({ error: { code: 'server_error' } });
      expect(grant.json()).toMatchObject({ written: true });
      const { groups } = verdicts.json<{ groups: Array<{ groupId: string; perm: string }> }>();
      expect(groups.map(({ groupId }) => groupId)).toContain(B_GROUP.userid);
      expect(groups.filter(({ perm }) => perm !== 'none')).toEqual([]);
      expect(leaked(groupWrite, TENANT_A_MARKERS)).toEqual([]);
      expect(leaked(verdicts, TENANT_A_MARKERS.filter((marker) => marker !== A_CONTENT_ID))).toEqual([]);
      expect(await storedRows(TENANT_A)).toEqual(before);
      const own = await withTenant(created().app, TENANT_B.tenantId, async (tx) => ({
        groups: (await tx.query(`SELECT userid FROM "${tx.schema}".group_account WHERE userid = $1`, [A_PRIVATE_GROUP.userid])).rows,
        grants: (
          await tx.query<{ tenant_id: string; siteid: string; type: string }>(
            `SELECT tenant_id::text, siteid, type FROM "${tx.schema}".permission WHERE contentid = $1 AND groupid = $2`,
            [USERS_MODULE, A_PRIVATE_GROUP.userid],
          )
        ).rows,
      }));
      // cperm.updatemodule stores any posted group id; the grant row is tenant-b data under tenant-b's site.
      expect(own).toEqual({ groups: [], grants: [{ tenant_id: TENANT_B.tenantId, siteid: TENANT_B.siteId, type: 'module' }] });
    });

    // Reproduced legacy behaviour, not an isolation guarantee: userManager.read loads a group by id from any site, and the
    // carried routes keep that site-independent lookup, reading the row only inside its own tenant's transaction.
    it('a tenant-b site-admin reading a tenant-a group by id finds it, as legacy userManager.read does for any site', async () => {
      const headers = await headersFor('site-admin', { site: TENANT_B.siteId, sub: MEMBER_B.account.userid });
      const admin = await send('GET', `/v1/groups/${A_PRIVATE_GROUP.userid}?siteid=${TENANT_B.siteId}`, headers);
      const api = await send('GET', `/_api/json/v1/${TENANT_B.siteId}/group/${A_PRIVATE_GROUP.userid}`, headers);

      expect([admin.statusCode, api.statusCode]).toEqual([200, 200]);
      expect(admin.json()).toMatchObject({ isNew: false, group: { UserID: A_PRIVATE_GROUP.userid, SiteID: TENANT_A.siteId } });
      expect(api.json()).toMatchObject({ data: { userid: A_PRIVATE_GROUP.userid, siteid: TENANT_A.siteId } });
    });

    it('POST /internal/v1/tokens for a tenant-b site with a tenant-a session yields no roles', async () => {
      const headers = await headersFor('service:gateway');
      const mint = async (siteId: string) => {
        const reply = await built().ctx.app.inject({
          method: 'POST',
          url: '/internal/v1/tokens',
          headers,
          payload: { sessionId: A_SESSION.session_id, siteId },
        });
        expect(reply.statusCode).toBe(200);
        return decodeJwt(reply.json<{ token: string }>().token);
      };

      const foreign = await mint(TENANT_B.siteId);
      const own = await mint(TENANT_A.siteId);

      expect(foreign).toMatchObject({ sub: SITE_ADMIN_A.account.userid, sid: A_SESSION.session_id, site: TENANT_B.siteId, tid: TENANT_B.tenantId, roles: [], s2: false });
      expect(own).toMatchObject({ site: TENANT_A.siteId, tid: TENANT_A.tenantId });
      expect(own.roles).toEqual(expect.arrayContaining(['site-admin']));
    });

    it('people.person.changed.v1 of tenant-a stores one person_contact row, visible to tenant-a only', async () => {
      const userId = cfUuid();
      const reply = await pushTo(built().ctx.app, PERSON_CONTACT_SUBSCRIPTION, personEnvelope(TENANT_A, userId));

      expect(isAck(reply), `push answered ${String(reply.statusCode)}`).toBe(true);
      const counts: Record<string, number> = {};
      for (const tenant of TENANT_LIST) {
        counts[tenant.key] = await withTenant(created().app, tenant.tenantId, async (tx) => {
          const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tx.schema}".person_contact WHERE user_id = $1`, [userId]);
          return rows[0]?.n ?? 0;
        });
      }
      expect(counts).toEqual({ A: 1, B: 0, umbrella: 0 });
    });
  });

  it('drops its throwaway schema and roles', async () => {
    const db = created();
    await ctx?.app.close();
    ctx = undefined;
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

