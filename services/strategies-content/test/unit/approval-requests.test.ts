/** Approval request primitives over a throwaway `content` schema: request loads, the approval requirement, request and action saves, cancelation and the action mail decision. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfDateAdd } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { approvalAction } from '../../src/domain/approvals.js';
import { ContentSaveDataError } from '../../src/domain/content.js';
import {
  PENDING_STATUS,
  UndefinedLegacyVariableError,
  approvalNotice,
  cancelRequest,
  loadRequest,
  requiresApproval,
  saveRequest,
  writeAction,
  type ApprovalRequestValues,
} from '../../src/domain/approval-requests.js';
import { CONTENT_CONFIG_DEFAULTS, type Actor, type SiteContentSettings } from '../../src/domain/context.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const EARLIER = new Date(2026, 4, 1, 8, 0, 0, 0);
const SITE_ID = TENANT_A.siteId;
const KINDS = ['Approved', 'Rejected', 'Canceled', 'Pending'] as const;
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;

const ACTOR: Actor = {
  userId: cfId('U', 1),
  fullName: 'Ada Lovelace',
  isLoggedIn: true,
  s2: false,
  roles: ['system-user'],
  siteId: SITE_ID,
  tenantId: TENANT_A.tenantId,
};

const SITE: SiteContentSettings = {
  siteId: SITE_ID,
  site: 'Tenant A',
  locking: 'None',
  contentApprovalScript: '',
  contentRejectionScript: '',
  contentPendingScript: '',
  contentCanceledScript: '',
  contactEmail: '',
  urls: {
    siteId: SITE_ID,
    scheme: 'http',
    domain: 'localhost',
    requestDomain: 'localhost',
    previewDomain: '',
    serverPort: '',
    context: '',
    siteIdInUrls: false,
    indexFileInUrls: false,
    hashUrls: false,
    useSSL: false,
    filePoolId: SITE_ID,
    configFileAssetPath: '',
    assetPath: '/sites',
    siteAssetPath: '/sites',
    fileStore: 'fileDir',
    legacyIndexFileLocation: false,
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  },
};

const SCRIPT_OF = {
  Approved: 'contentApprovalScript',
  Rejected: 'contentRejectionScript',
  Canceled: 'contentCanceledScript',
  Pending: 'contentPendingScript',
} as const;

/** The site with `kind`'s script set. */
const scripted = (kind: (typeof KINDS)[number]): SiteContentSettings => ({ ...SITE, [SCRIPT_OF[kind]]: 'Review #returnURL#' });

const requestValues = (extra: Partial<ApprovalRequestValues> = {}): ApprovalRequestValues => ({
  requestid: cfId('R', 1),
  contenthistid: cfId('H', 1),
  chainid: '',
  siteid: SITE_ID,
  userid: ACTOR.userId,
  groupid: '',
  status: PENDING_STATUS,
  created: null,
  ...extra,
});

/** Thrown inside a test transaction so its writes are rolled back. */
class Rollback extends Error {}

describe('approvalNotice', () => {
  it.each(KINDS)('decides no %s mail without a script', (kind) => {
    expect(approvalNotice(kind, SITE)).toBeNull();
  });

  it.each(KINDS)('fails as legacy does reading approvalHistory when the %s script is set', (kind) => {
    expect(() => approvalNotice(kind, scripted(kind))).toThrow(new UndefinedLegacyVariableError('APPROVALHISTORY'));
    expect(() => approvalNotice(kind.toUpperCase(), scripted(kind))).toThrow('Variable APPROVALHISTORY is undefined.');
  });

  it('reads only the script of its own kind and ignores other statuses', () => {
    const allScripted: SiteContentSettings = { ...SITE, contentApprovalScript: 'x', contentRejectionScript: 'x', contentCanceledScript: 'x' };
    expect(approvalNotice('Pending', allScripted)).toBeNull();
    expect(approvalNotice('Draft', allScripted)).toBeNull();
  });

  it('names the error as the legacy 500 reports it', () => {
    const error = new UndefinedLegacyVariableError('APPROVALHISTORY');
    expect(error.name).toBe('UndefinedLegacyVariableError');
    expect(error.variable).toBe('APPROVALHISTORY');
    expect(error).toBeInstanceOf(Error);
  });
});

describe.skipIf(!(await pgAvailable()))('domain/approval-requests', () => {
  let handle: ThrowawaySchema;
  let repo: ContentRepository;
  let chainId: string;
  let emptyChainId: string;
  const group1 = cfId('G', 1);
  const group2 = cfId('G', 2);

  const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

  /** Runs `fn` in a transaction that is rolled back afterwards. */
  async function rolledBack<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    let result: T | undefined;
    await expect(
      inA(async (tx) => {
        result = await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    return result as T;
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'approval-requests-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'approval-requests-test', state: 'open' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    chainId = (await inA((tx) => repo.approvals.insertChain(tx, { siteid: SITE_ID, name: 'Two step', description: '' }))).chainid;
    emptyChainId = (await inA((tx) => repo.approvals.insertChain(tx, { siteid: SITE_ID, name: 'No groups', description: '' }))).chainid;
    // Listed second first so the chain order (orderno), not insertion order, decides the first group.
    await inA((tx) => repo.approvals.replaceChainMemberships(tx, chainId, SITE_ID, [group2, group1]));
  });

  afterAll(async () => {
    await handle?.drop();
  });

  describe('loadRequest', () => {
    it('loads a stored request by id or by version, chain and site', async () => {
      const stored = await rolledBack(async (tx) => {
        await repo.approvals.insertRequest(tx, { requestid: cfId('R', 10), contenthistid: cfId('H', 10), chainid: chainId, groupid: group2, siteid: SITE_ID, userid: ACTOR.userId, created: EARLIER });
        return {
          byId: await loadRequest(tx, repo, { requestId: cfId('R', 10).toLowerCase() }),
          byVersion: await loadRequest(tx, repo, { contentHistId: cfId('H', 10), chainId, siteId: SITE_ID }),
          otherChain: await loadRequest(tx, repo, { contentHistId: cfId('H', 10), chainId: emptyChainId, siteId: SITE_ID }),
        };
      });
      const expected: ApprovalRequestValues = {
        requestid: cfId('R', 10),
        contenthistid: cfId('H', 10),
        chainid: chainId,
        siteid: SITE_ID,
        userid: ACTOR.userId,
        groupid: group2,
        status: PENDING_STATUS,
        created: EARLIER,
      };
      expect(stored.byId).toEqual({ isNew: false, values: expected });
      expect(stored.byVersion).toEqual({ isNew: false, values: expected });
      expect(stored.otherChain.isNew).toBe(true);
    });

    it('returns a new bean holding the key and the ORM defaults when nothing matches', async () => {
      const byId = await inA((tx) => loadRequest(tx, repo, { requestId: cfId('R', 11) }));
      expect(byId).toEqual({
        isNew: true,
        values: { requestid: cfId('R', 11), contenthistid: '', chainid: '', siteid: '', userid: '', groupid: '', status: 'Pending', created: null },
      });
      const byVersion = await inA((tx) => loadRequest(tx, repo, { contentHistId: cfId('H', 11), chainId, siteId: SITE_ID }));
      expect(byVersion.isNew).toBe(true);
      expect(byVersion.values).toMatchObject({ contenthistid: cfId('H', 11), chainid: chainId, siteid: SITE_ID, status: 'Pending', groupid: '', created: null });
      expect(byVersion.values.requestid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
    });

    it.each([
      ['an unknown id, keeping it', cfId('R', 12), cfId('R', 12)],
      ['an empty id, keeping the bean\u2019s new id', '', expect.stringMatching(CF_UUID)],
    ])('gives a new bean loaded by %s, the site getBean set', async (_label, requestId, expectedId) => {
      const loaded = await inA((tx) => loadRequest(tx, repo, { requestId, siteId: SITE_ID }));
      expect(loaded).toEqual({
        isNew: true,
        values: { requestid: expectedId, contenthistid: '', chainid: '', siteid: SITE_ID, userid: '', groupid: '', status: 'Pending', created: null },
      });
    });
  });

  describe('requiresApproval', () => {
    const member = { groupIds: [group1] };
    const none = { groupIds: [] };

    it('takes the chain of the nearest crumb whose chain exists, walking node to root', async () => {
      const crumbs = [
        { chainid: null, exemptid: null },
        { chainid: cfId('X', 404), exemptid: null },
        { chainid: chainId, exemptid: '' },
        { chainid: emptyChainId, exemptid: null },
      ];
      expect(await inA((tx) => requiresApproval(tx, repo, ACTOR, crumbs, none))).toEqual({ required: true, chainId });
    });

    it('requires nothing when no crumb has an existing chain', async () => {
      const crumbs = [{ chainid: '', exemptid: group1 }, { chainid: cfId('X', 405), exemptid: null }];
      expect(await inA((tx) => requiresApproval(tx, repo, ACTOR, crumbs, member))).toEqual({ required: false, chainId: '' });
    });

    it.each([
      ['an S2 actor', { ...ACTOR, s2: true }, none, null],
      ['an actor with the s2 role', { ...ACTOR, roles: ['s2'] }, none, null],
      ['a site-admin actor', { ...ACTOR, roles: ['system-user', 'site-admin'] }, none, null],
      ['a member of an exempt group', ACTOR, member, `${group2},${group1}`],
    ])('exempts %s', async (_label, actor, memberships, exemptid) => {
      const crumbs = [{ chainid: chainId, exemptid }];
      expect(await inA((tx) => requiresApproval(tx, repo, actor, crumbs, memberships))).toEqual({ required: false, chainId: '' });
      expect(await inA((tx) => requiresApproval(tx, repo, actor, crumbs, memberships, false))).toEqual({ required: true, chainId });
    });

    it.each([
      ['a non-member', { groupIds: [cfId('G', 9)] }],
      ['a group id differing only in case (listFind)', { groupIds: [group1.toLowerCase()] }],
    ])('requires approval of %s of the exempt groups', async (_label, memberships) => {
      const crumbs = [{ chainid: chainId, exemptid: `,${group1},` }];
      expect(await inA((tx) => requiresApproval(tx, repo, ACTOR, crumbs, memberships))).toEqual({ required: true, chainId });
    });
  });

  describe('writeAction', () => {
    it('overwrites the action of the same request and group, and adds one for another group', async () => {
      const actions = await rolledBack(async (tx) => {
        const requestId = cfId('R', 20);
        const first = await writeAction(tx, repo, { requestId, groupId: group2, chainId, siteId: SITE_ID, actionType: 'Approval', comments: 'ok', userId: ACTOR.userId });
        const again = await writeAction(tx, repo, { requestId: requestId.toLowerCase(), groupId: group2, chainId, siteId: '', actionType: 'Rejection', comments: 'no', userId: cfId('U', 2) });
        const other = await writeAction(tx, repo, { requestId, groupId: group1, chainId, siteId: '', actionType: 'Approval', comments: '', userId: ACTOR.userId });
        return { first, again, other, stored: await repo.approvals.actionsForRequest(tx, { requestId }) };
      });
      expect(actions.first).toMatchObject({ requestid: cfId('R', 20), groupid: group2, chainid: chainId, actiontype: 'Approval', comments: 'ok', created: NOW, siteid: SITE_ID, parentid: null });
      expect(actions.first.actiontid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
      expect(actions.again).toMatchObject({ actiontid: actions.first.actiontid, actiontype: 'Rejection', comments: 'no', userid: cfId('U', 2), created: NOW, siteid: SITE_ID });
      expect(actions.other.actiontid).not.toBe(actions.first.actiontid);
      expect(actions.other).toMatchObject({ comments: null, siteid: null });
      expect(actions.stored.map((row) => [row.groupid, row.actiontype])).toEqual(
        expect.arrayContaining([
          [group2, 'Rejection'],
          [group1, 'Approval'],
        ]),
      );
      expect(actions.stored).toHaveLength(2);
    });

    it('keeps the loaded creation time of an overwritten action, giving one stored without a site the request\u2019s', async () => {
      const kept = await rolledBack(async (tx) => {
        await repo.approvals.insertAction(tx, { requestid: cfId('R', 21), groupid: group1, actiontype: 'Approval', created: EARLIER });
        return writeAction(tx, repo, { requestId: cfId('R', 21), groupId: group1, chainId, siteId: SITE_ID, actionType: 'Cancelation', comments: 'c', userId: ACTOR.userId });
      });
      expect(kept).toMatchObject({ actiontype: 'Cancelation', created: EARLIER, siteid: SITE_ID });
    });

    it('inserts the loaded action again when its row is gone at save time', async () => {
      // The row disappears between the load and the save, as the ORM save's own existence check would find it.
      const vanishing: ContentRepository = {
        ...repo,
        approvals: {
          ...repo.approvals,
          updateAction: async (tx, actionId) => {
            await repo.platform.delete(tx, 'approval_action', { actiontid: actionId });
            return null;
          },
        },
      };
      const reinserted = await rolledBack(async (tx) => {
        const original = await repo.approvals.insertAction(tx, { requestid: cfId('R', 22), groupid: group1, actiontype: 'Approval', created: EARLIER, siteid: SITE_ID });
        const saved = await writeAction(tx, vanishing, { requestId: cfId('R', 22), groupId: group1, chainId, siteId: SITE_ID, actionType: 'Rejection', comments: 'gone', userId: ACTOR.userId });
        return { original, saved, stored: await repo.approvals.actionsForRequest(tx, { requestId: cfId('R', 22) }) };
      });
      expect(reinserted.saved).toMatchObject({ actiontid: reinserted.original.actiontid, actiontype: 'Rejection', comments: 'gone', created: EARLIER, siteid: SITE_ID });
      expect(reinserted.stored).toHaveLength(1);
    });
  });

  describe('saveRequest', () => {
    it('starts a request without a group at the chain\u2019s first membership and inserts it stamped now', async () => {
      const saved = await rolledBack(async (tx) => {
        const loaded = await loadRequest(tx, repo, { contentHistId: cfId('H', 30), chainId, siteId: SITE_ID });
        const result = await saveRequest(tx, repo, { ...loaded.values, userid: ACTOR.userId }, ACTOR, SITE);
        const changes = await tx.query<{ actor_user_id: string | null; table: string; op: string }>(
          `SELECT actor_user_id, "table", op FROM ${handle.schema}.changelog WHERE "table" = 'approval_request' ORDER BY seq DESC LIMIT 1`,
        );
        return { result, change: changes.rows[0], stored: await repo.approvals.findRequest(tx, { requestId: result.requestid }) };
      });
      expect(saved.result).toMatchObject({ contenthistid: cfId('H', 30), chainid: chainId, groupid: group2, status: 'Pending', created: NOW });
      expect(saved.stored?.groupid).toBe(group2);
      expect(saved.change).toMatchObject({ actor_user_id: ACTOR.userId, op: 'insert' });
    });

    it('updates a stored request in place, keeping its group and creation time', async () => {
      const saved = await rolledBack(async (tx) => {
        await repo.approvals.insertRequest(tx, { requestid: cfId('R', 31), contenthistid: cfId('H', 31), chainid: chainId, groupid: group1, siteid: SITE_ID, created: EARLIER });
        const loaded = await loadRequest(tx, repo, { requestId: cfId('R', 31) });
        const result = await saveRequest(tx, repo, { ...loaded.values, status: 'Rejected' }, ACTOR, SITE);
        return { result, all: await repo.approvals.requestsByStatus(tx, { status: 'Rejected', chainId }) };
      });
      expect(saved.result).toMatchObject({ requestid: cfId('R', 31), groupid: group1, status: 'Rejected', created: EARLIER });
      expect(saved.all).toHaveLength(1);
    });

    it('inserts a loaded request given a new id as a second row with the loaded creation time', async () => {
      const saved = await rolledBack(async (tx) => {
        await repo.approvals.insertRequest(tx, { requestid: cfId('R', 32), contenthistid: cfId('H', 32), chainid: chainId, groupid: group1, siteid: SITE_ID, status: 'Canceled', created: EARLIER });
        const loaded = await loadRequest(tx, repo, { contentHistId: cfId('H', 32), chainId, siteId: SITE_ID });
        const result = await saveRequest(
          tx,
          repo,
          { ...loaded.values, requestid: cfId('R', 33), contenthistid: cfId('H', 33), status: 'Pending', groupid: '' },
          ACTOR,
          SITE,
        );
        return { result, previous: await repo.approvals.findRequest(tx, { requestId: cfId('R', 32) }) };
      });
      expect(saved.result).toMatchObject({ requestid: cfId('R', 33), contenthistid: cfId('H', 33), groupid: group2, status: 'Pending', created: EARLIER });
      expect(saved.previous).toMatchObject({ status: 'Canceled', groupid: group1 });
    });

    it('leaves the group empty on a chain without memberships', async () => {
      const saved = await rolledBack((tx) => saveRequest(tx, repo, requestValues({ requestid: cfId('R', 34), chainid: emptyChainId }), ACTOR, scripted('Pending')));
      expect(saved).toMatchObject({ groupid: '', status: 'Pending' });
    });

    it('fails before writing when the Pending script is set, as the legacy save does', async () => {
      await expect(
        inA((tx) => saveRequest(tx, repo, requestValues({ requestid: cfId('R', 35), chainid: chainId }), ACTOR, scripted('Pending'))),
      ).rejects.toBeInstanceOf(UndefinedLegacyVariableError);
      expect(await inA((tx) => repo.approvals.findRequest(tx, { requestId: cfId('R', 35) }))).toBeNull();
    });
  });

  describe('cancelRequest', () => {
    it.each(['Pending', 'pending'])('cancels a %s request with a Cancelation action of its group', async (status) => {
      const canceled = await rolledBack(async (tx) => {
        await repo.approvals.insertRequest(tx, { requestid: cfId('R', 40), contenthistid: cfId('H', 40), chainid: chainId, groupid: group1, siteid: SITE_ID, status, created: EARLIER });
        const loaded = await loadRequest(tx, repo, { requestId: cfId('R', 40) });
        const result = await cancelRequest(tx, repo, loaded.values, 'withdrawn', ACTOR, SITE);
        return { result, actions: await repo.approvals.actionsForRequest(tx, { requestId: cfId('R', 40) }) };
      });
      expect(canceled.result).toMatchObject({ requestid: cfId('R', 40), status: 'Canceled', groupid: group1, created: EARLIER });
      expect(canceled.actions).toHaveLength(1);
      expect(canceled.actions[0]).toMatchObject({ actiontype: 'Cancelation', comments: 'withdrawn', groupid: group1, chainid: chainId, siteid: SITE_ID, userid: ACTOR.userId, created: NOW });
    });

    it.each(['Approved', 'Rejected', 'Canceled'])('leaves a %s request and its actions unchanged', async (status) => {
      const untouched = await rolledBack(async (tx) => {
        await repo.approvals.insertRequest(tx, { requestid: cfId('R', 41), contenthistid: cfId('H', 41), chainid: chainId, groupid: group1, siteid: SITE_ID, status });
        const loaded = await loadRequest(tx, repo, { requestId: cfId('R', 41) });
        const result = await cancelRequest(tx, repo, loaded.values, 'late', ACTOR, scripted('Canceled'));
        return { loaded: loaded.values, result, actions: await repo.approvals.actionsForRequest(tx, { requestId: cfId('R', 41) }) };
      });
      expect(untouched.result).toEqual(untouched.loaded);
      expect(untouched.actions).toEqual([]);
    });

    it('fails after its writes when the Canceled script is set, as the legacy cancel does', async () => {
      const writes = await rolledBack(async (tx) => {
        await repo.approvals.insertRequest(tx, { requestid: cfId('R', 42), contenthistid: cfId('H', 42), chainid: chainId, groupid: group1, siteid: SITE_ID });
        const loaded = await loadRequest(tx, repo, { requestId: cfId('R', 42) });
        const error = await cancelRequest(tx, repo, loaded.values, '', ACTOR, scripted('Canceled')).catch((err: unknown) => err);
        return {
          error,
          request: await repo.approvals.findRequest(tx, { requestId: cfId('R', 42) }),
          actions: await repo.approvals.actionsForRequest(tx, { requestId: cfId('R', 42) }),
        };
      });
      expect(writes.error).toBeInstanceOf(UndefinedLegacyVariableError);
      expect(writes.request?.status).toBe('Canceled');
      expect(writes.actions.map((row) => row.actiontype)).toEqual(['Cancelation']);
    });
  });

  // A new request saved without a version: its NULL contenthistid empties the site's later draft lists (NOT IN over a NULL).
  describe('approvalAction on an unstored request', () => {
    const SITE_MANAGER = '00000000000000000000000000000000000';
    const UNSTORED = [
      ['an empty request id', ''],
      ['an unknown request id', cfId('R', 50)],
    ] as const;
    let sites = 0;

    /** A new site in its own tenant holding the Site Manager module and one unpublished page ACTOR saved. */
    async function draftSite(): Promise<{ actor: Actor; site: SiteContentSettings; inSite: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T> }> {
      sites += 1;
      const siteId = `approval-unstored-${sites}`;
      const tenantId = tenantIdForSite(siteId);
      const inSite = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, tenantId, fn);
      const page = { siteid: siteId, moduleid: SITE_MANAGER, active: 1, display: 1, lastupdate: EARLIER, lastupdatebyid: ACTOR.userId };
      await inSite(async (tx) => {
        for (const row of [
          { ...page, contentid: SITE_MANAGER, contenthistid: cfId('M', sites), type: 'Module', title: 'Site Manager', approved: 1 },
          { ...page, contentid: cfId('C', sites), contenthistid: cfId('H', 50 + sites), type: 'Page', title: 'Draft', approved: 0 },
        ]) {
          const names = Object.keys(row);
          await tx.query(
            `INSERT INTO ${handle.schema}.content (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
            [tx.tenantId, ...Object.values(row)],
          );
        }
      });
      return { actor: { ...ACTOR, siteId, tenantId }, site: { ...SITE, siteId, urls: { ...SITE.urls, siteId, filePoolId: siteId } }, inSite };
    }

    /** The site's request and action rows and its header counts (getMyDraftsCount over the last three months). */
    function storedState(inSite: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>, siteId: string) {
      return inSite(async (tx) => ({
        requests: (await tx.query(`SELECT requestid, siteid, contenthistid, chainid, groupid, userid, status, created FROM ${handle.schema}.approval_request`)).rows,
        actions: (
          await tx.query(`SELECT actiontid, siteid, actiontype, comments, userid, groupid, requestid, parentid, chainid, created FROM ${handle.schema}.approval_action`)
        ).rows,
        drafts: await repo.content.draftCount(tx, { siteId, userId: ACTOR.userId, startDate: cfDateAdd('m', -3, NOW) }),
        submissions: await repo.content.submissionsCount(tx, { siteId, userId: ACTOR.userId }),
        approvals: await repo.content.approvalsCount(tx, { siteId, groupIds: null }),
      }));
    }

    /** The request and action legacy stores for `status` and `actionType`, NULL in every column the new bean leaves empty. */
    function expectedRows(siteId: string, requestId: string, status: string, actionType: string) {
      const requestid = requestId === '' ? expect.stringMatching(CF_UUID) : requestId;
      return {
        requests: [{ requestid, siteid: siteId, contenthistid: null, chainid: null, groupid: null, userid: null, status, created: NOW }],
        actions: [
          {
            actiontid: expect.stringMatching(CF_UUID),
            siteid: siteId,
            actiontype: actionType,
            comments: 'GS-ID-09',
            userid: ACTOR.userId,
            groupid: null,
            requestid,
            parentid: null,
            chainid: null,
            created: NOW,
          },
        ],
        drafts: 0,
        submissions: 0,
        approvals: 0,
      };
    }

    const deps = () => ({ db: handle.app, repository: repo, clock: fixedClock(NOW), config: CONTENT_CONFIG_DEFAULTS });

    const DECISIONS = [
      ['reject', 'Rejection', 'Rejected'],
      ['cancel', 'Cancelation', 'Canceled'],
    ] as const;

    it.each(DECISIONS.flatMap((decision) => UNSTORED.map(([label, requestId]) => [...decision, label, requestId] as const)))(
      '%s records a %s and a %s request for %s, answering no version and emptying the site\u2019s drafts',
      async (action, actionType, status, _label, requestId) => {
        const { actor, site, inSite } = await draftSite();
        expect((await storedState(inSite, site.siteId)).drafts).toBe(1);
        const result = await approvalAction(deps(), actor, site, { requestId, action, comment: 'GS-ID-09' });
        expect(result.value).toEqual({ contenthistid: '', previewurl: '/?previewid=' });
        const stored = await storedState(inSite, site.siteId);
        expect(stored).toEqual(expectedRows(site.siteId, requestId, status, actionType));
        expect(stored.actions[0]?.requestid).toBe(stored.requests[0]?.requestid);
      },
    );

    it.each(UNSTORED)('approve for %s commits the Approval and the Approved request before the version save fails', async (_label, requestId) => {
      const { actor, site, inSite } = await draftSite();
      const outcome = approvalAction(deps(), actor, site, { requestId, action: 'approve', comment: 'GS-ID-09' });
      await expect(outcome).rejects.toBeInstanceOf(ContentSaveDataError);
      await expect(outcome).rejects.toThrow("The attribute 'PARENTID' is required when saving content.");
      expect(await storedState(inSite, site.siteId)).toEqual(expectedRows(site.siteId, requestId, 'Approved', 'Approval'));
    });
  });
});
