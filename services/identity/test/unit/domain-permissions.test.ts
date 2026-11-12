/** Permission operations of the `cperm` screens: node verdicts, module grant replacement with its permission events, and site and pool group reads against a throwaway `identity` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GateClosedError, ensureUnitGates, withGatedTenant, type GateState } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  NODE_GRANT_TYPES,
  groupListForSite,
  groupPermVerdict,
  permissionsForContent,
  permittedGroups,
  updateModulePermissions,
  type PermissionDeps,
} from '../../src/domain/permissions.js';
import type { IdentityEvents } from '../../src/events/publish.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const SITE = 'tenant-a';
const TENANT_A = tenantIdForSite(SITE);
const BUDGET_MS = 300;

function id(n: number, prefix: string): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const G1 = id(1, 'G');
const G2 = id(2, 'G');
const G3 = id(3, 'G');

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
