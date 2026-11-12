// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Message domain as the fixture communications.cfc answers POST and GET messages: composition, checks, history, views and paging. */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { createOutbox, resetOutboxRuntimes } from '@opt2/platform/outbox';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createCapturingPublisher, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import type { MailDeps } from '../../src/domain/delivery.js';
import type { OutgoingMail } from '../../src/domain/mail-transport.js';
import {
  DEFAULT_FROM_ADDRESS,
  confirmMessage,
  createMessage,
  getMessage,
  listMessages,
  outgoingMailFor,
  sendMessage,
  submitMessage,
  type MessageInput,
} from '../../src/domain/messages.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import { UNITS, type MessageRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const USER_ID = 'AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000';
const TO = 'ann@example.com';
const LITERAL: MessageInput = { to: TO, subject: 'Hello', bodyText: 'Body' };
const MESSAGE_KEYS = [
  'message_id',
  'siteid',
  'template_id',
  'to_address',
  'from_address',
  'subject',
  'body_text',
  'body_html',
  'state',
  'created',
  'sent_at',
];

const available = await pgAvailable();

describe.skipIf(!available)('message domain against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let sites = 0;
  let siteId: string;
  let tenantId: string;
  let sent: OutgoingMail[];
  let sendError: Error | null;
  let mailpitId: string | null;
  let lookups: string[];
  let logLines: Array<Record<string, unknown>>;
  let deps: MailDeps;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`),
    );
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    const clock = fixedClock(NOW);
    const logger = createLogger({
      service: 'communications',
      version: '1.0.0',
      env: 'local',
      destination: { write: (line: string) => void logLines.push(JSON.parse(line) as Record<string, unknown>) },
    });
    createOutbox({ service: 'communications', db: handle.app, publisher: createCapturingPublisher(), logger, clock });
    sites += 1;
    siteId = `communications-messages-${sites}`;
    tenantId = tenantIdForSite(siteId);
    sent = [];
    sendError = null;
    mailpitId = 'MAILPIT-1';
    lookups = [];
    logLines = [];
    deps = {
      db: handle.app,
      repository: createCommunicationsRepository({ clock, schema: handle.schema }),
      clock,
      logger,
      transport: {
        send: (mail) => {
          if (sendError !== null) return Promise.reject(sendError);
          sent.push(mail);
          return Promise.resolve({ accepted: [mail.to] });
        },
        close: () => Promise.resolve(),
      },
      deliveryStatus: {
        confirm: (id) => {
          lookups.push(id);
          return Promise.resolve(mailpitId);
        },
      },
      senderAddress: { fromEmail: () => Promise.reject(new Error('fixture sends never read the site sender')) },
    };
  });

  afterEach(() => {
    resetOutboxRuntimes();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(tenantId, fn);
  }

  function submit(input: MessageInput) {
    return submitMessage(deps, { tenantId, siteId, userId: USER_ID, input });
  }

  function newTemplate(subject: string, bodyText: string, bodyHtml = ''): Promise<string> {
    return inTenant(async (tx) => (await deps.repository.insertTemplate(tx, { siteId, name: 'T', subject, bodyText, bodyHtml })).template_id);
  }

  function outboxStates(): Promise<Array<string | undefined>> {
    return inTenant(async (tx) => {
      const { rows } = await tx.query<{ state: string | undefined }>(
        `SELECT envelope->'payload'->>'state' AS state FROM ${handle.schema}.outbox ORDER BY seq`,
      );
      return rows.map((row) => row.state);
    });
  }

  function storedRow(messageId: string): Promise<MessageRow> {
    return inTenant(async (tx) => {
      const { rows } = await tx.query<MessageRow>(`SELECT * FROM ${handle.schema}.message WHERE message_id = $1`, [messageId]);
      return rows[0] as MessageRow;
    });
  }

  it('queues, sends and confirms literal content, answering the fixture detail', async () => {
    const detail = await submit(LITERAL);

    expect(Object.keys(detail)).toEqual([...MESSAGE_KEYS, 'history']);
    expect(detail).toMatchObject({
      siteid: siteId,
      template_id: '',
      to_address: TO,
      from_address: DEFAULT_FROM_ADDRESS,
      body_html: '',
      state: 'delivered',
      created: '2026-06-30T14:05:09',
      sent_at: '2026-06-30T14:05:09',
    });
    expect(Object.keys(detail.history[0] ?? {})).toEqual(['status_id', 'message_id', 'status', 'detail', 'mailpit_id', 'recorded_at']);
    expect(detail.history.map((row) => [row.status, row.detail, row.mailpit_id])).toEqual([
      ['queued', '', ''],
      ['sent', '', ''],
      ['delivered', '', 'MAILPIT-1'],
    ]);
    expect(sent).toEqual([
      { to: TO, from: { name: '', address: DEFAULT_FROM_ADDRESS }, subject: 'Hello', text: 'Body', html: '', messageId: detail.message_id },
    ]);
    expect(lookups).toEqual([detail.message_id]);
    expect(await outboxStates()).toEqual(['queued', 'sent', 'delivered']);
    expect(await storedRow(detail.message_id)).toMatchObject({ source: 'send', row_version: '4', tenant_id: tenantId });
  });

  it('stores createMessage queued with its queued history row and sends nothing', async () => {
    const row = await createMessage(deps, { tenantId, siteId, userId: USER_ID, input: LITERAL });

    expect(row).toMatchObject({ state: 'queued', source: 'send', template_id: null, row_version: '2' });
    expect(sent).toEqual([]);
    expect((await inTenant((tx) => getMessage(tx, row.message_id))).history.map((h) => h.status)).toEqual(['queued']);
  });

  it('fills a template case-sensitively in one pass and keeps the template id', async () => {
    const templateId = await newTemplate('Hi {{name}} {{Name}}', 'x {{missing}} {{name}}', '<b>{{name}}</b>');

    const fromJson = await submit({ templateId, to: TO, VARIABLES: '{"name":"{{name}}"}', from: 'me@example.org' });
    const fromObject = await submit({ templateId, to: TO, variables: { name: true } });
    const withoutVariables = await submit({ templateId, to: TO, variables: null });

    expect(fromJson).toMatchObject({
      template_id: templateId,
      subject: 'Hi {{name}} {{Name}}',
      body_text: 'x {{missing}} {{name}}',
      body_html: '<b>{{name}}</b>',
      from_address: 'me@example.org',
    });
    expect(fromObject).toMatchObject({ subject: 'Hi YES {{Name}}', body_text: 'x {{missing}} YES' });
    expect(withoutVariables).toMatchObject({ subject: 'Hi {{name}} {{Name}}', body_text: 'x {{missing}} {{name}}' });
  });

  it.each<[string, unknown]>([
    [
      'an object',
      {
        name: 'Ann',
        flag: true,
        off: false,
        n: 10,
        f: 1.5,
        big: 1e20,
        third: 0.3333333333333333,
        neg: -0.5,
        s: 'true',
        whole: 3,
        tiny: 0.00001,
        wide: 1234567.891234567,
        huge: 1.2345678901234567e19,
      },
    ],
    [
      'a JSON string',
      '{"name":"Ann","flag":true,"off":false,"n":10,"f":1.50,"big":1e20,"third":0.3333333333333333,"neg":-0.5,"s":"true",' +
        '"whole":3.0,"tiny":0.00001,"wide":1234567.891234567,"huge":12345678901234567890}',
    ],
  ])('fills simple values from %s as CFML toString renders them', async (_case, variables) => {
    const template = 'Hi {{name}} flag={{flag}} off={{off}} n={{n}} f={{f}} big={{big}} third={{third}} neg={{neg}} s={{s}} {{Name}} {{missing}}';
    const filled = 'Hi Ann flag=YES off=NO n=10 f=1.5 big=1E+020 third=0.333333333333 neg=-0.5 s=true {{Name}} {{missing}}';
    const templateId = await newTemplate(template, template, '<p>{{whole}} {{tiny}} {{wide}} {{huge}}</p>');

    const detail = await submit({ templateId, to: TO, variables });

    expect(detail).toMatchObject({ subject: filled, body_text: filled, body_html: '<p>3 1E-005 1234567.89123 1.23456789012E+019</p>' });
    expect(sent.map((mail) => [mail.subject, mail.text])).toEqual([[filled, filled]]);
  });

  it('answers notFound for an unknown template before reading variables, storing nothing', async () => {
    const error = await submit({ templateId: 'NO-SUCH-TEMPLATE', to: TO, variables: '[1]' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FixtureApiError);
    expect(error).toMatchObject({ type: 'notFound', messageOverride: undefined });
    expect((await inTenant((tx) => listMessages(tx, { siteId }))).totalItems).toBe(0);
  });

  it.each<[string, MessageInput]>([
    ['an invalid recipient', { ...LITERAL, to: 'ann' }],
    ['a complex recipient, before the template lookup', { templateId: 'NO-SUCH-TEMPLATE', to: [TO] }],
    ['an invalid sender', { ...LITERAL, from: 'Ann <ann@example.com>' }],
    ['a blank subject', { ...LITERAL, subject: ' \t' }],
    ['no body', { to: TO, subject: 'Hello', bodyText: '', bodyHtml: '' }],
    ['a subject over 255 characters', { ...LITERAL, subject: 'x'.repeat(256) }],
    ['a recipient over 255 characters', { ...LITERAL, to: `${'a'.repeat(244)}@example.com` }],
  ])('answers invalidParameters for %s', async (_case, input) => {
    const error = await submit(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).not.toBeInstanceOf(FixtureApiError);
    expect(error).toMatchObject({ type: 'invalidParameters' });
    expect(sent).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['an array', '[1]'],
    ['a null value', '{"name":null}'],
    ['a nested value', { name: { first: 'Ann' } }],
    ['text that is not JSON', 'name=Ann'],
    ['a JSON scalar', '5'],
  ])('answers invalidParameters for variables holding %s', async (_case, variables) => {
    const templateId = await newTemplate('Hi', 'Body');

    await expect(submit({ templateId, to: TO, variables })).rejects.toMatchObject({ type: 'invalidParameters' });
  });

  it('answers invalidParameters when the filled template subject exceeds 255 characters', async () => {
    const templateId = await newTemplate('{{long}}', 'Body');

    await expect(submit({ templateId, to: TO, variables: { long: 'y'.repeat(256) } })).rejects.toMatchObject({ type: 'invalidParameters' });
  });

  it('records failed smtp-error on a transport error, logs it, never throws and never confirms', async () => {
    sendError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1025'), { code: 'ECONNREFUSED', syscall: 'connect' });

    const detail = await submit(LITERAL);

    expect(detail).toMatchObject({ state: 'failed', sent_at: '' });
    expect(detail.history.map((row) => [row.status, row.detail])).toEqual([
      ['queued', ''],
      ['failed', 'smtp-error'],
    ]);
    expect(lookups).toEqual([]);
    expect(await outboxStates()).toEqual(['queued', 'failed']);
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatchObject({
      severity: 'ERROR',
      tenantId,
      message: `The current mail server settings for the site '${siteId}' are not valid: connect ECONNREFUSED`,
      error: { type: 'Error', message: 'connect ECONNREFUSED' },
    });
  });

  it('records failed mailpit-not-found when Mailpit never shows the sent message', async () => {
    mailpitId = null;

    const detail = await submit({ to: TO, subject: 'Hello', bodyHtml: '<p>Body</p>' });

    expect(detail.state).toBe('failed');
    expect(detail.sent_at).toBe('2026-06-30T14:05:09');
    expect(detail.history.map((row) => [row.status, row.detail])).toEqual([
      ['queued', ''],
      ['sent', ''],
      ['failed', 'mailpit-not-found'],
    ]);
    expect(sent[0]).toMatchObject({ text: '', html: '<p>Body</p>' });
  });

  it('sends and confirms a stored row through outgoingMailFor, logging the settings.ini line without a site', async () => {
    const row = await createMessage(deps, { tenantId, siteId, userId: USER_ID, input: LITERAL });
    const mail = outgoingMailFor(row, { name: 'Ann', address: 'no-reply@example.com' });

    expect(mail).toEqual({ to: TO, from: { name: 'Ann', address: 'no-reply@example.com' }, subject: 'Hello', text: 'Body', html: '', messageId: row.message_id });
    const sentRow = await sendMessage(deps, { tenantId, message: row, mail });
    // Under a fixed clock each status is recorded 10 ms after the previous one, as the fixture's nextInstant spaces them.
    expect(sentRow).toMatchObject({ state: 'sent', sent_at: new Date(NOW.getTime() + 10) });
    expect(await confirmMessage(deps, { tenantId, message: sentRow })).toMatchObject({ state: 'delivered' });

    sendError = new Error('boom');
    expect(await sendMessage(deps, { tenantId, message: { ...row, siteid: '' }, mail })).toMatchObject({ state: 'failed' });
    expect(logLines.at(-1)?.message).toBe('The current mail server settings in the settings.ini are not valid: [REDACTED]');
  });

  it('answers notFound for an unknown message id', async () => {
    await expect(inTenant((tx) => getMessage(tx, 'NO-SUCH-MESSAGE'))).rejects.toMatchObject({ type: 'notFound' });
  });

  it('lists one page of the site messages with envelope.cfc paging', async () => {
    for (const subject of ['One', 'Two', 'Three']) {
      await submit({ ...LITERAL, subject });
    }

    const page = await inTenant((tx) => listMessages(tx, { siteId, pageIndex: '2', ITEMSPERPAGE: 2 }));
    const otherSite = await inTenant((tx) => listMessages(tx, { siteId: 'another-site' }));

    expect(page).toMatchObject({ pageIndex: 2, itemsPerPage: 2, totalItems: 3 });
    expect(page.list).toHaveLength(1);
    expect(Object.keys(page.list[0] ?? {})).toEqual(MESSAGE_KEYS);
    expect(otherSite).toMatchObject({ list: [], totalItems: 0, pageIndex: 1, itemsPerPage: 50 });
    await expect(inTenant((tx) => listMessages(tx, { siteId, itemsPerPage: '1001' }))).rejects.toMatchObject({ type: 'invalidParameters' });
  });
});
