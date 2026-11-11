/** Unit suite for the site settings bean, DAO column rules and list order ported in src/legacy/site-fields.ts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DROPPED_SETTER_KEYS,
  LEGACY_GLOBAL_CONFIG_DEFAULTS,
  READ_FIELDS,
  SITE_COLUMNS,
  SITE_DEFAULTS,
  UPDATE_COLUMNS,
  applySet,
  effectiveDataCollection,
  effectiveEditProfileURL,
  effectiveEmailBroadcaster,
  effectiveLoginURL,
  effectiveUseSSL,
  getSiteText,
  getSiteValue,
  legacyNameFor,
  listOrderSql,
  newSiteBean,
  readBean,
  sortSites,
  targetNameFor,
  updateColumnValues,
  type SiteBean,
  type SiteData,
  type SiteRow,
  type SiteStoredValue,
} from '../../../src/legacy/site-fields.js';

interface OwnershipTarget {
  unit: string;
  ownedColumns?: string[];
}
interface Ownership {
  tables: { table: string; targets: OwnershipTarget[] }[];
}

const ownership = JSON.parse(
  readFileSync(new URL('../../../../../opt2/table-ownership.json', import.meta.url), 'utf8'),
) as Ownership;
const sitesDdl = readFileSync(new URL('../../../db/migrations/0002_sites.sql', import.meta.url), 'utf8');

/** Column names of `programs_sites.site` in DDL order, without the target-only columns. */
function ddlSiteColumns(): string[] {
  const body = /CREATE TABLE programs_sites\.site \(([\s\S]*?)\n\);/.exec(sitesDdl)?.[1] ?? '';
  return body
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name !== '' && !['tenant_id', 'row_version', 'PRIMARY'].includes(name));
}

/** applySet on a fresh bean whose baseID is `B`. */
function set(data: SiteData, bean: SiteBean = newSiteBean('B')): SiteBean {
  return applySet(bean, data);
}

/** A bean holding exactly the given values over the init defaults, bypassing setValue. */
function beanWith(values: Record<string, SiteStoredValue>): SiteBean {
  return { values: { ...newSiteBean().values, ...values }, isNew: 0 };
}

describe('column catalogue', () => {
  it('lists the ownership columns in order, with the DDL column names as target names', () => {
    const target = ownership.tables
      .find((t) => t.table === 'tsettings')
      ?.targets.find((t) => t.unit === 'programs_sites.site');
    expect(SITE_COLUMNS.map((c) => c.legacyName)).toEqual(target?.ownedColumns);
    expect(SITE_COLUMNS.map((c) => c.targetName)).toEqual(ddlSiteColumns());
    expect(SITE_COLUMNS.every((c) => c.targetName === c.legacyName.toLowerCase())).toBe(true);
  });

  it.each([
    ['MAILSERVERIP', 'mailserverip', 'MailserverIP'],
    ['isRemote', 'isremote', 'isremote'],
    ['reCaptchaSiteKey', 'recaptchasitekey', 'reCAPTCHASiteKey'],
  ])('maps %s case-insensitively', (name, target, legacy) => {
    expect(targetNameFor(name)).toBe(target);
    expect(legacyNameFor(name)).toBe(legacy);
  });

  it('answers undefined for a name outside tsettings', () => {
    expect(targetNameFor('tenant_id')).toBeUndefined();
    expect(legacyNameFor('row_version')).toBeUndefined();
  });

  it('reads the DAO field list plus lastdeployment, all of them live columns', () => {
    expect(READ_FIELDS).toHaveLength(94);
    expect(READ_FIELDS[0]).toBe('siteid');
    expect(READ_FIELDS.at(-1)).toBe('lastdeployment');
    expect(READ_FIELDS.filter((f) => targetNameFor(f) === undefined)).toEqual([]);
    expect(READ_FIELDS).not.toContain('MaxNestLevel');
  });

  it('updates exactly the DAO SET list, never the key, order, deploy, deployment date or type', () => {
    expect(UPDATE_COLUMNS).toHaveLength(90);
    expect(new Set(UPDATE_COLUMNS).size).toBe(90);
    expect(UPDATE_COLUMNS.filter((c) => targetNameFor(c) !== c)).toEqual([]);
    for (const excluded of ['siteid', 'orderno', 'deploy', 'lastdeployment', 'type', 'subtype', 'maxnestlevel']) {
      expect(UPDATE_COLUMNS).not.toContain(excluded);
    }
    expect([UPDATE_COLUMNS[0], UPDATE_COLUMNS.at(-1)]).toEqual(['site', 'scaffolding']);
  });
});

describe('newSiteBean and getSiteValue', () => {
  it.each([
    ['Locking', 'None'],
    ['RemotePort', '80'],
    ['PublicSubmission', '0'],
    ['deploy', '1'],
    ['type', 'Site'],
    ['subType', 'Default'],
    ['largeImageWidth', '600'],
    ['largeImageHeight', 'AUTO'],
    ['cacheFreeMemoryThreshold', '60'],
    ['columnNames', 'Left Column^Main Content^Right Column'],
    ['reCAPTCHALanguage', 'en'],
    ['publicSubmissionApprovalScript', ''],
    ['hasSharedFilePool', ''],
    ['extendDataTable', 'tclassextenddata'],
    ['display', ''],
    ['placeholderImgExt', ''],
  ])('defaults %s to %j', (name, value) => {
    expect(getSiteValue(newSiteBean(), name)).toBe(value);
  });

  it('builds a new bean with isNew 1 and the caller baseID', () => {
    expect(newSiteBean().isNew).toBe(1);
    expect(getSiteValue(newSiteBean(), 'baseID')).toBe('');
    expect(getSiteValue(newSiteBean('X'.repeat(35)), 'BASEID')).toBe('X'.repeat(35));
    expect(SITE_DEFAULTS.baseID).toBe('');
    expect(Object.isFrozen(SITE_DEFAULTS)).toBe(true);
  });

  it('reads inherited object keys as missing fields', () => {
    expect(getSiteValue(newSiteBean(), 'constructor')).toBe('');
    expect(getSiteValue({ values: {}, isNew: 1 }, '__proto__')).toBe('');
  });

  it.each([
    ['a Date', new Date(0)],
    ['a struct', { a: 1 }],
  ])('refuses %s as text', (_label, value) => {
    expect(() => getSiteText(beanWith({ x: value }), 'x')).toThrow(TypeError);
  });
});

describe('applySet value handling', () => {
  it('trims simple values and stores keys without a setter under the lower-cased key', () => {
    const bean = set({ Foo: '  bar  ', n: 1.5, big: 10n, yes: true, none: null, missing: undefined, value: ' v ' });
    expect(getSiteValue(bean, 'foo')).toBe('bar');
    expect(getSiteValue(bean, 'n')).toBe('1.5');
    expect(getSiteValue(bean, 'big')).toBe('10');
    expect(getSiteValue(bean, 'yes')).toBe('true');
    expect(getSiteValue(bean, 'none')).toBe('');
    expect(getSiteValue(bean, 'missing')).toBe('');
    expect(getSiteValue(bean, 'value')).toBe('v');
  });

  it('stores complex values as given and keeps __proto__ a plain field', () => {
    const nested = { deep: [1] };
    const bean = set(JSON.parse('{"__proto__": {"polluted": 1}, "list": [1, 2]}') as SiteData);
    expect(set({ nested }).values.nested).toBe(nested);
    expect(getSiteValue(bean, 'list')).toEqual([1, 2]);
    expect(getSiteValue(bean, '__proto__')).toEqual({ polluted: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns a new bean and leaves the input bean untouched', () => {
    const before = newSiteBean('B');
    const snapshot = { ...before.values };
    const after = applySet(before, { site: 'Changed', siteid: 'tenant-a' });
    expect(after).not.toBe(before);
    expect({ ...before.values }).toEqual(snapshot);
    expect(after.isNew).toBe(1);
    expect(applySet(readBean({ siteid: 'x' }), {}).isNew).toBe(0);
  });

  it('defaults every empty pool id to the site id after the loop', () => {
    const bean = set({ siteid: 'tenant-a', publicUserPoolID: 'umbrella', privateUserPoolID: ' ' });
    expect(getSiteValue(bean, 'publicUserPoolID')).toBe('umbrella');
    for (const pool of ['privateUserPoolID', 'displayPoolID', 'filePoolID', 'categoryPoolID', 'contentPoolID']) {
      expect(getSiteValue(bean, pool)).toBe('tenant-a');
    }
  });

  it('drops keys whose legacy setters are not field setters', () => {
    const bean = set(Object.fromEntries(DROPPED_SETTER_KEYS.map((key) => [key, 'x'])));
    expect(bean.values).toEqual(newSiteBean('B').values);
    expect(DROPPED_SETTER_KEYS).toContain('moduleFilePath');
  });

  it('throws when a text setter receives a complex value', () => {
    expect(() => set({ siteid: { a: 1 } })).toThrow(TypeError);
  });
});

describe('applySet setter guards', () => {
  const numericFields = [
    ['scaffolding', '1'],
    ['enforcePrimaryDomain', '0'],
    ['enforceChangesets', '0'],
    ['cacheCapacity', '0'],
    ['hasComments', '1'],
    ['useDefaultSMTPServer', '1'],
    ['mailServerSMTPPort', '25'],
    ['mailServerPOPPort', '110'],
    ['hasLockableNodes', '0'],
    ['JSONApi', '0'],
    ['isRemote', '0'],
    ['resourceSSL', '0'],
    ['RemotePort', '80'],
  ] as const;

  it.each(numericFields)('%s accepts numeric input as given and ignores the rest', (field, initial) => {
    expect(getSiteValue(set({ [field]: ' 7 ' }), field)).toBe('7');
    expect(getSiteValue(set({ [field]: 'abc' }), field)).toBe(initial);
  });

  it.each([
    ['75', '75'],
    ['0', '60'],
    ['x', '60'],
  ])('cacheFreeMemoryThreshold %j gives %j', (input, expected) => {
    expect(getSiteValue(set({ cacheFreeMemoryThreshold: input }), 'cacheFreeMemoryThreshold')).toBe(expected);
  });

  const imageFields = [
    ['smallImageWidth', '80'],
    ['smallImageHeight', '80'],
    ['mediumImageWidth', '180'],
    ['mediumImageHeight', '180'],
    ['largeImageWidth', '600'],
    ['largeImageHeight', 'AUTO'],
  ] as const;

  it.each(imageFields)('%s accepts a non-zero number or AUTO in any case', (field, initial) => {
    expect(getSiteValue(set({ [field]: '1.5' }), field)).toBe('1.5');
    expect(getSiteValue(set({ [field]: 'auto' }), field)).toBe('auto');
    expect(getSiteValue(set({ [field]: '0' }), field)).toBe(initial);
    expect(getSiteValue(set({ [field]: 'big' }), field)).toBe(initial);
  });

  it.each([
    ['siteID', 'tenant-a', 'tenant-a'],
    ['siteID', '', ''],
    ['type', 'Page', 'Page'],
    ['type', 'SITE', 'Site'],
    ['type', '', 'Site'],
    ['subType', 'default', 'Default'],
    ['subType', 'Custom', 'Custom'],
    ['baseID', '', 'B'],
    ['baseID', 'C', 'C'],
    ['exportLocation', 'EXPORT1', ''],
    ['exportLocation', '/exports', '/exports'],
    ['mailServerTLS', 'yes', 'yes'],
    ['mailServerTLS', 'maybe', 'false'],
    ['mailServerSSL', 'true', 'true'],
    ['mailServerSSL', ' 2 ', '2'],
    ['mailServerSSL', 'nope', 'false'],
    ['showDashboard', 'yes', '1'],
    ['showDashboard', 'no', '0'],
    ['showDashboard', 'x', '0'],
    ['feedManager', 'abc', 'abc'],
  ])('%s %j stores %j', (field, input, expected) => {
    expect(getSiteValue(set({ [field]: input }), field)).toBe(expected);
  });

  it('keeps the stored siteID, type and theme when the new value differs only in case', () => {
    const stored = set({ siteid: 'default', theme: 'mytheme' });
    const bean = applySet(stored, { siteID: 'DEFAULT', theme: 'MyTheme' });
    expect(getSiteValue(bean, 'siteid')).toBe('default');
    expect(getSiteValue(bean, 'theme')).toBe('mytheme');
    expect(getSiteValue(applySet(stored, { theme: '' }), 'theme')).toBe('');
  });

  it('writes feedManager through hasFeedManager', () => {
    expect(getSiteValue(set({ hasFeedManager: '0' }), 'feedManager')).toBe('0');
  });

  it.each([
    ['true', '1'],
    ['1', '1'],
    ['false', '0'],
    ['0', '0'],
  ])('useSSL %j sets useSSL and extranetSSL to %j', (input, expected) => {
    const bean = set({ extranetSSL: '7', useSSL: input });
    expect([getSiteValue(bean, 'useSSL'), getSiteValue(bean, 'extranetSSL')]).toEqual([expected, expected]);
  });

  it('ignores a non-boolean useSSL and applies useSSL and extranetSSL in data order', () => {
    expect(getSiteValue(set({ extranetSSL: '7', useSSL: 'maybe' }), 'extranetSSL')).toBe('7');
    expect(getSiteValue(set({ useSSL: 'maybe' }), 'useSSL')).toBe('0');
    expect(getSiteValue(set({ useSSL: '1', extranetSSL: '0' }), 'extranetSSL')).toBe('0');
  });

  it.each([
    ['user@example.com', '', '', 'user@example.com'],
    ['a+b+c', '', '', 'a@b+c'],
    ['bounce', 'mail.example.com', '', 'bounce@example.com'],
    ['bounce', '.mail..example.com.', '', 'bounce@example.com'],
    ['bounce', 'localhost', '', 'bounce@'],
    ['', 'mail.example.com', 'admin@example.com', 'admin@example.com'],
  ])('mailServerUsername %j with IP %j derives the email %j', (username, ip, contact, email) => {
    const bean = set({ contact, MailServerIP: ip, mailServerUsername: username });
    expect(getSiteValue(bean, 'mailServerUsernameEmail')).toBe(email);
    expect(getSiteValue(bean, 'mailServerUsername')).toBe(username);
    expect(getSiteValue(set({ contact, mailServerUsernameEmail: username }), 'mailServerUsername')).toBe('');
  });

  it.each([
    ['2026-01-02T03:04:05', new Date(2026, 0, 2, 3, 4, 5)],
    ['2026-01-02 03:04:05.5', new Date(2026, 0, 2, 3, 4, 5, 500)],
    ['2026-01-02', new Date(2026, 0, 2)],
  ])('lastDeployment %j parses to local time', (input, expected) => {
    const value = getSiteValue(set({ lastDeployment: input }), 'lastDeployment');
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).getTime()).toBe(expected.getTime());
  });

  it.each(['2026-02-30', '2026-13-01', '2026-01-02 24:00:00', '01/02/2026', 'soon'])(
    'lastDeployment %j becomes empty',
    (input) => {
      expect(getSiteValue(set({ lastDeployment: input }), 'lastDeployment')).toBe('');
    },
  );

  it('keeps a valid Date for lastDeployment as a copy and drops an invalid one', () => {
    const when = new Date(2026, 5, 30, 12, 0, 0, 7);
    const value = getSiteValue(set({ lastDeployment: when }), 'lastDeployment');
    expect(value).not.toBe(when);
    expect((value as Date).getTime()).toBe(when.getTime());
    expect(getSiteValue(set({ lastDeployment: new Date(Number.NaN) }), 'lastDeployment')).toBe('');
  });

  it('accepts only structs for errors and truncates lastUpdateBy to 50 trimmed characters', () => {
    expect(getSiteValue(set({ errors: { siteid: 'bad' } }), 'errors')).toEqual({ siteid: 'bad' });
    expect(getSiteValue(set({ errors: 'x' }), 'errors')).toBe('');
    expect(getSiteValue(set({ errors: ['x'] }), 'errors')).toBe('');
    expect(getSiteValue(set({ lastUpdateBy: `  ${'n'.repeat(60)}  ` }), 'lastUpdateBy')).toBe('n'.repeat(50));
  });
});

describe('readBean', () => {
  const row: SiteRow = {
    siteid: 'default',
    site: ' Default ',
    pagelimit: 1000,
    domain: 'localhost',
    domainalias: null,
    remoteport: null,
    usessl: null,
    extranetssl: 1,
    baseid: null,
    publicuserpoolid: 'umbrella',
    maxnestlevel: 4,
    filedir: 'files',
    archivedate: new Date(2026, 0, 1),
    lastdeployment: new Date(2026, 0, 2, 3, 4, 5),
  };

  it('loads the read fields through setValue: NULL as empty, numbers as CF text, trimmed text, pools defaulted', () => {
    const bean = readBean(row, 'K'.repeat(35));
    expect(bean.isNew).toBe(0);
    expect(getSiteValue(bean, 'site')).toBe('Default');
    expect(getSiteValue(bean, 'pagelimit')).toBe('1000');
    expect(getSiteValue(bean, 'domainAlias')).toBe('');
    expect(getSiteValue(bean, 'remoteport')).toBe('80');
    expect([getSiteValue(bean, 'useSSL'), getSiteValue(bean, 'extranetSSL')]).toEqual(['0', '1']);
    expect(getSiteValue(bean, 'baseID')).toBe('K'.repeat(35));
    expect(getSiteValue(bean, 'publicUserPoolID')).toBe('umbrella');
    expect(getSiteValue(bean, 'privateUserPoolID')).toBe('default');
    expect((getSiteValue(bean, 'lastDeployment') as Date).getTime()).toBe(new Date(2026, 0, 2, 3, 4, 5).getTime());
  });

  it('ignores columns outside the read list', () => {
    const bean = readBean(row);
    for (const column of ['maxnestlevel', 'filedir', 'archivedate']) expect(getSiteValue(bean, column)).toBe('');
    expect(getSiteValue(bean, 'baseID')).toBe('');
  });
});

describe('updateColumnValues', () => {
  it('returns exactly the update columns, with the init defaults for a new bean', () => {
    const values = updateColumnValues(set({ siteid: 'tenant-a' }));
    expect(Object.keys(values)).toEqual([...UPDATE_COLUMNS]);
    expect(values).toMatchObject({ locking: 'None', remoteport: '80', baseid: 'B', filepoolid: 'tenant-a' });
  });

  it.each([
    ['domain', 'trimmed, null when empty', ' x ', 'x', ''],
    ['contactemail', 'trimmed, null when empty', ' a@b.c ', 'a@b.c', ''],
    ['customtaggroups', 'trimmed, null when empty', ' a^b ', 'a^b', ''],
    ['recaptchasitekey', 'trimmed, null when blank', ' k ', 'k', '   '],
    ['placeholderimgext', 'trimmed, null when blank', ' png ', 'png', ' '],
    ['sendloginscript', 'untrimmed, null when empty', ' s ', ' s ', ''],
    ['mailservertls', 'untrimmed, null when empty', ' true ', ' true ', ''],
  ])('writes %s %s', (column, _rule, value, written, nullInput) => {
    expect(updateColumnValues(beanWith({ [column]: value }))[column]).toBe(written);
    expect(updateColumnValues(beanWith({ [column]: nullInput }))[column]).toBeNull();
  });

  const rawColumns = ['site', 'tagline', 'enablelockdown', 'baseid', 'locking', 'pagelimit', 'publicuserpoolid'];

  it.each([...rawColumns, 'smallimagewidth'])('writes %s raw and never null', (column) => {
    expect(updateColumnValues(beanWith({ [column]: ' r ' }))[column]).toBe(' r ');
    expect(updateColumnValues(beanWith({ [column]: '' }))[column]).toBe('');
  });

  it('writes the effective broadcaster and data collection flags', () => {
    const bean = beanWith({ emailbroadcaster: '1', datacollection: '1' });
    expect(updateColumnValues(bean)).toMatchObject({ emailbroadcaster: '0', datacollection: '1' });
    const on = { ...LEGACY_GLOBAL_CONFIG_DEFAULTS, emailBroadcaster: true, dataCollection: false };
    expect(updateColumnValues(bean, on)).toMatchObject({ emailbroadcaster: '1', datacollection: '0' });
    expect(effectiveEmailBroadcaster(bean)).toBe('0');
    expect(effectiveDataCollection(bean, on)).toBe('0');
  });

  it.each([
    ['0', '0', '0'],
    ['1', '0', '1'],
    ['0', '1', '1'],
    ['1', '', '1'],
    ['false', 'yes', '1'],
  ])('writes useSSL as the effective flag (useSSL %j, extranetSSL %j -> %j)', (useSSL, extranetSSL, expected) => {
    const bean = beanWith({ usessl: useSSL, extranetssl: extranetSSL });
    expect(effectiveUseSSL(bean)).toBe(expected);
    expect(updateColumnValues(bean).usessl).toBe(expected);
  });

  it('fails like CF when extranetSSL must be read as a boolean and is not one', () => {
    expect(() => effectiveUseSSL(beanWith({ usessl: '0', extranetssl: '' }))).toThrow(TypeError);
  });

  it('falls back to the index file display URLs, so login and profile URLs are never null', () => {
    const config = { ...LEGACY_GLOBAL_CONFIG_DEFAULTS, indexFile: '/index.cfm' };
    const empty = beanWith({ loginurl: '', editprofileurl: '' });
    expect(updateColumnValues(empty)).toMatchObject({
      loginurl: '?display=login',
      editprofileurl: '?display=editProfile',
    });
    expect(effectiveLoginURL(empty, config)).toBe('/index.cfm?display=login');
    expect(effectiveEditProfileURL(empty, config)).toBe('/index.cfm?display=editProfile');
    const custom = beanWith({ loginurl: '/login', editprofileurl: '/profile' });
    expect(updateColumnValues(custom, config)).toMatchObject({ loginurl: '/login', editprofileurl: '/profile' });
  });

  it('throws when an update column holds a complex value', () => {
    expect(() => updateColumnValues(set({ googleAPIKey: { key: 1 } }))).toThrow(TypeError);
  });
});

describe('list order', () => {
  it.each([
    [undefined, undefined, 'orderno', 'ORDER BY orderno ASC NULLS FIRST'],
    ['DOMAIN', 'DESC', 'domain', 'ORDER BY lower(domain) DESC NULLS LAST'],
    ['Site', 'Asc', 'site', 'ORDER BY lower(site) ASC NULLS FIRST'],
    ['name', 'sideways', 'orderno', 'ORDER BY orderno ASC NULLS FIRST'],
    [' site', 'asc', 'orderno', 'ORDER BY orderno ASC NULLS FIRST'],
    ['orderno; drop table tsettings', 'desc', 'orderno', 'ORDER BY orderno DESC NULLS LAST'],
  ])('listOrderSql(%j, %j) orders by %s', (sortBy, sortDirection, column, sql) => {
    const order = listOrderSql(sortBy, sortDirection);
    expect(order.column).toBe(column);
    expect(order.sql).toBe(sql);
    expect(order.nulls).toBe(order.direction === 'ASC' ? 'FIRST' : 'LAST');
  });

  const rows: SiteRow[] = [
    { siteid: 'b', site: 'Beta', domain: 'B.example', orderno: 10 },
    { siteid: 'a', site: 'alpha', domain: 'a.example', orderno: 2 },
    { siteid: 'n', site: null, domain: null, orderno: null },
    { siteid: 'e', site: 'Écho', domain: '', orderno: '3' },
    { siteid: 'a2', site: 'ALPHA', domain: 'A.example', orderno: 2 },
  ];
  const ids = (sorted: SiteRow[]): unknown[] => sorted.map((r) => r.siteid);

  it.each([
    ['domain', 'asc', ['n', 'e', 'a', 'a2', 'b']],
    ['domain', 'desc', ['b', 'a', 'a2', 'e', 'n']],
    ['SITE', 'ASC', ['n', 'a', 'a2', 'b', 'e']],
    ['orderno', 'asc', ['n', 'a', 'a2', 'e', 'b']],
    ['orderno', 'desc', ['b', 'e', 'a', 'a2', 'n']],
    ['bogus', 'bogus', ['n', 'a', 'a2', 'e', 'b']],
  ])('sortSites by %s %s keeps ties in input order', (sortBy, sortDirection, expected) => {
    expect(ids(sortSites(rows, sortBy, sortDirection))).toEqual(expected);
  });

  it('sorts by orderno ascending by default without changing its input', () => {
    const input = [...rows];
    expect(ids(sortSites(input))).toEqual(['n', 'a', 'a2', 'e', 'b']);
    expect(input).toEqual(rows);
  });
});
