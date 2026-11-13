// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Dead letters, and nacks behind a closed unit gate, on communications' login-mail push route against a throwaway schema. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEAD_LETTER_REASON_ATTRIBUTE,
  INBOX_TABLE,
  dlqTopicName,
  encodeEnvelope,
  type DeadLetterReason,
  type EventEnvelope,
} from '@opt2/platform/events';
import { MIGRATION_PATH_PREFIX, UNIT_GATE_TABLE, qualified, type GateRequest } from '@opt2/platform/migration-kit';
import { isTenantId, tenantIdForSite, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_LIST,
  createThrowawaySchema,
  pgAvailable,
  pushTo,
  seedRegistry,
  withEnvelopeTenant,
  withoutTenant,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { LOGIN_MAIL_SUBSCRIPTION } from '../../src/events/consumers.js';
import { LOGIN_MAIL_TOPIC } from '../../src/events/login-mail.js';
import { DELIVERY_STATUS, MESSAGE } from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { envelopeFor, loginMailPayload, producerValidator } from '../helpers/payloads.js';

interface DeadLetterCase {
  label: string;
  reason: DeadLetterReason;
  envelope: (messageId: string) => TenantlessEnvelope;
}

const LOGIN_MAIL_DLQ = dlqTopicName(LOGIN_MAIL_SUBSCRIPTION);
const GATE_PATH = `${MIGRATION_PATH_PREFIX}/gate`;
const GATE_HOLDER = 'window-dlq-suite';
const UNREGISTERED_TENANT = tenantIdForSite('no-such-site');
const FIXTURE_TENANTS: readonly string[] = TENANT_LIST.map(({ tenantId }) => tenantId);

const DEAD_LETTER_CASES: DeadLetterCase[] = [
  {
    label: 'a missing tenant',
    reason: 'missing-tenant',
    envelope: (messageId) => withoutTenant(envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId }), { tenantId: TENANT_A.tenantId })),
  },
  {
    label: 'an invalid tenant (a site id, not a UUID)',
    reason: 'invalid-tenant',
    envelope: (messageId) => withEnvelopeTenant(envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId })), TENANT_A.siteId),
  },
  {
    label: 'an invalid tenant (an unregistered UUID)',
    reason: 'invalid-tenant',
    envelope: (messageId) => envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId }), { tenantId: UNREGISTERED_TENANT }),
  },
  {
    label: 'a schema-invalid payload',
    reason: 'schema-invalid',
    envelope: (messageId) => {
      const { subject: _subject, ...payload } = loginMailPayload({ messageId });
      return envelopeFor(LOGIN_MAIL_TOPIC, payload, { tenantId: TENANT_A.tenantId });
    },
  },
];

let messageIds = 0;

/** The next CF UUID of a fixed sequence, so no case can see another case's message row. */
function nextMessageId(): string {
  messageIds += 1;
  return `D1000000-0000-4000-${messageIds.toString(16).toUpperCase().padStart(16, '0')}`;
}

// An unset PG_HOST means no PostgreSQL is configured; pgAvailable would reject on the missing settings.
const pgReason = process.env.PG_HOST ? 'requires PostgreSQL: server unreachable' : 'requires PostgreSQL: PG_HOST not set';
const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)(`communications login-mail push route${available ? '' : ` (${pgReason})`}`, () => {
  let schema: ThrowawaySchema;
  let ctx: TestApp<TenantDb>;

  /** Rows of `table` whose `column` is `value`, summed over the fixture tenants and `extraTenant` when it is a UUID; RLS hides them from any other session. */
  async function countRows(table: string, column: string, value: string, extraTenant?: string): Promise<number> {
    const tenants = new Set(FIXTURE_TENANTS);
    if (isTenantId(extraTenant)) tenants.add(extraTenant.toLowerCase());
    let total = 0;
    for (const tenantId of tenants) {
      total += await withTenant(schema.app, tenantId, async (tx) => {
        const { rowCount } = await tx.query(`SELECT 1 FROM ${qualified(schema.schema, table)} WHERE ${column} = $1`, [value]);
        return rowCount ?? 0;
      });
    }
    return total;
  }

  async function gate(body: GateRequest) {
    return ctx.app.inject({ method: 'POST', url: GATE_PATH, headers: await headersFor('service:migration'), payload: body });
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations/', import.meta.url)),
    });
    await seedRegistry(schema.app, schema.schema);
    ctx = await buildTestApp({ db: schema.app, seedRegistry: false });
    // Start-up registers every gate legacy-authoritative; login-mail writes need the message units target-authoritative.
    await withMetadata(schema.app, (tx) =>
      tx.query(
        `UPDATE ${qualified(schema.schema, UNIT_GATE_TABLE)} SET state = 'open', holder_id = NULL, phase = 'quiet' WHERE unit = ANY($1::text[])`,
        [[MESSAGE.unit, DELIVERY_STATUS.unit]],
      ),
    );
  });

  beforeEach(() => {
    ctx.publisher.clear();
  });

  afterAll(async () => {
    try {
      await ctx?.app.close();
    } finally {
      await schema?.drop();
    }
  });

  describe('dead letters and nacks', () => {
    it.each(DEAD_LETTER_CASES)('dead-letters $label', async ({ reason, envelope: build }) => {
      const messageId = nextMessageId();
      const envelope = build(messageId);
      const sentBefore = ctx.mail.sent.length;
      // Only the schema case may fail the producer schema, so the tenant cases are rejected for their tenant alone.
      expect(producerValidator(LOGIN_MAIL_TOPIC).validatePayload(envelope.payload).ok).toBe(reason !== 'schema-invalid');

      const response = await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope);

      expect(response.statusCode).toBe(204);
      expect(ctx.publisher.raw.map(({ topic }) => topic)).toEqual([LOGIN_MAIL_DLQ]);
      const [letter] = ctx.publisher.raw;
      expect(letter?.message.attributes[DEAD_LETTER_REASON_ATTRIBUTE]).toBe(reason);
      expect(letter?.message.data).toEqual(encodeEnvelope(envelope as EventEnvelope));
      expect(await countRows(INBOX_TABLE, 'event_id', envelope.eventId, envelope.tenantId)).toBe(0);
      expect(await countRows(MESSAGE.table, 'message_id', messageId, envelope.tenantId)).toBe(0);
      expect(ctx.mail.sent).toHaveLength(sentBefore);
    });

    it('nacks while the message gate is closed', { timeout: 45_000 }, async () => {
      const messageId = nextMessageId();
      const envelope = envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId }), { tenantId: TENANT_A.tenantId });
      const delivery = randomUUID();
      const sentBefore = ctx.mail.sent.length;

      const closed = await gate({ op: 'close', units: [MESSAGE.unit], holderId: GATE_HOLDER });
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toEqual({ units: [{ unit: MESSAGE.unit, state: 'closed', holderId: GATE_HOLDER, phase: 'quiet' }] });

      const nacked = await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope, { messageId: delivery, deliveryAttempt: 1 });

      // The consumer's message read fences the gate before its insert, so the closed gate nacks as GateRaceError without the gate wait.
      expect(nacked.statusCode).toBe(503);
      expect(ctx.publisher.deadLetters(LOGIN_MAIL_SUBSCRIPTION)).toEqual([]);
      expect(await countRows(INBOX_TABLE, 'event_id', envelope.eventId)).toBe(0);
      expect(await countRows(MESSAGE.table, 'message_id', messageId)).toBe(0);
      expect(ctx.mail.sent).toHaveLength(sentBefore);

      const reopened = await gate({ op: 'open', units: [MESSAGE.unit], holderId: GATE_HOLDER });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json()).toEqual({ units: [{ unit: MESSAGE.unit, state: 'open', holderId: null, phase: 'quiet' }] });

      const redelivered = await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope, { messageId: delivery, deliveryAttempt: 2 });

      expect(redelivered.statusCode).toBe(204);
      expect(ctx.publisher.deadLetters(LOGIN_MAIL_SUBSCRIPTION)).toEqual([]);
      expect(await countRows(INBOX_TABLE, 'event_id', envelope.eventId)).toBe(1);
      expect(await countRows(MESSAGE.table, 'message_id', messageId)).toBe(1);
      expect(ctx.mail.sent).toHaveLength(sentBefore + 1);
    });
  });
});
