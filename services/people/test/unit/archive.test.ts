/** People's person archive, seam 1's producer: input parsing, the domain over in-memory collaborators, the fixture route's check order and writes over the recording database, and its PostgreSQL semantics. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  LEGACY_ERROR_MAP,
  LegacyApiError,
  isCfUuid,
  type LegacyErrorSpec,
} from '@opt2/platform/legacy-compat';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertResponseMatchesOpenApi,
  mintUserToken,
  poolTenantExpectation,
  type TenantFixture,
} from '@opt2/platform/testing';
import { archivePerson, getPersonArchive, parseArchiveInput, type ArchiveArgs, type ArchiveDeps } from '../../src/domain/archive.js';
import { PERSON_ARCHIVED_TOPIC, personArchivedSchema } from '../../src/events/topics.js';
import { DuplicateArchiveError } from '../../src/repo/repository.js';
import { FIXTURE_ARCHIVE_PATH } from '../../src/routes/fixture-archive.js';
import {
  PG_AVAILABLE,
  TEST_CLOCK,
  buildTestApp,
  createRecordingDb,
  userHeaders,
  withPgApp,
  type PgTestApp,
  type RecordingDb,
  type RecordedStatement,
  type TestApp,
} from '../helpers/app.js';
import {
  ADMIN_S2,
  ARCHIVED_PERSON_B,
  ARCHIVE_EFFECTIVE_FROM,
  DEFAULT_PEOPLE_SEED,
  DEFAULT_SITE,
  MEMBER_POOLED,
  OTHER_TENANT,
  OTHER_TENANT_PERSON,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  SYSTEM_USER_A_PERSON,
  TENANT_B_ARCHIVE,
  personRow,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';

type ArchiveRepo = ArchiveDeps['repo'];
type Tx = Parameters<ArchiveRepo['findPerson']>[0];
type StoredPerson = NonNullable<Awaited<ReturnType<ArchiveRepo['findPerson']>>>;
type StoredArchive = Awaited<ReturnType<ArchiveRepo['insertPersonArchive']>>;
type ArchiveInsert = Parameters<ArchiveRepo['insertPersonArchive']>[1];
type WriteCtx = Parameters<ArchiveRepo['insertPersonArchive']>[2];
type InjectResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

/** api.cfm's envelope `method` of the archive route. */
const METHOD = 'people.persons.archive';
/** envelope.cfc rows the JSON API error map lacks. */
const FORBIDDEN: LegacyErrorSpec = { status: 403, code: 'invalid_request', message: 'Insufficient Account Permissions' };
const NOT_FOUND: LegacyErrorSpec = { status: 404, code: 'invalid_request', message: 'Not Found' };

const ARCHIVE_ID = 'A1B2C3D4-0000-0000-0000000000000001';
const EFFECTIVE_FROM_TEXT = '2026-07-01T00:00:00';
const ARCHIVED_AT_TEXT = '2026-06-30T12:00:00';
const SADMIN_NAMES = { fname: 'Sasha', lname: 'Admin' } as const;

const SEEDED_PERSONS: readonly StoredPerson[] = Object.values(DEFAULT_PEOPLE_SEED).flatMap((tenant) => tenant.persons ?? []);
const SEEDED_ARCHIVES: readonly StoredArchive[] = Object.values(DEFAULT_PEOPLE_SEED).flatMap((tenant) => tenant.archives ?? []);

/** A char(35) id as SQL Server compares it: case-insensitive, trailing spaces ignored. */
const sameId = (a: string, b: string): boolean => a.replace(/ +$/, '').toUpperCase() === b.replace(/ +$/, '').toUpperCase();

/** The archive path of `userId`. */
const archivePath = (userId: string): string => FIXTURE_ARCHIVE_PATH.replace(':userId', encodeURIComponent(userId));

/** The rejection `outcome` settles with. */
async function rejection(outcome: Promise<unknown>): Promise<unknown> {
  try {
    await outcome;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/** The fixture envelope of an error row: api.cfm's method, code before message. */
function expectFixtureError(response: InjectResponse, row: LegacyErrorSpec): void {
  expect(response.statusCode).toBe(row.status);
  const body = response.json<{ error: Record<string, unknown> }>();
  expect(body).toStrictEqual({ apiversion: 'v1', method: METHOD, error: { code: row.code, message: row.message } });
  expect(Object.keys(body.error)).toEqual(['code', 'message']);
}

describe('parseArchiveInput', () => {
  it.each<[string, Map<string, unknown>]>([
    ['a missing effectiveFrom', new Map()],
    ['an empty effectiveFrom', new Map([['effectivefrom', '']])],
    ['a non-string effectiveFrom', new Map<string, unknown>([['effectivefrom', 20260701]])],
    ['a date-time, which the fixture pattern refuses', new Map([['effectivefrom', '2026-07-01T00:00:00']])],
    ['a date with spaces around it', new Map([['effectivefrom', ' 2026-07-01']])],
    ['a two-digit year', new Map([['effectivefrom', '26-07-01']])],
    ['a day past the month end', new Map([['effectivefrom', '2026-02-30']])],
    ['a thirteenth month', new Map([['effectivefrom', '2026-13-01']])],
    ['a February 29 outside a leap year', new Map([['effectivefrom', '2027-02-29']])],
    ['a year before SQL Server datetime begins', new Map([['effectivefrom', '1752-12-31']])],
    ['the name in its request casing, as only lower-cased keys are read', new Map([['effectiveFrom', '2026-07-01']])],
  ])('refuses %s with invalidParameters', (_label, params) => {
    const error = (() => {
      try {
        return parseArchiveInput(SYSTEM_USER_A.sub, params);
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({ type: 'invalidParameters' });
  });

  it.each(['2026-07-01', '1753-01-01', '2028-02-29', '9999-12-31'])('accepts the calendar day %s', (effectiveFrom) => {
    expect(parseArchiveInput(SYSTEM_USER_A.sub, new Map([['effectivefrom', effectiveFrom]]))).toStrictEqual({
      userId: SYSTEM_USER_A.sub,
      effectiveFrom,
    });
  });
});

/** In-memory archive collaborators and what they received. */
interface MemoryArchive {
  deps: ArchiveDeps;
  inserted: Array<{ row: ArchiveInsert; ctx: WriteCtx }>;
  published: StoredArchive[];
  fenced: Array<{ tenantId: string; userIds: string[] }>;
}

interface MemoryArchiveOptions {
  persons?: readonly StoredPerson[];
  archives?: readonly StoredArchive[];
  insertError?: Error;
  publishError?: Error;
}

/** Archive collaborators over in-memory rows; the fence runs its callback once in a transaction of the given tenant. */
function memoryArchive(opts: MemoryArchiveOptions = {}): MemoryArchive {
  const inserted: MemoryArchive['inserted'] = [];
  const published: StoredArchive[] = [];
  const fenced: MemoryArchive['fenced'] = [];
  const archives = [...(opts.archives ?? [])];
  const persons = opts.persons ?? [];
  const repo = {
    findPerson: async (tx: Tx, userId: string) => persons.find((row) => row.tenant_id === tx.tenantId && sameId(row.userid, userId)) ?? null,
    findPersonArchive: async (tx: Tx, personId: string) =>
      archives.find((row) => row.tenant_id === tx.tenantId && sameId(row.person_id, personId)) ?? null,
    insertPersonArchive: async (tx: Tx, row: ArchiveInsert, ctx: WriteCtx) => {
      inserted.push({ row, ctx });
      if (opts.insertError !== undefined) throw opts.insertError;
      const stored = { tenant_id: tx.tenantId, archive_id: ARCHIVE_ID, ...row } as StoredArchive;
      archives.push(stored);
      return stored;
    },
  } as unknown as ArchiveRepo;
  const fence: ArchiveDeps['fence'] = {
    fencePersons: async (tx, userIds) => {
      fenced.push({ tenantId: tx.tenantId, userIds: [...userIds] });
    },
    withPersonsOpen: (_db, tenantId, fn) => fn({ tenantId } as unknown as Tx),
  };
  const events: ArchiveDeps['events'] = {
    publishPersonArchived: async (_tx, archive) => {
      published.push(archive);
      if (opts.publishError !== undefined) throw opts.publishError;
      return null;
    },
  };
  return { deps: { db: {} as ArchiveDeps['db'], repo, events, clock: TEST_CLOCK, fence }, inserted, published, fenced };
}

const ARCHIVER: NonNullable<ArchiveArgs['actor']> = { userId: SITE_ADMIN_A.sub, ...SADMIN_NAMES, isLoggedIn: true };

/** Archives `SYSTEM_USER_A_PERSON` in tenant-a from `ARCHIVE_EFFECTIVE_FROM`; `actor` undefined is an archive without a session user. */
function archiveSystemUser(deps: ArchiveDeps, actor: ArchiveArgs['actor']): Promise<unknown> {
  return archivePerson(deps, { tenantId: TENANT_A.tenantId, input: { userId: SYSTEM_USER_A_PERSON.userid, effectiveFrom: ARCHIVE_EFFECTIVE_FROM }, actor });
}

describe('archivePerson over in-memory collaborators', () => {
  it('stores the archive from local midnight at the clock instant, named by the session user, publishes it and answers the fixture record', async () => {
    const memory = memoryArchive({ persons: [SYSTEM_USER_A_PERSON] });

    const record = await archiveSystemUser(memory.deps, ARCHIVER);

    expect(memory.fenced).toStrictEqual([{ tenantId: TENANT_A.tenantId, userIds: [SYSTEM_USER_A_PERSON.userid] }]);
    expect(memory.inserted).toStrictEqual([
      {
        row: {
          person_id: SYSTEM_USER_A_PERSON.userid,
          siteid: TENANT_A.siteId,
          effective_from: new Date(2026, 6, 1),
          archived_at: TEST_CLOCK.now(),
          archived_by_id: SITE_ADMIN_A.sub,
          archived_by: 'Sasha Admin',
        },
        ctx: { origin: 'target', actorUserId: SITE_ADMIN_A.sub },
      },
    ]);
    expect(memory.published).toHaveLength(1);
    expect(memory.published[0]).toMatchObject({ archive_id: ARCHIVE_ID, person_id: SYSTEM_USER_A_PERSON.userid });
    expect(record).toStrictEqual({
      archiveid: ARCHIVE_ID,
      personid: SYSTEM_USER_A_PERSON.userid,
      siteid: TENANT_A.siteId,
      effectivefrom: EFFECTIVE_FROM_TEXT,
      archivedat: ARCHIVED_AT_TEXT,
    });
  });

  it.each<[string, ArchiveArgs['actor'], string | null, string | null]>([
    ['no session user', undefined, null, null],
    ['a session user without names', { userId: SITE_ADMIN_A.sub, isLoggedIn: true }, SITE_ADMIN_A.sub, ''],
    ['names with spaces around them', { userId: SITE_ADMIN_A.sub, fname: '  Ada ', lname: ' Lovelace  ', isLoggedIn: true }, SITE_ADMIN_A.sub, 'Ada   Lovelace'],
    ['a full name past 50 characters', { userId: SITE_ADMIN_A.sub, fname: 'A'.repeat(30), lname: 'B'.repeat(30), isLoggedIn: true }, SITE_ADMIN_A.sub, `${'A'.repeat(30)} ${'B'.repeat(19)}`],
  ])('records archived_by for %s as left(getFullName(), 50)', async (_label, actor, archivedById, archivedBy) => {
    const memory = memoryArchive({ persons: [SYSTEM_USER_A_PERSON] });

    await archiveSystemUser(memory.deps, actor);

    expect(memory.inserted[0]?.row).toMatchObject({ archived_by_id: archivedById, archived_by: archivedBy });
    expect(memory.inserted[0]?.ctx).toStrictEqual({ origin: 'target', actorUserId: actor?.userId });
  });

  it('stores the person site id trimmed, as user.getSiteID() holds it', async () => {
    const memory = memoryArchive({ persons: [{ ...SYSTEM_USER_A_PERSON, siteid: `${TENANT_A.siteId}  ` }] });

    await archiveSystemUser(memory.deps, ARCHIVER);

    expect(memory.inserted[0]?.row.siteid).toBe(TENANT_A.siteId);
  });

  it.each<[string, readonly StoredPerson[]]>([
    ['a person the tenant does not hold', []],
    ['a person without a site id', [{ ...SYSTEM_USER_A_PERSON, siteid: null }]],
    ['a person whose site id is blank', [{ ...SYSTEM_USER_A_PERSON, siteid: '   ' }]],
  ])('answers notFound for %s, storing and publishing nothing', async (_label, persons) => {
    const memory = memoryArchive({ persons });

    const error = await rejection(archiveSystemUser(memory.deps, ARCHIVER));

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({ type: 'notFound' });
    expect(memory.inserted).toStrictEqual([]);
    expect(memory.published).toStrictEqual([]);
  });

  it('answers badRequest for a person already archived, publishing nothing', async () => {
    const memory = memoryArchive({ persons: [SYSTEM_USER_A_PERSON], insertError: new DuplicateArchiveError(SYSTEM_USER_A_PERSON.userid) });

    const error = await rejection(archiveSystemUser(memory.deps, ARCHIVER));

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({ type: 'badRequest' });
    expect(memory.published).toStrictEqual([]);
  });

  it.each<[string, keyof Pick<MemoryArchiveOptions, 'insertError' | 'publishError'>]>([
    ['the insert', 'insertError'],
    ['the outbox write', 'publishError'],
  ])('rethrows any other failure of %s unchanged', async (_label, at) => {
    const failure = new Error(`${at} failed`);
    const memory = memoryArchive({ persons: [SYSTEM_USER_A_PERSON], [at]: failure });

    expect(await rejection(archiveSystemUser(memory.deps, ARCHIVER))).toBe(failure);
  });
});

describe('getPersonArchive over in-memory collaborators', () => {
  const stored = { ...TENANT_B_ARCHIVE };

  it('answers the person record, dates in the fixture row form', async () => {
    const memory = memoryArchive({ persons: [ARCHIVED_PERSON_B], archives: [stored] });

    const record = await getPersonArchive(memory.deps, { tenantId: TENANT_B.tenantId, userId: ARCHIVED_PERSON_B.userid.toLowerCase() });

    expect(memory.fenced).toStrictEqual([{ tenantId: TENANT_B.tenantId, userIds: [ARCHIVED_PERSON_B.userid.toLowerCase()] }]);
    expect(record).toStrictEqual({
      archiveid: TENANT_B_ARCHIVE.archive_id,
      personid: ARCHIVED_PERSON_B.userid,
      siteid: TENANT_B.siteId,
      effectivefrom: '2026-06-01T00:00:00',
      archivedat: ARCHIVED_AT_TEXT,
    });
  });

  it.each<[string, MemoryArchiveOptions]>([
    ['a person the tenant does not hold, whatever records exist', { archives: [stored] }],
    ['a person without an archive record', { persons: [ARCHIVED_PERSON_B] }],
  ])('answers notFound for %s', async (_label, opts) => {
    const memory = memoryArchive(opts);

    const error = await rejection(getPersonArchive(memory.deps, { tenantId: TENANT_B.tenantId, userId: ARCHIVED_PERSON_B.userid }));

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({ type: 'notFound' });
  });
});

/** Sites the recording database registers: the three fixtures and the installed `default`, which pools to itself. */
const REGISTERED_SITES: readonly Pick<TenantFixture, 'siteId' | 'tenantId'>[] = [TENANT_A, TENANT_B, TENANT_UMBRELLA, DEFAULT_SITE];
const POOL_FIXTURES: readonly TenantFixture[] = [TENANT_A, TENANT_B, TENANT_UMBRELLA];
const POOL_KINDS = { public_user_pool_tenant: 'publicUser', private_user_pool_tenant: 'privateUser' } as const;

const SITE_LOOKUP = /tenant_registry"? WHERE lower\(site_id\) = lower\(\$1\)$/;
const POOL_LOOKUP = /^SELECT (\w+) AS pool_tenant FROM \S*tenant_registry"? WHERE tenant_id = \$1$/;
const PERSON_BY_ID = /^SELECT \* FROM \S*\bperson"? WHERE tenant_id = \$1 AND userid\b/;
const ARCHIVE_BY_PERSON = /^SELECT \* FROM \S*\bperson_archive"? WHERE tenant_id = \$1 AND person_id\b/;
const ARCHIVE_INSERT = /^INSERT INTO \S*\bperson_archive"? \(/;
const TRANSACTION_END = /^(?:COMMIT|ROLLBACK)\b/;

/** The pool tenant the registry gives `tenantId` in `column`; the installed site pools to itself. */
function poolTenantOf(tenantId: unknown, column: string | undefined): string | undefined {
  const kind = column === undefined ? undefined : POOL_KINDS[column as keyof typeof POOL_KINDS];
  if (kind === undefined) return undefined;
  const fixture = POOL_FIXTURES.find((candidate) => candidate.tenantId === tenantId);
  if (fixture !== undefined) return poolTenantExpectation(fixture, kind);
  return tenantId === DEFAULT_SITE.tenantId ? DEFAULT_SITE.tenantId : undefined;
}

/** The row an `INSERT … (columns) VALUES (…) RETURNING *` stores: its columns zipped with its values. */
function insertedRow(text: string, values: readonly unknown[]): Record<string, unknown> {
  const columns = /^INSERT INTO \S+ \(([^)]*)\)/.exec(text)?.[1]?.split(',') ?? [];
  return Object.fromEntries(columns.map((column, index) => [column.trim().replace(/"/g, ''), values[index]]));
}

/** A recording database answering the registry, the seeded persons and archives, and echoing the archive insert. */
function archiveDb(persons: readonly StoredPerson[] = SEEDED_PERSONS): RecordingDb {
  const db = createRecordingDb();
  db.respond(SITE_LOOKUP, (_text, [siteId]) =>
    REGISTERED_SITES.filter((site) => site.siteId === String(siteId).toLowerCase()).map((site) => ({ tenant_id: site.tenantId })),
  );
  db.respond(POOL_LOOKUP, (text, [tenantId]) => {
    const pool = poolTenantOf(tenantId, POOL_LOOKUP.exec(text)?.[1]);
    return pool === undefined ? [] : [{ pool_tenant: pool }];
  });
  db.respond(PERSON_BY_ID, (_text, [tenantId, userId]) => persons.filter((row) => row.tenant_id === tenantId && sameId(row.userid, String(userId))));
  db.respond(ARCHIVE_BY_PERSON, (_text, [tenantId, personId]) =>
    SEEDED_ARCHIVES.filter((row) => row.tenant_id === tenantId && sameId(row.person_id, String(personId))).slice(0, 1),
  );
  db.respond(ARCHIVE_INSERT, (text, values) => [insertedRow(text, values)]);
  return db;
}

/** Tenants whose person rows the request read, in order. */
const personReads = (db: RecordingDb): string[] => db.statements().filter(({ text }) => PERSON_BY_ID.test(text)).map(({ values }) => String(values[0]));
/** Sites the request looked up in the registry, in order. */
const siteLookups = (db: RecordingDb): string[] => db.statements().filter(({ text }) => SITE_LOOKUP.test(text)).map(({ values }) => String(values[0]));
/** Unqualified tables of the request's writes, in order. */
const writtenTables = (db: RecordingDb): string[] =>
  db.writes().map(({ text }) => /^INSERT INTO (?:"?\w+"?\.)?"?(\w+)"?/.exec(text)?.[1] ?? text);

let csrfSequence = 0;

/** Headers of `actor` arriving through the gateway with a fresh CSRF token; `site` overrides the token's site. */
async function actorHeaders(actor: Pick<TestActor, 'sub' | 'site' | 'roles' | 's2'>, opts: { sid?: string; site?: string } = {}): Promise<Record<string, string>> {
  csrfSequence += 1;
  return {
    ...(await userHeaders({ ...actor, site: opts.site ?? actor.site, ...(opts.sid === undefined ? {} : { sid: opts.sid }) })),
    [CSRF_HEADER_TOKEN]: `TOKEN-${String(csrfSequence)}`,
    [CSRF_HEADER_EXPIRES]: '260630130000000',
  };
}

/** One call of the archive route. */
interface ArchiveCall {
  method?: 'GET' | 'POST';
  userId: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** A JSON object body, or a urlencoded form string. */
  body?: Record<string, unknown> | string;
}

function callArchive(app: TestApp['app'], call: ArchiveCall): Promise<InjectResponse> {
  const method = call.method ?? 'POST';
  const form = typeof call.body === 'string';
  return app.inject({
    method,
    url: archivePath(call.userId),
    query: call.query ?? {},
    headers: { ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...call.headers },
    ...(method === 'POST' ? { payload: call.body ?? { effectiveFrom: ARCHIVE_EFFECTIVE_FROM } } : {}),
  });
}

/** One check-order case: the call, its fixture error row, and how far the request got. */
interface CheckCase {
  call: () => Promise<ArchiveCall>;
  arrange?: (t: TestApp) => void;
  row: LegacyErrorSpec;
  sites: string[];
  identityCalls: string[];
  csrfContexts: string[];
  reads: string[];
}

const PUBLIC_THEN_PRIVATE = [TENANT_UMBRELLA.tenantId, TENANT_A.tenantId];
const anonymous = async (): Promise<Record<string, string>> => userHeaders({ sub: '', site: TENANT_A.siteId, roles: [] });

const CHECK_CASES: ReadonlyArray<[string, CheckCase]> = [
  [
    'an unregistered siteid answers invalidParameters before the login check',
    { call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid, query: { siteid: 'nosuchsite' } }), row: LEGACY_ERROR_MAP.invalidParameters, sites: ['nosuchsite'], identityCalls: [], csrfContexts: [], reads: [] },
  ],
  [
    'an absent siteid falls back to default, where an anonymous call answers authorization',
    { call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid }), row: LEGACY_ERROR_MAP.authorization, sites: [DEFAULT_SITE.siteId], identityCalls: [], csrfContexts: [], reads: [] },
  ],
  [
    'a siteid other than the token site answers forbidden',
    {
      call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A), query: { siteid: TENANT_B.siteId } }),
      row: FORBIDDEN, sites: [TENANT_B.siteId], identityCalls: [], csrfContexts: [], reads: [],
    },
  ],
  [
    'an effective method other than GET and POST answers notFound before the login check',
    {
      call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid, headers: { 'x-http-method-override': 'delete' } }),
      row: NOT_FOUND, sites: [DEFAULT_SITE.siteId], identityCalls: [], csrfContexts: [], reads: [],
    },
  ],
  [
    'the anonymous principal answers authorization',
    { call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid, headers: await anonymous() }), row: LEGACY_ERROR_MAP.authorization, sites: [TENANT_A.siteId], identityCalls: [], csrfContexts: [], reads: [] },
  ],
  [
    'a system user without site-admin answers forbidden',
    { call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SYSTEM_USER_A) }), row: FORBIDDEN, sites: [TENANT_A.siteId], identityCalls: [], csrfContexts: [], reads: [] },
  ],
  [
    'a CSRF token identity refuses answers invalidTokens before the person lookup',
    {
      call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A) }),
      arrange: (t) => t.identity.csrf.rejectAll(),
      row: LEGACY_ERROR_MAP.invalidTokens, sites: [TENANT_A.siteId], identityCalls: ['consumeCsrfToken'], csrfContexts: [SYSTEM_USER_A_PERSON.userid], reads: [],
    },
  ],
  [
    'a person outside both user pools of the site answers notFound after the CSRF check',
    {
      call: async () => ({ userId: OTHER_TENANT_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A) }),
      row: NOT_FOUND, sites: [TENANT_A.siteId], identityCalls: ['consumeCsrfToken'], csrfContexts: [OTHER_TENANT_PERSON.userid], reads: PUBLIC_THEN_PRIVATE,
    },
  ],
  [
    'an id that is not a CF UUID is kept as sent and answers notFound after the CSRF check',
    {
      call: async () => ({ userId: 'not-a-uuid', headers: await actorHeaders(SITE_ADMIN_A) }),
      row: NOT_FOUND, sites: [TENANT_A.siteId], identityCalls: ['consumeCsrfToken'], csrfContexts: ['not-a-uuid'], reads: PUBLIC_THEN_PRIVATE,
    },
  ],
  [
    'an effectiveFrom that is no calendar day answers invalidParameters after the person lookup',
    {
      call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A), body: { effectiveFrom: '2026-02-30' } }),
      row: LEGACY_ERROR_MAP.invalidParameters, sites: [TENANT_A.siteId], identityCalls: ['consumeCsrfToken'], csrfContexts: [SYSTEM_USER_A_PERSON.userid], reads: PUBLIC_THEN_PRIVATE,
    },
  ],
  [
    'a JSON effectiveFrom keeps its spaces and answers invalidParameters',
    {
      call: async () => ({ userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A), body: { effectiveFrom: ` ${ARCHIVE_EFFECTIVE_FROM} ` } }),
      row: LEGACY_ERROR_MAP.invalidParameters, sites: [TENANT_A.siteId], identityCalls: ['consumeCsrfToken'], csrfContexts: [SYSTEM_USER_A_PERSON.userid], reads: PUBLIC_THEN_PRIVATE,
    },
  ],
  [
    'a person already archived answers badRequest, writing nothing',
    {
      call: async () => ({ userId: ARCHIVED_PERSON_B.userid, headers: await actorHeaders(OTHER_TENANT) }),
      row: LEGACY_ERROR_MAP.badRequest, sites: [TENANT_B.siteId], identityCalls: ['consumeCsrfToken', 'getCurrentSession'], csrfContexts: [ARCHIVED_PERSON_B.userid],
      reads: [TENANT_B.tenantId, TENANT_B.tenantId],
    },
  ],
];

describe('the fixture archive route over the recording database', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp({ db: archiveDb() });
    // Start-up registers the unit gates; only the request's statements are inspected.
    t.db.clear();
  });

  afterEach(async () => {
    await t.close();
  });

  it.each(CHECK_CASES)('%s', async (_label, check) => {
    check.arrange?.(t);

    const response = await callArchive(t.app, await check.call());

    expectFixtureError(response, check.row);
    expect(siteLookups(t.db)).toEqual(check.sites);
    expect(t.identity.requests.map((request) => request.operationId)).toEqual(check.identityCalls);
    expect(t.identity.csrf.consumed().map(({ request }) => request.context)).toEqual(check.csrfContexts);
    expect(personReads(t.db)).toEqual(check.reads);
    expect(t.db.writes()).toEqual([]);
  });

  it('answers a call without any credential as the anonymous principal', async () => {
    expectFixtureError(await callArchive(t.app, { userId: SYSTEM_USER_A_PERSON.userid, query: { siteid: TENANT_A.siteId } }), LEGACY_ERROR_MAP.authorization);
  });

  it('renders a presented user token that fails verification as the fixture authorization error', async () => {
    const issuedAt = Math.floor(TEST_CLOCK.now().getTime() / 1000) - 7200;
    const expired = await mintUserToken({ sub: SITE_ADMIN_A.sub, site: SITE_ADMIN_A.site, roles: SITE_ADMIN_A.roles, iat: issuedAt, exp: issuedAt + 300 });
    const headers = { ...(await actorHeaders(SITE_ADMIN_A)), authorization: `Bearer ${expired}` };

    expectFixtureError(await callArchive(t.app, { userId: SYSTEM_USER_A_PERSON.userid, headers }), LEGACY_ERROR_MAP.authorization);
    expect(t.identity.requests).toEqual([]);
    expect(personReads(t.db)).toEqual([]);
  });

  it('answers server_error for an error type the fixture error map lacks, as envelope.cfc fail() does', async () => {
    t.db.respond(PERSON_BY_ID, () => {
      throw new LegacyApiError('invalidEntityCall');
    });

    const response = await callArchive(t.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A) });

    expectFixtureError(response, LEGACY_ERROR_MAP.server_error);
    expect(t.db.writes()).toEqual([]);
  });

  it('answers the legacy 503 when identity cannot be reached for the CSRF check, reading no person', async () => {
    t.identity.setUnreachable(true);

    const response = await callArchive(t.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A) });

    expect(response.statusCode).toBe(503);
    expect(personReads(t.db)).toEqual([]);
    expect(t.db.writes()).toEqual([]);
  });

  it('archives in one transaction that writes only the archive row, its changelog row and its outbox row', async () => {
    const sid = 'SESSION-ARCHIVE-A';
    t.identity.seedSessions({ sessionId: sid, user: { isLoggedIn: true, userID: SITE_ADMIN_A.sub, ...SADMIN_NAMES } });

    const response = await callArchive(t.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A, { sid }) });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { archiveid: string } }>();
    expect(body).toStrictEqual({
      apiversion: 'v1',
      method: METHOD,
      data: { archiveid: body.data.archiveid, personid: SYSTEM_USER_A_PERSON.userid, siteid: TENANT_A.siteId, effectivefrom: EFFECTIVE_FROM_TEXT, archivedat: ARCHIVED_AT_TEXT },
    });
    expect(isCfUuid(body.data.archiveid)).toBe(true);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: archivePath(SYSTEM_USER_A_PERSON.userid), status: 200, contentType: response.headers['content-type'], body });

    expect(writtenTables(t.db)).toEqual(['person_archive', 'changelog', 'outbox']);
    const [archiveWrite, , outboxWrite] = t.db.writes() as [RecordedStatement, RecordedStatement, RecordedStatement];
    expect(insertedRow(archiveWrite.text, archiveWrite.values)).toMatchObject({
      tenant_id: TENANT_A.tenantId,
      archive_id: body.data.archiveid,
      person_id: SYSTEM_USER_A_PERSON.userid,
      siteid: TENANT_A.siteId,
      archived_by_id: SITE_ADMIN_A.sub,
      archived_by: 'Sasha Admin',
    });
    const statements = t.db.statements();
    const first = statements.indexOf(archiveWrite);
    const last = statements.indexOf(outboxWrite);
    expect(statements.slice(first, last).some(({ text }) => TRANSACTION_END.test(text))).toBe(false);
    expect(statements.slice(last).find(({ text }) => TRANSACTION_END.test(text))?.text).toMatch(/^COMMIT\b/);

    const [tenantId, , topic, kind, orderingKey, envelopeJson] = outboxWrite.values;
    expect({ tenantId, topic, kind, orderingKey }).toStrictEqual({
      tenantId: TENANT_A.tenantId,
      topic: PERSON_ARCHIVED_TOPIC,
      kind: 'process',
      orderingKey: SYSTEM_USER_A_PERSON.userid,
    });
    const envelope = assertEventMatches(undefined, personArchivedSchema, JSON.parse(String(envelopeJson)));
    expect(envelope).toMatchObject({
      tenantId: TENANT_A.tenantId,
      producer: 'people',
      aggregateType: 'person',
      aggregateId: SYSTEM_USER_A_PERSON.userid,
      aggregateVersion: 1,
      payload: {
        personId: SYSTEM_USER_A_PERSON.userid,
        archiveId: body.data.archiveid,
        siteId: TENANT_A.siteId,
        effectiveFrom: '2026-07-01 00:00:00.000',
        archivedAt: '2026-06-30 12:00:00.000',
      },
    });
    expect(t.identity.requests.map((request) => request.operationId)).toEqual(['consumeCsrfToken', 'getCurrentSession']);
  });

  it.each<[string, Pick<ArchiveCall, 'query' | 'body'>]>([
    ['a query parameter, trimmed as Masa trims url values', { query: { effectiveFrom: ` ${ARCHIVE_EFFECTIVE_FROM} ` }, body: {} }],
    ['a form field', { body: `effectiveFrom=${ARCHIVE_EFFECTIVE_FROM}` }],
  ])('takes effectiveFrom from %s', async (_label, call) => {
    const response = await callArchive(t.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A), ...call });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ method: METHOD, data: { personid: SYSTEM_USER_A_PERSON.userid, effectivefrom: EFFECTIVE_FROM_TEXT } });
  });

  it('moves the record to the top level when useDataNamespace is false', async () => {
    const response = await callArchive(t.app, {
      userId: SYSTEM_USER_A_PERSON.userid,
      headers: await actorHeaders(SITE_ADMIN_A),
      query: { usedatanamespace: 'false' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['apiversion', 'archivedat', 'archiveid', 'effectivefrom', 'method', 'personid', 'siteid']);
    expect(body).toMatchObject({ method: METHOD, personid: SYSTEM_USER_A_PERSON.userid, siteid: TENANT_A.siteId });
  });

  it('reads instead of writing when X-HTTP-Method-Override is GET, consuming no CSRF token', async () => {
    const response = await callArchive(t.app, {
      userId: ARCHIVED_PERSON_B.userid,
      headers: { ...(await actorHeaders(OTHER_TENANT)), 'x-http-method-override': 'GET' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      apiversion: 'v1',
      method: METHOD,
      data: { archiveid: TENANT_B_ARCHIVE.archive_id, personid: ARCHIVED_PERSON_B.userid, siteid: TENANT_B.siteId, effectivefrom: '2026-06-01T00:00:00', archivedat: ARCHIVED_AT_TEXT },
    });
    expect(t.identity.requests).toEqual([]);
    expect(t.db.writes()).toEqual([]);
  });

  it('lets an S2 user through the site-admin check, and GET answers notFound for a person never archived', async () => {
    const response = await callArchive(t.app, {
      method: 'GET',
      userId: SYSTEM_USER_A_PERSON.userid,
      headers: await actorHeaders(ADMIN_S2, { site: TENANT_A.siteId }),
    });

    expectFixtureError(response, NOT_FOUND);
    expect(personReads(t.db)).toEqual([...PUBLIC_THEN_PRIVATE, TENANT_A.tenantId]);
    expect(t.db.statements().some(({ text }) => ARCHIVE_BY_PERSON.test(text))).toBe(true);
    expect(t.identity.requests).toEqual([]);
  });
});


/** A stored `person_archive` row as the test reads it back. */
interface ArchiveRow {
  archive_id: string;
  person_id: string;
  siteid: string;
  archived_by_id: string | null;
  archived_by: string | null;
}

describe.skipIf(!PG_AVAILABLE)('the fixture archive route against PostgreSQL', () => {
  /** Runs `fn` over a seeded throwaway schema; fails rather than skips once PostgreSQL was found at import. */
  async function onPg(fn: (ctx: PgTestApp) => Promise<void>): Promise<void> {
    const outcome = await withPgApp(async (ctx) => {
      await seedPeople(ctx.db, DEFAULT_PEOPLE_SEED);
      await fn(ctx);
      return 'ran' as const;
    });
    expect(outcome).toBe('ran');
  }

  /** Rows of `sql` read in a transaction of `tenantId`. */
  async function rowsIn<R>(ctx: PgTestApp, tenantId: string, sql: string, params: unknown[] = []): Promise<R[]> {
    return ctx.db.withTenant(tenantId, async (tx) => (await tx.query(sql, params)).rows as R[]);
  }

  const archivesOf = (ctx: PgTestApp, tenantId: string, personId: string): Promise<ArchiveRow[]> =>
    rowsIn<ArchiveRow>(
      ctx,
      tenantId,
      `SELECT archive_id, person_id, siteid, archived_by_id, archived_by FROM ${ctx.schema.schema}.person_archive WHERE person_id = $1`,
      [personId],
    );

  const outboxOf = (ctx: PgTestApp, tenantId: string, personId: string): Promise<Array<{ topic: string; published: boolean }>> =>
    rowsIn(ctx, tenantId, `SELECT topic, published_at IS NOT NULL AS published FROM ${ctx.schema.schema}.outbox WHERE ordering_key = $1`, [personId]);

  /** Changelog rows the requests wrote, as opposed to the seed's backfill rows. */
  const targetChanges = (ctx: PgTestApp, tenantId: string): Promise<Array<{ table: string; op: string }>> =>
    rowsIn(ctx, tenantId, `SELECT "table", op FROM ${ctx.schema.schema}.changelog WHERE origin = 'target' ORDER BY seq`);

  it('commits the archive with its outbox row, publishes it in the request, and writes no person or identity data', async () => {
    await onPg(async (ctx) => {
      const sid = 'SESSION-ARCHIVE-PG';
      ctx.identity.seedSessions({ sessionId: sid, user: { isLoggedIn: true, userID: SITE_ADMIN_A.sub, ...SADMIN_NAMES } });
      const before = await rowsIn<{ row_version: string }>(ctx, TENANT_A.tenantId, `SELECT row_version FROM ${ctx.schema.schema}.person WHERE userid = $1`, [
        SYSTEM_USER_A_PERSON.userid,
      ]);

      const response = await callArchive(ctx.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A, { sid }) });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: { archiveid: string } }>();
      const archiveId = body.data.archiveid;
      expect(isCfUuid(archiveId)).toBe(true);
      expect(body).toStrictEqual({
        apiversion: 'v1',
        method: METHOD,
        data: { archiveid: archiveId, personid: SYSTEM_USER_A_PERSON.userid, siteid: TENANT_A.siteId, effectivefrom: EFFECTIVE_FROM_TEXT, archivedat: ARCHIVED_AT_TEXT },
      });
      expect(response.headers['x-opt2-write-position']).toMatch(/^people=\d+$/);

      expect(ctx.publisher.published).toHaveLength(1);
      const [event] = ctx.publisher.published;
      expect(event?.topic).toBe(PERSON_ARCHIVED_TOPIC);
      expect(assertEventMatches(undefined, personArchivedSchema, event?.envelope)).toMatchObject({
        tenantId: TENANT_A.tenantId,
        aggregateId: SYSTEM_USER_A_PERSON.userid,
        payload: {
          personId: SYSTEM_USER_A_PERSON.userid,
          archiveId,
          siteId: TENANT_A.siteId,
          effectiveFrom: '2026-07-01 00:00:00.000',
          archivedAt: '2026-06-30 12:00:00.000',
        },
      });

      expect(await archivesOf(ctx, TENANT_A.tenantId, SYSTEM_USER_A_PERSON.userid)).toStrictEqual([
        { archive_id: archiveId, person_id: SYSTEM_USER_A_PERSON.userid, siteid: TENANT_A.siteId, archived_by_id: SITE_ADMIN_A.sub, archived_by: 'Sasha Admin' },
      ]);
      expect(await outboxOf(ctx, TENANT_A.tenantId, SYSTEM_USER_A_PERSON.userid)).toStrictEqual([{ topic: PERSON_ARCHIVED_TOPIC, published: true }]);
      expect(await targetChanges(ctx, TENANT_A.tenantId)).toStrictEqual([{ table: 'person_archive', op: 'insert' }]);
      expect(
        await rowsIn(ctx, TENANT_A.tenantId, `SELECT row_version FROM ${ctx.schema.schema}.person WHERE userid = $1`, [SYSTEM_USER_A_PERSON.userid]),
      ).toStrictEqual(before);
      expect(ctx.identity.requests.map((request) => request.operationId)).toEqual(['consumeCsrfToken', 'getCurrentSession']);
      expect(ctx.identity.operations.size).toBe(0);
    });
  });

  it('archives a pooled member through tenant-a in the umbrella tenant, and GET reads the stored record back', async () => {
    await onPg(async (ctx) => {
      const posted = await callArchive(ctx.app, { userId: MEMBER_POOLED.sub, headers: await actorHeaders(SITE_ADMIN_A) });

      expect(posted.statusCode).toBe(200);
      const { data } = posted.json<{ data: { archiveid: string; siteid: string } }>();
      expect(data.siteid).toBe(TENANT_UMBRELLA.siteId);
      expect(ctx.publisher.published.map(({ envelope }) => [envelope.tenantId, (envelope.payload as { siteId: string }).siteId])).toStrictEqual([
        [TENANT_UMBRELLA.tenantId, TENANT_UMBRELLA.siteId],
      ]);
      expect((await archivesOf(ctx, TENANT_UMBRELLA.tenantId, MEMBER_POOLED.sub)).map((row) => row.archive_id)).toEqual([data.archiveid]);
      expect(await archivesOf(ctx, TENANT_A.tenantId, MEMBER_POOLED.sub)).toEqual([]);

      const read = await callArchive(ctx.app, { method: 'GET', userId: MEMBER_POOLED.sub, headers: await actorHeaders(SITE_ADMIN_A) });

      expect(read.statusCode).toBe(200);
      expect(read.json()).toStrictEqual(posted.json());
      assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: archivePath(MEMBER_POOLED.sub), status: 200, contentType: read.headers['content-type'], body: read.json() });
    });
  });

  it('reads a seeded archive record, answers notFound for a person never archived, and invalidParameters for a site id PostgreSQL cannot store', async () => {
    await onPg(async (ctx) => {
      const seeded = await callArchive(ctx.app, { method: 'GET', userId: ARCHIVED_PERSON_B.userid, headers: await actorHeaders(OTHER_TENANT) });
      expect(seeded.statusCode).toBe(200);
      expect(seeded.json()).toStrictEqual({
        apiversion: 'v1',
        method: METHOD,
        data: { archiveid: TENANT_B_ARCHIVE.archive_id, personid: ARCHIVED_PERSON_B.userid, siteid: TENANT_B.siteId, effectivefrom: '2026-06-01T00:00:00', archivedat: ARCHIVED_AT_TEXT },
      });

      expectFixtureError(await callArchive(ctx.app, { method: 'GET', userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A) }), NOT_FOUND);

      const nul = await callArchive(ctx.app, { method: 'GET', userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A), query: { siteid: 'tenant\u0000a' } });
      expectFixtureError(nul, LEGACY_ERROR_MAP.invalidParameters);
    });
  });

  it('refuses any second archive of a person with badRequest, keeping one archive row and one outbox row', async () => {
    await onPg(async (ctx) => {
      const first = await callArchive(ctx.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A) });
      expect(first.statusCode).toBe(200);

      for (const effectiveFrom of [ARCHIVE_EFFECTIVE_FROM, '2026-08-01']) {
        const repeat = await callArchive(ctx.app, { userId: SYSTEM_USER_A_PERSON.userid, headers: await actorHeaders(SITE_ADMIN_A), body: { effectiveFrom } });
        expectFixtureError(repeat, LEGACY_ERROR_MAP.badRequest);
      }

      expect(await archivesOf(ctx, TENANT_A.tenantId, SYSTEM_USER_A_PERSON.userid)).toHaveLength(1);
      expect(await outboxOf(ctx, TENANT_A.tenantId, SYSTEM_USER_A_PERSON.userid)).toHaveLength(1);
      expect(ctx.publisher.published).toHaveLength(1);
    });
  });

  it('rolls the archive back when its outbox event is rejected after the insert, answering server_error', async () => {
    await onPg(async (ctx) => {
      // Backfilled persons keep row_version 0, below the envelope's aggregateVersion minimum.
      const unbumped = personRow({ siteid: TENANT_A.siteId, row_version: '0' });
      await seedPeople(ctx.db, { [TENANT_A.tenantId]: { persons: [unbumped] } });

      const response = await callArchive(ctx.app, { userId: unbumped.userid, headers: await actorHeaders(SITE_ADMIN_A) });

      expectFixtureError(response, LEGACY_ERROR_MAP.server_error);
      expect(await archivesOf(ctx, TENANT_A.tenantId, unbumped.userid)).toEqual([]);
      expect(await outboxOf(ctx, TENANT_A.tenantId, unbumped.userid)).toEqual([]);
      expect(await targetChanges(ctx, TENANT_A.tenantId)).toEqual([]);
      expect(ctx.publisher.published).toEqual([]);
    });
  });
});

