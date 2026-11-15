// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of e-signature on `programs-sites.site.changed.v1`, the topic that fills `esignature.tenant_registry`. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subscriptionName } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantIdForSite, type SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  TENANT_A,
  assertEventMatches,
  assertProducerConsumerCompatible,
  pushTo,
  registryPayloads,
  testEnvelope,
  withoutTenant,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION, consumers } from '../../src/events/consumers.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';

/** The root keywords of the producer schema this suite reads. */
interface ProducerSchema {
  $comment: string;
  'x-opt2-kind': string;
}

const producerSchema = JSON.parse(
  readFileSync(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as ProducerSchema;
const pin = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as {
  sha: string;
};

/** Payload fields the tenant registry consumer reads: the site id and the Masa site pool settings. */
const REQUIRED = [
  'siteId',
  'publicUserPoolId',
  'privateUserPoolId',
  'categoryPoolId',
  'filePoolId',
  'displayPoolId',
  'contentPoolIds',
  'domains',
] as const satisfies readonly (keyof SiteChangedPayload)[];

/** A site event as programs-sites publishes it: the site's own tenant in the envelope, the site as aggregate. */
function envelopeFor(payload: SiteChangedPayload) {
  return testEnvelope({
    topic: SITE_CHANGED_TOPIC,
    tenantId: tenantIdForSite(payload.siteId),
    aggregateId: payload.siteId,
    aggregateVersion: 1,
    payload,
  });
}

const fixtureSites = registryPayloads().map((payload) => ({ siteId: payload.siteId, payload }));
const tenantASite = registryPayloads().find((payload) => payload.siteId === TENANT_A.siteId)!;

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

describe('e-signature consumer expectation of programs-sites.site.changed.v1', () => {
  it('producer schema requires every field the tenant registry consumer reads, as a state event', () => {
    expect(() => assertProducerConsumerCompatible(producerSchema, { required: [...REQUIRED], kind: 'state' })).not.toThrow();
  });

  it('rejects an expectation of a field the producer does not declare, such as the legacy contentPoolId', () => {
    const error = contractErrorOf(() =>
      assertProducerConsumerCompatible(producerSchema, { required: [...REQUIRED, 'contentPoolId'], kind: 'state' }),
    );

    expect(error.errors).toStrictEqual([
      { instancePath: '/contentPoolId', message: 'is not declared by the producer', keyword: 'properties' },
    ]);
  });
});

describe('programs-sites.site.changed.v1 schema declarations', () => {
  it('is a state event, the kind e-signature registers its consumer with', () => {
    expect(producerSchema['x-opt2-kind']).toBe('state');
  });

  it('records the pinned source SHA', () => {
    expect(producerSchema.$comment).toBe(`source-sha: ${pin.sha}`);
  });
});

describe('programs-sites.site.changed.v1 envelope and payload', () => {
  it.each(fixtureSites)('accepts the $siteId fixture site event under its own tenant', ({ siteId, payload }) => {
    const accepted = assertEventMatches(undefined, producerSchema, envelopeFor(payload));

    expect(accepted.tenantId).toBe(tenantIdForSite(siteId));
    expect(accepted.payload).toStrictEqual(payload);
  });

  it('rejects the event without an envelope tenant, since the payload never carries one', () => {
    const error = contractErrorOf(() => assertEventMatches(undefined, producerSchema, withoutTenant(envelopeFor(tenantASite))));

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath: 'envelope', message: expect.stringContaining("'tenantId'") }),
    );
  });

  it.each(REQUIRED)('rejects a payload without %s', (field) => {
    const payload = Object.fromEntries(Object.entries(tenantASite).filter(([key]) => key !== field));

    const error = contractErrorOf(() => assertEventMatches(undefined, producerSchema, { ...envelopeFor(tenantASite), payload }));

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath: 'payload', message: expect.stringContaining(`'${field}'`) }),
    );
  });

  it('rejects a payload with a property the closed producer object does not declare', () => {
    const payload = { ...tenantASite, tenantId: TENANT_A.tenantId };

    const error = contractErrorOf(() => assertEventMatches(undefined, producerSchema, envelopeFor(payload)));

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath: 'payload', message: expect.stringContaining('(tenantId)') }),
    );
  });
});

describe('e-signature subscription', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await buildTestApp();
    await ctx.app.ready();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('subscribes as e-signature.<topic> under the platform naming rule', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('e-signature.programs-sites.site.changed.v1');
    expect(SITE_CHANGED_SUBSCRIPTION).toBe(subscriptionName('e-signature', SITE_CHANGED_TOPIC));
  });

  it('registers one state consumer, on the site.changed topic', () => {
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.consumer.topic).toBe(SITE_CHANGED_TOPIC);
    expect(consumers[0]?.consumer.kind).toBe('state');
  });

  it('acknowledges a pushed tenant-a site event without dead-lettering it', async () => {
    const response = await pushTo(ctx.app, SITE_CHANGED_SUBSCRIPTION, envelopeFor(tenantASite));

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toStrictEqual([]);
  });
});
