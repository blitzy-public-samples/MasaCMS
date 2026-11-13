// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Login mail through the communications app: the identity consumer and the outbox-sweep recovery hook, over the offline fakes. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsumeContext, EventEnvelope } from '@opt2/platform/events';
import { createLogger, type Logger } from '@opt2/platform/logging';
import { outboxRuntimeFor, type RecoveryContext } from '@opt2/platform/outbox';
import type { TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, fixedClock, pushTo } from '@opt2/platform/testing';
import type { MailDeps } from '../../src/domain/delivery.js';
import {
  LOGIN_MAIL_RECOVERY_AGE_MS,
  LOGIN_MAIL_SOURCE,
  applyLoginMail,
  loginMailFrom,
  loginMailRecovery,
} from '../../src/domain/login-mail.js';
import { cfTrim, messageIdHeader } from '../../src/domain/mail-transport.js';
import type { SenderAddressSource } from '../../src/domain/sender-address.js';
import { LOGIN_MAIL_SUBSCRIPTION } from '../../src/events/consumers.js';
import { LOGIN_MAIL_TOPIC, type LoginMailRequestedPayload } from '../../src/events/login-mail.js';
import { RECOVERY_BATCH_SIZE } from '../../src/repo/queries.js';
import { OWNER, SCHEMA, createCommunicationsRepository } from '../../src/repo/repository.js';
import {
  DEFAULT_SENDER_ADDRESS,
  TEST_CLOCK,
  buildTestApp,
  createRecordingDb,
  type RecordingDb,
  type Row,
  type TestApp,
} from '../helpers/app.js';
import { SAMPLE_IDS, envelopeFor, loginMailPayload } from '../helpers/payloads.js';

const DELIVERY_STATUS_TOPIC = 'communications.message.delivery-status-changed.v1';
const DELIVERY_STATUS_UNIT = 'communications.delivery_status';
const MIXED_TO = 'member1@tenant-a.example,not-an-address, member2@tenant-a.example';
const FILTERED_TO = 'member1@tenant-a.example, member2@tenant-a.example';
const OTHER_MESSAGE_ID = 'A1B2C3D4-0001-4000-8000000000000002';

type Payload = LoginMailRequestedPayload;
type HistoryEntry = [status: unknown, detail: unknown, mailpitId: unknown];

interface LogLine {
  severity: string;
  message: string;
  tenantId?: string;
}

/** The app's sender source, made to reject its next lookups on request. */
interface FlakySender extends SenderAddressSource {
  failNext(): void;
}

/** An app built over the fakes, the MailDeps the recovery hook takes from them, and the lines its logger wrote. */
interface Rig {
  t: TestApp;
  deps: MailDeps;
  sender: FlakySender;
  logger: Logger;
  logs: LogLine[];
}

const openApps: TestApp[] = [];

afterEach(async () => {
  for (const t of openApps.splice(0)) {
    await t.app.close();
  }
});

function flakySender(base: SenderAddressSource): FlakySender {
  let failures = 0;
  return {
    failNext() {
      failures += 1;
    },
    async fromEmail(siteId) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('sender lookup failed');
      }
      return base.fromEmail(siteId);
    },
  };
}

async function buildRig(db?: RecordingDb): Promise<Rig> {
  const t = await buildTestApp(db === undefined ? {} : { db });
  openApps.push(t);
  const logs: LogLine[] = [];
  const logger = createLogger({
    service: OWNER,
    version: '1.0.0',
    env: 'local',
    destination: { write: (line: string) => void logs.push(JSON.parse(line) as LogLine) },
  });
  const sender = flakySender(t.senderAddress);
  const deps: MailDeps = {
    db: t.db,
    repository: createCommunicationsRepository({ clock: t.clock }),
    clock: t.clock,
    logger,
    transport: t.mail,
    deliveryStatus: t.deliveryStatus,
    senderAddress: sender,
  };
  return { t, deps, sender, logger, logs };
}

function loginMailEnvelope(payload: Payload = loginMailPayload()): EventEnvelope<Payload> {
  return envelopeFor(LOGIN_MAIL_TOPIC, payload, { tenantId: TENANT_A.tenantId });
}

function consumeContext(rig: Rig): ConsumeContext {
  return {
    subscription: LOGIN_MAIL_SUBSCRIPTION,
    messageId: randomUUID(),
    destinationTenantId: TENANT_A.tenantId,
    isFanout: false,
    logger: rig.logger,
  };
}

/** Applies `payload` in tenant A as the consumer does while its post-commit sender lookup fails, leaving the mail queued. */
async function storeQueued(rig: Rig, payload: Payload = loginMailPayload()): Promise<Row> {
  const envelope = loginMailEnvelope(payload);
  const apply = applyLoginMail(rig.deps);
  rig.sender.failNext();
  await rig.t.db.withTenant(TENANT_A.tenantId, async (tx) => {
    await apply(tx, envelope, consumeContext(rig));
  });
  return messageRow(rig.t, payload.messageId);
}

function messageRow(t: TestApp, messageId: string): Row {
  const row = t.db.rows('message').find((candidate) => candidate.message_id === messageId);
  if (row === undefined) {
    throw new Error(`message ${messageId} is not stored`);
  }
  return row;
}

function history(t: TestApp, messageId: string): HistoryEntry[] {
  return t.db
    .rows('delivery_status')
    .filter((row) => row.message_id === messageId)
    .map((row) => [row.status, row.detail, row.mailpit_id]);
}

/** Sweep context at `at`; the hook reads only its clock and logger. */
function sweepAt(rig: Rig, at: Date): RecoveryContext {
  return { service: OWNER, runtime: outboxRuntimeFor(SCHEMA), clock: fixedClock(at), logger: rig.logger };
}

/** The first instant at which `row` is older than the recovery age. */
function overdue(row: Row): Date {
  return new Date((row.created as Date).getTime() + LOGIN_MAIL_RECOVERY_AGE_MS + 1);
}

/** A tenant-a login mail left `queued` at `created`, as a seed row. */
function queuedRow(messageId: string, created: Date): Row {
  const payload = loginMailPayload({ messageId });
  return {
    tenant_id: TENANT_A.tenantId,
    message_id: messageId,
    siteid: payload.siteId,
    to_address: payload.to,
    from_address: payload.from,
    subject: payload.subject,
    body_text: payload.text,
    body_html: '',
    state: 'queued',
    created,
    source: LOGIN_MAIL_SOURCE,
    event_id: randomUUID(),
    row_version: '1',
  };
}

interface StoredEnvelope {
  aggregateId: string;
  aggregateVersion: number;
  payload: { state: string };
}

function envelopeOf(row: Row): StoredEnvelope {
  return row.envelope as StoredEnvelope;
}

/** Body mailer.cfc sendText delivers: the CF-trimmed text plus the one space its cfmail tag adds. */
function sendTextOf(text: string): string {
  return `${cfTrim(text)} `;
}

const queued: HistoryEntry = ['queued', null, null];
const sent: HistoryEntry = ['sent', null, null];
const delivered = (messageId: string): HistoryEntry => ['delivered', null, `mailpit-${messageId}`];

describe('loginMailFrom', () => {
  it.each([
    ['the display name', { from: 'Tenant A', siteId: 'tenant-a' }, 'Tenant A'],
    ['the site address when the name is empty', { from: '', siteId: 'tenant-a' }, DEFAULT_SENDER_ADDRESS],
    ['no name without a site', { from: '', siteId: '' }, ''],
  ])('shows %s', (_case, payload, name) => {
    expect(loginMailFrom(payload, DEFAULT_SENDER_ADDRESS)).toEqual({ name, address: DEFAULT_SENDER_ADDRESS });
  });
});

describe('login-mail consumer', () => {
  it('stores the mail and sends it as sendText, without Bcc', async () => {
    const { t } = await buildRig();
    const payload = loginMailPayload({ to: MIXED_TO });
    const envelope = loginMailEnvelope(payload);

    const res = await pushTo(t.app, LOGIN_MAIL_SUBSCRIPTION, envelope);

    expect(res.statusCode, res.body).toBe(204);
    expect(t.db.rows('message')).toEqual([
      expect.objectContaining({
        tenant_id: TENANT_A.tenantId,
        message_id: payload.messageId,
        siteid: payload.siteId,
        to_address: MIXED_TO,
        from_address: payload.from,
        subject: payload.subject,
        body_text: payload.text,
        body_html: '',
        source: LOGIN_MAIL_SOURCE,
        event_id: envelope.eventId,
      }),
    ]);
    expect(t.senderAddress.calls).toEqual([payload.siteId]);
    expect(t.mail.sent).toStrictEqual([
      {
        to: FILTERED_TO,
        from: { name: payload.from, address: DEFAULT_SENDER_ADDRESS },
        subject: payload.subject,
        text: sendTextOf(payload.text),
        html: '',
        messageId: payload.messageId,
      },
    ]);
    expect(t.mail.sent[0]).not.toHaveProperty('bcc');
    expect(t.mail.sent.map((mail) => messageIdHeader(mail.messageId))).toEqual([`<${payload.messageId}@opt2.local>`]);
  });

  it('confirms the mail delivered, with one delivery-status event per change', async () => {
    const { t } = await buildRig();
    const { messageId } = loginMailPayload();

    expect((await pushTo(t.app, LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope())).statusCode).toBe(204);

    expect(messageRow(t, messageId)).toMatchObject({ state: 'delivered', row_version: '4', sent_at: expect.any(Date) });
    expect(history(t, messageId)).toEqual([queued, sent, delivered(messageId)]);
    expect(t.deliveryStatus.calls).toEqual([{ messageId, attempt: 1, result: `mailpit-${messageId}` }]);
    const events = t.db.rows('outbox').map((row) => ({ topic: row.topic, envelope: envelopeOf(row) }));
    expect(events.map(({ topic, envelope }) => [topic, envelope.aggregateId, envelope.aggregateVersion, envelope.payload.state])).toEqual([
      [DELIVERY_STATUS_TOPIC, messageId, 2, 'queued'],
      [DELIVERY_STATUS_TOPIC, messageId, 3, 'sent'],
      [DELIVERY_STATUS_TOPIC, messageId, 4, 'delivered'],
    ]);
  });

  it('applies a redelivered envelope once', async () => {
    const { t } = await buildRig();
    const envelope = loginMailEnvelope();

    for (let delivery = 0; delivery < 2; delivery += 1) {
      expect((await pushTo(t.app, LOGIN_MAIL_SUBSCRIPTION, envelope)).statusCode).toBe(204);
    }

    expect(t.db.rows('message')).toHaveLength(1);
    expect(t.db.rows('inbox')).toHaveLength(1);
    expect(t.mail.sent).toHaveLength(1);
  });

  it('stores and sends nothing for another event naming a stored message', async () => {
    const { t } = await buildRig();
    const first = loginMailEnvelope();
    const second = loginMailEnvelope();

    for (const envelope of [first, second]) {
      expect((await pushTo(t.app, LOGIN_MAIL_SUBSCRIPTION, envelope)).statusCode).toBe(204);
    }

    expect(t.db.rows('message')).toEqual([expect.objectContaining({ event_id: first.eventId })]);
    expect(t.db.rows('inbox').map((row) => row.event_id)).toEqual([first.eventId, second.eventId]);
    expect(t.mail.sent).toHaveLength(1);
  });

  it('sends nothing and records failed when no recipient is valid', async () => {
    const { t } = await buildRig();
    const { messageId } = loginMailPayload();

    const res = await pushTo(t.app, LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope(loginMailPayload({ to: 'not-an-address,also@invalid' })));

    expect(res.statusCode, res.body).toBe(204);
    expect(t.mail.sent).toEqual([]);
    expect(t.deliveryStatus.calls).toEqual([]);
    expect(messageRow(t, messageId)).toMatchObject({ state: 'failed', sent_at: null });
    expect(history(t, messageId)).toEqual([queued, ['failed', null, null]]);
  });

  it('records an SMTP failure without a Mailpit lookup', async () => {
    const { t } = await buildRig();
    const { messageId } = loginMailPayload();
    t.mail.fail(new Error('connect ECONNREFUSED 127.0.0.1:1025'));

    expect((await pushTo(t.app, LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope())).statusCode).toBe(204);

    expect(t.deliveryStatus.calls).toEqual([]);
    expect(messageRow(t, messageId).state).toBe('failed');
    expect(history(t, messageId)).toEqual([queued, ['failed', 'smtp-error', null]]);
  });
});

describe('login-mail recovery', () => {
  it('leaves a mail queued until it is older than the recovery age', async () => {
    const rig = await buildRig();
    const row = await storeQueued(rig);
    expect(row.state).toBe('queued');
    expect(rig.logs).toContainEqual(
      expect.objectContaining({ severity: 'ERROR', tenantId: TENANT_A.tenantId, message: expect.stringContaining('stays queued for recovery') }),
    );

    await loginMailRecovery(rig.deps).run(sweepAt(rig, new Date((row.created as Date).getTime() + LOGIN_MAIL_RECOVERY_AGE_MS)));

    expect(rig.t.mail.sent).toEqual([]);
    expect(rig.t.deliveryStatus.calls).toEqual([]);
    expect(messageRow(rig.t, SAMPLE_IDS.messageId).state).toBe('queued');
  });

  it('sends a lost mail once and confirms it', async () => {
    const rig = await buildRig();
    const payload = loginMailPayload();
    const row = await storeQueued(rig, payload);
    rig.t.deliveryStatus.script(payload.messageId, { foundOnTry: 2 });
    const hook = loginMailRecovery(rig.deps);

    await hook.run(sweepAt(rig, overdue(row)));
    await hook.run(sweepAt(rig, overdue(row)));

    expect(rig.t.mail.sent).toStrictEqual([
      {
        to: payload.to,
        from: { name: payload.from, address: DEFAULT_SENDER_ADDRESS },
        subject: payload.subject,
        text: sendTextOf(payload.text),
        html: '',
        messageId: payload.messageId,
      },
    ]);
    expect(rig.t.deliveryStatus.calls.map(({ attempt, result }) => [attempt, result])).toEqual([
      [1, null],
      [2, `mailpit-${payload.messageId}`],
    ]);
    expect(messageRow(rig.t, payload.messageId).state).toBe('delivered');
    expect(history(rig.t, payload.messageId)).toEqual([queued, sent, delivered(payload.messageId)]);
  });

  it('only records a mail Mailpit already holds', async () => {
    const rig = await buildRig();
    const row = await storeQueued(rig);

    await loginMailRecovery(rig.deps).run(sweepAt(rig, overdue(row)));

    expect(rig.t.mail.sent).toEqual([]);
    expect(messageRow(rig.t, SAMPLE_IDS.messageId).state).toBe('delivered');
    expect(history(rig.t, SAMPLE_IDS.messageId)).toEqual([queued, sent, delivered(SAMPLE_IDS.messageId)]);
  });

  it('recovers each registry tenant in its own tenant transaction', async () => {
    const rig = await buildRig();
    const row = await storeQueued(rig);
    const start = rig.t.db.transactions.length;

    await loginMailRecovery(rig.deps).run(sweepAt(rig, overdue(row)));

    const swept = rig.t.db.transactions.slice(start);
    const registry = rig.t.db.rows('tenant_registry').map((entry) => String(entry.tenant_id).toLowerCase());
    expect(new Set(swept.flatMap((tx) => (tx.tenantId === null ? [] : [tx.tenantId])))).toEqual(new Set(registry));
    const writers = swept.filter((tx) => tx.statements.some((statement) => /^(INSERT|UPDATE)\b/i.test(statement.text)));
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.every((tx) => tx.tenantId === TENANT_A.tenantId && tx.outcome === 'commit')).toBe(true);
  });

  it.each<[string, Partial<Payload>, (rig: Rig) => void, number, HistoryEntry[]]>([
    ['a mail without a valid recipient', { to: 'not-an-address' }, () => undefined, 0, [queued, ['failed', null, null]]],
    ['a failed send', {}, (rig) => rig.t.mail.fail(new Error('connect ECONNREFUSED 127.0.0.1:1025')), 0, [queued, ['failed', 'smtp-error', null]]],
    ['a sent mail Mailpit never shows', {}, () => undefined, 1, [queued, sent, ['failed', 'mailpit-not-found', null]]],
  ])('records %s as failed', async (_case, overrides, arrange, sends, expected) => {
    const rig = await buildRig();
    const row = await storeQueued(rig, loginMailPayload(overrides));
    rig.t.deliveryStatus.script(SAMPLE_IDS.messageId, 'never');
    arrange(rig);

    await loginMailRecovery(rig.deps).run(sweepAt(rig, overdue(row)));

    expect(rig.t.mail.sent).toHaveLength(sends);
    expect(messageRow(rig.t, SAMPLE_IDS.messageId).state).toBe('failed');
    expect(history(rig.t, SAMPLE_IDS.messageId)).toEqual(expected);
  });

  it('skips the tenant while a unit gate is legacy-authoritative', async () => {
    const rig = await buildRig();
    const row = await storeQueued(rig);
    const hook = loginMailRecovery(rig.deps);
    rig.t.db.setGate(DELIVERY_STATUS_UNIT, 'legacy');

    await hook.run(sweepAt(rig, overdue(row)));

    expect(messageRow(rig.t, SAMPLE_IDS.messageId).state).toBe('queued');
    expect(rig.t.deliveryStatus.calls).toEqual([]);
    expect(rig.logs).toContainEqual(expect.objectContaining({ severity: 'WARNING', tenantId: TENANT_A.tenantId }));

    rig.t.db.setGate(DELIVERY_STATUS_UNIT, 'open');
    await hook.run(sweepAt(rig, overdue(row)));

    expect(messageRow(rig.t, SAMPLE_IDS.messageId).state).toBe('delivered');
  });

  it('logs a failing mail and recovers the others', async () => {
    const rig = await buildRig();
    const failing = await storeQueued(rig);
    await storeQueued(rig, loginMailPayload({ messageId: OTHER_MESSAGE_ID }));
    const deps: MailDeps = {
      ...rig.deps,
      deliveryStatus: {
        confirm: (messageId) =>
          messageId === failing.message_id ? Promise.reject(new Error('mailpit unreachable')) : rig.t.deliveryStatus.confirm(messageId),
      },
    };

    await loginMailRecovery(deps).run(sweepAt(rig, overdue(failing)));

    expect(messageRow(rig.t, SAMPLE_IDS.messageId).state).toBe('queued');
    expect(messageRow(rig.t, OTHER_MESSAGE_ID).state).toBe('delivered');
    expect(rig.logs).toContainEqual(
      expect.objectContaining({ severity: 'ERROR', tenantId: TENANT_A.tenantId, message: `login mail ${SAMPLE_IDS.messageId}: recovery failed` }),
    );
  });

  it('rethrows a tenant error that is not a gate error', async () => {
    const rig = await buildRig();
    const db: TenantDb = { ...rig.t.db, withTenant: () => Promise.reject(new Error('connection terminated')) };

    await expect(loginMailRecovery({ ...rig.deps, db }).run(sweepAt(rig, TEST_CLOCK.now()))).rejects.toThrow('connection terminated');
  });

  it('pages through more than one batch', async () => {
    const created = new Date(TEST_CLOCK.now().getTime() - 2 * LOGIN_MAIL_RECOVERY_AGE_MS);
    const ids = Array.from({ length: RECOVERY_BATCH_SIZE + 1 }, (_, n) => `C0000000-0000-0000-${String(n + 1).padStart(16, '0')}`);
    const rig = await buildRig(createRecordingDb({ message: ids.map((messageId) => queuedRow(messageId, created)) }));

    await loginMailRecovery(rig.deps).run(sweepAt(rig, TEST_CLOCK.now()));

    expect(rig.t.deliveryStatus.calls.map(({ messageId }) => messageId)).toEqual(ids);
    expect(rig.t.db.rows('message').every((row) => row.state === 'delivered')).toBe(true);
  });

  it('skips a mail another sweep finished after the batch read', async () => {
    const rig = await buildRig();
    const row = await storeQueued(rig);
    rig.t.deliveryStatus.script(SAMPLE_IDS.messageId, { foundOnTry: 2 });
    const ctx = sweepAt(rig, overdue(row));
    // The recording database ignores row locks, so the competing sweep runs between the first batch read and its claim.
    let competing: (() => Promise<void>) | undefined = () => loginMailRecovery(rig.deps).run(ctx);
    const db: TenantDb = {
      ...rig.t.db,
      async withTenant(tenantId, fn) {
        const result = await rig.t.db.withTenant(tenantId, fn);
        const run = competing;
        competing = undefined;
        await run?.();
        return result;
      },
    };

    await loginMailRecovery({ ...rig.deps, db }).run(ctx);

    expect(competing).toBeUndefined();
    expect(rig.t.mail.sent).toHaveLength(1);
    expect(history(rig.t, SAMPLE_IDS.messageId)).toEqual([queued, sent, delivered(SAMPLE_IDS.messageId)]);
  });
});
