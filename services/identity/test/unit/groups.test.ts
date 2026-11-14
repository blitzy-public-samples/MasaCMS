/** Group CRUD, memberships and the cUsers group routes over the memory repository and recording database: no PostgreSQL, network or running stack. */
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, moduleRole } from '@opt2/platform/auth';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  cfQueryCellText,
  cfQueryColumnOrder,
  generateCsrfToken,
  legacyUsersCsv,
} from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { createService, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertResponseMatchesOpenApi,
  createCapturingPublisher,
  fixedClock,
  fixtureForSite,
  mintServiceToken,
  mintUserToken,
  registryPayloads,
  testVerifier,
} from '@opt2/platform/testing';
import { SERVICE_NAME, SERVICE_VERSION } from '../../src/app.js';
import {
  GroupPhotoWithheldError,
  GroupSaveHaltedError,
  addToGroup,
  createGroup,
  deleteGroup,
  findGroupForSite,
  listGroupMembers,
  listGroups,
  removeFromGroup,
  resolveGroupSite,
  updateGroup,
  type GroupActor,
  type GroupDeps,
  type GroupMemberRow,
  type GroupSaveInput,
} from '../../src/domain/groups.js';
import { GROUP_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC, createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import {
  CREDENTIAL,
  GROUP_ACCOUNT,
  GROUP_ADDRESS,
  GROUP_EXTEND_DATA,
  GROUP_INTEREST,
  GROUP_TAG,
  GROUP_TRASH,
  IDENTITY_UNITS,
  MEMBERSHIP,
  OWNED_TABLES,
  USER_ACCOUNT,
} from '../../src/repo/tables.js';
import { registerAdminGroupRoutes, type AdminGroupRouteDeps } from '../../src/routes/admin-groups.js';
import { buildTestApp, createTestStateDir, headersFor, testEnv, type TestApp } from '../helpers/app.js';
import {
  createMemoryIdentityRepo,
  createRecordingDb,
  type IdentitySeed,
  type MemoryIdentityRepo,
  type MemoryWrite,
  type RecordingDb,
} from '../helpers/memory-repo.js';
import {
  ADMIN_S2,
  EDITOR,
  SITE_ADMIN_A,
  accountRow,
  actorSeed,
  groupRow,
  loginSnapshotFixture,
  membershipRow,
  personContactRow,
  sessionRow,
} from '../helpers/rows.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Envelope = ReturnType<typeof assertEventMatches>;

const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const CLOCK = fixedClock(NOW);
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const GROUP_CHANGED_SCHEMA = JSON.parse(readFileSync(new URL(`../../contracts/events/${GROUP_CHANGED_TOPIC}.json`, import.meta.url), 'utf8')) as object;
const MEMBERSHIP_CHANGED_SCHEMA = JSON.parse(
  readFileSync(new URL(`../../contracts/events/${MEMBERSHIP_CHANGED_TOPIC}.json`, import.meta.url), 'utf8'),
) as object;
const SETTINGS: NonNullable<GroupDeps['settings']> = {
  password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 },
  hashAlgorithm: 'CFMX_COMPAT',
};
const USERS_MODULE = moduleRole('00000000000000000000000000000000008');
const SITE_MANAGER_MODULE = moduleRole('00000000000000000000000000000000000');
const S2_ROLES = [Roles.systemUser, Roles.s2] as const;
const SITE_ADMIN_ROLES = [Roles.systemUser, Roles.siteAdmin] as const;
const FORM_BODY = { 'content-type': 'application/x-www-form-urlencoded' };
const QUIET = createLogger({ service: SERVICE_NAME, version: SERVICE_VERSION, env: 'local', destination: { write: () => undefined } });
const noSleep = (): Promise<void> => Promise.resolve();

/** A 35-character CF UUID numbered `n` under the hex digit `prefix`. */
function cfId(prefix: string, n: number): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const STORED_PHOTO = cfId('F', 1);
const CATEGORY = cfId('C', 1);
const SESSION_ID = 'S-groups-admin';
const SESSION_SECRET = cfId('5', 1);
const EDITORS = groupRow({ userid: cfId('B', 1), groupname: 'Editors' });
const PARENT = groupRow({ userid: cfId('B', 2), groupname: 'Parent', perm: 1 });
const PICTURED = groupRow({ userid: cfId('B', 3), groupname: 'Pictured', photofileid: STORED_PHOTO });
const MEMBERS = groupRow({ tenant_id: TENANT_UMBRELLA.tenantId, siteid: TENANT_UMBRELLA.siteId, userid: cfId('B', 4), groupname: 'Members', ispublic: 1 });
const TWIN_A = groupRow({ userid: cfId('B', 8), groupname: 'Twin A' });
const TWIN_B = groupRow({ tenant_id: TENANT_B.tenantId, siteid: SITE_B, userid: TWIN_A.userid, groupname: 'Twin B' });
const B_GROUP = groupRow({ tenant_id: TENANT_B.tenantId, siteid: SITE_B, userid: cfId('B', 9), groupname: 'Tenant B' });
const ALPHA = accountRow({ userid: cfId('E', 1), username: 'alpha' });
const BETA = accountRow({ userid: cfId('E', 2), username: 'beta' });
const ZED = accountRow({ userid: cfId('E', 3), username: 'zed', s2: 1 });
const NEW_GROUP = cfId('B', 10);
const UNKNOWN_ID = cfId('D', 1);
const SUPER: GroupActor = { userId: ADMIN_S2.account.userid, fname: 'Admin', lname: 'User', isSuperUser: true };

/** The tenant of a fixture site; every registry pool is one. */
function tenantOfSite(siteId: string): string {
  const fixture = fixtureForSite(siteId);
  if (fixture === undefined) throw new TypeError(`${siteId} is no tenant fixture`);
  return fixture.tenantId;
}

/** `tenant_registry` rows of the three platform fixture sites, ordered by site id. */
const REGISTRY_ROWS: readonly Record<string, unknown>[] = registryPayloads().map((site) => {
  const pool = (id: string | null | undefined): string => id ?? site.siteId;
  const pools = {
    public_user_pool: pool(site.publicUserPoolId),
    private_user_pool: pool(site.privateUserPoolId),
    category_pool: pool(site.categoryPoolId),
    file_pool: pool(site.filePoolId),
    display_pool: pool(site.displayPoolId),
  };
  const content = [site.contentPoolIds ?? []].flat();
  return {
    site_id: site.siteId,
    tenant_id: tenantOfSite(site.siteId),
    ...Object.fromEntries(Object.entries(pools).flatMap(([column, id]) => [[`${column}_id`, id], [`${column}_tenant`, tenantOfSite(id)]])),
    content_pool_ids: content,
    content_pool_tenants: content.map(tenantOfSite),
    domains: site.domains ?? [],
    aggregate_version: '1',
    updated_at: NOW,
  };
});

const REGISTRY_READ = /FROM identity\.tenant_registry\b/;

/** Answers the platform's registry reads from REGISTRY_ROWS by their WHERE clause. */
function registryAnswer(sql: string, values: readonly unknown[]): Record<string, unknown>[] {
  const [first] = values;
  if (/WHERE lower\(site_id\) = lower\(\$1\)/.test(sql)) return REGISTRY_ROWS.filter((row) => String(row.site_id) === String(first).toLowerCase());
  if (/WHERE public_user_pool_tenant = \$1 OR private_user_pool_tenant = \$1/.test(sql)) {
    return REGISTRY_ROWS.filter((row) => row.public_user_pool_tenant === first || row.private_user_pool_tenant === first);
  }
  if (/WHERE tenant_id = \$1/.test(sql)) return REGISTRY_ROWS.filter((row) => row.tenant_id === first);
  return [...REGISTRY_ROWS];
}

/** A recording database answering the registry, with identity's outbox runtime registered on it. */
function registryDb(): RecordingDb {
  const db = createRecordingDb();
  db.respond(REGISTRY_READ, registryAnswer);
  createOutbox({ service: SERVICE_NAME, db, publisher: createCapturingPublisher(), logger: QUIET, clock: CLOCK, payloadValidators: identityPayloadValidators });
  return db;
}

/** The site admin's rows, tenant-a's groups and members, the umbrella's member group, tenant-b's groups and the S2 admin's session. */
function seed(): IdentitySeed {
  const base = actorSeed(SITE_ADMIN_A);
  const contact = (userid: string, lname: string, extra: Parameters<typeof personContactRow>[0] = {}) =>
    personContactRow({ user_id: userid, fname: 'F', lname, ...extra });
  return {
    ...base,
    accounts: [...(base.accounts ?? []), ALPHA, BETA, ZED],
    personContacts: [
      ...(base.personContacts ?? []),
      contact(ALPHA.userid, 'alpha', { company: 'A, B', photofileid: STORED_PHOTO }),
      contact(BETA.userid, 'Beta'),
      contact(ZED.userid, 'Zed'),
    ],
    groups: [...(base.groups ?? []), EDITORS, PARENT, PICTURED, MEMBERS, TWIN_A, TWIN_B, B_GROUP],
    memberships: [
      ...(base.memberships ?? []),
      membershipRow({ userid: ALPHA.userid, groupid: EDITORS.userid }),
      membershipRow({ userid: ZED.userid, groupid: EDITORS.userid }),
      membershipRow({ userid: BETA.userid, groupid: PARENT.userid }),
    ],
    sessions: [
      sessionRow({
        session_id: SESSION_ID,
        user_id: ADMIN_S2.account.userid,
        login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: ADMIN_S2 })),
        csrf_secret: SESSION_SECRET,
      }),
    ],
  };
}

/**
 * `store` with each member wrapped to record the transaction argument of every call that mutated it. The store is a frozen
 * proxy, so the wrappers sit on an object inheriting from it, which keeps its refusal of members it does not implement.
 */
function trackTransactions(store: MemoryIdentityRepo): { repo: MemoryIdentityRepo; transactions: Set<unknown> } {
  const transactions = new Set<unknown>();
  const repo = Object.create(store) as MemoryIdentityRepo;
  for (const key of Object.keys(store)) {
    const member: unknown = Reflect.get(store, key);
    if (typeof member !== 'function') continue;
    const value = (...args: unknown[]): unknown => {
      const before = store.writes().length;
      const result: unknown = Reflect.apply(member, store, args);
      if (!(result instanceof Promise)) return result;
      return result.then((settled: unknown) => {
        if (store.writes().length > before) transactions.add(args[0]);
        return settled;
      });
    };
    Object.defineProperty(repo, key, { value, enumerable: true });
  }
  return { repo, transactions };
}

/** Group deps over `db` and `repo` with test password rounds and no sleeping. */
function groupDeps(db: RecordingDb, repo: MemoryIdentityRepo): GroupDeps {
  return { db, repo, events: createIdentityEvents(repo), clock: CLOCK, settings: SETTINGS, sleep: noSleep };
}

/** Envelopes of the committed `identity.outbox` inserts of `topic`, in commit order. */
function outboxEvents(db: RecordingDb, topic: string): Record<string, unknown>[] {
  return db
    .writes()
    .filter((write) => write.verb === 'INSERT' && write.table === 'identity.outbox' && write.values[2] === topic)
    .map((write) => JSON.parse(String(write.values[5])) as Record<string, unknown>);
}

/** The units the memory writes touched; tables without a unit (sequences, sessions, claims) are left out. */
function writtenUnits(writes: readonly MemoryWrite[]): string[] {
  const units = writes.flatMap((write) => {
    const unit = OWNED_TABLES.find((def) => def.table === write.table)?.unit;
    return unit === undefined ? [] : [unit];
  });
  return [...new Set(units)].sort();
}

/** Every memory write carries the changelog images its op records: `after` unless deleted, `before` unless inserted. */
function expectChangelogImages(writes: readonly MemoryWrite[]): void {
  expect(writes.length).toBeGreaterThan(0);
  for (const write of writes) {
    expect({ table: write.table, op: write.op, before: write.before !== undefined, after: write.after !== undefined }).toEqual({
      table: write.table,
      op: write.op,
      before: write.op !== 'insert',
      after: write.op !== 'delete',
    });
  }
}

/** Stored rows of `table` in tenant-a whose `column` names `id`. */
function rowsOf(repo: MemoryIdentityRepo, table: Parameters<MemoryIdentityRepo['rows']>[0], column: string, id: string): Record<string, unknown>[] {
  return (repo.rows(table, TENANT_A.tenantId) as unknown as Record<string, unknown>[]).filter((row) => String(row[column]).toUpperCase() === id.toUpperCase());
}

interface DomainHarness {
  db: RecordingDb;
  store: MemoryIdentityRepo;
  deps: GroupDeps;
  transactions: Set<unknown>;
  /** Forgets every recorded statement, write and transaction; stored rows stay. */
  reset(): void;
}

function domainHarness(): DomainHarness {
  const db = registryDb();
  const store = createMemoryIdentityRepo(seed(), { clock: CLOCK });
  const { repo, transactions } = trackTransactions(store);
  return {
    db,
    store,
    deps: groupDeps(db, repo),
    transactions,
    reset() {
      db.clear();
      db.respond(REGISTRY_READ, registryAnswer);
      store.clear();
      transactions.clear();
    },
  };
}

/** A private tenant-a group save posting a parent group, an interest, two tags, one extended attribute and the primary address. */
const FULL_SAVE: GroupSaveInput = {
  userId: NEW_GROUP,
  siteId: SITE_A,
  groupName: 'Reviewers',
  isPublic: 0,
  tags: 'alpha, beta',
  groupID: PARENT.userid,
  categoryID: CATEGORY,
  extendSetID: 'S1',
  extendData: [
    { attributeId: 7, values: { siteid: SITE_A, attributevalue: 'Blue', remoteid: null, datetimevalue: null, numericvalue: null, stringvalue: 'Blue' } },
  ],
  address: { address1: '1 Main St', city: 'Springfield' },
};

describe('group saves of Type=1 rows [userManager.cfc:563-744; userDAO.cfc:300-500]', () => {
  let h: DomainHarness;

  beforeEach(() => {
    h = domainHarness();
  });

  it('creates the group row and its membership, interest, tag, extended-data and address rows in one identity transaction [userManager.cfc:601-611,659-660]', async () => {
    const result = await createGroup(h.deps, SUPER, FULL_SAVE);

    expect(result).toMatchObject({ written: true, errors: {}, group: { userid: NEW_GROUP, groupname: 'Reviewers', type: 1, ispublic: 0, siteid: SITE_A, lastupdateby: 'Admin User' } });
    const writes = h.store.writes();
    expect(h.transactions.size).toBe(1);
    expect(writes.every((write) => write.tenantId === TENANT_A.tenantId)).toBe(true);
    expect(writtenUnits(writes)).toEqual(
      [GROUP_ACCOUNT, MEMBERSHIP, GROUP_INTEREST, GROUP_TAG, GROUP_EXTEND_DATA, GROUP_ADDRESS].map((def) => def.unit).sort(),
    );
    expect(IDENTITY_UNITS).toEqual(expect.arrayContaining(writtenUnits(writes)));
    expectChangelogImages(writes);
    expect(rowsOf(h.store, GROUP_TAG.table, 'userid', NEW_GROUP).map((row) => row.tag)).toEqual(['alpha', 'beta']);
    expect(rowsOf(h.store, GROUP_INTEREST.table, 'userid', NEW_GROUP).map((row) => row.categoryid)).toEqual([CATEGORY]);
    expect(rowsOf(h.store, GROUP_EXTEND_DATA.table, 'baseid', NEW_GROUP)).toEqual([expect.objectContaining({ attributeid: 7, stringvalue: 'Blue' })]);
    expect(rowsOf(h.store, GROUP_ADDRESS.table, 'userid', NEW_GROUP)).toEqual([
      expect.objectContaining({ addressname: 'Primary', address1: '1 Main St', city: 'Springfield', isprimary: 1, siteid: SITE_A }),
    ]);
    expect(rowsOf(h.store, MEMBERSHIP.table, 'userid', NEW_GROUP).map((row) => row.groupid)).toEqual([PARENT.userid]);
  });

  it('emits one group.changed state event at the row version, and the group own membership set', async () => {
    await createGroup(h.deps, SUPER, FULL_SAVE);

    const [stored] = rowsOf(h.store, GROUP_ACCOUNT.table, 'userid', NEW_GROUP);
    const groupEvents = outboxEvents(h.db, GROUP_CHANGED_TOPIC).map((event) => assertEventMatches(undefined, GROUP_CHANGED_SCHEMA, event));
    expect(groupEvents).toHaveLength(1);
    expect(groupEvents[0]).toMatchObject({
      tenantId: TENANT_A.tenantId,
      aggregateId: NEW_GROUP,
      aggregateVersion: Number(stored?.row_version),
      payload: { groupId: NEW_GROUP, siteId: SITE_A, groupName: 'Reviewers', type: 1, isPublic: 0, poolTenantId: TENANT_A.tenantId, deleted: false },
    });
    const membershipEvents = outboxEvents(h.db, MEMBERSHIP_CHANGED_TOPIC).map((event) => assertEventMatches(undefined, MEMBERSHIP_CHANGED_SCHEMA, event));
    expect(membershipEvents.map((event) => event.payload)).toEqual([{ userId: NEW_GROUP, siteId: SITE_A, groupIds: [PARENT.userid] }]);
  });

  it('updates the row at the next row version and announces it at that higher version', async () => {
    await createGroup(h.deps, SUPER, FULL_SAVE);
    h.reset();

    const result = await updateGroup(h.deps, SUPER, { userId: NEW_GROUP, siteId: SITE_A, groupName: 'Senior Reviewers', isPublic: 0 });

    expect(result).toMatchObject({ written: true, errors: {}, group: { userid: NEW_GROUP, groupname: 'Senior Reviewers' } });
    const [stored] = rowsOf(h.store, GROUP_ACCOUNT.table, 'userid', NEW_GROUP);
    expect(Number(stored?.row_version)).toBe(2);
    expect(h.transactions.size).toBe(1);
    expectChangelogImages(h.store.writes());
    const [event] = outboxEvents(h.db, GROUP_CHANGED_TOPIC).map((raw) => assertEventMatches(undefined, GROUP_CHANGED_SCHEMA, raw));
    expect(event).toMatchObject({ aggregateVersion: 2, payload: { groupName: 'Senior Reviewers', deleted: false } });
  });

  it('writes nothing when updating an id no group holds', async () => {
    const result = await updateGroup(h.deps, SUPER, { userId: UNKNOWN_ID, siteId: SITE_A, groupName: 'Ghost', isPublic: 0 });

    expect(result).toMatchObject({ written: false, errors: {}, group: { userid: UNKNOWN_ID, groupname: 'Ghost' } });
    expect(h.store.writes()).toEqual([]);
    expect(h.db.writes()).toEqual([]);
  });

  it('deletes the row with its extended data and tags into the trash, leaving its memberships, members, addresses and interests [userManager.cfc:705-744]', async () => {
    await createGroup(h.deps, SUPER, FULL_SAVE);
    await addToGroup(h.deps, { userId: ALPHA.userid, groupId: NEW_GROUP });
    h.reset();

    expect(await deleteGroup(h.deps, SUPER, { groupId: NEW_GROUP, siteId: SITE_A })).toBe(true);

    expect(h.transactions.size).toBe(1);
    expect(IDENTITY_UNITS).toEqual(expect.arrayContaining(writtenUnits(h.store.writes())));
    expectChangelogImages(h.store.writes());
    expect(rowsOf(h.store, GROUP_ACCOUNT.table, 'userid', NEW_GROUP)).toEqual([]);
    expect(rowsOf(h.store, GROUP_TRASH.table, 'objectid', NEW_GROUP)).toEqual([expect.objectContaining({ objectclass: 'user', objecttype: 'Group', objectlabel: 'Reviewers' })]);
    expect(rowsOf(h.store, GROUP_TAG.table, 'userid', NEW_GROUP)).toEqual([]);
    expect(rowsOf(h.store, GROUP_EXTEND_DATA.table, 'baseid', NEW_GROUP)).toEqual([]);
    expect(rowsOf(h.store, GROUP_ADDRESS.table, 'userid', NEW_GROUP)).toHaveLength(1);
    expect(rowsOf(h.store, GROUP_INTEREST.table, 'userid', NEW_GROUP)).toHaveLength(1);
    expect(rowsOf(h.store, MEMBERSHIP.table, 'userid', NEW_GROUP).map((row) => row.groupid)).toEqual([PARENT.userid]);
    expect(rowsOf(h.store, MEMBERSHIP.table, 'groupid', NEW_GROUP).map((row) => row.userid)).toEqual([ALPHA.userid]);
    const events = outboxEvents(h.db, GROUP_CHANGED_TOPIC).map((raw) => assertEventMatches(undefined, GROUP_CHANGED_SCHEMA, raw));
    expect(events).toEqual([expect.objectContaining({ aggregateVersion: 2, payload: expect.objectContaining({ groupId: NEW_GROUP, groupName: 'Reviewers', deleted: true }) })]);
  });

  it('answers false for deleting an unknown id', async () => {
    expect(await deleteGroup(h.deps, SUPER, { groupId: UNKNOWN_ID, siteId: SITE_A })).toBe(false);
    expect(h.store.writes()).toEqual([]);
  });

  it('withholds deleting a group with a stored photo, which writes strategies-content data, before any write', async () => {
    await expect(deleteGroup(h.deps, SUPER, { groupId: PICTURED.userid, siteId: SITE_A })).rejects.toBeInstanceOf(GroupPhotoWithheldError);

    expect(h.store.writes()).toEqual([]);
    expect(h.db.writes()).toEqual([]);
    expect(rowsOf(h.store, GROUP_ACCOUNT.table, 'userid', PICTURED.userid)).toHaveLength(1);
  });
});

describe('group save validation and halts [userBean.cfc:447-522]', () => {
  let h: DomainHarness;

  beforeEach(() => {
    h = domainHarness();
  });

  it.each<[string, Partial<GroupSaveInput>, Record<string, string>]>([
    ['a site with no registered user pool', { siteId: 'nowhere' }, { siteid: "The 'SiteID' variable is missing." }],
    ['a security code that does not match its key', { hKey: 'not-the-hash', uKey: 'ABCD' }, { SecurityCode: "The 'Security Code' entered was not correct." }],
    ['a submission that failed spam protection', { passedProtect: 'false' }, { Spam: 'This submission has been marked as spam.' }],
  ])('returns the legacy errors and writes nothing for %s', async (_case, extra, errors) => {
    const result = await createGroup(h.deps, SUPER, { userId: NEW_GROUP, siteId: SITE_A, groupName: 'Rejected', isPublic: 0, ...extra });

    expect(result).toMatchObject({ written: false, errors, group: { userid: NEW_GROUP, groupname: 'Rejected' } });
    expect(h.store.writes()).toEqual([]);
    expect(h.db.writes()).toEqual([]);
  });

  it('throws before saving a group posted without a site id [userManager.cfc:597-599]', async () => {
    await expect(createGroup(h.deps, SUPER, { groupName: 'Siteless' })).rejects.toThrow("The attribute 'SITEID' is required when saving a user.");
    expect(h.store.writes()).toEqual([]);
  });

  it.each<[string, Partial<GroupSaveInput>]>([
    ['pool-move', { switchToPublic: '1' }],
    ['origin-interests', { originID: SITE_A, categoryID: CATEGORY }],
  ])('halts an update needing the %s write before any write', async (halt, extra) => {
    const update = updateGroup(h.deps, SUPER, { userId: EDITORS.userid, siteId: SITE_A, groupName: 'Editors', isPublic: 0, ...extra });

    await expect(update).rejects.toBeInstanceOf(GroupSaveHaltedError);
    await expect(update).rejects.toMatchObject({ groupId: EDITORS.userid, halt });
    expect(h.store.writes()).toEqual([]);
  });

  it.each<[string, Parameters<typeof resolveGroupSite>[1], Awaited<ReturnType<typeof resolveGroupSite>>]>([
    ['the private pool', { siteId: SITE_A, isPublic: 0 }, { poolSiteId: SITE_A, isPublic: 0, tenantId: TENANT_A.tenantId }],
    ['the public pool', { siteId: SITE_A, isPublic: 1 }, { poolSiteId: TENANT_UMBRELLA.siteId, isPublic: 1, tenantId: TENANT_UMBRELLA.tenantId }],
    ['switchToPublic', { siteId: SITE_A, isPublic: 0, switchToPublic: '1' }, { poolSiteId: TENANT_UMBRELLA.siteId, isPublic: 1, tenantId: TENANT_UMBRELLA.tenantId }],
    ['switchToPrivate', { siteId: SITE_A, isPublic: 1, switchToPrivate: 1 }, { poolSiteId: SITE_A, isPublic: 0, tenantId: TENANT_A.tenantId }],
    ['an unregistered site', { siteId: 'nowhere', isPublic: 0 }, { poolSiteId: null, isPublic: 0, tenantId: null }],
  ])('resolves the user pool a save lands in for %s [userBean.cfc:227-239]', async (_case, input, expected) => {
    expect(await resolveGroupSite(h.db, input)).toEqual(expected);
  });
});

describe('memberships [userDAO.cfc:535-559,646-660]', () => {
  let h: DomainHarness;

  beforeEach(() => {
    h = domainHarness();
  });

  /** Payloads of the committed membership.changed events, each checked against its contract. */
  function membershipPayloads(): Envelope['payload'][] {
    return outboxEvents(h.db, MEMBERSHIP_CHANGED_TOPIC).map((raw) => assertEventMatches(undefined, MEMBERSHIP_CHANGED_SCHEMA, raw).payload);
  }

  it('adds a membership and announces the user full group set once, a repeat adding no second row', async () => {
    expect(await addToGroup(h.deps, { userId: BETA.userid, groupId: EDITORS.userid })).toBe(true);
    expect(await addToGroup(h.deps, { userId: BETA.userid, groupId: EDITORS.userid })).toBe(false);

    expect(h.transactions.size).toBe(1);
    expect(writtenUnits(h.store.writes())).toEqual([MEMBERSHIP.unit]);
    expect(rowsOf(h.store, MEMBERSHIP.table, 'userid', BETA.userid).map((row) => row.groupid).sort()).toEqual([EDITORS.userid, PARENT.userid]);
    expect(membershipPayloads()).toEqual([{ userId: BETA.userid, siteId: SITE_A, groupIds: [EDITORS.userid, PARENT.userid] }]);
  });

  it('removes memberships and announces each remaining set, down to none', async () => {
    await addToGroup(h.deps, { userId: BETA.userid, groupId: EDITORS.userid });
    h.reset();

    expect(await removeFromGroup(h.deps, { userId: BETA.userid, groupId: EDITORS.userid })).toBe(true);
    expect(await removeFromGroup(h.deps, { userId: BETA.userid, groupId: PARENT.userid })).toBe(true);
    expect(await removeFromGroup(h.deps, { userId: BETA.userid, groupId: PARENT.userid })).toBe(false);

    expectChangelogImages(h.store.writes().filter((write) => write.table === MEMBERSHIP.table));
    expect(rowsOf(h.store, MEMBERSHIP.table, 'userid', BETA.userid)).toEqual([]);
    expect(membershipPayloads()).toEqual([
      { userId: BETA.userid, siteId: SITE_A, groupIds: [PARENT.userid] },
      { userId: BETA.userid, siteId: SITE_A, groupIds: [] },
    ]);
  });

  it('changes nothing for a member id no account or group holds', async () => {
    expect(await addToGroup(h.deps, { userId: UNKNOWN_ID, groupId: EDITORS.userid })).toBe(false);
    expect(h.store.writes()).toEqual([]);
    expect(h.db.writes()).toEqual([]);
  });

  it.each<[boolean, string[]]>([
    [false, ['alpha']],
    [true, ['alpha', 'Zed']],
  ])('lists members by last name with includeS2 %s [userDAO.cfc:656]', async (includeS2, lnames) => {
    const members = await listGroupMembers(h.deps, EDITORS.userid, { includeS2 });

    expect(members.map((member) => member.lname)).toEqual(lnames);
  });
});

describe('group reads', () => {
  let h: DomainHarness;

  beforeEach(() => {
    h = domainHarness();
  });

  it('lists the private pool of a site by Perm descending then name, with member counts, and none of another tenant [userGateway.cfc:93-120]', async () => {
    const rows = await listGroups(h.deps, { siteId: SITE_A, isPublic: 0 });

    expect(rows.map((row) => [row.groupname, row.counter])).toEqual([
      ['Parent', 1],
      ['Admin', 1],
      ['Editors', 2],
      ['Pictured', null],
      ['Twin A', null],
    ]);
    expect(await listGroups(h.deps, { siteId: SITE_A, isPublic: 1 })).toEqual([expect.objectContaining({ groupname: 'Members', siteid: TENANT_UMBRELLA.siteId })]);
  });

  it.each<[string, string, string]>([
    [SITE_A, TENANT_A.tenantId, 'Twin A'],
    [SITE_B, TENANT_B.tenantId, 'Twin B'],
  ])('finds a group id two tenants hold in the user pools of site %s first [userDAO.cfc:92-120]', async (siteId, tenantId, groupname) => {
    expect(await findGroupForSite(h.deps, { groupId: TWIN_A.userid, siteId })).toEqual({ tenantId, group: expect.objectContaining({ groupname }) });
  });

  it('answers null for an id no group holds', async () => {
    expect(await findGroupForSite(h.deps, { groupId: UNKNOWN_ID, siteId: SITE_A })).toBeNull();
  });
});


describe('cUsers before() gate on the composed identity app [cusers.cfc:90-124]', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await buildTestApp({ clock: CLOCK });
    await test.app.ready();
  });

  afterAll(async () => {
    await test.app.opt2.shutdown();
  });

  it.each<[string, readonly string[], number]>([
    ['s2', S2_ROLES, 200],
    ['site-admin', SITE_ADMIN_ROLES, 200],
    ['the Users and Site Manager module grants together', [Roles.systemUser, USERS_MODULE, SITE_MANAGER_MODULE], 200],
    ['the Users module grant alone, which the route requirement admits', [Roles.systemUser, USERS_MODULE], 403],
  ])('answers a caller holding %s on GET /v1/groups', async (_case, roles, status) => {
    const headers = await headersFor({ name: 'cusers-caller', kind: 'user', roles }, { sub: EDITOR.account.userid });

    const res = await test.app.inject({ method: 'GET', url: '/v1/groups', headers });

    expect(res.statusCode).toBe(status);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: '/v1/groups', status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  });
});

describe('cUsers group routes over the memory repository', () => {
  let app: FastifyInstance;
  let db: RecordingDb;
  let repo: MemoryIdentityRepo;
  let groups: GroupDeps;
  let stateDir: string;

  /** strategies-content's photo lookup, storing only STORED_PHOTO as a jpg. */
  const content: AdminGroupRouteDeps['content'] = {
    photoFileExts: (fileIds) => Promise.resolve(new Map(fileIds.flatMap((id): [string, string][] => (id === STORED_PHOTO ? [[id, 'jpg']] : [])))),
  };

  beforeEach(async () => {
    db = registryDb();
    repo = createMemoryIdentityRepo(seed(), { clock: CLOCK });
    groups = groupDeps(db, repo);
    stateDir = await createTestStateDir();
    app = await createService({ name: SERVICE_NAME, version: SERVICE_VERSION, env: testEnv({}, stateDir), clock: CLOCK, verifierOverride: testVerifier(SERVICE_NAME), logger: QUIET });
    registerWritePositionHeader(app);
    const bridge: AdminGroupRouteDeps['csrf']['bridge'] = { markUsed: () => Promise.resolve({ applied: true }) };
    await registerAdminGroupRoutes(app, { groups, content, sessions: { db, repo, clock: CLOCK }, csrf: { db, repo, bridge, clock: CLOCK, sleep: noSleep } });
    await app.ready();
  });

  afterEach(async () => {
    await app.opt2.shutdown();
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Gateway-relayed headers of a tenant-a user holding `roles`, in the S2 admin's seeded session unless `sub` names another user. */
  async function callerHeaders(roles: readonly string[], sub: string = ADMIN_S2.account.userid): Promise<Record<string, string>> {
    const [user, invocation] = await Promise.all([
      mintUserToken({ sub, sid: SESSION_ID, site: SITE_A, roles }),
      mintServiceToken({ caller: 'gateway', audience: SERVICE_NAME }),
    ]);
    return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
  }

  /** CSRF form fields for `context` under the admin session's secret, issued `laterMs` after the clock so each use is a fresh token. */
  function csrfFor(context: string, laterMs = 0): Record<string, string> {
    const { token, expires } = generateCsrfToken({ context, secret: SESSION_SECRET, now: new Date(NOW.getTime() + laterMs) });
    return { [CSRF_FIELD_TOKEN]: token, [CSRF_FIELD_EXPIRES]: expires };
  }

  /** Injects a request, `form` as a form post, and checks the answer against the contract. */
  async function send(method: Method, url: string, headers: Record<string, string>, form?: Record<string, string>) {
    const res = await app.inject({
      method,
      url,
      headers: form === undefined ? headers : { ...headers, ...FORM_BODY },
      payload: form === undefined ? undefined : new URLSearchParams(form).toString(),
    });
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  function groupName(groupId: string): unknown {
    return rowsOf(repo, GROUP_ACCOUNT.table, 'userid', groupId)[0]?.groupname;
  }

  function memberIds(groupId: string): unknown[] {
    return rowsOf(repo, MEMBERSHIP.table, 'groupid', groupId).map((row) => row.userid);
  }

  it('saves update{type=1} only under CSRF context rc.userid, a token of another context leaving the group unchanged [cusers.cfc:316]', async () => {
    const headers = await callerHeaders(S2_ROLES);

    const foreign = await send('PUT', `/v1/groups/${EDITORS.userid}`, headers, { groupname: 'Renamed', isPublic: '0', ...csrfFor(PARENT.userid) });
    expect(foreign.statusCode).toBe(500);
    expect(groupName(EDITORS.userid)).toBe('Editors');

    const own = await send('PUT', `/v1/groups/${EDITORS.userid}`, headers, { groupname: 'Renamed', isPublic: '0', ...csrfFor(EDITORS.userid, 1) });
    expect(own.json()).toMatchObject({ written: true, errors: {}, group: { UserID: EDITORS.userid, GroupName: 'Renamed', Type: 1, isPublic: 0, LastUpdateBy: 'Admin User' } });
    expect(groupName(EDITORS.userid)).toBe('Renamed');
    expect(outboxEvents(db, GROUP_CHANGED_TOPIC)).toHaveLength(1);
  });

  it('refuses the photo variants before any write and saves a posted type=2 as a Type=1 group, never a user account', async () => {
    const headers = await callerHeaders(S2_ROLES);

    const photoFields: Record<string, string>[] = [{ newFile: 'portrait.png' }, { removePhotoFile: 'true' }];
    for (const [n, photo] of photoFields.entries()) {
      const res = await send('POST', '/v1/groups', headers, { userid: NEW_GROUP, groupname: 'Withheld', isPublic: '0', ...photo, ...csrfFor(NEW_GROUP, n) });
      expect(res.statusCode).toBe(400);
    }
    expect(repo.writes()).toEqual([]);

    const created = await send('POST', '/v1/groups', headers, { userid: NEW_GROUP, groupname: 'Typed', isPublic: '0', type: '2', action: 'Add', ...csrfFor(NEW_GROUP, 2) });

    expect(created.json()).toMatchObject({ written: true, group: { UserID: NEW_GROUP, GroupName: 'Typed', Type: 1, SiteID: SITE_A } });
    const tables = repo.writes().map((write) => write.table);
    expect(tables).toContain(GROUP_ACCOUNT.table);
    expect(tables).not.toContain(USER_ACCOUNT.table);
    expect(tables).not.toContain(CREDENTIAL.table);
  });

  it("adds a member only under CSRF context userid & groupid & 'addtogroup', a wrong token answering written: false [cusers.cfc:272-277]", async () => {
    const headers = await callerHeaders(S2_ROLES);
    const url = `/v1/groups/${EDITORS.userid}/members/${BETA.userid}`;

    const wrong = await send('POST', url, headers, csrfFor(`${BETA.userid}${EDITORS.userid}`));
    expect(wrong.json()).toEqual({ written: false });
    expect(memberIds(EDITORS.userid)).not.toContain(BETA.userid);

    const right = await send('POST', url, headers, csrfFor(`${BETA.userid}${EDITORS.userid}addtogroup`, 1));
    expect(right.json()).toEqual({ written: true });
    expect(memberIds(EDITORS.userid)).toContain(BETA.userid);
    expect(outboxEvents(db, MEMBERSHIP_CHANGED_TOPIC).map((raw) => assertEventMatches(undefined, MEMBERSHIP_CHANGED_SCHEMA, raw).payload)).toEqual([
      { userId: BETA.userid, siteId: SITE_A, groupIds: [EDITORS.userid, PARENT.userid] },
    ]);
  });

  it('removes a member without any CSRF token, as legacy checks none [cusers.cfc:279-282]', async () => {
    const res = await send('DELETE', `/v1/groups/${PARENT.userid}/members/${BETA.userid}`, await callerHeaders(SITE_ADMIN_ROLES));

    expect(res.json()).toEqual({ written: true });
    expect(memberIds(PARENT.userid)).toEqual([]);
    expect(outboxEvents(db, MEMBERSHIP_CHANGED_TOPIC).map((raw) => assertEventMatches(undefined, MEMBERSHIP_CHANGED_SCHEMA, raw).payload)).toEqual([
      { userId: BETA.userid, siteId: SITE_A, groupIds: [] },
    ]);
  });

  /** The columns of `readGroupMemberships`: the member id aliased as groupID, userDAO's fieldList, then the joined photoFileExt [userDAO.cfc:78,652]. */
  const MEMBER_QUERY_COLUMNS = [
    'groupID', 'userID', 'GroupName', 'Fname', 'Lname', 'UserName', 'PasswordCreated', 'Email', 'Company', 'JobTitle', 'MobilePhone',
    'Website', 'Type', 'subType', 'ContactForm', 'S2', 'LastLogin', 'LastUpdate', 'LastUpdateBy', 'LastUpdateByID', 'Perm', 'InActive',
    'IsPublic', 'SiteID', 'Subscribe', 'Notes', 'description', 'Interests', 'keepPrivate', 'PhotoFileID', 'IMName', 'IMService',
    'Created', 'RemoteID', 'Tags', 'tablist', 'photoFileExt',
  ];

  /** `legacyUsersCsv` of the members query as ACF reads it: columns in its `columnList` order, cells rendered as query values. */
  function expectedMembersCsv(members: readonly GroupMemberRow[]): ReturnType<typeof legacyUsersCsv> {
    const columns = cfQueryColumnOrder(MEMBER_QUERY_COLUMNS);
    const cell = (member: GroupMemberRow, name: string): unknown => {
      if (name === 'groupID') return member.userid;
      if (name === 'photoFileExt') return member.photofileid === STORED_PHOTO ? 'jpg' : null;
      return (member as unknown as Record<string, unknown>)[name.toLowerCase()];
    };
    const rows = members.map((member) => Object.fromEntries(columns.map(({ name, column }) => [column, cfQueryCellText(cell(member, name))])));
    return legacyUsersCsv({ kind: 'query', columnList: columns.map(({ column }) => column), rows });
  }

  it.each<[string, readonly string[], boolean]>([
    ['an S2 caller, S2 members included', S2_ROLES, true],
    ['a site admin, S2 members left out', SITE_ADMIN_ROLES, false],
  ])('downloads the members CSV byte for byte as legacyUsersCsv renders it for %s [dsp_download.cfm]', async (_case, roles, includeS2) => {
    const res = await send('GET', `/v1/groups/${EDITORS.userid}/members.csv`, await callerHeaders(roles));

    const expected = expectedMembersCsv(await listGroupMembers(groups, EDITORS.userid, { includeS2 }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(expected.body);
    expect(res.headers['content-disposition']).toBe(expected.headers['Content-Disposition']);
    expect(res.headers['content-type']).toBe(expected.headers['Content-Type']);
    expect(res.body).toContain('"A, B "');
    expect(res.body.includes('"Zed "')).toBe(includeS2);
  });

  it('lists only the token site pools and refuses a siteid other than the token site with 403', async () => {
    const headers = await callerHeaders(SITE_ADMIN_ROLES);

    const listed = await send('GET', '/v1/groups?ispublic=0', headers);
    const foreign = await send('GET', `/v1/groups/${B_GROUP.userid}?siteid=${SITE_B}`, headers);

    expect(listed.json<{ items: { GroupName: string }[] }>().items.map((item) => item.GroupName)).not.toContain('Tenant B');
    expect(foreign.statusCode).toBe(403);
  });

  it('serves the editGroup, editGroupMembers and Group Memberships reads from the token site pools [cusers.cfc:219-265]', async () => {
    const headers = await callerHeaders(S2_ROLES);

    const stored = await send('GET', `/v1/groups/${EDITORS.userid}`, headers);
    const unknown = await send('GET', `/v1/groups/${UNKNOWN_ID}`, headers);
    const members = await send('GET', `/v1/groups/${EDITORS.userid}/members`, headers);
    const memberships = await send('GET', `/v1/users/${ALPHA.userid}/memberships`, headers);

    expect(stored.json()).toMatchObject({ isNew: false, group: { UserID: EDITORS.userid, GroupName: 'Editors' } });
    expect(unknown.json()).toMatchObject({ isNew: true, group: { isPublic: 1, subType: 'Default' } });
    expect(members.json<{ items: { Lname: string; photoFileExt: string | null }[] }>().items).toEqual([
      expect.objectContaining({ Lname: 'alpha', photoFileExt: 'jpg' }),
      expect.objectContaining({ Lname: 'Zed', photoFileExt: null }),
    ]);
    expect(memberships.json()).toMatchObject({
      publicGroups: [{ UserID: MEMBERS.userid, GroupName: 'Members' }],
      groupIds: [EDITORS.userid],
    });
    expect(memberships.json<{ privateGroups: { GroupName: string }[] }>().privateGroups.map((group) => group.GroupName)).toEqual(
      expect.arrayContaining(['Admin', 'Editors', 'Parent']),
    );
  });
});

