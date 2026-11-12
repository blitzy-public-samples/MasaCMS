/** Content and approval deletions over a throwaway `content` schema: one row lock per child table, per-row changelogged deletes in version order, and unit gates taken only for rows to lock. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitNotAuthoritativeError, closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { APPROVAL_ACTION, CONTENT_UNITS, FILE_METADATA } from '../../src/repo/tables.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const SITE = TENANT_A.siteId;
const TREE = '00000000000000000000000000000000000';
const FILE_ATTRIBUTE = 701;
const TEXT_ATTRIBUTE = 702;

let handle: ThrowawaySchema;
let repo: ContentRepository;

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

interface Change {
  op: string;
  table: string;
  key: string;
}

/** A version to seed: its flags, and the status and action count of its request (none when `actions` is 0 and `status` absent). */
interface VersionSpec {
  active: number;
  approved: number;
  status?: string;
  actions?: number;
}

/** A seeded version and the keys of its child rows; `childId` is the version id as its child rows store it. */
interface SeededVersion {
  histId: string;
  childId: string;
  dataIds: number[];
  requestId: string | null;
  actionIds: string[];
  metaId: string;
  fileId: string;
}

async function changelog(): Promise<Change[]> {
  return inA(async (tx) => (await tx.query<Change>(`SELECT op, "table", key FROM ${handle.schema}.changelog ORDER BY seq`)).rows);
}

async function newChanges<T>(fn: () => Promise<T>): Promise<{ result: T; changes: Change[] }> {
  const before = (await changelog()).length;
  const result = await fn();
  return { result, changes: (await changelog()).slice(before) };
}

/** Runs `fn` in tenant A over the same transaction with its `… FOR UPDATE` row locks counted per table. */
async function withLockCount<T>(fn: (tx: TenantTx) => Promise<T>): Promise<{ result: T; locks: Record<string, number> }> {
  const locks: Record<string, number> = {};
  const result = await inA((tx) => {
    const counted = Object.create(tx, {
      query: {
        value: (text: string, values?: unknown[]) => {
          const table = text.endsWith(' FOR UPDATE') ? /^SELECT \* FROM "[^"]+"\."([^"]+)"/.exec(text)?.[1] : undefined;
          if (table !== undefined) {
            locks[table] = (locks[table] ?? 0) + 1;
          }
          return tx.query(text, values);
        },
      },
    }) as TenantTx;
    return fn(counted);
  });
  return { result, locks };
}

async function setGates(state: 'open' | 'legacy', units: readonly string[] = CONTENT_UNITS): Promise<void> {
  await closeGates(handle.app, { units, holderId: 'batched-deletes-test', allowLegacy: true });
  await openGates(handle.app, { units, holderId: 'batched-deletes-test', state });
}

/** The single key value of a changelog key encoding (`<tag><length>:<value>`). */
const keyValue = (change: Change): string => change.key.slice(change.key.indexOf(':') + 1);

/** Keys of `table`'s changes, in changelog order. */
const keysOf = (changes: readonly Change[], table: string): string[] => changes.filter((change) => change.table === table).map(keyValue);

/** The tables of `changes` with consecutive repeats collapsed. */
const tableRuns = (changes: readonly Change[]): string[] => changes.map((change) => change.table).filter((table, index, all) => table !== all[index - 1]);

/**
 * Seeds item `cfId('C', base)` with one version per spec, in order. Child rows are written in reverse version order under keys
 * descending in version order, so key order is never version order; odd versions' children store the version id lower-cased.
 */
async function seedItem(base: number, specs: readonly VersionSpec[]): Promise<{ contentId: string; versions: SeededVersion[] }> {
  const contentId = cfId('C', base);
  const count = specs.length;
  const versions: SeededVersion[] = specs.map((spec, i) => {
    const histId = cfId('H', base + i);
    const hasRequest = spec.status !== undefined || (spec.actions ?? 2) > 0;
    return {
      histId,
      childId: i % 2 === 1 ? histId.toLowerCase() : histId,
      dataIds: [],
      requestId: hasRequest ? cfId('R', base + count - i) : null,
      actionIds: hasRequest ? Array.from({ length: spec.actions ?? 2 }, (_, k) => cfId('A', (base + count - i) * 10 + k)) : [],
      metaId: cfId('M', base + count - i),
      fileId: cfId('F', base + i),
    };
  });
  await inA(async (tx) => {
    for (const [i, spec] of specs.entries()) {
      await repo.content.insertVersion(tx, {
        contentid: contentId, contenthistid: versions[i]?.histId, siteid: SITE, type: 'Page', subtype: 'Default', moduleid: TREE,
        active: spec.active, approved: spec.approved, display: 1,
      });
    }
    for (const [i, seeded] of [...versions.entries()].reverse()) {
      const rows = await repo.extend.replaceExtendData(tx, seeded.childId, [
        { attributeid: FILE_ATTRIBUTE, siteid: SITE, attributevalue: seeded.fileId },
        { attributeid: TEXT_ATTRIBUTE, siteid: SITE, attributevalue: `text ${i}` },
      ]);
      seeded.dataIds = rows.map((row) => row.dataid).sort((a, b) => a - b);
      if (seeded.requestId !== null) {
        await repo.approvals.insertRequest(tx, { requestid: seeded.requestId, contenthistid: seeded.childId, status: specs[i]?.status ?? 'Rejected', siteid: SITE });
        const storedRequestId = i % 2 === 1 ? seeded.requestId.toLowerCase() : seeded.requestId;
        for (const actionId of [...seeded.actionIds].reverse()) {
          await repo.approvals.insertAction(tx, { actiontid: actionId, requestid: storedRequestId, actiontype: 'Reject', siteid: SITE });
        }
      }
      await repo.files.insertFileMetadata(tx, { metaid: seeded.metaId, contenthistid: seeded.childId, contentid: contentId, fileid: seeded.fileId, siteid: SITE });
    }
  });
  return { contentId, versions };
}

/** Child rows of `versions` still stored, by table. */
async function remaining(versions: readonly SeededVersion[]): Promise<Record<string, string[]>> {
  const histIds = versions.map((seeded) => seeded.histId.toLowerCase());
  const requestIds = versions.flatMap((seeded) => (seeded.requestId === null ? [] : [seeded.requestId.toLowerCase()]));
  return inA(async (tx) => {
    const ids = async (sql: string, values: string[]): Promise<string[]> => (await tx.query<{ id: string }>(sql, [values])).rows.map((row) => String(row.id));
    return {
      content: await ids(`SELECT contenthistid AS id FROM ${handle.schema}.content WHERE lower(rtrim(contenthistid)) = ANY($1::text[]) ORDER BY tcontent_id`, histIds),
      extend_data: await ids(`SELECT dataid AS id FROM ${handle.schema}.extend_data WHERE lower(rtrim(baseid)) = ANY($1::text[]) ORDER BY dataid`, histIds),
      approval_request: await ids(`SELECT requestid AS id FROM ${handle.schema}.approval_request WHERE lower(rtrim(requestid)) = ANY($1::text[]) ORDER BY requestid`, requestIds),
      approval_action: await ids(`SELECT actiontid AS id FROM ${handle.schema}.approval_action WHERE lower(rtrim(requestid)) = ANY($1::text[]) ORDER BY actiontid`, requestIds),
      file_metadata: await ids(`SELECT metaid AS id FROM ${handle.schema}.file_metadata WHERE lower(rtrim(contenthistid)) = ANY($1::text[]) ORDER BY metaid`, histIds),
    };
  });
}

const dataKeys = (versions: readonly SeededVersion[]): string[] => versions.flatMap((seeded) => seeded.dataIds.map(String));
const actionKeys = (versions: readonly SeededVersion[]): string[] => versions.flatMap((seeded) => seeded.actionIds);
const requestKeys = (versions: readonly SeededVersion[]): string[] => versions.flatMap((seeded) => (seeded.requestId === null ? [] : [seeded.requestId]));

describe.skipIf(!(await pgAvailable()))('repo/repository batched deletes', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await setGates('open');
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    await inA(async (tx) => {
      await repo.platform.insert(tx, 'extend_attribute', { attributeid: FILE_ATTRIBUTE, siteid: SITE, name: 'doc', type: 'File' });
      await repo.platform.insert(tx, 'extend_attribute', { attributeid: TEXT_ATTRIBUTE, siteid: SITE, name: 'txt', type: 'TextBox' });
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it.each([
    { count: 3, base: 100, lowerCaseId: false },
    { count: 5, base: 200, lowerCaseId: true },
  ])('deleteContent of $count versions (lower-case id: $lowerCaseId) locks each child table once and deletes per row in version order', async ({ count, base, lowerCaseId }) => {
    const specs = Array.from({ length: count }, (_, i): VersionSpec => ({ active: i === 0 ? 1 : 0, approved: 1 }));
    const { contentId, versions } = await seedItem(base, specs);
    const inactive = versions.slice(1);
    const { result, changes } = await newChanges(() =>
      withLockCount((tx) =>
        repo.content.deleteContent(tx, { contentId: lowerCaseId ? contentId.toLowerCase() : contentId, siteId: SITE, parentId: cfId('P', base), type: 'Page' }),
      ),
    );
    expect(result.result.versions.map((row) => row.contenthistid)).toEqual(versions.map((seeded) => seeded.histId));
    expect(result.result.extendFileIds).toEqual(versions.map((seeded) => seeded.fileId));
    expect(result.locks).toMatchObject({ extend_data: 1, approval_request: 1, approval_action: 1, file_metadata: 1, content: 2 });
    expect(changes.every((change) => change.op === 'delete')).toBe(true);
    expect(tableRuns(changes)).toEqual(['extend_data', 'approval_action', 'approval_request', 'file_metadata', 'content']);
    expect(keysOf(changes, 'extend_data')).toEqual(dataKeys(versions));
    expect(keysOf(changes, 'approval_action')).toEqual(actionKeys(versions));
    expect(keysOf(changes, 'approval_request')).toEqual(requestKeys(versions));
    expect(keysOf(changes, 'file_metadata')).toEqual(inactive.map((seeded) => seeded.metaId));
    expect(keysOf(changes, 'content')).toHaveLength(count);
    expect(await remaining(versions)).toEqual({
      content: [],
      extend_data: [],
      approval_request: [],
      approval_action: [],
      file_metadata: [versions[0]?.metaId],
    });
  });

  it.each([
    { method: 'deleteHistAll' as const, base: 300, requests: true },
    { method: 'deleteDraftHistAll' as const, base: 400, requests: false },
  ])('$method purges draft versions with one lock per child table, removing requests: $requests', async ({ method, base, requests }) => {
    const { contentId, versions } = await seedItem(base, [
      { active: 1, approved: 1 },
      { active: 0, approved: 0, status: 'Rejected' },
      { active: 0, approved: 0, status: 'Rejected', actions: 3 },
      { active: 0, approved: 0, status: 'Rejected' },
      { active: 0, approved: 0, status: 'Pending', actions: 1 },
    ]);
    const purged = versions.slice(1, 4);
    const kept = [versions[0], versions[4]].filter((seeded) => seeded !== undefined);
    const { result, changes } = await newChanges(() => withLockCount((tx) => repo.content[method](tx, { contentId, siteId: SITE })));
    expect(result.result.versions.map((row) => row.contenthistid)).toEqual(purged.map((seeded) => seeded.histId));
    expect(result.result.extendFileIds).toEqual(purged.map((seeded) => seeded.fileId));
    expect(result.locks).toMatchObject({ extend_data: 1, file_metadata: 1 });
    expect(result.locks.approval_request ?? 0).toBe(requests ? 1 : 0);
    expect(result.locks.approval_action ?? 0).toBe(requests ? 1 : 0);
    expect(changes.every((change) => change.op === 'delete')).toBe(true);
    expect(tableRuns(changes)).toEqual(
      requests ? ['extend_data', 'approval_action', 'approval_request', 'file_metadata', 'content'] : ['extend_data', 'file_metadata', 'content'],
    );
    expect(keysOf(changes, 'extend_data')).toEqual(dataKeys(purged));
    expect(keysOf(changes, 'approval_action')).toEqual(requests ? actionKeys(purged) : []);
    expect(keysOf(changes, 'approval_request')).toEqual(requests ? requestKeys(purged) : []);
    expect(keysOf(changes, 'file_metadata')).toEqual(purged.map((seeded) => seeded.metaId));
    expect(keysOf(changes, 'content')).toHaveLength(purged.length);
    const left = await remaining(versions);
    expect(left.content).toEqual(kept.map((seeded) => seeded.histId));
    expect(left.extend_data).toEqual(dataKeys(kept).sort((a, b) => Number(a) - Number(b)));
    expect(left.file_metadata).toEqual(kept.map((seeded) => seeded.metaId).sort());
    expect(left.approval_request).toEqual((requests ? requestKeys(kept) : requestKeys(versions)).sort());
    expect(left.approval_action).toEqual((requests ? actionKeys(kept) : actionKeys(versions)).sort());
  });

  it('deleteRequest and deleteChain lock the actions of all their requests once and delete them request by request', async () => {
    const chain = await inA((tx) => repo.approvals.insertChain(tx, { siteid: SITE, name: 'Batched', description: '' }));
    await inA((tx) => repo.approvals.replaceChainMemberships(tx, chain.chainid, [cfId('G', 501), cfId('G', 502)]));
    const requestIds = [1, 2, 3, 4].map((n) => cfId('R', 500 + n));
    const actionIds = requestIds.map((_, i) => [1, 2].map((k) => cfId('A', (510 - i) * 10 + k)));
    await inA(async (tx) => {
      for (const [i, requestId] of [...requestIds.entries()].reverse()) {
        await repo.approvals.insertRequest(tx, { requestid: requestId, contenthistid: cfId('H', 500 + i), chainid: chain.chainid, groupid: cfId('G', 501), siteid: SITE });
        for (const actionId of actionIds[i] ?? []) {
          await repo.approvals.insertAction(tx, { actiontid: actionId, requestid: i === 1 ? requestId.toLowerCase() : requestId, chainid: chain.chainid, actiontype: 'Approve', siteid: SITE });
        }
      }
    });
    const lone = await newChanges(() => withLockCount((tx) => repo.approvals.deleteRequest(tx, { requestId: requestIds[3]?.toLowerCase() ?? '' })));
    expect(lone.result.result?.requestid).toBe(requestIds[3]);
    expect(lone.result.locks).toEqual({ approval_request: 1, approval_action: 1 });
    expect(lone.changes.map((change) => [change.table, keyValue(change)])).toEqual([
      ...(actionIds[3] ?? []).map((id) => ['approval_action', id]),
      ['approval_request', requestIds[3]],
    ]);
    const { result, changes } = await newChanges(() => withLockCount((tx) => repo.approvals.deleteChain(tx, { chainId: chain.chainid })));
    expect(result.result?.chainid).toBe(chain.chainid);
    expect(result.locks).toEqual({ approval_membership: 1, approval_request: 1, approval_action: 1, approval_chain: 1 });
    expect(changes.every((change) => change.op === 'delete')).toBe(true);
    expect(tableRuns(changes)).toEqual(['approval_membership', 'approval_action', 'approval_request', 'approval_chain']);
    expect(keysOf(changes, 'approval_membership')).toHaveLength(2);
    expect(keysOf(changes, 'approval_action')).toEqual(actionIds.slice(0, 3).flat());
    expect(keysOf(changes, 'approval_request')).toEqual(requestIds.slice(0, 3));
    for (const requestId of requestIds) {
      expect(await inA((tx) => repo.approvals.actionsForRequest(tx, { requestId }))).toEqual([]);
    }
    expect(await inA((tx) => repo.approvals.requestsByStatus(tx, { status: 'Pending', chainId: chain.chainid }))).toEqual([]);
  });

  it.each([
    { name: 'an active version without a request', base: 600, specs: [{ active: 1, approved: 1, actions: 0 }], rejects: false },
    { name: 'an inactive version', base: 610, specs: [{ active: 1, approved: 1, actions: 0 }, { active: 0, approved: 1, actions: 0 }], rejects: true },
    { name: 'a version with a request', base: 620, specs: [{ active: 1, approved: 1 }], rejects: true },
  ])('deleteContent of an item with $name needs the approval_action and file_metadata gates only for rows to lock', async ({ base, specs, rejects }) => {
    const { contentId, versions } = await seedItem(base, specs);
    const units = [APPROVAL_ACTION.unit, FILE_METADATA.unit];
    const before = await remaining(versions);
    await setGates('legacy', units);
    try {
      const deletion = inA((tx) => repo.content.deleteContent(tx, { contentId, siteId: SITE, parentId: null, type: 'Page' }));
      if (rejects) {
        await expect(deletion).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
      } else {
        expect((await deletion).versions).toHaveLength(versions.length);
      }
    } finally {
      await setGates('open', units);
    }
    const after = await remaining(versions);
    expect(after).toEqual(rejects ? before : { content: [], extend_data: [], approval_request: [], approval_action: [], file_metadata: [versions[0]?.metaId] });
  });
});
