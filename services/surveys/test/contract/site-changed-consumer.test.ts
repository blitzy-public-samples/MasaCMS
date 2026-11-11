// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of surveys on `programs-sites.site.changed.v1`, the only feed of `surveys.tenant_registry`. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ContractAssertionError,
  assertProducerConsumerCompatible,
  registryPayloads,
  type ConsumerExpectation,
  type ContractViolation,
  type JsonType,
} from '@opt2/platform/testing';
import type { SiteChangedPayload } from '@opt2/platform/tenancy';
import { SITE_CHANGED_SUBSCRIPTION, siteChangedSchema } from '../../src/events/consumers.js';

const producerSchema = JSON.parse(
  await readFile(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

/** Every field the registry consumer reads, with the JSON type it relies on; keyed exactly by SiteChangedPayload. */
const REGISTRY_FIELD_TYPES = {
  siteId: 'string',
  publicUserPoolId: 'string',
  privateUserPoolId: 'string',
  categoryPoolId: 'string',
  filePoolId: 'string',
  displayPoolId: 'string',
  contentPoolIds: 'array',
  domains: 'array',
} as const satisfies Record<keyof SiteChangedPayload, JsonType>;

const expectation: ConsumerExpectation = {
  required: Object.keys(REGISTRY_FIELD_TYPES),
  types: REGISTRY_FIELD_TYPES,
  samples: registryPayloads(),
  kind: 'state',
};

/** A mutated copy of the producer schema; `$id` is dropped because the shared Ajv registry already holds the original under it. */
function mutatedProducer(mutate: (schema: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = structuredClone(producerSchema);
  delete copy.$id;
  mutate(copy);
  return copy;
}

function withoutRequired(field: string): (schema: Record<string, unknown>) => void {
  return (schema) => {
    schema.required = (schema.required as string[]).filter((name) => name !== field);
  };
}

function renamed(field: string, to: string): (schema: Record<string, unknown>) => void {
  return (schema) => {
    const properties = schema.properties as Record<string, unknown>;
    properties[to] = properties[field];
    delete properties[field];
    schema.required = (schema.required as string[]).map((name) => (name === field ? to : name));
  };
}

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('programs-sites.site.changed.v1 consumed by the surveys site registry', () => {
  it('producer schema supplies every registry field surveys reads', () => {
    expect(() => assertProducerConsumerCompatible(producerSchema, expectation)).not.toThrow();
  });

  it.each<[string, (schema: Record<string, unknown>) => void, ContractViolation['instancePath'], ContractViolation['keyword']]>([
    ['a pool field the producer no longer requires', withoutRequired('publicUserPoolId'), '/publicUserPoolId', 'required'],
    ['a renamed pool field', renamed('categoryPoolId', 'categoryPoolID'), '/categoryPoolId', 'properties'],
    ['a process kind', (schema) => void (schema['x-opt2-kind'] = 'process'), '', 'x-opt2-kind'],
  ])('rejects a producer schema with %s', (_case, mutate, instancePath, keyword) => {
    const error = thrownBy(() => assertProducerConsumerCompatible(mutatedProducer(mutate), expectation));

    expect(error).toBeInstanceOf(ContractAssertionError);
    expect((error as ContractAssertionError).errors).toContainEqual(expect.objectContaining({ instancePath, keyword }));
  });

  it('producer schema declares no tenant fan-out, so registry events apply in the envelope tenant only', () => {
    expect(producerSchema).not.toHaveProperty(['x-opt2-tenant-fanout']);
  });
});

describe('surveys site-registry consumer wiring', () => {
  it("consumer validates against the producer's file", () => {
    expect(siteChangedSchema).toStrictEqual(producerSchema);
  });

  it('subscribes as surveys.programs-sites.site.changed.v1', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('surveys.programs-sites.site.changed.v1');
  });
});
