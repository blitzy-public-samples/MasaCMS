// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Tenant re-check of the login-mail and survey-scheduled consumers through the platform consumer and the push route, against a throwaway schema. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { consumeEnvelope, type ConsumerDefinition, type DeadLetterReason, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import {
  SITE_CHANGED_TOPIC,
  tenantIdForSite,
  tenantRegistryConsumer,
  withMetadata,
  withTenant,
  type TenantDb,
} from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  pgAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { MailDeps } from '../../src/domain/delivery.js';
import type { SurveyScheduleDeps } from '../../src/domain/survey-schedule.js';
import { LOGIN_MAIL_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION, SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { LOGIN_MAIL_TOPIC, loginMailConsumer, type LoginMailRequestedPayload } from '../../src/events/login-mail.js';
import { SURVEY_SCHEDULED_TOPIC, surveyScheduledConsumer, type SurveyScheduledPayload } from '../../src/events/survey-scheduled.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { SAMPLE_IDS, envelopeFor, loginMailPayload, surveyScheduledPayload } from '../helpers/payloads.js';

type Expected = 'applied' | DeadLetterReason;

const UNREGISTERED_TENANT = tenantIdForSite('no-such-site');
const DEFAULT_TENANT = tenantIdForSite('default');
const OTHER_USER_ID = 'E5F6A7B8-0005-4000-8000000000000005';
const OTHER_SURVEY_ID = 'F6A7B8C9-0006-4000-8000000000000006';

interface BindingCase {
  label: string;
  tenantId: string;
  siteId: string;
  /** The login mail's kind; forgot-password when absent. */
  kind?: LoginMailRequestedPayload['kind'];
  /** Replaces the producer's aggregate type. */
  aggregateType?: string;
  /** Replaces the payload's user or survey id as the envelope aggregate. */
  aggregateId?: string;
  expected: Expected;
}

type EnvelopeCase = Omit<BindingCase, 'label' | 'expected'>;

const LOGIN_MAIL_CASES: BindingCase[] = [
  { label: 'the public pool umbrella for site tenant-a', tenantId: TENANT_UMBRELLA.tenantId, siteId: 'tenant-a', expected: 'applied' },
  { label: 'the private pool tenant-a for site tenant-a', tenantId: TENANT_A.tenantId, siteId: 'tenant-a', expected: 'applied' },
  { label: 'the private pool tenant-a for site TENANT-A', tenantId: TENANT_A.tenantId, siteId: 'TENANT-A', expected: 'applied' },
  { label: 'self-pooled tenant-b for its own site', tenantId: TENANT_B.tenantId, siteId: 'tenant-b', expected: 'applied' },
  { label: 'tenant-a for the global configuration', tenantId: TENANT_A.tenantId, siteId: '', expected: 'applied' },
  { label: 'tenant-b for the global configuration', tenantId: TENANT_B.tenantId, siteId: '', expected: 'applied' },
  { label: 'umbrella for the global configuration', tenantId: TENANT_UMBRELLA.tenantId, siteId: '', expected: 'applied' },
  { label: 'tenant-b for site tenant-a', tenantId: TENANT_B.tenantId, siteId: 'tenant-a', expected: 'tenant-mismatch' },
  { label: 'tenant-a for site tenant-b', tenantId: TENANT_A.tenantId, siteId: 'tenant-b', expected: 'tenant-mismatch' },
  { label: 'umbrella for site tenant-b', tenantId: TENANT_UMBRELLA.tenantId, siteId: 'tenant-b', expected: 'tenant-mismatch' },
  { label: 'tenant-a for site umbrella', tenantId: TENANT_A.tenantId, siteId: 'umbrella', expected: 'tenant-mismatch' },
  { label: 'tenant-a for an unregistered site with no default site', tenantId: TENANT_A.tenantId, siteId: 'no-such-site', expected: 'tenant-mismatch' },
  { label: "another user's aggregate", tenantId: TENANT_A.tenantId, siteId: 'tenant-a', aggregateId: OTHER_USER_ID, expected: 'tenant-mismatch' },
  { label: 'the user id in another casing', tenantId: TENANT_A.tenantId, siteId: 'tenant-a', aggregateId: SAMPLE_IDS.userId.toLowerCase(), expected: 'tenant-mismatch' },
  { label: 'an aggregate type other than user', tenantId: TENANT_A.tenantId, siteId: 'tenant-a', aggregateType: 'person', expected: 'tenant-mismatch' },
  { label: 'an unregistered envelope tenant for site tenant-a', tenantId: UNREGISTERED_TENANT, siteId: 'tenant-a', expected: 'invalid-tenant' },
  { label: 'an unregistered envelope tenant for the global configuration', tenantId: UNREGISTERED_TENANT, siteId: '', expected: 'invalid-tenant' },
];

// As identity's sendLoginByUser publishes them: the tenant of the user's own site, and the caller's settings site.
const SEND_LOGIN_CASES: BindingCase[] = [
  { label: "a tenant-a user's send-login for site tenant-a", kind: 'send-login', tenantId: TENANT_A.tenantId, siteId: 'tenant-a', expected: 'applied' },
  { label: "a tenant-a user's send-login for an unknown site with no default site", kind: 'send-login', tenantId: TENANT_A.tenantId, siteId: 'nowhere', expected: 'applied' },
  { label: "a tenant-a user's send-login for site tenant-b", kind: 'send-login', tenantId: TENANT_A.tenantId, siteId: 'tenant-b', expected: 'applied' },
  { label: "a tenant-a user's send-login for the global configuration", kind: 'send-login', tenantId: TENANT_A.tenantId, siteId: '', expected: 'applied' },
  { label: "a pooled umbrella member's send-login for site tenant-b", kind: 'send-login', tenantId: TENANT_UMBRELLA.tenantId, siteId: 'tenant-b', expected: 'applied' },
  { label: "a send-login for another user's aggregate", kind: 'send-login', tenantId: TENANT_A.tenantId, siteId: 'tenant-b', aggregateId: OTHER_USER_ID, expected: 'tenant-mismatch' },
  { label: 'a send-login under an aggregate type other than user', kind: 'send-login', tenantId: TENANT_A.tenantId, siteId: 'tenant-b', aggregateType: 'person', expected: 'tenant-mismatch' },
  { label: "an unregistered site's user's send-login for site tenant-a", kind: 'send-login', tenantId: UNREGISTERED_TENANT, siteId: 'tenant-a', expected: 'invalid-tenant' },
];

const DEFAULT_SITE_CASES: BindingCase[] = [
  { label: 'the default tenant for an unregistered site', tenantId: DEFAULT_TENANT, siteId: 'no-such-site', expected: 'applied' },
  { label: 'tenant-a for an unregistered site', tenantId: TENANT_A.tenantId, siteId: 'no-such-site', expected: 'tenant-mismatch' },
  { label: 'the default tenant for registered site tenant-a', tenantId: DEFAULT_TENANT, siteId: 'tenant-a', expected: 'tenant-mismatch' },
  { label: "a tenant-a user's send-login for an unknown site", kind: 'send-login', tenantId: TENANT_A.tenantId, siteId: 'nowhere', expected: 'applied' },
  { label: "a default-site user's send-login for site tenant-a", kind: 'send-login', tenantId: DEFAULT_TENANT, siteId: 'tenant-a', expected: 'applied' },
];

const SURVEY_CASES: BindingCase[] = [
  { label: 'tenant-a for its site tenant-a', tenantId: TENANT_A.tenantId, siteId: 'tenant-a', expected: 'applied' },
  { label: 'tenant-a for its site in another casing', tenantId: TENANT_A.tenantId, siteId: 'TENANT-A', expected: 'applied' },
  { label: 'tenant-a for its site with trailing spaces', tenantId: TENANT_A.tenantId, siteId: 'tenant-a  ', expected: 'applied' },
  { label: 'tenant-b for its site tenant-b', tenantId: TENANT_B.tenantId, siteId: 'tenant-b', expected: 'applied' },
  { label: 'tenant-a for site tenant-b', tenantId: TENANT_A.tenantId, siteId: 'tenant-b', expected: 'tenant-mismatch' },
  { label: 'tenant-b for site tenant-a', tenantId: TENANT_B.tenantId, siteId: 'tenant-a', expected: 'tenant-mismatch' },
  { label: 'the pool tenant umbrella for site tenant-a', tenantId: TENANT_UMBRELLA.tenantId, siteId: 'tenant-a', expected: 'tenant-mismatch' },
  { label: 'tenant-a for its site with a leading space', tenantId: TENANT_A.tenantId, siteId: ' tenant-a', expected: 'tenant-mismatch' },
  { label: "another survey's aggregate", tenantId: TENANT_A.tenantId, siteId: 'tenant-a', aggregateId: OTHER_SURVEY_ID, expected: 'tenant-mismatch' },
  { label: 'an aggregate type other than survey-schedule', tenantId: TENANT_A.tenantId, siteId: 'tenant-a', aggregateType: 'survey', expected: 'tenant-mismatch' },
  { label: 'an unregistered envelope tenant', tenantId: UNREGISTERED_TENANT, siteId: 'tenant-a', expected: 'invalid-tenant' },
];

let fixtureIds = 0;

/** The next upper-case CF UUID of a fixed sequence, giving every case its own message or survey. */
function cfId(): string {
  fixtureIds += 1;
  return `C0000000-0000-0000-${String(fixtureIds).padStart(16, '0')}`;
}

function loginMailEnvelope({ tenantId, siteId, kind = 'forgot-password', aggregateType, aggregateId }: EnvelopeCase): EventEnvelope<LoginMailRequestedPayload> {
  return envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId: cfId(), siteId, kind }), { tenantId, aggregateType, aggregateId });
}

function surveyEnvelope({ tenantId, siteId, aggregateType, aggregateId }: EnvelopeCase): EventEnvelope<SurveyScheduledPayload> {
  return envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(1, { surveyId: cfId(), siteId }), { tenantId, aggregateType, aggregateId });
}

const available = await pgAvailable();

describe.skipIf(!available)('communications consumer tenant binding against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let applied: Array<{ tenantId: string; eventId: string }>;
  const logger = createLogger({ service: 'communications', version: '1.0.0', env: 'local', destination: { write: () => undefined } });

  /** The real definition, its `checkTenant` included, with `apply` replaced by a recorder of each applied event. */
  function recorded<P>(def: ConsumerDefinition<P>): ConsumerDefinition<P> {
    return {
      ...def,
      apply: (tx, envelope) => {
        applied.push({ tenantId: tx.tenantId, eventId: envelope.eventId });
      },
    };
  }

  const loginMail = recorded(loginMailConsumer({} as MailDeps));
  const surveyScheduled = recorded(surveyScheduledConsumer({} as SurveyScheduleDeps));

  async function hasReceipt(tenantId: string, eventId: string): Promise<boolean> {
    return withTenant(handle.app, tenantId, async (tx) => {
      const { rowCount } = await tx.query(`SELECT 1 FROM ${handle.schema}.inbox WHERE event_id = $1`, [eventId]);
      return rowCount === 1;
    });
  }

  /** Consumes `envelope` once and checks the outcome, the recorded effect and the envelope tenant's inbox receipt. */
  async function expectBinding<P>(def: ConsumerDefinition<P>, subscription: string, envelope: EventEnvelope<P>, expected: Expected): Promise<void> {
    const { tenantId, eventId } = envelope;
    const outcome = consumeEnvelope(handle.app, def, envelope, { subscription, messageId: randomUUID(), logger });
    if (expected === 'applied') {
      await expect(outcome).resolves.toEqual({ eventId, destinations: [{ tenantId, result: 'applied' }] });
      expect(applied).toEqual([{ tenantId, eventId }]);
    } else {
      await expect(outcome).rejects.toMatchObject({ name: 'DeadLetterError', reason: expected });
      expect(applied).toEqual([]);
    }
    expect(await hasReceipt(tenantId, eventId)).toBe(expected === 'applied');
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await seedRegistry(handle.app);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    applied = [];
  });

  it.each([...LOGIN_MAIL_CASES, ...SEND_LOGIN_CASES])('login mail from $label: $expected', async (bindingCase) => {
    await expectBinding(loginMail, LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope(bindingCase), bindingCase.expected);
  });

  it.each(SURVEY_CASES)('survey schedule from $label: $expected', async (bindingCase) => {
    await expectBinding(surveyScheduled, SURVEY_SCHEDULED_SUBSCRIPTION, surveyEnvelope(bindingCase), bindingCase.expected);
  });

  describe('with a self-pooled default site registered', () => {
    beforeAll(async () => {
      const site = testEnvelope({
        topic: SITE_CHANGED_TOPIC,
        tenantId: DEFAULT_TENANT,
        aggregateId: 'default',
        payload: { siteId: 'default', domains: ['default.opt2.test'] },
      });
      await consumeEnvelope(handle.app, tenantRegistryConsumer, site, { subscription: SITE_CHANGED_SUBSCRIPTION, messageId: randomUUID(), logger });
    });

    afterAll(async () => {
      await withMetadata(handle.app, (tx) => tx.query(`DELETE FROM ${handle.schema}.tenant_registry WHERE tenant_id = $1`, [DEFAULT_TENANT]));
    });

    it.each(DEFAULT_SITE_CASES)('login mail from $label: $expected', async (bindingCase) => {
      await expectBinding(loginMail, LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope(bindingCase), bindingCase.expected);
    });
  });

  describe('through the push route of the communications app', () => {
    let built: TestApp<TenantDb>;

    beforeAll(async () => {
      // The app's shutdown ends its pool; the throwaway schema's drop() ends this one.
      const db: TenantDb = {
        schema: handle.app.schema,
        withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, fn),
        withMetadata: (fn, opts) => handle.app.withMetadata(fn, opts),
        end: async () => undefined,
      };
      built = await buildTestApp({ db });
    });

    afterAll(async () => {
      await built?.app.close();
    });

    async function storedRows(tenantId: string, table: string, column: string, id: string): Promise<number> {
      return withTenant(handle.app, tenantId, async (tx) => {
        const { rowCount } = await tx.query(`SELECT 1 FROM ${handle.schema}.${table} WHERE ${column} = $1`, [id]);
        return rowCount ?? 0;
      });
    }

    it.each([
      {
        label: 'a login mail for site tenant-a under tenant-b',
        subscription: LOGIN_MAIL_SUBSCRIPTION,
        envelope: (): EventEnvelope => loginMailEnvelope({ tenantId: TENANT_B.tenantId, siteId: 'tenant-a' }),
        effect: { table: 'message', column: 'message_id', field: 'messageId' },
      },
      {
        label: 'a survey schedule for site tenant-b under tenant-a',
        subscription: SURVEY_SCHEDULED_SUBSCRIPTION,
        envelope: (): EventEnvelope => surveyEnvelope({ tenantId: TENANT_A.tenantId, siteId: 'tenant-b' }),
        effect: { table: 'scheduled_task', column: 'source_id', field: 'surveyId' },
      },
    ])('acks $label with 204 and dead-letters it as tenant-mismatch, storing, sending and queueing nothing', async ({ subscription, envelope: make, effect }) => {
      const envelope = make();
      const tasksBefore = built.taskPort.tasks.length;

      const response = await pushTo(built.app, subscription, envelope);

      expect(response.statusCode).toBe(204);
      const letters = built.publisher.deadLetters(subscription).filter((letter) => letter.message.attributes.eventId === envelope.eventId);
      expect(letters).toEqual([expect.objectContaining({ reason: 'tenant-mismatch' })]);
      expect(await hasReceipt(envelope.tenantId, envelope.eventId)).toBe(false);
      const id = (envelope.payload as Record<string, string>)[effect.field] ?? '';
      expect(await storedRows(envelope.tenantId, effect.table, effect.column, id)).toBe(0);
      expect(built.mail.sent).toEqual([]);
      expect(built.taskPort.tasks).toHaveLength(tasksBefore);
    });
  });
});
