// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of finance on `programs-sites.site.changed.v1`, the only topic finance consumes. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ContractAssertionError,
  TENANT_A,
  assertEventMatches,
  assertProducerConsumerCompatible,
  testEnvelope,
  withoutTenant,
} from '@opt2/platform/testing';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer, type SiteChangedPayload } from '@opt2/platform/tenancy';
import { SITE_CHANGED_SUBSCRIPTION, consumers } from '../../src/events/consumers.js';

/** The root keywords of the producer schema this suite reads. */
interface ProducerSchema {
  $comment: string;
  'x-opt2-kind': string;
  'x-opt2-tenant-fanout'?: string;
}

const producerSchema = JSON.parse(
  readFileSync(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as ProducerSchema;
const pin = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as {
  sha: string;
};

const sample: SiteChangedPayload = {
  siteId: 'tenant-a',
  publicUserPoolId: 'umbrella',
  privateUserPoolId: 'tenant-a',
  categoryPoolId: 'umbrella',
  filePoolId: 'umbrella',
  displayPoolId: 'umbrella',
  contentPoolIds: ['tenant-a'],
  domains: ['tenant-a.local'],
};

const required = [
  'siteId',
  'publicUserPoolId',
  'privateUserPoolId',
  'categoryPoolId',
  'filePoolId',
  'displayPoolId',
  'contentPoolIds',
  'domains',
] satisfies readonly (keyof SiteChangedPayload)[];

const types = {
  siteId: 'string',
  publicUserPoolId: 'string',
  privateUserPoolId: 'string',
  categoryPoolId: 'string',
  filePoolId: 'string',
  displayPoolId: 'string',
  contentPoolIds: 'array',
  domains: 'array',
} as const satisfies Record<keyof SiteChangedPayload, 'string' | 'array'>;

const envelope = testEnvelope({
  topic: SITE_CHANGED_TOPIC,
  tenantId: TENANT_A.tenantId,
  aggregateId: 'tenant-a',
  aggregateVersion: 1,
  payload: sample,
});

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

describe('finance consumer expectation of programs-sites.site.changed.v1', () => {
  it('expects exactly the SiteChangedPayload fields the sample carries', () => {
    const fields = Object.keys(sample).sort();

    expect([...required].sort()).toStrictEqual(fields);
    expect(Object.keys(types).sort()).toStrictEqual(fields);
  });

  it('producer schema carries every field the tenant registry consumer reads', () => {
    expect(() =>
      assertProducerConsumerCompatible(producerSchema, { required: [...required], types, samples: [sample], kind: 'state' }),
    ).not.toThrow();
  });

  it('does not carry the tenant id in the payload', () => {
    const error = contractErrorOf(() =>
      assertProducerConsumerCompatible(producerSchema, { required: [...required, 'tenantId'] }),
    );

    expect(error.errors).toStrictEqual([
      { instancePath: '/tenantId', message: 'is not declared by the producer', keyword: 'properties' },
    ]);
  });
});

describe('programs-sites.site.changed.v1 schema declarations', () => {
  it('is a state event, the kind the tenant registry consumer applies on this topic', () => {
    expect(producerSchema['x-opt2-kind']).toBe('state');
    expect(tenantRegistryConsumer.kind).toBe(producerSchema['x-opt2-kind']);
    expect(tenantRegistryConsumer.topic).toBe(SITE_CHANGED_TOPIC);
  });

  it('records the pinned source SHA', () => {
    expect(producerSchema.$comment).toBe(`source-sha: ${pin.sha}`);
  });

  it('declares no tenant fan-out, so finance applies each event in the envelope tenant only', () => {
    expect(producerSchema).not.toHaveProperty(['x-opt2-tenant-fanout']);
  });
});

describe('programs-sites.site.changed.v1 envelope', () => {
  it('accepts a tenant-a event whose tenant travels in the envelope', () => {
    const accepted = assertEventMatches(undefined, producerSchema, envelope);

    expect(accepted.tenantId).toBe(TENANT_A.tenantId);
    expect(accepted.payload).toStrictEqual(sample);
  });

  it('rejects the event without an envelope tenant', () => {
    const error = contractErrorOf(() => assertEventMatches(undefined, producerSchema, withoutTenant(envelope)));

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath: 'envelope', message: expect.stringContaining("'tenantId'") }),
    );
  });
});

describe('finance subscription', () => {
  it('subscribes as finance.<topic> under the platform naming rule', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('finance.programs-sites.site.changed.v1');
  });

  it('registers one consumer, on the site.changed topic', () => {
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.consumer.topic).toBe(SITE_CHANGED_TOPIC);
  });
});
