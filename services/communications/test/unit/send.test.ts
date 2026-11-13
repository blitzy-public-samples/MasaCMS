// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Message send and delivery state over the fake transport, scripted Mailpit and recording database: fixture route, domain, outbox and changelog. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, type PublishedEvent } from '@opt2/platform/testing';
import { recordStatus, type MailDeps } from '../../src/domain/delivery.js';
import { cfTrim, messageIdHeader } from '../../src/domain/mail-transport.js';
import {
  DEFAULT_FROM_ADDRESS,
  MAILPIT_NOT_FOUND_DETAIL,
  SMTP_ERROR_DETAIL,
  confirmMessage,
  createMessage,
  outgoingMailFor,
  sendMessage,
  submitMessage,
  type CreateMessageArgs,
  type MessageDetailView,
  type MessageInput,
} from '../../src/domain/messages.js';
import {
  DELIVERY_STATUS_CHANGED_TOPIC,
  buildDeliveryStatusPayload,
  deliveryStatusChangedValidator,
} from '../../src/events/delivery-status-changed.js';
// The app builds its repository internally without exposing it, so direct domain calls build the same one over the same database.
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import type { DeliveryStatusRow, MessageRow, MessageState } from '../../src/repo/tables.js';
import { buildTestApp, createFakeDeliveryStatus, headersFor, type RecordedTransaction, type TestApp } from '../helpers/app.js';

const MESSAGES_URL = '/legacy-fixtures/cfml/api.cfm/communications/messages';
const SENDER = 'communications.sender';
const USER_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const CSRF_HEADERS = { 'x-csrf_token': 'SEND-TOKEN', 'x-csrf_token_expires': '260630120000000' } as const;
const MAILPIT_ID = 'MP-20260630-0001';
const TO = 'ann@tenant-a.example';
const SUBJECT = 'Timesheet reminder';
// Leading and trailing whitespace the fixture's cfmailpart writes as is, unlike mailer.cfc's trimmed sendText.
const BODY = '  Please submit your timesheet.\n';
const LITERAL: MessageInput = { to: TO, subject: SUBJECT, bodyText: BODY };
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
// The repository spaces one message's statuses 10 ms apart, as the fixture's nextInstant does.
const STATUS_SPACING_MS = 10;
// TEST_CLOCK's instant as envelope.rows() prints a datetime; every status falls within that second.
const FIXTURE_TIME = '2026-06-30T12:00:00';
const OUTBOX_INSERT = /^INSERT INTO "communications"\.outbox\b/;
const CHANGELOG_INSERT = /^INSERT INTO "communications"\."changelog"/;

type Envelope = PublishedEvent['envelope'];

/** A `communications.outbox` row as the recording database returns it. */
type OutboxRow = {
  event_id: string;
  tenant_id: string;
  topic: string;
  kind: string;
  ordering_key: string;
  envelope: Envelope;
  published_at: Date | null;
};

/** A `communications.changelog` row as the recording database returns it. */
type ChangelogRow = {
  table: string;
  op: string;
  key: string;
  after: string | null;
  origin: string;
  actor_user_id: string | null;
  request_id: string | null;
};

/** One changelog insert of a recorded transaction, from its bound values. */
type ChangeWrite = { table: string; op: string; key: string; after: string };

let t: TestApp;

/** Builds the app whose fake Mailpit finds every message on the first lookup under MAILPIT_ID, or never. */
async function startApp(found = true): Promise<TestApp> {
  const deliveryStatus = createFakeDeliveryStatus({}, { unscripted: found ? { foundOnTry: 1, mailpitId: MAILPIT_ID } : 'never' });
  return buildTestApp({ deliveryStatus });
}

afterEach(async () => {
  await t?.app.close();
});

/** POSTs `input` to the fixture messages route as the tenant-a sender; returns the status and the envelope data. */
async function postMessage(input: MessageInput = LITERAL): Promise<{ status: number; body: Record<string, unknown>; data: MessageDetailView }> {
  const headers = { ...(await headersFor(SENDER, { site: TENANT_A.siteId, sub: USER_ID })), ...CSRF_HEADERS };
  const res = await t.app.inject({ method: 'POST', url: MESSAGES_URL, headers, payload: input });
  const body = res.json() as Record<string, unknown>;
  return { status: res.statusCode, body, data: body.data as MessageDetailView };
}

/** The instant of a message's `n`-th status (0-based) under the injected clock. */
function statusTime(n: number): Date {
  return new Date(t.clock.now().getTime() + n * STATUS_SPACING_MS);
}

/** The stored message `messageId` and its history rows in storage order. */
function stored(messageId: string): { message: MessageRow; history: DeliveryStatusRow[] } {
  const messages = (t.db.rows('message') as MessageRow[]).filter((row) => row.message_id === messageId);
  expect(messages).toHaveLength(1);
  const history = (t.db.rows('delivery_status') as DeliveryStatusRow[]).filter((row) => row.message_id === messageId);
  return { message: messages[0] as MessageRow, history };
}

function outboxOf(messageId: string): OutboxRow[] {
  return (t.db.rows('outbox') as OutboxRow[]).filter((row) => row.ordering_key === messageId);
}

function changelogOf(messageId: string): ChangelogRow[] {
  return (t.db.rows('changelog') as ChangelogRow[]).filter((row) => row.key.includes(messageId) || row.after?.includes(messageId));
}

/** `row_version`, the last column of a canonical `message` encoding. */
function rowVersionIn(encoded: string | null): number {
  const match = /i\d+:(\d+)$/.exec(encoded ?? '');
  expect(match, encoded ?? 'null').not.toBeNull();
  return Number(match?.[1]);
}

/** `op` and `row_version` of each changelog row of the message itself. */
function messageVersions(messageId: string): Array<[string, number]> {
  return changelogOf(messageId)
    .filter((row) => row.table === 'message')
    .map((row) => [row.op, rowVersionIn(row.after)]);
}

/** The one committed transaction that wrote outbox event `eventId`, and the changelog inserts it made. */
function writtenWith(eventId: string): { tx: RecordedTransaction; changes: ChangeWrite[] } {
  const found = t.db.transactions.filter((tx) => tx.statements.some((s) => OUTBOX_INSERT.test(s.text) && s.values.includes(eventId)));
  expect(found).toHaveLength(1);
  const tx = found[0] as RecordedTransaction;
  const changes = tx.statements
    .filter((s) => CHANGELOG_INSERT.test(s.text))
    .map(({ values }) => ({ table: values[1], op: values[2], key: values[3], after: values[5] }) as ChangeWrite);
  return { tx, changes };
}

/**
 * Asserts one state event per history row, each written with its status row and changelog rows in that change's
 * transaction, its version the message's `row_version` after the change; returns the outbox rows.
 */
function expectStateEvents(message: MessageRow, history: readonly DeliveryStatusRow[]): OutboxRow[] {
  const outbox = outboxOf(message.message_id);
  expect(outbox.map((row) => row.envelope.payload)).toStrictEqual(history.map((status) => buildDeliveryStatusPayload(message, status)));
  const first = Number(message.row_version) - history.length + 1;
  expect(outbox.map((row) => row.envelope.aggregateVersion)).toStrictEqual(history.map((_, i) => first + i));
  outbox.forEach((row, i) => {
    const status = history[i] as DeliveryStatusRow;
    expect(row).toMatchObject({ topic: DELIVERY_STATUS_CHANGED_TOPIC, kind: 'state', tenant_id: TENANT_A.tenantId });
    expect(row.envelope).toMatchObject({
      aggregateType: 'message',
      aggregateId: message.message_id,
      tenantId: TENANT_A.tenantId,
      producer: 'communications',
    });
    expect(deliveryStatusChangedValidator.validatePayload(row.envelope.payload)).toMatchObject({ ok: true });
    const { tx, changes } = writtenWith(row.event_id);
    expect(tx).toMatchObject({ tenantId: TENANT_A.tenantId, outcome: 'commit' });
    expect(changes).toContainEqual(expect.objectContaining({ table: 'delivery_status', op: 'insert', key: expect.stringContaining(status.status_id) }));
    const messageVersionsWritten = changes.filter((change) => change.table === 'message').map((change) => rowVersionIn(change.after));
    expect(messageVersionsWritten).toContain(row.envelope.aggregateVersion);
  });
  return outbox;
}

/** Each history row's status, detail and Mailpit id as stored. */
function statuses(history: readonly DeliveryStatusRow[]): Array<[MessageState, string | null, string | null]> {
  return history.map((row) => [row.status, row.detail, row.mailpit_id]);
}

describe('fixture messages route', () => {
  beforeEach(async () => {
    t = await startApp();
  });

  it('answers the fixture envelope with the delivered detail', async () => {
    const { status, body, data } = await postMessage();
    const { history } = stored(data.message_id);

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      apiversion: 'v1',
      method: 'communications.messages',
      data: {
        message_id: data.message_id,
        siteid: TENANT_A.siteId,
        template_id: '',
        to_address: TO,
        from_address: DEFAULT_FROM_ADDRESS,
        subject: SUBJECT,
        body_text: BODY,
        body_html: '',
        state: 'delivered',
        created: FIXTURE_TIME,
        sent_at: FIXTURE_TIME,
        history: history.map((row) => ({
          status_id: row.status_id,
          message_id: data.message_id,
          status: row.status,
          detail: '',
          mailpit_id: row.status === 'delivered' ? MAILPIT_ID : '',
          recorded_at: FIXTURE_TIME,
        })),
      },
    });
    expect(data.history.map((row) => row.status)).toStrictEqual(['queued', 'sent', 'delivered']);
  });

  it('sends one mail under the message id with the body verbatim', async () => {
    const { data } = await postMessage();

    expect(t.mail.sent).toStrictEqual([
      { to: TO, from: { name: '', address: DEFAULT_FROM_ADDRESS }, subject: SUBJECT, text: BODY, html: '', messageId: data.message_id },
    ]);
    expect(messageIdHeader(data.message_id)).toBe(`<${data.message_id}@opt2.local>`);
    expect(t.mail.sent[0]?.text).not.toBe(cfTrim(BODY));
    expect(t.deliveryStatus.calls).toStrictEqual([{ messageId: data.message_id, attempt: 1, result: MAILPIT_ID }]);
  });

  it('stores the message and its history at the injected clock', async () => {
    const { data } = await postMessage();
    const { message, history } = stored(data.message_id);

    expect(message.message_id).toMatch(CF_UUID);
    expect(message).toMatchObject({
      tenant_id: TENANT_A.tenantId,
      siteid: TENANT_A.siteId,
      template_id: null,
      state: 'delivered',
      source: 'send',
      created: statusTime(0),
      sent_at: statusTime(1),
      event_id: null,
      row_version: '4',
    });
    expect(statuses(history)).toStrictEqual([
      ['queued', null, null],
      ['sent', null, null],
      ['delivered', null, MAILPIT_ID],
    ]);
    expect(history.map((row) => row.recorded_at)).toStrictEqual([statusTime(0), statusTime(1), statusTime(2)]);
    expect(history.every((row) => CF_UUID.test(row.status_id) && row.source === 'send' && row.tenant_id === TENANT_A.tenantId)).toBe(true);
    expect(new Set(history.map((row) => row.status_id)).size).toBe(3);
  });

  it('bumps row_version by one per state change and audits every write', async () => {
    const { data } = await postMessage();

    expect(messageVersions(data.message_id)).toStrictEqual([
      ['insert', 1],
      ['update', 2],
      ['update', 3],
      ['update', 4],
    ]);
    const audit = changelogOf(data.message_id);
    expect(audit.filter((row) => row.table === 'delivery_status').map((row) => row.op)).toStrictEqual(['insert', 'insert', 'insert']);
    expect(audit.every((row) => row.origin === 'target' && row.actor_user_id === USER_ID)).toBe(true);
  });

  it('writes one state event per change in that change transaction', async () => {
    const { data } = await postMessage();
    const { message, history } = stored(data.message_id);

    expect(expectStateEvents(message, history)).toHaveLength(3);
  });

  it('publishes the outbox rows before answering', async () => {
    const { data } = await postMessage();
    const outbox = outboxOf(data.message_id);

    expect(outbox.every((row) => row.published_at !== null)).toBe(true);
    expect(t.publisher.published).toStrictEqual(outbox.map((row) => ({ topic: row.topic, envelope: row.envelope })));
  });

  it('answers the failed detail when SMTP throws, without a Mailpit lookup', async () => {
    t.mail.fail(new Error('smtp down'));

    const { status, data } = await postMessage();
    const { message, history } = stored(data.message_id);

    expect(status).toBe(200);
    expect(data).toMatchObject({ state: 'failed', sent_at: '' });
    expect(data.history.map((row) => [row.status, row.detail])).toStrictEqual([
      ['queued', ''],
      ['failed', SMTP_ERROR_DETAIL],
    ]);
    expect(message).toMatchObject({ state: 'failed', sent_at: null, row_version: '3' });
    expect(statuses(history).at(-1)).toStrictEqual(['failed', SMTP_ERROR_DETAIL, null]);
    expect(t.mail.sent).toStrictEqual([]);
    expect(t.deliveryStatus.calls).toStrictEqual([]);
    const outbox = expectStateEvents(message, history);
    expect(outbox.filter((row) => (row.envelope.payload as { state: string }).state === 'failed')).toHaveLength(1);
  });
});

// communications.cfc ends a send Mailpit never shows in `failed` (mailpit-not-found); the message does not stay `sent`.
describe('fixture messages route when Mailpit never shows the message', () => {
  beforeEach(async () => {
    t = await startApp(false);
  });

  it('keeps the send and records failed mailpit-not-found, never delivered', async () => {
    const { status, data } = await postMessage();
    const { message, history } = stored(data.message_id);

    expect(status).toBe(200);
    expect(data).toMatchObject({ state: 'failed', sent_at: FIXTURE_TIME });
    expect(statuses(history)).toStrictEqual([
      ['queued', null, null],
      ['sent', null, null],
      ['failed', MAILPIT_NOT_FOUND_DETAIL, null],
    ]);
    expect(message).toMatchObject({ state: 'failed', sent_at: statusTime(1), row_version: '4' });
    expect(t.mail.sent).toHaveLength(1);
    expect(t.deliveryStatus.calls).toStrictEqual([{ messageId: data.message_id, attempt: 1, result: null }]);
    const outbox = expectStateEvents(message, history);
    expect(outbox.map((row) => (row.envelope.payload as { state: string }).state)).toStrictEqual(['queued', 'sent', 'failed']);
  });
});

describe('message domain', () => {
  let deps: MailDeps;
  let args: CreateMessageArgs;

  beforeEach(async () => {
    t = await startApp();
    deps = {
      db: t.db,
      repository: createCommunicationsRepository({ clock: t.clock, schema: t.db.schema }),
      clock: t.clock,
      logger: t.app.opt2.logger,
      transport: t.mail,
      deliveryStatus: t.deliveryStatus,
      senderAddress: t.senderAddress,
    };
    args = { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, userId: USER_ID, input: LITERAL };
  });

  /** The fixture's mail for a stored message: bare sender address, no display name. */
  function mailFor(message: MessageRow) {
    return outgoingMailFor(message, { name: '', address: message.from_address });
  }

  it('createMessage stores a queued message and sends nothing', async () => {
    const row = await createMessage(deps, args);
    const { message, history } = stored(row.message_id);

    expect(row).toMatchObject({ state: 'queued', source: 'send', sent_at: null, row_version: '2' });
    expect(message).toStrictEqual(row);
    expect(messageVersions(row.message_id)).toStrictEqual([
      ['insert', 1],
      ['update', 2],
    ]);
    expect(statuses(history)).toStrictEqual([['queued', null, null]]);
    expect(t.mail.sent).toStrictEqual([]);
    expect(t.deliveryStatus.calls).toStrictEqual([]);
    expectStateEvents(message, history);
  });

  it('sendMessage resolves and records failed when the transport throws', async () => {
    const queued = await createMessage(deps, args);
    t.mail.fail(new Error('smtp down'));

    const result = await sendMessage(deps, { tenantId: TENANT_A.tenantId, message: queued, mail: mailFor(queued) });
    const { message, history } = stored(queued.message_id);

    expect(result).toMatchObject({ state: 'failed', sent_at: null, row_version: '3' });
    expect(statuses(history)).toStrictEqual([
      ['queued', null, null],
      ['failed', SMTP_ERROR_DETAIL, null],
    ]);
    expect(t.mail.sent).toStrictEqual([]);
    expectStateEvents(message, history);
  });

  it('sendMessage records sent, then confirmMessage records delivered with the Mailpit id', async () => {
    const queued = await createMessage(deps, args);

    const sent = await sendMessage(deps, { tenantId: TENANT_A.tenantId, message: queued, mail: mailFor(queued) });
    const delivered = await confirmMessage(deps, { tenantId: TENANT_A.tenantId, message: sent });
    const { message, history } = stored(queued.message_id);

    expect(sent).toMatchObject({ state: 'sent', sent_at: statusTime(1), row_version: '3' });
    expect(delivered).toMatchObject({ state: 'delivered', sent_at: statusTime(1), row_version: '4' });
    expect(history.at(-1)).toMatchObject({ status: 'delivered', detail: null, mailpit_id: MAILPIT_ID, recorded_at: statusTime(2) });
    expect(t.mail.sent.map((mail) => mail.messageId)).toStrictEqual([queued.message_id]);
    expect(t.deliveryStatus.calls).toStrictEqual([{ messageId: queued.message_id, attempt: 1, result: MAILPIT_ID }]);
    expectStateEvents(message, history);
  });

  it('recordStatus twice in one transaction appends two rows and two consecutive events', async () => {
    const queued = await createMessage(deps, args);

    const [first, second] = await t.db.withTenant(TENANT_A.tenantId, async (tx) => {
      const sent = await recordStatus(tx, deps, queued, 'sent');
      return [sent, await recordStatus(tx, deps, sent.message, 'delivered', MAILPIT_ID)] as const;
    });
    const { message, history } = stored(queued.message_id);

    expect(first.message).toMatchObject({ state: 'sent', row_version: '3' });
    expect(second.message).toMatchObject({ state: 'delivered', row_version: '4' });
    expect(second.status).toMatchObject({ status: 'delivered', mailpit_id: MAILPIT_ID, recorded_at: statusTime(2) });
    expect(history.map((row) => row.status_id)).toStrictEqual([history[0]?.status_id, first.status.status_id, second.status.status_id]);
    const [, ...events] = expectStateEvents(message, history);
    expect(events.map((row) => row.envelope.aggregateVersion)).toStrictEqual([3, 4]);
    expect(new Set(events.map((row) => writtenWith(row.event_id).tx.id)).size).toBe(1);
  });

  it('recordStatus outside the message tenant throws and rolls its history row back', async () => {
    const queued = await createMessage(deps, args);

    await expect(t.db.withTenant(TENANT_B.tenantId, (tx) => recordStatus(tx, deps, queued, 'sent'))).rejects.toMatchObject({
      name: 'RepositoryError',
    });

    expect(t.db.transactions.filter((tx) => tx.tenantId === TENANT_B.tenantId).map((tx) => tx.outcome)).toStrictEqual(['rollback']);
    expect(statuses(stored(queued.message_id).history)).toStrictEqual([['queued', null, null]]);
    expect(outboxOf(queued.message_id)).toHaveLength(1);
  });

  it('submitMessage queues, sends and confirms under its write context', async () => {
    const detail = await submitMessage(deps, { ...args, context: { requestId: 'REQ-SEND-1' } });
    const { message, history } = stored(detail.message_id);

    expect(detail).toMatchObject({ state: 'delivered', to_address: TO, sent_at: FIXTURE_TIME });
    expect(detail.history.map((row) => [row.status, row.mailpit_id])).toStrictEqual([
      ['queued', ''],
      ['sent', ''],
      ['delivered', MAILPIT_ID],
    ]);
    expect(t.mail.sent.map((mail) => mail.messageId)).toStrictEqual([detail.message_id]);
    expect(changelogOf(detail.message_id).every((row) => row.actor_user_id === USER_ID && row.request_id === 'REQ-SEND-1')).toBe(true);
    expectStateEvents(message, history);
  });
});
