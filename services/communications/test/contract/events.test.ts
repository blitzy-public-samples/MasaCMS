// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Producer contract of `communications.message.delivery-status-changed.v1`: the schema's declarations and the envelopes real sends publish. */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileTopicSchema, eventTypeOf, schemaVersionOf, topicMeta } from '@opt2/platform/events';
import {
  ContractAssertionError,
  TENANT_A,
  assertEventMatches,
  pushTo,
  withoutTenant,
  type PublishedEvent,
} from '@opt2/platform/testing';
import { LOGIN_MAIL_SUBSCRIPTION } from '../../src/events/consumers.js';
import {
  DELIVERY_STATUS_AGGREGATE_TYPE,
  DELIVERY_STATUS_CHANGED_TOPIC,
  DELIVERY_STATUS_KIND,
  deliveryStatusChangedSchema,
} from '../../src/events/delivery-status-changed.js';
import { LOGIN_MAIL_TOPIC } from '../../src/events/login-mail.js';
import { MESSAGE } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { SAMPLE_IDS, envelopeFor, loginMailPayload } from '../helpers/payloads.js';

/** The root keywords of the payload schema file this suite reads. */
interface TopicSchemaFile {
  $comment: string;
  'x-opt2-kind'?: unknown;
  'x-opt2-supersedes'?: unknown;
  additionalProperties?: unknown;
  required?: string[];
  properties?: Record<string, unknown>;
}

/** The payload communications builds for the topic, as read back from a captured envelope. */
interface DeliveryStatusPayload {
  messageId: string;
  siteId: string;
  source: 'send' | 'login-mail';
  state: 'queued' | 'sent' | 'delivered' | 'failed';
  mailpitId: string | null;
  statusId: string;
  changedAt: string;
}

/** One delivery-history row of a message detail answer. */
interface HistoryEntry {
  status_id: string;
  status: string;
  mailpit_id: string;
}

type CapturedEnvelope = PublishedEvent['envelope'];

/** A send's answered message id and history, with the envelopes it published. */
interface SendResult {
  messageId: string;
  history: HistoryEntry[];
  envelopes: CapturedEnvelope[];
}

async function readJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')) as T;
}

const schema = await readJson<TopicSchemaFile>('../../contracts/events/communications.message.delivery-status-changed.v1.json');
const envelopeSchema = await readJson<object>('../../../../platform/contracts/event-envelope.v1.json');
const pin = await readJson<{ sha: string }>('../../../../opt2/source-pin.json');

const PAYLOAD_FIELDS = ['messageId', 'siteId', 'source', 'state', 'mailpitId', 'statusId', 'changedAt'] as const;
const SITE = TENANT_A.siteId;
const SENDER = 'communications.sender';
const V1_MESSAGES = '/v1/messages';
const FIXTURE_MESSAGES = `${FIXTURE_PREFIX}/messages`;
const LITERAL = { to: 'member1@tenant-a.example', subject: 'Contract subject', bodyText: 'Contract body' };
// The test app's identity double consumes any CSRF pair, so the sends reach the handler.
const CSRF_HEADERS = { 'x-csrf_token': 'CONTRACT-TOKEN', 'x-csrf_token_expires': '260630120000000' } as const;

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();
const payloadOf = (envelope: CapturedEnvelope): DeliveryStatusPayload => envelope.payload as DeliveryStatusPayload;

/** The ContractAssertionError `run` throws; fails the test when it throws nothing or something else. */
function contractErrorOf(run: () => unknown): ContractAssertionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractAssertionError);
    return error as ContractAssertionError;
  }
  throw new Error('expected a ContractAssertionError, but nothing was thrown');
}

/** A copy of `envelope` whose payload `edit` changed. */
function withPayload(envelope: CapturedEnvelope, edit: (payload: Record<string, unknown>) => void): CapturedEnvelope {
  const payload = structuredClone(envelope.payload) as Record<string, unknown>;
  edit(payload);
  return { ...envelope, payload };
}

describe('communications.message.delivery-status-changed.v1 payload schema', () => {
  it('is a state topic applied in the envelope tenant only', () => {
    expect(schema['x-opt2-kind']).toBe('state');
    expect(DELIVERY_STATUS_KIND).toBe('state');
    expect('x-opt2-tenant-fanout' in schema).toBe(false);
    expect(schema['x-opt2-supersedes'] ?? false).toBe(false);
  });

  it('compiles with the platform validator as a non-superseding state topic', () => {
    const { meta } = compileTopicSchema(schema);
    expect(meta).toStrictEqual(topicMeta(schema));
    expect(meta.kind).toBe('state');
    expect(meta.fanout).toBeUndefined();
    expect(meta.supersedes).toBeFalsy();
  });

  it('names the topic, its event type and version, and the message aggregate', () => {
    expect(DELIVERY_STATUS_CHANGED_TOPIC).toBe('communications.message.delivery-status-changed.v1');
    expect(eventTypeOf(DELIVERY_STATUS_CHANGED_TOPIC)).toBe('communications.message.delivery-status-changed');
    expect(schemaVersionOf(DELIVERY_STATUS_CHANGED_TOPIC)).toBe('1.0.0');
    expect(DELIVERY_STATUS_AGGREGATE_TYPE).toBe('message');
  });

  it('records the pinned source SHA', () => {
    expect(schema.$comment).toBe(`source-sha: ${pin.sha}`);
  });

  it('is the file the producer validates its outbox rows against', () => {
    expect(deliveryStatusChangedSchema).toStrictEqual(schema);
  });

  it('declares and requires exactly the payload fields, and no others', () => {
    expect(sorted(Object.keys(schema.properties ?? {}))).toStrictEqual(sorted(PAYLOAD_FIELDS));
    expect(sorted(schema.required ?? [])).toStrictEqual(sorted(PAYLOAD_FIELDS));
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('communications.message.delivery-status-changed.v1 envelopes captured from real sends', () => {
  let t: TestApp;
  let delivered: SendResult;
  let viaFixture: SendResult;
  let failed: SendResult;
  let loginMail: CapturedEnvelope[];

  const published = (): CapturedEnvelope[] =>
    t.publisher.published.filter(({ topic }) => topic === DELIVERY_STATUS_CHANGED_TOPIC).map(({ envelope }) => envelope);

  /** Sends literal content to `path` and returns the answered detail with the envelopes the send published. */
  async function send(path: string): Promise<SendResult> {
    const before = published().length;
    const headers = { ...(await headersFor(SENDER, { site: SITE })), ...CSRF_HEADERS };
    const res = await t.app.inject({ method: 'POST', url: `${path}?siteid=${SITE}`, headers, payload: LITERAL });
    expect(res.statusCode, res.body).toBe(200);
    const { data } = res.json() as { data: { message_id: string; history: HistoryEntry[] } };
    return { messageId: data.message_id, history: data.history, envelopes: published().slice(before) };
  }

  beforeAll(async () => {
    t = await buildTestApp();
    delivered = await send(V1_MESSAGES);
    viaFixture = await send(FIXTURE_MESSAGES);
    t.mail.fail(new Error('connection refused'));
    failed = await send(V1_MESSAGES);
    t.mail.fail(null);
    const before = published().length;
    const res = await pushTo(t.app, LOGIN_MAIL_SUBSCRIPTION, envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload()));
    expect(res.statusCode, res.body).toBe(204);
    loginMail = published().slice(before);
  });

  afterAll(async () => {
    await t?.app.close();
  });

  const everyEnvelope = (): CapturedEnvelope[] => [...delivered.envelopes, ...viaFixture.envelopes, ...failed.envelopes, ...loginMail];

  /** Each captured message id with the envelopes published for it, in publish order. */
  const byMessage = (): (readonly [string, CapturedEnvelope[]])[] => [
    [delivered.messageId, delivered.envelopes],
    [viaFixture.messageId, viaFixture.envelopes],
    [failed.messageId, failed.envelopes],
    [SAMPLE_IDS.messageId, loginMail],
  ];

  it('publishes one envelope per delivery-status row, in the order of the message history', () => {
    for (const sent of [delivered, viaFixture]) {
      expect(sent.envelopes.map((envelope) => payloadOf(envelope).state)).toStrictEqual(['queued', 'sent', 'delivered']);
      expect(sent.envelopes.map((envelope) => payloadOf(envelope).statusId)).toStrictEqual(sent.history.map((row) => row.status_id));
    }
    expect(failed.envelopes.map((envelope) => payloadOf(envelope).state)).toStrictEqual(['queued', 'failed']);
    expect(loginMail.map((envelope) => payloadOf(envelope).state)).toStrictEqual(['queued', 'sent', 'delivered']);
  });

  it('captured envelopes validate against envelope and topic schema', () => {
    for (const envelope of everyEnvelope()) {
      expect(() => assertEventMatches(envelopeSchema, schema, envelope), `${payloadOf(envelope).messageId} ${payloadOf(envelope).state}`).not.toThrow();
      expect(() => assertEventMatches(undefined, schema, envelope)).not.toThrow();
    }
  });

  it("ends each message's version sequence at its stored row_version", () => {
    // int8 arrives as a decimal string, as pg returns it.
    const stored = new Map(t.db.rows(MESSAGE.table).map((row) => [row.message_id, Number(row.row_version)]));
    for (const [messageId, envelopes] of byMessage()) {
      expect(envelopes.at(-1)?.aggregateVersion, messageId).toBe(stored.get(messageId));
    }
  });

  it("names the message aggregate in the sender's tenant, its version rising with every status", () => {
    for (const [messageId, envelopes] of byMessage()) {
      for (const envelope of envelopes) {
        expect(envelope, messageId).toMatchObject({
          eventType: 'communications.message.delivery-status-changed',
          schemaVersion: '1.0.0',
          aggregateType: DELIVERY_STATUS_AGGREGATE_TYPE,
          aggregateId: messageId,
          tenantId: TENANT_A.tenantId,
          producer: 'communications',
        });
        expect(payloadOf(envelope).messageId).toBe(envelope.aggregateId);
      }
      const versions = envelopes.map((envelope) => envelope.aggregateVersion);
      expect(versions, messageId).toStrictEqual([...versions].sort((a, b) => a - b));
      expect(new Set(versions).size, messageId).toBe(versions.length);
    }
  });

  it('carries the source and site of each send, and the Mailpit id only once the message is found', () => {
    for (const sent of [delivered, viaFixture]) {
      expect(sent.envelopes.map(payloadOf).map(({ source, siteId }) => ({ source, siteId }))).toStrictEqual(
        sent.envelopes.map(() => ({ source: 'send', siteId: SITE })),
      );
      expect(sent.envelopes.map((envelope) => payloadOf(envelope).mailpitId)).toStrictEqual([null, null, sent.history[2]?.mailpit_id]);
    }
    expect(loginMail.map((envelope) => payloadOf(envelope).source)).toStrictEqual(['login-mail', 'login-mail', 'login-mail']);
    expect(failed.envelopes.map((envelope) => payloadOf(envelope).mailpitId)).toStrictEqual([null, null]);
  });

  it('requires every field the producer builds', () => {
    for (const envelope of everyEnvelope()) {
      expect(sorted(Object.keys(payloadOf(envelope)))).toStrictEqual(sorted(schema.required ?? []));
    }
  });

  it('an envelope without tenant fails validation', () => {
    const error = contractErrorOf(() => assertEventMatches(envelopeSchema, schema, withoutTenant(delivered.envelopes[0] as CapturedEnvelope)));
    expect(error.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining("'tenantId'") }));
  });

  it.each(PAYLOAD_FIELDS)('a payload without %s fails validation', (field) => {
    const envelope = withPayload(delivered.envelopes[0] as CapturedEnvelope, (payload) => {
      delete payload[field];
    });
    const error = contractErrorOf(() => assertEventMatches(envelopeSchema, schema, envelope));
    expect(error.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining(`'${field}'`) }));
  });

  it.each<[string, (payload: Record<string, unknown>) => void]>([
    ['an unknown state', (payload) => void (payload.state = 'bounced')],
    ['an unknown source', (payload) => void (payload.source = 'mailing-list')],
    ['a changedAt with an offset', (payload) => void (payload.changedAt = '2026-06-30T12:00:00.000Z')],
    ['an extra field', (payload) => void (payload.tenantId = TENANT_A.tenantId)],
  ])('a payload with %s fails validation', (_label, edit) => {
    contractErrorOf(() => assertEventMatches(envelopeSchema, schema, withPayload(delivered.envelopes[0] as CapturedEnvelope, edit)));
  });
});
