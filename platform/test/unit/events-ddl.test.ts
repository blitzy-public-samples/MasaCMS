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
  ['upper-case letters', 'Timesheets'],
  ['a double quote', 'timesheets"'],
  ['a statement separator', 'timesheets; DROP TABLE timesheets.inbox; --'],
  ['a schema-qualified name', 'timesheets.inbox'],
  ['whitespace', 'time sheets'],
  ['a hyphen', 'programs-sites'],
  ['a leading digit', '1timesheets'],
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
    expect(inboxSql('timesheets')).toBe(
      [
        'CREATE TABLE timesheets.inbox (',
        '  tenant_id uuid NOT NULL,',
        '  event_id uuid NOT NULL,',
        '  subscription text NOT NULL,',
        `  received_at ${TIMESTAMP},`,
        "  status text NOT NULL CHECK (status IN ('applied','stale','superseded')),",
        '  PRIMARY KEY (tenant_id, event_id)',
        ');',
        rlsSql('timesheets', 'inbox'),
        '',
      ].join('\n'),
    );
  });
});

describe('consumerAggregateVersionSql', () => {
  it('creates the tenant-owned progress table keyed by tenant, subscription and aggregate, followed by its tenant RLS', () => {
    expect(consumerAggregateVersionSql('timesheets')).toBe(
      [
        'CREATE TABLE timesheets.consumer_aggregate_version (',
        '  tenant_id uuid NOT NULL,',
        '  subscription text NOT NULL,',
        '  aggregate_type text NOT NULL,',
        '  aggregate_id text NOT NULL,',
        '  last_version bigint NULL,',
        `  updated_at ${TIMESTAMP},`,
        '  PRIMARY KEY (tenant_id, subscription, aggregate_type, aggregate_id)',
        ');',
        rlsSql('timesheets', 'consumer_aggregate_version'),
        '',
      ].join('\n'),
    );
  });
});

describe('eventsSql', () => {
  const sql = eventsSql('timesheets');

  it('joins the inbox and aggregate-version DDL with a blank line', () => {
    expect(sql).toBe(`${inboxSql('timesheets')}\n${consumerAggregateVersionSql('timesheets')}`);
    expect(sql.split('\n\n')).toHaveLength(2);
  });

  it('creates one tenant policy per table', () => {
    expect([...sql.matchAll(/^CREATE POLICY \S+ ON (\S+)$/gm)].map((match) => match[1])).toEqual([
      'timesheets.inbox',
      'timesheets.consumer_aggregate_version',
    ]);
  });

  it('uses the given schema throughout', () => {
    const other = eventsSql('people');
    expect(other).toBe(sql.replaceAll('timesheets.', 'people.'));
    expect(other).not.toContain('timesheets');
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
