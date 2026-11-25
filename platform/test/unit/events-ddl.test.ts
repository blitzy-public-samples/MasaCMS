import { describe, expect, it } from 'vitest';
import {
  CONSUMER_AGGREGATE_VERSION_TABLE,
  INBOX_STATUSES,
  INBOX_TABLE,
  consumerAggregateVersionSql,
  eventsSql,
  inboxSql,
} from '../../src/events/ddl.js';
import { rlsSql } from '../../src/tenancy/rls.js';

const TIMESTAMP = 'timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3)';

const INVALID_SCHEMAS: readonly (readonly [string, string])[] = [
  ['upper-case letters', 'Stub'],
  ['a double quote', 'stub"'],
  ['a statement separator', 'stub; DROP TABLE stub.inbox; --'],
  ['a schema-qualified name', 'stub.inbox'],
  ['whitespace', 'stub notes'],
  ['a hyphen', 'programs-sites'],
  ['a leading digit', '1stub'],
  ['an empty string', ''],
  ['a non-string value', 42 as unknown as string],
];

describe('events table names and inbox statuses', () => {
  it('names the inbox and aggregate-version tables', () => {
    expect([INBOX_TABLE, CONSUMER_AGGREGATE_VERSION_TABLE]).toEqual(['inbox', 'consumer_aggregate_version']);
  });

  it('lists the inbox outcomes in order', () => {
    expect(INBOX_STATUSES).toEqual(['applied', 'stale', 'superseded']);
  });
});

describe('inboxSql', () => {
  it('creates the tenant-owned inbox keyed by tenant and event, followed by its tenant RLS', () => {
    expect(inboxSql('stub')).toBe(
      [
        'CREATE TABLE stub.inbox (',
        '  tenant_id uuid NOT NULL,',
        '  event_id uuid NOT NULL,',
        '  subscription text NOT NULL,',
        `  received_at ${TIMESTAMP},`,
        "  status text NOT NULL CHECK (status IN ('applied','stale','superseded')),",
        '  PRIMARY KEY (tenant_id, event_id)',
        ');',
        rlsSql('stub', 'inbox'),
        '',
      ].join('\n'),
    );
  });
});

describe('consumerAggregateVersionSql', () => {
  it('creates the tenant-owned progress table keyed by tenant, subscription and aggregate, followed by its tenant RLS', () => {
    expect(consumerAggregateVersionSql('stub')).toBe(
      [
        'CREATE TABLE stub.consumer_aggregate_version (',
        '  tenant_id uuid NOT NULL,',
        '  subscription text NOT NULL,',
        '  aggregate_type text NOT NULL,',
        '  aggregate_id text NOT NULL,',
        '  last_version bigint NULL,',
        `  updated_at ${TIMESTAMP},`,
        '  PRIMARY KEY (tenant_id, subscription, aggregate_type, aggregate_id)',
        ');',
        rlsSql('stub', 'consumer_aggregate_version'),
        '',
      ].join('\n'),
    );
  });
});

describe('eventsSql', () => {
  const sql = eventsSql('stub');

  it('joins the inbox and aggregate-version DDL with a blank line', () => {
    expect(sql).toBe(`${inboxSql('stub')}\n${consumerAggregateVersionSql('stub')}`);
    expect(sql.split('\n\n')).toHaveLength(2);
  });

  it('creates one tenant policy per table', () => {
    expect([...sql.matchAll(/^CREATE POLICY \S+ ON (\S+)$/gm)].map((match) => match[1])).toEqual([
      'stub.inbox',
      'stub.consumer_aggregate_version',
    ]);
  });

  it('uses the given schema throughout', () => {
    const other = eventsSql('people');
    expect(other).toBe(sql.replaceAll('stub.', 'people.'));
    expect(other).not.toContain('stub');
  });
});

describe.each([
  ['inboxSql', inboxSql],
  ['consumerAggregateVersionSql', consumerAggregateVersionSql],
  ['eventsSql', eventsSql],
] as const)('%s schema identifier', (_name, generate) => {
  it.each(INVALID_SCHEMAS)('throws a TypeError for %s', (_case, schema) => {
    expect(() => generate(schema)).toThrow(new TypeError(`Invalid schema identifier: ${JSON.stringify(schema)}`));
  });
});
