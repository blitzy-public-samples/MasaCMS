/** contentManager.add's public-submission queue write (contentManager.cfc:1276-1281) through `domain/content` over a throwaway `content` schema. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { GateClosedError, UnitNotAuthoritativeError, closeGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { pgAvailable } from '@opt2/platform/testing';
import { saveContent, saveContentInTx, type ContentInput } from '../../src/domain/content.js';
import { PUBLIC_SUBMISSION_APPROVAL } from '../../src/repo/tables.js';
import { ADMIN, END, HOME, SITE, SITE_ID, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const HOLDER = 'content-approval-queue-test';
const UNIT = PUBLIC_SUBMISSION_APPROVAL.unit;
const TABLE = PUBLIC_SUBMISSION_APPROVAL.table;

describe.skipIf(!(await pgAvailable()))('domain/content public-submission queue', () => {
  let fx: ContentFixture;
  const submission = (title: string, email: string): ContentInput => ({ siteid: SITE_ID, parentid: HOME, type: 'Page', title, approved: 1, email, approvalqueue: 1 });
  const versions = (title: string) => fx.rows('content', 'title = $1', [title]);
  const queued = (email: string) => fx.rows(TABLE, 'email = $1', [email]);
  /** Changelog rows of `table` whose after-image contains `text`, in write order. */
  const logged = (table: string, text: string) => fx.rows('changelog', '"table" = $1 AND strpos(after, $2) > 0', [table, text], 'seq');

  beforeAll(async () => {
    fx = await createContentFixture(HOLDER);
    expect((await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 })).errors).toEqual({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('queues a new item with its changelog row in the transaction of its version', async () => {
    const saved = await saveContent(fx.deps, ADMIN, SITE, submission('Queued', 'queued@example.com'));
    expect(saved.errors).toEqual({});
    const contentId = saved.bean.contentId();
    expect(await queued('queued@example.com')).toEqual([expect.objectContaining({ contentid: contentId, isapproved: 0, siteid: SITE_ID, occurrence: 1 })]);
    const [queueLog, ...more] = await logged(TABLE, 'queued@example.com');
    expect(more).toEqual([]);
    expect(queueLog).toMatchObject({ op: 'insert', origin: 'target', actor_user_id: ADMIN.userId });
    const [versionLog] = await logged('content', saved.bean.contentHistId());
    expect(queueLog?.xid).toBe(versionLog?.xid);
  });

  it.each([
    { state: 'closed', error: GateClosedError },
    { state: 'legacy', error: UnitNotAuthoritativeError },
  ] as const)('fails the save closed and commits nothing while the queue gate is $state', async ({ state, error }) => {
    const title = `Gate ${state}`;
    const email = `gate-${state}@example.com`;
    await closeGates(fx.handle.app, { units: [UNIT], holderId: HOLDER, allowLegacy: true });
    if (state === 'legacy') await openGates(fx.handle.app, { units: [UNIT], holderId: HOLDER, state: 'legacy' });
    try {
      const failure = await withGatedTenant(fx.deps.db, ADMIN.tenantId, (tx) => saveContentInTx(tx, fx.deps, ADMIN, SITE, submission(title, email)), { budgetMs: 300 }).catch(
        (caught: unknown) => caught,
      );
      expect(failure).toBeInstanceOf(error);
      expect(failure).toBeInstanceOf(LegacyServiceUnavailableError);
    } finally {
      if (state === 'legacy') await closeGates(fx.handle.app, { units: [UNIT], holderId: HOLDER, allowLegacy: true });
      await openGates(fx.handle.app, { units: [UNIT], holderId: HOLDER, state: 'open' });
    }
    expect(await versions(title)).toEqual([]);
    expect(await queued(email)).toEqual([]);
    expect(await logged(TABLE, email)).toEqual([]);
  });

  it.each([
    { failure: 'a NUL byte the email column refuses', email: 'nul\u0000@example.com', failsAfterInsert: false },
    { failure: 'a statement failing after the row and its changelog were written', email: 'late@example.com', failsAfterInsert: true },
  ])('commits the version without a queue row after $failure', async ({ failure, email, failsAfterInsert }) => {
    if (failsAfterInsert) {
      const insert = fx.repo.approvalQueues.insertSubmissionApproval;
      vi.spyOn(fx.repo.approvalQueues, 'insertSubmissionApproval').mockImplementationOnce(async (tx, args, ctx) => {
        const row = await insert(tx, args, ctx);
        await tx.query('SELECT 1 / 0');
        return row;
      });
    }
    const title = `Swallowed ${failure}`;
    const saved = await saveContent(fx.deps, ADMIN, SITE, submission(title, email));
    expect(saved.errors).toEqual({});
    expect(await versions(title)).toEqual([expect.objectContaining({ contentid: saved.bean.contentId(), active: 1, approved: 1 })]);
    expect(await fx.rows(TABLE, 'contentid = $1', [saved.bean.contentId()])).toEqual([]);
    expect(await logged(TABLE, saved.bean.contentId())).toEqual([]);
  });
});
