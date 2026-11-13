// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of timesheets on `people.person.archived.v1`, the archive-to-blackout seam. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { topicMeta } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  ContractAssertionError,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertProducerConsumerCompatible,
  testEnvelope,
  withoutTenant,
  type ConsumerExpectation,
} from '@opt2/platform/testing';
import { PERSON_ARCHIVED_SUBSCRIPTION, consumers, personArchivedSchema } from '../../src/events/consumers.js';
import { PERSON_ARCHIVED_TOPIC, personArchivedConsumer } from '../../src/events/person-archived.js';

/** The payload the timesheets consumer is typed to read. */
type ArchivedPayload = Parameters<(typeof personArchivedConsumer)['apply']>[1]['payload'];

/** The root keywords of the producer schema this suite reads. */
interface ProducerSchema {
  $id?: string;
  $comment: string;
  'x-opt2-kind': string;
  'x-opt2-tenant-fanout'?: string;
  required: string[];
  properties: Record<string, object>;
}

const producerSchema = JSON.parse(
  readFileSync(new URL('../../../people/contracts/events/people.person.archived.v1.json', import.meta.url), 'utf8'),
) as ProducerSchema;
const pin = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as {
  sha: string;
};

const personId = cfUuid();

const sample: ArchivedPayload = {
  personId,
  siteId: TENANT_UMBRELLA.siteId,
  effectiveFrom: '2026-06-15 00:00:00.000',
  archiveId: cfUuid(),
  archivedAt: '2026-06-15 09:30:00.000',
};

const required = ['personId', 'siteId', 'effectiveFrom', 'archiveId', 'archivedAt'] satisfies readonly (keyof ArchivedPayload)[];

const types = {
  personId: 'string',
  siteId: 'string',
  effectiveFrom: 'string',
  archiveId: 'string',
  archivedAt: 'string',
} as const satisfies Record<keyof ArchivedPayload, 'string'>;

const expectation: ConsumerExpectation = {
  required: [...required],
  types,
  samples: [sample],
  kind: 'process',
  fanout: 'userPool',
};

/**
 * A copy of the producer schema changed by `mutate`.
 * `$id` is dropped because the shared Ajv registry already holds the original under it.
 */
function mutated(mutate: (copy: ProducerSchema) => void): ProducerSchema {
  const copy = structuredClone(producerSchema);
  delete copy.$id;
  mutate(copy);
  return copy;
}

const envelope = testEnvelope({
  topic: PERSON_ARCHIVED_TOPIC,
  tenantId: TENANT_UMBRELLA.tenantId,
  aggregateId: personId,
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

describe('timesheets consumer expectation of people.person.archived.v1', () => {
  it('expects exactly the fields the sample carries', () => {
    const fields = Object.keys(sample).sort();

    expect([...required].sort()).toStrictEqual(fields);
    expect(Object.keys(types).sort()).toStrictEqual(fields);
  });

  it('accepts the producer schema as a userPool process event', () => {
    expect(() => assertProducerConsumerCompatible(producerSchema, expectation)).not.toThrow();
  });

  const mutations: { change: string; mutate: (copy: ProducerSchema) => void; instancePath: string; keyword: string }[] = [
    ...required.map((field) => ({
      change: `makes ${field} optional`,
      mutate: (copy: ProducerSchema) => {
        copy.required = copy.required.filter((name) => name !== field);
      },
      instancePath: `/${field}`,
      keyword: 'required',
    })),
    {
      change: 'types archivedAt as an integer',
      mutate: (copy) => {
        copy.properties.archivedAt = { type: 'integer' };
      },
      instancePath: '/archivedAt',
      keyword: 'type',
    },
    {
      change: 'declares a state event',
      mutate: (copy) => {
        copy['x-opt2-kind'] = 'state';
      },
      instancePath: '',
      keyword: 'x-opt2-kind',
    },
    {
      change: 'drops the userPool fan-out',
      mutate: (copy) => {
        delete copy['x-opt2-tenant-fanout'];
      },
      instancePath: '',
      keyword: 'x-opt2-tenant-fanout',
    },
  ];

  it.each(mutations)('rejects a producer schema that $change', ({ mutate, instancePath, keyword }) => {
    const error = contractErrorOf(() => assertProducerConsumerCompatible(mutated(mutate), expectation));

    expect(error.errors).toContainEqual(expect.objectContaining({ instancePath, keyword }));
  });

  it('does not carry a destination tenant in the payload', () => {
    const error = contractErrorOf(() =>
      assertProducerConsumerCompatible(producerSchema, { required: [...required, 'tenantId'] }),
    );

    expect(error.errors).toStrictEqual([
      { instancePath: '/tenantId', message: 'is not declared by the producer', keyword: 'properties' },
    ]);
  });
});

describe('people.person.archived.v1 schema declarations', () => {
  it('records the pinned source SHA', () => {
    expect(producerSchema.$comment).toBe(`source-sha: ${pin.sha}`);
  });

  it('declares the kind and fan-out the timesheets consumer applies', () => {
    const meta = topicMeta(producerSchema);

    expect(meta).toStrictEqual({ kind: 'process', fanout: 'userPool' });
    expect(personArchivedConsumer.topic).toBe(PERSON_ARCHIVED_TOPIC);
    expect(personArchivedConsumer.kind).toBe(meta.kind);
    expect(personArchivedConsumer.fanout).toBe(meta.fanout);
  });
});

describe('people.person.archived.v1 envelope', () => {
  it('accepts an umbrella event whose tenant travels in the envelope', () => {
    const accepted = assertEventMatches(undefined, producerSchema, envelope);

    expect(accepted.tenantId).toBe(TENANT_UMBRELLA.tenantId);
    expect(accepted.aggregateId).toBe(personId);
    expect(accepted.payload).toStrictEqual(sample);
  });

  it('rejects the event without an envelope tenant', () => {
    const error = contractErrorOf(() => assertEventMatches(undefined, producerSchema, withoutTenant(envelope)));

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath: 'envelope', message: expect.stringContaining("'tenantId'") }),
    );
  });

  it.each([
    {
      change: 'an ISO-8601 archivedAt',
      payload: { ...sample, archivedAt: '2026-06-15T09:30:00.000Z' },
      instancePath: 'payload/archivedAt',
    },
    { change: 'an RFC 4122 personId', payload: { ...sample, personId: randomUUID() }, instancePath: 'payload/personId' },
    { change: 'destination tenants', payload: { ...sample, tenantIds: [TENANT_UMBRELLA.tenantId] }, instancePath: 'payload' },
  ])('rejects a payload carrying $change', ({ payload, instancePath }) => {
    const error = contractErrorOf(() => assertEventMatches(undefined, producerSchema, { ...envelope, payload }));

    expect(error.errors).toContainEqual(expect.objectContaining({ instancePath }));
  });
});

describe('timesheets subscription', () => {
  it('subscribes as timesheets.<topic> under the platform naming rule', () => {
    expect(PERSON_ARCHIVED_TOPIC).toBe('people.person.archived.v1');
    expect(PERSON_ARCHIVED_SUBSCRIPTION).toBe('timesheets.people.person.archived.v1');
  });

  it('validates deliveries against the producer schema it reads from people contracts', () => {
    const registration = consumers.find((entry) => entry.consumer.topic === PERSON_ARCHIVED_TOPIC);

    expect(personArchivedSchema).toEqual(producerSchema);
    expect(registration?.payloadSchema).toBe(personArchivedSchema);
    expect(registration?.consumer).toMatchObject({ kind: 'process', fanout: 'userPool' });
  });
});
