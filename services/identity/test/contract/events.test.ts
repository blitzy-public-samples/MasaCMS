/** Event contracts of identity: its topic schemas, the envelopes its routes and event writers put in the outbox, and its consumers against the producers' schemas. */
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  compileTopicSchema,
  consumeEnvelope,
  eventTypeOf,
  readTopicSchema,
  schemaVersionOf,
  subscriptionName,
  topicMeta,
  type EventEnvelope,
  type EventKind,
  type TopicValidator,
} from '@opt2/platform/events';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { OUTBOX_TABLE, rowFromDb, type OutboxRow } from '@opt2/platform/outbox';
import { tenantIdForSite, type QueryResultRow, type SiteChangedPayload, type TenantTx } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  TENANT_A,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertProducerConsumerCompatible,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type ConsumerExpectation,
  type JsonType,
} from '@opt2/platform/testing';
import {
  GROUP_CHANGED_TOPIC,
  IDENTITY_TOPICS,
  LOGIN_MAIL_REQUESTED_TOPIC,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_TOPIC,
  createIdentityEvents,
  groupChangedPayload,
  identityPayloadValidators,
  type GroupChangedPayload,
  type IdentityEvents,
  type IdentityTopic,
  type LoginMailRequestedPayload,
} from '../../src/events/publish.js';
import { PERSON_CHANGED_TOPIC, PERSON_CONTACT_SUBSCRIPTION, personChangedSchema, personContactConsumer, type PersonChangedPayload } from '../../src/events/person-contact.js';
import { CREDENTIAL, GROUP_ACCOUNT, MEMBERSHIP, PERMISSION } from '../../src/repo/tables.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import type { RecordingDb } from '../helpers/memory-repo.js';
import { EDITOR, SITE_ADMIN_A, groupRow, membershipRow, permissionRow, type PermissionType } from '../helpers/rows.js';
import {
  SITE_A,
  SUBJECT_SESSIONS,
  buildIdentityApp,
  cfId,
  credentialsFor,
  csrfFor,
  relayedCredentials,
  subjectNamed,
  type IdentityTestApp,
} from '../helpers/service.js';

type Schema = Record<string, unknown>;

const EVENTS_DIR = new URL('../../contracts/events/', import.meta.url);
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };
/** Topic names of the schema files in `contracts/events/`. */
const SCHEMA_FILES = readdirSync(EVENTS_DIR)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''));
const SCHEMAS: Readonly<Record<string, Schema>> = Object.fromEntries(
  IDENTITY_TOPICS.map((topic) => [topic, readTopicSchema(new URL(`../../contracts/events/${topic}.json`, import.meta.url))]),
);
const PERSON_PRODUCER = JSON.parse(
  readFileSync(new URL('../../../people/contracts/events/people.person.changed.v1.json', import.meta.url), 'utf8'),
) as Schema;
const SITE_PRODUCER = JSON.parse(
  readFileSync(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as Schema;

/** The `x-opt2-kind` each identity topic is published under. */
const TOPIC_KINDS: Readonly<Record<IdentityTopic, EventKind>> = {
  'identity.group.changed.v1': 'state',
  'identity.membership.changed.v1': 'state',
  'identity.permission.changed.v1': 'state',
  'identity.login-mail.requested.v1': 'process',
};

/** The payload schema of `topic`; throws for a topic identity does not publish. */
function schemaFor(topic: string): Schema {
  const schema = SCHEMAS[topic];
  if (schema === undefined) throw new Error(`No contract for ${topic}`);
  return schema;
}

/** The compiled payload validator the outbox runtime checks `topic` writes with. */
function validatorFor(topic: IdentityTopic): TopicValidator {
  const validator = identityPayloadValidators[topic];
  if (validator === undefined) throw new Error(`identity registers no payload validator for ${topic}`);
  return validator;
}

/** Every key declared under a `properties` object anywhere in `node`, whether nested, in `$defs`, `items` or a combinator. */
function declaredPropertyNames(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(declaredPropertyNames);
  if (typeof node !== 'object' || node === null) return [];
  const { properties } = node as { properties?: unknown };
  const own = typeof properties === 'object' && properties !== null ? Object.keys(properties) : [];
  return [...own, ...Object.values(node).flatMap(declaredPropertyNames)];
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const USERS_MODULE = '00000000000000000000000000000000008';
const EDITOR_GROUP = EDITOR.groups[0]?.userid ?? '';
const ADMIN_GROUP = SITE_ADMIN_A.groups[0]?.userid ?? '';
const NEW_GROUP = cfId('A', 801);
const RENAMED_GROUP = cfId('A', 803);
const NEW_USER = cfId('E', 802);
const OPERATION_ID = cfId('F', 802);

function subjectSession(name: string) {
  const session = SUBJECT_SESSIONS[name];
  if (session === undefined) throw new TypeError(`No subject session ${name}`);
  return session;
}

/** Form fields of the token a subject session's secret issues for `context`. */
function csrfFields(subject: string, context: string): string {
  const { token, expires } = csrfFor(subjectSession(subject), context);
  return `${CSRF_FIELD_TOKEN}=${encodeURIComponent(token)}&${CSRF_FIELD_EXPIRES}=${encodeURIComponent(expires)}`;
}

/** The outbox `kind` column of each envelope the last flow wrote, by event id. */
function outboxKinds(t: IdentityTestApp): Map<string, unknown> {
  return new Map(
    t.db
      .writes()
      .filter((write) => write.verb === 'INSERT' && write.table === 'identity.outbox')
      .map((write): [string, unknown] => [String(write.values[1]), write.values[3]]),
  );
}

/** Validates every envelope the last flow wrote against its topic schema and returns them. */
function writtenEnvelopes(t: IdentityTestApp): EventEnvelope[] {
  const kinds = outboxKinds(t);
  return t.outboxEvents().map((envelope) => {
    const schema = schemaFor(`${envelope.eventType}.v${envelope.schemaVersion.split('.')[0] ?? ''}`);
    assertEventMatches(undefined, schema, envelope);
    expect(kinds.get(envelope.eventId)).toBe(schema['x-opt2-kind']);
    expect(envelope.producer).toBe('identity');
    return envelope;
  });
}

describe('topic schemas', () => {
  it('are exactly the topics identity publishes, one file per topic constant', () => {
    const constants = [GROUP_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC, PERMISSION_CHANGED_TOPIC, LOGIN_MAIL_REQUESTED_TOPIC];
    expect([...IDENTITY_TOPICS].sort()).toEqual([...constants].sort());
    expect([...SCHEMA_FILES].sort()).toEqual([...IDENTITY_TOPICS].sort());
  });

  it('registers a runtime payload validator for exactly the topics identity publishes', () => {
    expect(new Set(Object.keys(identityPayloadValidators))).toEqual(new Set(IDENTITY_TOPICS));
    expect(Object.keys(identityPayloadValidators)).toHaveLength(IDENTITY_TOPICS.length);
  });

  it('the login-mail schema declares no password or hash property at any depth', () => {
    const names = declaredPropertyNames(schemaFor(LOGIN_MAIL_REQUESTED_TOPIC));
    expect(names).toContain('userId');
    expect(names.filter((name) => /password|hash/i.test(name))).toEqual([]);
  });

  it.each(Object.entries(TOPIC_KINDS))('%s carries its URN, the pinned SHA and kind %s', (topic, kind) => {
    expect(SCHEMAS[topic]).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `urn:opt2:identity:event:${topic}`,
      $comment: `source-sha: ${PIN.sha}`,
      'x-opt2-kind': kind,
    });
    expect(SCHEMAS[topic]).not.toHaveProperty(['x-opt2-tenant-fanout']);
  });
});

describe.each(Object.entries(TOPIC_KINDS) as Array<[IdentityTopic, EventKind]>)('%s schema', (topic, kind) => {
  const schema = schemaFor(topic);

  it('compiles with the platform validator under its own $id', () => {
    const validator = compileTopicSchema(schema);
    expect(validator.schemaId).toBe(schema.$id);
    expect(validator.meta.kind).toBe(kind);
  });

  it(`declares kind ${kind} through topicMeta, with no tenant fan-out or superseding effects`, () => {
    const meta = topicMeta(schema);
    expect(meta.kind).toBe(kind);
    expect(meta.fanout).toBeUndefined();
    expect(meta.supersedes).not.toBe(true);
  });

  it("is the contract identity's outbox runtime validates writes against", () => {
    expect(validatorFor(topic).meta.kind).toBe(topicMeta(schema).kind);
    expect(validatorFor(topic).schemaId).toBe(schema.$id);
  });
});

/** A group payload in the envelope its pool tenant publishes it under. */
function groupEnvelope(payload: object, groupId: string): EventEnvelope {
  return testEnvelope({ topic: GROUP_CHANGED_TOPIC, tenantId: TENANT_UMBRELLA.tenantId, aggregateId: groupId, aggregateVersion: 1, payload });
}

describe('identity.group.changed.v1 payloads groupChangedPayload builds', () => {
  const schema = schemaFor(GROUP_CHANGED_TOPIC);
  const pooled = { tenant_id: TENANT_UMBRELLA.tenantId, siteid: TENANT_UMBRELLA.siteId };
  const saved = groupRow({ ...pooled, userid: cfId('A', 821), groupname: 'Umbrella Editors', ispublic: 0 });

  it.each([
    { name: 'a saved private-pool group', row: saved, deleted: false, groupName: 'Umbrella Editors', isPublic: 0 },
    { name: 'a deleted public-pool group', row: groupRow({ ...pooled, groupname: 'Umbrella Members', ispublic: 1 }), deleted: true, groupName: 'Umbrella Members', isPublic: 1 },
    { name: 'a group whose name and isPublic are null', row: groupRow({ ...pooled, groupname: null, ispublic: null }), deleted: false, groupName: null, isPublic: null },
    { name: "a group whose isPublic arrives in the driver's text form", row: { ...groupRow(pooled), ispublic: '1' }, deleted: false, groupName: 'Test Group', isPublic: 1 },
  ])('$name passes the topic contract in the pool tenant', ({ row, deleted, groupName, isPublic }) => {
    const payload = groupChangedPayload(row, { deleted }, TENANT_UMBRELLA.tenantId);

    expect(payload).toStrictEqual({ groupId: row.userid, siteId: TENANT_UMBRELLA.siteId, groupName, type: 1, isPublic, poolTenantId: TENANT_UMBRELLA.tenantId, deleted });
    expect(assertEventMatches(undefined, schema, groupEnvelope(payload, payload.groupId)).payload).toStrictEqual(payload);
  });

  it('rejects the envelope once its tenantId is removed', () => {
    const payload = groupChangedPayload(saved, { deleted: false }, TENANT_UMBRELLA.tenantId);
    expect(() => assertEventMatches(undefined, schema, withoutTenant(groupEnvelope(payload, payload.groupId)))).toThrow(ContractAssertionError);
  });

  const built: GroupChangedPayload = groupChangedPayload(saved, { deleted: false }, TENANT_UMBRELLA.tenantId);
  const withoutGroupId = Object.fromEntries(Object.entries(built).filter(([key]) => key !== 'groupId'));

  it.each([
    ['an extra legacy-cased property', { ...built, GroupName: built.groupName }, 'must NOT have additional properties'],
    ['no groupId', withoutGroupId, "must have required property 'groupId'"],
  ])('the runtime validator rejects a payload with %s', (_case, payload, message) => {
    const result = validatorFor(GROUP_CHANGED_TOPIC).validatePayload(payload);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContainEqual(expect.stringContaining(message));
  });
});

describe('envelopes the routes write', () => {
  let t: IdentityTestApp;

  beforeAll(async () => {
    t = await buildIdentityApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    t.resetEffects();
  });

  /** Injects a request as `subject` and expects 200. */
  async function send(subject: string, method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: string | Record<string, unknown>): Promise<void> {
    const headers = { ...(await credentialsFor(subjectNamed(subject))), ...(typeof payload === 'string' ? FORM : {}) };
    const res = await t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  }

  it('a cUsers group create writes identity.group.changed.v1 in the pool tenant', async () => {
    await send('site-admin', 'POST', '/v1/groups', `userid=${NEW_GROUP}&groupname=Events&ispublic=0&siteid=${SITE_A}&${csrfFields('site-admin', NEW_GROUP)}`);

    const [envelope, ...rest] = writtenEnvelopes(t);
    expect(rest).toEqual([]);
    expect(envelope).toMatchObject({
      eventType: 'identity.group.changed',
      tenantId: TENANT_A.tenantId,
      aggregateType: 'group',
      aggregateId: NEW_GROUP,
      payload: { groupId: NEW_GROUP, siteId: SITE_A, groupName: 'Events', type: 1, isPublic: 0, poolTenantId: TENANT_A.tenantId, deleted: false },
    });
  });

  it('a cUsers group update writes the next group version', async () => {
    await send('site-admin', 'POST', '/v1/groups', `userid=${RENAMED_GROUP}&groupname=Events&ispublic=0&siteid=${SITE_A}&${csrfFields('site-admin', RENAMED_GROUP)}`);
    expect(writtenEnvelopes(t)).toEqual([expect.objectContaining({ aggregateId: RENAMED_GROUP, aggregateVersion: 1 })]);
    t.resetEffects();

    await send('s2', 'PUT', `/v1/groups/${RENAMED_GROUP}`, `groupname=Events%20Renamed&ispublic=0&siteid=${SITE_A}&${csrfFields('s2', RENAMED_GROUP)}`);

    expect(writtenEnvelopes(t)).toEqual([
      expect.objectContaining({ aggregateId: RENAMED_GROUP, aggregateVersion: 2, payload: expect.objectContaining({ groupName: 'Events Renamed' }) }),
    ]);
  });

  it('adding and removing a member write identity.membership.changed.v1 with the full group set', async () => {
    const member = SITE_ADMIN_A.account.userid;
    const { token, expires } = csrfFor(subjectSession('s2'), `${member}${EDITOR_GROUP}addtogroup`);
    await send('s2', 'POST', `/v1/groups/${EDITOR_GROUP}/members/${member}`, `${CSRF_FIELD_TOKEN}=${token}&${CSRF_FIELD_EXPIRES}=${expires}`);
    const added = writtenEnvelopes(t);
    t.resetEffects();
    await send('s2', 'DELETE', `/v1/groups/${EDITOR_GROUP}/members/${member}`);
    const removed = writtenEnvelopes(t);

    const membership = { eventType: 'identity.membership.changed', tenantId: TENANT_A.tenantId, aggregateType: 'user', aggregateId: member };
    expect(added).toEqual([expect.objectContaining({ ...membership, payload: { userId: member, siteId: SITE_A, groupIds: [ADMIN_GROUP, EDITOR_GROUP].sort() } })]);
    expect(removed).toEqual([expect.objectContaining({ ...membership, payload: { userId: member, siteId: SITE_A, groupIds: [ADMIN_GROUP] } })]);
  });

  it('a module grant save writes identity.permission.changed.v1 per changed group', async () => {
    await send('s2', 'PUT', `/v1/permissions/modules/${USERS_MODULE}`, `groupid=${EDITOR_GROUP}&moduleid=${USERS_MODULE}&${csrfFields('s2', USERS_MODULE)}`);

    expect(writtenEnvelopes(t)).toEqual([
      expect.objectContaining({
        eventType: 'identity.permission.changed',
        aggregateType: 'group',
        aggregateId: EDITOR_GROUP,
        payload: { groupId: EDITOR_GROUP, siteId: SITE_A, rows: [{ contentId: USERS_MODULE, siteId: SITE_A, type: 'module' }] },
      }),
    ]);
  });

  it('a forgot-password request writes identity.login-mail.requested.v1 for the matching account', async () => {
    await send('anonymous', 'POST', '/v1/login-mail', { email: EDITOR.contact.email ?? '', siteid: SITE_A });

    expect(writtenEnvelopes(t)).toEqual([
      expect.objectContaining({
        eventType: 'identity.login-mail.requested',
        aggregateType: 'user',
        aggregateId: EDITOR.account.userid,
        payload: expect.objectContaining({ userId: EDITOR.account.userid, to: EDITOR.contact.email, kind: expect.any(String) }),
      }),
    ]);
  });

  it('a JSON API group save writes identity.group.changed.v1', async () => {
    await send('s2', 'POST', `/_api/json/v1/${SITE_A}/group`, `type=1&groupname=Json%20Events&ispublic=0&siteid=${SITE_A}&${csrfFields('s2', 'new')}`);

    expect(writtenEnvelopes(t)).toEqual([
      expect.objectContaining({ eventType: 'identity.group.changed', payload: expect.objectContaining({ groupName: 'Json Events', deleted: false }) }),
    ]);
  });

  it('a roster create committed with a group holds identity.membership.changed.v1 until finish', async () => {
    const headers = await relayedCredentials('people', subjectSession('s2'), subjectNamed('s2').roles);
    const url = (action: string): string => `/internal/v1/accounts/${NEW_USER}/operations/${OPERATION_ID}:${action}`;
    const account = { UserName: 'events_roster_user', Password: 'Events12345', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 };
    for (const [action, payload] of [
      ['prepare', { kind: 'create', siteId: SITE_A, account, groupIds: [EDITOR_GROUP] }],
      ['commit', undefined],
    ] as const) {
      const res = await t.app.inject({ method: 'POST', url: url(action), headers, ...(payload === undefined ? {} : { payload }) });
      expect(res.statusCode, res.body).toBe(200);
    }

    const held = t.db.writes().filter((write) => write.verb === 'INSERT' && write.table === 'identity.outbox').map((write) => write.values[6] === OPERATION_ID && write.values[7]);
    expect(held).toEqual([true]);
    expect(writtenEnvelopes(t)).toEqual([
      expect.objectContaining({ eventType: 'identity.membership.changed', aggregateId: NEW_USER, payload: { userId: NEW_USER, siteId: SITE_A, groupIds: [EDITOR_GROUP] } }),
    ]);

    t.resetEffects();
    expect((await t.app.inject({ method: 'POST', url: url('finish'), headers })).statusCode).toBe(200);
    const released = t.db.writes().filter((write) => write.verb === 'UPDATE' && write.table === 'identity.outbox');
    expect(released.map((write) => [write.sql.includes('SET held = false'), write.values[0]])).toEqual([[true, OPERATION_ID]]);
  });
});

const OUTBOX = `identity.${OUTBOX_TABLE}`;
const INSERT_COLUMNS = /^INSERT INTO \S+ \(([^)]+)\)/;
const FLUSH_LOCK = new RegExp(`FROM "identity"\\.${OUTBOX_TABLE} o JOIN`);

/** Committed outbox rows as pg returns them, rebuilt from the recorded inserts and publish stamps. */
function storedOutboxRows(db: RecordingDb): QueryResultRow[] {
  const writes = db.writes().filter((write) => write.table === OUTBOX);
  const stamps = new Map<string, unknown>();
  for (const write of writes.filter((candidate) => candidate.verb === 'UPDATE' && candidate.sql.includes('SET published_at'))) {
    for (const eventId of write.values[1] as readonly string[]) stamps.set(eventId, write.values[0]);
  }
  return writes
    .filter((write) => write.verb === 'INSERT')
    .map((write, index) => {
      const columns = (INSERT_COLUMNS.exec(write.sql)?.[1] ?? '').split(',').map((column) => column.trim());
      const row: QueryResultRow = Object.fromEntries(columns.map((column, i) => [column, write.values[i]]));
      return { ...row, seq: String(index + 1), envelope: JSON.parse(String(row.envelope)), published_at: stamps.get(String(row.event_id)) ?? null };
    });
}

/** The committed outbox rows, decoded as the flush, sweep and CLI read them. */
function outboxRows(db: RecordingDb): OutboxRow[] {
  return storedOutboxRows(db).map(rowFromDb);
}

/** Answers the in-request flush's row lock with the committed, unheld, unpublished rows it names, as PostgreSQL would. */
function answerFlushLock(db: RecordingDb): void {
  db.respond(FLUSH_LOCK, (_sql, values) => {
    const named = new Set(values[0] as readonly string[]);
    return storedOutboxRows(db).filter((row) => named.has(String(row.event_id)) && row.held === false && row.published_at === null);
  });
}

/** The only item of `items`; fails the test unless there is exactly one. */
function single<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

/** One identity event writer call and the outbox row it must leave in tenant-a. */
interface WriterCase {
  name: string;
  topic: IdentityTopic;
  aggregateType: 'group' | 'user';
  aggregateId: string;
  payload: unknown;
  write(events: IdentityEvents, tx: TenantTx): Promise<EventEnvelope | null>;
}

const WRITER_GROUP = groupRow({ userid: cfId('A', 811), groupname: 'Contract Group', ispublic: 1 });
const HOME_NODE = '00000000000000000000000000000000001';
const CONTENT_NODE = cfId('B', 811);
const MAIL: LoginMailRequestedPayload = {
  messageId: cfId('C', 811),
  userId: EDITOR.account.userid,
  returnId: cfId('D', 811),
  siteId: SITE_A,
  to: 'qa_editor@tenant-a.opt2.test',
  from: 'Tenant A',
  subject: 'Tenant A Account Information',
  text: 'Dear QA Editor,\n',
  bcc: '',
  kind: 'forgot-password',
};
const SEND_LOGIN_MAIL: LoginMailRequestedPayload = { ...MAIL, messageId: cfId('C', 812), returnId: cfId('D', 812), siteId: '', kind: 'send-login' };
const permission = (contentid: string, type: PermissionType) => permissionRow({ groupid: EDITOR_GROUP, siteid: SITE_A, contentid, type });

const WRITER_CASES: WriterCase[] = [
  ...[false, true].map((deleted): WriterCase => ({
    name: `publishGroupChanged of a ${deleted ? 'deleted' : 'saved'} group`,
    topic: GROUP_CHANGED_TOPIC,
    aggregateType: 'group',
    aggregateId: WRITER_GROUP.userid,
    payload: { groupId: WRITER_GROUP.userid, siteId: SITE_A, groupName: 'Contract Group', type: 1, isPublic: 1, poolTenantId: TENANT_A.tenantId, deleted },
    write: (events, tx) => events.publishGroupChanged(tx, WRITER_GROUP, { deleted }),
  })),
  {
    name: 'publishMembershipChanged of a user in no group',
    topic: MEMBERSHIP_CHANGED_TOPIC,
    aggregateType: 'user',
    aggregateId: EDITOR.account.userid,
    payload: { userId: EDITOR.account.userid, siteId: SITE_A, groupIds: [] },
    write: (events, tx) => events.publishMembershipChanged(tx, { userId: EDITOR.account.userid, siteId: SITE_A, groupIds: [] }),
  },
  {
    name: 'publishMembershipChanged of a user in two groups, given unsorted with a duplicate',
    topic: MEMBERSHIP_CHANGED_TOPIC,
    aggregateType: 'user',
    aggregateId: EDITOR.account.userid,
    payload: { userId: EDITOR.account.userid, siteId: SITE_A, groupIds: [ADMIN_GROUP, EDITOR_GROUP].sort() },
    write: (events, tx) =>
      events.publishMembershipChanged(tx, { userId: EDITOR.account.userid, siteId: SITE_A, groupIds: [EDITOR_GROUP, ADMIN_GROUP, EDITOR_GROUP] }),
  },
  {
    name: 'publishPermissionChanged of node verdicts and a module grant',
    topic: PERMISSION_CHANGED_TOPIC,
    aggregateType: 'group',
    aggregateId: EDITOR_GROUP,
    payload: {
      groupId: EDITOR_GROUP,
      siteId: SITE_A,
      rows: [
        { contentId: HOME_NODE, siteId: SITE_A, type: 'Editor' },
        { contentId: USERS_MODULE, siteId: SITE_A, type: 'module' },
        { contentId: CONTENT_NODE, siteId: SITE_A, type: 'Author' },
        { contentId: CONTENT_NODE, siteId: SITE_A, type: 'Deny' },
        { contentId: CONTENT_NODE, siteId: SITE_A, type: 'Read' },
      ],
    },
    write: (events, tx) =>
      events.publishPermissionChanged(tx, {
        groupId: EDITOR_GROUP,
        siteId: SITE_A,
        rows: [
          permission(CONTENT_NODE, 'Read'),
          permission(USERS_MODULE, 'module'),
          permission(CONTENT_NODE, 'Deny'),
          permission(HOME_NODE, 'Editor'),
          permission(CONTENT_NODE, 'Author'),
        ],
      }),
  },
  {
    name: 'publishPermissionChanged of a group with no rows left',
    topic: PERMISSION_CHANGED_TOPIC,
    aggregateType: 'group',
    aggregateId: EDITOR_GROUP,
    payload: { groupId: EDITOR_GROUP, siteId: SITE_A, rows: [] },
    write: (events, tx) => events.publishPermissionChanged(tx, { groupId: EDITOR_GROUP, siteId: SITE_A, rows: [] }),
  },
  ...[MAIL, SEND_LOGIN_MAIL].map((mail): WriterCase => ({
    name: `publishLoginMailRequested of a ${mail.kind} mail${mail.siteId === '' ? ' under the global configuration' : ''}`,
    topic: LOGIN_MAIL_REQUESTED_TOPIC,
    aggregateType: 'user',
    aggregateId: mail.userId,
    payload: mail,
    write: (events, tx) => events.publishLoginMailRequested(tx, mail),
  })),
];

describe('outbox rows the identity event writers leave', () => {
  let t: TestApp;
  let events: IdentityEvents;

  beforeAll(async () => {
    t = await buildTestApp();
    await t.app.ready();
    events = createIdentityEvents(t.repo);
  });

  afterAll(async () => {
    await t?.app.close();
  });

  beforeEach(() => {
    t.db.clear();
    t.publisher.clear();
    answerFlushLock(t.db);
  });

  it.each(WRITER_CASES)('$name writes one contract-valid row that the in-request flush publishes', async ({ topic, aggregateType, aggregateId, payload, write }) => {
    const returned = await t.db.withTenant(TENANT_A.tenantId, (tx) => write(events, tx));
    const row = single(outboxRows(t.db));
    const schema = schemaFor(topic);
    const envelope = assertEventMatches(undefined, schema, row.envelope);

    expect(envelope).toEqual(returned);
    expect(envelope).toMatchObject({
      eventType: eventTypeOf(topic),
      schemaVersion: schemaVersionOf(topic),
      tenantId: TENANT_A.tenantId,
      producer: 'identity',
      aggregateType,
      aggregateId,
      payload,
    });
    expect(envelope.schemaVersion).toBe('1.0.0');
    expect(envelope.payload).toStrictEqual(payload);
    expect(row).toMatchObject({ tenantId: TENANT_A.tenantId, eventId: envelope.eventId, topic, kind: topicMeta(schema).kind, orderingKey: aggregateId, held: false, operationId: null });
    expect(row.publishedAt).not.toBeNull();
    expect(t.publisher.published.map((sent) => [sent.topic, sent.envelope.eventId])).toEqual([[row.topic, row.eventId]]);
  });

  it('holds a membership row written under an open operation, unpublished', async () => {
    const operationId = cfId('F', 811);
    const returned = await t.db.withTenant(TENANT_A.tenantId, (tx) =>
      events.publishMembershipChanged(tx, { userId: EDITOR.account.userid, siteId: SITE_A, groupIds: [EDITOR_GROUP] }, { operationId }),
    );
    const row = single(outboxRows(t.db));

    expect(assertEventMatches(undefined, schemaFor(MEMBERSHIP_CHANGED_TOPIC), row.envelope)).toEqual(returned);
    expect(row).toMatchObject({ topic: MEMBERSHIP_CHANGED_TOPIC, kind: 'state', held: true, operationId, publishedAt: null });
    expect(t.publisher.published).toEqual([]);
  });

  it('emitStateEvents of applied group, membership, permission and credential rows writes only the three state topics', async () => {
    type AppliedChange = Parameters<IdentityEvents['emitStateEvents']>[1];
    const applied = (definition: { unit: string; table: string }, after: AppliedChange['after']): AppliedChange => ({
      unit: definition.unit,
      table: definition.table,
      op: 'insert',
      after,
      origin: 'backfill',
      tenantId: TENANT_A.tenantId,
    });
    const group = groupRow({ userid: cfId('A', 812), groupname: 'Applied Group' });
    const changes = [
      applied(GROUP_ACCOUNT, group),
      applied(MEMBERSHIP, membershipRow({ userid: SITE_ADMIN_A.account.userid, groupid: ADMIN_GROUP })),
      applied(PERMISSION, permissionRow({ groupid: group.userid, siteid: SITE_A })),
      applied(CREDENTIAL, SITE_ADMIN_A.credential),
    ];

    await t.db.withTenant(TENANT_A.tenantId, async (tx) => {
      for (const change of changes) await events.emitStateEvents(tx, change, { origin: 'backfill' });
    });
    const rows = outboxRows(t.db);

    expect(rows.map((row) => row.topic).sort()).toEqual([GROUP_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC, PERMISSION_CHANGED_TOPIC].sort());
    for (const row of rows) {
      const schema = schemaFor(row.topic);
      expect(assertEventMatches(undefined, schema, row.envelope).tenantId).toBe(TENANT_A.tenantId);
      expect(row.kind).toBe(topicMeta(schema).kind);
    }
  });
});

/** Every field the platform registry consumer reads from `programs-sites.site.changed.v1`, with the JSON type it relies on. */
const REGISTRY_FIELD_TYPES = {
  siteId: 'string',
  publicUserPoolId: 'string',
  privateUserPoolId: 'string',
  categoryPoolId: 'string',
  filePoolId: 'string',
  displayPoolId: 'string',
  contentPoolIds: 'array',
  domains: 'array',
} as const satisfies Record<keyof SiteChangedPayload, JsonType>;

/** The person fields `personContactConsumer` reads, with the JSON type of those the producer declares by `type`. */
const PERSON_FIELD_TYPES = { userId: 'string', siteId: 'string', deleted: 'boolean' } as const satisfies Partial<Record<keyof PersonChangedPayload, JsonType>>;

/** The nullable person fields the consumer stores; the producer declares them by `anyOf`, so samples hold both forms. */
const PERSON_NULLABLE_FIELDS = ['email', 'fname', 'lname', 'company', 'subType'] as const satisfies ReadonlyArray<keyof PersonChangedPayload>;

/** A person state the producer's schema admits, with the nullable fields identity stores left null. */
function personPayload(overrides: Partial<PersonChangedPayload> = {}): PersonChangedPayload {
  const nullable = Object.fromEntries(((PERSON_PRODUCER.required ?? []) as string[]).map((field) => [field, null]));
  return {
    ...(nullable as unknown as PersonChangedPayload),
    userId: EDITOR.account.userid,
    siteId: SITE_A,
    deleted: false,
    email: 'events.contact@tenant-a.opt2.test',
    fname: 'Events',
    lname: null,
    company: null,
    subType: null,
    subscribe: 0,
    keepPrivate: 0,
    ...overrides,
  };
}

describe('consumed producer contracts', () => {
  it('programs-sites.site.changed.v1 supplies every registry field identity reads, as state without fan-out', () => {
    const expectation: ConsumerExpectation = {
      required: Object.keys(REGISTRY_FIELD_TYPES),
      types: REGISTRY_FIELD_TYPES,
      itemTypes: { contentPoolIds: 'string', domains: 'string' },
      samples: registryPayloads(),
      kind: 'state',
    };
    expect(() => assertProducerConsumerCompatible(SITE_PRODUCER, expectation)).not.toThrow();
    expect(SITE_PRODUCER).not.toHaveProperty(['x-opt2-tenant-fanout']);
  });

  it('people.person.changed.v1 supplies every field the person-contact consumer reads, as state', () => {
    const expectation: ConsumerExpectation = {
      required: [...Object.keys(PERSON_FIELD_TYPES), ...PERSON_NULLABLE_FIELDS],
      types: PERSON_FIELD_TYPES,
      samples: [
        personPayload(),
        personPayload({ deleted: true, email: null, fname: null, lname: 'Contact', company: 'Events Co', subType: 'Default' }),
      ],
      kind: 'state',
    };
    expect(() => assertProducerConsumerCompatible(PERSON_PRODUCER, expectation)).not.toThrow();
  });

  it("the person-contact consumer validates against the producer's own file and subscribes under identity's name", () => {
    expect(personChangedSchema).toStrictEqual(PERSON_PRODUCER);
    expect(PERSON_CONTACT_SUBSCRIPTION).toBe(subscriptionName('identity', PERSON_CHANGED_TOPIC));
    expect(PERSON_CONTACT_SUBSCRIPTION).toBe('identity.people.person.changed.v1');
  });

  it('the person-contact consumer applies a producer-valid state with null names into the envelope tenant, then removes it on delete', async () => {
    const t = await buildIdentityApp();
    try {
      const consumer = personContactConsumer(t.repo);
      const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
      const deliver = async (payload: PersonChangedPayload, version: number): Promise<void> => {
        const envelope = testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateType: 'person', aggregateId: payload.userId, aggregateVersion: version, payload });
        assertEventMatches(undefined, PERSON_PRODUCER, envelope);
        const outcome = await consumeEnvelope(t.db, consumer, envelope, { subscription: PERSON_CONTACT_SUBSCRIPTION, messageId: `m-${version}`, logger });
        expect(outcome.destinations).toEqual([{ tenantId: TENANT_A.tenantId, result: 'applied' }]);
      };
      const contact = (): unknown => t.repo.rows('person_contact', TENANT_A.tenantId).find((row) => row.user_id === EDITOR.account.userid);

      await deliver(personPayload(), 2);
      expect(contact()).toMatchObject({ email: 'events.contact@tenant-a.opt2.test', fname: 'Events', lname: null, company: null, subtype: null });
      await deliver(personPayload({ deleted: true }), 3);
      expect(contact()).toBeUndefined();
      expect(t.repo.rows('person_contact', tenantIdForSite(TENANT_UMBRELLA.siteId)).every((row) => row.user_id !== EDITOR.account.userid)).toBe(true);
    } finally {
      await t.close();
    }
  });
});
