/** contentManager.add's item and deleteAll's site `editingContent` locks, over a throwaway `content` schema. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable } from '@opt2/platform/testing';
import type { TenantTx } from '@opt2/platform/tenancy';
import { deleteAll, publish, saveContent, saveContentInTx, type ContentInput } from '../../src/domain/content.js';
import { ADMIN, END, HOME, SITE, SITE_ID, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const WAIT_MS = 10_000;

describe.skipIf(!(await pgAvailable()))('domain/content edit locks', () => {
  let fx: ContentFixture;
  const save = (input: ContentInput) => saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, ...input });
  const page = (contentId: string, title: string): ContentInput => ({ siteid: SITE_ID, contentid: contentId, parentid: HOME, type: 'Page', title });
  const versionsOf = async (contentId: string) =>
    (await fx.rows('content', 'lower(rtrim(contentid)) = lower($1)', [contentId])).map((r) => [r.title, r.active, r.approved]);

  /** Runs `fn` in a tenant transaction that stays open until `release`; `held` gives its backend pid once `fn` is done. */
  function hold(fn: (tx: TenantTx) => Promise<unknown>): { held: Promise<number>; release: () => void; done: Promise<unknown> } {
    let release: () => void = () => undefined;
    let ready: (pid: number) => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const pid = new Promise<number>((resolve) => (ready = resolve));
    const done = fx.inTenant(async (tx) => {
      const value = await fn(tx);
      ready((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0);
      await released;
      return value;
    });
    const failed = done.then(() => Promise.reject(new Error('the held transaction ended before it was released')));
    return { held: Promise.race([pid, failed]), release, done };
  }

  /** True once some transaction waits on an advisory lock backend `holder` holds; false if `settled` first or after WAIT_MS. */
  async function waitsOn(holder: number, settled: () => boolean): Promise<boolean> {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline && !settled()) {
      const { rows } = await fx.handle.adminPool.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND $1 = ANY(pg_blocking_pids(pid))",
        [holder],
      );
      if ((rows[0]?.waiting ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  /** `promise`, rejected when it has not settled within WAIT_MS. */
  async function within<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish while the lock was held`)), WAIT_MS);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  beforeAll(async () => {
    fx = await createContentFixture('content-publish-lock-test');
    await save({ contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it.each<[string, (contentId: string) => string]>([
    ['its stored spelling', (contentId) => contentId],
    ['another casing with a trailing space', (contentId) => `${contentId.toLowerCase()} `],
  ])('a publish of an item another transaction is publishing, by %s, waits for it and leaves one active version', async (_label, spell) => {
    const item = await save({ parentid: HOME, type: 'Page', title: 'Original', approved: 1 });
    const contentId = item.bean.contentId();
    const first = hold((tx) => saveContentInTx(tx, fx.deps, ADMIN, SITE, { ...page(contentId, 'First'), approved: 1 }));
    let waited = false;
    let second: Promise<unknown> = Promise.resolve();
    try {
      const holder = await first.held;
      let settled = false;
      second = publish(fx.deps, ADMIN, SITE, page(spell(contentId), 'Second')).catch((err: unknown) => err);
      void second.then(() => (settled = true));
      waited = await waitsOn(holder, () => settled);
    } finally {
      first.release();
    }
    await first.done;
    expect(await second).not.toBeInstanceOf(Error);
    expect(waited).toBe(true);
    expect(await versionsOf(contentId)).toEqual([
      ['Original', 0, 1],
      ['First', 0, 1],
      ['Second', 1, 1],
    ]);
  });

  it('publishes of different items do not wait on each other', async () => {
    const one = await save({ parentid: HOME, type: 'Page', title: 'One', approved: 1 });
    const two = await save({ parentid: HOME, type: 'Page', title: 'Two', approved: 1 });
    const first = hold((tx) => saveContentInTx(tx, fx.deps, ADMIN, SITE, { ...page(one.bean.contentId(), 'One Again'), approved: 1 }));
    try {
      await first.held;
      await within(publish(fx.deps, ADMIN, SITE, page(two.bean.contentId(), 'Two Again')), 'the publish of another item');
      expect(await versionsOf(two.bean.contentId())).toEqual([
        ['Two', 0, 1],
        ['Two Again', 1, 1],
      ]);
    } finally {
      first.release();
    }
    await first.done;
    expect(await versionsOf(one.bean.contentId())).toEqual([
      ['One', 0, 1],
      ['One Again', 1, 1],
    ]);
  });

  it('deleteAll waits on the site lock under any spelling of the site id, which item saves do not take', async () => {
    const doomed = await save({ parentid: HOME, type: 'Page', title: 'Doomed', approved: 1 });
    const kept = await save({ parentid: HOME, type: 'Page', title: 'Kept', approved: 1 });
    const site = hold((tx) => fx.repo.content.lockSite(tx, { siteId: `${SITE_ID.toUpperCase()} ` }));
    let waited = false;
    let deletion: Promise<unknown> = Promise.resolve();
    try {
      const holder = await site.held;
      await within(publish(fx.deps, ADMIN, SITE, page(kept.bean.contentId(), 'Kept Again')), 'an item publish');
      let settled = false;
      deletion = deleteAll(fx.deps, ADMIN, SITE, { contentId: doomed.bean.contentId(), siteId: SITE_ID }).catch((err: unknown) => err);
      void deletion.then(() => (settled = true));
      waited = await waitsOn(holder, () => settled);
      expect(await versionsOf(doomed.bean.contentId())).toEqual([['Doomed', 1, 1]]);
    } finally {
      site.release();
    }
    await site.done;
    expect(await deletion).toEqual({ aborted: false, topId: HOME });
    expect(waited).toBe(true);
    expect(await versionsOf(doomed.bean.contentId())).toEqual([]);
    expect(await versionsOf(kept.bean.contentId())).toEqual([
      ['Kept', 0, 1],
      ['Kept Again', 1, 1],
    ]);
  });
});
