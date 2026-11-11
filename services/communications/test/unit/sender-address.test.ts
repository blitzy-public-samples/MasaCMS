// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, expect, it, vi } from 'vitest';
import type { ServiceClient } from '@opt2/platform/service-kit';
import {
  tenantIdForSite,
  type MetadataTx,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
} from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import {
  DEFAULT_SITE_ID,
  FALLBACK_DOMAIN,
  createSenderAddressSource,
  filterEmails,
  isValidEmail,
  isValidEmailFormat,
} from '../../src/domain/sender-address.js';

const SCHEMA = 'communications';
const DEFAULT_TENANT = tenantIdForSite('default');
const NO_DOMAIN_TENANT = tenantIdForSite('no-domain');
const BLANK_DOMAIN_TENANT = tenantIdForSite('blank-domain');

interface RegistryRow {
  site_id: string;
  tenant_id: string;
  domains: string[];
}

type Lookup = ['site' | 'entry', string];

const REGISTRY: readonly RegistryRow[] = [
  { site_id: TENANT_A.siteId, tenant_id: TENANT_A.tenantId, domains: ['a.example.org', 'www.a.example.org'] },
  { site_id: TENANT_B.siteId, tenant_id: TENANT_B.tenantId, domains: ['b.example.org'] },
  { site_id: 'default', tenant_id: DEFAULT_TENANT, domains: ['default.example.org'] },
  { site_id: 'no-domain', tenant_id: NO_DOMAIN_TENANT, domains: [] },
  { site_id: 'blank-domain', tenant_id: BLANK_DOMAIN_TENANT, domains: ['', 'late.example.org'] },
];

/** In-memory TenantDb whose tenant_registry is `rows`; records each registry read with the metadata transaction it ran in. */
function registryDb(rows: readonly RegistryRow[]) {
  const lookups: Array<{ tx: number; lookup: Lookup }> = [];
  const calls = { withMetadata: 0, withTenant: 0 };

  function metadataTx(id: number): MetadataTx {
    return {
      schema: SCHEMA,
      kind: 'metadata',
      onCommit: () => undefined,
      query: async <R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values: unknown[] = []) => {
        const sql = typeof text === 'string' ? text : text.text;
        const key = String(values[0]);
        let result: QueryResultRow[];
        if (sql.endsWith(`FROM ${SCHEMA}.tenant_registry WHERE lower(site_id) = lower($1)`)) {
          lookups.push({ tx: id, lookup: ['site', key] });
          result = rows
            .filter((row) => row.site_id.toLowerCase() === key.toLowerCase())
            .map((row) => ({ tenant_id: row.tenant_id }));
        } else if (sql.endsWith(`FROM ${SCHEMA}.tenant_registry WHERE tenant_id = $1`)) {
          lookups.push({ tx: id, lookup: ['entry', key] });
          result = rows
            .filter((row) => row.tenant_id === key)
            .map((row) => ({ ...row, aggregate_version: '1', updated_at: new Date(0) }));
        } else {
          throw new Error(`Unexpected SQL: ${sql}`);
        }
        const answer: QueryResult<R> = { command: 'SELECT', rowCount: result.length, oid: 0, fields: [], rows: result as R[] };
        return answer;
      },
    };
  }

  const db: TenantDb = {
    schema: SCHEMA,
    withTenant: () => {
      calls.withTenant += 1;
      return Promise.reject(new Error('sender address reads no tenant data'));
    },
    withMetadata: (fn) => {
      calls.withMetadata += 1;
      return fn(metadataTx(calls.withMetadata));
    },
    end: () => Promise.resolve(),
  };
  return { db, lookups, calls };
}

describe('isValidEmailFormat', () => {
  it.each(['a@b.co', '  a@b.co  ', '\t\na@b.co\r\n', 'a@b.abcdefgh', 'A@B.COM', 'a@b.com>trailing'])(
    'accepts %j',
    (email) => {
      expect(isValidEmailFormat(email)).toBe(true);
    },
  );

  it.each(['', ' \t ', 'a b@c.com', "o'neil@x.com", 'a%b@c.com', 'a*b@c.com', '<a@b.com>', 'a@@b.com', 'a@b.c', 'a@b'])(
    'rejects %j',
    (email) => {
      expect(isValidEmailFormat(email)).toBe(false);
    },
  );
});

describe('filterEmails', () => {
  it.each([
    ['a@b.com,bad,c@d.org', 'a@b.com,c@d.org'],
    ['', ''],
    ['bad', ''],
    [',a@b.com,,c@d.org,', 'a@b.com,c@d.org'],
    ['a@b.com, c@d.org', 'a@b.com, c@d.org'],
  ])('filters %j to %j', (list, kept) => {
    expect(filterEmails(list)).toBe(kept);
  });
});

describe('isValidEmail', () => {
  it.each(['a@b.co', 'A@B.COM', "o'neil@x.com", 'first.last+tag@mail.example.org', 'a~b@x-y.museum'])('accepts %j', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    '',
    ' a@b.co',
    'a@b.co ',
    'a@b.c',
    'a@b.abcdefgh',
    'a@b',
    '.a@b.co',
    'a..b@c.co',
    'a@b.co,c@d.org',
    'a b@c.co',
    '<a@b.co>',
  ])('rejects %j', (email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});

describe('createSenderAddressSource', () => {
  it('names the default site and fallback domain of a bare Masa install', () => {
    expect(DEFAULT_SITE_ID).toBe('default');
    expect(FALLBACK_DOMAIN).toBe('localhost');
  });

  it.each<[string, string, Lookup[]]>([
    [TENANT_A.siteId, 'no-reply@a.example.org', [['site', TENANT_A.siteId], ['entry', TENANT_A.tenantId]]],
    [TENANT_B.siteId, 'no-reply@b.example.org', [['site', TENANT_B.siteId], ['entry', TENANT_B.tenantId]]],
    ['unregistered', 'no-reply@default.example.org', [['site', 'unregistered'], ['site', 'default'], ['entry', DEFAULT_TENANT]]],
    [
      'no-domain',
      'no-reply@default.example.org',
      [['site', 'no-domain'], ['entry', NO_DOMAIN_TENANT], ['site', 'default'], ['entry', DEFAULT_TENANT]],
    ],
    [
      'blank-domain',
      'no-reply@default.example.org',
      [['site', 'blank-domain'], ['entry', BLANK_DOMAIN_TENANT], ['site', 'default'], ['entry', DEFAULT_TENANT]],
    ],
    ['', 'no-reply@default.example.org', [['site', 'default'], ['entry', DEFAULT_TENANT]]],
    ['default', 'no-reply@default.example.org', [['site', 'default'], ['entry', DEFAULT_TENANT]]],
    ['DEFAULT', 'no-reply@default.example.org', [['site', 'default'], ['entry', DEFAULT_TENANT]]],
  ])('resolves site %j to %s in one metadata transaction', async (siteId, from, expected) => {
    const { db, lookups, calls } = registryDb(REGISTRY);

    await expect(createSenderAddressSource({ db }).fromEmail(siteId)).resolves.toBe(from);

    expect(lookups).toStrictEqual(expected.map((lookup) => ({ tx: 1, lookup })));
    expect(calls).toStrictEqual({ withMetadata: 1, withTenant: 0 });
  });

  it.each<[string, RegistryRow[], string]>([
    ['the registry is empty', [], TENANT_A.siteId],
    ['the default site has no domain', [{ site_id: 'default', tenant_id: DEFAULT_TENANT, domains: [] }], ''],
    [
      'neither the site nor default has a domain',
      [
        { site_id: TENANT_A.siteId, tenant_id: TENANT_A.tenantId, domains: [] },
        { site_id: 'default', tenant_id: DEFAULT_TENANT, domains: [''] },
      ],
      TENANT_A.siteId,
    ],
  ])('falls back to no-reply@localhost when %s', async (_case, rows, siteId) => {
    const { db } = registryDb(rows);

    await expect(createSenderAddressSource({ db }).fromEmail(siteId)).resolves.toBe('no-reply@localhost');
  });

  it('reads the registry afresh on every call', async () => {
    const rows = REGISTRY.map((row) => ({ ...row, domains: [...row.domains] }));
    const { db, calls } = registryDb(rows);
    const source = createSenderAddressSource({ db });

    await expect(source.fromEmail(TENANT_A.siteId)).resolves.toBe('no-reply@a.example.org');
    rows[0]!.domains = ['moved.example.org'];
    await expect(source.fromEmail(TENANT_A.siteId)).resolves.toBe('no-reply@moved.example.org');

    expect(calls).toStrictEqual({ withMetadata: 2, withTenant: 0 });
  });

  it('never calls the programs-sites client', async () => {
    const { db } = registryDb(REGISTRY);
    const client = { request: vi.fn(), close: vi.fn() } satisfies ServiceClient;

    await expect(createSenderAddressSource({ db, client }).fromEmail(TENANT_B.siteId)).resolves.toBe('no-reply@b.example.org');

    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });
});
