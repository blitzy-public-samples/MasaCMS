/** Advanced-search criteria, queryParam and cusers nextN paging against queryParam.cfc, userGateway.cfc, utility.getNextN and admin/Application.cfc. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError, type LegacyQuery } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import type { MetadataTx, QueryConfig, QueryResult, QueryResultRow, TenantDb, TenantTx } from '@opt2/platform/tenancy';
import {
  DENIED_FEED_JOIN_TABLES,
  SEARCH_FIELD_LIST,
  SEARCH_MAX_ROWS,
  SORT_OPTIONS,
  USERS_LIST_COLUMNS,
  buildAdvancedSearchCriteria,
  getAdvancedSearch,
  newAdvancedSearchCriteria,
  nextN,
  pageRows,
  paramCondition,
  parseQueryParam,
  viewerScope,
  type AdvancedSearchCriteria,
  type AdvancedSearchOptions,
  type NextN,
  type QueryParam,
  type SearchDeps,
  type SearchParamEntry,
  type UserFeedKeys,
  type ViewerScope,
} from '../../src/domain/search.js';
import type { AccountView } from '../../src/legacy/identity-client.js';
import type { PeopleRepository } from '../../src/repo/repository.js';
import type { PersonRow } from '../../src/repo/tables.js';

const legacyFile = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');
const GATEWAY_CFC = legacyFile('core/mura/user/userGateway.cfc');
const CONFIG_CFC = legacyFile('core/mura/configBean.cfc');

/** The first capture of `pattern` in a legacy source. */
const captured = (source: string, pattern: RegExp): string => pattern.exec(source)?.[1] ?? '';

const TID = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const POOL_TID = TENANT_UMBRELLA.tenantId;
const POOL_SITE = TENANT_UMBRELLA.siteId;
const VIEWER: ViewerScope = { tid: TID, site: SITE, isS2: false };

/** A char(35) Masa id ending in `n`. */
const uid = (n: number): string => `5E1D0C00-0000-4000-8000${String(n).padStart(12, '0')}`;
const ARCHER = uid(1);
const BAKER = uid(2);
const COLE = uid(3);
const NIA = uid(4);
const SAGE = uid(5);
const PRICE = uid(6);
const GHOST = uid(7);
const UMBER = uid(8);
const ADMIN = uid(99);
const PHOTO = 'F0F0F0F0-0000-4000-8000000000000001';
const LAST_UPDATE = new Date(2026, 5, 1, 9, 30, 0);

function person(userid: string, overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    tenant_id: TID,
    userid,
    groupname: null,
    fname: null,
    lname: null,
    email: null,
    company: null,
    jobtitle: null,
    mobilephone: null,
    website: null,
    subtype: 'Default',
    ext: null,
    contactform: null,
    lastupdate: LAST_UPDATE,
    lastupdateby: 'Admin User',
    lastupdatebyid: ADMIN,
    siteid: SITE,
    subscribe: null,
    notes: null,
    description: null,
    interests: null,
    keepprivate: 0,
    photofileid: null,
    imname: null,
    imservice: null,
    created: null,
    tags: null,
    row_version: '1',
    ...overrides,
  };
}

function account(userId: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    userId,
    siteId: SITE,
    username: null,
    s2: 0,
    isPublic: 1,
    inactive: 0,
    type: 2,
    perm: 0,
    admin: 0,
    remoteId: null,
    lastLogin: null,
    passwordCreated: null,
    tablist: null,
    ...overrides,
  };
}

// Visible to a non-S2 viewer in the public pool: Nia (no last name), Archer, Baker, Cole.
const PERSONS: readonly PersonRow[] = [
  person(ARCHER, {
    fname: 'Ann',
    lname: 'Archer',
    email: 'ann.archer@example.com',
    company: 'Acme',
    subscribe: 1,
    created: new Date(2026, 5, 5, 9, 5, 0),
    photofileid: PHOTO,
  }),
  person(BAKER, { fname: 'Bob', lname: 'Baker', email: 'bob@example.com', company: 'Beta_Co', subscribe: 0, created: new Date(2026, 5, 5) }),
  person(COLE, { fname: 'Zoë', lname: 'Cole', company: 'BetaXCo', subscribe: 0, created: new Date(2026, 0, 10, 14, 30, 0) }),
  person(NIA, { fname: 'Nia', email: 'nia@example.com' }),
  person(SAGE, { fname: 'Sam', lname: 'Sage', company: 'Acme' }),
  person(PRICE, { fname: 'Pat', lname: 'Price' }),
  person(GHOST, { fname: 'Gus', lname: 'Ghost' }),
  person(UMBER, { tenant_id: POOL_TID, siteid: POOL_SITE, fname: 'Uma', lname: 'Umber' }),
];

const ACCOUNTS: readonly AccountView[] = [
  account(ARCHER, { username: 'aarcher', lastLogin: '2026-06-20T08:00:00.25', passwordCreated: '2026-02-01T08:00:00' }),
  // Identity may spell the id in another case; SQL Server's collation still joins it.
  account(`${BAKER.toLowerCase()} `, { username: 'bbaker', admin: 1 }),
  account(COLE, { username: 'zcole', inactive: 1, lastLogin: '2026-05-01T10:00:00' }),
  account(NIA, { username: 'nia', inactive: null, passwordCreated: 'unknown' }),
  account(SAGE, { username: 'ssage', s2: 1 }),
  account(PRICE, { username: 'pprice', isPublic: 0 }),
  account(UMBER, { siteId: POOL_SITE, username: 'uumber' }),
];

/** Implied-join rows by people table name. */
const JOIN_ROWS: Readonly<Record<string, readonly QueryResultRow[]>> = {
  user_address: [
    { tenant_id: TID, addressid: 'AD1', userid: ARCHER, city: 'Leeds', latitude: 40.712776, longitude: -74.005974 },
    { tenant_id: TID, addressid: 'AD2', userid: ARCHER, city: 'leeds ', latitude: null, longitude: null },
    { tenant_id: TID, addressid: 'AD3', userid: BAKER, city: 'York', latitude: 51.5, longitude: 1234567 },
    { tenant_id: TID, addressid: 'AD4', userid: COLE, city: 'Hull', latitude: 0, longitude: 0.0000123 },
  ],
  user_tag: [
    { tenant_id: TID, tagid: 1, userid: ARCHER, tag: 'VIP' },
    { tenant_id: TID, tagid: 2, userid: BAKER, tag: 'vip-gold' },
    { tenant_id: TID, tagid: 3, userid: COLE, tag: 'regular' },
  ],
  user_interest: [
    { tenant_id: TID, userid: ARCHER, categoryid: 'C1' },
    { tenant_id: TID, userid: COLE, categoryid: 'C2' },
    { tenant_id: TID, userid: BAKER, categoryid: 'C3' },
  ],
};

const idKey = (id: string): string => id.trim().toUpperCase();
const MEMBERSHIPS = new Map([
  [ARCHER, ['G1']],
  [BAKER, ['g1 ']],
  [COLE, ['G2']],
]);

/** A `tenant_registry` row of site tenant-a; both user pools are its own unless overridden. */
function registryRow(overrides: QueryResultRow = {}): QueryResultRow {
  return {
    site_id: SITE,
    tenant_id: TID,
    public_user_pool_id: null,
    private_user_pool_id: null,
    category_pool_id: null,
    file_pool_id: null,
    display_pool_id: null,
    content_pool_ids: [],
    public_user_pool_tenant: null,
    private_user_pool_tenant: null,
    category_pool_tenant: null,
    file_pool_tenant: null,
    display_pool_tenant: null,
    content_pool_tenants: [],
    domains: [],
    aggregate_version: '1',
    updated_at: LAST_UPDATE,
    ...overrides,
  };
}

// The public pool is the umbrella site; the private pool falls back to tenant-a itself.
const SPLIT_POOLS = registryRow({ public_user_pool_id: POOL_SITE, public_user_pool_tenant: POOL_TID, private_user_pool_id: '' });

function result<R extends QueryResultRow>(rows: readonly QueryResultRow[]): QueryResult<R> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows: rows as R[] };
}

interface World {
  registry?: QueryResultRow;
  photoFileExts?: SearchDeps['photoFileExts'];
}

/** In-memory collaborators over PERSONS, ACCOUNTS, JOIN_ROWS and MEMBERSHIPS. */
function searchDeps({ registry = registryRow(), photoFileExts }: World = {}): SearchDeps {
  const tenantTx = (tenantId: string): TenantTx => ({
    kind: 'tenant',
    tenantId,
    schema: 'people',
    onCommit: () => undefined,
    query: <R extends QueryResultRow>(text: string | QueryConfig, values?: unknown[]) => {
      const table = /FROM "people"\."(\w+)"/.exec(typeof text === 'string' ? text : text.text)?.[1] ?? '';
      return Promise.resolve(result<R>((JOIN_ROWS[table] ?? []).filter((row) => row.tenant_id === values?.[0])));
    },
  });
  const metadataTx: MetadataTx = {
    kind: 'metadata',
    schema: 'people',
    onCommit: () => undefined,
    query: <R extends QueryResultRow>(_text: string | QueryConfig, values?: unknown[]) =>
      Promise.resolve(result<R>([registry].filter((row) => row.tenant_id === values?.[0]))),
  };
  const db: TenantDb = {
    schema: 'people',
    withTenant: (tenantId, fn) => fn(tenantTx(tenantId)),
    withMetadata: (fn) => fn(metadataTx),
    end: () => Promise.resolve(),
  };
  const repo: Pick<PeopleRepository, 'schema' | 'read' | 'queryPersons' | 'listPersonsForSite' | 'listExtendData' | 'listExtendAttributes'> = {
    schema: 'people',
    read: (_tx, _units, fn) => fn(),
    queryPersons: (tx) => Promise.resolve(PERSONS.filter((row) => row.tenant_id === tx.tenantId)),
    listPersonsForSite: (tx, siteId) => Promise.resolve(PERSONS.filter((row) => row.tenant_id === tx.tenantId && row.siteid === siteId)),
    listExtendData: () => Promise.resolve([]),
    listExtendAttributes: () => Promise.resolve([]),
  };
  return {
    db,
    repo: repo as PeopleRepository,
    identity: {
      readAccounts: (ids) =>
        Promise.resolve(new Map(ACCOUNTS.filter((a) => ids.some((id) => idKey(id) === idKey(a.userId))).map((a) => [a.userId, a]))),
      membershipGroupIds: (userId) => Promise.resolve(MEMBERSHIPS.get(userId) ?? []),
    },
    ...(photoFileExts === undefined ? {} : { photoFileExts }),
  };
}

type Criteria = Partial<AdvancedSearchCriteria> & UserFeedKeys;

/** getAdvancedSearch over the in-memory world, from the session defaults plus `criteria`. */
function search(criteria: Criteria = {}, options: AdvancedSearchOptions = {}, world: World = {}, viewer: ViewerScope = VIEWER): Promise<LegacyQuery> {
  return getAdvancedSearch(searchDeps(world), viewer, { ...newAdvancedSearchCriteria(), ...criteria }, options);
}

/** One stored criteria row in session.paramArray. */
const param = (field: string, condition: string, criteria: string, relationship = 'and'): SearchParamEntry => ({
  field,
  condition,
  criteria,
  relationship,
});
const where = (...paramArray: SearchParamEntry[]): Criteria => ({ paramArray, paramCount: paramArray.length });
const lnames = (query: LegacyQuery): unknown[] => query.rows.map((row) => row.Lname);
const lnamesWhere = async (...entries: SearchParamEntry[]): Promise<unknown[]> => lnames(await search(where(...entries)));

/** Asserts `pending` rejects with the server_error a failing SQL Server query answers. */
async function expectServerError(pending: Promise<unknown>): Promise<void> {
  const err: unknown = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(LegacyApiError);
  expect(err).toMatchObject({ type: 'server_error' });
}

const ALL = [null, 'Archer', 'Baker', 'Cole'];
const LNAME = 'tusers.lname^varchar';
const COMPANY = 'tusers.company^varchar';
const CLOSE = param('', '', '', ')');

describe('legacy constants', () => {
  it('lists getSearch columns in userGateway fieldList order', () => {
    const fieldList = captured(GATEWAY_CFC, /variables\.fieldList="([^"]+)"/);
    expect(fieldList.split(',').map((item) => item.trim().split(' ').at(-1)?.split('.').at(-1))).toEqual([...SEARCH_FIELD_LIST]);
  });

  it('lists getUsers columns', () => {
    expect(captured(GATEWAY_CFC, /SELECT (UserID, [^\r\n]+)/).trim().split(/,\s*/)).toEqual([...USERS_LIST_COLUMNS]);
  });

  it('caps getSearch at its SQL Server maxrows', () => {
    expect(String(SEARCH_MAX_ROWS)).toBe(captured(GATEWAY_CFC, /name="getSearch"[\s\S]*?maxrows=(\d+)/));
  });

  it('keeps getAdvancedSearch sortOptions, isPubic typo included', () => {
    expect(SORT_OPTIONS).toBe(captured(GATEWAY_CFC, /sortOptions="([^"]+)"/));
  });

  it('keeps configBean deniedFeedJoinTables', () => {
    expect(DENIED_FEED_JOIN_TABLES).toBe(captured(CONFIG_CFC, /deniedFeedJoinTables="([^"]+)"/));
  });
});

describe('viewerScope', () => {
  it('maps verified claims', () => {
    expect(viewerScope({ tid: TID, site: SITE, s2: true })).toStrictEqual({ tid: TID, site: SITE, isS2: true });
  });
});

describe('newAdvancedSearchCriteria', () => {
  it('holds the admin session defaults', () => {
    expect(newAdvancedSearchCriteria()).toStrictEqual({
      paramArray: [],
      paramCount: 0,
      paramCircuit: '',
      paramCategories: '',
      paramGroups: '',
      inActive: '',
      membersOnly: false,
      visitorStatus: 'All',
    });
  });

  it('returns fresh state per call', () => {
    expect(newAdvancedSearchCriteria().paramArray).not.toBe(newAdvancedSearchCriteria().paramArray);
  });
});

describe('buildAdvancedSearchCriteria', () => {
  const previous: AdvancedSearchCriteria = {
    ...newAdvancedSearchCriteria(),
    paramArray: [param(LNAME, 'Equals', 'kept')],
    paramCount: 1,
    paramCircuit: 'cUsers',
  };
  const context = (entries: Record<string, unknown>) => new Map(Object.entries(entries));
  const entry = (n: string, field: string, criteria: string, relationship = 'and', condition = 'Equals') => ({
    [`paramField${n}`]: field,
    [`paramCriteria${n}`]: criteria,
    [`paramRelationship${n}`]: relationship,
    [`paramCondition${n}`]: condition,
  });

  it.each([
    ['no param', context({ muraAction: 'cUsers.advancedSearch' })],
    ['an empty param', context({ param: '', muraAction: 'cUsers.advancedSearch' })],
  ])('keeps the previous criteria for %s', (_label, ctx) => {
    expect(buildAdvancedSearchCriteria(ctx, previous)).toBe(previous);
  });

  it('rebuilds from the numbered params, skipping unselected fields and empty criteria', () => {
    const ctx = context({
      param: '1,2,3,4,,5',
      ...entry('1', 'tusers.fname^varchar', 'an', 'and', 'Contains'),
      paramField2: 'select field',
      paramField3: '',
      paramField4: LNAME,
      paramCriteria4: '',
      PARAMFIELD5: 'tuseraddresses.city^varchar',
      paramcriteria5: 'Leeds',
      ParamRelationship5: 'or',
      PARAMCONDITION5: 'Equals',
      muraAction: 'core:cUsers.advancedSearch',
      categoryID: 'C1',
      groupID: 'G1',
      inActive: 1,
      membersOnly: true,
      visitorStatus: 'Members',
    });
    expect(buildAdvancedSearchCriteria(ctx, previous)).toStrictEqual({
      paramArray: [param('tusers.fname^varchar', 'Contains', 'an'), param('tuseraddresses.city^varchar', 'Equals', 'Leeds', 'or')],
      paramCount: 2,
      paramCircuit: 'cUsers',
      paramCategories: 'C1',
      paramGroups: 'G1',
      inActive: '1',
      membersOnly: true,
      visitorStatus: 'Members',
    });
  });

  it('applies the request.context defaults', () => {
    const built = buildAdvancedSearchCriteria(context({ param: '1', ...entry('1', LNAME, 'x'), muraAction: 'cUsers.advancedSearch' }), previous);
    expect(built).toMatchObject({ paramCount: 1, paramCategories: '', paramGroups: '', inActive: '0', membersOnly: false, visitorStatus: 'All' });
  });

  it('keeps present but empty values over the defaults', () => {
    const ctx = context({ param: '1', ...entry('1', LNAME, 'x'), muraAction: 'cUsers.list', inActive: '', membersOnly: 'false' });
    const built = buildAdvancedSearchCriteria(ctx, previous);
    expect(built).toMatchObject({ inActive: '', membersOnly: 'false' });
  });

  it('resets the session criteria when every row is skipped', () => {
    const built = buildAdvancedSearchCriteria(context({ param: '1', paramField1: 'Select Field', muraAction: 'cPerm.main' }), previous);
    expect(built).toMatchObject({ paramArray: [], paramCount: 0, paramCircuit: 'cPerm' });
  });

  it.each([
    ['cUsers.advancedSearch', 'cUsers'],
    ['core:cusers.search', 'cusers'],
    ['cUsers', 'cUsers'],
  ])('reads paramCircuit %s as %s', (muraAction, circuit) => {
    expect(buildAdvancedSearchCriteria(context({ param: '1', paramField1: '', muraAction }), previous).paramCircuit).toBe(circuit);
  });

  it.each([
    ['paramField1', { param: '1' }],
    ['paramCriteria1', { param: '1', paramField1: LNAME }],
    ['paramRelationship1', { param: '1', paramField1: LNAME, paramCriteria1: 'x' }],
    ['paramCondition1', { param: '1', paramField1: LNAME, paramCriteria1: 'x', paramRelationship1: 'and' }],
  ])('fails as ACF does without %s', (name, values) => {
    expect(() => buildAdvancedSearchCriteria(context({ ...values, muraAction: 'cUsers.advancedSearch' }), previous)).toThrow(
      new TypeError(`Element ${name.toUpperCase()} is undefined in a CFML structure referenced as part of an expression.`),
    );
  });
});

describe('parseQueryParam', () => {
  const base = { field: 'tusers.lname', dataType: 'varchar' };

  it('applies queryParam.init defaults', () => {
    expect(parseQueryParam({})).toStrictEqual({ relationship: '', field: '', dataType: '', condition: '=', criteria: '', isValid: false });
  });

  it.each<[string, string, string, boolean]>([
    ['tusers.l name;--', 'and', 'tusers.lname', true],
    ['$%^', 'and', '', false],
    ['', 'and', '', false],
    // setField compares 'Select Field' only after stripping the space, so the option text is a valid field.
    ['Select Field', 'and', 'SelectField', true],
    ['', ')', '', true],
    ['', 'or (', '', true],
  ])('sanitizes field %j under %j', (field, relationship, expected, isValid) => {
    expect(parseQueryParam({ field, relationship, criteria: 'x' })).toMatchObject({ field: expected, isValid });
  });

  it.each<[string, string | undefined, string]>([
    ['AND', undefined, 'AND'],
    ['or not (', undefined, 'or not ('],
    ['closeGrouping', undefined, 'closeGrouping'],
    ['xor', undefined, ''],
    ['xor', 'or', 'or'],
    ['', 'and (', 'and ('],
  ])('keeps relationship %j after %j as %j', (relationship, prior, expected) => {
    const previous = prior === undefined ? undefined : parseQueryParam({ ...base, relationship: prior });
    expect(parseQueryParam({ ...base, relationship }, previous).relationship).toBe(expected);
  });

  it.each([
    ['Equals', 'varchar', '='],
    ['eq', 'varchar', '='],
    ['IS', 'varchar', '='],
    ['=', 'varchar', '='],
    ['GT', 'numeric', '>'],
    ['>', 'numeric', '>'],
    ['in', 'varchar', 'in'],
    ['NOTIN', 'varchar', 'not in'],
    ['not in', 'varchar', 'not in'],
    ['NEQ', 'varchar', '!='],
    ['!=', 'varchar', '!='],
    ['GTE', 'numeric', '>='],
    ['>=', 'numeric', '>='],
    ['LT', 'numeric', '<'],
    ['<', 'numeric', '<'],
    ['LTE', 'numeric', '<='],
    ['<=', 'numeric', '<='],
    ['Begins', 'varchar', 'like'],
    ['BeginsWith', 'longvarchar', 'like'],
    ['Contains', 'varchar', 'like'],
    ['ContainsValue', 'varchar', 'like'],
    ['Like', 'varchar', 'like'],
    ['Ends', 'varchar', 'like'],
    ['EndsWith', 'varchar', 'like'],
    ['Contains', 'date', '='],
    ['Begins', 'numeric', '='],
  ])('maps condition %s on %s to %s', (condition, dataType, expected) => {
    expect(parseQueryParam({ field: 'tusers.lname', dataType, condition, criteria: '5' }).condition).toBe(expected);
  });

  it('keeps the previous condition for an unknown name', () => {
    expect(parseQueryParam({ ...base, condition: 'Approx' }).condition).toBe('');
    expect(parseQueryParam({ ...base, condition: 'Approx' }, parseQueryParam({ ...base, condition: 'GT' })).condition).toBe('>');
  });

  it.each<[string, string, string, string, string | Date]>([
    ['varchar', 'Begins', 'ab', 'varchar', 'ab%'],
    ['varchar', 'BeginsWith', 'ab', 'varchar', 'ab%'],
    ['varchar', 'Ends', 'ab', 'varchar', '%ab'],
    ['varchar', 'EndsWith', 'ab', 'varchar', '%ab'],
    ['varchar', 'Contains', 'ab', 'varchar', '%ab%'],
    ['varchar', 'ContainsValue', 'ab', 'varchar', '%ab%'],
    ['varchar', 'Like', 'ab', 'varchar', '%ab%'],
    ['varchar', 'Equals', 'ab', 'varchar', 'ab'],
    ['longvarchar', 'contains', 'ab', 'longvarchar', '%ab%'],
    ['var-char', 'Contains', 'ab', 'varchar', '%ab%'],
    ['varchar', 'Contains', 'NULL', 'varchar', 'null'],
    ['numeric', 'Equals', 'null', 'numeric', 'null'],
    ['bit', 'Equals', 'yes', 'bit', 'yes'],
    ['bit', 'Equals', 'maybe', 'bit', ''],
    ['boolean', 'Equals', '0', 'bit', '0'],
    ['numeric', 'GT', '12.5', 'numeric', '12.5'],
    ['numeric', 'GT', 'abc', 'numeric', ''],
    ['date', 'Equals', '06/05/2026 9:05:30 AM', 'date', new Date(2026, 5, 5)],
    ['date', 'Equals', "{ts '2026-06-05 09:05:30'}", 'date', new Date(2026, 5, 5)],
    ['date', 'Equals', 'soon', 'date', ''],
    ['datetime', 'GT', '06/05/2026 9:05:30 AM', 'timestamp', new Date(2026, 5, 5, 9, 5, 30)],
    ['timestamp', 'GT', '2026-06-05 09:05:30.750', 'timestamp', new Date(2026, 5, 5, 9, 5, 30)],
    ['timestamp', 'GT', "{ts '2026-06-05 09:05:30'}", 'timestamp', new Date(2026, 5, 5, 9, 5, 30)],
    ['timestamp', 'GT', 'soon', 'timestamp', ''],
    ['time', 'GT', '9:05 AM', 'time', new Date(1899, 11, 30, 9, 5)],
    ['time', 'GT', 'soon', 'time', ''],
    ['integer', 'Equals', '7', 'integer', ''],
  ])('sets %s %s %j as %s %j', (dataType, condition, criteria, expectedType, expected) => {
    expect(parseQueryParam({ field: 'tusers.lname', dataType, condition, criteria })).toMatchObject({ dataType: expectedType, criteria: expected });
  });

  it('keeps the previous criteria for a data type setCriteria has no case for', () => {
    const previous = parseQueryParam({ field: 'tusers.fname', dataType: 'varchar', condition: 'Begins', criteria: 'a' });
    expect(parseQueryParam({ field: 'tusers.lname', dataType: 'integer', criteria: '7' }, previous).criteria).toBe('a%');
  });

  it.each<[string, Partial<QueryParam>]>([
    ['2026-06-05', { dataType: 'timestamp', condition: '=', criteria: new Date(2026, 5, 5) }],
    ['06/05/2026 9:05:30 AM', { dataType: 'timestamp', condition: '=', criteria: new Date(2026, 5, 5, 9, 5, 30) }],
    ['abc', { dataType: '', condition: '=', criteria: '' }],
    ['', { dataType: '', condition: '=', criteria: '' }],
  ])('types untyped criteria %j by its date shape', (criteria, expected) => {
    expect(parseQueryParam({ field: 'x', condition: 'Contains', criteria })).toMatchObject(expected);
  });
});

describe('paramCondition', () => {
  it.each<[string, string | Date, string | undefined]>([
    ['=', 'null', 'is'],
    ['=', 'NULL', 'is'],
    ['!=', 'null', 'is not'],
    ['>', 'null', undefined],
    ['like', 'null', undefined],
    ['like', '%a%', 'like'],
    ['=', 'nullable', '='],
    ['=', new Date(2026, 5, 5), '='],
  ])('reads %s against %j as %s', (condition, criteria, expected) => {
    expect(paramCondition({ condition, criteria })).toBe(expected);
  });
});

describe('getAdvancedSearch criteria', () => {
  it('lists the pool users a non-S2 viewer sees by last name, NULLs first', async () => {
    expect(lnames(await search())).toEqual(ALL);
  });

  it.each<[string, string, string, unknown[]]>([
    [LNAME, 'Equals', 'archer ', ['Archer']],
    [LNAME, 'Begins', 'b', ['Baker']],
    [LNAME, 'Contains', 'OLE', ['Cole']],
    [LNAME, 'EndsWith', 'er', ['Archer', 'Baker']],
    [LNAME, 'NEQ', 'Baker', ['Archer', 'Cole']],
    [LNAME, 'GT', 'B', ['Baker', 'Cole']],
    [LNAME, 'GTE', 'baker', ['Baker', 'Cole']],
    [LNAME, 'LT', 'Baker', ['Archer']],
    [LNAME, 'LTE', 'Baker', ['Archer', 'Baker']],
    [LNAME, 'Like', 'b%r', ['Baker']],
    [LNAME, 'Begins', '[ab]', ['Archer', 'Baker']],
    [LNAME, 'Begins', '[^ab]', ['Cole']],
    ['tusers.lname^longvarchar', 'Contains', 'ak', ['Baker']],
    ['lname^varchar', 'Begins', 'c', ['Cole']],
    [COMPANY, 'Contains', 'Beta_Co', ['Baker', 'Cole']],
    ['tusers.email^varchar', 'Contains', 'n.a', ['Archer']],
    ['tusers.fname^varchar', 'Equals', 'zoe', []],
    ['tusers.fname^varchar', 'Equals', 'ZOË', ['Cole']],
    ['tusers.username^varchar', 'Begins', 'z', ['Cole']],
    [COMPANY, 'Equals', 'null', [null]],
    [COMPANY, 'NEQ', 'NULL', ['Archer', 'Baker', 'Cole']],
    [LNAME, 'IN', 'Archer,cole', ['Archer', 'Cole']],
    [LNAME, 'NOT IN', 'Archer', ['Baker', 'Cole']],
    ['tusers.lname^nvarchar', 'Equals', 'Archer', []],
  ])('matches %s %s %j as SQL Server text', async (field, condition, criteria, expected) => {
    expect(await lnamesWhere(param(field, condition, criteria))).toEqual(expected);
  });

  it.each<[string, string, string, unknown[]]>([
    ['tusers.created^date', 'Equals', '06/05/2026', ['Baker']],
    ['tusers.created^date', 'Begins', '06/05/2026', ['Baker']],
    ['tusers.created^date', 'GT', '06/05/2026', ['Archer']],
    ['tusers.created^date', 'GTE', 'June 5, 2026', ['Archer', 'Baker']],
    ['tusers.created^date', 'LT', '2026-06-05', ['Cole']],
    ['tusers.created^datetime', 'Equals', '06/05/2026 9:05:00 AM', ['Archer']],
    ['tusers.created^timestamp', 'Equals', '2026-06-05 09:05:00.500', ['Archer']],
    ['tusers.created^time', 'GT', '9:05 AM', ['Archer', 'Baker', 'Cole']],
    ['tusers.created^varchar', 'Contains', 'Jun  5 2026', ['Archer', 'Baker']],
    ['tusers.created^varchar', 'Contains', '12:00AM', ['Baker']],
    ['tusers.created^varchar', 'Contains', '2:30PM', ['Cole']],
    ['tusers.created^varchar', 'Equals', '2026-06-05 09:05:00', ['Archer']],
    ['tusers.lastlogin^timestamp', 'GTE', '06/01/2026', ['Archer']],
    ['tusers.subscribe^numeric', 'Equals', '1', ['Archer']],
    ['tusers.admin^numeric', 'Equals', '1', ['Baker']],
    ['tusers.subscribe^numeric', 'LT', '1', ['Baker', 'Cole']],
    ['tusers.subscribe^varchar', 'Equals', '0', ['Baker', 'Cole']],
    ['tusers.subscribe^varchar', 'Contains', '1', ['Archer']],
    ['tusers.subscribe^varchar', 'IN', '1,5', ['Archer']],
    ['tusers.inactive^bit', 'Equals', 'yes', ['Cole']],
    ['tusers.inactive^boolean', 'Equals', 'false', ['Archer', 'Baker']],
  ])('matches %s %s %j as SQL Server dates and numbers', async (field, condition, criteria, expected) => {
    expect(await lnamesWhere(param(field, condition, criteria))).toEqual(expected);
  });

  it.each<[string, string, string, unknown[]]>([
    ['tuseraddresses.city^varchar', 'Equals', 'Leeds', ['Archer', 'Archer']],
    ['tuseraddresses.latitude^varchar', 'Contains', '40.7128', ['Archer']],
    ['tuseraddresses.latitude^varchar', 'Begins', '0', ['Cole']],
    ['tuseraddresses.longitude^varchar', 'Contains', 'e+006', ['Baker']],
    ['tuseraddresses.longitude^varchar', 'Contains', 'e-005', ['Cole']],
    ['TAG', 'Contains', 'vip', ['Archer', 'Baker']],
  ])('matches implied-join %s %s %j once per joined row', async (field, condition, criteria, expected) => {
    expect(await lnamesWhere(param(field, condition, criteria))).toEqual(expected);
  });

  it.each<[string, SearchParamEntry]>([
    ['a non-NULL comparison against null', param(COMPANY, 'GT', 'null')],
    ['an unknown condition', param(LNAME, 'Approx', 'x')],
    ['an unparseable date', param('tusers.created^date', 'Equals', 'soon')],
    ['an unparseable time', param('tusers.created^time', 'Equals', 'soon')],
    ['text no datetime can be converted from', param('tusers.created^varchar', 'Equals', 'later')],
    ['non-numeric numeric criteria', param('tusers.subscribe^numeric', 'Equals', 'abc')],
    ['a numeric list', param('tusers.subscribe^numeric', 'IN', '0,1')],
    ['text no integer can be converted from', param('tusers.subscribe^varchar', 'Equals', 'x')],
    ['non-boolean bit criteria', param('tusers.inactive^bit', 'Equals', 'maybe')],
    ['an empty IN list', param(LNAME, 'IN', ',')],
    ['an unknown cfsqltype', param('tusers.lname^bogus', 'Equals', 'x')],
    ['a field without a data type', param('tusers.lname', 'Equals', 'x')],
  ])('answers server_error for %s', async (_label, entry) => {
    await expectServerError(search(where(entry)));
  });

  it('reuses the previous criteria for a data type without a setCriteria case', async () => {
    expect(await lnamesWhere(param(COMPANY, 'Equals', 'Acme'), param('tusers.lname^nvarchar', 'Equals', 'Baker', 'or'))).toEqual(['Archer']);
  });

  it.each<[string, SearchParamEntry[], unknown[]]>([
    ['or', [param(LNAME, 'Begins', 'A'), param(LNAME, 'Begins', 'C', 'or')], ['Archer', 'Cole']],
    ['and before or', [param(LNAME, 'Begins', 'A'), param(LNAME, 'Begins', 'B', 'or'), param(COMPANY, 'Contains', 'X')], ['Archer']],
    ['and not (', [param(LNAME, 'Begins', 'A', 'and not ('), CLOSE], ['Baker', 'Cole']],
    ['or (', [param(LNAME, 'Begins', 'A'), param(LNAME, 'Begins', 'B', 'or ('), param(COMPANY, 'Contains', 'Co'), CLOSE], ['Archer', 'Baker']],
    ['or not (', [param(LNAME, 'Begins', 'A'), param(COMPANY, 'Contains', 'Co', 'or not ('), param('', '', '', 'closeGrouping')], ['Archer']],
    [
      'openGrouping and orOpenGrouping',
      [param(LNAME, 'Begins', 'A', 'openGrouping'), param(LNAME, 'Begins', 'B', 'orOpenGrouping'), param('', '', '', 'closeGrouping'), CLOSE],
      ['Archer', 'Baker'],
    ],
    ['andOpenGrouping', [param(LNAME, 'Begins', 'A'), param(COMPANY, 'Contains', 'm', 'andOpenGrouping'), CLOSE], ['Archer']],
    ['( and and (', [param(LNAME, 'Begins', 'B', '('), param(COMPANY, 'Contains', '_', 'and ('), CLOSE, CLOSE], ['Baker']],
    ['an unknown relationship after or', [param(LNAME, 'Begins', 'A', 'or'), param(LNAME, 'Begins', 'B', 'xor')], ['Archer', 'Baker']],
    ['an unknown relationship after and', [param(LNAME, 'Begins', 'A'), param(LNAME, 'Begins', 'B', 'xor')], []],
    ['a tusers.siteid criterion', [param('tusers.siteid^varchar', 'Equals', TENANT_B.siteId)], ALL],
    ['a criterion without a field', [param('', 'Equals', 'x')], ALL],
  ])('groups %s as SQL does', async (_label, entries, expected) => {
    expect(await lnamesWhere(...entries)).toEqual(expected);
  });

  it.each<[string, SearchParamEntry[]]>([
    ['an unclosed (', [param(LNAME, 'Begins', 'A', '(')]],
    ['an extra )', [param(LNAME, 'Begins', 'A'), CLOSE]],
    ['a ) before any criterion', [param(LNAME, 'Begins', 'A', ')')]],
    ['a criterion straight after )', [param(LNAME, 'Begins', 'A', '('), param(LNAME, 'Begins', 'B', ')')]],
  ])('answers server_error for %s', async (_label, entries) => {
    await expectServerError(search(where(...entries)));
  });

  it.each<[string, Criteria, AdvancedSearchOptions, unknown[]]>([
    ['inactive param', where(param('inactive', 'Equals', '1')), {}, ['Cole']],
    ['non-numeric inactive param', where(param('inactive', 'Equals', 'x')), {}, ALL],
    ['ispublic param', where(param('ispublic', 'Equals', '0')), {}, ['Price']],
    ['type group param', where(param('type', 'Equals', 'group')), {}, []],
    ['type user param', where(param('type', 'Equals', 'User')), {}, ALL],
    ['unknown type param', where(param('type', 'Equals', 'staff')), {}, ALL],
    ['groupid param', where(param('groupid', 'Equals', ' G1 ')), {}, ['Archer', 'Baker']],
    ['categoryid param', where(param('categoryid', 'Equals', 'C1,C2')), {}, ['Archer', 'Cole']],
    ['session inActive', { inActive: '0' }, {}, ['Archer', 'Baker']],
    ['ispublic key', { ispublic: 0 }, {}, ['Price']],
    ['numeric type key', { type: 1 }, {}, []],
    ['categoryID key', { categoryID: 'C3' }, {}, ['Baker']],
    ['groupID key', { groupID: 'G2' }, {}, ['Cole']],
    ['siteid key', { siteid: SITE }, {}, ALL],
    ['isPublic argument over the ispublic key', { ispublic: 1 }, { isPublic: 0 }, ['Price']],
  ])('applies the user feed %s', async (_label, criteria, options, expected) => {
    expect(lnames(await search(criteria, options))).toEqual(expected);
  });

  it.each<[string, QueryResultRow, Criteria, AdvancedSearchOptions, unknown[]]>([
    ['the public pool for isPublic 1', SPLIT_POOLS, {}, { isPublic: 1 }, ['Umber']],
    ['the private pool for isPublic 0', SPLIT_POOLS, {}, { isPublic: 0 }, ['Price']],
    ['both differing pools without isPublic', SPLIT_POOLS, { ispublic: '' }, {}, [...ALL, 'Price', 'Umber']],
    ['one shared pool without isPublic', registryRow(), { ispublic: '' }, {}, [...ALL, 'Price']],
  ])('reads %s', async (_label, registry, criteria, options, expected) => {
    expect(lnames(await search(criteria, options, { registry }))).toEqual(expected);
  });

  it('answers the legacy 503 for an unregistered tenant', async () => {
    await expect(search({}, {}, {}, { ...VIEWER, tid: TENANT_B.tenantId })).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
  });

  it('orders by a built-in date sort, NULLs last descending', async () => {
    expect(lnames(await search({}, { sortBy: 'created', sortDirection: 'desc' }))).toEqual(['Archer', 'Baker', 'Cole', null]);
  });

  it('orders by a built-in text sort across pools, NULLs first', async () => {
    const ordered = lnames(await search({ ispublic: '' }, { sortBy: 'email' }, { registry: SPLIT_POOLS }));
    // SQL Server leaves the order of the NULL emails unspecified.
    expect(ordered.slice(0, 3).sort()).toEqual(['Cole', 'Price', 'Umber']);
    expect(ordered.slice(3)).toEqual(['Archer', 'Baker', null]);
  });

  it('projects fieldList rows with wall-clock account times and photo extensions', async () => {
    const photoFileExts = (ids: readonly (string | null | undefined)[]) =>
      Promise.resolve(new Map(ids.filter((id): id is string => id === PHOTO).map((id) => [id, 'jpg'])));
    const query = await search({}, {}, { photoFileExts });
    expect(query.columnList).toEqual([...SEARCH_FIELD_LIST]);
    expect(query.rows[1]).toStrictEqual({
      userID: ARCHER,
      GroupName: null,
      Fname: 'Ann',
      Lname: 'Archer',
      UserName: 'aarcher',
      PasswordCreated: new Date(2026, 1, 1, 8, 0, 0),
      Email: 'ann.archer@example.com',
      Company: 'Acme',
      JobTitle: null,
      MobilePhone: null,
      Website: null,
      Type: 2,
      subType: 'Default',
      ContactForm: null,
      S2: 0,
      LastLogin: new Date(2026, 5, 20, 8, 0, 0, 250),
      LastUpdate: LAST_UPDATE,
      LastUpdateBy: 'Admin User',
      LastUpdateByID: ADMIN,
      Perm: 0,
      InActive: 0,
      IsPublic: 1,
      SiteID: SITE,
      Subscribe: 1,
      Notes: null,
      description: null,
      Interests: null,
      keepPrivate: 0,
      PhotoFileID: PHOTO,
      IMName: null,
      IMService: null,
      Created: new Date(2026, 5, 5, 9, 5, 0),
      RemoteID: null,
      Tags: null,
      tablist: null,
      photoFileExt: 'jpg',
    });
    expect(query.rows[0]).toMatchObject({ userID: NIA, PasswordCreated: 'unknown', LastLogin: null, photoFileExt: '' });
    expect((await search()).rows[1]).toMatchObject({ PhotoFileID: PHOTO, photoFileExt: '' });
  });

  it('searches the session criteria the admin form posts', async () => {
    const ctx = new Map<string, unknown>([
      ['param', '1,2'],
      ['paramRelationship1', 'and'],
      ['paramField1', LNAME],
      ['paramCondition1', 'Begins'],
      ['paramCriteria1', 'a'],
      ['paramRelationship2', 'or'],
      ['paramField2', COMPANY],
      ['paramCondition2', 'Contains'],
      ['paramCriteria2', 'co'],
      ['muraAction', 'cUsers.advancedSearch'],
    ]);
    // The request default inActive=0 hides Cole, whose company also contains 'co'.
    expect(lnames(await search(buildAdvancedSearchCriteria(ctx, newAdvancedSearchCriteria())))).toEqual(['Archer', 'Baker']);
  });
});

describe('nextN', () => {
  /** The nextN struct in getNextN's assignment order. */
  const struct = (
    TotalRecords: number,
    RecordsPerPage: number,
    NumberOfPages: number,
    CurrentPageNumber: number,
    firstPage: number,
    lastPage: number,
    next: number,
    previous: number,
    through: number,
    startrow: number,
  ): NextN => ({ TotalRecords, RecordsPerPage, NumberOfPages, CurrentPageNumber, firstPage, lastPage, next, previous, through, startrow });

  it.each<[string, [number, number, number, number], NextN]>([
    ['no rows', [0, 25, 1, 3], struct(0, 25, 0, 1, 1, 0, 1, 1, 0, 1)],
    ['100 by 25 from row 1', [100, 25, 1, 3], struct(100, 25, 4, 1, 1, 4, 26, 1, 25, 1)],
    ['100 by 25 from row 51', [100, 25, 51, 3], struct(100, 25, 4, 3, 1, 4, 76, 26, 75, 51)],
    ['a start beyond the total', [100, 25, 151, 3], struct(100, 25, 4, 7, 1, 4, 1, 126, 100, 151)],
    ['a short last page', [30, 25, 26, 3], struct(30, 25, 2, 2, 1, 2, 1, 1, 30, 26)],
    ['one page of all rows', [3, 100000, 1, 3], struct(3, 100000, 1, 1, 1, 1, 1, 1, 3, 1)],
    ['the first buffer window', [1000, 10, 1, 3], struct(1000, 10, 100, 1, 1, 7, 11, 1, 10, 1)],
    ['a middle buffer window', [1000, 10, 500, 3], struct(1000, 10, 100, 50, 47, 53, 501, 481, 500, 500)],
    ['the last buffer window', [1000, 10, 995, 3], struct(1000, 10, 100, 100, 94, 100, 1, 981, 1000, 995)],
    ['the utility default buffer of 5', [1000, 10, 41, 5], struct(1000, 10, 100, 5, 1, 11, 51, 31, 50, 41)],
  ])('computes %s', (_label, [total, perPage, startRow, buffer], expected) => {
    expect(nextN(total, perPage, startRow, buffer)).toStrictEqual(expected);
  });
});

describe('pageRows', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

  it.each<[string, number, { startRow?: number; recordsPerPage?: number }, [number, number], number, [number, number]]>([
    ['no rows', 0, {}, [0, 0], 1, [1, 25]],
    ['the first page by default', 100, {}, [0, 25], 1, [1, 25]],
    ['start row 2 as page 2', 100, { startRow: 2 }, [25, 50], 2, [2, 25]],
    ['start row 4 as page 4', 100, { startRow: 4 }, [75, 100], 4, [4, 25]],
    ['a page past the rows as page 1', 100, { startRow: 51 }, [0, 25], 1, [51, 25]],
    ['a page starting at the record count as empty', 100, { startRow: 5 }, [100, 100], 5, [5, 25]],
    ['a start row beyond the rows as row 1', 100, { startRow: 101 }, [0, 25], 1, [1, 25]],
    ['non-positive values as the cusers defaults', 100, { startRow: 0, recordsPerPage: 0 }, [0, 25], 1, [1, 25]],
    ['10 per page from row 3', 30, { startRow: 3, recordsPerPage: 10 }, [20, 30], 3, [3, 10]],
    ['1 per page from row 2', 3, { startRow: 2, recordsPerPage: 1 }, [1, 2], 2, [2, 1]],
  ])('shows %s', (_label, count, options, [from, to], pageIndex, [startrow, perPage]) => {
    const page = pageRows(rows(count), options);
    expect(page.rows).toEqual(rows(count).slice(from, to));
    expect(page.pageIndex).toBe(pageIndex);
    expect(page.nextn).toStrictEqual(nextN(count, perPage, startrow, 3));
  });
});
