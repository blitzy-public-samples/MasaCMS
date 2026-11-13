/** Event contracts of identity: its topic schemas, the envelopes its routes write to the outbox, and its consumers against the producers' schemas. */
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { consumeEnvelope, subscriptionName, type EventEnvelope } from '@opt2/platform/events';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { tenantIdForSite, type SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertProducerConsumerCompatible,
  registryPayloads,
  testEnvelope,
  type ConsumerExpectation,
  type JsonType,
} from '@opt2/platform/testing';
import { IDENTITY_TOPICS } from '../../src/events/publish.js';
import { PERSON_CHANGED_TOPIC, PERSON_CONTACT_SUBSCRIPTION, personChangedSchema, personContactConsumer, type PersonChangedPayload } from '../../src/events/person-contact.js';
import { EDITOR, SITE_ADMIN_A } from '../helpers/rows.js';
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
const SCHEMAS: Readonly<Record<string, Schema>> = Object.fromEntries(
  readdirSync(EVENTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [file.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(file, EVENTS_DIR), 'utf8')) as Schema]),
);
const PERSON_PRODUCER = JSON.parse(
  readFileSync(new URL('../../../people/contracts/events/people.person.changed.v1.json', import.meta.url), 'utf8'),
) as Schema;
const SITE_PRODUCER = JSON.parse(
  readFileSync(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as Schema;

/** The `x-opt2-kind` each identity topic is published under. */
const TOPIC_KINDS: Readonly<Record<string, 'state' | 'process'>> = {
  'identity.group.changed.v1': 'state',
  'identity.membership.changed.v1': 'state',
  'identity.permission.changed.v1': 'state',
  'identity.login-mail.requested.v1': 'process',
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const USERS_MODULE = '00000000000000000000000000000000008';
const EDITOR_GROUP = EDITOR.groups[0]?.userid ?? '';
const ADMIN_GROUP = SITE_ADMIN_A.groups[0]?.userid ?? '';
const NEW_GROUP = cfId('A', 801);
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
    const topic = `${envelope.eventType}.v${envelope.schemaVersion.split('.')[0] ?? ''}`;
    const schema = SCHEMAS[topic];
    if (schema === undefined) throw new Error(`No contract for ${topic}`);
    assertEventMatches(undefined, schema, envelope);
    expect(kinds.get(envelope.eventId)).toBe(schema['x-opt2-kind']);
    expect(envelope.producer).toBe('identity');
    return envelope;
  });
}

describe('topic schemas', () => {
  it('are exactly the topics identity publishes', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual([...IDENTITY_TOPICS].sort());
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
    await send('s2', 'PUT', `/v1/groups/${NEW_GROUP}`, `groupname=Events%20Renamed&ispublic=0&siteid=${SITE_A}&${csrfFields('s2', NEW_GROUP)}`);

    expect(writtenEnvelopes(t)).toEqual([
      expect.objectContaining({ aggregateId: NEW_GROUP, aggregateVersion: 2, payload: expect.objectContaining({ groupName: 'Events Renamed' }) }),
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
