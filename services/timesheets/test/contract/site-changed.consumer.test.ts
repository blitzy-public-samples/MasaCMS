// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of the timesheets tenant registry on `programs-sites.site.changed.v1`. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ContractAssertionError,
  TENANT_A,
  assertEventMatches,
  assertProducerConsumerCompatible,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type ConsumerExpectation,
  type JsonType,
} from '@opt2/platform/testing';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer, type SiteChangedPayload } from '@opt2/platform/tenancy';
import { SITE_CHANGED_SUBSCRIPTION, consumers, siteChangedSchema } from '../../src/events/consumers.js';

/** The root keywords of the producer schema this suite reads or mutates. */
interface ProducerSchema {
  $id?: string;
  $comment: string;
  'x-opt2-kind': string;
  'x-opt2-tenant-fanout'?: string;
  required: string[];
  properties: Record<string, Record<string, unknown>>;
}

const producer = JSON.parse(
  readFileSync(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as ProducerSchema;
const { sha } = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as {
  sha: string;
};

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

const TYPES = {
  siteId: 'string',
  publicUserPoolId: 'string',
  privateUserPoolId: 'string',
  categoryPoolId: 'string',
  filePoolId: 'string',
  displayPoolId: 'string',
  contentPoolIds: 'array',
  domains: 'array',
} as const satisfies Record<keyof SiteChangedPayload, JsonType>;

/** The element type the tenant registry consumer reads from each list field. */
const ITEM_TYPES = {
  contentPoolIds: 'string',
  domains: 'string',
} as const satisfies Partial<Record<keyof SiteChangedPayload, JsonType>>;

const payloads = registryPayloads();
const tenantAPayload = payloads.find((payload) => payload.siteId === TENANT_A.siteId);
if (tenantAPayload === undefined) {
  throw new Error(`registryPayloads() has no ${TENANT_A.siteId} payload`);
}

const expectation: ConsumerExpectation = {
  required: [...REQUIRED],
  types: TYPES,
  itemTypes: ITEM_TYPES,
  samples: payloads,
  kind: 'state',
};

/** A copy of the producer schema changed by `mutate`; `$id` is dropped because the shared Ajv registry already holds the original under it. */
function mutated(mutate: (schema: ProducerSchema) => void): ProducerSchema {
  const copy = structuredClone(producer);
  delete copy.$id;
  mutate(copy);
  return copy;
}

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

const envelope = testEnvelope({
  topic: SITE_CHANGED_TOPIC,
  tenantId: TENANT_A.tenantId,
  aggregateId: TENANT_A.siteId,
  aggregateVersion: 1,
  payload: tenantAPayload,
});

describe('timesheets consumer expectation of programs-sites.site.changed.v1', () => {
  it('expects exactly the SiteChangedPayload fields the registry payloads carry', () => {
    const fields = Object.keys(tenantAPayload).sort();

    expect([...REQUIRED].sort()).toStrictEqual(fields);
    expect(Object.keys(TYPES).sort()).toStrictEqual(fields);
  });

  it('producer schema carries every field the tenant registry consumer reads', () => {
    expect(() => assertProducerConsumerCompatible(producer, expectation)).not.toThrow();
  });

  it.each(REQUIRED)('rejects a producer schema that no longer requires %s', (field) => {
    const schema = mutated((copy) => {
      copy.required = copy.required.filter((name) => name !== field);
    });

    const error = contractErrorOf(() => assertProducerConsumerCompatible(schema, expectation));

    expect(error.errors).toContainEqual(expect.objectContaining({ instancePath: `/${field}`, keyword: 'required' }));
  });

  const itemChanges: { change: string; items: object | undefined; keyword: string }[] = [
    { change: 'removed', items: undefined, keyword: 'items' },
    { change: 'of any type', items: {}, keyword: 'type' },
    { change: 'widened to string or number', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, keyword: 'type' },
  ];
  const itemMutations = (Object.keys(ITEM_TYPES) as (keyof typeof ITEM_TYPES)[]).flatMap((field) =>
    itemChanges.map((change) => ({ field, ...change })),
  );

  it.each(itemMutations)('rejects a producer schema whose $field items are $change', ({ field, items, keyword }) => {
    const schema = mutated((copy) => {
      const { items: _items, ...property } = copy.properties[field] ?? {};
      copy.properties[field] = items === undefined ? property : { ...property, items };
    });

    const error = contractErrorOf(() => assertProducerConsumerCompatible(schema, expectation));

    expect(error.errors).toContainEqual(expect.objectContaining({ instancePath: `/${field}/items`, keyword }));
  });

  it('rejects a producer schema declared as a process event', () => {
    const schema = mutated((copy) => {
      copy['x-opt2-kind'] = 'process';
    });

    const error = contractErrorOf(() => assertProducerConsumerCompatible(schema, expectation));

    expect(error.errors).toContainEqual(expect.objectContaining({ instancePath: '', keyword: 'x-opt2-kind' }));
  });

  it('does not carry the tenant id in the payload', () => {
    const error = contractErrorOf(() =>
      assertProducerConsumerCompatible(producer, { required: [...REQUIRED, 'tenantId'] }),
    );

    expect(error.errors).toStrictEqual([
      { instancePath: '/tenantId', message: 'is not declared by the producer', keyword: 'properties' },
    ]);
  });
});

describe('programs-sites.site.changed.v1 schema declarations', () => {
  it('is a state event, the kind the tenant registry consumer applies', () => {
    expect(producer['x-opt2-kind']).toBe('state');
    expect(tenantRegistryConsumer.kind).toBe(producer['x-opt2-kind']);
  });

  it('records the pinned source SHA', () => {
    expect(producer.$comment).toBe(`source-sha: ${sha}`);
  });

  it('declares no tenant fan-out, so timesheets applies each event in the envelope tenant only', () => {
    expect(producer).not.toHaveProperty(['x-opt2-tenant-fanout']);
  });
});

describe('programs-sites.site.changed.v1 envelope', () => {
  it('accepts a tenant-a event whose tenant travels in the envelope', () => {
    const accepted = assertEventMatches(undefined, producer, envelope);

    expect(accepted.tenantId).toBe(TENANT_A.tenantId);
    expect(accepted.payload).toStrictEqual(tenantAPayload);
  });

  it('rejects the event without an envelope tenant', () => {
    const error = contractErrorOf(() => assertEventMatches(undefined, producer, withoutTenant(envelope)));

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath: 'envelope', message: expect.stringContaining("'tenantId'") }),
    );
  });
});

describe('timesheets site-registry consumer wiring', () => {
  it('subscribes as timesheets.<topic> under the platform naming rule', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('timesheets.programs-sites.site.changed.v1');
  });

  it("validates payloads against the producer's own schema file", () => {
    expect(siteChangedSchema).toEqual(producer);
  });

  it('registers the platform tenant registry consumer once, on the site.changed topic', () => {
    const registrations = consumers.filter((registration) => registration.consumer.topic === SITE_CHANGED_TOPIC);

    expect(tenantRegistryConsumer.topic).toBe(SITE_CHANGED_TOPIC);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.consumer).toBe(tenantRegistryConsumer);
    expect(registrations[0]?.payloadSchema).toBe(siteChangedSchema);
  });
});
