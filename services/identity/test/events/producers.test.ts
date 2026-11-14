/** Identity's event producers over PostgreSQL: atomic outbox writes, in-request flush, the sweep chain, replay and migration applies. */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createPublisher, readTopicSchema, type EventEnvelope, type PublisherOptions } from '@opt2/platform/events';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, cfUuid, generateCsrfToken } from '@opt2/platform/legacy-compat';
import { encodeRow, type ApplyRequest, type Mapping } from '@opt2/platform/migration-kit';
import { createOutbox, outboxRuntimeFor, publishLockedRows, rowFromDb } from '@opt2/platform/outbox';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_INTERVAL_S,
  slotName,
  slotStartS,
  successorSlotS,
  type CreateTaskResult,
  type TaskWireBody,
} from '@opt2/platform/tasks';
import { withMetadata, withTenant, type QueryResultRow, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  assertEventMatches,
  createTestSubscription,
  createTestTopic,
  createThrowawaySchema,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pgAvailable,
  pubsubEmulatorAvailable,
  seedRegistry,
  type CapturingPublisher,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { addToGroup, createGroup, removeFromGroup, updateGroup, type GroupActor, type GroupDeps } from '../../src/domain/groups.js';
import { DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS, legacyUrlStem, sendLoginByEmail, type LoginMailDeps, type LoginMailSettingsSource } from '../../src/domain/login-mail.js';
import { updateModulePermissions, type PermissionDeps } from '../../src/domain/permissions.js';
import {
  GROUP_CHANGED_TOPIC,
  LOGIN_MAIL_REQUESTED_TOPIC,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_TOPIC,
  createIdentityEvents,
  type IdentityEvents,
  type IdentityTopic,
} from '../../src/events/publish.js';
import { tpermissionsMapping, tusersGroupAccountMapping, tusersmembMapping } from '../../src/migration/mappings/index.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { GROUP_ACCOUNT, MEMBERSHIP, PERMISSION, REDIRECT } from '../../src/repo/tables.js';
import { SWEEP_QUEUE, buildTestApp, headersFor, type FakeTaskPort, type TestApp } from '../helpers/app.js';

/** An outbox row as stored, with the transaction id that last wrote it. */
interface StoredOutboxRow {
  seq: string;
  event_id: string;
  topic: string;
  kind: string;
  ordering_key: string;
  envelope: EventEnvelope;
  operation_id: string | null;
  held: boolean;
  published_at: Date | null;
  xmin: string;
}

/** A changelog row with its full `xid8` and that xid's low 32 bits, which a row's `xmin` carries. */
interface StoredChangelogRow {
  xid: string;
  xid_low: string;
  table: string;
  op: string;
  origin: string;
  request_id: string | null;
}

/** One write of a topic's aggregate, prepared over fresh ids. */
interface PreparedWrite {
  aggregateId: string;
  /** Runs the domain entry point; each further call writes the aggregate's next state. */
  write(): Promise<void>;
  /** The repository write and event of the entry point, inside `tx`. */
  writeInTx(tx: TenantTx): Promise<void>;
}

/** A topic identity produces and the domain entry point that writes it. */
interface TopicCase {
  topic: IdentityTopic;
  kind: 'state' | 'process';
  /** Tables the entry point's transaction records in the changelog. */
  tables: readonly string[];
  /** Business table holding the aggregate's rows, and the column naming the aggregate. */
  business: { table: string; column: string };
  prepare(): Promise<PreparedWrite>;
  /** Every stored version source of the aggregate. */
  storedVersions(aggregateId: string): Promise<number[]>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const SITE = TENANT_A.siteId;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const STATE_TOPICS: readonly string[] = [GROUP_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC, PERMISSION_CHANGED_TOPIC];
const ACTOR: GroupActor = { userId: cfUuid(), fname: 'Producer', lname: 'Suite', isSuperUser: true };
// bcrypt at its lowest cost keeps the generated group passwords cheap to hash.
const GROUP_SETTINGS: NonNullable<GroupDeps['settings']> = {
  password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 },
  hashAlgorithm: 'CFMX_COMPAT',
};
const MAIL_SETTINGS: LoginMailSettingsSource = {
  global: () => DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS,
  site: () => ({
    site: 'Tenant A Site',
    contact: 'contact@tenant-a.opt2.test',
    sendLoginScript: '',
    editProfileURL: '/profile/',
    extranetSSL: false,
    useSSL: false,
    serverPort: '',
    context: '',
    extranetPublicRegNotify: '',
  }),
  urlStem: (siteId, filename) => legacyUrlStem(siteId, filename, { siteIdInUrls: false, indexFileInUrls: true, hashUrls: false }),
};

/** The payload schema of `topic`, read from this service's contracts. */
function topicSchema(topic: IdentityTopic): object {
  return readTopicSchema(new URL(`../../contracts/events/${topic}.json`, import.meta.url));
}

/** A `group_account` insert of a tenant-a private-pool group. */
function groupInput(userid: string, groupname: string): GroupInput {
  return {
    userid, groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: SITE,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '',
  };
}

const PG_READY = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'].every((name) => Boolean(process.env[name])) && (await pgAvailable());
const EMULATOR_READY = PG_READY && (await pubsubEmulatorAvailable());

describe.skipIf(!PG_READY)('identity event producers against PostgreSQL', () => {
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];
  let publisher!: CapturingPublisher;
  let taskPort!: FakeTaskPort;
  let clock!: TestApp['clock'];
  let repo!: IdentityRepository;
  let events!: IdentityEvents;
  let groupDeps!: GroupDeps;
  let permissionDeps!: PermissionDeps;
  let mailDeps!: LoginMailDeps;
  const session = { sessionId: `S-producers-${cfUuid()}`, secret: cfUuid(), userId: cfUuid() };

  /** `<throwaway schema>.<table>`. */
  const table = (name: string): string => `${schema.schema}."${name}"`;

  /** Rows of `sql` read through the bootstrap pool in a read-only transaction scoped to tenant-a, as forced RLS requires. */
  async function adminRows<R extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<R[]> {
    const client = await schema.adminPool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A.tenantId]);
      const { rows } = await client.query<R>(sql, params);
      await client.query('COMMIT');
      client.release();
      return rows;
    } catch (err) {
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** Outbox rows of tenant-a matching `where`, in `seq` order. */
  function outboxRows(where: string, params: unknown[] = []): Promise<StoredOutboxRow[]> {
    return adminRows<StoredOutboxRow>(
      `SELECT seq::text AS seq, event_id::text AS event_id, topic, kind, ordering_key, envelope, operation_id, held, published_at,
              xmin::text AS xmin
         FROM ${table('outbox')} WHERE ${where} ORDER BY seq`,
      params,
    );
  }

  /** The outbox rows of one aggregate's topic. */
  function aggregateOutbox(topic: string, aggregateId: string): Promise<StoredOutboxRow[]> {
    return outboxRows('topic = $1 AND ordering_key = $2', [topic, aggregateId]);
  }

  /** Changelog rows of tenant-a matching `where`, in `seq` order. */
  function changelogRows(where: string, params: unknown[] = []): Promise<StoredChangelogRow[]> {
    return adminRows<StoredChangelogRow>(
      `SELECT xid::text AS xid, (xid::text::numeric % 4294967296)::text AS xid_low, "table", op, origin, request_id
         FROM ${table('changelog')} WHERE ${where} ORDER BY seq`,
      params,
    );
  }

  /** Rows of identity table `name` in tenant-a matching `where`. */
  function businessRows(name: string, where: string, params: unknown[] = []): Promise<QueryResultRow[]> {
    return adminRows(`SELECT * FROM ${table(name)} WHERE ${where}`, params);
  }

  /** Row count of identity table `name` in tenant-a. */
  async function countRows(name: string): Promise<number> {
    const [row] = await adminRows<{ count: number }>(`SELECT count(*)::int AS count FROM ${table(name)}`);
    return row?.count ?? 0;
  }

  /** The stored `aggregate_version` of `topic`'s aggregate `aggregateId`; 0 when it has none. */
  async function aggregateVersion(topic: string, aggregateId: string): Promise<number> {
    const [row] = await adminRows<{ row_version: string }>(
      `SELECT row_version::text AS row_version FROM ${table('aggregate_version')} WHERE aggregate_type = $1 AND aggregate_id = $2`,
      [topic, aggregateId],
    );
    return Number(row?.row_version ?? 0);
  }

  /** The envelopes the capturing publisher received for one aggregate's topic, in publish order. */
  function publishedFor(topic: string, aggregateId: string): EventEnvelope[] {
    return publisher.published.filter((event) => event.topic === topic && event.envelope.aggregateId === aggregateId).map((event) => event.envelope);
  }

  /** Commits a Type=2 tenant-a account with a contact row and returns its id. */
  async function seedUser(email = `producer-${cfUuid().slice(0, 8).toLowerCase()}@tenant-a.opt2.test`): Promise<string> {
    const userId = cfUuid();
    await withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
      await repo.insertAccount(tx, {
        userid: userId, username: `producer_${userId.slice(0, 8).toLowerCase()}`, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: SITE,
        remoteid: '', tablist: '',
      });
      await repo.upsertPersonContact(tx, { user_id: userId, site_id: SITE, email, fname: 'Pat', lname: 'Producer', company: null, subtype: null, aggregate_version: 1 });
    });
    return userId;
  }

  /** Commits a tenant-a private-pool group without publishing and returns its id. */
  async function seedGroup(): Promise<string> {
    const groupId = cfUuid();
    await withTenant(schema.app, TENANT_A.tenantId, (tx) => repo.insertGroup(tx, groupInput(groupId, `Seeded ${groupId.slice(0, 8)}`), null));
    return groupId;
  }

  /** `app.inject` headers of the gateway relaying for the suite's signed-in S2 admin session. */
  async function adminHeaders(): Promise<Record<string, string>> {
    const user = await mintUserToken({ sub: session.userId, sid: session.sessionId, site: SITE, roles: [Roles.systemUser, Roles.s2], s2: true });
    return { authorization: `Bearer ${user}`, ...(await gatewayHeaders()) };
  }

  /** The gateway's invocation credential alone, as an anonymous relayed request carries it. */
  async function gatewayHeaders(): Promise<Record<string, string>> {
    return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity' })}` };
  }

  /** CSRF form fields valid for `context` in the admin session. */
  function csrfFields(context: string): Record<string, string> {
    const { token, expires } = generateCsrfToken({ context, secret: session.secret, now: clock.now() });
    return { [CSRF_FIELD_TOKEN]: token, [CSRF_FIELD_EXPIRES]: expires };
  }

  /** Start of the sweep slot holding the suite clock's now, in epoch seconds. */
  function currentSlotS(): number {
    return slotStartS(Math.floor(clock.now().getTime() / 1000), OUTBOX_SWEEP_INTERVAL_S);
  }

  /** Headers of the local Cloud Tasks adapter delivering the sweep task of `slot`. */
  async function sweepHeaders(slot = currentSlotS()): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'identity' })}`,
      [CLOUD_TASKS_HEADERS.taskName]: slotName(SWEEP_QUEUE, slot),
      [CLOUD_TASKS_HEADERS.queueName]: SWEEP_QUEUE,
    };
  }

  /** The system task body of the sweep task of `slot`. */
  function sweepBody(slot = currentSlotS()): TaskWireBody {
    return { queue: SWEEP_QUEUE, name: slotName(SWEEP_QUEUE, slot), tenantId: null, payload: {} };
  }

  /** POSTs the current slot's sweep task, with the tasks-invoker credential unless `headers` replaces it. */
  async function sweep(headers?: Record<string, string>) {
    return app.inject({ method: 'POST', url: '/internal/v1/outbox/sweep', headers: headers ?? (await sweepHeaders()), payload: sweepBody() });
  }

  /** The migration service's invocation credential. */
  function migrationHeaders(): Promise<Record<string, string>> {
    return headersFor('service:migration');
  }

  /** POSTs `batch` to the migration apply route with `headers` (the migration service by default). */
  async function apply(batch: ApplyRequest, headers?: Record<string, string>) {
    return app.inject({ method: 'POST', url: '/internal/v1/migration/apply', headers: headers ?? (await migrationHeaders()), payload: batch });
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'identity', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    ({ app, publisher, taskPort, clock } = await buildTestApp({ db: schema.app }));
    await app.ready();
    // Gates start legacy-authoritative; the suite exercises the target-authoritative writers.
    await withMetadata(schema.app, (tx) => tx.query(`UPDATE ${table('unit_gate')} SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    repo = createIdentityRepository({ clock, schema: schema.schema });
    events = createIdentityEvents(repo);
    groupDeps = { db: schema.app, repo, events, clock, settings: GROUP_SETTINGS };
    permissionDeps = { db: schema.app, repo, events };
    mailDeps = { db: schema.app, repo, events, clock, settings: MAIL_SETTINGS };
    const snapshot = {
      userid: session.userId, username: 'admin', siteid: SITE, subtype: 'Default', password: null, fname: 'Admin', lname: 'User', email: null,
      remoteid: null, company: null, lastlogin: null, passwordcreated: null, roleList: `S2,Admin;${SITE};0`, membershipIds: session.userId,
    };
    await withTenant(schema.app, TENANT_A.tenantId, (tx) =>
      repo.insertSession(tx, {
        session_id: session.sessionId, csrf_secret: session.secret, mode: 'target-primary', state: 'active', user_id: session.userId, site_id: SITE,
        login_snapshot: JSON.stringify(snapshot),
      }),
    );
  });

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  beforeEach(() => {
    publisher.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // An injected publish failure a case did not consume must not fail a later case's publish.
    publisher.failNext(0);
  });

  const TOPIC_CASES: readonly TopicCase[] = [
    {
      topic: GROUP_CHANGED_TOPIC,
      kind: 'state',
      tables: [GROUP_ACCOUNT.table, 'user_address', 'aggregate_version'],
      business: { table: GROUP_ACCOUNT.table, column: 'userid' },
      async prepare() {
        const groupId = cfUuid();
        let saves = 0;
        return {
          aggregateId: groupId,
          async write() {
            saves += 1;
            const input = { userId: groupId, siteId: SITE, groupName: `Producers ${String(saves)}`, isPublic: 0 };
            const result = await (saves === 1 ? createGroup(groupDeps, ACTOR, input) : updateGroup(groupDeps, ACTOR, input));
            expect(result).toMatchObject({ written: true, errors: {} });
          },
          async writeInTx(tx) {
            const group = await repo.insertGroup(tx, groupInput(groupId, 'Rolled Back'), null);
            await events.publishGroupChanged(tx, group, { deleted: false });
          },
        };
      },
      async storedVersions(groupId) {
        const [row] = await businessRows(GROUP_ACCOUNT.table, 'userid = $1', [groupId]);
        return [await aggregateVersion(GROUP_CHANGED_TOPIC, groupId), Number(row?.row_version)];
      },
    },
    {
      topic: MEMBERSHIP_CHANGED_TOPIC,
      kind: 'state',
      tables: [MEMBERSHIP.table, 'aggregate_version'],
      business: { table: MEMBERSHIP.table, column: 'userid' },
      async prepare() {
        const [userId, groupId] = [await seedUser(), await seedGroup()];
        let changes = 0;
        return {
          aggregateId: userId,
          async write() {
            changes += 1;
            const change = changes % 2 === 1 ? addToGroup : removeFromGroup;
            expect(await change(groupDeps, { userId, groupId })).toBe(true);
          },
          async writeInTx(tx) {
            await repo.addMembership(tx, userId, groupId);
            await events.publishMembershipChanged(tx, { userId, siteId: SITE, groupIds: [groupId] });
          },
        };
      },
      async storedVersions(userId) {
        return [await aggregateVersion(MEMBERSHIP_CHANGED_TOPIC, userId)];
      },
    },
    // Module grants are identity's only built permission save; node saves also write approval chains and stay on legacy.
    {
      topic: PERMISSION_CHANGED_TOPIC,
      kind: 'state',
      tables: [PERMISSION.table, 'aggregate_version'],
      business: { table: PERMISSION.table, column: 'groupid' },
      async prepare() {
        const groupId = cfUuid();
        return {
          aggregateId: groupId,
          async write() {
            // Each save grants a further module, so every save changes the group's permission state.
            const { changedGroupIds } = await updateModulePermissions(permissionDeps, { siteId: SITE, moduleId: cfUuid(), groupIds: [groupId] });
            expect(changedGroupIds).toEqual([groupId]);
          },
          async writeInTx(tx) {
            await repo.replaceModulePermissions(tx, { moduleId: cfUuid(), siteId: SITE, groupIds: [groupId] });
            await events.publishPermissionChanged(tx, { groupId, siteId: SITE, rows: await repo.groupPermissions(tx, groupId, SITE) });
          },
        };
      },
      async storedVersions(groupId) {
        return [await aggregateVersion(PERMISSION_CHANGED_TOPIC, groupId)];
      },
    },
    {
      topic: LOGIN_MAIL_REQUESTED_TOPIC,
      kind: 'process',
      tables: [REDIRECT.table, 'aggregate_version'],
      business: { table: REDIRECT.table, column: 'userid' },
      async prepare() {
        const email = `mail-${cfUuid().slice(0, 8).toLowerCase()}@tenant-a.opt2.test`;
        const userId = await seedUser(email);
        return {
          aggregateId: userId,
          async write() {
            const requests = await sendLoginByEmail(mailDeps, { email, siteId: SITE, httpHost: `${SITE}.opt2.test` });
            expect(requests.map((request) => request.userId)).toEqual([userId]);
          },
          async writeInTx(tx) {
            const returnId = cfUuid();
            await repo.insert(tx, REDIRECT.table, { redirectid: returnId, url: '/profile/', created: clock.now(), userid: userId, siteid: SITE });
            await events.publishLoginMailRequested(tx, {
              messageId: cfUuid(), userId, returnId, siteId: SITE, to: email, from: 'Tenant A Site', subject: 'Tenant A Site Account Information',
              text: 'Rolled back.\n', bcc: '', kind: 'forgot-password',
            });
          },
        };
      },
      async storedVersions(userId) {
        return [await aggregateVersion(LOGIN_MAIL_REQUESTED_TOPIC, userId)];
      },
    },
  ];

  const caseOf = (topic: IdentityTopic): TopicCase => {
    const found = TOPIC_CASES.find((candidate) => candidate.topic === topic);
    if (found === undefined) throw new TypeError(`no topic case for ${topic}`);
    return found;
  };

  describe.each(TOPIC_CASES)('$topic', (topicCase) => {
    it('commits the business rows, their changelog rows and one outbox row of the declared kind in one transaction', async () => {
      const prepared = await topicCase.prepare();
      // A failed flush leaves the row as its writing transaction stored it, so its xmin names that transaction.
      publisher.failNext();

      await prepared.write();

      const rows = await aggregateOutbox(topicCase.topic, prepared.aggregateId);
      expect(rows).toHaveLength(1);
      const [row] = rows as [StoredOutboxRow];
      expect(row).toMatchObject({ kind: topicCase.kind, held: false, operation_id: null, published_at: null });
      expect(row.envelope.eventId).toBe(row.event_id);
      expect(await businessRows(topicCase.business.table, `${topicCase.business.column} = $1`, [prepared.aggregateId])).not.toHaveLength(0);
      const logs = await changelogRows('(xid::text::numeric % 4294967296)::text = $1', [row.xmin]);
      expect(new Set(logs.map((log) => log.xid)).size).toBe(1);
      expect(logs.map((log) => log.table)).toEqual(expect.arrayContaining([...topicCase.tables]));
      expect(new Set(logs.map((log) => log.origin))).toEqual(new Set(['target']));
    });

    it('leaves no business, changelog or outbox row and publishes nothing when the transaction rolls back', async () => {
      const prepared = await topicCase.prepare();
      const changelogBefore = await countRows('changelog');
      const outboxBefore = await countRows('outbox');

      const rolledBack = withTenant(schema.app, TENANT_A.tenantId, async (tx) => {
        await prepared.writeInTx(tx);
        throw new Error('forced rollback');
      });

      await expect(rolledBack).rejects.toThrow('forced rollback');
      expect(await businessRows(topicCase.business.table, `${topicCase.business.column} = $1`, [prepared.aggregateId])).toEqual([]);
      expect(await outboxRows('ordering_key = $1', [prepared.aggregateId])).toEqual([]);
      expect(await countRows('changelog')).toBe(changelogBefore);
      expect(await countRows('outbox')).toBe(outboxBefore);
      expect(await aggregateVersion(topicCase.topic, prepared.aggregateId)).toBe(0);
      expect(publisher.published).toEqual([]);
    });

    it('publishes a contract-valid envelope keyed by the aggregate once the domain call has committed and flushed', async () => {
      const prepared = await topicCase.prepare();

      await prepared.write();

      const published = publishedFor(topicCase.topic, prepared.aggregateId);
      expect(published).toHaveLength(1);
      const [envelope] = published as [EventEnvelope];
      assertEventMatches(undefined, topicSchema(topicCase.topic), envelope);
      expect(envelope).toMatchObject({ tenantId: TENANT_A.tenantId, producer: 'identity', aggregateId: prepared.aggregateId });
      const [row] = await aggregateOutbox(topicCase.topic, prepared.aggregateId);
      expect(row?.ordering_key).toBe(prepared.aggregateId);
      expect(row?.published_at).toBeInstanceOf(Date);
      expect(row?.envelope).toEqual(envelope);
    });

    it('numbers successive events of one aggregate from its stored version sequence', async () => {
      const prepared = await topicCase.prepare();

      await prepared.write();
      const first = await topicCase.storedVersions(prepared.aggregateId);
      await prepared.write();
      const second = await topicCase.storedVersions(prepared.aggregateId);

      const versions = publishedFor(topicCase.topic, prepared.aggregateId).map((envelope) => envelope.aggregateVersion);
      expect(versions).toEqual([1, 2]);
      expect(first).toEqual(first.map(() => 1));
      expect(second).toEqual(second.map(() => 2));
    });
  });

  describe('in-request flush', () => {
    /** One HTTP entry point per topic family, with the aggregate it writes. */
    const ROUTES: ReadonlyArray<{ name: string; topic: IdentityTopic; send(): Promise<{ status: number; body: unknown; aggregateId: string }> }> = [
      {
        name: 'POST /v1/groups',
        topic: GROUP_CHANGED_TOPIC,
        async send() {
          const groupId = cfUuid();
          const form = { userid: groupId, groupname: `HTTP ${groupId.slice(0, 8)}`, siteid: SITE, isPublic: '0', ...csrfFields(groupId) };
          const res = await app.inject({ method: 'POST', url: '/v1/groups', headers: { ...(await adminHeaders()), ...FORM }, payload: new URLSearchParams(form).toString() });
          return { status: res.statusCode, body: res.json(), aggregateId: groupId };
        },
      },
      {
        name: 'DELETE /v1/groups/{groupId}/members/{userId}',
        topic: MEMBERSHIP_CHANGED_TOPIC,
        async send() {
          const [userId, groupId] = [await seedUser(), await seedGroup()];
          await withTenant(schema.app, TENANT_A.tenantId, (tx) => repo.addMembership(tx, userId, groupId));
          const res = await app.inject({ method: 'DELETE', url: `/v1/groups/${groupId}/members/${userId}`, headers: await adminHeaders() });
          return { status: res.statusCode, body: res.json(), aggregateId: userId };
        },
      },
      {
        name: 'PUT /v1/permissions/modules/{moduleId}',
        topic: PERMISSION_CHANGED_TOPIC,
        async send() {
          const [groupId, moduleId] = [cfUuid(), cfUuid()];
          const form = { groupid: groupId, moduleid: moduleId, ...csrfFields(moduleId) };
          const res = await app.inject({
            method: 'PUT',
            url: `/v1/permissions/modules/${moduleId}`,
            headers: { ...(await adminHeaders()), ...FORM },
            payload: new URLSearchParams(form).toString(),
          });
          return { status: res.statusCode, body: res.json(), aggregateId: groupId };
        },
      },
      {
        // Without a site id the forgot-password form mails from the global settings, which identity holds.
        name: 'POST /v1/login-mail',
        topic: LOGIN_MAIL_REQUESTED_TOPIC,
        async send() {
          const email = `http-${cfUuid().slice(0, 8).toLowerCase()}@tenant-a.opt2.test`;
          const userId = await seedUser(email);
          const res = await app.inject({ method: 'POST', url: '/v1/login-mail', headers: await gatewayHeaders(), payload: { email } });
          return { status: res.statusCode, body: res.json(), aggregateId: userId };
        },
      },
    ];

    it.each(ROUTES)('publishes and stamps the outbox row of $name before the response returns', async ({ topic, send }) => {
      const { status, body, aggregateId } = await send();

      expect(status).toBe(200);
      expect(body).not.toMatchObject({ written: false });
      const published = publishedFor(topic, aggregateId);
      expect(published).toHaveLength(1);
      const rows = await aggregateOutbox(topic, aggregateId);
      expect(rows.map((row) => row.event_id)).toEqual(published.map((envelope) => envelope.eventId));
      expect(rows[0]?.published_at).toBeInstanceOf(Date);
    });
  });

  describe('outbox sweep', () => {
    /** Writes a group whose in-request flush fails and returns its still-unpublished outbox row. */
    async function unpublishedGroupRow(): Promise<StoredOutboxRow> {
      const prepared = await caseOf(GROUP_CHANGED_TOPIC).prepare();
      publisher.failNext();
      await prepared.write();
      const [row] = await aggregateOutbox(GROUP_CHANGED_TOPIC, prepared.aggregateId);
      expect(row?.published_at).toBeNull();
      return row as StoredOutboxRow;
    }

    /** The successor slot name a sweep of the current slot secures. */
    function successorName(): string {
      return slotName(SWEEP_QUEUE, successorSlotS(currentSlotS(), Math.floor(clock.now().getTime() / 1000), OUTBOX_SWEEP_INTERVAL_S));
    }

    it('publishes a committed-but-unpublished row on the next sweep under its original eventId', async () => {
      const row = await unpublishedGroupRow();

      const res = await sweep();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ failed: 0 });
      expect(res.json<{ published: number }>().published).toBeGreaterThanOrEqual(1);
      const [swept] = await outboxRows('event_id = $1', [row.event_id]);
      expect(swept?.published_at).toBeInstanceOf(Date);
      expect(publisher.published.filter((event) => event.envelope.eventId === row.event_id).map((event) => event.envelope)).toEqual([row.envelope]);
    });

    it('secures the successor task before publishing and finds it already secured on a repeated sweep', async () => {
      const row = await unpublishedGroupRow();
      const order: string[] = [];
      const creates: CreateTaskResult[] = [];
      const create = taskPort.create.bind(taskPort);
      const publish = publisher.publish.bind(publisher);
      vi.spyOn(taskPort, 'create').mockImplementation(async (input) => {
        order.push(`create ${input.name}`);
        const result = await create(input);
        creates.push(result);
        return result;
      });
      vi.spyOn(publisher, 'publish').mockImplementation(async (topic, envelope) => {
        order.push(`publish ${envelope.eventId}`);
        return publish(topic, envelope);
      });

      const first = await sweep();
      const repeated = await sweep();

      expect([first.statusCode, repeated.statusCode]).toEqual([200, 200]);
      const successor = `create ${successorName()}`;
      expect(order[0]).toBe(successor);
      expect(order).toContain(`publish ${row.event_id}`);
      expect(order.slice(0, order.indexOf(`publish ${row.event_id}`)).filter((entry) => entry.startsWith('create '))).toEqual([successor]);
      expect(order.filter((entry) => entry === successor)).toHaveLength(2);
      expect(creates.at(-1)).toEqual({ name: successorName(), created: false });
      expect(taskPort.tasks.has(`${SWEEP_QUEUE}/${successorName()}`)).toBe(true);
    });

    it('answers 503 and publishes nothing when the successor task cannot be created', async () => {
      const row = await unpublishedGroupRow();
      taskPort.failCreate(SWEEP_QUEUE);

      const res = await sweep();

      expect(res.statusCode).toBe(503);
      const [kept] = await outboxRows('event_id = $1', [row.event_id]);
      expect(kept?.published_at).toBeNull();
      expect(publisher.published).toEqual([]);
    });

    it('leaves the held rows of an open operation unpublished', async () => {
      const groupId = cfUuid();
      const operationId = cfUuid();
      const held = await withTenant(schema.app, TENANT_A.tenantId, (tx) =>
        events.publishGroupChanged(tx, { userid: groupId, siteid: SITE, groupname: 'Held', ispublic: 0 }, { deleted: false, operationId }),
      );

      const res = await sweep();

      expect(res.statusCode).toBe(200);
      expect(await aggregateOutbox(GROUP_CHANGED_TOPIC, groupId)).toEqual([
        expect.objectContaining({ event_id: held?.eventId, operation_id: operationId, held: true, published_at: null }),
      ]);
      expect(publishedFor(GROUP_CHANGED_TOPIC, groupId)).toEqual([]);
    });

    it.each(['s2', 'service:people'])('refuses the sweep to the %s credential before any task or publish', async (subject) => {
      const create = vi.spyOn(taskPort, 'create');
      const headers = { ...(await headersFor(subject)), [CLOUD_TASKS_HEADERS.taskName]: sweepBody().name, [CLOUD_TASKS_HEADERS.queueName]: SWEEP_QUEUE };

      const res = await sweep(headers);

      expect([401, 403]).toContain(res.statusCode);
      expect(create).not.toHaveBeenCalled();
      expect(publisher.published).toEqual([]);
    });
  });

  describe('outbox replay', () => {
    it('republishes a stored row with its original envelope, eventId and aggregateVersion included', async () => {
      const prepared = await caseOf(GROUP_CHANGED_TOPIC).prepare();
      await prepared.write();
      const [stored] = await adminRows(`SELECT * FROM ${table('outbox')} WHERE ordering_key = $1`, [prepared.aggregateId]);
      const row = rowFromDb(stored as QueryResultRow);
      publisher.clear();

      const summary = await withTenant(schema.app, TENANT_A.tenantId, (tx) => publishLockedRows(tx, outboxRuntimeFor(schema.schema), [row]));

      expect(summary).toEqual({ published: 1, failed: 0, skipped: 0 });
      expect(publisher.published).toEqual([{ topic: GROUP_CHANGED_TOPIC, envelope: row.envelope }]);
      expect(publisher.published[0]?.envelope).toMatchObject({ eventId: row.eventId, aggregateVersion: 1 });
    });
  });

  describe('migration applies', () => {
    /** A `tusers` row of tenant-a with every mapped column, NULL unless `values` sets it. */
    function tusersRow(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
      return { ...Object.fromEntries(tusersGroupAccountMapping.legacyColumns.map((column) => [column.name, null])), ...values };
    }

    /** A backfill batch of `rows` encoded over the legacy columns of `mapping`. */
    function batch(mapping: Mapping, rows: readonly Record<string, unknown>[]): ApplyRequest {
      const columns = mapping.legacyColumns;
      return {
        batchId: `producers-${mapping.legacyTable}-${cfUuid()}`,
        origin: 'backfill',
        legacyTable: mapping.legacyTable,
        siteId: SITE,
        columns: columns.map((column) => ({ ...column })),
        rows: rows.map((row) => ({ op: 'upsert' as const, row: encodeRow(columns, row) })),
      };
    }

    /** The `tusers` batch of one Type=1 group and one Type=2 user of tenant-a. */
    function tusersBatch(groupId: string, userId: string): ApplyRequest {
      return batch(tusersGroupAccountMapping, [
        tusersRow({ UserID: groupId, GroupName: 'Backfilled', Type: 1, S2: 0, Perm: 0, InActive: 0, isPublic: 0, SiteID: SITE, subType: 'Default' }),
        tusersRow({
          UserID: userId, UserName: `backfill_${userId.slice(0, 8).toLowerCase()}`, Password: 'not-a-real-hash', PasswordCreated: '2026-06-01 09:00:00',
          Type: 2, S2: 0, Perm: 0, InActive: 0, isPublic: 0, SiteID: SITE, Fname: 'Back', Lname: 'Fill',
        }),
      ]);
    }

    /** The highest outbox `seq` of tenant-a, 0 for an empty outbox. */
    async function lastOutboxSeq(): Promise<number> {
      const [row] = await adminRows<{ seq: string | null }>(`SELECT max(seq)::text AS seq FROM ${table('outbox')}`);
      return Number(row?.seq ?? 0);
    }

    it('emits only state events for backfilled groups, users, memberships and permissions, audited as backfill', async () => {
      const [groupId, userId] = [cfUuid(), cfUuid()];
      const batches = [
        tusersBatch(groupId, userId),
        batch(tusersmembMapping, [{ UserID: userId, GroupID: groupId }]),
        batch(tpermissionsMapping, [{ ContentID: cfUuid(), GroupID: groupId, SiteID: SITE, Type: 'Editor' }]),
      ];
      const after = await lastOutboxSeq();

      for (const body of batches) {
        const res = await apply(body);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ batchId: body.batchId, duplicate: false, applied: body.rows.length, skipped: 0 });
      }

      const rows = await outboxRows('seq > $1', [after]);
      expect(rows.map((row) => [row.topic, row.ordering_key])).toEqual(
        expect.arrayContaining([
          [GROUP_CHANGED_TOPIC, groupId],
          [MEMBERSHIP_CHANGED_TOPIC, userId],
          [PERMISSION_CHANGED_TOPIC, groupId],
        ]),
      );
      expect(rows.every((row) => STATE_TOPICS.includes(row.topic) && row.kind === 'state')).toBe(true);
      expect(publisher.published.map((event) => event.topic).every((topic) => STATE_TOPICS.includes(topic))).toBe(true);
      expect(publisher.published.map((event) => event.envelope.eventId).sort()).toEqual(rows.map((row) => row.event_id).sort());
      const logs = await changelogRows('request_id = ANY($1::text[])', [batches.map((body) => body.batchId)]);
      expect(logs.length).toBeGreaterThan(0);
      expect(new Set(logs.map((log) => log.origin))).toEqual(new Set(['backfill']));
    });

    it('treats a repeated batch as a no-op that writes no outbox or changelog row', async () => {
      const body = tusersBatch(cfUuid(), cfUuid());
      expect((await apply(body)).statusCode).toBe(200);
      const outboxBefore = await countRows('outbox');
      const changelogBefore = await countRows('changelog');
      publisher.clear();

      const repeated = await apply(body);

      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toEqual({ batchId: body.batchId, duplicate: true, applied: 0, skipped: 0 });
      expect(await countRows('outbox')).toBe(outboxBefore);
      expect(await countRows('changelog')).toBe(changelogBefore);
      expect(publisher.published).toEqual([]);
    });

    it('refuses an apply from a service without the platform.migration role', async () => {
      const body = tusersBatch(cfUuid(), cfUuid());

      const res = await apply(body, await headersFor('service:people'));

      expect(res.statusCode).toBe(403);
      expect(await adminRows(`SELECT 1 FROM ${table('migration_batch')} WHERE batch_id = $1`, [body.batchId])).toEqual([]);
    });
  });

  describe.skipIf(!EMULATOR_READY)('against the Pub/Sub emulator', () => {
    it('publishes a group save once, ordered by the group id', async () => {
      const topic = await createTestTopic();
      const subscription = await createTestSubscription(topic);
      const original = outboxRuntimeFor(schema.schema);
      // The publisher keeps the contract checks of the real topic name while the client sends to the run's own topic.
      const client = { topic: () => topic.topic, close: () => Promise.resolve() } as unknown as NonNullable<PublisherOptions['pubsub']>;
      const emulator = createPublisher({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local', pubsub: client, payloadValidators: original.payloadValidators });
      const register = (target: typeof original.publisher): void => {
        createOutbox({ ...original, publisher: target, payloadValidators: new Map(original.payloadValidators) });
      };
      register(emulator);
      try {
        const prepared = await caseOf(GROUP_CHANGED_TOPIC).prepare();

        await prepared.write();

        const [row] = await aggregateOutbox(GROUP_CHANGED_TOPIC, prepared.aggregateId);
        expect(row?.published_at).toBeInstanceOf(Date);
        const messages = await subscription.pull(10, 5_000);
        expect(messages.map((message) => ({ orderingKey: message.orderingKey, eventId: message.attributes.eventId }))).toEqual([
          { orderingKey: prepared.aggregateId, eventId: row?.event_id },
        ]);
      } finally {
        register(original.publisher);
        await emulator.close();
        await subscription.delete();
        await topic.delete();
      }
    });
  });
});
