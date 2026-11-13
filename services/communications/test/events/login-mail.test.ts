// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Duplicated push delivery of `identity.login-mail.requested.v1` against PostgreSQL: one receipt, one message, one mail. */
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, deliverDuplicate, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { LOGIN_MAIL_SUBSCRIPTION } from '../../src/events/consumers.js';
import { LOGIN_MAIL_TOPIC } from '../../src/events/login-mail.js';
import { DELIVERY_STATUS, MESSAGE } from '../../src/repo/tables.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { envelopeFor, loginMailPayload } from '../helpers/payloads.js';

const DELIVERIES = 3;
const GATED_UNITS = [MESSAGE.unit, DELIVERY_STATUS.unit];
const WAIT = { timeout: 10_000, interval: 50 };
// Time for a second after-commit send, were one queued, to reach the fake transport.
const SETTLE_MS = 250;

// pgAvailable rejects when PG_HOST is unset; that case skips the suite instead.
const available = Boolean(process.env.PG_HOST) && (await pgAvailable());
const title = available ? 'login-mail consumer' : 'login-mail consumer (requires PostgreSQL: PG_HOST unset or unreachable)';

describe.skipIf(!available)(title, () => {
  let handle: ThrowawaySchema;
  let ctx: TestApp<TenantDb>;

  /** Rows of `columns` in the tenant-a slice of `table`. */
  async function tenantRows<T extends Record<string, unknown>>(table: string, columns: string): Promise<T[]> {
    const { rows } = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      tx.query<T>(`SELECT ${columns} FROM ${handle.schema}.${table}`),
    );
    return rows;
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations/', import.meta.url)),
    });
    await ensureUnitGates(handle.app, GATED_UNITS);
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet' WHERE unit = ANY($1::text[])`, [
        GATED_UNITS,
      ]),
    );
    ctx = await buildTestApp({ db: handle.app });
  });

  afterAll(async () => {
    await ctx?.app.close();
    await handle?.drop();
  });

  it('applies a duplicated delivery once', async () => {
    const payload = loginMailPayload();
    const envelope = envelopeFor(LOGIN_MAIL_TOPIC, payload, { tenantId: TENANT_A.tenantId });

    const responses = await deliverDuplicate(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope, DELIVERIES);

    expect(responses.map((response) => response.statusCode)).toEqual(Array<number>(DELIVERIES).fill(204));
    expect(ctx.publisher.deadLetters(LOGIN_MAIL_SUBSCRIPTION)).toEqual([]);

    // The send and its Mailpit confirmation run after the consumer's transaction commits, outside the push request.
    await vi.waitFor(() => expect(ctx.mail.sent).toHaveLength(1), WAIT);
    await vi.waitFor(async () => {
      expect(await tenantRows<{ state: string }>('message', 'state')).toEqual([{ state: 'delivered' }]);
    }, WAIT);
    await sleep(SETTLE_MS);

    expect(await tenantRows('message', 'message_id, source, event_id, state')).toEqual([
      { message_id: payload.messageId, source: 'login-mail', event_id: envelope.eventId, state: 'delivered' },
    ]);
    expect(await tenantRows('inbox', 'event_id, subscription, status')).toEqual([
      { event_id: envelope.eventId, subscription: LOGIN_MAIL_SUBSCRIPTION, status: 'applied' },
    ]);
    const statuses = await tenantRows<{ status: string }>('delivery_status', 'status');
    expect(statuses.map(({ status }) => status).sort()).toEqual(['delivered', 'queued', 'sent']);

    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0]).toMatchObject({ to: payload.to, messageId: payload.messageId });
    expect(ctx.mail.sent[0]).not.toHaveProperty('bcc');
    expect(ctx.deliveryStatus.calls).toHaveLength(1);
  });
});
