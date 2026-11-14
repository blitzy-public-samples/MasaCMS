// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of reporting on `programs-sites.site.changed.v1`, the only feed of `reporting.tenant_registry`. */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, dlqTopicName, subscriptionName, topicMeta } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantIdForSite, type SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  assertEventMatches,
  assertProducerConsumerCompatible,
  pushTo,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type ConsumerExpectation,
  type JsonType,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION, consumers, siteChangedSchema } from '../../src/events/consumers.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';

type Json = Record<string, unknown>;

const producerSchema = JSON.parse(
  await readFile(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as Json;
const pin = JSON.parse(await readFile(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const required = [
  'siteId',
  'publicUserPoolId',
  'privateUserPoolId',
  'categoryPoolId',
  'filePoolId',
  'displayPoolId',
  'contentPoolIds',
  'domains',
] as const satisfies readonly (keyof SiteChangedPayload)[];

/** The JSON type the registry consumer relies on for each SiteChangedPayload field. */
const types = {
  siteId: 'string',
  publicUserPoolId: 'string',
  privateUserPoolId: 'string',
  categoryPoolId: 'string',
  filePoolId: 'string',
  displayPoolId: 'string',
  contentPoolIds: 'array',
  domains: 'array',
} as const satisfies Record<keyof SiteChangedPayload, JsonType>;

/** The element type the registry consumer relies on in each list field. */
const itemTypes = {
  contentPoolIds: 'string',
  domains: 'string',
} as const satisfies Partial<Record<keyof SiteChangedPayload, JsonType>>;

const expectation: ConsumerExpectation = { required: [...required], types, itemTypes, samples: registryPayloads(), kind: 'state' };

/** A contract-valid envelope of `payload`, in its own site's tenant. */
function envelopeOf(payload: Json & { siteId: string }, aggregateVersion = 1) {
  return testEnvelope({
    topic: SITE_CHANGED_TOPIC,
    tenantId: tenantIdForSite(payload.siteId),
    aggregateId: payload.siteId,
    aggregateVersion,
    payload,
  });
}

const envelopes = registryPayloads().map((sample) => [sample.siteId, envelopeOf({ ...sample })] as const);

const [firstSample] = registryPayloads();
if (firstSample === undefined) throw new TypeError('registryPayloads returned no fixture site');
const { domains: _domains, ...withoutDomains } = firstSample;

/** Payloads the producer schema refuses: a required field missing, and an undeclared property naming the tenant. */
const offSchemaPayloads: ReadonlyArray<readonly [string, Json & { siteId: string }]> = [
  ['without domains', withoutDomains],
  ['with an undeclared tenantId property', { ...firstSample, tenantId: tenantIdForSite(firstSample.siteId) }],
];

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

describe('programs-sites.site.changed.v1 producer schema', () => {
  it('is a state event without tenant fan-out', () => {
    expect(producerSchema['x-opt2-kind']).toBe('state');
    expect(topicMeta(producerSchema).fanout).toBeUndefined();
  });

  it('records the pinned source SHA', () => {
    expect(producerSchema.$comment).toBe(`source-sha: ${pin.sha}`);
  });

  it('is the schema the reporting consumer validates with', () => {
    expect(siteChangedSchema).toStrictEqual(producerSchema);
  });
});

describe('reporting expectation of programs-sites.site.changed.v1', () => {
  it('is met by the producer schema and the fixture payloads', () => {
    expect(() => assertProducerConsumerCompatible(producerSchema, expectation)).not.toThrow();
  });

  it.each(required)('fails against a producer schema where %s is optional', (field) => {
    const copy = structuredClone(producerSchema);
    // The shared Ajv registry already holds the original schema under its $id.
    delete copy.$id;
    copy.required = (copy.required as string[]).filter((name) => name !== field);

    const error = contractErrorOf(() => assertProducerConsumerCompatible(copy, expectation));

    expect(error.errors).toContainEqual(expect.objectContaining({ instancePath: `/${field}`, keyword: 'required' }));
  });

  it('registers exactly one state consumer, on the site.changed topic', () => {
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.consumer.topic).toBe(SITE_CHANGED_TOPIC);
    expect(consumers[0]?.consumer.kind).toBe('state');
  });

  it('subscribes as reporting.<topic> under the platform naming rule', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe(subscriptionName('reporting', SITE_CHANGED_TOPIC));
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('reporting.programs-sites.site.changed.v1');
  });
});

describe('programs-sites.site.changed.v1 envelopes', () => {
  it.each(envelopes)('accepts the %s envelope with its tenant in the envelope', (siteId, envelope) => {
    const accepted = assertEventMatches(undefined, producerSchema, envelope);

    expect(accepted.tenantId).toBe(tenantIdForSite(siteId));
  });

  it.each(envelopes)('rejects the %s envelope without a tenant', (_siteId, envelope) => {
    const error = contractErrorOf(() => assertEventMatches(undefined, producerSchema, withoutTenant(envelope)));

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath: 'envelope', message: expect.stringContaining("'tenantId'") }),
    );
  });

  it.each(offSchemaPayloads)('rejects a payload %s', (_case, payload) => {
    const error = contractErrorOf(() => assertEventMatches(undefined, producerSchema, envelopeOf(payload)));

    expect(error.errors.map((violation) => violation.instancePath)).toContain('payload');
  });
});

describe('reporting push consumer', () => {
  let handle: TestApp;

  beforeAll(async () => {
    // An empty registry makes each valid delivery an apply rather than a stale ack of the seeded version 1.
    handle = await buildTestApp({ db: 'recording', registry: false });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it.each(envelopes)('acks the %s delivery and records the site in the registry', async (siteId, envelope) => {
    handle.publisher.clear();

    const res = await pushTo(handle.app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect({ status: res.statusCode, raw: handle.publisher.raw.length }).toEqual({ status: 204, raw: 0 });
    expect(handle.db.rows('tenant_registry').find((row) => row.site_id === siteId)).toMatchObject({
      tenant_id: tenantIdForSite(siteId),
    });
  });

  it.each(offSchemaPayloads)('acks a delivery whose payload is %s and dead-letters it as schema-invalid', async (_case, payload) => {
    handle.publisher.clear();
    const before = handle.db.rows('tenant_registry');
    const envelope = envelopeOf(payload, 2);

    const res = await pushTo(handle.app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    expect(handle.publisher.raw).toHaveLength(1);
    const [letter] = handle.publisher.raw;
    expect(letter?.topic).toBe(dlqTopicName(SITE_CHANGED_SUBSCRIPTION));
    expect(letter?.message.attributes[DEAD_LETTER_REASON_ATTRIBUTE]).toBe('schema-invalid');
    expect((JSON.parse(letter?.message.data.toString('utf8') ?? 'null') as Json | null)?.eventId).toBe(envelope.eventId);
    expect(handle.db.rows('tenant_registry')).toStrictEqual(before);
  });
});
