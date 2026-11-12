/** Permission operations of the `cperm` screens: node verdicts, module grant replacement with its permission events, site and pool group reads, and the reverse Users-module lookup against throwaway `identity` schemas. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GateClosedError, ensureUnitGates, withGatedTenant, type GateState } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  NODE_GRANT_TYPES,
  groupListForSite,
  groupPermVerdict,
  permissionsForContent,
  permittedGroups,
  reversePermLookUp,
  updateModulePermissions,
  type PermissionDeps,
  type ReversePermDeps,
} from '../../src/domain/permissions.js';
import { applyLogin, endSession, ensureSession } from '../../src/domain/sessions.js';
import type { IdentityEvents } from '../../src/events/publish.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type LoginSnapshot } from '../../src/repo/tables.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const SITE = 'tenant-a';
const TENANT_A = tenantIdForSite(SITE);
const BUDGET_MS = 300;
const STEP_WAIT_MS = 5_000;

function id(n: number, prefix: string): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const G1 = id(1, 'G');
const G2 = id(2, 'G');
const G3 = id(3, 'G');
const G4 = id(4, 'G');

describe('group node verdicts', () => {
  it('keeps the getGroupPerm precedence Editor, Author, Read, Deny', () => {
    expect(NODE_GRANT_TYPES).toEqual(['Editor', 'Author', 'Read', 'Deny']);
  });

  it.each([
    ['editor over every lower grant', [{ groupid: G1, type: 'Read' }, { groupid: G1, type: 'Deny' }, { groupid: G1, type: 'Editor' }], 'editor'],
    ['author over read and deny', [{ groupid: G1, type: 'Deny' }, { groupid: G1, type: 'Author' }, { groupid: G1, type: 'Read' }], 'author'],
    ['read over deny', [{ groupid: G1, type: 'Deny' }, { groupid: G1, type: 'Read' }], 'read'],
    ['deny alone', [{ groupid: G1, type: 'Deny' }], 'deny'],
    ['a grant whose group and type differ only by case and trailing spaces', [{ groupid: `${G1.toLowerCase()}  `, type: 'AUTHOR ' }], 'author'],
    ['none for another group', [{ groupid: G2, type: 'Editor' }], 'none'],
    ['none for a module grant', [{ groupid: G1, type: 'module' }], 'none'],
    ['none without rows', [], 'none'],
  ] as const)('answers %s', (_label, rows, verdict) => {
    expect(groupPermVerdict(rows, G1)).toBe(verdict);
  });
});

interface PublishedPermission {
  tenantId: string;
  groupId: string;
  siteId: string;
  rows: string[];
}

/** Permission events recorded with the tenant of the transaction they were written in; `fail` makes every write reject. */
function recordingEvents(fail = false): Pick<IdentityEvents, 'publishPermissionChanged'> & { published: PublishedPermission[] } {
  const published: PublishedPermission[] = [];
  return {
    published,
    publishPermissionChanged(tx, input) {
      if (fail) return Promise.reject(new Error('outbox write failed'));
      published.push({ tenantId: tx.tenantId, groupId: input.groupId, siteId: input.siteId, rows: input.rows.map((row) => `${row.contentid}:${row.type}`) });
      return Promise.resolve(null);
    },
  };
}

/** Settles as `promise` does, or rejects once `ms` pass first. */
async function within<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${step} did not happen within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** A step hook given the backend pid of its transaction. */
type StepHook = (pid: number) => Promise<void>;

/** A hook that resolves `reached` with its pid on arrival, then waits until `release` is called. */
function holdPoint(): { hook: StepHook; reached: Promise<number>; release: () => void } {
  let arrive: (pid: number) => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<number>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    hook: async (pid) => {
      arrive(pid);
      await released;
    },
  };
}

const available = await pgAvailable();

describe.skipIf(!available)('permission operations against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let moduleSeq = 0;

  function deps(events: Pick<IdentityEvents, 'publishPermissionChanged'> = recordingEvents(), gateWaitMs?: number): PermissionDeps {
    return { db: handle.app, repo, events, ...(gateWaitMs === undefined ? {} : { gateWaitMs }) };
  }

  function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(site), fn);
  }

  function nextModule(): string {
    moduleSeq += 1;
    return id(moduleSeq, 'M');
  }

  async function setGates(state: GateState): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $1, holder_id = $2, phase = 'quiet'`, [state, state === 'closed' ? 'test-holder' : null]),
    );
  }

  async function registerSite(site: string, privatePool: string | null, publicPool: string | null): Promise<void> {
    const tenantOf = (pool: string | null): string | null => (pool === null ? null : tenantIdForSite(pool));
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantOf(privatePool), tenantOf(publicPool), CLOCK.now()],
      ),
    );
  }

  function groupInput(groupname: string, siteid: string, ispublic: 0 | 1): GroupInput {
    return {
      groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
      website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic, siteid,
      subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
      remoteid: '', tags: '', tablist: '',
    };
  }

  async function moduleGroupIds(moduleId: string): Promise<string[]> {
    return (await permittedGroups(deps(), { siteId: SITE, contentId: moduleId })).map((row) => row.groupid);
  }

  async function backendPid(tx: TenantTx): Promise<number> {
    return Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
  }

  /** The repository with `replaceModulePermissions` running `before` and `after` around the real replacement. */
  function hookedRepo(hooks: { before?: StepHook; after?: StepHook }): PermissionDeps['repo'] {
    return {
      ...repo,
      async replaceModulePermissions(tx, input, ctx) {
        const pid = await backendPid(tx);
        await hooks.before?.(pid);
        const replaced = await repo.replaceModulePermissions(tx, input, ctx);
        await hooks.after?.(pid);
        return replaced;
      },
    };
  }

  /** The repository with `groupPermissions` running `before` and `after` around the real state read. */
  function hookedReadRepo(hooks: { before?: StepHook; after?: StepHook }): PermissionDeps['repo'] {
    return {
      ...repo,
      async groupPermissions(tx, groupId, siteId, ctx) {
        const pid = await backendPid(tx);
        await hooks.before?.(pid);
        const rows = await repo.groupPermissions(tx, groupId, siteId, ctx);
        await hooks.after?.(pid);
        return rows;
      },
    };
  }

  /** Resolves once backend `pid` waits for an advisory lock, polling for at most STEP_WAIT_MS. */
  async function waitsOnAdvisoryLock(pid: number): Promise<void> {
    const deadline = Date.now() + STEP_WAIT_MS;
    while (
      (await handle.adminPool.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [pid])).rowCount === 0
    ) {
      if (Date.now() > deadline) throw new Error(`backend ${pid} did not wait for an advisory lock within ${STEP_WAIT_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Expects the last state published for each group to equal its stored rows in SITE. */
  async function expectLastStatesStored(published: readonly PublishedPermission[]): Promise<void> {
    const last = new Map(published.map((event) => [event.groupId, event.rows]));
    for (const [groupId, rows] of last) {
      const stored = await gated(SITE, (tx) => repo.groupPermissions(tx, groupId, SITE));
      expect(rows, groupId).toEqual(stored.map((row) => `${row.contentid}:${row.type}`));
    }
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await setGates('open');
    await registerSite(SITE, SITE, 'umbrella');
    await registerSite('umbrella', 'umbrella', 'umbrella');
    await registerSite('poolless', null, null);
    await gated(SITE, async (tx) => {
      for (const [name, isPublic] of [['Editors', 0], ['Admin', 0], ['authors', 0], ['Site Members', 1]] as const) {
        await repo.insertGroup(tx, groupInput(name, SITE, isPublic), null);
      }
    });
    await gated('umbrella', async (tx) => {
      for (const [name, isPublic] of [['Members', 1], ['Admin', 1], ['Umbrella Staff', 0]] as const) {
        await repo.insertGroup(tx, groupInput(name, 'umbrella', isPublic), null);
      }
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('lists the private-pool groups without Admin and the public-pool groups of the pool site, each read in its pool tenant', async () => {
    const lists = await groupListForSite(deps(), SITE);

    expect(lists.privateGroups.map((group) => [group.groupname, group.siteid])).toEqual([
      ['authors', SITE],
      ['Editors', SITE],
    ]);
    expect(lists.publicGroups.map((group) => [group.groupname, group.siteid])).toEqual([
      ['Admin', 'umbrella'],
      ['Members', 'umbrella'],
    ]);
    expect(await groupListForSite(deps(), 'TENANT-A')).toEqual(lists);
  });

  it.each([
    ['an unregistered site', 'nowhere'],
    ['a site without user pools', 'poolless'],
  ])('lists no groups for %s', async (_label, siteId) => {
    expect(await groupListForSite(deps(), siteId)).toEqual({ privateGroups: [], publicGroups: [] });
  });

  it("replaces a module's grants and writes each affected group's full permission rows in the same tenant transaction", async () => {
    const moduleId = nextModule();
    const node = id(1, 'N');
    await gated(SITE, (tx) => repo.replaceNodePermissions(tx, { contentId: node, siteId: SITE, grants: [{ groupId: G1, type: 'Read' }] }));

    const first = recordingEvents();
    const created = await updateModulePermissions(deps(first), { siteId: SITE, moduleId, groupIds: `${G2},,${G1}` });
    expect(created.rows.map((row) => [row.groupid, row.type])).toEqual([
      [G2, 'module'],
      [G1, 'module'],
    ]);
    expect(created.changedGroupIds).toEqual([G1, G2]);
    expect(first.published).toEqual([
      { tenantId: TENANT_A, groupId: G1, siteId: SITE, rows: [`${moduleId}:module`, `${node}:Read`] },
      { tenantId: TENANT_A, groupId: G2, siteId: SITE, rows: [`${moduleId}:module`] },
    ]);
    expect(await moduleGroupIds(moduleId)).toEqual([G1, G2]);

    const second = recordingEvents();
    const replaced = await updateModulePermissions(deps(second), { siteId: SITE, moduleId, groupIds: [G3, G2.toLowerCase()] });
    expect(replaced.changedGroupIds).toEqual([G1, G2.toLowerCase(), G3]);
    expect(second.published.map((event) => [event.groupId, event.rows])).toEqual([
      [G1, [`${node}:Read`]],
      [G2.toLowerCase(), [`${moduleId}:module`]],
      [G3, [`${moduleId}:module`]],
    ]);
    expect(await moduleGroupIds(moduleId)).toEqual([G2.toLowerCase(), G3]);
  });

  it('reads listed items as CFML list items, so comma-joined items split and empty ones are skipped, and an empty list removes every grant', async () => {
    const moduleId = nextModule();

    const listed = await updateModulePermissions(deps(), { siteId: SITE, moduleId, groupIds: [`${G1},${G2}`, '', G3] });
    expect(listed.rows.map((row) => row.groupid)).toEqual([G1, G2, G3]);

    const events = recordingEvents();
    const cleared = await updateModulePermissions(deps(events), { siteId: SITE, moduleId, groupIds: '' });
    expect(cleared).toEqual({ rows: [], changedGroupIds: [G1, G2, G3] });
    expect(events.published.map((event) => event.rows.includes(`${moduleId}:module`))).toEqual([false, false, false]);
    expect(await moduleGroupIds(moduleId)).toEqual([]);
  });

  it('announces every grant it deletes, including one another replacement committed after its transaction began', async () => {
    const moduleId = nextModule();
    await updateModulePermissions(deps(), { siteId: SITE, moduleId, groupIds: [G1] });
    const held = holdPoint();
    const first = recordingEvents();
    const second = recordingEvents();

    const replacing = updateModulePermissions({ ...deps(first), repo: hookedRepo({ before: held.hook }) }, { siteId: SITE, moduleId, groupIds: [G3] });
    try {
      await within(held.reached, STEP_WAIT_MS, 'the first replacement reaching its grant replacement');
      await within(updateModulePermissions(deps(second), { siteId: SITE, moduleId, groupIds: [G1, G2] }), STEP_WAIT_MS, 'the second replacement');
    } finally {
      held.release();
      await Promise.allSettled([replacing]);
    }

    const replaced = await replacing;
    expect(replaced.changedGroupIds).toEqual([G1, G2, G3]);
    expect(first.published.map((event) => [event.groupId, event.rows.includes(`${moduleId}:module`)])).toEqual([
      [G1, false],
      [G2, false],
      [G3, true],
    ]);
    expect(await moduleGroupIds(moduleId)).toEqual([G3]);
    await expectLastStatesStored([...second.published, ...first.published]);
  });

  it.each([
    ['overlapping lists', [G1, G2], [G2, G3]],
    ['disjoint lists', [G1], [G2, G3]],
  ])('serializes two concurrent replacements of one module with %s, keeping the list committed last', async (_label, firstList, secondList) => {
    const moduleId = nextModule();
    const held = holdPoint();
    const entered = holdPoint();
    entered.release();
    const first = recordingEvents();
    const second = recordingEvents();

    const replacingFirst = updateModulePermissions({ ...deps(first), repo: hookedRepo({ after: held.hook }) }, { siteId: SITE, moduleId, groupIds: firstList });
    const replacingSecond = within(held.reached, STEP_WAIT_MS, 'the first replacement holding its module').then(() =>
      updateModulePermissions({ ...deps(second), repo: hookedRepo({ before: entered.hook }) }, { siteId: SITE, moduleId, groupIds: secondList }),
    );
    try {
      await waitsOnAdvisoryLock(await within(entered.reached, STEP_WAIT_MS, 'the second replacement starting'));
    } finally {
      held.release();
      await Promise.allSettled([replacingFirst, replacingSecond]);
    }

    const [firstResult, secondResult] = await Promise.all([replacingFirst, replacingSecond]);
    expect(firstResult.rows.map((row) => row.groupid)).toEqual(firstList);
    expect(secondResult.rows.map((row) => row.groupid)).toEqual(secondList);
    expect(secondResult.changedGroupIds).toEqual([G1, G2, G3]);
    expect(await moduleGroupIds(moduleId)).toEqual(secondList);
    await expectLastStatesStored([...first.published, ...second.published]);
  });

  it("reads a group's state for publishing only after a concurrent replacement of another module granting the group commits", async () => {
    const [firstModule, secondModule] = [nextModule(), nextModule()];
    const held = holdPoint();
    const entered = holdPoint();
    entered.release();
    const first = recordingEvents();
    const second = recordingEvents();

    const replacingFirst = updateModulePermissions(
      { ...deps(first), repo: hookedReadRepo({ after: held.hook }) },
      { siteId: SITE, moduleId: firstModule, groupIds: [G4] },
    );
    const replacingSecond = within(held.reached, STEP_WAIT_MS, 'the first replacement reading its group state').then(() =>
      updateModulePermissions({ ...deps(second), repo: hookedReadRepo({ before: entered.hook }) }, { siteId: SITE, moduleId: secondModule, groupIds: [G4] }),
    );
    try {
      // The second replacement's own module lock is free, so its advisory wait is the group lock the first one holds.
      await waitsOnAdvisoryLock(await within(entered.reached, STEP_WAIT_MS, 'the second replacement reading its group state'));
    } finally {
      held.release();
      await Promise.allSettled([replacingFirst, replacingSecond]);
    }

    await Promise.all([replacingFirst, replacingSecond]);
    expect(first.published.map((event) => [event.groupId, event.rows])).toEqual([[G4, [`${firstModule}:module`]]]);
    expect(second.published.map((event) => [event.groupId, event.rows])).toEqual([[G4, [`${firstModule}:module`, `${secondModule}:module`]]]);
    await expectLastStatesStored([...first.published, ...second.published]);
  });

  it('rolls the grant replacement back when a permission event cannot be written', async () => {
    const moduleId = nextModule();
    await updateModulePermissions(deps(), { siteId: SITE, moduleId, groupIds: G1 });

    await expect(updateModulePermissions(deps(recordingEvents(true)), { siteId: SITE, moduleId, groupIds: [G2] })).rejects.toThrow('outbox write failed');
    expect(await moduleGroupIds(moduleId)).toEqual([G1]);
  });

  it('refuses module grants for an unregistered site without writing events', async () => {
    const events = recordingEvents();

    await expect(updateModulePermissions(deps(events), { siteId: 'nowhere', moduleId: nextModule(), groupIds: G1 })).rejects.toThrow(
      'Site nowhere is not registered, so its module grants have no tenant',
    );
    expect(events.published).toEqual([]);
  });

  it('gives up on a closed gate after gateWaitMs', async () => {
    await setGates('closed');
    try {
      const started = Date.now();
      await expect(updateModulePermissions(deps(recordingEvents(), BUDGET_MS), { siteId: SITE, moduleId: nextModule(), groupIds: G1 })).rejects.toBeInstanceOf(
        GateClosedError,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - 50);
    } finally {
      await setGates('open');
    }
  });

  it('reads every stored row of a content node, which groupPermVerdict resolves per group, and only module rows as permitted groups', async () => {
    const node = id(2, 'N');
    const grants = [
      { groupId: G1, type: 'Read' },
      { groupId: G1, type: 'Editor' },
      { groupId: G2, type: 'Deny' },
    ];
    await gated(SITE, (tx) => repo.replaceNodePermissions(tx, { contentId: node, siteId: SITE, grants }));

    const rows = await permissionsForContent(deps(), { siteId: SITE, contentId: node });
    expect(rows.map((row) => [row.groupid, row.type])).toEqual([
      [G1, 'Editor'],
      [G1, 'Read'],
      [G2, 'Deny'],
    ]);
    expect([G1, G2, G3].map((groupId) => groupPermVerdict(rows, groupId))).toEqual(['editor', 'deny', 'none']);
    expect(await permittedGroups(deps(), { siteId: SITE, contentId: node })).toEqual([]);
    expect(await permissionsForContent(deps(), { siteId: 'umbrella', contentId: node })).toEqual([]);
  });

  it.each([
    ['permittedGroups', permittedGroups],
    ['permissionsForContent', permissionsForContent],
  ])('%s reads no rows for an unregistered site', async (_label, read) => {
    expect(await read(deps(), { siteId: 'nowhere', contentId: id(1, 'N') })).toEqual([]);
  });
});

/** A login snapshot of a `hub` user with the given role list and login-time group ids. */
function snapshotOf(userid: string, roleList: string, groupIds: readonly string[]): LoginSnapshot {
  return {
    userid, username: userid, siteid: 'hub', subtype: 'Default', password: 'stored-hash', fname: '', lname: '', email: '', remoteid: '',
    company: '', lastlogin: null, passwordcreated: null, roleList, membershipIds: [...groupIds, userid].join(','),
  };
}

type PoolGroup = 'hubAdmin' | 'hubEditors' | 'hubClerks' | 'hubMembers' | 'pubStaff';

// hub pools itself; pub-member pools its public users in hub; priv-member pools its private users in hub, spelling the pool HUB.
describe.skipIf(!available)('reverse Users-module lookup against PostgreSQL [legacy: core/mura/user/userManager.cfc:1050-1086]', () => {
  const USERS_MODULE = '00000000000000000000000000000000008';
  const groupIds: Record<PoolGroup, string> = { hubAdmin: '', hubEditors: '', hubClerks: '', hubMembers: '', pubStaff: '' };
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let sessionSeq = 0;

  function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(site), fn);
  }

  async function registerSite(site: string, privatePool: string, publicPool: string): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), CLOCK.now()],
      ),
    );
  }

  function groupInput(groupname: string, siteid: string, ispublic: 0 | 1): GroupInput {
    return {
      groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
      website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic, siteid,
      subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
      remoteid: '', tags: '', tablist: '',
    };
  }

  function lookupDeps(): ReversePermDeps {
    return { db: handle.app, repo };
  }

  function sessionDeps(): { db: TenantDb; repo: IdentityRepository; clock: Clock } {
    return { db: handle.app, repo, clock: CLOCK };
  }

  /** Signs a new `hub` user in with the role list and login-time group ids, and returns the session id. */
  async function login(roleList: string, groups: readonly string[]): Promise<string> {
    sessionSeq += 1;
    const sessionId = `S-REVERSE-${String(sessionSeq)}`;
    const snapshot = snapshotOf(id(sessionSeq, 'U'), roleList, groups);
    await applyLogin(sessionDeps(), { sessionId, snapshot, mode: 'target-primary', siteId: 'hub' });
    return sessionId;
  }

  function claimsFor(sid: string, site: string): { sid: string; tid: string; site: string } {
    return { sid, tid: tenantIdForSite(site), site };
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await registerSite('hub', 'hub', 'hub');
    await registerSite('pub-member', 'pub-member', 'hub');
    await registerSite('priv-member', 'HUB', 'priv-member');
    await registerSite('other', 'other', 'other');
    await gated('hub', async (tx) => {
      groupIds.hubAdmin = (await repo.insertGroup(tx, groupInput('Admin', 'hub', 0), null)).userid;
      groupIds.hubEditors = (await repo.insertGroup(tx, groupInput('Editors', 'hub', 0), null)).userid;
      groupIds.hubClerks = (await repo.insertGroup(tx, groupInput('Clerks', 'hub', 0), null)).userid;
      groupIds.hubMembers = (await repo.insertGroup(tx, groupInput('Members', 'hub', 1), null)).userid;
    });
    groupIds.pubStaff = (await gated('pub-member', (tx) => repo.insertGroup(tx, groupInput('Staff', 'pub-member', 0), null))).userid;
    await gated('hub', (tx) => repo.replaceModulePermissions(tx, { moduleId: USERS_MODULE, siteId: 'hub', groupIds: [groupIds.hubEditors] }));
    await gated('pub-member', (tx) =>
      repo.replaceModulePermissions(tx, { moduleId: USERS_MODULE, siteId: 'pub-member', groupIds: [groupIds.pubStaff, groupIds.hubMembers] }),
    );
    // getReversePermLookUp never reads a private-pool member site's grants, so this grant reaches nobody.
    await gated('priv-member', (tx) => repo.replaceModulePermissions(tx, { moduleId: USERS_MODULE, siteId: 'priv-member', groupIds: [groupIds.hubClerks] }));
  });

  afterAll(async () => {
    await handle.drop();
  });

  it.each<{ when: string; roleList: string; groups: PoolGroup[]; site: string; expected: boolean }>([
    { when: 'S2, on the site', roleList: 'S2IsPrivate;hub,S2IsPrivate,S2', groups: [], site: 'hub', expected: true },
    { when: "the site's private-pool Admin group", roleList: 'Admin;hub;0,S2IsPrivate;hub,S2IsPrivate', groups: ['hubAdmin'], site: 'hub', expected: true },
    { when: "a Users grant of the site to the user's group", roleList: 'Editors;hub;0,S2IsPrivate;hub,S2IsPrivate', groups: ['hubEditors'], site: 'hub', expected: true },
    { when: "the private-pool Admin group of a site whose public pool is the site", roleList: 'Admin;pub-member;0', groups: [], site: 'hub', expected: true },
    { when: "that site's Users grant to its private-pool group", roleList: 'Staff;pub-member;0', groups: ['pubStaff'], site: 'hub', expected: true },
    { when: "that site's Users grant to a public group of the site", roleList: 'Members;hub;1,S2IsPublic;hub,S2IsPublic', groups: ['hubMembers'], site: 'hub', expected: true },
    { when: 'the site spelled in another case, through a public-pool member site', roleList: 'Admin;pub-member;0', groups: [], site: 'HUB', expected: true },
    { when: "the Admin group of a site whose private pool is the site, as that site spells it", roleList: 'Admin;HUB;0', groups: [], site: 'hub', expected: true },
    { when: 'an Admin group spelled in neither case of the pools', roleList: 'Admin;Hub;0', groups: [], site: 'hub', expected: false },
    { when: 'a group named admin in the private pool', roleList: 'admin;hub;0', groups: [], site: 'hub', expected: false },
    { when: "only a private-pool member site's Users grant", roleList: 'Clerks;hub;0,S2IsPrivate;hub,S2IsPrivate', groups: ['hubClerks'], site: 'hub', expected: false },
    {
      when: 'only grants and Admin groups of sites that pool no users in the site',
      roleList: 'Admin;hub;0,Admin;pub-member;0,Staff;pub-member;0', groups: ['hubAdmin', 'pubStaff'], site: 'other', expected: false,
    },
    { when: 'S2, on a site outside the registry', roleList: 'S2IsPrivate;hub,S2IsPrivate,S2', groups: [], site: 'nowhere', expected: true },
    { when: "the Admin group of a site outside the registry, whose pool is its own id", roleList: 'Admin;nowhere;0', groups: [], site: 'nowhere', expected: true },
    { when: 'only groups of other sites, on a site outside the registry', roleList: 'Admin;hub;0,Editors;hub;0', groups: ['hubAdmin', 'hubEditors'], site: 'nowhere', expected: false },
  ])('answers $expected for $when', async ({ roleList, groups, site, expected }) => {
    const sid = await login(roleList, groups.map((key) => groupIds[key]));

    expect(await reversePermLookUp(lookupDeps(), claimsFor(sid, site))).toBe(expected);
  });

  it('answers false for anonymous, ended and unknown sessions, whatever the ended login held', async () => {
    await ensureSession(sessionDeps(), { sessionId: 'S-REVERSE-ANON', mode: 'target-primary' });
    const ended = await login('S2IsPrivate;hub,S2IsPrivate,S2', []);
    expect(await reversePermLookUp(lookupDeps(), claimsFor(ended, 'hub'))).toBe(true);
    await endSession(sessionDeps(), ended);

    for (const sid of ['S-REVERSE-ANON', ended, 'S-REVERSE-UNKNOWN']) {
      expect(await reversePermLookUp(lookupDeps(), claimsFor(sid, 'hub'))).toBe(false);
    }
  });
});
