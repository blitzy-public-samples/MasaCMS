/** Envelopes people's routes publish over PostgreSQL, held to the event contract files and their Pub/Sub wire form. */
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@opt2/platform/events';
import { TENANT_A, TENANT_UMBRELLA, assertEventMatches, type PublishedEvent } from '@opt2/platform/testing';
import { PERSON_ARCHIVED_TOPIC, PERSON_CHANGED_TOPIC, type PeopleTopic } from '../../src/events/topics.js';
import { userHeaders } from '../helpers/app.js';
import { SCHEMAS, expectWireForm } from '../helpers/event-contract.js';
import { PG_AVAILABLE, withPgApp, type PgTestApp } from '../helpers/pg-app.js';
import {
  ARCHIVE_EFFECTIVE_FROM,
  ARCHIVE_PERSON,
  DEFAULT_PEOPLE_SEED,
  MODULE_008_ONLY_PERSON,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  SYSTEM_USER_A_PERSON,
  accountsForSeed,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const ARCHIVE_URL = `/legacy-fixtures/cfml/api.cfm/people/persons/${ARCHIVE_PERSON.userid}/archive`;
/** Expiry of every posted CSRF pair: an hour after business noon, `yyMMddHHnnsslll`. */
const CSRF_EXPIRES = '260630130000000';
const ROSTER_TARGET = MODULE_008_ONLY_PERSON;

let csrfSequence = 0;

/** A fresh CSRF pair; the identity double consumes each token once. */
function csrfFields(): Record<string, string> {
  csrfSequence += 1;
  return { csrf_token: `CONTRACT-TOKEN-${String(csrfSequence)}`, csrf_token_expires: CSRF_EXPIRES };
}

/** The people app over the fixed people seed, with identity holding each seeded person's account. */
async function seeded(ctx: PgTestApp): Promise<PgTestApp> {
  await seedPeople(ctx.db, DEFAULT_PEOPLE_SEED);
  ctx.identity.seedAccounts(...accountsForSeed(DEFAULT_PEOPLE_SEED));
  return ctx;
}

/** Posts `fields` as `actor` and returns what the outbox published while the request ran; the request must answer 200. */
async function publishedBy(ctx: PgTestApp, actor: TestActor, url: string, fields: Record<string, string>): Promise<PublishedEvent[]> {
  ctx.publisher.clear();
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    headers: { ...(await userHeaders(actor)), ...FORM },
    payload: new URLSearchParams({ ...fields, ...csrfFields() }).toString(),
  });
  expect(res.statusCode, res.body.slice(0, 500)).toBe(200);
  return [...ctx.publisher.published];
}

/** The roster edit of `ROSTER_TARGET` renaming them to `lname`, as the Edit User form posts it. */
function rosterEdit(lname: string): Record<string, string> {
  return {
    userid: ROSTER_TARGET.userid,
    siteid: TENANT_A.siteId,
    type: '2',
    action: 'Update',
    fname: ROSTER_TARGET.fname ?? '',
    lname,
    email: ROSTER_TARGET.email ?? '',
    username: (ROSTER_TARGET.email ?? '').split('@')[0] ?? '',
    ispublic: '0',
  };
}

/** Asserts the single envelope of `topic` a request published for `userId` in `tenantId`, and returns it. */
async function onlyPersonEnvelope(published: readonly PublishedEvent[], topic: PeopleTopic, tenantId: string, userId: string): Promise<EventEnvelope> {
  expect(published.map((event) => event.topic)).toEqual([topic]);
  const [{ envelope }] = published as [PublishedEvent];
  expect(assertEventMatches(undefined, SCHEMAS[topic], envelope)).toBe(envelope);
  expect(envelope).toMatchObject({ producer: 'people', aggregateType: 'person', aggregateId: userId, tenantId });
  await expectWireForm(topic, envelope);
  return envelope;
}

// Gated on PG_AVAILABLE, resolved at import: platform pgAvailable() is async and rejects when PG_HOST is set and another PG_* variable is unset.
describe.skipIf(!PG_AVAILABLE)('published envelopes', () => {
  it('consecutive roster saves of one person publish people.person.changed.v1 at consecutive versions', async () => {
    await withPgApp(async (app) => {
      const ctx = await seeded(app);
      const first = await onlyPersonEnvelope(
        await publishedBy(ctx, SITE_ADMIN_A, '/v1/users:update', rosterEdit('Saved')),
        PERSON_CHANGED_TOPIC,
        TENANT_A.tenantId,
        ROSTER_TARGET.userid,
      );
      const second = await onlyPersonEnvelope(
        await publishedBy(ctx, SITE_ADMIN_A, '/v1/users:update', rosterEdit('Saved Again')),
        PERSON_CHANGED_TOPIC,
        TENANT_A.tenantId,
        ROSTER_TARGET.userid,
      );

      expect(first.payload).toMatchObject({ userId: ROSTER_TARGET.userid, siteId: TENANT_A.siteId, lname: 'Saved', deleted: false });
      expect(second.payload).toMatchObject({ lname: 'Saved Again', deleted: false });
      expect(second.aggregateVersion).toBe(first.aggregateVersion + 1);
    });
  });

  it("a profile update publishes the session user's people.person.changed.v1", async () => {
    await withPgApp(async (app) => {
      const ctx = await seeded(app);
      const fields = {
        siteid: TENANT_A.siteId,
        fname: SYSTEM_USER_A_PERSON.fname ?? '',
        lname: 'Profiled',
        email: SYSTEM_USER_A_PERSON.email ?? '',
        jobtitle: 'Lead Analyst',
      };
      const envelope = await onlyPersonEnvelope(
        await publishedBy(ctx, SYSTEM_USER_A, '/v1/profile:update', fields),
        PERSON_CHANGED_TOPIC,
        TENANT_A.tenantId,
        SYSTEM_USER_A_PERSON.userid,
      );

      expect(envelope.payload).toMatchObject({ userId: SYSTEM_USER_A_PERSON.userid, lname: 'Profiled', jobTitle: 'Lead Analyst', deleted: false });
    });
  });

  it('archiving a pooled person publishes one people.person.archived.v1 in the umbrella tenant and no person change', async () => {
    await withPgApp(async (app) => {
      const ctx = await seeded(app);
      const envelope = await onlyPersonEnvelope(
        await publishedBy(ctx, SITE_ADMIN_A, ARCHIVE_URL, { effectiveFrom: ARCHIVE_EFFECTIVE_FROM }),
        PERSON_ARCHIVED_TOPIC,
        TENANT_UMBRELLA.tenantId,
        ARCHIVE_PERSON.userid,
      );

      expect(envelope.payload).toMatchObject({
        personId: ARCHIVE_PERSON.userid,
        siteId: TENANT_UMBRELLA.siteId,
        effectiveFrom: `${ARCHIVE_EFFECTIVE_FROM} 00:00:00.000`,
      });
    });
  });
});
