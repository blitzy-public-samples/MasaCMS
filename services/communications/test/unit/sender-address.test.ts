// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, expect, it } from 'vitest';
import { tenantIdForSite, withMetadata } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import {
  DEFAULT_SITE_ID,
  FALLBACK_DOMAIN,
  createSenderAddressSource,
  filterEmails,
  isValidEmail,
  isValidEmailFormat,
} from '../../src/domain/sender-address.js';
import { createClientRecorder, createRecordingDb, type RecordedStatement, type RecordingDb, type Row } from '../helpers/app.js';
import { siteChangedPayload } from '../helpers/payloads.js';

const REGISTRY = 'communications.tenant_registry';
const DEFAULT_TENANT = tenantIdForSite(DEFAULT_SITE_ID);
const NO_DOMAIN_TENANT = tenantIdForSite('no-domain');
const BLANK_DOMAIN_TENANT = tenantIdForSite('blank-domain');
const DOMAIN_A = siteChangedPayload(TENANT_A.siteId).domains[0]!;
const DOMAIN_B = siteChangedPayload(TENANT_B.siteId).domains[0]!;

type Lookup = ['site' | 'entry', string];

/** A tenant_registry row of `siteId` with `domains`; pool columns stay null. */
function registryRow(siteId: string, domains: string[]): Row {
  return { site_id: siteId, tenant_id: tenantIdForSite(siteId), domains, aggregate_version: 1, updated_at: new Date(0) };
}

const EXTRA_SITES: readonly Row[] = [
  registryRow(DEFAULT_SITE_ID, ['default.example.org']),
  registryRow('no-domain', []),
  registryRow('blank-domain', ['', 'late.example.org']),
];

/** RecordingDb holding `rows`, plus the platform fixture sites unless `fixtures` is false; `seeded` counts its seeding transactions. */
async function registryDb(rows: readonly Row[] = EXTRA_SITES, fixtures = true): Promise<{ db: RecordingDb; seeded: number }> {
  const db = createRecordingDb({ tenant_registry: rows });
  if (fixtures) await db.seedRegistry();
  return { db, seeded: db.transactions.length };
}

function lookupOf({ text, values }: RecordedStatement): Lookup {
  if (text.endsWith(`FROM ${REGISTRY} WHERE lower(site_id) = lower($1)`)) return ['site', String(values[0])];
  if (text.endsWith(`FROM ${REGISTRY} WHERE tenant_id = $1`)) return ['entry', String(values[0])];
  throw new Error(`Unexpected statement: ${text}`);
}

/** Tenant, outcome and registry lookups of each transaction after the first `from`. */
function readsOf(db: RecordingDb, from: number) {
  return db.transactions.slice(from).map((tx) => ({ tenantId: tx.tenantId, outcome: tx.outcome, lookups: tx.statements.map(lookupOf) }));
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
    'not-an-email',
    'a@',
    '@b.com',
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
    [TENANT_A.siteId, `no-reply@${DOMAIN_A}`, [['site', TENANT_A.siteId], ['entry', TENANT_A.tenantId]]],
    ['TENANT-A', `no-reply@${DOMAIN_A}`, [['site', 'TENANT-A'], ['entry', TENANT_A.tenantId]]],
    [TENANT_B.siteId, `no-reply@${DOMAIN_B}`, [['site', TENANT_B.siteId], ['entry', TENANT_B.tenantId]]],
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
  ])('resolves site %j to %s in one metadata transaction', async (siteId, from, lookups) => {
    const { db, seeded } = await registryDb();

    await expect(createSenderAddressSource({ db }).fromEmail(siteId)).resolves.toBe(from);

    expect(readsOf(db, seeded)).toStrictEqual([{ tenantId: null, outcome: 'commit', lookups }]);
  });

  it.each<[string, Row[], string]>([
    ['the registry is empty', [], TENANT_A.siteId],
    ['the default site has no domain', [registryRow(DEFAULT_SITE_ID, [])], ''],
    ['neither the site nor default has a domain', [registryRow(TENANT_A.siteId, []), registryRow(DEFAULT_SITE_ID, [''])], TENANT_A.siteId],
  ])('falls back to no-reply@localhost when %s', async (_case, rows, siteId) => {
    const { db } = await registryDb(rows, false);

    await expect(createSenderAddressSource({ db }).fromEmail(siteId)).resolves.toBe('no-reply@localhost');
  });

  it('reads the registry afresh on every call', async () => {
    const { db, seeded } = await registryDb();
    const source = createSenderAddressSource({ db });

    await expect(source.fromEmail(TENANT_A.siteId)).resolves.toBe(`no-reply@${DOMAIN_A}`);
    await withMetadata(db, (tx) =>
      tx.query(`UPDATE ${REGISTRY} SET domains = $1 WHERE tenant_id = $2`, [['moved.example.org'], TENANT_A.tenantId]),
    );
    await expect(source.fromEmail(TENANT_A.siteId)).resolves.toBe('no-reply@moved.example.org');

    expect(db.transactions.slice(seeded).map((tx) => tx.tenantId)).toStrictEqual([null, null, null]);
  });

  it('never calls the programs-sites client', async () => {
    const { db } = await registryDb();
    const client = createClientRecorder();

    await expect(createSenderAddressSource({ db, client }).fromEmail(TENANT_B.siteId)).resolves.toBe(`no-reply@${DOMAIN_B}`);

    expect(client.requests).toStrictEqual([]);
    expect(client.closed).toBe(false);
  });
});
