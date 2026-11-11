/** Contract of `programs-sites.site.changed.v1`: the payload schema, the platform payload type and the producer's builder agree. */
import { readFileSync } from 'node:fs';
import { compileTopicSchema, topicSchemaRelativePath } from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, tenantIdForSite, type SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertEventMatches,
  testEnvelope,
  withoutTenant,
  type ContractViolation,
} from '@opt2/platform/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { siteChangedPayload } from '../../src/domain/pools.js';
import { siteChangedSchema } from '../../src/events/consumers.js';
import { SITE_COLUMNS, targetNameFor, type SiteRow } from '../../src/legacy/site-fields.js';

/** The root keywords of the payload schema file this suite reads. */
interface TopicSchemaFile {
  $schema: string;
  $id: string;
  $comment: string;
  'x-opt2-kind': string;
  additionalProperties: unknown;
  required: string[];
  properties: Record<string, unknown>;
}

const schemaUrl = new URL('../../contracts/events/programs-sites.site.changed.v1.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as TopicSchemaFile;
const pin = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as {
  sha: string;
};

const FIELDS = [
  'siteId',
  'publicUserPoolId',
  'privateUserPoolId',
  'categoryPoolId',
  'filePoolId',
  'displayPoolId',
  'contentPoolIds',
  'domains',
] as const satisfies readonly (keyof SiteChangedPayload)[];

/** A stored `programs_sites.site` row: every site column NULL except `values`, which must name site columns. */
function siteRow(values: Readonly<Record<string, string>>): SiteRow {
  const row: SiteRow = Object.fromEntries(SITE_COLUMNS.map(({ targetName }) => [targetName, null]));
  for (const [column, value] of Object.entries(values)) {
    if (targetNameFor(column) !== column) throw new Error(`${column} is not a programs_sites.site column`);
    row[column] = value;
  }
  return row;
}

const pooledRow = siteRow({
  siteid: TENANT_A.siteId,
  domain: 'tenant-a.opt2.test',
  domainalias: 'www.tenant-a.opt2.test',
  publicuserpoolid: TENANT_UMBRELLA.siteId,
  privateuserpoolid: TENANT_A.siteId,
  categorypoolid: TENANT_UMBRELLA.siteId,
  filepoolid: TENANT_UMBRELLA.siteId,
  displaypoolid: TENANT_UMBRELLA.siteId,
  contentpoolid: `${TENANT_A.siteId},${TENANT_UMBRELLA.siteId}`,
});

const unpooledRow = siteRow({
  siteid: TENANT_B.siteId,
  domain: 'tenant-b.opt2.test',
  publicuserpoolid: '',
  privateuserpoolid: '',
  categorypoolid: '',
  filepoolid: '',
  displaypoolid: '',
  contentpoolid: '',
});

/** The envelope the producer writes for `payload`: tenant of the site, aggregate the site. */
function envelopeOf<P>(siteId: string, payload: P) {
  return testEnvelope({
    topic: 'programs-sites.site.changed.v1',
    tenantId: tenantIdForSite(siteId),
    aggregateId: siteId,
    aggregateVersion: 1,
    payload,
  });
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

describe('programs-sites.site.changed.v1 payload schema', () => {
  it('compiles as a draft 2020-12 state topic with the platform validator', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');

    const validator = compileTopicSchema(schema);

    expect(validator.schemaId).toBe(schema.$id);
    expect(validator.meta.kind).toBe('state');
  });

  it('declares and requires exactly the SiteChangedPayload fields, and no others', () => {
    expectTypeOf<Exclude<keyof SiteChangedPayload, (typeof FIELDS)[number]>>().toBeNever();

    expect(Object.keys(schema.properties).sort()).toStrictEqual([...FIELDS].sort());
    expect([...schema.required].sort()).toStrictEqual([...FIELDS].sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it('is a state event recording the pinned source SHA', () => {
    expect(schema['x-opt2-kind']).toBe('state');
    expect(schema.$comment).toBe(`source-sha: ${pin.sha}`);
  });

  it('is the file the runtime consumer reads, named and placed by the topic', () => {
    expect(siteChangedSchema.$id).toBe(schema.$id);
    expect(siteChangedSchema).toStrictEqual(schema);
    expect(schemaUrl.pathname.endsWith(`/${topicSchemaRelativePath(SITE_CHANGED_TOPIC)}`)).toBe(true);
  });
});

describe('programs-sites.site.changed.v1 producer payloads', () => {
  it.each([
    { site: TENANT_A.siteId, row: pooledRow },
    { site: TENANT_B.siteId, row: unpooledRow },
  ])('builds a conforming event for the $site site row', ({ site, row }) => {
    const payload = siteChangedPayload(row);

    expect(Object.keys(payload).sort()).toStrictEqual([...FIELDS].sort());
    expect(assertEventMatches(undefined, schema, envelopeOf(site, payload)).payload).toStrictEqual(payload);
  });

  it('carries pooled sites as legacy site ids, with the content pool list in stored order', () => {
    expect(siteChangedPayload(pooledRow)).toStrictEqual({
      siteId: 'tenant-a',
      publicUserPoolId: 'umbrella',
      privateUserPoolId: 'tenant-a',
      categoryPoolId: 'umbrella',
      filePoolId: 'umbrella',
      displayPoolId: 'umbrella',
      contentPoolIds: ['tenant-a', 'umbrella'],
      domains: ['tenant-a.opt2.test', 'www.tenant-a.opt2.test'],
    });
  });

  it("defaults every empty pool of a site to the site's own id", () => {
    const payload = siteChangedPayload(unpooledRow);

    for (const field of ['publicUserPoolId', 'privateUserPoolId', 'categoryPoolId', 'filePoolId', 'displayPoolId'] as const) {
      expect(payload[field]).toBe('tenant-b');
    }
    expect(payload.contentPoolIds).toStrictEqual(['tenant-b']);
  });
});

describe('programs-sites.site.changed.v1 contract violations', () => {
  const pooled = siteChangedPayload(pooledRow);
  const { domains: _domains, ...withoutDomains } = pooled;

  it('rejects an envelope without tenantId', () => {
    const error = contractErrorOf(() =>
      assertEventMatches(undefined, schema, withoutTenant(envelopeOf(TENANT_A.siteId, pooled))),
    );

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath: 'envelope', message: expect.stringContaining("'tenantId'") }),
    );
  });

  it.each<[string, Record<string, unknown>, ContractViolation['instancePath'], string]>([
    ['without domains', withoutDomains, 'payload', "'domains'"],
    ['with a legacy-cased extra key', { ...pooled, siteID: TENANT_A.siteId }, 'payload', '(siteID)'],
    ['with an empty pool id', { ...pooled, filePoolId: '' }, 'payload/filePoolId', 'fewer than 1'],
  ])('rejects a payload %s', (_case, payload, instancePath, message) => {
    const error = contractErrorOf(() => assertEventMatches(undefined, schema, envelopeOf(TENANT_A.siteId, payload)));

    expect(error.errors).toContainEqual(
      expect.objectContaining({ instancePath, message: expect.stringContaining(message) }),
    );
  });
});
