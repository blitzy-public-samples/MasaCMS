/** JSON API content lists over a throwaway `content` schema: page versions read once per tenant, and abandoned reads stop before them. */
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { RequestAbortedError, currentRequestContext } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { TENANT_UMBRELLA, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { saveContent } from '../../src/domain/content.js';
import { readContent, readContentVersions } from '../../src/domain/content-tree.js';
import { createFeed } from '../../src/domain/feeds.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { ADMIN, END, HOME, NOW, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';
import { roundTripCounter, type RoundTripCounter } from '../helpers/round-trips.js';
import { contentHeaders } from '../helpers/tokens.js';

type Struct = Record<string, unknown>;

const API = `/_api/json/v1/${SITE_ID}`;
const PAGES = 50;
const FILE_ID = cfId('L', 7);
/** The version read of a page's rows: contentDAO.readVersion of every row's contenthistid. */
const VERSION_READ = /WHERE tcontent\.contenthistid = ANY\(/;

/** SQL text of each statement `handle`'s app pool runs while a recorded call runs. */
function sqlRecorder(handle: ThrowawaySchema): <T>(fn: () => Promise<T>) => Promise<{ result: T; sql: string[] }> {
  let sql: string[] | undefined;
  const wrapped = new WeakSet<object>();
  handle.appPool.on('acquire', (client) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    const value = (...args: unknown[]): unknown => {
      const [text] = args;
      sql?.push(typeof text === 'string' ? text : String((text as { text?: unknown } | undefined)?.text ?? ''));
      return query(...args);
    };
    Object.defineProperty(client, 'query', { configurable: true, writable: true, value });
  });
  return async (fn) => {
    sql = [];
    const recorded = sql;
    try {
      return { result: await fn(), sql: recorded };
    } finally {
      sql = undefined;
    }
  };
}

describe.skipIf(!(await pgAvailable()))('JSON API content lists', () => {
  let fx: ContentFixture;
  let counter: RoundTripCounter;
  let record: ReturnType<typeof sqlRecorder>;
  let t: TestApp<TenantDb>;
  let folder = '';
  let feedId = '';
  /** Runs once, inside the request, before its next tenant transaction. */
  let beforeTenantRead: (() => Promise<void>) | undefined;
  /** Whether each tenant transaction ran in a request opted into abandonment. */
  let abandonable: boolean[] = [];
  let onRouteError: ((error: Error) => void) | undefined;

  const list = (query: string): string =>
    `${API}/?method=findQuery&entityname=content&parentid=${folder}&maxItems=100&sortBy=title&sortDirection=asc&${query}`;
  const feedForm = (query: string): string => `${API}/content/?feedid=${feedId}&${query}`;

  async function get(url: string): Promise<{ status: number; body: Struct; items: Struct[] }> {
    const res = await t.app.inject({ method: 'GET', url, headers: await contentHeaders('anonymous') });
    const body = JSON.parse(res.body) as Struct;
    return { status: res.statusCode, body, items: ((body['data'] as Struct | undefined)?.['items'] as Struct[] | undefined) ?? [] };
  }

  beforeAll(async () => {
    fx = await createContentFixture('jsonapi-content-batching-test');
    counter = roundTripCounter(fx.handle);
    record = sqlRecorder(fx.handle);
    const db: TenantDb = {
      ...counter.db,
      withTenant: async (tenantId, fn, options) => {
        abandonable.push(currentRequestContext()?.signal !== undefined);
        const hook = beforeTenantRead;
        beforeTenantRead = undefined;
        await hook?.();
        return counter.db.withTenant(tenantId, fn, options);
      },
    };
    t = await buildTestApp({
      db,
      declare: (app) =>
        app.addHook('onError', async (_request, _reply, error) => {
          onRouteError?.(error);
        }),
    });
    await withGatedTenant(fx.handle.app, TENANT_UMBRELLA.tenantId, (tx) =>
      fx.repo.files.insertFile(tx, {
        fileid: FILE_ID,
        siteid: TENANT_UMBRELLA.siteId,
        filename: 'shared.pdf',
        fileext: 'pdf',
        filesize: 77,
        contenttype: 'application',
        contentsubtype: 'pdf',
        created: NOW,
      }),
    );
    const save = async (data: Struct): Promise<string> => {
      const saved = await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, type: 'Page', approved: 1, ...data });
      expect(saved.errors).toEqual({});
      return saved.bean.contentId();
    };
    await save({ contentid: HOME, parentid: END, title: 'Home' });
    folder = await save({ parentid: HOME, type: 'Folder', title: 'Batch' });
    for (let n = 1; n <= PAGES; n += 1) await save({ parentid: folder, title: `Page ${String(n).padStart(2, '0')}`, fileid: FILE_ID });
    const feed = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, name: 'Batch', type: 'Local', contentid: folder, maxitems: 100, sortby: 'title', sortdirection: 'asc' });
    expect(feed.errors).toEqual({});
    feedId = feed.text('feedid');
  });

  afterAll(async () => {
    await t?.close();
    await fx?.drop();
  });

  it.each([
    ['findQuery', (n: number) => list(`itemsPerPage=${n}`)],
    ['the feed form', (n: number) => feedForm(`itemsPerPage=${n}`)],
  ])('%s answers a page of 1 and of 50 items with the same transactions and statements', async (_label, url) => {
    const pages: number[] = [];
    const [one, fifty] = [
      await counter.measure(async () => pages.push((await get(url(1))).items.length)),
      await counter.measure(async () => pages.push((await get(url(PAGES))).items.length)),
    ];
    expect(pages).toEqual([1, PAGES]);
    expect(fifty).toEqual(one);
  });

  it('readContentVersions answers each ref as readContent does, pooled file columns, missing and empty ids included', async () => {
    const stored = (await fx.rows('content', 'parentid = $1 AND active = 1', [folder])).map((row) => String(row['contenthistid']));
    const refs = [
      ...stored.slice(0, 3).map((contentHistId) => ({ siteId: SITE_ID, contentHistId })),
      { siteId: SITE_ID, contentHistId: cfId('H', 1) },
      { siteId: SITE_ID, contentHistId: '' },
      { siteId: SITE_ID, contentHistId: (stored[0] ?? '').toLowerCase() },
    ];
    const together = await readContentVersions(fx.deps, ADMIN, refs);
    const alone = [];
    for (const ref of refs) alone.push(await readContent(fx.deps, ADMIN, ref));
    expect(together).toEqual(alone);
    expect(together.map((bean) => bean.isNew)).toEqual([0, 0, 0, 1, 1, 0]);
    expect(together[0]).toMatchObject({ version: { fileext: 'pdf', filesize: 77 } });
    const missingSite = [{ siteId: '', contentHistId: stored[0] ?? '' }];
    await expect(readContentVersions(fx.deps, ADMIN, missingSite)).rejects.toEqual(await readContent(fx.deps, ADMIN, missingSite[0] ?? { siteId: '' }).catch((error: unknown) => error));
  });

  it('serializes every item of a 50-item page as its own one-item page does', async () => {
    const page = await get(list(`itemsPerPage=${PAGES}`));
    const singles: Struct[] = [];
    for (let index = 1; index <= PAGES; index += 1) singles.push(...(await get(list(`itemsPerPage=1&pageIndex=${index}`))).items);
    expect(page.items.map((item) => item['title'])).toEqual(Array.from({ length: PAGES }, (_, at) => `Page ${String(at + 1).padStart(2, '0')}`));
    expect(page.items).toEqual(singles);
  });

  it.each([
    ['a findQuery read', true, 'GET' as const, () => list('itemsPerPage=5')],
    ['a content delete', false, 'DELETE' as const, () => `${API}/content/${cfId('X', 9)}`],
  ])('%s opts into abandonment: %s', async (_label, expected, method, url) => {
    abandonable = [];
    await t.app.inject({ method, url: url(), headers: await contentHeaders('anonymous') });
    expect(abandonable.length).toBeGreaterThan(0);
    expect(new Set(abandonable)).toEqual(new Set([expected]));
  });

  it('stops a findQuery whose client disconnects before it reads the page versions', async () => {
    const complete = await record(() => get(list(`itemsPerPage=${PAGES}`)));
    expect(complete.result.items).toHaveLength(PAGES);
    expect(complete.sql.some((text) => VERSION_READ.test(text))).toBe(true);

    const origin = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const headers = await contentHeaders('anonymous');
    const aborted = await record(
      () =>
        new Promise<Error>((resolve) => {
          onRouteError = resolve;
          const client = httpRequest(`${origin}${list(`itemsPerPage=${PAGES}`)}`, { headers });
          client.on('error', () => undefined);
          client.on('response', () => resolve(new Error('the request was answered')));
          beforeTenantRead = async () => {
            const signal = currentRequestContext()?.signal;
            if (signal === undefined) throw new Error('the read was not opted into abandonment');
            const left = once(signal, 'abort');
            client.destroy();
            await left;
          };
          client.end();
        }),
    );
    onRouteError = undefined;
    expect(aborted.result).toBeInstanceOf(RequestAbortedError);
    expect(aborted.sql.some((text) => VERSION_READ.test(text))).toBe(false);
  });
});
