// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Login-mail consumer effect, post-commit delivery and sweep recovery over in-memory fakes of the tenant database, repository and mail ports. */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ConsumeContext, EventEnvelope } from '@opt2/platform/events';
import { createLogger, type Logger } from '@opt2/platform/logging';
import {
  GateClosedError,
  GateRaceError,
  OperationBlockedError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  acquireWriteGates,
  awaitReadable,
  qualified,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { writeOutbox, type OutboxRuntime, type OutboxWriteInput } from '@opt2/platform/outbox';
import { registeredTenants, type CommitCallback, type CommitErrorHandler, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createCapturingPublisher, fixedClock, testEnvelope } from '@opt2/platform/testing';
import type { MailDeps } from '../../src/domain/delivery.js';
import {
  LOGIN_MAIL_RECOVERY_AGE_MS,
  LOGIN_MAIL_RECOVERY_HOOK,
  LOGIN_MAIL_SOURCE,
  applyLoginMail,
  deliverLoginMail,
  loginMailFrom,
  loginMailRecovery,
} from '../../src/domain/login-mail.js';
import { messageIdHeader, type OutgoingMail, type SendResult } from '../../src/domain/mail-transport.js';
import type { IdentityLoginMailRequestedV1Payload } from '../../src/generated/events/identity.login-mail.requested.v1.js';
import { RECOVERY_BATCH_SIZE, findMessage, messageCursor, queuedLoginMailOlderThan, type RecoveryBatch } from '../../src/repo/queries.js';
import type { CommunicationsRepository, MessageStateChange, NewDeliveryStatus, NewMessage } from '../../src/repo/repository.js';
import { DELIVERY_STATUS, MESSAGE, type DeliveryStatusRow, type MessageRow } from '../../src/repo/tables.js';

vi.mock('@opt2/platform/migration-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opt2/platform/migration-kit')>()),
  acquireWriteGates: vi.fn(),
  awaitReadable: vi.fn(),
}));

vi.mock('@opt2/platform/tenancy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opt2/platform/tenancy')>()),
  registeredTenants: vi.fn(),
}));

vi.mock('@opt2/platform/outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opt2/platform/outbox')>()),
  writeOutbox: vi.fn(),
}));

vi.mock('../../src/repo/queries.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/repo/queries.js')>()),
  findMessage: vi.fn(),
  queuedLoginMailOlderThan: vi.fn(),
}));

type Payload = IdentityLoginMailRequestedV1Payload;

const SCHEMA = 'communications';
const TOPIC = 'identity.login-mail.requested.v1';
const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const QUEUED_AT = new Date(NOW.getTime() - LOGIN_MAIL_RECOVERY_AGE_MS - 1);
const MESSAGE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const USER_ID = 'AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000';
const CLAIM_SQL = `SELECT * FROM ${qualified(SCHEMA, MESSAGE.table)} WHERE message_id = $1 FOR UPDATE SKIP LOCKED`;
const CONSUMER_CONTEXT: WriteContext = { origin: 'target', actorService: 'identity' };
const RECOVERY_CONTEXT: WriteContext = { origin: 'target', actorService: 'communications' };
const PAYLOAD: Payload = {
  messageId: MESSAGE_ID,
  siteId: TENANT_A.siteId,
  to: 'ann@example.com,not-an-address, bob@example.org',
  from: 'Masa CMS',
  subject: 'Your login information',
  text: '\r\n  Dear Ann,\n\nYour username is ann.\n\n',
  bcc: 'audit@example.com',
  kind: 'send-login',
  userId: USER_ID,
  returnId: 'BBBBBBBB-CCCC-DDDD-EEEEFFFF00001111',
};

interface TenantRows {
  messages: Map<string, MessageRow>;
  history: DeliveryStatusRow[];
  outbox: OutboxWriteInput[];
}

interface LogLine {
  severity: string;
  message: string;
  tenantId?: string;
  eventId?: string;
  error?: { type: string; message: string };
}

/** Mutable state of the fakes; tests set the switches and read the records. */
interface WorldState {
  committed: Map<string, TenantRows>;
  /** Tenant of every transaction opened, in order. */
  opened: string[];
  rolledBack: number;
  /** Message ids another transaction holds. */
  locked: Set<string>;
  /** Mailpit IDs by message id. */
  mailpit: Map<string, string>;
  /** Sent mail drops before Mailpit sees it. */
  mailpitDrops: boolean;
  sendError: Error | null;
  sent: OutgoingMail[];
  /** Committed state of each message when its send started. */
  stateAtSend: (string | undefined)[];
  contexts: (WriteContext | undefined)[];
  batchReads: { tenantId: string; cutoff: Date; batch: RecoveryBatch | undefined }[];
  logs: LogLine[];
}

/** In-memory tenant database, repository and mail ports with per-transaction copies that commit or roll back. */
interface World extends WorldState {
  db: TenantDb;
  deps: MailDeps;
  insertMessage: Mock<(tx: TenantTx, input: NewMessage, ctx?: WriteContext) => Promise<MessageRow>>;
  send: Mock<(mail: OutgoingMail) => Promise<SendResult>>;
  confirm: Mock<(messageId: string) => Promise<string | null>>;
  fromEmail: Mock<(siteId: string) => Promise<string>>;
}

const working = new WeakMap<TenantTx, TenantRows>();

function rowsOf(tx: TenantTx): TenantRows {
  const rows = working.get(tx);
  if (rows === undefined) {
    throw new Error('statement outside a fake transaction');
  }
  return rows;
}

function copyRows(rows: TenantRows | undefined): TenantRows {
  return {
    messages: new Map([...(rows?.messages ?? [])].map(([id, row]) => [id, { ...row }])),
    history: [...(rows?.history ?? [])],
    outbox: [...(rows?.outbox ?? [])],
  };
}

function fakeDb(state: WorldState): TenantDb {
  return {
    schema: SCHEMA,
    async withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
      state.opened.push(tenantId);
      const rows = copyRows(state.committed.get(tenantId));
      const callbacks: [CommitCallback, CommitErrorHandler | undefined][] = [];
      const query = (text: unknown, values: unknown[] = []) => {
        if (text !== CLAIM_SQL) {
          return Promise.reject(new Error(`unexpected SQL: ${String(text)}`));
        }
        const id = String(values[0]);
        const row = state.locked.has(id) ? undefined : rows.messages.get(id);
        return Promise.resolve({ command: 'SELECT', rowCount: row === undefined ? 0 : 1, oid: 0, fields: [], rows: row === undefined ? [] : [{ ...row }] });
      };
      const tx: TenantTx = Object.freeze({
        kind: 'tenant',
        tenantId,
        schema: SCHEMA,
        query: query as unknown as TenantTx['query'],
        onCommit: (cb: CommitCallback, onError?: CommitErrorHandler) => {
          callbacks.push([cb, onError]);
        },
      });
      working.set(tx, rows);
      let result: T;
      try {
        result = await fn(tx);
      } catch (error) {
        state.rolledBack += 1;
        throw error;
      }
      state.committed.set(tenantId, rows);
      for (const [cb, onError] of callbacks) {
        try {
          await cb();
        } catch (error) {
          onError?.(error);
        }
      }
      return result;
    },
    withMetadata: () => Promise.reject(new Error('metadata transaction opened')),
    end: () => Promise.resolve(),
  };
}

function createWorld(): World {
  const clock = fixedClock(NOW);
  let statusSeq = 0;
  const state: WorldState = {
    committed: new Map(),
    opened: [],
    rolledBack: 0,
    locked: new Set(),
    mailpit: new Map(),
    mailpitDrops: false,
    sendError: null,
    sent: [],
    stateAtSend: [],
    contexts: [],
    batchReads: [],
    logs: [],
  };
  const committedMessage = (id: string): MessageRow | undefined =>
    [...state.committed.values()].map((rows) => rows.messages.get(id)).find((row) => row !== undefined);
  const db = fakeDb(state);

  const repository = {
    insertMessage: vi.fn((tx: TenantTx, input: NewMessage, ctx?: WriteContext) => {
      state.contexts.push(ctx);
      const row: MessageRow = {
        tenant_id: tx.tenantId,
        message_id: String(input.messageId),
        siteid: input.siteId,
        template_id: input.templateId ?? null,
        to_address: input.toAddress,
        from_address: input.fromAddress,
        subject: input.subject,
        body_text: input.bodyText,
        body_html: input.bodyHtml,
        state: input.state ?? 'queued',
        created: clock.now(),
        sent_at: null,
        source: input.source,
        event_id: input.eventId ?? null,
        row_version: '1',
      };
      rowsOf(tx).messages.set(row.message_id, row);
      return Promise.resolve({ ...row });
    }),
    appendDeliveryStatus: vi.fn((tx: TenantTx, input: NewDeliveryStatus, ctx?: WriteContext) => {
      state.contexts.push(ctx);
      statusSeq += 1;
      const row: DeliveryStatusRow = {
        tenant_id: tx.tenantId,
        status_id: `S${statusSeq}`,
        message_id: input.messageId,
        status: input.state,
        detail: input.detail || null,
        mailpit_id: input.mailpitId || null,
        recorded_at: clock.now(),
        source: input.source,
      };
      rowsOf(tx).history.push(row);
      return Promise.resolve({ ...row });
    }),
    setMessageState: vi.fn((tx: TenantTx, change: MessageStateChange, ctx?: WriteContext): Promise<MessageRow | null> => {
      state.contexts.push(ctx);
      const rows = rowsOf(tx);
      const current = rows.messages.get(change.messageId);
      if (current === undefined) {
        return Promise.resolve(null);
      }
      const next: MessageRow = {
        ...current,
        state: change.state,
        row_version: String(Number(current.row_version) + 1),
        ...(change.state === 'sent' ? { sent_at: change.at ?? clock.now() } : {}),
      };
      rows.messages.set(next.message_id, next);
      return Promise.resolve({ ...next });
    }),
  };

  const send = vi.fn((mail: OutgoingMail): Promise<SendResult> => {
    state.stateAtSend.push(committedMessage(mail.messageId)?.state);
    if (state.sendError !== null) {
      return Promise.reject(state.sendError);
    }
    state.sent.push(mail);
    if (!state.mailpitDrops) {
      state.mailpit.set(mail.messageId, `MP-${mail.messageId}`);
    }
    return Promise.resolve({ accepted: mail.to.split(',') });
  });
  const confirm = vi.fn((messageId: string) => Promise.resolve(state.mailpit.get(messageId) ?? null));
  const fromEmail = vi.fn((siteId: string) => Promise.resolve(`no-reply@${siteId === '' ? 'localhost' : `${siteId}.example.test`}`));
  const logger: Logger = createLogger({
    service: 'communications',
    version: '1.0.0',
    env: 'local',
    destination: { write: (line: string) => void state.logs.push(JSON.parse(line) as LogLine) },
  });
  const deps: MailDeps = {
    db,
    repository: repository as unknown as CommunicationsRepository,
    clock,
    logger,
    transport: { send, close: () => Promise.resolve() },
    deliveryStatus: { confirm },
    senderAddress: { fromEmail },
  };

  vi.mocked(awaitReadable).mockResolvedValue(undefined);
  vi.mocked(acquireWriteGates).mockResolvedValue(undefined);
  vi.mocked(writeOutbox).mockImplementation((tx, input) => {
    rowsOf(tx).outbox.push(input);
    return Promise.resolve(null);
  });
  vi.mocked(findMessage).mockImplementation((tx, messageId) => {
    const row = rowsOf(tx).messages.get(messageId);
    return Promise.resolve(row === undefined ? null : { ...row });
  });
  vi.mocked(queuedLoginMailOlderThan).mockImplementation((tx, cutoff, batch) => {
    state.batchReads.push({ tenantId: tx.tenantId, cutoff, batch });
    const after = batch?.after;
    const rows = [...rowsOf(tx).messages.values()]
      .filter((row) => row.source === LOGIN_MAIL_SOURCE && row.state === 'queued' && row.created.getTime() < cutoff.getTime())
      .filter(
        (row) =>
          after === undefined ||
          row.created.getTime() > after.at.getTime() ||
          (row.created.getTime() === after.at.getTime() && row.message_id > after.id),
      )
      .sort((a, b) => a.created.getTime() - b.created.getTime() || a.message_id.localeCompare(b.message_id))
      .slice(0, batch?.limit ?? RECOVERY_BATCH_SIZE)
      .map((row) => ({ ...row }));
    return Promise.resolve(rows);
  });
  vi.mocked(registeredTenants).mockResolvedValue([]);
  return Object.assign(state, { db, deps, insertMessage: repository.insertMessage, send, confirm, fromEmail });
}

/** A committed `queued` login mail, as the consumer stores it, created `QUEUED_AT` unless overridden. */
function seed(world: World, tenantId: string, overrides: Partial<MessageRow> = {}): MessageRow {
  const rows = world.committed.get(tenantId) ?? copyRows(undefined);
  const row: MessageRow = {
    tenant_id: tenantId,
    message_id: MESSAGE_ID,
    siteid: PAYLOAD.siteId,
    template_id: null,
    to_address: PAYLOAD.to,
    from_address: PAYLOAD.from,
    subject: PAYLOAD.subject,
    body_text: PAYLOAD.text,
    body_html: '',
    state: 'queued',
    created: QUEUED_AT,
    sent_at: null,
    source: LOGIN_MAIL_SOURCE,
    event_id: '0b9c7a52-3f2e-4c1d-9a8b-1c2d3e4f5a6b',
    row_version: '2',
    ...overrides,
  };
  rows.messages.set(row.message_id, row);
  world.committed.set(tenantId, rows);
  return { ...row };
}

function stored(world: World, tenantId: string, messageId = MESSAGE_ID): MessageRow | undefined {
  return world.committed.get(tenantId)?.messages.get(messageId);
}

function history(world: World, tenantId: string, messageId = MESSAGE_ID): [string, string | null, string | null][] {
  return (world.committed.get(tenantId)?.history ?? [])
    .filter((row) => row.message_id === messageId)
    .map((row) => [row.status, row.detail, row.mailpit_id]);
}

function outbox(world: World, tenantId: string): [string, number, string][] {
  return (world.committed.get(tenantId)?.outbox ?? []).map((row) => [
    row.aggregateId,
    row.aggregateVersion,
    (row.payload as { state: string }).state,
  ]);
}

/** Each log line as severity, tenant, message and error type. */
function logged(world: World): [string, string | undefined, string, string | undefined][] {
  return world.logs.map((line) => [line.severity, line.tenantId, line.message, line.error?.type]);
}

/** Every write the fakes saw carried `ctx`. */
function expectContexts(world: World, ctx: WriteContext): void {
  expect(world.contexts.length).toBeGreaterThan(0);
  expect(world.contexts).toEqual(world.contexts.map(() => ctx));
}

function loginMailEvent(payload: Partial<Payload> = {}, eventId?: string): EventEnvelope<Payload> {
  return testEnvelope<Payload>({
    topic: TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateId: USER_ID,
    payload: { ...PAYLOAD, ...payload },
    ...(eventId === undefined ? {} : { eventId }),
  });
}

/** Applies `envelope` in its own consumer transaction, then runs `after` in that transaction. */
function consume(world: World, envelope: EventEnvelope<Payload>, after?: () => Promise<void>): Promise<void> {
  const ctx: ConsumeContext = {
    subscription: 'communications.identity.login-mail.requested.v1',
    messageId: 'pubsub-1',
    destinationTenantId: envelope.tenantId,
    isFanout: false,
    logger: world.deps.logger,
  };
  return world.db.withTenant(envelope.tenantId, async (tx) => {
    await applyLoginMail(world.deps)(tx, envelope, ctx);
    await after?.();
  });
}

function sweep(world: World): Promise<void> {
  const runtime: OutboxRuntime = {
    service: 'communications',
    db: world.db,
    publisher: createCapturingPublisher(),
    logger: world.deps.logger,
    clock: world.deps.clock,
  };
  return loginMailRecovery(world.deps).run({ service: 'communications', runtime, clock: world.deps.clock, logger: world.deps.logger });
}

function registry(...tenantIds: string[]): void {
  vi.mocked(registeredTenants).mockResolvedValue(tenantIds.map((tenantId, i) => ({ tenantId, siteId: `site-${i}` })));
}

/** The error nodemailer throws when the relay refuses the connection. */
function refused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1025'), { code: 'ECONNREFUSED', syscall: 'connect' });
}

function cfId(n: number): string {
  return `A0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

let world: World;

beforeEach(() => {
  vi.resetAllMocks();
  world = createWorld();
});

describe('constants', () => {
  it('names the source, recovery age and hook', () => {
    expect(LOGIN_MAIL_SOURCE).toBe('login-mail');
    expect(LOGIN_MAIL_RECOVERY_AGE_MS).toBe(30_000);
    expect(LOGIN_MAIL_RECOVERY_HOOK).toBe('communications-login-mail');
    expect(loginMailRecovery(world.deps).name).toBe('communications-login-mail');
  });
});

describe('loginMailFrom', () => {
  it.each([
    ['a named sender', 'Masa CMS', 'tenant-a', 'Masa CMS'],
    ['a named sender without a site', 'Masa CMS', '', 'Masa CMS'],
    ['the site address for an empty sender', '', 'tenant-a', 'no-reply@site.test'],
    ['an empty name without a site or sender', '', '', ''],
  ])('shows %s', (_case, from, siteId, name) => {
    expect(loginMailFrom({ from, siteId }, 'no-reply@site.test')).toEqual({ name, address: 'no-reply@site.test' });
  });
});

describe('applyLoginMail', () => {
  it('stores the mail queued and sends it as sendText after commit', async () => {
    const envelope = loginMailEvent();

    await consume(world, envelope);

    expect(world.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A.tenantId }),
      {
        messageId: MESSAGE_ID,
        siteId: TENANT_A.siteId,
        toAddress: PAYLOAD.to,
        fromAddress: 'Masa CMS',
        subject: 'Your login information',
        bodyText: PAYLOAD.text,
        bodyHtml: '',
        state: 'queued',
        source: 'login-mail',
        eventId: envelope.eventId,
      },
      CONSUMER_CONTEXT,
    );
    expect(world.sent).toStrictEqual([
      {
        to: 'ann@example.com, bob@example.org',
        from: { name: 'Masa CMS', address: 'no-reply@tenant-a.example.test' },
        subject: 'Your login information',
        text: 'Dear Ann,\n\nYour username is ann. ',
        html: '',
        messageId: MESSAGE_ID,
      },
    ]);
    expect(messageIdHeader(world.sent[0]!.messageId)).toBe(`<${MESSAGE_ID}@opt2.local>`);
    expect(world.stateAtSend).toEqual(['queued']);
    expect(world.fromEmail.mock.calls).toEqual([[TENANT_A.siteId]]);
    expect(world.confirm.mock.calls).toEqual([[MESSAGE_ID]]);
    expect(history(world, TENANT_A.tenantId)).toEqual([
      ['queued', null, null],
      ['sent', null, null],
      ['delivered', null, `MP-${MESSAGE_ID}`],
    ]);
    expect(stored(world, TENANT_A.tenantId)).toMatchObject({
      state: 'delivered',
      sent_at: NOW,
      row_version: '4',
      source: 'login-mail',
      event_id: envelope.eventId,
    });
    expect(outbox(world, TENANT_A.tenantId)).toEqual([
      [MESSAGE_ID, 2, 'queued'],
      [MESSAGE_ID, 3, 'sent'],
      [MESSAGE_ID, 4, 'delivered'],
    ]);
    expectContexts(world, CONSUMER_CONTEXT);
    expect(world.opened).toEqual([TENANT_A.tenantId, TENANT_A.tenantId, TENANT_A.tenantId]);
  });

  it('sends from the global address without a site', async () => {
    await consume(world, loginMailEvent({ siteId: '', from: '' }));

    expect(world.fromEmail.mock.calls).toEqual([['']]);
    expect(world.sent[0]?.from).toEqual({ name: '', address: 'no-reply@localhost' });
    expect(stored(world, TENANT_A.tenantId)).toMatchObject({ siteid: '', from_address: '', state: 'delivered' });
  });

  it('applies the effect once per message id', async () => {
    const first = loginMailEvent();

    await consume(world, first);
    await consume(world, loginMailEvent({}, '5d0c6a1e-8f7b-4e2a-9c3d-2b1a0f9e8d7c'));
    await consume(world, first);

    expect(world.insertMessage).toHaveBeenCalledTimes(1);
    expect(world.sent).toHaveLength(1);
    expect(history(world, TENANT_A.tenantId).map(([state]) => state)).toEqual(['queued', 'sent', 'delivered']);
    expect(stored(world, TENANT_A.tenantId)?.event_id).toBe(first.eventId);
  });

  it('stores and sends nothing on rollback', async () => {
    const failure = new Error('inbox receipt failed');

    await expect(consume(world, loginMailEvent(), () => Promise.reject(failure))).rejects.toBe(failure);

    expect(world.committed.get(TENANT_A.tenantId)).toBeUndefined();
    expect(world.send).not.toHaveBeenCalled();
    expect(world.fromEmail).not.toHaveBeenCalled();
  });

  it('leaves the mail queued when delivery after commit fails', async () => {
    const envelope = loginMailEvent();
    world.fromEmail.mockRejectedValueOnce(new Error('registry unavailable'));

    await consume(world, envelope);

    expect(world.send).not.toHaveBeenCalled();
    expect(stored(world, TENANT_A.tenantId)?.state).toBe('queued');
    expect(history(world, TENANT_A.tenantId)).toEqual([['queued', null, null]]);
    expect(world.logs).toHaveLength(1);
    expect(world.logs[0]).toMatchObject({
      severity: 'ERROR',
      tenantId: TENANT_A.tenantId,
      eventId: envelope.eventId,
      message: `login mail ${MESSAGE_ID} stays queued for recovery: delivery after commit failed`,
      error: { type: 'Error' },
    });
  });
});

describe('deliverLoginMail', () => {
  it.each<{
    case: string;
    to?: string;
    sendError?: Error;
    drops?: boolean;
    state: string;
    trail: [string, string | null, string | null][];
    sends: number;
    lookups: number;
    log?: string;
  }>([
    {
      case: 'confirms a mail Mailpit holds as delivered',
      state: 'delivered',
      trail: [
        ['sent', null, null],
        ['delivered', null, `MP-${MESSAGE_ID}`],
      ],
      sends: 1,
      lookups: 1,
    },
    {
      case: 'records failed and sends nothing without a valid recipient',
      to: 'nobody, ann@localhost',
      state: 'failed',
      trail: [['failed', null, null]],
      sends: 0,
      lookups: 0,
    },
    {
      case: 'records smtp-error and never confirms when the send fails',
      sendError: refused(),
      state: 'failed',
      trail: [['failed', 'smtp-error', null]],
      sends: 1,
      lookups: 0,
      log: `The current mail server settings for the site '${TENANT_A.siteId}' are not valid: connect ECONNREFUSED`,
    },
    {
      case: 'records mailpit-not-found when Mailpit lacks the sent mail',
      drops: true,
      state: 'failed',
      trail: [
        ['sent', null, null],
        ['failed', 'mailpit-not-found', null],
      ],
      sends: 1,
      lookups: 1,
    },
  ])('$case', async ({ to, sendError, drops, state, trail, sends, lookups, log }) => {
    const message = seed(world, TENANT_A.tenantId, to === undefined ? {} : { to_address: to });
    world.sendError = sendError ?? null;
    world.mailpitDrops = drops ?? false;

    const result = await deliverLoginMail(world.deps, TENANT_A.tenantId, message);

    expect(result).toEqual(stored(world, TENANT_A.tenantId));
    expect(result.state).toBe(state);
    expect(history(world, TENANT_A.tenantId)).toEqual(trail);
    expect(world.send).toHaveBeenCalledTimes(sends);
    expect(world.confirm).toHaveBeenCalledTimes(lookups);
    expect(logged(world)).toEqual(log === undefined ? [] : [['ERROR', TENANT_A.tenantId, log, 'Error']]);
    expectContexts(world, CONSUMER_CONTEXT);
    expect(new Set(world.opened)).toEqual(new Set([TENANT_A.tenantId]));
  });
});

describe('loginMailRecovery', () => {
  it('reads mail queued over 30 s once per tenant', async () => {
    registry(TENANT_A.tenantId.toUpperCase(), TENANT_A.tenantId, TENANT_B.tenantId);

    await sweep(world);

    expect(registeredTenants).toHaveBeenCalledWith(world.db);
    expect(world.batchReads).toEqual([
      { tenantId: TENANT_A.tenantId, cutoff: new Date(NOW.getTime() - 30_000), batch: {} },
      { tenantId: TENANT_B.tenantId, cutoff: new Date(NOW.getTime() - 30_000), batch: {} },
    ]);
  });

  it('claims, gates, sends and confirms a lost mail', async () => {
    registry(TENANT_A.tenantId);
    seed(world, TENANT_A.tenantId, { from_address: '' });

    await sweep(world);

    expect(awaitReadable).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A.tenantId }), [MESSAGE.unit]);
    expect(acquireWriteGates).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A.tenantId }), [
      MESSAGE.unit,
      DELIVERY_STATUS.unit,
    ]);
    expect(vi.mocked(acquireWriteGates).mock.invocationCallOrder[0]).toBeLessThan(world.confirm.mock.invocationCallOrder[0]!);
    expect(world.confirm.mock.invocationCallOrder[0]).toBeLessThan(world.send.mock.invocationCallOrder[0]!);
    expect(world.sent).toStrictEqual([
      {
        to: 'ann@example.com, bob@example.org',
        from: { name: 'no-reply@tenant-a.example.test', address: 'no-reply@tenant-a.example.test' },
        subject: 'Your login information',
        text: 'Dear Ann,\n\nYour username is ann. ',
        html: '',
        messageId: MESSAGE_ID,
      },
    ]);
    expect(history(world, TENANT_A.tenantId)).toEqual([
      ['sent', null, null],
      ['delivered', null, `MP-${MESSAGE_ID}`],
    ]);
    expect(stored(world, TENANT_A.tenantId)).toMatchObject({ state: 'delivered', sent_at: NOW, row_version: '4' });
    expect(outbox(world, TENANT_A.tenantId)).toEqual([
      [MESSAGE_ID, 3, 'sent'],
      [MESSAGE_ID, 4, 'delivered'],
    ]);
    expectContexts(world, RECOVERY_CONTEXT);
    expect(world.committed.get(TENANT_A.tenantId)?.history.every((row) => row.tenant_id === TENANT_A.tenantId)).toBe(true);
    // One batch read and one claim transaction.
    expect(world.opened).toEqual([TENANT_A.tenantId, TENANT_A.tenantId]);
  });

  it.each<{
    case: string;
    to?: string;
    inMailpit?: boolean;
    sendError?: Error;
    drops?: boolean;
    state: string;
    trail: [string, string | null, string | null][];
    sends: number;
    log?: string;
  }>([
    {
      case: 'records a mail Mailpit already holds without resending',
      inMailpit: true,
      state: 'delivered',
      trail: [
        ['sent', null, null],
        ['delivered', null, 'MP-early'],
      ],
      sends: 0,
    },
    {
      case: 'records mailpit-not-found when the resend never arrives',
      drops: true,
      state: 'failed',
      trail: [
        ['sent', null, null],
        ['failed', 'mailpit-not-found', null],
      ],
      sends: 1,
    },
    {
      case: 'records failed without a valid recipient',
      to: 'nobody',
      state: 'failed',
      trail: [['failed', null, null]],
      sends: 0,
    },
    {
      case: 'records smtp-error and logs when the resend fails',
      sendError: refused(),
      state: 'failed',
      trail: [['failed', 'smtp-error', null]],
      sends: 1,
      log: `login mail ${MESSAGE_ID}: recovery send failed`,
    },
  ])('$case', async ({ to, inMailpit, sendError, drops, state, trail, sends, log }) => {
    registry(TENANT_A.tenantId);
    seed(world, TENANT_A.tenantId, to === undefined ? {} : { to_address: to });
    if (inMailpit === true) {
      world.mailpit.set(MESSAGE_ID, 'MP-early');
    }
    world.sendError = sendError ?? null;
    world.mailpitDrops = drops ?? false;

    await sweep(world);

    expect(stored(world, TENANT_A.tenantId)?.state).toBe(state);
    expect(history(world, TENANT_A.tenantId)).toEqual(trail);
    expect(world.send).toHaveBeenCalledTimes(sends);
    expect(world.fromEmail).toHaveBeenCalledTimes(inMailpit === true ? 0 : 1);
    expect(logged(world)).toEqual(log === undefined ? [] : [['ERROR', TENANT_A.tenantId, log, 'Error']]);
  });

  it.each<[string, (w: World, row: MessageRow) => void]>([
    ['held by another transaction', (w) => void w.locked.add(MESSAGE_ID)],
    ['no longer queued', (w, row) => void w.committed.get(TENANT_A.tenantId)?.messages.set(MESSAGE_ID, { ...row, state: 'sent' })],
    ['gone', (w) => void w.committed.get(TENANT_A.tenantId)?.messages.delete(MESSAGE_ID)],
  ])('leaves a mail %s untouched', async (_case, change) => {
    registry(TENANT_A.tenantId);
    const row = seed(world, TENANT_A.tenantId);
    vi.mocked(queuedLoginMailOlderThan).mockResolvedValueOnce([row]);
    change(world, row);

    await sweep(world);

    expect(acquireWriteGates).not.toHaveBeenCalled();
    expect(world.confirm).not.toHaveBeenCalled();
    expect(world.send).not.toHaveBeenCalled();
    expect(history(world, TENANT_A.tenantId)).toEqual([]);
  });

  it('pages through the tenant by message cursor', async () => {
    registry(TENANT_A.tenantId);
    const rows = Array.from({ length: RECOVERY_BATCH_SIZE + 50 }, (_, i) => seed(world, TENANT_A.tenantId, { message_id: cfId(i) }));

    await sweep(world);

    expect(world.batchReads.map((read) => read.batch)).toEqual([{}, { after: messageCursor(rows[RECOVERY_BATCH_SIZE - 1]!) }]);
    expect(world.sent).toHaveLength(RECOVERY_BATCH_SIZE + 50);
    expect(rows.every((row) => stored(world, TENANT_A.tenantId, row.message_id)?.state === 'delivered')).toBe(true);
  });

  it('logs a failing mail and recovers the rest', async () => {
    registry(TENANT_A.tenantId);
    seed(world, TENANT_A.tenantId, { message_id: cfId(1) });
    seed(world, TENANT_A.tenantId, { message_id: cfId(2) });
    world.fromEmail.mockRejectedValueOnce(new Error('registry unavailable'));

    await sweep(world);

    expect(stored(world, TENANT_A.tenantId, cfId(1))?.state).toBe('queued');
    expect(history(world, TENANT_A.tenantId, cfId(1))).toEqual([]);
    expect(stored(world, TENANT_A.tenantId, cfId(2))?.state).toBe('delivered');
    expect(logged(world)).toEqual([['ERROR', TENANT_A.tenantId, `login mail ${cfId(1)}: recovery failed`, 'Error']]);
  });

  it('re-runs a claim after a gate race and sends once', async () => {
    registry(TENANT_A.tenantId);
    seed(world, TENANT_A.tenantId);
    vi.mocked(acquireWriteGates).mockRejectedValueOnce(new GateRaceError([MESSAGE.unit]));

    await sweep(world);

    expect(world.rolledBack).toBe(1);
    expect(world.send).toHaveBeenCalledTimes(1);
    expect(history(world, TENANT_A.tenantId).map(([state]) => state)).toEqual(['sent', 'delivered']);
  });

  it('ends a tenant at a gate error and recovers the next', async () => {
    registry(TENANT_A.tenantId, TENANT_B.tenantId);
    seed(world, TENANT_A.tenantId, { message_id: cfId(1) });
    seed(world, TENANT_A.tenantId, { message_id: cfId(2) });
    seed(world, TENANT_B.tenantId, { message_id: cfId(3), siteid: TENANT_B.siteId });
    vi.mocked(acquireWriteGates).mockImplementation((tx) =>
      tx.tenantId === TENANT_A.tenantId ? Promise.reject(new GateClosedError([MESSAGE.unit])) : Promise.resolve(),
    );

    await sweep(world);

    expect(vi.mocked(awaitReadable).mock.calls.map(([tx]) => tx.kind === 'tenant' && tx.tenantId)).toEqual([
      TENANT_A.tenantId,
      TENANT_B.tenantId,
    ]);
    expect(stored(world, TENANT_A.tenantId, cfId(1))?.state).toBe('queued');
    expect(stored(world, TENANT_A.tenantId, cfId(2))?.state).toBe('queued');
    expect(stored(world, TENANT_B.tenantId, cfId(3))).toMatchObject({ state: 'delivered', tenant_id: TENANT_B.tenantId });
    expect(world.sent.map((mail) => mail.from.address)).toEqual([`no-reply@${TENANT_B.siteId}.example.test`]);
    expect(logged(world)).toEqual([['WARNING', TENANT_A.tenantId, 'login mail recovery skipped the tenant for this sweep: unit gate', 'GateClosedError']]);
  });

  it.each([
    ['GateClosedError', () => new GateClosedError([MESSAGE.unit])],
    ['GateRaceError', () => new GateRaceError([MESSAGE.unit])],
    ['UnitNotAuthoritativeError', () => new UnitNotAuthoritativeError([MESSAGE.unit])],
    ['UnitReadBlockedError', () => new UnitReadBlockedError([MESSAGE.unit])],
    ['OperationBlockedError', () => new OperationBlockedError([MESSAGE.unit])],
  ])('skips a tenant whose batch read throws %s', async (type, gateError) => {
    registry(TENANT_A.tenantId, TENANT_B.tenantId);
    seed(world, TENANT_B.tenantId, { siteid: TENANT_B.siteId });
    vi.mocked(queuedLoginMailOlderThan).mockRejectedValueOnce(gateError());

    await sweep(world);

    expect(stored(world, TENANT_B.tenantId)?.state).toBe('delivered');
    expect(logged(world)).toEqual([['WARNING', TENANT_A.tenantId, 'login mail recovery skipped the tenant for this sweep: unit gate', type]]);
  });

  it('rethrows any other tenant error', async () => {
    registry(TENANT_A.tenantId, TENANT_B.tenantId);
    const failure = new Error('connection terminated');
    vi.mocked(queuedLoginMailOlderThan).mockRejectedValueOnce(failure);

    await expect(sweep(world)).rejects.toBe(failure);

    expect(world.batchReads).toEqual([]);
    expect(world.opened).toEqual([TENANT_A.tenantId]);
    expect(world.logs).toEqual([]);
  });
});
